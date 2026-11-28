//! Wire compatibility tests for the GraphQL WebSocket server.

#![allow(clippy::panic, clippy::unwrap_used)]

use std::time::Duration;

use canopy_graphql::ws::{
    Action, CONNECTION_INIT_TIMEOUT, Close, GRAPHQL_WS_SUBPROTOCOL, ServerConnection, SubscribePayload,
    credential_headers, offers_graphql_ws,
};
use canopy_protocol::json::{Json, parse_json};

const INIT: &str = r#"{"type":"connection_init"}"#;
const SUBSCRIBE: &str = r#"{"type":"subscribe","id":"ok","payload":{"query":"{ hello }"}}"#;
const COMPLETE: &str = r#"{"type":"complete","id":"ok"}"#;

fn json(text: &str) -> Json {
    parse_json(text).unwrap()
}

fn close(code: u16, reason: &str) -> Close {
    Close { code, reason: reason.into() }
}

fn acknowledged() -> ServerConnection {
    let mut connection = ServerConnection::open(GRAPHQL_WS_SUBPROTOCOL).unwrap();
    assert_eq!(connection.on_text(INIT), Some(Action::Init { payload: None }));
    assert_eq!(connection.ack(None).as_deref(), Some(r#"{"type":"connection_ack"}"#));
    connection
}

#[test]
fn negotiates_only_the_graphql_transport_protocol() {
    assert!(offers_graphql_ws(["graphql-ws, other", "\tgraphql-transport-ws\u{feff} "]));
    assert!(!offers_graphql_ws(["graphql-ws", "GraphQL-transport-ws"]));
    assert!(!offers_graphql_ws(["\u{85}graphql-transport-ws"]));
    assert_eq!(ServerConnection::open("graphql-ws").unwrap_err(), close(4406, "Subprotocol not acceptable"));
}

#[test]
fn initialization_deadline_ends_on_receipt_before_ack() {
    let mut connection = ServerConnection::default();
    assert_eq!(CONNECTION_INIT_TIMEOUT, Duration::from_secs(3));
    assert_eq!(connection.init_timed_out(), Some(close(4408, "Connection initialisation timeout")));
    assert_eq!(connection.ack(None), None);
    assert_eq!(
        connection.on_text(r#"{"type":"connection_init","payload":{"apikey":"secret"}}"#),
        Some(Action::Init { payload: Some(vec![("apikey".into(), Json::String("secret".into()))]) })
    );
    assert_eq!(connection.init_timed_out(), None);
    assert_eq!(
        connection.ack(Some(json(r#"{"accepted":true}"#))).as_deref(),
        Some(r#"{"type":"connection_ack","payload":{"accepted":true}}"#)
    );
    assert_eq!(connection.ack(None), None);
}

#[test]
fn null_init_and_duplicate_init_while_ack_is_pending() {
    let mut connection = ServerConnection::default();
    assert_eq!(
        connection.on_text(r#"{"type":"connection_init","payload":null}"#),
        Some(Action::Init { payload: None })
    );
    assert_eq!(
        connection.on_text(INIT),
        Some(Action::Close(close(4429, "Too many initialisation requests")))
    );
    assert_eq!(Close::forbidden(), close(4403, "Forbidden"));
}

#[test]
fn ping_and_pong_are_available_before_initialization() {
    let mut connection = ServerConnection::default();
    for (message, expected) in [
        (r#"{"type":"ping"}"#, r#"{"type":"pong"}"#),
        (r#"{"type":"ping","payload":null}"#, r#"{"type":"pong"}"#),
        (r#"{"type":"ping","payload":{}}"#, r#"{"type":"pong","payload":{}}"#),
        (
            r#"{"type":"ping","payload":{"z":1,"10":2,"2":3,"01":4,"nested":[{"a":1,"0":2}]}}"#,
            r#"{"type":"pong","payload":{"2":3,"10":2,"z":1,"01":4,"nested":[{"0":2,"a":1}]}}"#,
        ),
    ] {
        assert_eq!(connection.on_text(message), Some(Action::Send(expected.into())));
    }
    for message in
        [r#"{"type":"pong"}"#, r#"{"type":"pong","payload":null}"#, r#"{"type":"pong","payload":{"x":1}}"#]
    {
        assert_eq!(connection.on_text(message), None);
    }
    assert_eq!(connection.init_timed_out(), Some(close(4408, "Connection initialisation timeout")));
}

#[test]
fn subscribe_requires_ack_even_after_initialization_arrives() {
    let expected = Some(Action::Close(close(4401, "Unauthorized")));
    assert_eq!(ServerConnection::default().on_text(SUBSCRIBE), expected);
    let mut pending = ServerConnection::default();
    assert_eq!(pending.on_text(INIT), Some(Action::Init { payload: None }));
    assert_eq!(pending.on_text(SUBSCRIBE), expected);
}

#[test]
fn subscription_fields_preserve_null_and_missing_and_ids_are_unique() {
    let mut connection = acknowledged();
    assert_eq!(
        connection.on_text(SUBSCRIBE),
        Some(Action::Subscribe {
            id: "ok".into(),
            payload: SubscribePayload {
                query: "{ hello }".into(),
                operation_name: None,
                variables: None,
                extensions: None
            },
        })
    );
    assert_eq!(connection.on_text(r#"{"type":"subscribe","id":"__proto__","payload":{"query":"","operationName":null,"variables":null,"extensions":{"a":1}}}"#), Some(Action::Subscribe {
        id: "__proto__".into(),
        payload: SubscribePayload { query: "".into(), operation_name: Some(None), variables: Some(Json::Null), extensions: Some(json(r#"{"a":1}"#)) },
    }));
    assert_eq!(
        connection.on_text(SUBSCRIBE),
        Some(Action::Close(close(4409, "Subscriber for ok already exists")))
    );
}

#[test]
fn results_and_completion_follow_library_frame_order() {
    let mut connection = acknowledged();
    assert!(matches!(connection.on_text(SUBSCRIBE), Some(Action::Subscribe { .. })));
    assert_eq!(
        connection.next("ok", &json(r#"{"data":{"hello":"world"}}"#)).unwrap().as_deref(),
        Some(r#"{"id":"ok","type":"next","payload":{"data":{"hello":"world"}}}"#)
    );
    assert_eq!(
        connection.next("ok", &json(r#"{"errors":[{"message":"partial"}],"data":null}"#)).unwrap().as_deref(),
        Some(r#"{"id":"ok","type":"next","payload":{"data":null,"errors":[{"message":"partial"}]}}"#)
    );
    assert_eq!(connection.complete("ok").as_deref(), Some(r#"{"id":"ok","type":"complete"}"#));
    assert_eq!(connection.on_text(COMPLETE), None);
    assert_eq!(connection.complete("ok"), None);
    assert_eq!(connection.next("ok", &Json::Null), Ok(None));
    assert!(matches!(connection.on_text(SUBSCRIBE), Some(Action::Subscribe { .. })));
    assert_eq!(
        connection.error("ok", &[json(r#"{"message":"failed"}"#)]).unwrap().as_deref(),
        Some(r#"{"id":"ok","type":"error","payload":[{"message":"failed"}]}"#)
    );
    assert_eq!(connection.complete("ok"), None);
    assert_eq!(connection.on_text(COMPLETE), None);
}

#[test]
fn client_completion_only_cancels_active_operations() {
    let mut connection = acknowledged();
    assert_eq!(connection.on_text(COMPLETE), None);
    assert!(matches!(connection.on_text(SUBSCRIBE), Some(Action::Subscribe { .. })));
    assert_eq!(connection.on_text(COMPLETE), Some(Action::Unsubscribe { id: "ok".into() }));
    assert_eq!(connection.on_text(COMPLETE), None);
    assert_eq!(connection.complete("ok"), None);
    assert_eq!(connection.error("ok", &[json(r#"{"message":"failed"}"#)]), Ok(None));
    assert!(matches!(connection.on_text(SUBSCRIBE), Some(Action::Subscribe { .. })));
}

#[test]
fn invalid_messages_all_use_the_same_wire_reason() {
    for message in [
        "{",
        "null",
        "[]",
        "42",
        r#""ping""#,
        "{}",
        r#"{"type":""}"#,
        r#"{"type":4}"#,
        r#"{"type":"unknown"}"#,
        r#"{"type":"connection_init","payload":[]}"#,
        r#"{"type":"connection_ack","payload":true}"#,
        r#"{"type":"ping","payload":[]}"#,
        r#"{"type":"pong","payload":0}"#,
        r#"{"type":"subscribe","payload":{"query":""}}"#,
        r#"{"type":"subscribe","id":1,"payload":{"query":""}}"#,
        r#"{"type":"subscribe","id":"","payload":{"query":""}}"#,
        r#"{"type":"subscribe","id":"x","payload":null}"#,
        r#"{"type":"subscribe","id":"x","payload":[]}"#,
        r#"{"type":"subscribe","id":"x","payload":{}}"#,
        r#"{"type":"subscribe","id":"x","payload":{"query":false}}"#,
        r#"{"type":"subscribe","id":"x","payload":{"query":"","variables":[]}}"#,
        r#"{"type":"subscribe","id":"x","payload":{"query":"","operationName":{}}}"#,
        r#"{"type":"subscribe","id":"x","payload":{"query":"","extensions":true}}"#,
        r#"{"type":"complete","id":""}"#,
        r#"{"type":"next","id":"x","payload":null}"#,
        r#"{"type":"error","id":"x","payload":[]}"#,
        r#"{"type":"error","id":"x","payload":[{}]}"#,
        r#"{"type":"error","id":"x","payload":[null]}"#,
    ] {
        assert_eq!(
            ServerConnection::default().on_text(message),
            Some(Action::Close(close(4400, "Invalid message received"))),
            "{message}"
        );
    }
}

#[test]
fn unexpected_server_messages_and_invalid_execution_payloads_close_internally() {
    let expected = close(4500, "Internal server error");
    for message in [
        r#"{"type":"connection_ack"}"#,
        r#"{"type":"next","id":"x","payload":{}}"#,
        r#"{"type":"error","id":"x","payload":[{"message":null}]}"#,
    ] {
        assert_eq!(ServerConnection::default().on_text(message), Some(Action::Close(expected.clone())));
    }
    let mut connection = acknowledged();
    assert!(matches!(connection.on_text(SUBSCRIBE), Some(Action::Subscribe { .. })));
    assert_eq!(connection.next("ok", &Json::Null), Err(expected.clone()));
    assert_eq!(connection.error("ok", &[]), Err(expected));
}

#[test]
fn binary_frames_follow_canopys_bun_adapter() {
    assert_eq!(ServerConnection::default().on_binary(), Action::Close(close(4400, "Expected a text frame")));
}

#[test]
fn credential_overrides_match_nullish_precedence_and_header_case() {
    let headers = vec![
        ("ApiKey".into(), "old".into()),
        ("AUTHORIZATION".into(), "old auth".into()),
        ("other".into(), "unchanged".into()),
    ];
    let Json::Object(params) = json(
        r#"{"apikey":" lower ","Apikey":"upper","authorization":null,"Authorization":"Bearer new","other":"ignored"}"#,
    ) else {
        panic!("expected object");
    };
    assert_eq!(
        credential_headers(&headers, Some(&params)),
        vec![
            ("other".into(), "unchanged".into()),
            ("apikey".into(), "lower".into()),
            ("authorization".into(), "Bearer new".into()),
        ]
    );
    let Json::Object(params) = json(r#"{"apikey":false,"Apikey":"upper","AUTHORIZATION":"ignored"}"#) else {
        panic!("expected object");
    };
    assert_eq!(credential_headers(&headers, Some(&params)), headers);
    assert_eq!(credential_headers(&headers, None), headers);
}
