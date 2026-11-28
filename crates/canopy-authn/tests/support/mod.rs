use serde_json::Value;
use std::{
    io::Write,
    path::Path,
    process::{Command, Output, Stdio},
};

/// Whether the TypeScript server is available for interoperability checks: `CANOPY_TEST_TYPESCRIPT` is set
/// where Bun and the workspace dependencies are installed. Prints why a test is skipped otherwise.
#[allow(clippy::print_stderr)]
pub(super) fn enabled(test: &str) -> bool {
    let enabled = std::env::var_os("CANOPY_TEST_TYPESCRIPT").is_some();
    if !enabled {
        eprintln!("skipped {test}: set CANOPY_TEST_TYPESCRIPT where Bun and the workspace are installed");
    }
    enabled
}

pub(super) fn typescript(mode: &str, input: &Value) -> std::io::Result<Output> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut child = Command::new("bun")
        .args(["--conditions=@canopy/source", "packages/auth-builtin/test/password-interop.ts", mode])
        .current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let mut stdin = child.stdin.take().ok_or_else(|| std::io::Error::other("Bun stdin unavailable"))?;
    stdin.write_all(input.to_string().as_bytes())?;
    drop(stdin);
    let output = child.wait_with_output()?;
    assert!(output.status.success(), "TypeScript {mode}: {}", String::from_utf8_lossy(&output.stderr));
    Ok(output)
}
