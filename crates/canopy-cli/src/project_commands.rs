use std::process::ExitCode;

use canopy_config::authoring::{Command, format_config};
use canopy_protocol::json::{Json, write_json};

use crate::invocation::Invocation;
use crate::output;

/// `canopy config print`: the resolved config, secrets masked, with `--sources` the origin of each value.
pub(crate) fn config_print(call: &Invocation) -> Result<ExitCode, String> {
    let debug = call.has_flag("debug");
    let project =
        crate::project::configure(call, Command::Print, false).map_err(|error| error.text(debug))?;
    let text = format_config(&project.resolution, call.has_flag("sources"));
    output(format_args!("{}", text.trim_end()))?;
    Ok(ExitCode::SUCCESS)
}

/// `canopy build`: writes the canonical bundle of the project to a file, for deployments that publish
/// policies without a JavaScript runtime (`canopy policies push --bundle`, or `CANOPY_POLICY_BUNDLE` at
/// control startup). The config stays unresolved, so no secret reaches the file.
pub(crate) fn build(call: &Invocation) -> Result<ExitCode, String> {
    if call.text("bundle").is_some() {
        return Err("canopy build writes a bundle; it does not read one (remove --bundle).".to_owned());
    }
    let debug = call.has_flag("debug");
    let project = crate::project::load_with(call, Command::Policies, Command::Start, true)
        .map_err(|error| error.text(debug))?;
    let out = match call.text("out") {
        Some(out) => crate::project::absolute(&project.cwd, out),
        None => project.root.join("canopy.bundle.json"),
    };
    let mut text = String::new();
    write_json(&mut text, &project.bundle.json);
    text.push('\n');
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("{}: {error}", parent.display()))?;
    }
    std::fs::write(&out, text).map_err(|error| format!("{}: {error}", out.display()))?;
    let collections = project.bundle.policies.as_ref().map_or(0, |set| set.collections().len());
    let tests = match project.bundle.json.get("tests") {
        Some(Json::Array(tests)) => tests.len(),
        _ => 0,
    };
    output(format_args!("wrote  {}", out.display()))?;
    output(format_args!(
        "{collections} {}, {tests} policy {}, config {}",
        if collections == 1 { "collection" } else { "collections" },
        if tests == 1 { "test" } else { "tests" },
        if project.bundle.config.is_some() { "unresolved" } else { "absent (zero config)" }
    ))?;
    Ok(ExitCode::SUCCESS)
}
