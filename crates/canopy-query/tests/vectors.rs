//! Replays the vectors recorded from the TypeScript `@canopy/query` package
//! (`packages/testing/scripts/query-vectors.ts`): every input must be accepted or refused exactly as
//! TypeScript did, with the same message and code, the same parsed result, and byte identical canonical
//! queries and hashes.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use canopy_protocol::ejson::{DecodeOptions, canonical_string, parse};
use canopy_protocol::json::{Json, parse_json};
use canopy_protocol::{CanopyError, Value};
use canopy_query::{
    DEFAULT_LIMITS, FilterContext, ParseFilterOptions, ParseUpdateOptions, ParsedProjection, ProjectionMode,
    QueryInput, QueryKeyParts, USING_LIMITS, UpdateKind, canonical_query, canonicalize_filter,
    parse_expression, parse_filter, parse_limit, parse_projection, parse_query, parse_sort, parse_update,
    query_hash, validate_stored_document,
};

fn text(json: &Json) -> &str {
    match json {
        Json::String(text) => text,
        _ => panic!("expected a string, got {json:?}"),
    }
}

fn flag(json: Option<&Json>) -> bool {
    matches!(json, Some(Json::Bool(true)))
}

fn strings(values: &[String]) -> Json {
    Json::Array(values.iter().map(|value| Json::String(value.clone())).collect())
}

fn canonical(value: &Value) -> Json {
    Json::String(canonical_string(value).expect("canonical EJSON"))
}

fn object(fields: Vec<(&str, Json)>) -> Json {
    Json::Object(fields.into_iter().map(|(key, value)| (key.to_owned(), value)).collect())
}

fn error(error: &CanopyError) -> Json {
    object(vec![
        ("error", Json::String(error.message().to_owned())),
        ("code", Json::String(error.code().to_string())),
    ])
}

fn answer(result: Result<Json, CanopyError>) -> Json {
    match result {
        Ok(result) => object(vec![("result", result)]),
        Err(failure) => error(&failure),
    }
}

fn expected(case: &Json) -> Json {
    match (case.get("result"), case.get("error"), case.get("code")) {
        (Some(result), _, _) => object(vec![("result", result.clone())]),
        (None, Some(message), Some(code)) => object(vec![("error", message.clone()), ("code", code.clone())]),
        _ => panic!("case without an answer: {case:?}"),
    }
}

fn projection_json(fields: &ParsedProjection) -> Json {
    let mode = if fields.mode == ProjectionMode::Include { "include" } else { "exclude" };
    object(vec![
        ("projection", canonical(&Value::Document(fields.projection.clone()))),
        ("mode", Json::String(mode.to_owned())),
        ("paths", strings(&fields.paths)),
        ("includeId", Json::Bool(fields.include_id)),
    ])
}

fn run(kind: &str, case: &Json, input: &Value) -> Json {
    match kind {
        "filter" => {
            let options = case.get("options").expect("options");
            let context = match options.get("context").map(text) {
                Some("using") => FilterContext::Using,
                Some("check") => FilterContext::Check,
                _ => FilterContext::Filter,
            };
            let limits =
                if options.get("limits").map(text) == Some("using") { USING_LIMITS } else { DEFAULT_LIMITS };
            let options = ParseFilterOptions {
                context,
                limits,
                variables: flag(options.get("variables")),
                expressions: flag(options.get("expressions")),
            };
            answer(parse_filter(input, &options).and_then(|parsed| {
                Ok(object(vec![
                    ("paths", strings(&parsed.paths)),
                    ("matcherSafe", Json::Bool(parsed.matcher_safe)),
                    ("hasVariables", Json::Bool(parsed.has_variables)),
                    ("canonical", canonical(&Value::Document(canonicalize_filter(&parsed.filter)?))),
                ]))
            }))
        }
        "query" => {
            let Value::Document(parts) = input else { panic!("query input") };
            let query = QueryInput {
                filter: parts.get("filter").cloned(),
                sort: parts.get("sort").cloned(),
                limit: parts.get("limit").cloned(),
                fields: parts.get("fields").cloned(),
            };
            answer(parse_query(&query, &DEFAULT_LIMITS).and_then(|parsed| {
                let key = QueryKeyParts {
                    collection: "notes".to_owned(),
                    filter: parsed.filter.filter.clone(),
                    sort: parsed.sort.as_ref().map(|sort| sort.sort.clone()),
                    limit: parsed.limit,
                    projection: parsed.fields.as_ref().map(|fields| fields.projection.clone()),
                };
                let projection = parsed.fields.as_ref().map_or(Json::Null, projection_json);
                Ok(object(vec![
                    ("paths", strings(&parsed.paths)),
                    (
                        "sort",
                        parsed
                            .sort
                            .as_ref()
                            .map_or(Json::Null, |sort| canonical(&Value::Document(sort.sort.clone()))),
                    ),
                    ("projection", projection),
                    ("limit", parsed.limit.map_or(Json::Null, |limit| Json::Number(f64::from(limit)))),
                    ("canonical", Json::String(canonical_query(&key)?)),
                    ("hash", Json::String(query_hash(&key)?)),
                ]))
            }))
        }
        "expression" => answer(parse_expression(input, &DEFAULT_LIMITS).map(|()| Json::Null)),
        "stored" => answer(validate_stored_document(input, &DEFAULT_LIMITS).map(|()| Json::Null)),
        "sort" => answer(parse_sort(input, &DEFAULT_LIMITS).map(|parsed| {
            object(vec![
                ("sort", canonical(&Value::Document(parsed.sort))),
                ("paths", strings(&parsed.paths)),
            ])
        })),
        "projection" => {
            answer(parse_projection(input, &DEFAULT_LIMITS).map(|fields| projection_json(&fields)))
        }
        "limit" => answer(parse_limit(input, &DEFAULT_LIMITS).map(|limit| Json::Number(f64::from(limit)))),
        "update" => {
            let options = ParseUpdateOptions {
                allow_pipeline: flag(case.get("allowPipeline")),
                ..ParseUpdateOptions::default()
            };
            answer(parse_update(input, &options).map(|parsed| {
                let kind = if parsed.kind == UpdateKind::Operators { "operators" } else { "replacement" };
                object(vec![
                    ("kind", Json::String(kind.to_owned())),
                    ("writtenPaths", strings(&parsed.written_paths)),
                ])
            }))
        }
        other => panic!("unknown kind {other}"),
    }
}

fn same(a: &Json, b: &Json) -> bool {
    match (a, b) {
        (Json::Number(x), Json::Number(y)) => x == y,
        (Json::Array(x), Json::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(x, y)| same(x, y)),
        (Json::Object(x), Json::Object(y)) => {
            x.len() == y.len()
                && x.iter()
                    .all(|(key, value)| y.iter().any(|(other, inner)| other == key && same(value, inner)))
        }
        _ => a == b,
    }
}

/// JavaScript strings may hold unpaired UTF-16 surrogates (`"\ud800"`), which Rust strings, BSON and
/// MongoDB cannot. The Rust decoder refuses them, so such inputs fail closed at the EJSON boundary; this
/// replaces every surrogate escape to check that a refused input was refused for that reason only.
fn without_surrogate_escapes(source: &str) -> String {
    let bytes = source.as_bytes();
    let mut out = String::with_capacity(source.len());
    let mut index = 0;
    while index < bytes.len() {
        let escape = bytes.get(index..index + 6).filter(|window| {
            window[0] == b'\\'
                && window[1] == b'u'
                && window[2].eq_ignore_ascii_case(&b'd')
                && matches!(window[3].to_ascii_lowercase(), b'8'..=b'9' | b'a'..=b'f')
        });
        if escape.is_some() && (index == 0 || bytes[index - 1] != b'\\') {
            out.push('x');
            index += 6;
            continue;
        }
        let rest = &source[index..];
        let Some(next) = rest.chars().next() else { break };
        out.push(next);
        index += next.len_utf8();
    }
    out
}

#[test]
fn query_validation_and_hashing_agree_with_typescript() {
    let vectors = parse_json(include_str!("../../../conformance/query/query.json")).expect("vector file");
    let Some(Json::Array(cases)) = vectors.get("cases") else { panic!("cases") };
    let mut mismatches = Vec::new();
    let mut hashed = 0;
    let mut unpaired = 0;
    for case in cases {
        let kind = text(case.get("kind").expect("kind"));
        let source = text(case.get("input").expect("input"));
        let input = match parse(source, DecodeOptions::default()) {
            Ok(input) => input,
            Err(failure) => {
                if parse(&without_surrogate_escapes(source), DecodeOptions::default()).is_ok() {
                    unpaired += 1;
                } else {
                    mismatches.push(format!(
                        "{kind} {source}: Rust cannot decode the input ({})",
                        failure.message()
                    ));
                }
                continue;
            }
        };
        let actual = run(kind, case, &input);
        let wanted = expected(case);
        if kind == "query" && wanted.get("result").is_some() {
            hashed += 1;
        }
        if !same(&actual, &wanted) {
            mismatches.push(format!("{kind} {source}\n  TypeScript {wanted:?}\n  Rust       {actual:?}"));
        }
    }
    let source = vectors.get("source").map(text).unwrap_or_default();
    assert!(
        mismatches.is_empty(),
        "{} mismatches of {} against {source}:\n{}",
        mismatches.len(),
        cases.len(),
        mismatches.iter().take(25).cloned().collect::<Vec<_>>().join("\n")
    );
    assert!(hashed > 500, "too few hashed queries: {hashed}");
    assert!(unpaired < cases.len() / 50, "too many inputs with unpaired surrogates: {unpaired}");
}
