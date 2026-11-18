//! Replays matcher vectors recorded from MongoDB (`packages/testing/scripts/matcher-vectors.ts`). Every filter
//! MongoDB answered must match exactly the same documents here, and every filter MongoDB refused must be
//! refused here too, both on decoded documents and on the raw BSON MongoDB stored. Filters the matcher reports as unsupported are routed to MongoDB in production, so they
//! are counted, not compared.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use canopy_matcher::{
    UpdateOptions, apply_update, compile_filter, compile_projection, compile_sort, is_unsupported,
};
use canopy_protocol::bson::decode_document;
use canopy_protocol::ejson::forgiving_base64_decode;
use canopy_protocol::json::{Json, parse_json};
use canopy_protocol::{DocRef, Document, RawDocument, Value};

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
    let raw: Vec<Vec<u8>> =
        documents.iter().map(|json| forgiving_base64_decode(text(json)).expect("base64")).collect();
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
        for (index, (doc, bytes)) in documents.iter().zip(&raw).enumerate() {
            let expected = bit(&mask, index);
            let raw_doc = RawDocument::new(bytes).expect("raw BSON");
            for (form, outcome) in
                [("decoded", compiled.matches(doc)), ("raw", compiled.matches_raw(raw_doc))]
            {
                match outcome {
                    Ok(actual) if actual == expected => {}
                    Ok(actual) => {
                        let shown_doc = canopy_protocol::ejson::stringify(&Value::Document(doc.clone()))
                            .unwrap_or_default();
                        mismatches.push(format!(
                            "{shown} on {shown_doc} ({form}): MongoDB {expected}, matcher {actual}"
                        ));
                    }
                    Err(error) => {
                        mismatches
                            .push(format!("{shown} ({form}): the matcher failed ({})", error.message()));
                    }
                }
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

struct Recorded {
    source: String,
    documents: Vec<Document>,
    cases: Vec<Json>,
}

fn recorded(source: &str) -> Recorded {
    let vectors = parse_json(source).expect("vector file");
    let Some(Json::Array(documents)) = vectors.get("documents") else { panic!("documents") };
    let Some(Json::Array(cases)) = vectors.get("cases") else { panic!("cases") };
    Recorded {
        source: vectors.get("source").map(|json| text(json).to_owned()).unwrap_or_default(),
        documents: documents.iter().map(document).collect(),
        cases: cases.clone(),
    }
}

fn shown(value: Document) -> String {
    canopy_protocol::ejson::stringify(&Value::Document(value)).unwrap_or_default()
}

#[test]
fn sorts_agree_with_mongodb() {
    let vectors = recorded(include_str!("vectors/sorts.json"));
    let mut mismatches = Vec::new();
    let (mut ordered, mut refused) = (0, 0);
    for case in &vectors.cases {
        let spec = document(case.get("sort").expect("sort"));
        let label = shown(spec.clone());
        let mut documents = vectors.documents.clone();
        let outcome = compile_sort(&Value::Document(spec)).and_then(|sort| sort.sort(&mut documents));
        match (outcome, case.get("order")) {
            (Ok(()), Some(Json::Array(order))) => {
                ordered += 1;
                let expected: Vec<String> = order.iter().map(|id| format!("{id:?}")).collect();
                let actual: Vec<String> = documents
                    .iter()
                    .map(|doc| match doc.get("_id") {
                        Some(Value::Int32(id)) => format!("{:?}", Json::Number(f64::from(*id))),
                        other => format!("{other:?}"),
                    })
                    .collect();
                if expected != actual {
                    mismatches
                        .push(format!("{label}: MongoDB and the matcher order the documents differently"));
                }
            }
            (Err(_), None) => refused += 1,
            (Err(error), Some(_)) => {
                mismatches
                    .push(format!("{label}: MongoDB sorted, the matcher refused ({})", error.message()));
            }
            (Ok(()), _) => mismatches.push(format!("{label}: MongoDB refused, the matcher sorted")),
        }
    }
    assert!(
        mismatches.is_empty(),
        "{} mismatches against {}:\n{}",
        mismatches.len(),
        vectors.source,
        mismatches.iter().take(40).cloned().collect::<Vec<_>>().join("\n")
    );
    assert!(ordered > vectors.cases.len() / 3, "too few sorts compared: {ordered}");
    assert!(refused > 0, "no parallel array refusal compared");
}

#[test]
fn sorts_on_raw_documents_order_like_decoded_ones() {
    let vectors = recorded(include_str!("vectors/sorts.json"));
    let raw: Vec<Vec<u8>> = vectors
        .documents
        .iter()
        .map(|doc| canopy_protocol::bson::encode_document(doc).expect("BSON"))
        .collect();
    for case in &vectors.cases {
        let spec = document(case.get("sort").expect("sort"));
        let sort = compile_sort(&Value::Document(spec.clone())).expect("compiles");
        for (left, (a, a_raw)) in vectors.documents.iter().zip(&raw).enumerate().step_by(7) {
            for (b, b_raw) in vectors.documents.iter().zip(&raw).skip(left % 5).step_by(11) {
                let decoded = sort.compare(DocRef::Owned(a), DocRef::Owned(b));
                let in_place = sort.compare(
                    DocRef::Raw(RawDocument::new(a_raw).expect("raw")),
                    DocRef::Raw(RawDocument::new(b_raw).expect("raw")),
                );
                assert_eq!(
                    decoded,
                    in_place,
                    "{} on {} and {}",
                    shown(spec.clone()),
                    shown(a.clone()),
                    shown(b.clone())
                );
            }
        }
    }
}

#[test]
fn projections_agree_with_mongodb() {
    let vectors = recorded(include_str!("vectors/projections.json"));
    let mut mismatches = Vec::new();
    let (mut projected, mut unsupported) = (0, 0);
    for case in &vectors.cases {
        let spec = document(case.get("projection").expect("projection"));
        let label = shown(spec.clone());
        let compiled = compile_projection(&Value::Document(spec));
        match (compiled, case.get("documents")) {
            (Err(error), _) if is_unsupported(&error) => unsupported += 1,
            (Err(_), None) => {}
            (Err(error), Some(_)) => {
                mismatches
                    .push(format!("{label}: MongoDB projected, the matcher refused ({})", error.message()));
            }
            (Ok(_), None) => mismatches.push(format!("{label}: MongoDB refused, the matcher projected")),
            (Ok(projection), Some(Json::Array(expected))) => {
                projected += 1;
                for (doc, want) in vectors.documents.iter().zip(expected) {
                    let want = document(want);
                    for (form, got) in [
                        ("decoded", projection.apply(DocRef::Owned(doc))),
                        (
                            "raw",
                            projection.apply(DocRef::Raw(
                                RawDocument::new(&canopy_protocol::bson::encode_document(doc).expect("BSON"))
                                    .expect("raw"),
                            )),
                        ),
                    ] {
                        let bytes = canopy_protocol::bson::encode_document(&got).expect("BSON");
                        if bytes != canopy_protocol::bson::encode_document(&want).expect("BSON") {
                            mismatches.push(format!(
                                "{label} on {} ({form}): MongoDB {}, matcher {}",
                                shown(doc.clone()),
                                shown(want.clone()),
                                shown(got)
                            ));
                        }
                    }
                }
            }
            (Ok(_), Some(other)) => panic!("unexpected documents: {other:?}"),
        }
    }
    assert!(
        mismatches.is_empty(),
        "{} mismatches against {}:\n{}",
        mismatches.len(),
        vectors.source,
        mismatches.iter().take(40).cloned().collect::<Vec<_>>().join("\n")
    );
    assert_eq!(unsupported, 0);
    assert!(projected > vectors.cases.len() / 3, "too few projections compared: {projected}");
}

#[test]
fn updates_agree_with_mongodb() {
    let vectors = recorded(include_str!("vectors/updates.json"));
    let mut mismatches = Vec::new();
    let (mut applied, mut refused, mut unsupported) = (0, 0, 0);
    for case in &vectors.cases {
        let Some(Json::Number(index)) = case.get("document") else { panic!("document") };
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let original = &vectors.documents[*index as usize];
        let update = document(case.get("update").expect("update"));
        let array_filters = match case.get("arrayFilters").map(document) {
            Some(holder) => match holder.get("list") {
                Some(Value::Array(filters)) => filters.clone(),
                other => panic!("array filters: {other:?}"),
            },
            None => Vec::new(),
        };
        let label = format!("{} on {}", shown(update.clone()), shown(original.clone()));
        let options = UpdateOptions { array_filters, ..UpdateOptions::default() };
        let outcome = apply_update(original, &Value::Document(update), &options);
        match (outcome, case.get("result")) {
            (Err(error), _) if is_unsupported(&error) => unsupported += 1,
            (Err(_), None) => refused += 1,
            (Err(error), Some(_)) => {
                mismatches
                    .push(format!("{label}: MongoDB applied it, the updater refused ({})", error.message()));
            }
            (Ok(after), None) => mismatches.push(format!(
                "{label}: MongoDB refused it ({}), the updater gave {}",
                case.get("error").map(text).unwrap_or_default(),
                shown(after)
            )),
            (Ok(after), Some(expected)) => {
                applied += 1;
                let expected = document(expected);
                let bytes = canopy_protocol::bson::encode_document(&after).expect("BSON");
                if bytes != canopy_protocol::bson::encode_document(&expected).expect("BSON") {
                    mismatches.push(format!(
                        "{label}: MongoDB {}, updater {}",
                        shown(expected),
                        shown(after)
                    ));
                }
            }
        }
    }
    assert!(
        mismatches.is_empty(),
        "{} mismatches against {} ({applied} applied, {refused} refused, {unsupported} unsupported):\n{}",
        mismatches.len(),
        vectors.source,
        mismatches.iter().take(40).cloned().collect::<Vec<_>>().join("\n")
    );
    assert!(applied > vectors.cases.len() / 3, "too few updates compared: {applied}");
    assert!(unsupported < vectors.cases.len() / 20, "too many unsupported updates: {unsupported}");
}
