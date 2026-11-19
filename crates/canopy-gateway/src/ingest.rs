use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use canopy_engine::{Ct, Event, Normalized, merge_fragments, normalize};
use canopy_protocol::bson::{decode_document, encode_document};
use futures_util::StreamExt;
use mongodb::Database;
use mongodb::bson::{RawDocumentBuf, doc};
use mongodb::change_stream::ChangeStream;
use mongodb::change_stream::event::ResumeToken;
use mongodb::error::{Error, ErrorKind};
use mongodb::options::{FullDocumentBeforeChangeType, FullDocumentType};
use tokio::sync::{Notify, mpsc};

use crate::config::FullDocument;
use crate::core::{Command, EngineSender};
use crate::log::Log;
use crate::mongo::Checkpoints;

const HISTORY_LOST: [i32; 3] = [260, 280, 286];
const MAX_BATCH: usize = 1000;
const DATA_OPS: [&str; 4] = ["insert", "update", "replace", "delete"];

fn server_code(error: &Error) -> Option<i32> {
    match error.kind.as_ref() {
        ErrorKind::Command(command) => Some(command.code),
        _ => None,
    }
}

fn history_lost(error: &Error) -> bool {
    server_code(error).is_some_and(|code| HISTORY_LOST.contains(&code))
}

enum End {
    Reopen,
    HistoryLost,
    Failed(Error),
}

/// Reads the one change stream of the app database: filters it to the watched collections, reassembles split
/// events, hands normalized batches to the engine in stream order, saves the position and restarts from now
/// when the history it needs is gone.
pub(crate) struct Ingest {
    pub(crate) db: Database,
    pub(crate) mode: FullDocument,
    pub(crate) watched: Arc<Mutex<Vec<String>>>,
    pub(crate) reopen: Arc<Notify>,
    pub(crate) checkpoints: Checkpoints,
    pub(crate) engine: EngineSender,
    pub(crate) open: Arc<AtomicBool>,
    pub(crate) log: Log,
}

impl Ingest {
    fn pipeline(&self) -> Vec<mongodb::bson::Document> {
        let watched: Vec<String> = self.watched.lock().map(|list| list.clone()).unwrap_or_default();
        vec![
            doc! { "$match": { "$or": [
                { "operationType": { "$in": ["insert", "update", "replace", "delete", "drop", "rename"] }, "ns.coll": { "$in": watched } },
                { "operationType": { "$in": ["dropDatabase", "invalidate"] } },
            ] } },
            doc! { "$changeStreamSplitLargeEvent": {} },
        ]
    }

    async fn open_stream(&self, token: Option<ResumeToken>) -> Result<ChangeStream<RawDocumentBuf>, Error> {
        let full = match self.mode {
            FullDocument::UpdateLookup => FullDocumentType::UpdateLookup,
            FullDocument::Images => FullDocumentType::Required,
            FullDocument::Auto => FullDocumentType::WhenAvailable,
        };
        let mut watch =
            self.db.watch().pipeline(self.pipeline()).full_document(full).show_expanded_events(true);
        watch = match self.mode {
            FullDocument::UpdateLookup => watch,
            FullDocument::Images => watch.full_document_before_change(FullDocumentBeforeChangeType::Required),
            FullDocument::Auto => {
                watch.full_document_before_change(FullDocumentBeforeChangeType::WhenAvailable)
            }
        };
        if let Some(token) = token {
            watch = watch.start_after(token);
        }
        Ok(watch.await?.with_type::<RawDocumentBuf>())
    }

    /// Runs until the process ends.
    pub(crate) async fn run(self) {
        let mut token = self.checkpoints.load().await;
        let mut restarted = false;
        loop {
            match self.open_stream(token.clone()).await {
                Ok(mut stream) => {
                    self.open.store(true, Ordering::Release);
                    if restarted {
                        let _ = self.engine.send(Command::Restart("history_lost".to_owned()));
                        restarted = false;
                    }
                    let end = self.consume(&mut stream, &mut token).await;
                    self.open.store(false, Ordering::Release);
                    match end {
                        End::Reopen => {}
                        End::HistoryLost => {
                            self.log.error("change stream history lost, restarting from now", &[]);
                            token = None;
                            restarted = true;
                        }
                        End::Failed(error) => {
                            self.log.warn("change stream failed, reopening", &[("err", &error.to_string())]);
                            tokio::time::sleep(Duration::from_millis(500)).await;
                        }
                    }
                }
                Err(error) if history_lost(&error) => {
                    self.log.error("change stream history lost, restarting from now", &[]);
                    token = None;
                    restarted = true;
                }
                Err(error) => {
                    self.log.error("change stream could not be opened", &[("err", &error.to_string())]);
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
            }
        }
    }

    async fn consume(
        &self,
        stream: &mut ChangeStream<RawDocumentBuf>,
        token: &mut Option<ResumeToken>,
    ) -> End {
        let (tx, mut rx) = mpsc::channel::<Result<(RawDocumentBuf, Option<ResumeToken>), Error>>(MAX_BATCH * 2);
        let reader = async {
            loop {
                match stream.next().await {
                    Some(Ok(event)) => {
                        let current = stream.resume_token();
                        if tx.send(Ok((event, current))).await.is_err() {
                            break;
                        }
                    }
                    Some(Err(error)) => {
                        let _ = tx.send(Err(error)).await;
                        break;
                    }
                    None => {
                        let _ = tx.send(Err(Error::custom("the change stream closed"))).await;
                        break;
                    }
                }
            }
            std::future::pending::<()>().await;
        };
        let consumer = async {
            let mut fragments: Vec<canopy_protocol::Document> = Vec::new();
            let mut last = Ct::ZERO;
            let mut saved = Instant::now();
            let mut since_save = 0usize;
            loop {
                let mut raw = Vec::new();
                match tokio::time::timeout(Duration::from_secs(1), rx.recv()).await {
                    Err(_) => {}
                    Ok(None) => return End::Failed(Error::custom("the change stream closed")),
                    Ok(Some(item)) => raw.push(item),
                }
                while raw.len() < MAX_BATCH {
                    match rx.try_recv() {
                        Ok(item) => raw.push(item),
                        Err(_) => break,
                    }
                }
                let mut events: Vec<Event> = Vec::new();
                let mut failure = None;
                for item in raw {
                    let (event, current) = match item {
                        Ok(pair) => pair,
                        Err(error) => {
                            failure = Some(error);
                            break;
                        }
                    };
                    if current.is_some() {
                        *token = current;
                    }
                    let bytes = match event.get_document("splitEvent") {
                        Ok(split) => {
                            let (fragment, of) =
                                (split.get_i32("fragment").unwrap_or(0), split.get_i32("of").unwrap_or(0));
                            if let Ok(document) = decode_document(event.as_bytes()) {
                                fragments.push(document);
                            }
                            if fragment != of {
                                continue;
                            }
                            let merged = merge_fragments(&fragments);
                            fragments.clear();
                            encode_document(&merged).unwrap_or_default()
                        }
                        Err(_) => event.into_bytes(),
                    };
                    let op = mongodb::bson::RawDocument::from_bytes(&bytes)
                        .ok()
                        .and_then(|document| document.get_str("operationType").ok().map(str::to_owned));
                    match normalize(&bytes) {
                        Some(Normalized::Data(event)) => {
                            last = last.max(event.ct);
                            events.push(event);
                        }
                        Some(Normalized::Control(control)) => {
                            last = last.max(control.ct);
                            if !events.is_empty() {
                                let _ = self.engine.send(Command::Events(std::mem::take(&mut events)));
                            }
                            let _ = self.engine.send(Command::Control(control));
                        }
                        None if op.as_deref().is_none_or(|op| DATA_OPS.contains(&op)) => {
                            if !events.is_empty() {
                                let _ = self.engine.send(Command::Events(std::mem::take(&mut events)));
                            }
                            fragments.clear();
                            self.log.error(
                                "change stream returned an event that cannot be read, resynchronizing",
                                &[],
                            );
                            let _ = self.engine.send(Command::Restart("malformed_event".to_owned()));
                        }
                        None => {}
                    }
                    since_save += 1;
                }
                if !events.is_empty() {
                    let _ = self.engine.send(Command::Events(events));
                }
                if let Some(error) = failure {
                    return if history_lost(&error) { End::HistoryLost } else { End::Failed(error) };
                }
                if since_save >= 1000 || saved.elapsed() >= Duration::from_secs(1) {
                    since_save = 0;
                    saved = Instant::now();
                    let _ = self.engine.send(Command::Progress(last));
                    if let Some(token) = token.as_ref() {
                        self.checkpoints.save(token, last).await;
                    }
                }
            }
        };
        tokio::select! {
            () = self.reopen.notified() => End::Reopen,
            () = reader => End::Reopen,
            end = consumer => end,
        }
    }
}
