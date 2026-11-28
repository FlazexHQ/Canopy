use std::env;
use std::fs::{self, DirBuilder};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use indexmap::IndexMap;
use serde_json::Value;
use url::Url;

const PROTECTED_PREFIX: &str = "dpapi:";
type Fields = IndexMap<String, Value>;

pub(crate) fn project_key(raw: &str) -> Result<String, String> {
    let url = Url::parse(raw).map_err(|_| "Invalid URL")?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(format!("{raw} is not an http or https URL"));
    }
    Ok(format!("{}{}", url.origin().ascii_serialization(), url.path().trim_end_matches('/')))
}

pub(crate) fn nonempty_env(name: &str) -> Option<String> {
    env::var(name).ok().filter(|value| !value.is_empty())
}

fn env_path(name: &str) -> Option<PathBuf> {
    env::var_os(name).filter(|value| !value.is_empty()).map(PathBuf::from)
}

fn config_file(variable: &str, filename: &str) -> Result<PathBuf, String> {
    if let Some(path) = env_path(variable) {
        return Ok(path);
    }
    let base = env_path("XDG_CONFIG_HOME").or_else(|| {
        if cfg!(windows) {
            env_path("APPDATA").or_else(|| env::home_dir().map(|home| home.join("AppData/Roaming")))
        } else {
            env::home_dir().map(|home| home.join(".config"))
        }
    });
    base.map(|base| base.join("canopy").join(filename))
        .ok_or_else(|| format!("Cannot locate {filename}: the user configuration folder is unknown"))
}

fn read_store(path: &Path) -> Result<Fields, String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Fields::new()),
        Err(error) => return Err(format!("Cannot read {}: {error}", path.display())),
    };
    let contents = String::from_utf8_lossy(&bytes);
    let mut fields: Fields = serde_json::from_str(&contents).map_err(|_| {
        let reason = if serde_json::from_str::<Value>(&contents).is_ok() {
            "must hold a JSON object"
        } else {
            "is not valid JSON"
        };
        format!("{} {reason}; fix or remove it", path.display())
    })?;
    fields.retain(|_, value| value.is_string());
    Ok(fields)
}

fn write_store(path: &Path, fields: &Fields) -> io::Result<()> {
    let parent = path.parent().filter(|path| !path.as_os_str().is_empty()).unwrap_or(Path::new("."));
    let mut dirs = DirBuilder::new();
    dirs.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        dirs.mode(0o700);
    }
    dirs.create(parent)?;
    let mut pending = tempfile::NamedTempFile::new_in(parent)?;
    serde_json::to_writer_pretty(pending.as_file_mut(), fields)?;
    pending.write_all(b"\n")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        pending.as_file().set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    for attempt in 0..=10 {
        match pending.persist(path) {
            Ok(_) => return Ok(()),
            Err(failure)
                if attempt < 10
                    && matches!(
                        failure.error.kind(),
                        io::ErrorKind::PermissionDenied | io::ErrorKind::ResourceBusy
                    ) =>
            {
                pending = failure.file;
                thread::sleep(Duration::from_millis((20 << attempt).min(500)));
            }
            Err(failure) => return Err(failure.error),
        }
    }
    Err(io::Error::other("Could not replace the configuration file"))
}

fn write(path: &Path, fields: &Fields) -> Result<(), String> {
    write_store(path, fields).map_err(|error| format!("Cannot write {}: {error}", path.display()))
}

fn tool(program: &str, args: &[&str], input: &str) -> Option<String> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let input = input.as_bytes().to_vec();
    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let writer = thread::spawn(move || stdin?.write_all(&input).ok());
    let reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout?.take(1024 * 1024 + 1).read_to_end(&mut bytes).ok()?;
        (bytes.len() <= 1024 * 1024).then(|| String::from_utf8_lossy(&bytes).trim().to_owned())
    });
    let deadline = Instant::now() + Duration::from_secs(30);
    let success = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.success(),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    };
    let _ = writer.join();
    if success { reader.join().ok().flatten() } else { None }
}

fn dpapi(protect: bool, input: &str) -> Option<String> {
    let (verb, input_expr, output_expr) = if protect {
        ("Protect", "[Text.Encoding]::UTF8.GetBytes($text)", "[Convert]::ToBase64String($bytes)")
    } else {
        ("Unprotect", "[Convert]::FromBase64String($text)", "[Text.Encoding]::UTF8.GetString($bytes)")
    };
    let script = format!(
        "$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.Security; \
         [Console]::InputEncoding = [Text.UTF8Encoding]::new($false); \
         [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); \
         $text = [Console]::In.ReadToEnd().Trim(); \
         $bytes = [Security.Cryptography.ProtectedData]::{verb}({input_expr}, $null, 'CurrentUser'); \
         [Console]::Out.Write({output_expr})"
    );
    tool("powershell.exe", &["-NoProfile", "-NonInteractive", "-Command", &script], input)
        .filter(|value| !value.is_empty())
}

enum Keychain<'a> {
    Save(&'a str),
    Read,
    Delete,
}

fn keychain(action: Keychain<'_>, account: &str) -> Option<String> {
    match (env::consts::OS, action) {
        ("macos", Keychain::Save(token)) => {
            tool("security", &["add-generic-password", "-U", "-s", "canopy", "-a", account, "-w", token], "")
        }
        ("macos", Keychain::Read) => {
            tool("security", &["find-generic-password", "-s", "canopy", "-a", account, "-w"], "")
        }
        ("macos", Keychain::Delete) => {
            tool("security", &["delete-generic-password", "-s", "canopy", "-a", account], "")
        }
        ("linux", Keychain::Save(token)) => tool(
            "secret-tool",
            &[
                "store",
                "--label",
                &format!("Canopy admin token for {account}"),
                "service",
                "canopy",
                "account",
                account,
            ],
            token,
        ),
        ("linux", Keychain::Read) => {
            tool("secret-tool", &["lookup", "service", "canopy", "account", account], "")
        }
        ("linux", Keychain::Delete) => {
            tool("secret-tool", &["clear", "service", "canopy", "account", account], "")
        }
        _ => None,
    }
}

#[derive(Debug)]
pub(crate) enum Store {
    Keychain,
    Protected,
    File,
}

pub(crate) struct Credentials {
    path: PathBuf,
    fallback_only: bool,
}

impl Credentials {
    pub(crate) fn open() -> Result<Self, String> {
        Ok(Self {
            path: config_file("CANOPY_CREDENTIALS", "credentials.json")?,
            fallback_only: env::var_os("CANOPY_CREDENTIALS").is_some(),
        })
    }

    fn seal(&self, token: &str) -> Option<String> {
        if cfg!(windows) && !self.fallback_only {
            dpapi(true, token).map(|sealed| format!("{PROTECTED_PREFIX}{sealed}"))
        } else {
            None
        }
    }

    pub(crate) fn save(&self, account: &str, token: &str) -> Result<Store, String> {
        if !self.fallback_only && keychain(Keychain::Save(token), account).is_some() {
            self.forget(account)?;
            return Ok(Store::Keychain);
        }
        let mut fields = read_store(&self.path)?;
        let sealed = self.seal(token);
        let store = if sealed.is_some() { Store::Protected } else { Store::File };
        fields.insert(account.to_owned(), Value::String(sealed.unwrap_or_else(|| token.to_owned())));
        write(&self.path, &fields)?;
        Ok(store)
    }

    pub(crate) fn read(&self, account: &str) -> Result<Option<String>, String> {
        if !self.fallback_only
            && let Some(token) = keychain(Keychain::Read, account).filter(|token| !token.is_empty())
        {
            return Ok(Some(token));
        }
        let fields = read_store(&self.path)?;
        let Some(stored) = fields.get(account).and_then(Value::as_str) else {
            return Ok(None);
        };
        if let Some(sealed) = stored.strip_prefix(PROTECTED_PREFIX) {
            return dpapi(false, sealed).map(Some).ok_or_else(|| {
                format!("The token for {account} is encrypted for another Windows account, or this one cannot read it any more; run canopy login again")
            });
        }
        if let Some(sealed) = self.seal(stored)
            && let Ok(mut latest) = read_store(&self.path)
            && latest.get(account).and_then(Value::as_str) == Some(stored)
        {
            latest.insert(account.to_owned(), Value::String(sealed));
            let _ = write(&self.path, &latest);
        }
        Ok(Some(stored.to_owned()))
    }

    pub(crate) fn delete(&self, account: &str) -> Result<bool, String> {
        let found = !self.fallback_only && keychain(Keychain::Delete, account).is_some();
        Ok(self.forget(account)? || found)
    }

    fn forget(&self, account: &str) -> Result<bool, String> {
        let mut fields = read_store(&self.path)?;
        if fields.shift_remove(account).is_none() {
            return Ok(false);
        }
        write(&self.path, &fields)?;
        Ok(true)
    }
}

pub(crate) fn save_environment(name: &str, url: &str) -> Result<(), String> {
    let path = config_file("CANOPY_ENVIRONMENTS", "environments.json")?;
    let mut fields = read_store(&path)?;
    fields.insert(name.to_owned(), Value::String(url.to_owned()));
    write(&path, &fields)
}

pub(crate) fn read_environment(name: &str) -> Result<Option<String>, String> {
    let path = config_file("CANOPY_ENVIRONMENTS", "environments.json")?;
    Ok(read_store(&path)?.get(name).and_then(Value::as_str).map(str::to_owned))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn credentials_match_typescript_file_shape() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("credentials.json");
        let credentials = Credentials { path: path.clone(), fallback_only: true };
        let account = project_key("https://First.example:443/admin///?view=1#here").unwrap();
        assert_eq!(account, "https://first.example/admin");
        assert_eq!(credentials.read(&account).unwrap(), None);
        assert!(matches!(credentials.save(&account, "first-token").unwrap(), Store::File));
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "{\n  \"https://first.example/admin\": \"first-token\"\n}\n"
        );
        assert_eq!(credentials.read(&account).unwrap().as_deref(), Some("first-token"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }

        fs::write(
            &path,
            concat!(
                "{\n  \"https://second.example\": \"second-token\",\n",
                "  \"https://first.example/admin\": \"from-typescript\"\n}\n"
            ),
        )
        .unwrap();
        assert_eq!(credentials.read(&account).unwrap().as_deref(), Some("from-typescript"));
        assert!(credentials.delete(&account).unwrap());
        assert!(!credentials.delete(&account).unwrap());
        assert_eq!(credentials.read(&account).unwrap(), None);
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "{\n  \"https://second.example\": \"second-token\"\n}\n"
        );
        fs::write(&path, "{corrupt").unwrap();
        assert!(credentials.save(&account, "first-token").unwrap_err().contains("is not valid JSON"));
        assert_eq!(fs::read_to_string(&path).unwrap(), "{corrupt");
    }

    #[cfg(windows)]
    #[test]
    fn dpapi_tokens_use_the_current_user_scope() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("credentials.json");
        let credentials = Credentials { path: path.clone(), fallback_only: false };
        let account = "https://example.test";
        assert!(matches!(credentials.save(account, "protected-token").unwrap(), Store::Protected));
        let stored = read_store(&path).unwrap();
        let sealed = stored[account].as_str().unwrap();
        assert!(sealed.starts_with(PROTECTED_PREFIX));
        assert!(!sealed.contains("protected-token"));
        assert_eq!(credentials.read(account).unwrap().as_deref(), Some("protected-token"));
        assert!(credentials.delete(account).unwrap());
    }
}
