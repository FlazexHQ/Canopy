//! MongoDB filters compiled once and matched against BSON documents, one or a batch at a time.

use canopy_matcher::{CompiledFilter, compile_filter};
use canopy_protocol::{CanopyError, ErrorCode, RawDocument};

use crate::codec::value_of;

/// The batch result of a document that does not match.
pub const NO_MATCH: u8 = 0;
/// The batch result of a document that matches.
pub const MATCH: u8 = 1;
/// The batch result of a document whose decision is unknown: malformed BSON, or an input the matcher refuses
/// to evaluate. Callers must treat it as a refusal.
pub const UNDECIDED: u8 = 2;

fn malformed(reason: &str) -> CanopyError {
    CanopyError::new(ErrorCode::InvalidQuery, format!("Malformed BSON: {reason}"))
}

/// Compiles a filter given as EJSON text (relaxed or canonical).
pub fn compile_ejson(text: &str) -> Result<CompiledFilter, CanopyError> {
    compile_filter(&value_of(text)?)
}

/// Decides one BSON document: [`MATCH`], [`NO_MATCH`] or [`UNDECIDED`].
pub fn decide(filter: &CompiledFilter, bytes: &[u8]) -> u8 {
    match RawDocument::new(bytes).and_then(|document| filter.matches_raw(document)) {
        Ok(true) => MATCH,
        Ok(false) => NO_MATCH,
        Err(_) => UNDECIDED,
    }
}

/// Splits BSON documents laid end to end in one buffer, as a batch of change events is. Fails when the framing
/// itself is broken, since no document after that point can be located.
pub fn split_documents(documents: &[u8]) -> Result<Vec<&[u8]>, CanopyError> {
    let mut out = Vec::new();
    let mut position = 0usize;
    while position < documents.len() {
        let header = documents
            .get(position..position.saturating_add(4))
            .ok_or_else(|| malformed("truncated document length"))?;
        let length = i32::from_le_bytes([header[0], header[1], header[2], header[3]]);
        let length = usize::try_from(length).map_err(|_| malformed("negative document length"))?;
        if length < 5 {
            return Err(malformed("document length below 5"));
        }
        let end = position.checked_add(length).ok_or_else(|| malformed("document length overflows"))?;
        out.push(documents.get(position..end).ok_or_else(|| malformed("document runs past the buffer"))?);
        position = end;
    }
    Ok(out)
}

/// Decides each of the BSON documents laid end to end in one buffer, one byte per document as [`decide`].
pub fn decide_concatenated(filter: &CompiledFilter, documents: &[u8]) -> Result<Vec<u8>, CanopyError> {
    Ok(split_documents(documents)?.into_iter().map(|document| decide(filter, document)).collect())
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use super::*;

    const EMPTY: [u8; 5] = [5, 0, 0, 0, 0];
    const ONE: [u8; 12] = [12, 0, 0, 0, 0x10, b'a', 0, 1, 0, 0, 0, 0];

    #[test]
    fn decides_each_document_of_a_batch() {
        let filter = compile_ejson(r#"{"a": 1}"#).unwrap();
        let batch = [ONE.as_slice(), EMPTY.as_slice(), ONE.as_slice()].concat();
        assert_eq!(decide_concatenated(&filter, &batch).unwrap(), vec![MATCH, NO_MATCH, MATCH]);
    }

    #[test]
    fn a_malformed_document_is_undecided() {
        let filter = compile_ejson("{}").unwrap();
        let mut broken = ONE;
        broken[11] = 1;
        assert_eq!(decide(&filter, &broken), UNDECIDED);
    }

    #[test]
    fn broken_framing_fails_the_batch() {
        let filter = compile_ejson("{}").unwrap();
        let cases: [&[u8]; 4] = [&[5, 0, 0], &[4, 0, 0, 0, 0], &[255, 255, 255, 255], &[12, 0, 0, 0, 0]];
        for case in cases {
            let error = decide_concatenated(&filter, case).unwrap_err();
            assert!(error.message().starts_with("Malformed BSON: "), "{case:?}: {}", error.message());
        }
    }
}
