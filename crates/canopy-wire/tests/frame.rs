#![allow(missing_docs)]

use canopy_mongo::mongodb::bson::{Document, doc};
use canopy_wire::frame::{Header, WireError, encode_op_msg, encode_op_reply, parse_message};

const MAX: usize = 48_000_000;
const BODY: &str = "000c0000001078000700000000";
const CHECKSUM: &str = "250000002a00000000000000dd07000001000000000c0000001078000700000000b116926c";

fn hex(input: &str) -> Vec<u8> {
    let digits: Vec<_> = input.bytes().filter(|byte| !byte.is_ascii_whitespace()).collect();
    let (pairs, remainder) = digits.as_chunks::<2>();
    assert!(remainder.is_empty());
    pairs
        .iter()
        .map(|pair| {
            let high = char::from(pair[0]).to_digit(16);
            let low = char::from(pair[1]).to_digit(16);
            match (high, low) {
                (Some(high), Some(low)) => ((high << 4) | low) as u8,
                _ => unreachable!("Fixture contains nonhexadecimal digits"),
            }
        })
        .collect()
}

fn wire(opcode: i32, payload: &[u8]) -> Vec<u8> {
    let length = (16 + payload.len()) as i32;
    let mut frame: Vec<_> = [length, 42, 0, opcode].into_iter().flat_map(i32::to_le_bytes).collect();
    frame.extend_from_slice(payload);
    frame
}

fn op_msg(flags: u32, sections: &str) -> Vec<u8> {
    let mut payload = flags.to_le_bytes().to_vec();
    payload.extend(hex(sections));
    wire(2013, &payload)
}

fn legacy(namespace: &[u8], command: &str) -> Vec<u8> {
    let mut payload = hex("04000000");
    payload.extend_from_slice(namespace);
    payload.extend(hex("00 00000000 ffffffff"));
    payload.extend(hex(command));
    wire(2004, &payload)
}

fn sequence(name: &str, documents: &str) -> String {
    let length = (5 + name.len() + hex(documents).len()) as i32;
    let mut prefix = vec![1];
    prefix.extend(length.to_le_bytes());
    prefix.extend_from_slice(name.as_bytes());
    prefix.push(0);
    let prefix: String = prefix.into_iter().map(|byte| format!("{byte:02x}")).collect();
    prefix + documents
}

fn assert_reply(frame: &[u8], code: i32, code_name: &str, message: &str) {
    match parse_message(frame, MAX) {
        Err(WireError::Reply { header, document }) => {
            assert_eq!(header.request_id, 42);
            assert_eq!(header.response_to, 0);
            assert_eq!(document, doc! { "ok": 0.0, "errmsg": message, "code": code, "codeName": code_name });
        }
        result => unreachable!("Expected an error reply, got {result:?}"),
    }
}

#[test]
fn parses_body_and_header() -> Result<(), WireError> {
    let bytes = hex("210000002a000000fbffffffdd070000 00000000 000c0000001078000700000000");
    let message = parse_message(&bytes, MAX)?;
    assert_eq!(message.header, Header { length: 33, request_id: 42, response_to: -5, opcode: 2013 });
    assert_eq!(Header::parse(&bytes[..16], 33)?, message.header);
    assert_eq!(message.body, doc! { "x": 7 });
    assert!(!message.checksum_present);
    assert!(!message.more_to_come);
    assert!(!message.exhaust_allowed);
    Ok(())
}

#[test]
fn folds_one_sequence_with_two_documents() -> Result<(), WireError> {
    let frame =
        op_msg(0, &format!("{BODY} 01 1e000000 6100 0c0000001079000100000000 0c0000001079000200000000"));
    assert_eq!(parse_message(&frame, MAX)?.body, doc! { "x": 7, "a": [{ "y": 1 }, { "y": 2 }] });
    Ok(())
}

#[test]
fn folds_two_sequences_around_the_body() -> Result<(), WireError> {
    let frame = op_msg(0, &format!("01 06000000 6100 {BODY} 01 0d000000 622e6300 0500000000"));
    let body = parse_message(&frame, MAX)?.body;
    assert_eq!(body, doc! { "x": 7, "a": Vec::<Document>::new(), "b": { "c": [Document::new()] } });
    assert_eq!(body.keys().next().map(String::as_str), Some("x"));
    Ok(())
}

#[test]
fn folds_more_than_two_distinct_sequences() -> Result<(), WireError> {
    let frame = op_msg(0, &format!("{BODY} 01060000006100 01060000006200 01060000006300"));
    let empty = Vec::<Document>::new();
    assert_eq!(
        parse_message(&frame, MAX)?.body,
        doc! { "x": 7, "a": empty.clone(), "b": empty.clone(), "c": empty }
    );
    Ok(())
}

#[test]
fn validates_crc32c() -> Result<(), WireError> {
    let message = parse_message(&hex(CHECKSUM), MAX)?;
    assert!(message.checksum_present);
    assert_eq!(message.body, doc! { "x": 7 });
    Ok(())
}

#[test]
fn closes_on_wrong_checksum_including_header_changes() {
    let mut checksum = hex(CHECKSUM);
    checksum[4] ^= 1;
    assert!(matches!(parse_message(&checksum, MAX), Err(WireError::CloseConnection(_))));
    let mut checksum = hex(CHECKSUM);
    checksum[36] ^= 1;
    assert!(matches!(parse_message(&checksum, MAX), Err(WireError::CloseConnection(_))));
}

#[test]
fn parses_known_flags_and_ignores_unknown_optional_flags() -> Result<(), WireError> {
    let message = parse_message(&op_msg(0x8001_0002, BODY), MAX)?;
    assert!(message.more_to_come);
    assert!(message.exhaust_allowed);
    assert!(!message.checksum_present);
    Ok(())
}

#[test]
fn closes_on_unknown_required_flags() {
    for flags in [4, 1 << 15] {
        assert!(matches!(parse_message(&op_msg(flags, BODY), MAX), Err(WireError::CloseConnection(_))));
    }
}

#[test]
fn closes_on_truncated_header() {
    let frame = op_msg(0, BODY);
    for count in 0..16 {
        assert!(matches!(parse_message(&frame[..count], MAX), Err(WireError::CloseConnection(_))));
    }
}

#[test]
fn closes_when_length_does_not_match_the_frame() {
    let mut frame = op_msg(0, BODY);
    frame[0] = 34;
    assert!(matches!(parse_message(&frame, MAX), Err(WireError::CloseConnection(_))));
    frame[0] = 32;
    assert!(matches!(parse_message(&frame, MAX), Err(WireError::CloseConnection(_))));
    frame[..4].copy_from_slice(&(-1i32).to_le_bytes());
    assert!(matches!(parse_message(&frame, MAX), Err(WireError::CloseConnection(_))));
}

#[test]
fn closes_when_length_exceeds_the_maximum() {
    assert!(matches!(parse_message(&op_msg(0, BODY), 32), Err(WireError::CloseConnection(_))));
}

#[test]
fn rejects_section_and_document_length_overruns() {
    for sections in [
        format!("{BODY} 01 0a000000 00"),
        format!("{BODY} 01 0a000000 6100 05000000"),
        "00200000001078000700000000".to_owned(),
    ] {
        assert_reply(&op_msg(0, &sections), 15, "Overflow", "Section exceeds the available message bytes");
    }
}

#[test]
fn requires_exactly_one_body() {
    assert_reply(&op_msg(0, "01060000006100"), 40587, "Location40587", "OP_MSG messages must have a body");
    assert_reply(
        &op_msg(0, &format!("{BODY}{BODY}")),
        40430,
        "Location40430",
        "Multiple body sections in message",
    );
}

#[test]
fn rejects_unknown_section_kind() {
    assert_reply(&op_msg(0, "05"), 40432, "Location40432", "Unknown section kind 5");
}

#[test]
fn rejects_duplicate_sequence_keys() {
    assert_reply(
        &op_msg(0, &format!("{BODY} 01060000006100 01060000006100")),
        40431,
        "Location40431",
        "Duplicate document sequence: a",
    );
    assert_reply(
        &op_msg(0, &format!("{BODY} 01060000007800")),
        40433,
        "Location40433",
        "Duplicate field between body and document sequence x",
    );
    let nested = "00140000000361000c000000106200010000000000";
    assert_reply(
        &op_msg(0, &format!("{nested}{}", sequence("a.b", ""))),
        40433,
        "Location40433",
        "Duplicate field between body and document sequence a.b",
    );
}

#[test]
fn rejects_duplicate_bson_fields_and_bad_bson_terminators() {
    for sections in ["0013000000107800070000001078000900000000", "000500000008"] {
        assert_reply(&op_msg(0, sections), 22, "InvalidBSON", "Invalid BSON document");
    }
}

#[test]
fn rejects_excessive_bson_nesting() {
    let mut document = hex("0500000000");
    for _ in 0..100 {
        let length = (document.len() + 8) as i32;
        let mut wrapper = length.to_le_bytes().to_vec();
        wrapper.extend_from_slice(b"\x03x\0");
        wrapper.extend(document);
        wrapper.push(0);
        document = wrapper;
    }
    let mut payload = vec![0; 5];
    payload.extend(document);
    assert_reply(&wire(2013, &payload), 22, "InvalidBSON", "Invalid BSON document");
}

#[test]
fn never_replies_to_malformed_more_to_come_requests() {
    assert!(matches!(
        parse_message(&op_msg(2, &format!("{BODY}{BODY}")), MAX),
        Err(WireError::CloseConnection(_))
    ));
}

#[test]
fn accepts_legacy_hello_spellings() -> Result<(), WireError> {
    for (name, bson) in [
        ("hello", "100000001068656c6c6f000100000000"),
        ("isMaster", "130000001069734d6173746572000100000000"),
        ("ismaster", "130000001069736d6173746572000100000000"),
    ] {
        let message = parse_message(&legacy(b"admin.$cmd", bson), MAX)?;
        assert_eq!(message.header.opcode, 2004);
        assert_eq!(message.body, doc! { name: 1 });
        assert!(!message.more_to_come);
        assert!(!message.exhaust_allowed);
    }
    Ok(())
}

#[test]
fn rejects_legacy_non_handshake_commands_and_namespaces() {
    let ping = "0f0000001070696e67000100000000";
    assert_reply(
        &legacy(b"admin.$cmd", ping),
        352,
        "UnsupportedOpQueryCommand",
        "Unsupported OP_QUERY command: ping. The client driver may require an upgrade. For more details see https://dochub.mongodb.org/core/legacy-opcode-removal",
    );
    let hello = "100000001068656c6c6f000100000000";
    assert!(matches!(parse_message(&legacy(b"other.$cmd", hello), MAX), Err(WireError::CloseConnection(_))));
    assert!(matches!(
        parse_message(&legacy(b"admin.$cmd", &format!("{hello}0500000000")), MAX),
        Err(WireError::CloseConnection(_))
    ));
}

#[test]
fn rejects_compressed_and_unsupported_opcodes() {
    let payload = hex("dd070000100000000000000000000000");
    for opcode in [2012, 2002, 1, 999] {
        assert!(matches!(parse_message(&wire(opcode, &payload), MAX), Err(WireError::CloseConnection(_))));
    }
}

#[test]
fn encodes_and_parses_op_msg() -> Result<(), WireError> {
    let body = doc! { "x": 7 };
    let frame = encode_op_msg(42, -5, &body)?;
    assert_eq!(frame, hex("210000002a000000fbffffffdd070000 00000000 000c0000001078000700000000"));
    let message = parse_message(&frame, MAX)?;
    assert_eq!(message.body, body);
    assert_eq!(message.header.response_to, -5);
    Ok(())
}

#[test]
fn encodes_legacy_reply() -> Result<(), WireError> {
    assert_eq!(
        encode_op_reply(42, -5, &doc! { "x": 7 })?,
        hex("
        300000002a000000fbffffff01000000
        00000000 0000000000000000 00000000 01000000
        0c0000001078000700000000
    ")
    );
    Ok(())
}

#[test]
fn parses_node_driver_legacy_handshake() -> Result<(), WireError> {
    let frame = hex("
        330100000100000000000000d40700000000000061646d696e2e24636d640000000000ffffffff
        0c0100001069736d61737465720001000000026261636b707265737375726500020000003200
        0868656c6c6f4f6b000103636c69656e7400b5000000036472697665720029000000026e616d
        6500070000006e6f64656a73000276657273696f6e0006000000372e372e30000002706c6174
        666f726d00150000004e6f64652e6a73207632362e31322e312c204c4500036f730058000000
        026e616d65000600000077696e33320002617263686974656374757265000400000078363400
        0276657273696f6e000b00000031302e302e3236333030000274797065000b00000057696e64
        6f77735f4e5400000004636f6d7072657373696f6e0011000000023000050000006e6f6e65000000
    ");
    let message = parse_message(&frame, MAX)?;
    assert_eq!(message.header.request_id, 1);
    assert_eq!(message.header.opcode, 2004);
    assert_eq!(
        message.body,
        doc! {
            "ismaster": 1, "backpressure": "2", "helloOk": true,
            "client": {
                "driver": { "name": "nodejs", "version": "7.7.0" },
                "platform": "Node.js v26.12.1, LE",
                "os": { "name": "win32", "architecture": "x64", "version": "10.0.26300", "type": "Windows_NT" },
            },
            "compression": ["none"],
        }
    );
    Ok(())
}

#[test]
fn parses_node_driver_find() -> Result<(), WireError> {
    let frame = hex("
        510000000300000000000000dd07000000000000003c0000000266696e6400060000006974656d7300
        0366696c746572000e000000105f6964000700000000022464620008000000666978747572650000
    ");
    let message = parse_message(&frame, MAX)?;
    assert_eq!(message.header.request_id, 3);
    assert_eq!(message.body, doc! { "find": "items", "filter": { "_id": 7 }, "$db": "fixture" });
    Ok(())
}

#[test]
fn parses_node_driver_insert_sequence() -> Result<(), WireError> {
    let frame = hex("
        900000000400000000000000dd07000000000000003200000002696e7365727400060000006974656d
        7300086f72646572656400010224646200080000006669787475726500000148000000646f63756d65
        6e7473001d000000105f69640007000000026e616d6500050000006665726e00001d000000105f6964
        0008000000026e616d6500050000006d6f73730000
    ");
    let message = parse_message(&frame, MAX)?;
    assert_eq!(message.header.request_id, 4);
    assert_eq!(
        message.body,
        doc! {
            "insert": "items", "ordered": true, "$db": "fixture", "documents": [
                { "_id": 7, "name": "fern" }, { "_id": 8, "name": "moss" },
            ],
        }
    );
    Ok(())
}
