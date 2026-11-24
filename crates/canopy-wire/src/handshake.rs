use canopy_mongo::mongodb::bson::{DateTime, Document, doc};

use crate::frame::Compressor;

pub(crate) fn negotiate(request: &Document) -> Option<Vec<Compressor>> {
    let offered = request.get_array("compression").ok()?;
    let mut negotiated = Vec::new();
    for compressor in offered.iter().filter_map(|item| item.as_str().and_then(Compressor::named)) {
        if !negotiated.contains(&compressor) {
            negotiated.push(compressor);
        }
    }
    Some(negotiated)
}

pub(crate) fn hello(
    command: &str,
    request: &Document,
    connection_id: i64,
    service_enabled: bool,
    compressors: Option<&[Compressor]>,
) -> Document {
    let writable = if command == "hello" { "isWritablePrimary" } else { "ismaster" };
    let mut reply = doc! {
        "msg": "isdbgrid",
        "maxBsonObjectSize": 16_777_216,
        "maxMessageSizeBytes": 48_000_000,
        "maxWriteBatchSize": 100_000,
        "localTime": DateTime::now(),
        "logicalSessionTimeoutMinutes": 30,
        "connectionId": connection_id,
        "minWireVersion": 0,
        "maxWireVersion": 25,
        "readOnly": false,
        "ok": 1.0,
    };
    reply.insert(writable, true);
    if let Some(compressors) = compressors {
        reply.insert(
            "compression",
            compressors.iter().map(|compressor| compressor.name()).collect::<Vec<_>>(),
        );
    }
    if request.get_bool("helloOk").is_ok() {
        reply.insert("helloOk", true);
    }
    if let Ok(user) = request.get_str("saslSupportedMechs") {
        let mechanisms =
            if service_enabled && user.rsplit_once('.').is_some_and(|(_, name)| name == "service") {
                vec!["SCRAM-SHA-256"]
            } else {
                Vec::new()
            };
        reply.insert("saslSupportedMechs", mechanisms);
    }
    reply
}

pub(crate) fn build_info() -> Document {
    doc! { "version": "8.0.34", "versionArray": [8, 0, 34, 0], "maxBsonObjectSize": 16_777_216, "ok": 1.0 }
}
