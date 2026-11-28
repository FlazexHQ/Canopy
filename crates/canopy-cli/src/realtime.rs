use std::collections::HashMap;
use std::process::ExitCode;

use canopy_mongo::mongodb::{Database, bson::doc};
use futures_util::TryStreamExt as _;

use crate::{confirmed, output};

pub(crate) async fn run(
    db: &Database,
    collections: &[String],
    enable: bool,
    yes: bool,
) -> Result<ExitCode, String> {
    let action = if enable { "enable" } else { "disable" };
    if collections.is_empty() {
        return Err(format!("Name the collections: canopy realtime {action}-images <collection...>"));
    }
    let mut cursor = db
        .list_collections()
        .filter(doc! { "name": { "$in": collections } })
        .await
        .map_err(|error| format!("Cannot reach MongoDB: {error}"))?;
    let mut current = HashMap::new();
    while let Some(info) =
        cursor.try_next().await.map_err(|error| format!("Cannot reach MongoDB: {error}"))?
    {
        current.insert(
            info.name,
            info.options.change_stream_pre_and_post_images.is_some_and(|images| images.enabled),
        );
    }
    let missing: Vec<_> =
        collections.iter().filter(|name| !current.contains_key(*name)).map(String::as_str).collect();
    if !missing.is_empty() {
        let verb = if missing.len() == 1 { "does" } else { "do" };
        return Err(format!(
            "{} {verb} not exist in {}. Canopy never creates collections in the app database.",
            missing.join(", "),
            db.name()
        ));
    }
    let state = if enable { "on" } else { "off" };
    let mut pending = Vec::new();
    for name in collections {
        if current.get(name) == Some(&enable) {
            output(format_args!("{name}: pre and post images are already {state}"))?;
        } else {
            pending.push(name);
        }
    }
    if pending.is_empty() {
        return Ok(ExitCode::SUCCESS);
    }
    output(format_args!("Will run on {}:", db.name()))?;
    for name in &pending {
        let name = serde_json::Value::String((*name).clone());
        output(format_args!(
            "  db.runCommand({{\"collMod\":{name},\"changeStreamPreAndPostImages\":{{\"enabled\":{enable}}}}})"
        ))?;
    }
    if enable {
        output(format_args!(
            "Pre images are kept in config.system.preimages until the oplog rolls past them. Bound their size with"
        ))?;
        output(format_args!(
            "  db.adminCommand({{ setClusterParameter: {{ changeStreamOptions: {{ preAndPostImages: {{ expireAfterSeconds: 3600 }} }} }} }})"
        ))?;
    }
    let verb = if enable { "Enable" } else { "Disable" };
    let noun = if pending.len() == 1 { "collection" } else { "collections" };
    if !yes && !confirmed(&format!("{verb} pre and post images on {} {noun}?", pending.len()))? {
        return Ok(ExitCode::FAILURE);
    }
    for name in pending {
        db.run_command(doc! { "collMod": name, "changeStreamPreAndPostImages": { "enabled": enable } })
            .await
            .map_err(|error| format!("{name}: collMod failed: {error}"))?;
        output(format_args!("{name}: pre and post images {state}"))?;
    }
    Ok(ExitCode::SUCCESS)
}
