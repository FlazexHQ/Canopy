use std::collections::BTreeMap;
use std::io::IsTerminal as _;
use std::process::ExitCode;

use canopy_config::authoring::Command;
use canopy_policy::{IndexMode, IndexPlan, PolicySet, plan_indexes};
use futures_util::TryStreamExt as _;

use crate::invocation::Invocation;
use crate::meta::{app_target, meta_target, with_client};
use crate::{error_line, output, prompt};

/// `canopy indexes advise` and `canopy indexes create`: indexes that would serve the equality fields of
/// policies and context lookups, built after confirmation on collections that exist.
pub(crate) fn run(name: &str, call: &Invocation) -> Result<ExitCode, String> {
    let debug = call.has_flag("debug");
    let project = crate::project::configure(call, Command::Gen, false).map_err(|error| error.text(debug))?;
    let (uri, database) = app_target(call, &project, name)?;
    let (_, meta) = meta_target(call, &project, name)?;
    let local = project.dir_given.then(|| project.bundle.policy_set()).transpose()?;
    let create = name == "indexes create";
    with_client(&uri, |client| async move {
        let set: PolicySet = match local {
            Some(set) => set,
            None => match canopy_mongo::load_policies(&client.database(&meta)).await {
                Ok(set) => set,
                Err(error) => {
                    error_line(format_args!("Policies do not load: {}", error.message()))?;
                    return Ok(ExitCode::FAILURE);
                }
            },
        };
        let db = client.database(&database);
        let failed = |error: canopy_mongo::mongodb::error::Error| format!("MongoDB error: {error}");
        let mut existing = BTreeMap::new();
        for collection in db.list_collection_names().await.map_err(failed)? {
            if collection.starts_with("system.") {
                continue;
            }
            let indexes: Vec<_> = db
                .collection::<canopy_mongo::mongodb::bson::Document>(&collection)
                .list_indexes()
                .await
                .map_err(failed)?
                .try_collect()
                .await
                .map_err(failed)?;
            let keys = indexes.into_iter().map(|index| index.keys.keys().cloned().collect()).collect();
            existing.insert(collection, keys);
        }
        let mode = match (create, call.has_flag("yes")) {
            (false, _) => IndexMode::Advise,
            (true, true) => IndexMode::CreateConfirmed,
            (true, false) if std::io::stdin().is_terminal() => IndexMode::CreatePrompt,
            (true, false) => IndexMode::CreateWithoutTerminal,
        };
        let mut plan = plan_indexes(&database, &set, &existing, mode);
        if let Some(question) = plan.confirmation_question.take() {
            print(&plan)?;
            prompt(&format!("{question} [y/N] "))?;
            let mut answer = String::new();
            std::io::stdin().read_line(&mut answer).map_err(|error| error.to_string())?;
            let accepted = matches!(answer.trim().to_ascii_lowercase().as_str(), "y" | "yes");
            let mode = if accepted { IndexMode::CreateConfirmed } else { IndexMode::CreateDeclined };
            let decided = plan_indexes(&database, &set, &existing, mode);
            plan = IndexPlan { logs: decided.logs.into_iter().skip(plan.logs.len()).collect(), ..decided };
        }
        print(&plan)?;
        for creation in &plan.creations {
            let command = crate::schema_commands::to_bson(&creation.command)?;
            db.run_command(command).await.map_err(failed)?;
            output(format_args!("{}", creation.applied_line))?;
        }
        Ok(if plan.exit_code == 0 { ExitCode::SUCCESS } else { ExitCode::FAILURE })
    })
}

fn print(plan: &IndexPlan) -> Result<(), String> {
    for line in &plan.logs {
        output(format_args!("{line}"))?;
    }
    for line in &plan.errors {
        error_line(format_args!("{line}"))?;
    }
    Ok(())
}
