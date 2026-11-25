//! Command line entry point for Canopy.

mod invocation;
mod login;

use std::io::{self, Write};
use std::process::ExitCode;

const USAGE: &str = include_str!("usage.txt");

fn main() -> ExitCode {
    let outcome = run(std::env::args_os().skip(1).map(|arg| arg.to_string_lossy().into_owned()));
    match outcome {
        Ok((stdout, code)) if io::stdout().write_all(stdout.as_bytes()).is_ok() => code,
        Ok(_) => ExitCode::FAILURE,
        Err(message) => {
            let _ = writeln!(io::stderr().lock(), "{message}");
            ExitCode::FAILURE
        }
    }
}

fn run(args: impl IntoIterator<Item = String>) -> Result<(&'static str, ExitCode), String> {
    let call = invocation::Invocation::parse(args);
    if call.has_flag("version") {
        return Ok((concat!(env!("CARGO_PKG_VERSION"), "\n"), ExitCode::SUCCESS));
    }
    if call.has_flag("help") {
        return Ok((USAGE, ExitCode::SUCCESS));
    }
    if call.is_empty() {
        return Ok((USAGE, ExitCode::FAILURE));
    }

    let (name, args) = call.validate()?;
    match (name, args) {
        ("login", [url]) => login::login(url, call.text("token")),
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

fn unavailable(name: &str) -> String {
    format!("canopy {name} is not implemented in this build.")
}
