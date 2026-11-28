use std::time::Duration;

use canopy_engine::{Ct, MutOp, MutationOutcome, MutationRequest};
use canopy_protocol::ejson::{DecodeOptions, parse, to_canonical};
use canopy_protocol::json::write_json;
use canopy_protocol::{CanopyError, Document, ErrorCode, Value};

fn unavailable() -> CanopyError {
    CanopyError::new(ErrorCode::Unavailable, "The write path is unavailable")
}

fn number(value: Option<&Value>) -> u64 {
    match value {
        Some(Value::Int32(n)) => u64::try_from(*n).unwrap_or(0),
        Some(Value::Int64(n)) => u64::try_from(*n).unwrap_or(0),
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        Some(Value::Double(n)) if *n >= 0.0 => *n as u64,
        _ => 0,
    }
}

/// The body of an atomic `_batch` holding the one write of a `mut` frame.
pub(crate) fn batch_body(request: &MutationRequest) -> Result<String, CanopyError> {
    let mut body = Document::new();
    body.insert("atomic", Value::Bool(true));
    body.insert("ops", Value::Array(vec![operation(request)]));
    let mut out = String::new();
    write_json(&mut out, &to_canonical(&Value::Document(body))?);
    Ok(out)
}

/// Reads the answer of the `_batch` into what the engine needs for the `ack`.
pub(crate) fn outcome(
    request: &MutationRequest,
    status: u16,
    text: &str,
) -> Result<MutationOutcome, CanopyError> {
    let body = parse(text, DecodeOptions { max_depth: 64, max_nodes: 1_000_000 });
    if !(200..300).contains(&status) {
        let body = body.ok();
        let field =
            |name: &str| match body.as_ref().and_then(Value::as_document).and_then(|doc| doc.get(name)) {
                Some(Value::String(text)) => Some(text.clone()),
                _ => None,
            };
        let code = field("code").and_then(|code| ErrorCode::parse(&code)).unwrap_or(ErrorCode::Internal);
        let message = field("detail").unwrap_or_else(|| "The write failed".to_owned());
        return Err(CanopyError::new(code, message));
    }
    let Ok(Value::Document(body)) = body else { return Err(unavailable()) };
    let ct = match body.get("ct") {
        Some(Value::String(ct)) => Ct::parse(ct).unwrap_or_default(),
        _ => Ct::ZERO,
    };
    let replayed = matches!(body.get("replayed"), Some(Value::Bool(true)));
    let entry = match body.get("data") {
        Some(Value::Array(items)) => items.first().and_then(Value::as_document).cloned().unwrap_or_default(),
        _ => Document::new(),
    };
    Ok(outcome_of_entry(request, ct, replayed, &entry))
}

/// What the engine needs for the `ack` from the result of the one operation of the batch: the cluster time,
/// whether it was replayed, and the operation's entry of the batch's `data`.
pub(crate) fn outcome_of_entry(
    request: &MutationRequest,
    ct: Ct,
    replayed: bool,
    entry: &Document,
) -> MutationOutcome {
    let data = entry.get("data");
    let args = &request.mutation.args;
    let mut result = MutationOutcome { ct, replayed, ..MutationOutcome::default() };
    match request.mutation.op {
        MutOp::Insert => {
            let doc = data.and_then(Value::as_document).cloned();
            let id = doc
                .as_ref()
                .and_then(|doc| doc.get("_id"))
                .or_else(|| args.get("doc").and_then(Value::as_document).and_then(|doc| doc.get("_id")))
                .cloned();
            result.inserted_ids = id.iter().cloned().collect();
            result.changed_ids = result.inserted_ids.clone();
            result.documents = Some(doc.into_iter().collect());
        }
        MutOp::InsertMany => {
            if let Some(Value::Array(ids)) = entry.get("ids") {
                result.inserted_ids = ids.clone();
            }
            if let Some(Value::Array(docs)) = data {
                result.documents = Some(docs.iter().filter_map(Value::as_document).cloned().collect());
            }
        }
        MutOp::UpdateMany => {
            let counts = data.and_then(Value::as_document);
            result.matched = number(counts.and_then(|c| c.get("matched")));
            result.modified = number(counts.and_then(|c| c.get("modified")));
        }
        MutOp::DeleteMany => {
            let counts = data.and_then(Value::as_document);
            result.matched = number(counts.and_then(|c| c.get("deleted")));
        }
        MutOp::Update | MutOp::Replace | MutOp::Delete => {
            let upserted = matches!(entry.get("upserted"), Some(Value::Bool(true)));
            result.matched = number(entry.get("matched"));
            result.modified = if request.mutation.op == MutOp::Delete { 0 } else { result.matched };
            if result.matched > 0 || upserted {
                result.changed_ids = args.get("id").cloned().into_iter().collect();
            }
            result.documents = Some(data.and_then(Value::as_document).cloned().into_iter().collect());
        }
    }
    result
}

/// The `{op, c, ...}` operation of a `mut` frame, as an atomic `_batch` holds it.
pub(crate) fn operation(request: &MutationRequest) -> Value {
    let mutation = &request.mutation;
    let mut op = Document::new();
    op.insert("op", Value::String(mutation.op.as_str().to_owned()));
    op.insert("c", Value::String(mutation.c.clone()));
    for (key, value) in mutation.args.iter() {
        if key != "bulk" {
            op.insert(key, value.clone());
        }
    }
    Value::Document(op)
}

/// Forwards a write to the TypeScript write path with the caller's own credentials, so its policies, its
/// transaction and its idempotency record are the ones REST uses.
pub(crate) async fn forward(
    client: &reqwest::Client,
    base: &str,
    request: &MutationRequest,
) -> Result<MutationOutcome, CanopyError> {
    let body = batch_body(request)?;
    let mut call = client
        .post(format!("{}/_batch", base.trim_end_matches('/')))
        .timeout(Duration::from_secs(30))
        .header("content-type", "application/json")
        .header("apikey", &request.key)
        .header("idempotency-key", &request.mutation.id);
    if let Some(token) = &request.token {
        call = call.header("authorization", format!("Bearer {token}"));
    }
    if let Some(address) = &request.address {
        call = call.header("x-forwarded-for", address);
    }
    if request.mutation.op.is_bulk() {
        call = call.header("prefer", "bulk=true");
    }
    let response = call.body(body).send().await.map_err(|_| unavailable())?;
    let status = response.status().as_u16();
    let text = response.text().await.map_err(|_| unavailable())?;
    outcome(request, status, &text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use canopy_engine::{Mutation, Principal};

    fn request(op: MutOp, args: &str) -> MutationRequest {
        let Ok(Value::Document(args)) = parse(args, DecodeOptions::default()) else {
            unreachable!("valid args")
        };
        MutationRequest {
            id: 1,
            key: "pk".to_owned(),
            token: None,
            address: None,
            principal: Principal::anon(),
            mutation: Mutation { id: "m1".to_owned(), c: "items".to_owned(), op, args },
        }
    }

    #[test]
    fn sends_one_atomic_operation_in_canonical_ejson() {
        let body = batch_body(&request(
            MutOp::Update,
            r#"{"id":{"$oid":"6728f0c2a1b2c3d4e5f60718"},"update":{"$set":{"n":1.5}}}"#,
        ));
        assert_eq!(
            body.ok().as_deref(),
            Some(
                r#"{"atomic":true,"ops":[{"op":"update","c":"items","id":{"$oid":"6728f0c2a1b2c3d4e5f60718"},"update":{"$set":{"n":{"$numberDouble":"1.5"}}}}]}"#
            )
        );
    }

    #[test]
    fn reads_a_single_document_write() {
        let result = outcome(
            &request(MutOp::Update, r#"{"id":3,"update":{"$set":{"n":1}}}"#),
            200,
            r#"{"data":[{"data":{"_id":3,"n":1},"matched":1}],"ct":"7301444403200000007","replayed":false}"#,
        );
        let Ok(result) = result else { unreachable!("{result:?}") };
        assert_eq!(result.ct, Ct(7_301_444_403_200_000_007));
        assert_eq!(result.matched, 1);
        assert_eq!(result.changed_ids, vec![Value::Int32(3)]);
        assert_eq!(result.documents.map(|docs| docs.len()), Some(1));
    }

    #[test]
    fn a_write_that_matched_nothing_changed_nothing() {
        let result = outcome(
            &request(MutOp::Delete, r#"{"id":3}"#),
            200,
            r#"{"data":[{"data":null,"matched":0}],"ct":"1"}"#,
        );
        assert!(result.is_ok_and(|result| result.changed_ids.is_empty() && result.matched == 0));
    }

    #[test]
    fn an_insert_reports_its_id() {
        let result = outcome(
            &request(MutOp::Insert, r#"{"doc":{"_id":"a","x":1}}"#),
            200,
            r#"{"data":[{"data":{"_id":"a","x":1},"matched":0}],"ct":"5"}"#,
        );
        assert!(result.is_ok_and(|result| result.inserted_ids == vec![Value::String("a".to_owned())]));
    }

    #[test]
    fn a_problem_becomes_the_matching_error() {
        let result = outcome(
            &request(MutOp::Insert, r#"{"doc":{}}"#),
            403,
            r#"{"type":"x","title":"Policy violation","status":403,"code":"CANOPY_POLICY_VIOLATION","detail":"The document fails the insert policy"}"#,
        );
        let Err(error) = result else { unreachable!("an error") };
        assert_eq!(error.code(), ErrorCode::PolicyViolation);
        assert_eq!(error.message(), "The document fails the insert policy");
    }
}
