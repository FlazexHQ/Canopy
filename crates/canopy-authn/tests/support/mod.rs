use serde_json::Value;
use std::{
    io::Write,
    path::Path,
    process::{Command, Output, Stdio},
};

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
