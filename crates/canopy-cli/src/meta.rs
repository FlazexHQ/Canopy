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

use crate::invocation::Invocation;
use crate::{confirmed, output};
use canopy_control::{ApiKeyStore, KeyKind};

pub(crate) fn run(name: &str, args: &[String], call: &Invocation) -> Result<ExitCode, String> {
    let uri = call
        .text("mongodb-uri")
        .map(str::to_owned)
        .or_else(|| std::env::var("MONGODB_URI").ok().filter(|uri| !uri.is_empty()))
        .ok_or_else(|| {
            format!("{name} needs --mongodb-uri or MONGODB_URI. This build cannot load canopy.config.ts.")
        })?;
    let database = std::env::var("CANOPY_META_DB").unwrap_or_else(|_| "canopy".into());
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| error.to_string())?;
    runtime.block_on(async {
        let mut options = ClientOptions::parse(uri).await.map_err(mongo_error)?;
        options.server_selection_timeout = Some(Duration::from_secs(10));
        let app = if name.starts_with("realtime ") {
            Some(
                call.text("database")
                    .map(str::to_owned)
                    .or_else(|| std::env::var("CANOPY_DB").ok().filter(|name| !name.is_empty()))
                    .or_else(|| options.default_database.clone())
                    .filter(|name| !name.is_empty())
                    .ok_or_else(|| {
                        format!("{name} needs --database, CANOPY_DB or a database in the URI path")
                    })?,
            )
        } else {
            None
        };
        let client = Client::with_options(options).map_err(mongo_error)?;
        let result = if let Some(app) = app {
            crate::realtime::run(
                &client.database(&app),
                args,
                name == "realtime enable-images",
                call.has_flag("yes"),
            )
            .await
        } else {
            execute(name, args, call, client.database(&database)).await
        };
        client.shutdown().await;
        result
    })
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

    let migrations = meta.collection::<Document>("migrations");
    let mut pending = Vec::new();
    for (version, migration) in (1..=LATEST_VERSION).zip(MIGRATION_NAMES) {
        let applied = migrations.find_one(doc! { "_id": version }).await.map_err(mongo_error)?;
        let at = applied.as_ref().and_then(|document| document.get_datetime("appliedAt").ok());
        if name == "migrate" {
            let state = match at {
                Some(at) => format!("applied {}", date(at)?),
                None => "pending".into(),
            };
            output(format_args!("{version:>4}  {migration}  {state}"))?;
        } else if at.is_none() {
            pending.push(migration);
        }
    }
    if name == "migrate" {
        return Ok(ExitCode::SUCCESS);
    }
    if !pending.is_empty() {
        return Err(format!(
            "The meta database {} is not migrated ({}). Run canopy migrate first.",
            meta.name(),
            pending.join(", ")
        ));
    }
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

fn mongo_error(error: canopy_mongo::mongodb::error::Error) -> String {
    format!("error  {error}")
}

pub(crate) fn message(error: CanopyError) -> String {
    error.message().to_owned()
}
