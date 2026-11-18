//! Replays filter vectors recorded from MongoDB (`packages/testing/scripts/matcher-vectors.ts`): every filter
//! MongoDB answered must match exactly the same documents here, and every filter MongoDB refused must be
//! refused here too. Filters the matcher reports as unsupported are routed to MongoDB in production, so they
//! are counted, not compared.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use canopy_matcher::{compile_filter, is_unsupported};
use canopy_protocol::bson::decode_document;
use canopy_protocol::ejson::forgiving_base64_decode;
use canopy_protocol::json::{Json, parse_json};
use canopy_protocol::{Document, Value};

fn text(json: &Json) -> &str {
    match json {
        Json::String(text) => text,
        _ => panic!("expected a string, got {json:?}"),
    }
}

fn document(json: &Json) -> Document {
    let bytes = forgiving_base64_decode(text(json)).expect("base64");
    decode_document(&bytes).expect("BSON")
}

fn bit(mask: &[u8], index: usize) -> bool {
    mask.get(index / 8).is_some_and(|byte| byte & (1 << (index % 8)) != 0)
}

fn hex_bytes(hex: &str) -> Vec<u8> {
    (0..hex.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&hex[index..index + 2], 16).expect("hex"))
        .collect()
}

#[test]
fn filters_agree_with_mongodb() {
    let source = include_str!("vectors/filters.json");
    let vectors = parse_json(source).expect("vector file");
    let Some(Json::Array(documents)) = vectors.get("documents") else { panic!("documents") };
    let Some(Json::Array(cases)) = vectors.get("cases") else { panic!("cases") };
    let documents: Vec<Document> = documents.iter().map(document).collect();

    let mut mismatches = Vec::new();
    let mut compared = 0;
    let mut unsupported = 0;
    for case in cases {
        let filter = document(case.get("filter").expect("filter"));
        let shown = canopy_protocol::ejson::stringify(&Value::Document(filter.clone())).unwrap_or_default();
        let compiled = compile_filter(&Value::Document(filter));
        match (&compiled, case.get("error")) {
            (Err(error), _) if is_unsupported(error) => {
                unsupported += 1;
                continue;
            }
            (Err(_), Some(_)) => {
                compared += 1;
                continue;
            }
            (Err(error), None) => {
                mismatches
                    .push(format!("{shown}: MongoDB answered, the matcher refused it ({})", error.message()));
                continue;
            }
            (Ok(_), Some(message)) => {
                mismatches.push(format!(
                    "{shown}: MongoDB refused it ({}), the matcher accepted it",
                    text(message)
                ));
                continue;
            }
            (Ok(_), None) => {}
        }
        let Ok(compiled) = compiled else { continue };
        compared += 1;
        let mask = hex_bytes(text(case.get("matches").expect("matches")));
        for (index, doc) in documents.iter().enumerate() {
            let expected = bit(&mask, index);
            match compiled.matches(doc) {
                Ok(actual) if actual == expected => {}
                Ok(actual) => {
                    let shown_doc =
                        canopy_protocol::ejson::stringify(&Value::Document(doc.clone())).unwrap_or_default();
                    mismatches.push(format!("{shown} on {shown_doc}: MongoDB {expected}, matcher {actual}"));
                }
                Err(error) => mismatches.push(format!("{shown}: the matcher failed ({})", error.message())),
            }
        }
    }
    let source = match vectors.get("source") {
        Some(json) => text(json).to_owned(),
        None => String::new(),
    };
    assert!(
        mismatches.is_empty(),
        "{} mismatches against {source} ({compared} compared, {unsupported} unsupported):\n{}",
        mismatches.len(),
        mismatches.iter().take(40).cloned().collect::<Vec<_>>().join("\n")
    );
    assert!(compared > cases.len() / 2, "too few filters compared: {compared} of {}", cases.len());
}
