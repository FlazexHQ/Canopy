use std::process::ExitCode;

use canopy_config::authoring::Command;
use canopy_mongo::mongodb::bson::Document as BsonDocument;
use canopy_mongo::to_bson;
use canopy_policy::{
    Compiled, ExplainRequest, Operation, PolicyEngine, context_query, explain_access, explain_context,
    format_access_report, lookup_values,
};
use canopy_protocol::ejson::{DecodeOptions, parse};
use canopy_protocol::{Document, Value};
use futures_util::TryStreamExt as _;

use crate::invocation::Invocation;
use crate::output;
use crate::targets::to_canopy;

const FLAGS: [&str; 5] = ["as", "roles", "op", "filter", "ctx"];

fn document(text: &str, flag: &str) -> Result<Document, String> {
    match parse(text, DecodeOptions::default()) {
        Ok(Value::Document(document)) => Ok(document),
        Ok(_) => Err(format!("--{flag} needs a JSON document")),
        Err(error) => Err(error.message().to_owned()),
    }
}

/// `canopy policies explain <collection>`: how DLS decides one operation for a stated caller. Offline it
/// uses the policy folder only; with `--mongodb-uri` it also resolves context lookups and counts the
/// documents the effective filter matches.
pub(crate) fn run(call: &Invocation, collection: &str) -> Result<ExitCode, String> {
    if let Some(bare) = FLAGS.iter().find(|flag| call.has_flag(flag) && call.text(flag).is_none()) {
        return Err(format!("--{bare} needs a value"));
    }
    let op = call.text("op").unwrap_or("read");
    let Some(op) = Operation::parse(op) else {
        let all: Vec<&str> = Operation::ALL.iter().map(|op| op.as_str()).collect();
        return Err(format!("--op must be one of {}", all.join(", ")));
    };
    let claims = match call.text("as") {
        None | Some("anon") => None,
        Some(text) => Some(document(text, "as")?),
    };
    let filter = call.text("filter").map(|text| document(text, "filter")).transpose()?;
    let ctx = call.text("ctx").map(|text| document(text, "ctx")).transpose()?;
    let debug = call.has_flag("debug");
    let project = crate::project::load(call, Command::Policies, true).map_err(|error| error.text(debug))?;
    let Some(set) = project.bundle.policies.clone() else {
        return Err(format!("error  No policy folder at {}", project.policy_dir.display()));
    };
    if set.collection(collection).is_none() {
        let mut known: Vec<&str> =
            set.collections().iter().map(|definition| definition.collection.as_str()).collect();
        known.sort_unstable();
        let listed = if known.is_empty() {
            String::new()
        } else {
            format!("\nCollections with policies: {}", known.join(", "))
        };
        return Err(format!(
            "No policies for {collection} in {}. Every request but service is denied.{listed}",
            project.policy_dir.display()
        ));
    }
    let engine = PolicyEngine::new(set.clone());
    let roles: Vec<String> = call
        .text("roles")
        .unwrap_or("")
        .split(',')
        .map(str::trim)
        .filter(|role| !role.is_empty())
        .map(str::to_owned)
        .collect();
    let now = canopy_mongo::mongodb::bson::DateTime::now().timestamp_millis();
    let given_ctx = ctx.is_some();
    let mut context = explain_context(claims, &roles, ctx, now);
    let lookups = engine.context_names(Some(&[collection]), &context.roles);
    let report = |context: canopy_policy::RequestContext| {
        explain_access(
            &engine,
            &ExplainRequest { collection: collection.to_owned(), op, context, filter: filter.clone() },
        )
        .map_err(|error| error.message().to_owned())
    };
    let Some(uri) = call.text("mongodb-uri") else {
        let report = report(context)?;
        output(format_args!(
            "{}",
            format_access_report(&report).map_err(|error| error.message().to_owned())?
        ))?;
        if !given_ctx && !lookups.is_empty() {
            output(format_args!(
                "Context lookups {} were not resolved and count as missing: pass --ctx, or --mongodb-uri to resolve them.",
                lookups.join(", ")
            ))?;
        }
        return Ok(ExitCode::SUCCESS);
    };
    let database = call
        .text("database")
        .map(str::to_owned)
        .or_else(|| std::env::var("CANOPY_DB").ok())
        .or_else(|| canopy_config::authoring::database_from_uri(uri))
        .unwrap_or_default();
    crate::meta::with_client(uri, |client| async move {
        let db = client.database(&database);
        if !given_ctx && !lookups.is_empty() {
            let mut resolved = Document::new();
            for name in &lookups {
                let Some((_, lookup)) = set.contexts().iter().find(|(known, _)| known == name) else {
                    continue;
                };
                let query = context_query(name, lookup, &context)
                    .map_err(|error| format!("error  {}", error.message()))?;
                let Some(query) = query else { continue };
                #[allow(clippy::cast_possible_truncation)]
                let limit = query.limit as i64;
                let found: Vec<BsonDocument> = db
                    .collection::<BsonDocument>(&lookup.from)
                    .find(to_bson(&query.filter).map_err(|error| error.message().to_owned())?)
                    .limit(limit)
                    .await
                    .map_err(|error| format!("error  {error}"))?
                    .try_collect()
                    .await
                    .map_err(|error| format!("error  {error}"))?;
                let documents = found
                    .iter()
                    .map(to_canopy)
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|error| error.message().to_owned())?;
                if let Some(values) = lookup_values(&documents, &lookup.select, lookup.max)
                    .map_err(|error| error.message().to_owned())?
                {
                    resolved.insert(name.clone(), Value::Array(values));
                }
            }
            context.ctx = Some(resolved);
        }
        let report = report(context)?;
        output(format_args!(
            "{}",
            format_access_report(&report).map_err(|error| error.message().to_owned())?
        ))?;
        let count = match &report.effective {
            Compiled::Deny => 0,
            effective => db
                .collection::<BsonDocument>(collection)
                .count_documents(to_bson(&effective.to_filter()).map_err(|error| error.message().to_owned())?)
                .await
                .map_err(|error| format!("error  {error}"))?,
        };
        output(format_args!("Matching documents: {count}"))?;
        Ok(ExitCode::SUCCESS)
    })
}
