use std::path::{Path, PathBuf};
use std::sync::mpsc;

use canopy_config::authoring::Command;
use canopy_mongo::mongodb::{Client, bson::doc};
use canopy_schema::{DEFAULT_SAMPLE_SIZE, schema_diff};
use futures_util::StreamExt as _;

use super::watch::Watched;
use crate::invocation::Invocation;
use crate::project::{LoadError, Loading, load_from};
use crate::schema_commands::{SchemaSource, collection_schemas};
use crate::{error_line, output};

/// Warns while the schema file and MongoDB disagree: checked at start, when the file is saved and when a
/// collection is created, changed (a validator), dropped or renamed. Nothing is ever written.
pub(crate) struct Drift {
    file: String,
    path: PathBuf,
    uri: String,
    database: String,
    watched: Watched,
    events: mpsc::Receiver<()>,
    task: tokio::task::JoinHandle<()>,
    previous: Vec<String>,
    overrides: Vec<(String, String)>,
}

impl Drift {
    pub(crate) fn start(
        runtime: &tokio::runtime::Runtime,
        cwd: &Path,
        file: &str,
        target: (&str, &str),
        overrides: &[(String, String)],
    ) -> Drift {
        let (uri, database) = target;
        let path = cwd.join(file);
        let shown = path.clone();
        let watched =
            Watched::new(cwd.to_path_buf(), false, move |candidate: &Path| candidate == shown.as_path());
        let (sender, events) = mpsc::channel();
        let (uri_owned, database_owned) = (uri.to_owned(), database.to_owned());
        let task = runtime.spawn(async move {
            let Ok(client) = Client::with_uri_str(&uri_owned).await else { return };
            let pipeline = [doc! { "$match": { "operationType": {
                "$in": ["create", "modify", "drop", "rename", "dropDatabase"]
            } } }];
            let Ok(mut stream) =
                client.database(&database_owned).watch().pipeline(pipeline).show_expanded_events(true).await
            else {
                return;
            };
            while let Some(event) = stream.next().await {
                if event.is_err() || sender.send(()).is_err() {
                    break;
                }
            }
        });
        Drift {
            file: file.to_owned(),
            path,
            uri: uri.to_owned(),
            database: database.to_owned(),
            watched,
            events,
            task,
            previous: Vec::new(),
            overrides: overrides.to_vec(),
        }
    }

    /// Checks again when the file or the collections changed since the last call; `force` checks at once.
    pub(crate) fn poll(&mut self, runtime: &tokio::runtime::Runtime, call: &Invocation, force: bool) {
        let mut due = force || self.watched.changed(super::SETTLE);
        while self.events.try_recv().is_ok() {
            due = true;
        }
        if due {
            self.check(runtime, call);
        }
    }

    fn check(&mut self, runtime: &tokio::runtime::Runtime, call: &Invocation) {
        match self.differences(runtime, call) {
            Ok(messages) => {
                if messages.is_empty() {
                    if !self.previous.is_empty() {
                        let _ = output(format_args!("schema  {} matches {} again", self.file, self.database));
                    }
                } else if messages != self.previous {
                    let _ = error_line(format_args!("schema  {} differs from {}:", self.file, self.database));
                    for message in &messages {
                        let _ = error_line(format_args!("  {message}"));
                    }
                    let _ = error_line(format_args!("schema  run canopy schema push or edit {}", self.file));
                }
                self.previous = messages;
            }
            Err(message) => {
                let _ = error_line(format_args!("schema  {message}"));
            }
        }
    }

    fn differences(
        &self,
        runtime: &tokio::runtime::Runtime,
        call: &Invocation,
    ) -> Result<Vec<String>, String> {
        let loading = Loading {
            command: Command::Dev,
            emit_as: Command::Dev,
            needs_policies: false,
            schema: Some(&self.path),
            env_files: true,
            overrides: &self.overrides,
        };
        let project = load_from(call, &loading).map_err(|error| match error {
            LoadError::Invalid { message, .. }
            | LoadError::Message(message)
            | LoadError::Unexpected(message) => {
                format!("Cannot load {}: {message}", self.file)
            }
        })?;
        let declared = project.bundle.schema.unwrap_or_default();
        let source = SchemaSource {
            policies: None,
            collection: None,
            sample_size: DEFAULT_SAMPLE_SIZE,
            infer_enums: false,
        };
        let actual = runtime.block_on(async {
            let client = Client::with_uri_str(&self.uri).await.map_err(|error| error.to_string())?;
            let schemas = collection_schemas(&client.database(&self.database), &source).await;
            client.shutdown().await;
            schemas
        })?;
        let report = schema_diff(&self.file, &self.database, &declared, &actual, None);
        let mut messages = report.errors;
        if report.exit_code != 0 {
            messages.pop();
        }
        Ok(messages)
    }

    pub(crate) fn stop(self) {
        self.task.abort();
    }
}
