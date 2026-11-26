//! Command line entry point for Canopy.

mod admin;
mod auth_import;
mod bundle;
mod credentials;
mod dev;
mod diagnostics;
mod doctor;
mod dsl;
mod explain;
mod indexes;
mod init;
mod invocation;
mod login;
mod meta;
mod policies;
mod policy_tests;
mod project;
mod project_commands;
mod realtime;
mod remote;
mod schema_commands;
mod targets;
mod templates;
mod tokens;

use std::fmt;
use std::io::{self, IsTerminal as _, Write};
use std::process::ExitCode;

const USAGE: &str = include_str!("usage.txt");

fn main() -> ExitCode {
    let outcome = run(std::env::args_os().skip(1).map(|arg| arg.to_string_lossy().into_owned()));
    match outcome {
        Ok(code) => code,
        Err(message) => {
            let _ = writeln!(io::stderr().lock(), "{message}");
            ExitCode::FAILURE
        }
    }
}

fn run(args: impl IntoIterator<Item = String>) -> Result<ExitCode, String> {
    let call = invocation::Invocation::parse(args);
    if call.has_flag("version") {
        output(format_args!("{}", env!("CARGO_PKG_VERSION")))?;
        return Ok(ExitCode::SUCCESS);
    }
    if call.has_flag("help") {
        prompt(USAGE)?;
        return Ok(ExitCode::SUCCESS);
    }
    if call.is_empty() {
        prompt(USAGE)?;
        return Ok(ExitCode::FAILURE);
    }

    let (name, args) = call.validate()?;
    match (name, args) {
        ("login", [url]) => login::login(url, call.text("token"), call.text("env"), call.has_flag("debug")),
        ("logout", [url]) => login::logout(url, call.has_flag("debug")),
        ("admin tokens create" | "admin tokens list" | "admin tokens revoke", _) => {
            tokens::run(name, args, &call)
        }
        (
            "migrate"
            | "keys list"
            | "keys create"
            | "keys revoke"
            | "admin list"
            | "admin create"
            | "admin reset-totp"
            | "realtime enable-images"
            | "realtime disable-images",
            _,
        ) => meta::run(name, args, &call),
        ("auth import", [file]) => auth_import::run(file, &call),
        ("config print", _) => project_commands::config_print(&call),
        ("build", _) => project_commands::build(&call),
        ("pull", _) => schema_commands::pull(&call),
        ("init", _) => init::run(&call),
        ("doctor", _) => doctor::run(&call),
        ("gen types", _) => schema_commands::gen_types(&call),
        ("schema diff" | "schema push", _) => schema_commands::schema(name, &call),
        ("indexes advise" | "indexes create", _) => indexes::run(name, &call),
        (
            "policies lint" | "policies test" | "policies explain" | "policies diff" | "policies push"
            | "policies pull" | "policies history" | "policies rollback",
            _,
        ) => policies::run(name, args, &call),
        ("dev", _) => dev::run(&call),
        _ => Err(unavailable(name)),
    }
}

fn output(line: fmt::Arguments<'_>) -> Result<(), String> {
    writeln!(io::stdout().lock(), "{line}").map_err(|error| error.to_string())
}

fn error_line(line: fmt::Arguments<'_>) -> Result<(), String> {
    writeln!(io::stderr().lock(), "{line}").map_err(|error| error.to_string())
}

fn prompt(text: &str) -> Result<(), String> {
    let mut stdout = io::stdout().lock();
    stdout.write_all(text.as_bytes()).and_then(|()| stdout.flush()).map_err(|error| error.to_string())
}

fn confirmed(question: &str) -> Result<bool, String> {
    if !io::stdin().is_terminal() {
        return Err("Not applied: no terminal to confirm on. Pass --yes to apply without a prompt.".into());
    }
    prompt(&format!("{question} [y/N] "))?;
    let mut answer = String::new();
    io::stdin().read_line(&mut answer).map_err(|error| error.to_string())?;
    let accepted = matches!(answer.trim().to_ascii_lowercase().as_str(), "y" | "yes");
    if !accepted {
        output(format_args!("Not applied."))?;
    }
    Ok(accepted)
}

fn storage_error(message: String, debug: bool) -> String {
    if debug { message } else { format!("{message}\nRun again with --debug for the stack trace.") }
}

fn unavailable(name: &str) -> String {
    format!("canopy {name} is not implemented in this build.")
}
