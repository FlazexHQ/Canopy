use std::path::Path;
use std::process::ExitCode;

use canopy_config::authoring::Command;
use canopy_data::schema::{SchemaSourceOptions, load_schema};
use canopy_mongo::mongodb::{
    Database,
    bson::{Document as BsonDocument, RawDocumentBuf, doc},
};
use canopy_policy::PolicySet;
use canopy_protocol::Document;
use canopy_schema::{
    CollectionSchema, DEFAULT_SAMPLE_SIZE, EmitOptions, EnumOptions, InferOptions, PullUpdate, js_cmp,
    parse_diff_sample_size, parse_sample_size, schema_diff, schema_diff_collections, schema_push,
    update_schema_file,
};
use futures_util::TryStreamExt as _;

use crate::invocation::Invocation;
use crate::meta::{app_target, mongo_error, with_client};
use crate::project::{LoadError, Loading, Project, absolute, configure, load_from};
use crate::{confirmed, error_line, output};

fn missing_value(call: &Invocation, flags: &[&str]) -> Result<(), String> {
    for flag in flags {
        if call.has_flag(flag) && call.text(flag).is_none_or(str::is_empty) {
            return Err(format!("--{flag} needs a value"));
        }
    }
    Ok(())
}

/// Where `canopy pull` and `canopy schema diff` read collection schemas from.
pub(crate) struct SchemaSource<'a> {
    /// The policies of the policy folder; their exposed collections are read, otherwise every collection.
    pub(crate) policies: Option<&'a PolicySet>,
    /// One collection instead of the selection.
    pub(crate) collection: Option<&'a str>,
    pub(crate) sample_size: i32,
    pub(crate) infer_enums: bool,
}

/// Lists the selected collections and reads each one's validator or samples its newest documents.
pub(crate) async fn collection_schemas(
    db: &Database,
    source: &SchemaSource<'_>,
) -> Result<Vec<CollectionSchema>, String> {
    let mut names: Vec<String> = match source.collection {
        Some(name) => {
            let listed =
                db.list_collection_names().filter(doc! { "name": name }).await.map_err(mongo_error)?;
            if listed.is_empty() {
                return Err(format!("Collection {name} does not exist in the database"));
            }
            listed
        }
        None => {
            let listed = db.list_collection_names().await.map_err(mongo_error)?;
            schema_diff_collections(listed.iter().map(String::as_str), source.policies)
                .into_iter()
                .map(str::to_owned)
                .collect()
        }
    };
    names.sort_by(|a, b| js_cmp(a, b));
    let options = SchemaSourceOptions {
        sample_size: source.sample_size,
        infer: InferOptions { enums: source.infer_enums.then(EnumOptions::default) },
        ..SchemaSourceOptions::default()
    };
    let mut schemas = Vec::with_capacity(names.len());
    for name in &names {
        schemas.push(load_schema(db, name, &options).await.map_err(|error| error.message().to_owned())?);
    }
    Ok(schemas)
}

fn policies_of(project: &Project) -> Option<&PolicySet> {
    if project.dir_given { project.bundle.policies.as_ref() } else { None }
}

fn read_existing(path: &Path) -> Result<Option<String>, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("{}: {error}", path.display())),
    }
}

fn write_file(path: &Path, text: &str, create: bool) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("{}: {error}", parent.display()))?;
    }
    let mut options = std::fs::OpenOptions::new();
    options.write(true);
    if create {
        options.create_new(true);
    } else {
        options.create(true).truncate(true);
    }
    let mut file = options.open(path).map_err(|error| format!("{}: {error}", path.display()))?;
    std::io::Write::write_all(&mut file, text.as_bytes())
        .map_err(|error| format!("{}: {error}", path.display()))
}

/// Lists changed lines in source order, preferring deletions when two alignments tie.
pub(crate) fn line_diff(existing: &str, generated: &str) -> Vec<String> {
    fn lines(text: &str) -> Vec<String> {
        let text = text.replace("\r\n", "\n");
        text.split_inclusive('\n').map(str::to_owned).collect()
    }
    let old = lines(existing);
    let next = lines(generated);
    let mut start = 0;
    while start < old.len() && old.get(start) == next.get(start) {
        start += 1;
    }
    let (mut end_old, mut end_next) = (old.len(), next.len());
    while end_old > start && end_next > start && old.get(end_old - 1) == next.get(end_next - 1) {
        end_old -= 1;
        end_next -= 1;
    }
    let width = end_next - start + 1;
    let mut lengths = vec![0u32; (end_old - start + 1) * width];
    let at = |lengths: &[u32], index: usize| lengths.get(index).copied().unwrap_or(0);
    for i in (start..end_old).rev() {
        for j in (start..end_next).rev() {
            let k = (i - start) * width + j - start;
            let value = if old.get(i) == next.get(j) {
                1 + at(&lengths, k + width + 1)
            } else {
                at(&lengths, k + width).max(at(&lengths, k + 1))
            };
            if let Some(slot) = lengths.get_mut(k) {
                *slot = value;
            }
        }
    }
    let trim =
        |line: Option<&String>| line.map_or("", |line| line.strip_suffix('\n').unwrap_or(line)).to_owned();
    let mut changes = Vec::new();
    let (mut i, mut j) = (start, start);
    while i < end_old || j < end_next {
        let k = (i - start) * width + j - start;
        if i < end_old && j < end_next && old.get(i) == next.get(j) {
            i += 1;
            j += 1;
        } else if i < end_old && (j == end_next || at(&lengths, k + width) >= at(&lengths, k + 1)) {
            changes.push(format!("- {}", trim(old.get(i))));
            i += 1;
        } else {
            changes.push(format!("+ {}", trim(next.get(j))));
            j += 1;
        }
    }
    changes
}

/// `canopy pull`: writes the editable schema of the app database, or adds one collection to it.
pub(crate) fn pull(call: &Invocation) -> Result<ExitCode, String> {
    let debug = call.has_flag("debug");
    let project = configure(call, Command::Gen, false).map_err(|error| error.text(debug))?;
    let (uri, database) = app_target(call, &project, "pull")?;
    missing_value(call, &["collection", "sample", "out"])?;
    let sample =
        call.text("sample").map(parse_sample_size).transpose().map_err(|error| error.message().to_owned())?;
    let collection = call.text("collection");
    let js = call.has_flag("js");
    let file = call.text("out").unwrap_or(if js { "canopy.schema.js" } else { "canopy.schema.ts" });
    let path = absolute(&project.cwd, file);
    let policies = if collection.is_none() { policies_of(&project) } else { None };
    let source = SchemaSource {
        policies,
        collection,
        sample_size: sample.unwrap_or(DEFAULT_SAMPLE_SIZE),
        infer_enums: call.has_flag("infer-enums"),
    };
    let schemas =
        with_client(
            &uri,
            |client| async move { collection_schemas(&client.database(&database), &source).await },
        )?;
    let existing = read_existing(&path)?;
    let options = EmitOptions { js, ..EmitOptions::default() };
    let update =
        update_schema_file(&schemas, collection, existing.as_deref(), file, call.has_flag("force"), &options)
            .map_err(|error| error.message().to_owned())?;
    match update {
        PullUpdate::Append(text) => {
            write_file(&path, &text, false)?;
            output(format_args!("added {} to {file}", collection.unwrap_or_default()))?;
        }
        PullUpdate::Current => output(format_args!("{file} is up to date"))?,
        PullUpdate::Edited(generated) => {
            error_line(format_args!("{file} was edited; pass --force to replace it"))?;
            for change in line_diff(existing.as_deref().unwrap_or_default(), &generated) {
                error_line(format_args!("{change}"))?;
            }
            return Ok(ExitCode::FAILURE);
        }
        PullUpdate::Write(text) => {
            write_file(&path, &text, existing.is_none())?;
            let count = if collection.is_some() { 1 } else { schemas.len() };
            output(format_args!("wrote {file} ({count} collections)"))?;
        }
    }
    Ok(ExitCode::SUCCESS)
}

fn schema_file(call: &Invocation, cwd: &Path) -> Result<String, String> {
    if call.has_flag("file") {
        return call
            .text("file")
            .filter(|file| !file.is_empty())
            .map(str::to_owned)
            .ok_or_else(|| "--file needs a path".to_owned());
    }
    ["canopy.schema.ts", "canopy.schema.js"]
        .into_iter()
        .find(|name| cwd.join(name).is_file())
        .map(str::to_owned)
        .ok_or_else(|| "Cannot find canopy.schema.ts or canopy.schema.js".to_owned())
}

pub(crate) fn to_bson(document: &Document) -> Result<BsonDocument, String> {
    let bytes =
        canopy_protocol::bson::encode_document(document).map_err(|error| error.message().to_owned())?;
    let raw = RawDocumentBuf::from_bytes(bytes).map_err(|error| error.to_string())?;
    BsonDocument::try_from(raw).map_err(|error| error.to_string())
}

/// `canopy schema diff` and `canopy schema push`: compare the schema file with MongoDB, or apply its
/// validators after confirmation.
pub(crate) fn schema(name: &str, call: &Invocation) -> Result<ExitCode, String> {
    let debug = call.has_flag("debug");
    let cwd = std::env::current_dir().map_err(|error| error.to_string())?;
    let file = schema_file(call, &cwd)?;
    let path = absolute(&cwd, &file);
    let loading = Loading {
        command: Command::Policies,
        emit_as: Command::Policies,
        needs_policies: false,
        schema: Some(&path),
        env_files: false,
        overrides: &[],
    };
    let project = load_from(call, &loading).map_err(|error| match error {
        LoadError::Invalid { part, message } if part == "schema" => format!("Cannot load {file}: {message}"),
        other => other.text(debug),
    })?;
    let declared = project.bundle.schema.clone().ok_or_else(|| {
        format!(
            "Cannot load {file}: Expected a schema export containing collection definitions with a name and an object shape"
        )
    })?;
    if let Some(sample) = call.text("sample") {
        parse_diff_sample_size(sample).map_err(|error| error.message().to_owned())?;
    } else if call.has_flag("sample") {
        return Err("--sample needs a positive integer".to_owned());
    }
    let role = if call.has_flag("role") {
        let role =
            call.text("role").filter(|role| !role.trim().is_empty()).ok_or("--role needs a role name")?;
        if !project.dir_given {
            return Err("--role needs a policy directory from --dir or policies.dir".to_owned());
        }
        let set = project.bundle.policy_set()?;
        if set.collections().is_empty() {
            return Err(format!("No collection policies found in {}", project.policy_dir.display()));
        }
        Some((role.to_owned(), set))
    } else {
        None
    };
    let (uri, database) = app_target(call, &project, name)?;
    if name == "schema push" {
        return push(call, &uri, &database, &declared);
    }
    let sample_size = match call.text("sample") {
        Some(sample) => {
            i32::try_from(parse_diff_sample_size(sample).map_err(|error| error.message().to_owned())?)
                .unwrap_or(i32::MAX)
        }
        None => DEFAULT_SAMPLE_SIZE,
    };
    let source = SchemaSource {
        policies: policies_of(&project),
        collection: None,
        sample_size,
        infer_enums: call.has_flag("infer-enums"),
    };
    let db_name = database.clone();
    let actual =
        with_client(
            &uri,
            |client| async move { collection_schemas(&client.database(&db_name), &source).await },
        )?;
    let report = schema_diff(
        &file,
        &database,
        &declared,
        &actual,
        role.as_ref().map(|(role, set)| (role.as_str(), set)),
    );
    for line in &report.errors {
        error_line(format_args!("{line}"))?;
    }
    for line in &report.logs {
        output(format_args!("{line}"))?;
    }
    Ok(if report.exit_code == 0 { ExitCode::SUCCESS } else { ExitCode::FAILURE })
}

fn push(
    call: &Invocation,
    uri: &str,
    database: &str,
    declared: &[CollectionSchema],
) -> Result<ExitCode, String> {
    with_client(uri, |client| async move {
        let db = client.database(database);
        let mut existing: Vec<(String, Option<Document>)> = Vec::new();
        for schema in declared {
            let mut cursor =
                db.list_collections().filter(doc! { "name": &schema.name }).await.map_err(mongo_error)?;
            if let Some(info) = cursor.try_next().await.map_err(mongo_error)? {
                let validator =
                    info.options.validator.map(|validator| crate::targets::to_canopy(&validator)).transpose();
                existing.push((schema.name.clone(), validator.map_err(|error| error.message().to_owned())?));
            }
        }
        let listed: Vec<(&str, Option<&Document>)> =
            existing.iter().map(|(name, validator)| (name.as_str(), validator.as_ref())).collect();
        let plan = schema_push(database, declared, &listed);
        for line in &plan.logs {
            output(format_args!("{line}"))?;
        }
        if let Some(question) = &plan.question
            && !call.has_flag("yes")
            && !confirmed(question)?
        {
            return Ok(ExitCode::FAILURE);
        }
        for change in &plan.changes {
            db.run_command(to_bson(&change.command)?).await.map_err(mongo_error)?;
            output(format_args!("{}", change.applied_line))?;
        }
        Ok(ExitCode::SUCCESS)
    })
}

#[cfg(test)]
mod tests {
    use super::line_diff;

    #[test]
    fn line_diff_prefers_deletions_and_ignores_line_endings() {
        assert_eq!(line_diff("a\r\nb\r\nc\r\n", "a\nb\nc\n"), Vec::<String>::new());
        assert_eq!(line_diff("a\nold\nc\n", "a\nnew\nc\n"), ["- old", "+ new"]);
        assert_eq!(line_diff("a\n", "a\nb\n"), ["+ b"]);
        assert_eq!(line_diff("x\ny\n", "y\nx\n"), ["- x", "+ x"]);
    }
}
