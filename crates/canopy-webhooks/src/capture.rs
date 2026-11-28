use std::{sync::Arc, time::Duration};

use canopy_engine::{Normalized, Op, normalize};
use canopy_mongo::mongodb::{
    self, Collection, Database,
    bson::{self, Bson, Document, RawDocumentBuf, doc},
    change_stream::{ChangeStream, event::ResumeToken},
    error::{Error, ErrorKind},
    options::{FullDocumentBeforeChangeType, FullDocumentType},
};
use canopy_protocol::json::{Json, write_json};
use canopy_protocol::{CanopyError, bson::decode_document, ejson::canonical_string};
use serde_json::Value as DriverJson;
use tokio::sync::watch;

use crate::{Kind, Webhooks, invalid, unavailable};

const STREAM: &str = "webhooks";
type Stream = ChangeStream<RawDocumentBuf>;

impl Webhooks {
    /// Enqueues the matching deliveries of one MongoDB data change. The change must include its resume token.
    pub async fn capture(&self, raw: &RawDocumentBuf) -> Result<usize, CanopyError> {
        let Some(Normalized::Data(event)) = normalize(raw.as_bytes()) else {
            return Err(invalid("Expected a webhook data change"));
        };
        let raw = Document::try_from(raw.as_ref()).map_err(unavailable)?;
        let token = raw.get("_id").ok_or_else(|| invalid("The change has no resume token"))?;
        let token_id = match token.as_document().and_then(|doc| doc.get_str("_data").ok()) {
            Some(data) => data.to_owned(),
            None => {
                let wrapper = doc! { "token": token };
                let decoded = decode_document(&wrapper.to_vec().map_err(unavailable)?)?;
                canonical_string(decoded.get("token").ok_or_else(|| invalid("Invalid resume token"))?)?
            }
        };
        let before = raw.get_document("fullDocumentBeforeChange").ok();
        let post = raw.get_document("fullDocument").ok().filter(|_| event.op != Op::Delete);
        let mut stored = 0;
        for (name, hook) in &self.hooks {
            let Kind::Trigger { collection, operations, filter } = &hook.kind else {
                continue;
            };
            let operation = event.op.as_str();
            if collection != &event.coll || !operations.iter().any(|op| op == operation) {
                continue;
            }
            if let Some(filter) = filter {
                let image = if event.op == Op::Delete { before } else { post };
                let Some(image) = image else {
                    continue;
                };
                let image = decode_document(&image.to_vec().map_err(unavailable)?)?;
                match filter.matches(&image) {
                    Ok(true) => {}
                    Ok(false) => continue,
                    Err(error) => {
                        tracing::warn!(hook = name, error = %error, "Webhook filter evaluation failed");
                        continue;
                    }
                }
            }
            let mut payload = doc! {
                "type": "trigger", "trigger": name, "collection": collection, "operation": operation,
                "documentId": raw.get_document("documentKey").ok().and_then(|key| key.get("_id")),
                "document": post.cloned(),
            };
            if let Some(before) = before.filter(|_| event.op != Op::Insert) {
                payload.insert("before", before.clone());
            }
            if let Some(diff) = &event.diff {
                let updated = raw
                    .get_document("updateDescription")
                    .and_then(|desc| desc.get_document("updatedFields"))
                    .cloned()
                    .unwrap_or_default();
                payload.insert(
                    "updateDescription",
                    doc! { "updatedFields": updated, "removedFields": &diff.unset },
                );
            }
            payload.insert("clusterTime", event.ct.to_string());
            if let Some(at) = event.wall_ms {
                payload.insert("wallTime", bson::DateTime::from_millis(at));
            }
            let id = format!("trigger:{name}:{token_id}");
            let body = body(payload);
            stored += usize::from(self.enqueue(&id, name, "trigger", body).await?);
        }
        Ok(stored)
    }

    fn checkpoints(&self) -> Collection<Document> {
        self.meta.collection("checkpoints")
    }

    pub(crate) async fn open_capture(
        &self,
        app: &Database,
    ) -> Result<(Stream, Option<ResumeToken>), CanopyError> {
        let mut token = self
            .checkpoints()
            .find_one(doc! { "_id": STREAM })
            .await
            .map_err(unavailable)?
            .and_then(|mut state| state.remove("token"))
            .map(bson::deserialize_from_bson)
            .transpose()
            .map_err(unavailable)?;
        let stream = match self.watch_changes(app, token.clone()).await {
            Err(error) if history_lost(&error) => {
                tracing::error!("Webhook change stream history lost, restarting from now");
                token = None;
                self.watch_changes(app, None).await
            }
            result => result,
        }
        .map_err(unavailable)?;
        if token.is_none()
            && let Some(initial) = stream.resume_token()
        {
            self.save_checkpoint(&initial, Some("0")).await?;
            token = Some(initial);
        }
        Ok((stream, token))
    }

    async fn watch_changes(
        &self,
        app: &Database,
        token: Option<ResumeToken>,
    ) -> mongodb::error::Result<Stream> {
        let collections = self
            .hooks
            .values()
            .filter_map(|hook| match &hook.kind {
                Kind::Trigger { collection, .. } => Some(collection.as_str()),
                Kind::Schedule { .. } => None,
            })
            .collect::<Vec<_>>();
        let pipeline = vec![
            doc! { "$match": { "$or": [
                { "operationType": { "$in": ["insert", "update", "replace", "delete"] }, "ns.coll": { "$in": collections } },
                { "operationType": "invalidate" },
            ] } },
            doc! { "$changeStreamSplitLargeEvent": {} },
        ];
        let mut watch = app.watch().pipeline(pipeline).batch_size(0).max_await_time(Duration::from_secs(1));
        watch = if self.options.images {
            watch
                .full_document(FullDocumentType::Required)
                .full_document_before_change(FullDocumentBeforeChangeType::Required)
        } else {
            watch.full_document(FullDocumentType::UpdateLookup)
        };
        if let Some(token) = token {
            watch = watch.start_after(token);
        }
        Ok(watch.await?.with_type::<RawDocumentBuf>())
    }

    pub(crate) async fn capture_loop(
        self: Arc<Self>,
        app: Database,
        mut stream: Stream,
        mut token: Option<ResumeToken>,
        mut stop: watch::Receiver<bool>,
    ) {
        if token.is_none() {
            token = stream.resume_token();
        }
        loop {
            match self.consume(&mut stream, &mut token, &mut stop).await {
                Ok(()) => return,
                Err(error) => tracing::error!(error = %error, "Webhook change stream interrupted"),
            }
            loop {
                tokio::select! {
                    biased;
                    _ = stop.changed() => return,
                    _ = tokio::time::sleep(Duration::from_millis(500)) => {}
                }
                let reopened = tokio::select! {
                    biased;
                    _ = stop.changed() => return,
                    result = self.watch_changes(&app, token.clone()) => result,
                };
                match reopened {
                    Ok(new) => {
                        stream = new;
                        if token.is_none() {
                            token = stream.resume_token();
                        }
                        break;
                    }
                    Err(error) if history_lost(&error) => {
                        tracing::error!("Webhook change stream history lost, restarting from now");
                        token = None;
                    }
                    Err(error) => tracing::error!(error = %error, "Could not reopen webhook change stream"),
                }
            }
        }
    }

    async fn save_checkpoint(&self, token: &ResumeToken, ct: Option<&str>) -> Result<(), CanopyError> {
        let value = bson::serialize_to_bson(token).map_err(unavailable)?;
        let mut set = doc! { "token": value, "node": &self.options.node, "at": self.now() };
        let update = if let Some(ct) = ct {
            set.insert("ct", ct);
            doc! { "$set": set }
        } else {
            doc! { "$set": set, "$setOnInsert": { "ct": "0" } }
        };
        self.checkpoints()
            .update_one(doc! { "_id": STREAM }, update)
            .upsert(true)
            .await
            .map_err(unavailable)?;
        Ok(())
    }

    async fn consume(
        &self,
        stream: &mut Stream,
        token: &mut Option<ResumeToken>,
        stop: &mut watch::Receiver<bool>,
    ) -> Result<(), CanopyError> {
        let mut fragments = Document::new();
        let mut last_ct = None;
        loop {
            let next = tokio::select! {
                biased;
                _ = stop.changed() => return Ok(()),
                next = stream.next_if_any() => next,
            }
            .map_err(unavailable)?;
            if let Some(raw) = next {
                let change = Document::try_from(raw.as_ref()).map_err(unavailable)?;
                let change = if let Ok(split) = change.get_document("splitEvent") {
                    let done = split.get_i32("fragment").map_err(unavailable)?
                        == split.get_i32("of").map_err(unavailable)?;
                    fragments.extend(change.into_iter().filter(|(key, _)| key != "splitEvent"));
                    if !done {
                        continue;
                    }
                    std::mem::take(&mut fragments)
                } else {
                    change
                };
                if let Ok(ct) = change.get_timestamp("clusterTime") {
                    last_ct = Some(canopy_engine::Ct::from_parts(ct.time, ct.increment).to_string());
                }
                if change.get_str("operationType").ok() != Some("invalidate") {
                    self.capture(&RawDocumentBuf::try_from(&change).map_err(unavailable)?).await?;
                }
            } else if !fragments.is_empty() {
                continue;
            }
            let current = stream.resume_token();
            if current != *token
                && let Some(current) = current
            {
                self.save_checkpoint(&current, last_ct.as_deref()).await?;
                *token = Some(current);
            }
            if !stream.is_alive() {
                return Err(unavailable("The webhook change stream closed"));
            }
        }
    }
}

fn history_lost(error: &Error) -> bool {
    matches!(error.kind.as_ref(), ErrorKind::Command(command) if [260, 280, 286].contains(&command.code))
}

pub(crate) fn body(payload: Document) -> String {
    let mut text = String::new();
    write_json(&mut text, &relaxed(Bson::Document(payload)));
    text
}

fn relaxed(value: Bson) -> Json {
    match value {
        Bson::Document(document) => object(document.into_iter().map(|(key, value)| (key, relaxed(value)))),
        Bson::Array(items) => Json::Array(items.into_iter().map(relaxed).collect()),
        Bson::Double(value) if value.is_finite() => Json::Number(value),
        Bson::Double(value) if value.is_nan() => tagged("$numberDouble", Json::String("NaN".into())),
        Bson::Int64(value) => Json::Number(value as f64),
        Bson::Undefined => Json::Null,
        Bson::DateTime(at) => {
            let millis = at.timestamp_millis();
            let date = if (0..253_402_300_800_000).contains(&millis)
                && let Ok(iso) = crate::iso(at)
            {
                Json::String(if millis % 1000 == 0 { iso.replace(".000Z", "Z") } else { iso })
            } else {
                tagged("$numberLong", Json::String(millis.to_string()))
            };
            tagged("$date", date)
        }
        Bson::Timestamp(timestamp) => tagged(
            "$timestamp",
            object([
                ("t".into(), Json::Number(f64::from(timestamp.time))),
                ("i".into(), Json::Number(f64::from(timestamp.increment))),
            ]),
        ),
        Bson::RegularExpression(regex) => {
            let mut options: Vec<_> = regex.options.as_str().chars().collect();
            options.sort_unstable();
            tagged(
                "$regularExpression",
                object([
                    ("pattern".into(), Json::String(regex.pattern.into_string())),
                    ("options".into(), Json::String(options.into_iter().collect())),
                ]),
            )
        }
        Bson::JavaScriptCodeWithScope(code) => object([
            ("$code".into(), Json::String(code.code)),
            ("$scope".into(), relaxed(Bson::Document(code.scope))),
        ]),
        other => driver_json(other.into_relaxed_extjson()),
    }
}

fn object(fields: impl IntoIterator<Item = (String, Json)>) -> Json {
    let (mut indices, names): (Vec<_>, Vec<_>) =
        fields.into_iter().partition(|(key, _)| js_index(key).is_some());
    indices.sort_by_key(|(key, _)| js_index(key));
    indices.extend(names);
    Json::Object(indices)
}

fn js_index(key: &str) -> Option<u32> {
    if key.starts_with('+') || (key.len() > 1 && key.starts_with('0')) {
        return None;
    }
    key.parse().ok().filter(|index| *index != u32::MAX)
}

fn tagged(tag: &str, value: Json) -> Json {
    Json::Object(vec![(tag.to_owned(), value)])
}

fn driver_json(value: DriverJson) -> Json {
    match value {
        DriverJson::Null => Json::Null,
        DriverJson::Bool(value) => Json::Bool(value),
        DriverJson::String(value) => Json::String(value),
        DriverJson::Number(value) => value.as_f64().map_or(Json::Null, Json::Number),
        DriverJson::Array(items) => Json::Array(items.into_iter().map(driver_json).collect()),
        DriverJson::Object(fields) => {
            object(fields.into_iter().map(|(key, value)| (key, driver_json(value))))
        }
    }
}
