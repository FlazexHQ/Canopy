//! Command line entry point for Canopy.

mod credentials;
mod invocation;
mod login;
mod remote;
mod tokens;

use std::fmt;
use std::io::{self, Write};
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
        ("dev", _) => {
            let errors = ["port", "mongo-port"]
                .into_iter()
                .filter_map(|flag| {
                    let value = call.text(flag)?;
                    (!value.bytes().all(|byte| byte.is_ascii_digit()) || value.parse::<u16>().is_err())
                        .then(|| format!("--{flag} needs a port number between 0 and 65535"))
                })
                .collect::<Vec<_>>();
            if errors.is_empty() { Err(unavailable(name)) } else { Err(errors.join("\n")) }
        }
        _ => Err(unavailable(name)),
    }
}

fn output(line: fmt::Arguments<'_>) -> Result<(), String> {
    writeln!(io::stdout().lock(), "{line}").map_err(|error| error.to_string())
}

fn prompt(text: &str) -> Result<(), String> {
    let mut stdout = io::stdout().lock();
    stdout.write_all(text.as_bytes()).and_then(|()| stdout.flush()).map_err(|error| error.to_string())
}

fn storage_error(message: String, debug: bool) -> String {
    if debug { message } else { format!("{message}\nRun again with --debug for the stack trace.") }
}

fn unavailable(name: &str) -> String {
    format!("canopy {name} is not implemented in this build.")
}
