use std::collections::BTreeSet;
use std::process::ExitCode;
use std::time::Duration;

use canopy_config::authoring::Command;
use canopy_mongo::mongodb::{
    Client, Database,
    bson::{Bson, Document, doc},
    error::ErrorKind,
};
use canopy_policy::{LintEnvironment, PolicySet, lint_policies};
use canopy_protocol::json::Json;
use futures_util::{StreamExt as _, TryStreamExt as _};

use crate::diagnostics::{self, MIN_FEATURE_COMPATIBILITY_VERSION, Target};
use crate::invocation::Invocation;
use crate::meta::{app_target, with_client};
use crate::policies::format_finding;
use crate::{error_line, output};

const SAMPLE_SIZE: i32 = 200;
const SEARCH_NOT_ENABLED: [i32; 2] = [31082, 6_047_401];

#[derive(PartialEq)]
enum Status {
    Ok,
    Warn,
    Fail,
}

struct Report {
    failed: bool,
}

impl Report {
    fn check(&mut self, status: Status, message: &str) -> Result<(), String> {
        match status {
            Status::Ok => output(format_args!("ok    {message}")),
            Status::Warn => output(format_args!("warn  {message}")),
            Status::Fail => {
                self.failed = true;
                error_line(format_args!("fail  {message}"))
            }
        }
    }

    fn diagnose(&mut self, diagnostic: &diagnostics::Diagnostic) -> Result<(), String> {
        self.failed = true;
        error_line(format_args!("{}", diagnostics::format(diagnostic)))
    }
}

/// Every dotted path of the sampled documents, looking through arrays, for the `unknown-field` lint rule.
fn sampled_paths(documents: &[Document]) -> Vec<String> {
    fn visit(value: &Bson, prefix: &str, out: &mut BTreeSet<String>) {
        match value {
            Bson::Array(items) => items.iter().for_each(|item| visit(item, prefix, out)),
            Bson::Document(document) => {
                for (key, child) in document {
                    let path = if prefix.is_empty() { key.clone() } else { format!("{prefix}.{key}") };
                    out.insert(path.clone());
                    visit(child, &path, out);
                }
            }
            _ => {}
        }
    }
    let mut out = BTreeSet::new();
    for document in documents {
        visit(&Bson::Document(document.clone()), "", &mut out);
    }
    let mut paths: Vec<String> = out.into_iter().collect();
    paths.sort_by(|a, b| canopy_schema::js_cmp(a, b));
    paths
}

fn search_collections(resolution: &canopy_config::authoring::Resolution) -> Vec<String> {
    match resolution.value("collections") {
        Some(Json::Object(entries)) => entries
            .iter()
            .filter(|(_, collection)| collection.get("search") == Some(&Json::Bool(true)))
            .map(|(name, _)| name.clone())
            .collect(),
        _ => Vec::new(),
    }
}

/// `canopy doctor`: checks the deployment (replica set, version, change streams), that the policies load and
/// lint cleanly, which policy fields lack an index, and whether search is available. It never creates
/// anything.
pub(crate) fn run(call: &Invocation) -> Result<ExitCode, String> {
    let debug = call.has_flag("debug");
    let project =
        crate::project::configure(call, Command::Doctor, false).map_err(|error| error.text(debug))?;
    let (uri, database) = app_target(call, &project, "doctor")?;
    let set = project.dir_given.then(|| project.bundle.policy_set()).transpose()?;
    let dir = project.policy_dir.to_string_lossy().into_owned();
    let search = search_collections(&project.resolution);
    let target = Target::of(&uri, Some(&database));
    with_client(&uri, |client| async move {
        let mut report = Report { failed: false };
        if let Err(error) = client.database("admin").run_command(doc! { "ping": 1 }).await {
            report.diagnose(&diagnostics::of(&error, &target))?;
            return Ok(ExitCode::FAILURE);
        }
        report.check(Status::Ok, "connected to MongoDB")?;
        deployment(&client, &mut report, &target).await?;
        let db = client.database(&database);
        change_streams(&db, &mut report, &target).await?;
        let set = match set {
            Some(set) => {
                report.check(
                    Status::Ok,
                    &format!("{} policy collections loaded from {dir}", set.collections().len()),
                )?;
                set
            }
            None => canopy_policy::create_policy_set(Vec::new(), Vec::new())
                .map_err(|error| error.message().to_owned())?,
        };
        policies(&db, &set, &mut report).await?;
        report.check(
            Status::Warn,
            "DLS is enforced by Canopy, not inside mongod: clients holding MongoDB credentials bypass it",
        )?;
        for (status, message) in search_checks(&db, &search).await {
            report.check(status, &message)?;
        }
        Ok(if report.failed { ExitCode::FAILURE } else { ExitCode::SUCCESS })
    })
}

async fn deployment(client: &Client, report: &mut Report, target: &Target) -> Result<(), String> {
    let admin = client.database("admin");
    let hello = admin.run_command(doc! { "hello": 1 }).await.map_err(|error| error.to_string())?;
    let sharded = hello.get_str("msg").is_ok_and(|msg| msg == "isdbgrid");
    match hello.get_str("setName") {
        Ok(name) if !sharded => report.check(Status::Ok, &format!("topology: replica set {name}"))?,
        _ if sharded => report.check(Status::Ok, "topology: sharded cluster")?,
        _ => report
            .check(Status::Fail, "standalone server: change streams and transactions need a replica set")?,
    }
    let info = admin.run_command(doc! { "buildInfo": 1 }).await.map_err(|error| error.to_string())?;
    let version = info.get_str("version").unwrap_or("0").to_owned();
    let major: f64 = version.split('.').next().and_then(|major| major.parse().ok()).unwrap_or(f64::NAN);
    let min: f64 = MIN_FEATURE_COMPATIBILITY_VERSION.parse().unwrap_or(8.0);
    if major >= min.trunc() {
        report.check(Status::Ok, &format!("MongoDB {version}"))?;
    } else {
        report.check(
            Status::Fail,
            &format!(
                "MongoDB {version} is too old; {MIN_FEATURE_COMPATIBILITY_VERSION} or newer is required"
            ),
        )?;
    }
    match admin.run_command(doc! { "getParameter": 1, "featureCompatibilityVersion": 1 }).await {
        Ok(answer) => {
            let fcv = answer
                .get_document("featureCompatibilityVersion")
                .ok()
                .and_then(|fcv| fcv.get_str("version").ok())
                .unwrap_or("unknown")
                .to_owned();
            if fcv.parse::<f64>().is_ok_and(|value| value >= min) {
                report.check(Status::Ok, &format!("featureCompatibilityVersion {fcv}"))?;
            } else {
                report.diagnose(&diagnostics::feature_compatibility(Some(&fcv), target))?;
            }
        }
        Err(error) => {
            report.check(Status::Warn, &format!("featureCompatibilityVersion could not be read: {error}"))?
        }
    }
    Ok(())
}

async fn change_streams(db: &Database, report: &mut Report, target: &Target) -> Result<(), String> {
    let opened = async {
        let mut stream = db.watch().max_await_time(Duration::from_millis(100)).await?;
        stream.next_if_any().await?;
        Ok::<(), canopy_mongo::mongodb::error::Error>(())
    };
    match opened.await {
        Ok(()) => report.check(Status::Ok, &format!("change streams can be opened on {}", db.name())),
        Err(error) => match diagnostics::diagnose(&error, target) {
            Some(diagnostic) => report.diagnose(&diagnostic),
            None => {
                report.check(Status::Fail, &format!("cannot open a change stream on {}: {error}", db.name()))
            }
        },
    }
}

async fn policies(db: &Database, set: &PolicySet, report: &mut Report) -> Result<(), String> {
    let mut listed = db.list_collections().await.map_err(|error| error.to_string())?;
    let mut collections = Vec::new();
    while let Some(info) = listed.next().await {
        collections.push(info.map_err(|error| error.to_string())?);
    }
    let mut indexes = Vec::new();
    let mut fields = Vec::new();
    for definition in set.collections() {
        let name = &definition.collection;
        let Some(existing) = collections.iter().find(|info| info.name == *name) else {
            report.check(Status::Warn, &format!("{name} has policies but does not exist yet"))?;
            continue;
        };
        let collection = db.collection::<Document>(name);
        let keys: Vec<Vec<String>> = collection
            .list_indexes()
            .await
            .map_err(|error| error.to_string())?
            .map_ok(|index| index.keys.keys().cloned().collect())
            .try_collect()
            .await
            .map_err(|error| error.to_string())?;
        indexes.push((name.clone(), keys));
        let sample: Vec<Document> = collection
            .aggregate(vec![doc! { "$sample": { "size": SAMPLE_SIZE } }])
            .await
            .map_err(|error| error.to_string())?
            .try_collect()
            .await
            .map_err(|error| error.to_string())?;
        fields.push((name.clone(), sampled_paths(&sample)));
        if definition.realtime {
            let images = existing
                .options
                .change_stream_pre_and_post_images
                .as_ref()
                .is_some_and(|images| images.enabled);
            report.check(
                Status::Ok,
                &format!(
                    "{name}: realtime {}",
                    if images {
                        "with pre and post images"
                    } else {
                        "without images (membership is tracked, updates fetch post images)"
                    }
                ),
            )?;
        }
    }
    let environment = LintEnvironment { known_roles: None, indexes: &indexes, fields: &fields };
    for finding in lint_policies(set.collections(), set.contexts(), &environment) {
        if finding.severity == "info" {
            continue;
        }
        let status = if finding.severity == "error" { Status::Fail } else { Status::Warn };
        report.check(status, &format_finding(&finding))?;
    }
    Ok(())
}

async fn search_checks(db: &Database, configured: &[String]) -> Vec<(Status, String)> {
    let probe = ["canopy_search_probe".to_owned()];
    let names = if configured.is_empty() { &probe[..] } else { configured };
    let mut ready = 0;
    let mut warnings = Vec::new();
    for name in names {
        let found = async {
            db.collection::<Document>(name)
                .aggregate(vec![doc! { "$listSearchIndexes": {} }])
                .await?
                .try_collect::<Vec<Document>>()
                .await
        };
        match found.await {
            Ok(indexes) => {
                for index in indexes.iter().filter(|_| !configured.is_empty()) {
                    if index.get_bool("queryable").unwrap_or(false) {
                        ready += 1;
                    } else {
                        warnings.push((
                            Status::Warn,
                            format!(
                                "search index {name}.{} is {}",
                                index.get_str("name").unwrap_or_default(),
                                index.get_str("status").unwrap_or("unknown")
                            ),
                        ));
                    }
                }
            }
            Err(error) => {
                let code = match error.kind.as_ref() {
                    ErrorKind::Command(command) => Some(command.code),
                    _ => None,
                };
                return if code.is_some_and(|code| SEARCH_NOT_ENABLED.contains(&code)) {
                    let status = if configured.is_empty() { Status::Ok } else { Status::Warn };
                    vec![(
                        status,
                        "search: Search is not available on this MongoDB deployment; it needs Atlas, an Atlas local deployment or MongoDB Search"
                            .to_owned(),
                    )]
                } else {
                    vec![(Status::Warn, format!("search: could not be checked: {error}"))]
                };
            }
        }
    }
    let mut out =
        vec![(Status::Ok, format!("search: {} collections, {ready} indexes ready", configured.len()))];
    out.extend(warnings);
    out
}

#[cfg(test)]
mod tests {
    use super::sampled_paths;
    use canopy_mongo::mongodb::bson::doc;

    #[test]
    fn sampled_paths_look_through_arrays_and_skip_scalars() {
        let documents =
            [doc! { "a": { "b": 1 }, "list": [{ "x": 1 }, 2, [{ "y": true }]] }, doc! { "a": 2, "z": null }];
        assert_eq!(sampled_paths(&documents), ["a", "a.b", "list", "list.x", "list.y", "z"]);
    }
}
