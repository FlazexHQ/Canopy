use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use canopy_migrations::{LATEST_VERSION, MIGRATION_NAMES, MigrationOptions, migrate};
use canopy_mongo::mongodb::{
    Client, Database,
    bson::{DateTime, Document, doc},
    options::ClientOptions,
};
use canopy_protocol::CanopyError;
use time::OffsetDateTime;

use canopy_config::authoring::Command;

use crate::invocation::Invocation;
use crate::project::Project;
use crate::{confirmed, output};
use canopy_control::{ApiKeyStore, KeyKind};

pub(crate) fn run(name: &str, args: &[String], call: &Invocation) -> Result<ExitCode, String> {
    let debug = call.has_flag("debug");
    let project = crate::project::configure(call, Command::Gen, false).map_err(|error| error.text(debug))?;
    if name.starts_with("realtime ") {
        let (uri, database) = app_target(call, &project, name)?;
        return with_client(&uri, |client| async move {
            crate::realtime::run(
                &client.database(&database),
                args,
                name == "realtime enable-images",
                call.has_flag("yes"),
            )
            .await
        });
    }
    let (uri, database) = meta_target(call, &project, name)?;
    with_client(&uri, |client| async move { execute(name, args, call, client.database(&database)).await })
}

/// The connection string and meta database of a command: `--mongodb-uri`, else the config.
pub(crate) fn meta_target(
    call: &Invocation,
    project: &Project,
    name: &str,
) -> Result<(String, String), String> {
    let uri = configured_uri(call, project).ok_or_else(|| {
        format!("{name} needs --mongodb-uri, MONGODB_URI or mongodb.uri in the config file")
    })?;
    let meta = std::env::var("CANOPY_META_DB")
        .ok()
        .or_else(|| project.resolution.text("mongodb.metaDatabase").map(str::to_owned))
        .unwrap_or_else(|| "canopy".to_owned());
    Ok((uri, meta))
}

/// The connection string and app database of a command: the flags, the variables and the config.
pub(crate) fn app_target(
    call: &Invocation,
    project: &Project,
    name: &str,
) -> Result<(String, String), String> {
    let uri = configured_uri(call, project).ok_or_else(|| {
        format!("{name} needs --mongodb-uri, MONGODB_URI or mongodb.uri in the config file")
    })?;
    let database = match (call.text("database"), call.text("mongodb-uri")) {
        (Some(database), _) => database.to_owned(),
        (None, None) => project.resolution.text("mongodb.database").unwrap_or_default().to_owned(),
        (None, Some(_)) => std::env::var("CANOPY_DB")
            .ok()
            .or_else(|| canopy_config::authoring::database_from_uri(&uri))
            .unwrap_or_default(),
    };
    if database.is_empty() {
        return Err(format!("{name} needs --database, CANOPY_DB or a database in the URI path"));
    }
    Ok((uri, database))
}

fn configured_uri(call: &Invocation, project: &Project) -> Option<String> {
    call.text("mongodb-uri").map(str::to_owned).or_else(|| project.text("mongodb.uri").map(str::to_owned))
}

/// Connects to MongoDB on a single threaded runtime, runs `body` and closes the client.
pub(crate) fn with_client<F, T>(uri: &str, body: impl FnOnce(Client) -> F) -> Result<T, String>
where
    F: std::future::Future<Output = Result<T, String>>,
{
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| error.to_string())?;
    runtime.block_on(async {
        let mut options = ClientOptions::parse(uri).await.map_err(mongo_error)?;
        if !uri.to_ascii_lowercase().contains("serverselectiontimeoutms=") {
            options.server_selection_timeout = Some(Duration::from_secs(10));
        }
        let client = Client::with_options(options).map_err(mongo_error)?;
        let result = body(client.clone()).await;
        client.shutdown().await;
        result
    })
}

/// The migrations the meta database has not run yet.
pub(crate) async fn pending_migrations(meta: &Database) -> Result<Vec<&'static str>, String> {
    let migrations = meta.collection::<Document>("migrations");
    let mut pending = Vec::new();
    for (version, migration) in (1..=LATEST_VERSION).zip(MIGRATION_NAMES) {
        let applied = migrations.find_one(doc! { "_id": version }).await.map_err(mongo_error)?;
        if applied.as_ref().and_then(|document| document.get_datetime("appliedAt").ok()).is_none() {
            pending.push(migration);
        }
    }
    Ok(pending)
}

/// Refuses a meta database whose migrations have not run.
pub(crate) async fn require_migrated(meta: &Database) -> Result<(), String> {
    let pending = pending_migrations(meta).await?;
    if pending.is_empty() {
        return Ok(());
    }
    Err(format!(
        "The meta database {} is not migrated ({}). Run canopy migrate first.",
        meta.name(),
        pending.join(", ")
    ))
}

async fn execute(name: &str, args: &[String], call: &Invocation, meta: Database) -> Result<ExitCode, String> {
    let creation = (name == "keys create").then(|| call.key_create_options()).transpose()?;
    if name == "migrate" && !call.has_flag("status") {
        let report = migrate(&meta, MigrationOptions::default()).await.map_err(message)?;
        let name = meta.name();
        let version = report.version;
        if report.applied.is_empty() {
            output(format_args!("{name} is up to date (version {version})"))?;
        } else {
            output(format_args!("Applied {}; {name} is at version {version}", report.applied.join(", ")))?;
        }
        return Ok(ExitCode::SUCCESS);
    }

    if name == "migrate" {
        let migrations = meta.collection::<Document>("migrations");
        for (version, migration) in (1..=LATEST_VERSION).zip(MIGRATION_NAMES) {
            let applied = migrations.find_one(doc! { "_id": version }).await.map_err(mongo_error)?;
            let state = match applied.as_ref().and_then(|document| document.get_datetime("appliedAt").ok()) {
                Some(at) => format!("applied {}", date(at)?),
                None => "pending".into(),
            };
            output(format_args!("{version:>4}  {migration}  {state}"))?;
        }
        return Ok(ExitCode::SUCCESS);
    }
    require_migrated(&meta).await?;
    if name.starts_with("admin ") {
        return crate::admin::run(name, args, call, &meta).await;
    }
    let store =
        ApiKeyStore::new(meta.collection("api_keys"), Arc::new(|| DateTime::now().timestamp_millis()));
    match (creation, args) {
        (Some((kind, name)), _) => create(&meta, &store, kind, name).await?,
        (None, [id]) => return revoke(&meta, &store, id, call.has_flag("yes")).await,
        _ => list(&store).await?,
    }
    Ok(ExitCode::SUCCESS)
}

async fn create(meta: &Database, store: &ApiKeyStore, kind: KeyKind, name: &str) -> Result<(), String> {
    let actor = actor();
    let result = store.create(kind, name, &actor).await.map_err(message)?;
    let info = result.get_document("info").map_err(|error| error.to_string())?;
    audit(meta, "key.create", &actor, info).await?;
    let key = field(&result, "key")?;
    let id = field(info, "id")?;
    output(format_args!("{id}  {}  {}", kind.as_str(), quoted(name)))?;
    output(format_args!("{key}"))?;
    if kind == KeyKind::Secret {
        output(format_args!(
            "This is the only time the secret key is shown. Store it in your server's secrets; it bypasses every policy."
        ))?;
    }
    Ok(())
}

async fn list(store: &ApiKeyStore) -> Result<(), String> {
    let keys = store.list().await.map_err(message)?;
    if keys.is_empty() {
        return output(format_args!(
            "No API keys. Create one with canopy keys create --kind publishable --name web"
        ));
    }
    for key in keys {
        let id = field(&key, "id")?;
        let kind = field(&key, "kind")?;
        let name = quoted(field(&key, "name")?);
        let displayed = match (kind, key.get_str("key")) {
            ("publishable", Ok(key)) => key.to_owned(),
            _ => format!("{}...", field(&key, "prefix")?),
        };
        let created = document_date(&key, "createdAt")?;
        let creator = field(&key, "createdBy")?;
        let used = document_date(&key, "lastUsedAt")?;
        let state = match key.get_datetime("revokedAt") {
            Ok(at) => format!("revoked {}", date(at)?),
            Err(_) => "active".into(),
        };
        output(format_args!(
            "{id}  {kind:11}  {displayed:24}  {name}  created {created} by {creator}  last used {used}  {state}"
        ))?;
    }
    Ok(())
}

async fn revoke(meta: &Database, store: &ApiKeyStore, id: &str, yes: bool) -> Result<ExitCode, String> {
    let current = store
        .get(id)
        .await
        .map_err(message)?
        .ok_or_else(|| format!("No API key {id}. List them with canopy keys list."))?;
    if let Ok(at) = current.get_datetime("revokedAt") {
        output(format_args!("{id} was already revoked on {}", date(at)?))?;
        return Ok(ExitCode::SUCCESS);
    }
    if !yes {
        let kind = field(&current, "kind")?;
        let name = quoted(field(&current, "name")?);
        if !confirmed(&format!("Revoke the {kind} key {name} ({id})? Apps using it stop working."))? {
            return Ok(ExitCode::FAILURE);
        }
    }
    let actor = actor();
    let revoked = store.revoke(id, &actor).await.map_err(message)?;
    audit(meta, "key.revoke", &actor, &revoked).await?;
    output(format_args!("revoked  {id}"))?;
    Ok(ExitCode::SUCCESS)
}

async fn audit(meta: &Database, action: &str, actor: &str, info: &Document) -> Result<(), String> {
    meta.collection::<Document>("audit_log")
        .insert_one(doc! {
            "action": action,
            "actor": { "type": "system", "id": actor },
            "target": { "keyId": field(info, "id")?, "kind": field(info, "kind")?, "name": field(info, "name")? },
            "at": DateTime::now(),
            "outcome": "ok",
        })
        .await
        .map_err(mongo_error)?;
    Ok(())
}

pub(crate) fn actor() -> String {
    let user = std::env::var(if cfg!(windows) { "USERNAME" } else { "USER" })
        .ok()
        .filter(|user| !user.is_empty())
        .unwrap_or_else(|| "unknown".into());
    format!("cli:{user}")
}

pub(crate) fn field<'a>(document: &'a Document, name: &str) -> Result<&'a str, String> {
    document.get_str(name).map_err(|error| error.to_string())
}

fn quoted(text: &str) -> serde_json::Value {
    serde_json::Value::String(text.into())
}

fn document_date(document: &Document, field: &str) -> Result<String, String> {
    document.get_datetime(field).map_or_else(|_| Ok("never".into()), date)
}

pub(crate) fn date(value: &DateTime) -> Result<String, String> {
    let at = OffsetDateTime::from_unix_timestamp_nanos(i128::from(value.timestamp_millis()) * 1_000_000)
        .map_err(|error| error.to_string())?;
    Ok(crate::tokens::timestamp(at))
}

pub(crate) fn mongo_error(error: canopy_mongo::mongodb::error::Error) -> String {
    format!("error  {error}")
}

pub(crate) fn message(error: CanopyError) -> String {
    error.message().to_owned()
}
