use std::collections::BTreeMap;

use canopy_http::{Request, Response};
use canopy_mongo::mongodb::Client;
use canopy_protocol::json::{Json, parse_json, write_json};

use crate::common::{
    canonical_documents, case_files_of, entries, get, list, seed, text, text_of, without_ct, write_request_of,
};

const KIND_ONLY: [&str; 2] = ["GRAPHQL_PARSE_FAILED", "GRAPHQL_VALIDATION_FAILED"];

pub(crate) fn number(json: &Json, key: &str) -> f64 {
    match get(json, key) {
        Json::Number(value) => *value,
        other => panic!("{key} is not a number: {other:?}"),
    }
}

fn by_kind(body: &str) -> String {
    let Ok(mut json) = parse_json(body) else { return body.to_owned() };
    let normalize = |result: &mut Json| {
        let Json::Object(members) = result else { return };
        for (key, value) in members.iter_mut() {
            if key != "errors" {
                continue;
            }
            let Json::Array(errors) = value else { continue };
            for error in errors {
                let code = match error.get("extensions").and_then(|extensions| extensions.get("code")) {
                    Some(Json::String(code)) => code.clone(),
                    _ => continue,
                };
                if !KIND_ONLY.contains(&code.as_str()) {
                    continue;
                }
                if let Json::Object(fields) = error {
                    for (name, message) in fields.iter_mut() {
                        if name == "message" {
                            *message = Json::String(format!("<{code}>"));
                        }
                    }
                }
            }
        }
    };
    match &mut json {
        Json::Array(results) => results.iter_mut().for_each(normalize),
        other => normalize(other),
    }
    let mut out = String::new();
    write_json(&mut out, &json);
    out
}

fn parser_message(body: &str) -> String {
    let marker = "\"originalError\":{\"name\":\"SyntaxError\",\"message\":\"";
    let Some(start) = body.find(marker).map(|at| at + marker.len()) else { return body.to_owned() };
    let mut end = start;
    let bytes = body.as_bytes();
    while end < bytes.len() && bytes[end] != b'"' {
        end += if bytes[end] == b'\\' { 2 } else { 1 };
    }
    format!("{}<json-parser-message>{}", &body[..start], &body[end..])
}

pub(crate) async fn replay<S>(
    client: &Client,
    database: &str,
    meta: &str,
    fixture: &Json,
    mut start: impl AsyncFnMut() -> S,
    send: impl AsyncFn(&S, &Request) -> Option<Response>,
) {
    let mut failures = Vec::new();
    let mut count = 0;
    for (_, file) in case_files_of("graphql") {
        for case in list(&file, "cases") {
            count += 1;
            let id = text(case, "id");
            client.database(database).drop().await.expect("drop");
            client.database(meta).drop().await.expect("drop");
            seed(&client.database(database), fixture).await;
            let server = start().await;
            let mut bodies = Vec::new();
            for (index, step) in list(case, "steps").iter().enumerate() {
                let request = write_request_of(fixture, get(step, "request"));
                let Some(response) = send(&server, &request).await else {
                    failures.push(format!("{id} step {index}: not served"));
                    continue;
                };
                bodies.push((index, response, get(step, "response").clone()));
            }
            let generated = match case.get("generatedId") {
                Some(spec) => {
                    let docs =
                        canonical_documents(&client.database(database), text(spec, "collection"), None).await;
                    let title = format!("\"title\":\"{}\"", text(spec, "title"));
                    docs.iter().find(|doc| doc.contains(&title)).and_then(|doc| {
                        let start = doc.find("{\"$oid\":\"")? + 9;
                        Some(doc[start..start + 24].to_owned())
                    })
                }
                None => None,
            };
            let substitute = |text: String| match &generated {
                Some(hex) => text.replace(&format!("\"{hex}\""), "\"<object-id>\""),
                None => text,
            };
            for (index, response, recorded) in bodies {
                let status = number(&recorded, "status") as u16;
                if response.status != status {
                    failures
                        .push(format!("{id} step {index}: status {} instead of {status}", response.status));
                }
                let mut alternatives =
                    vec![recorded.get("headers").and_then(|headers| headers.get("content-type")).cloned()];
                if let Some(Json::Array(more)) = recorded.get("alternateContentTypes") {
                    alternatives.extend(more.iter().cloned().map(Some));
                }
                let content_type =
                    response.header("content-type").map(|value| Json::String(value.to_owned()));
                if !alternatives.contains(&content_type) {
                    failures.push(format!(
                        "{id} step {index}: content-type {content_type:?} instead of {alternatives:?}"
                    ));
                }
                let mut headers = BTreeMap::new();
                for name in ["x-request-id", "x-canopy-ct"] {
                    if let Some(value) = response.header(name) {
                        headers.insert(name.to_owned(), Json::String(value.to_owned()));
                    }
                }
                let expected: BTreeMap<String, Json> = entries(&recorded, "headers")
                    .iter()
                    .filter(|(name, _)| name != "content-type")
                    .cloned()
                    .collect();
                if headers != expected {
                    failures.push(format!("{id} step {index}: headers {headers:?} instead of {expected:?}"));
                }
                let body = substitute(parser_message(&without_ct(&String::from_utf8_lossy(&response.body))));
                let wanted = text(&recorded, "body");
                if by_kind(&body) != by_kind(wanted) {
                    failures.push(format!("{id} step {index}: body\n  {body}\n  instead of\n  {wanted}"));
                }
            }
            let state = match case.get("state") {
                Some(Json::Object(state)) => state.clone(),
                _ => Vec::new(),
            };
            for (name, documents) in &state {
                let Json::Array(expected) = documents else { panic!("state of {name}") };
                let expected: Vec<String> = expected.iter().map(text_of).collect();
                let actual: Vec<String> = canonical_documents(&client.database(database), name, None)
                    .await
                    .into_iter()
                    .map(&substitute)
                    .collect();
                if actual != expected {
                    failures.push(format!("{id}: {name} holds\n  {actual:?}\n  instead of\n  {expected:?}"));
                }
            }
        }
    }
    client.database(database).drop().await.expect("drop");
    client.database(meta).drop().await.expect("drop");
    assert!(count >= 50, "{count} cases");
    assert!(failures.is_empty(), "{} failures in {count} cases:\n{}", failures.len(), failures.join("\n"));
}
