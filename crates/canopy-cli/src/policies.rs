use std::process::ExitCode;

use canopy_config::authoring::Command;
use canopy_policy::{
    CONTEXT_DOCUMENT_ID, CollectionPolicies, ContextDefinitions, LintEnvironment, LintFinding, PolicySet,
    hash_collection, hash_contexts, lint_policies,
};

use crate::invocation::Invocation;
use crate::project::{self, LoadError, Project};
use crate::targets::{MetaTarget, PolicyTarget, RemoteTarget};
use crate::{confirmed, output};

fn error_line(line: impl std::fmt::Display) -> Result<(), String> {
    use std::io::Write as _;
    writeln!(std::io::stderr().lock(), "{line}").map_err(|error| error.to_string())
}

/// Reads a whole number flag; `Err` carries the message.
pub(crate) fn count(value: Option<&str>, flag: &str) -> Result<Option<i64>, String> {
    match value {
        None => Ok(None),
        Some(text) if !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit()) => {
            text.parse().map(Some).map_err(|_| format!("--{flag} needs a whole number"))
        }
        Some(_) => Err(format!("--{flag} needs a whole number")),
    }
}

/// Runs a `policies` command.
pub(crate) fn run(name: &str, args: &[String], call: &Invocation) -> Result<ExitCode, String> {
    let debug = call.has_flag("debug");
    match name {
        "policies lint" => {
            let project = project::load(call, Command::Policies, true).map_err(|error| error.text(debug))?;
            lint(&project)
        }
        "policies test" => {
            let project = project::load(call, Command::Policies, true).map_err(|error| error.text(debug))?;
            crate::policy_tests::run(call, &project)
        }
        "policies explain" => crate::explain::run(call, args.first().map_or("", String::as_str)),
        _ => lifecycle(name, args, call),
    }
}

fn local_set(project: &Project) -> Result<PolicySet, LoadError> {
    project.bundle.policies.clone().ok_or_else(|| {
        LoadError::Message(format!("error  No policy folder at {}", project.policy_dir.display()))
    })
}

pub(crate) fn format_finding(finding: &LintFinding) -> String {
    let place = match &finding.policy {
        Some(policy) => format!("{} > {policy}", finding.collection),
        None => finding.collection.clone(),
    };
    format!("{:<5}  {}  {place}: {}", finding.severity, finding.rule, finding.message)
}

fn lint(project: &Project) -> Result<ExitCode, String> {
    let set = local_set(project).map_err(|error| error.text(false))?;
    let findings = lint_policies(set.collections(), set.contexts(), &LintEnvironment::default());
    for finding in &findings {
        if finding.severity == "error" {
            error_line(format_finding(finding))?;
        } else {
            output(format_args!("{}", format_finding(finding)))?;
        }
    }
    let errors = findings.iter().filter(|finding| finding.severity == "error").count();
    output(format_args!(
        "{} collections, {} findings, {errors} errors",
        set.collections().len(),
        findings.len()
    ))?;
    Ok(if errors > 0 { ExitCode::FAILURE } else { ExitCode::SUCCESS })
}

/// Runs `body` against the admin API behind `--env`, or the meta database of the config.
fn with_target(
    name: &str,
    call: &Invocation,
    project: &Project,
    body: impl FnOnce(&dyn PolicyTarget) -> Result<ExitCode, String>,
) -> Result<ExitCode, String> {
    if let Some(environment) = call.text("env") {
        let debug = call.has_flag("debug");
        let admin = crate::remote::resolve(environment, |error| crate::storage_error(error, debug))?;
        return body(&RemoteTarget { admin });
    }
    let (uri, database) = crate::meta::meta_target(call, project, name)?;
    let target = MetaTarget::open(&uri, &database)?;
    let result = body(&target);
    target.close();
    result
}

fn lifecycle(name: &str, args: &[String], call: &Invocation) -> Result<ExitCode, String> {
    let debug = call.has_flag("debug");
    let needs_local = matches!(name, "policies diff" | "policies push");
    let project = project::configure(call, Command::Gen, needs_local).map_err(|error| error.text(debug))?;
    let local = || {
        local_set(&project).map_err(|error| {
            let message = match error {
                LoadError::Message(message) => message.trim_start_matches("error  ").to_owned(),
                other => other.text(false),
            };
            format!("Policies in {} do not load: {message}", project.policy_dir.display())
        })
    };
    match name {
        "policies diff" => {
            let local = local()?;
            with_target(name, call, &project, |target| {
                diff(&local, target, args, call.has_flag("fail-on-drift"))
            })
        }
        "policies push" => {
            let local = local()?;
            push(&local, &project, args, call, name)
        }
        "policies pull" => with_target(name, call, &project, |target| pull(call, &project, target, args)),
        "policies history" => {
            let limit = count(call.text("limit"), "limit")?;
            let collection = args.first().map_or("", String::as_str);
            with_target(name, call, &project, |target| history(target, collection, limit))
        }
        "policies rollback" => {
            let version = count(args.get(1).map(String::as_str), "version")?.unwrap_or(0);
            let expect = count(call.text("expect-version"), "expect-version")?;
            let collection = args.first().map_or("", String::as_str);
            with_target(name, call, &project, |target| {
                let current = target.version(collection)?;
                let question = format!("Republish {collection} v{version} as v{}?", current + 1);
                if !call.has_flag("yes") && !confirmed(&question)? {
                    return Ok(ExitCode::FAILURE);
                }
                let published = target
                    .rollback(collection, version, expect.unwrap_or(current), call.text("comment"))
                    .map_err(|refusal| refusal.message)?;
                output(format_args!("published  {collection}  v{published}  (rollback of v{version})"))?;
                Ok(ExitCode::SUCCESS)
            })
        }
        _ => Err(crate::unavailable(name)),
    }
}

fn same_contexts(a: &ContextDefinitions, b: &ContextDefinitions) -> bool {
    matches!((hash_contexts(a), hash_contexts(b)), (Ok(a), Ok(b)) if a == b)
}

fn hash(definition: &CollectionPolicies) -> String {
    hash_collection(definition).unwrap_or_default()
}

fn select(names: &[String], all: &PolicySet) -> Vec<String> {
    if names.is_empty() {
        all.collections().iter().map(|definition| definition.collection.clone()).collect()
    } else {
        names.to_vec()
    }
}

/// What differs between a local and a stored definition, one line per difference.
fn describe_changes(local: &CollectionPolicies, stored: &CollectionPolicies) -> Vec<String> {
    let mut lines = Vec::new();
    let policy_hash = |definition: &CollectionPolicies, name: &str| {
        definition.policies.iter().find(|policy| policy.name == name).map(|policy| {
            hash(&CollectionPolicies {
                collection: String::new(),
                exposed: false,
                realtime: false,
                policies: vec![policy.clone()],
                fields: None,
                immutable: None,
            })
        })
    };
    if local.exposed != stored.exposed {
        lines.push(format!("exposed: {} locally, {} in the database", local.exposed, stored.exposed));
    }
    if local.realtime != stored.realtime {
        lines.push(format!("realtime: {} locally, {} in the database", local.realtime, stored.realtime));
    }
    let mut names: Vec<&str> = Vec::new();
    for policy in local.policies.iter().chain(&stored.policies) {
        if !names.contains(&policy.name.as_str()) {
            names.push(&policy.name);
        }
    }
    for name in names {
        match (policy_hash(local, name), policy_hash(stored, name)) {
            (_, None) => lines.push(format!("policy \"{name}\": only local")),
            (None, _) => lines.push(format!("policy \"{name}\": only in the database")),
            (Some(mine), Some(theirs)) if mine != theirs => lines.push(format!("policy \"{name}\": differs")),
            _ => {}
        }
    }
    let order = |definition: &CollectionPolicies| {
        definition.policies.iter().map(|policy| policy.name.as_str()).collect::<Vec<_>>().join("\n")
    };
    if lines.is_empty() && order(local) != order(stored) {
        lines.push("policy order differs".to_owned());
    }
    let rest = |definition: &CollectionPolicies| {
        hash(&CollectionPolicies {
            exposed: false,
            realtime: false,
            policies: Vec::new(),
            ..definition.clone()
        })
    };
    if rest(local) != rest(stored) {
        lines.push("fields or immutable differ".to_owned());
    }
    lines
}

fn diff(
    local: &PolicySet,
    target: &dyn PolicyTarget,
    args: &[String],
    fail_on_drift: bool,
) -> Result<ExitCode, String> {
    let remote = target.published()?;
    let mut names = select(args, local);
    if args.is_empty() {
        names.extend(remote.collections.iter().map(|(name, ..)| name.clone()));
    }
    names.sort();
    names.dedup();
    let mut drift = 0;
    for name in &names {
        let mine = local.collection(name);
        match (mine, remote.get(name)) {
            (None, None) => {
                error_line(format!("{name}: no policies locally or in the database"))?;
                drift += 1;
            }
            (Some(_), None) => {
                output(format_args!("only local     {name}"))?;
                drift += 1;
            }
            (None, Some((version, _))) => {
                output(format_args!("only database  {name}  v{version}"))?;
                drift += 1;
            }
            (Some(mine), Some((version, theirs))) if hash(mine) == theirs => {
                output(format_args!("same           {name}  v{version}"))?;
            }
            (Some(mine), Some((version, _))) => {
                output(format_args!("changed        {name}  v{version} in the database"))?;
                if let Some(stored) = target.definition(name)? {
                    for line in describe_changes(mine, &stored) {
                        output(format_args!("                 {line}"))?;
                    }
                }
                drift += 1;
            }
        }
    }
    if args.is_empty() && !same_contexts(local.contexts(), &remote.contexts) {
        output(format_args!("changed        context lookups (_context)"))?;
        drift += 1;
    }
    if drift == 0 {
        output(format_args!("No drift: the database matches the policy directory."))?;
    } else {
        output(format_args!("{drift} {}", if drift == 1 { "difference" } else { "differences" }))?;
    }
    Ok(if fail_on_drift && drift > 0 { ExitCode::FAILURE } else { ExitCode::SUCCESS })
}

/// Parses `--expect-version`: a bare number for one collection, or `collection=version` pairs.
pub(crate) fn parse_expected_versions(
    text: &str,
    collections: &[String],
) -> Result<Vec<(String, i64)>, String> {
    if !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit()) {
        let [only] = collections else {
            return Err(format!(
                "A bare --expect-version applies to one collection, but {} would be published ({}). Use collection=version pairs.",
                collections.len(),
                collections.join(", ")
            ));
        };
        return Ok(vec![(only.clone(), text.parse().map_err(|_| "--expect-version is too large")?)]);
    }
    let mut out: Vec<(String, i64)> = Vec::new();
    for part in text.split(',') {
        let refused = || {
            format!(
                "Cannot read --expect-version {}: expected todos=3,notes=5",
                serde_json::Value::String(text.to_owned())
            )
        };
        let (name, version) = part.split_once('=').ok_or_else(refused)?;
        let (name, version) = (name.trim(), version.trim());
        if name.is_empty()
            || name.contains(char::is_whitespace)
            || version.is_empty()
            || !version.bytes().all(|byte| byte.is_ascii_digit())
        {
            return Err(refused());
        }
        let version: i64 = version.parse().map_err(|_| refused())?;
        match out.iter_mut().find(|(known, _)| known == name) {
            Some((_, slot)) => *slot = version,
            None => out.push((name.to_owned(), version)),
        }
    }
    Ok(out)
}

fn conflict_hint(conflict: bool) -> Result<(), String> {
    if conflict {
        error_line("Someone published in between: run canopy policies diff, then push again.")?;
    }
    Ok(())
}

fn push(
    local: &PolicySet,
    project: &Project,
    args: &[String],
    call: &Invocation,
    name: &str,
) -> Result<ExitCode, String> {
    for collection in args {
        if local.collection(collection).is_none() {
            return Err(format!("{collection} has no policies in {}", project.policy_dir.display()));
        }
    }
    let mut names = select(args, local);
    names.sort();
    let definitions: Vec<CollectionPolicies> =
        names.iter().filter_map(|name| local.collection(name).cloned()).collect();
    let errors: Vec<LintFinding> = lint_policies(&definitions, local.contexts(), &LintEnvironment::default())
        .into_iter()
        .filter(|finding| finding.severity == "error")
        .collect();
    if !errors.is_empty() {
        for finding in &errors {
            error_line(format!("error  {}  {}: {}", finding.rule, finding.collection, finding.message))?;
        }
        return Err("Not pushed: fix the lint errors first (canopy policies lint).".to_owned());
    }
    with_target(name, call, project, |target| {
        let remote = target.published()?;
        let changed: Vec<String> = names
            .iter()
            .filter(|name| {
                local.collection(name).is_some_and(|definition| {
                    remote.get(name).map(|(_, hash)| hash) != Some(hash(definition).as_str())
                })
            })
            .cloned()
            .collect();
        let contexts_changed = args.is_empty() && !same_contexts(local.contexts(), &remote.contexts);
        let context_version = remote.context_version;
        let current = |name: &str| {
            if name == CONTEXT_DOCUMENT_ID {
                context_version
            } else {
                remote.get(name).map_or(0, |(version, _)| version)
            }
        };
        let mut expected: Vec<(String, i64)> =
            changed.iter().map(|name| (name.clone(), current(name))).collect();
        if let Some(text) = call.text("expect-version") {
            let parsed = parse_expected_versions(text, if changed.is_empty() { &names } else { &changed })?;
            let missing: Vec<&str> = changed
                .iter()
                .filter(|name| !parsed.iter().any(|(known, _)| known == *name))
                .map(String::as_str)
                .collect();
            if !missing.is_empty() {
                return Err(format!(
                    "--expect-version does not name {}, which would be published",
                    missing.join(", ")
                ));
            }
            let stale: Vec<&(String, i64)> =
                parsed.iter().filter(|(name, version)| current(name) != *version).collect();
            if !stale.is_empty() {
                let lines: Vec<String> = stale
                    .iter()
                    .map(|(name, version)| format!(
                        "{name} is at version {} in the database, not {version}. Someone published in between: run canopy policies diff, then push again.",
                        current(name)
                    ))
                    .collect();
                return Err(lines.join("\n"));
            }
            expected = changed
                .iter()
                .map(|name| {
                    (
                        name.clone(),
                        parsed.iter().find(|(known, _)| known == name).map_or(0, |(_, version)| *version),
                    )
                })
                .collect();
        }
        let mut versions: Vec<(String, i64)> =
            names.iter().map(|name| (name.clone(), current(name))).collect();
        for name in &names {
            if !changed.contains(name) {
                output(format_args!("unchanged  {name}  v{}", current(name)))?;
            }
        }
        if !contexts_changed && args.is_empty() && context_version > 0 {
            output(format_args!("unchanged  _context  v{context_version}"))?;
        }
        let expected_of =
            |name: &str| expected.iter().find(|(known, _)| known == name).map_or(0, |(_, version)| *version);
        if call.has_flag("dry-run") {
            if contexts_changed {
                output(format_args!("would publish  _context  v{}", context_version + 1))?;
            }
            for name in &changed {
                output(format_args!("would publish  {name}  v{}", expected_of(name) + 1))?;
            }
            return Ok(ExitCode::SUCCESS);
        }
        let comment = call.text("comment");
        if contexts_changed {
            match target.publish_contexts(local.contexts(), context_version, comment) {
                Ok(version) => output(format_args!("published  _context  v{version}"))?,
                Err(refusal) => {
                    error_line(format!("_context: {}", refusal.message))?;
                    conflict_hint(refusal.conflict)?;
                    return Ok(ExitCode::FAILURE);
                }
            }
        }
        for name in &changed {
            let Some(definition) = local.collection(name) else { continue };
            match target.publish(definition, expected_of(name), comment) {
                Ok((version, warnings)) => {
                    if let Some((_, slot)) = versions.iter_mut().find(|(known, _)| known == name) {
                        *slot = version;
                    }
                    output(format_args!("published  {name}  v{version}"))?;
                    for (rule, message) in warnings {
                        output(format_args!("  warn  {rule}: {message}"))?;
                    }
                }
                Err(refusal) => {
                    error_line(format!("{name}: {}", refusal.message))?;
                    conflict_hint(refusal.conflict)?;
                    return Ok(ExitCode::FAILURE);
                }
            }
        }
        let summary: Vec<String> =
            versions.iter().map(|(name, version)| format!("{name}={version}")).collect();
        output(format_args!("versions: {}", summary.join(",")))?;
        Ok(ExitCode::SUCCESS)
    })
}

fn file_name(collection: &str) -> String {
    collection
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') { ch } else { '_' })
        .collect()
}

fn pull(
    call: &Invocation,
    project: &Project,
    target: &dyn PolicyTarget,
    args: &[String],
) -> Result<ExitCode, String> {
    let published = target.published()?;
    let mut names: Vec<String> = if args.is_empty() {
        published.collections.iter().map(|(name, ..)| name.clone()).collect()
    } else {
        args.to_vec()
    };
    names.sort();
    let dir = &project.policy_dir;
    let mut files: Vec<(std::path::PathBuf, String)> = Vec::new();
    for name in &names {
        let Some(definition) = target.definition(name)? else {
            return Err(format!("{name} has no published policies"));
        };
        let module = crate::dsl::collection_module(&definition).map_err(|error| {
            format!("{name}: {}; edit it in Studio or write the module by hand", error.message())
        })?;
        files.push((dir.join(format!("{}.ts", file_name(name))), module));
    }
    if args.is_empty() && !published.contexts.is_empty() {
        let module = crate::dsl::context_module(&published.contexts)
            .map_err(|error| format!("_context: {}; write the module by hand", error.message()))?;
        files.push((dir.join("_context.ts"), module));
    }
    let blocked: Vec<String> = files
        .iter()
        .filter(|(file, _)| !call.has_flag("force") && file.exists())
        .map(|(file, _)| file.display().to_string())
        .collect();
    if !blocked.is_empty() {
        return Err(format!(
            "Not pulled: {} already exist. Pass --force to replace them.",
            blocked.join(", ")
        ));
    }
    std::fs::create_dir_all(dir).map_err(|error| format!("{}: {error}", dir.display()))?;
    for (file, content) in &files {
        std::fs::write(file, content).map_err(|error| format!("{}: {error}", file.display()))?;
        output(format_args!("wrote  {}", file.display()))?;
    }
    if call.text("bundle").is_none() {
        let reloaded = project::emit_policies(call, project, dir)
            .map_err(|error| format!("Policies in {} do not load: {}", dir.display(), error.text(false)))?;
        let mut mismatched = 0;
        for name in &names {
            let stored = published.get(name);
            let same = match (reloaded.collection(name), stored) {
                (Some(definition), Some((_, stored_hash))) => hash(definition) == stored_hash,
                _ => false,
            };
            if !same {
                error_line(format!(
                    "{name}: the pulled module does not reproduce version {}",
                    stored.map_or(0, |(version, _)| version)
                ))?;
                mismatched += 1;
            }
        }
        if mismatched > 0 {
            return Ok(ExitCode::FAILURE);
        }
    }
    let summary: Vec<String> = names
        .iter()
        .map(|name| format!("{name}={}", published.get(name).map_or(0, |(version, _)| version)))
        .collect();
    output(format_args!(
        "Pulled {} {}: {}",
        names.len(),
        if names.len() == 1 { "collection" } else { "collections" },
        summary.join(",")
    ))?;
    Ok(ExitCode::SUCCESS)
}

fn history(target: &dyn PolicyTarget, collection: &str, limit: Option<i64>) -> Result<ExitCode, String> {
    let current = target.version(collection)?;
    let entries = target.history(collection, limit)?;
    if entries.is_empty() {
        return Err(format!("{collection} has no published versions"));
    }
    for entry in entries {
        let mut notes = Vec::new();
        if entry.version == current {
            notes.push("current".to_owned());
        }
        if let Some(version) = entry.rollback_of {
            notes.push(format!("rollback of v{version}"));
        }
        if let Some(comment) = &entry.comment {
            notes.push(serde_json::Value::String(comment.clone()).to_string());
        }
        let short: String = entry.hash.chars().take(19).collect();
        let notes = if notes.is_empty() { String::new() } else { format!("  {}", notes.join("  ")) };
        output(format_args!(
            "v{}  {}  {}  {short}{notes}",
            entry.version, entry.published_at, entry.published_by
        ))?;
    }
    Ok(ExitCode::SUCCESS)
}
