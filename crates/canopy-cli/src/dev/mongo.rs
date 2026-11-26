use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use canopy_mongo::mongodb::{Client, bson::doc, error::ErrorKind, options::ClientOptions};

/// The official MongoDB Community image `canopy dev --with-mongo` runs by default.
pub(crate) const DEFAULT_IMAGE: &str = "mongodb/mongodb-community-server:8.0-ubi9";
/// The MongoDB version `canopy dev --with-mongo` downloads when Docker is not available.
pub(crate) const DEFAULT_VERSION: &str = "8.0.34";
const READY_TIMEOUT: Duration = Duration::from_secs(60);

struct Output {
    code: i32,
    stdout: String,
    stderr: String,
}

fn docker(args: &[&str]) -> Output {
    match Command::new("docker").args(args).stdin(Stdio::null()).output() {
        Ok(output) => Output {
            code: output.status.code().unwrap_or(1),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Output { code: 127, stdout: String::new(), stderr: error.to_string() }
        }
        Err(error) => Output { code: 1, stdout: String::new(), stderr: error.to_string() },
    }
}

/// Whether the `docker` command is installed and its daemon answers.
pub(crate) fn docker_available() -> bool {
    let result = docker(&["version", "--format", "{{.Server.Version}}"]);
    result.code == 0 && !result.stdout.trim().is_empty()
}

fn sha256_hex(bytes: &[u8]) -> String {
    ring::digest::digest(&ring::digest::SHA256, bytes)
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// The container name of a project: stable per directory, readable, and unique across projects.
pub(crate) fn container_name(project: &Path) -> String {
    let root = project.to_string_lossy();
    let base = project.file_name().map(|name| name.to_string_lossy().to_lowercase()).unwrap_or_default();
    let mut slug = String::new();
    for c in base.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            slug.push(c);
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug = slug.trim_matches('-');
    let slug = if slug.is_empty() { "project" } else { slug };
    let hash = sha256_hex(root.as_bytes());
    format!("canopy-dev-{slug}-{}", hash.get(..8).unwrap_or_default())
}

/// The `docker run` arguments of a single node replica set with a named volume for its data.
pub(crate) fn docker_run_args(name: &str, port: u16, image: &str) -> Vec<String> {
    [
        "run",
        "--detach",
        "--name",
        name,
        "--label",
        "dev.canopy.role=mongo",
        "--publish",
        &format!("127.0.0.1:{port}:{port}"),
        "--volume",
        &format!("{name}-data:/data/db"),
        image,
        "--replSet",
        "rs0",
        "--bind_ip_all",
        "--port",
        &port.to_string(),
    ]
    .into_iter()
    .map(str::to_owned)
    .collect()
}

/// Waits until the server at `uri` (a direct connection) is the writable primary of a replica set,
/// initiating a single member set the first time.
fn wait_for_primary(uri: &str, port: u16, stopped: &mut dyn FnMut() -> Option<String>) -> Result<(), String> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| error.to_string())?;
    let deadline = Instant::now() + READY_TIMEOUT;
    let mut last = "not reachable".to_owned();
    while Instant::now() < deadline {
        if let Some(reason) = stopped() {
            return Err(reason);
        }
        let attempt = runtime.block_on(async {
            let mut options = ClientOptions::parse(uri).await?;
            options.direct_connection = Some(true);
            options.server_selection_timeout = Some(Duration::from_secs(1));
            options.connect_timeout = Some(Duration::from_secs(1));
            let client = Client::with_options(options)?;
            let admin = client.database("admin");
            let result = async {
                let hello = admin.run_command(doc! { "hello": 1 }).await?;
                if hello.get_bool("isWritablePrimary").unwrap_or(false) && hello.get_str("setName").is_ok() {
                    return Ok(true);
                }
                if hello.get_str("setName").is_err() {
                    let config = doc! { "_id": "rs0", "members": [{ "_id": 0, "host": format!("localhost:{port}") }] };
                    if let Err(error) = admin.run_command(doc! { "replSetInitiate": config }).await {
                        let initiated = matches!(error.kind.as_ref(), ErrorKind::Command(command) if command.code_name == "AlreadyInitialized");
                        if !initiated {
                            return Err(error);
                        }
                    }
                }
                Ok(false)
            }
            .await;
            client.shutdown().await;
            result
        });
        match attempt {
            Ok(true) => return Ok(()),
            Ok(false) => last = "waiting for the primary".to_owned(),
            Err(error) => last = error.to_string(),
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    Err(format!("MongoDB did not become a writable primary within {} ms: {last}", READY_TIMEOUT.as_millis()))
}

/// Starts (or reuses) a single node replica set in Docker with a named volume, waits until it is healthy and
/// returns its connection string with `database` as the app database.
pub(crate) fn start_docker(
    project: &Path,
    port: u16,
    database: &str,
    image: &str,
    log: &mut dyn FnMut(&str),
) -> Result<String, String> {
    let name = container_name(project);
    let state = docker(&["inspect", "--format", "{{.State.Running}}", &name]);
    if state.code == 127 {
        return Err("docker is not installed or not on PATH; --with-mongo needs Docker".to_owned());
    }
    let failed = |what: &str, result: &Output| {
        let detail =
            if result.stderr.trim().is_empty() { result.stdout.trim() } else { result.stderr.trim() };
        format!("{what} failed: {detail}")
    };
    if state.code != 0 {
        log(&format!(
            "Starting {image} as {name}, data in the volume {name}-data (the first run pulls the image)"
        ));
        let args = docker_run_args(&name, port, image);
        let started = docker(&args.iter().map(String::as_str).collect::<Vec<_>>());
        if started.code != 0 {
            return Err(failed("docker run", &started));
        }
    } else if state.stdout.trim() != "true" {
        log(&format!("Starting the existing container {name}"));
        let started = docker(&["start", &name]);
        if started.code != 0 {
            return Err(failed("docker start", &started));
        }
    } else {
        log(&format!("Reusing the running container {name}"));
    }
    wait_for_primary(&format!("mongodb://localhost:{port}/"), port, &mut || None)?;
    Ok(format!("mongodb://localhost:{port}/{database}?replicaSet=rs0"))
}

/// Where downloaded MongoDB builds are kept, shared by every project of this user.
pub(crate) fn cache_dir(env: &std::collections::HashMap<String, String>) -> PathBuf {
    if let Some(dir) = env.get("CANOPY_MONGO_CACHE").filter(|dir| !dir.is_empty()) {
        return crate::project::absolute(&std::env::current_dir().unwrap_or_default(), dir);
    }
    let home =
        env.get(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from).unwrap_or_default();
    if cfg!(windows) {
        let local = env.get("LOCALAPPDATA").map_or_else(|| home.join("AppData").join("Local"), PathBuf::from);
        return local.join("canopy").join("mongodb");
    }
    if cfg!(target_os = "macos") {
        return home.join("Library").join("Caches").join("canopy").join("mongodb");
    }
    env.get("XDG_CACHE_HOME")
        .map_or_else(|| home.join(".cache"), PathBuf::from)
        .join("canopy")
        .join("mongodb")
}

/// The download URL of the official server build for this platform and CPU, from fastdl.mongodb.org. Linux
/// uses the Ubuntu 24.04 build, which runs on current glibc distributions; musl (Alpine) has none.
pub(crate) fn archive_url(version: &str, os: &str, arch: &str) -> Result<String, String> {
    let base = "https://fastdl.mongodb.org";
    let x64 = arch == "x86_64";
    let unsupported = || {
        format!("MongoDB publishes no server build for {os} {arch}; run MongoDB yourself and set MONGODB_URI")
    };
    match os {
        "windows" if x64 => Ok(format!("{base}/windows/mongodb-windows-x86_64-{version}.zip")),
        "macos" if x64 || arch == "aarch64" => {
            Ok(format!("{base}/osx/mongodb-macos-{}-{version}.tgz", if x64 { "x86_64" } else { "arm64" }))
        }
        "linux" if cfg!(target_env = "musl") => Err(unsupported()),
        "linux" if x64 || arch == "aarch64" => Ok(format!(
            "{base}/linux/mongodb-linux-{}-ubuntu2404-{version}.tgz",
            if x64 { "x86_64" } else { "aarch64" }
        )),
        _ => Err(unsupported()),
    }
}

fn find_mongod(dir: &Path) -> Option<PathBuf> {
    let name = if cfg!(windows) { "mongod.exe" } else { "mongod" };
    std::fs::read_dir(dir).ok()?.filter_map(Result::ok).find_map(|entry| {
        let candidate = entry.path().join("bin").join(name);
        candidate.is_file().then_some(candidate)
    })
}

fn tar() -> PathBuf {
    if cfg!(windows) {
        let root = std::env::var_os("SystemRoot").map_or_else(|| PathBuf::from("C:\\Windows"), PathBuf::from);
        root.join("System32").join("tar.exe")
    } else {
        PathBuf::from("tar")
    }
}

/// Returns the path of `mongod` for `version`, downloading, checking and unpacking the official build once.
fn install(version: &str, cache: &Path, log: &mut dyn FnMut(&str)) -> Result<PathBuf, String> {
    let target = cache.join(version);
    if let Some(mongod) = find_mongod(&target) {
        return Ok(mongod);
    }
    let url = archive_url(version, std::env::consts::OS, std::env::consts::ARCH)?;
    log(&format!("Downloading MongoDB {version} from {url} (once, into {})", target.display()));
    let client = reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|error| error.to_string())?;
    let fetch = |url: &str| -> Result<Vec<u8>, String> {
        let response = client.get(url).send().map_err(|error| format!("GET {url}: {error}"))?;
        if !response.status().is_success() {
            return Err(format!("GET {url} answered {}", response.status().as_u16()));
        }
        response.bytes().map(|bytes| bytes.to_vec()).map_err(|error| format!("GET {url}: {error}"))
    };
    let checksum = String::from_utf8_lossy(&fetch(&format!("{url}.sha256"))?).into_owned();
    let expected = checksum.split_whitespace().next().unwrap_or_default().to_ascii_lowercase();
    let archive = fetch(&url)?;
    if sha256_hex(&archive) != expected {
        return Err(format!("The archive from {url} does not match its published SHA-256"));
    }
    let staging = cache.join(format!("{version}.partial"));
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|error| format!("{}: {error}", staging.display()))?;
    let file = staging.join(url.rsplit('/').next().unwrap_or("mongodb-archive"));
    std::fs::write(&file, archive).map_err(|error| format!("{}: {error}", file.display()))?;
    let status = Command::new(tar())
        .arg("-xf")
        .arg(&file)
        .arg("-C")
        .arg(&staging)
        .stdin(Stdio::null())
        .status()
        .map_err(|error| format!("Could not run tar: {error}"))?;
    if !status.success() {
        return Err(format!("tar could not unpack {}", file.display()));
    }
    let _ = std::fs::remove_file(&file);
    let _ = std::fs::remove_dir_all(&target);
    std::fs::rename(&staging, &target).map_err(|error| format!("{}: {error}", target.display()))?;
    find_mongod(&target).ok_or_else(|| format!("The archive from {url} has no mongod"))
}

/// A `mongod` started by `canopy dev --with-mongo` from the official binaries.
pub(crate) struct RunningMongo {
    pub(crate) uri: String,
    child: Child,
}

impl RunningMongo {
    /// Stops `mongod`: a graceful shutdown on POSIX (SIGTERM, then SIGKILL after ten seconds); Windows has no
    /// graceful signal for a console less child, so it is terminated.
    pub(crate) fn stop(mut self) {
        if !cfg!(windows) {
            let _ = Command::new("kill").args(["-TERM", &self.child.id().to_string()]).status();
            let deadline = Instant::now() + Duration::from_secs(10);
            while Instant::now() < deadline {
                if matches!(self.child.try_wait(), Ok(Some(_))) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Starts a single node replica set from the official binaries, with its data in the project's
/// `.canopy/mongodb` folder, and waits until it is the writable primary.
pub(crate) fn start_binary(
    project: &Path,
    port: u16,
    database: &str,
    version: &str,
    cache: &Path,
    log: &mut dyn FnMut(&str),
) -> Result<RunningMongo, String> {
    let mongod = install(version, cache, log)?;
    let home = project.join(".canopy").join("mongodb");
    let data = home.join("data");
    std::fs::create_dir_all(&data).map_err(|error| format!("{}: {error}", data.display()))?;
    let log_path = home.join("mongod.log");
    log(&format!(
        "Starting mongod on port {port}, data in {}, log in {}",
        data.display(),
        log_path.display()
    ));
    let mut command = Command::new(&mongod);
    command
        .args(["--replSet", "rs0", "--port", &port.to_string(), "--ipv6", "--bind_ip", "127.0.0.1,::1"])
        .arg("--dbpath")
        .arg(&data)
        .arg("--logpath")
        .arg(&log_path)
        .arg("--logappend")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let child = command.spawn().map_err(|error| format!("Could not start {}: {error}", mongod.display()))?;
    let mut running =
        RunningMongo { uri: format!("mongodb://localhost:{port}/{database}?replicaSet=rs0"), child };
    let shown = log_path.display().to_string();
    let ready = wait_for_primary(&format!("mongodb://127.0.0.1:{port}/"), port, &mut || match running
        .child
        .try_wait()
    {
        Ok(Some(status)) => Some(format!(
            "mongod exited with code {} before it was ready; see {shown}",
            status.code().map_or_else(|| "null".to_owned(), |code| code.to_string())
        )),
        _ => None,
    });
    match ready {
        Ok(()) => Ok(running),
        Err(message) => {
            running.stop();
            Err(message)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{archive_url, container_name, docker_run_args};
    use std::path::Path;

    #[test]
    fn container_names_are_readable_and_unique_per_directory() {
        let name = container_name(Path::new("/home/dev/My App"));
        assert!(name.starts_with("canopy-dev-my-app-"), "{name}");
        assert_eq!(name.len(), "canopy-dev-my-app-".len() + 8);
        assert_ne!(name, container_name(Path::new("/srv/My App")));
        assert!(container_name(Path::new("/")).starts_with("canopy-dev-project-"));
    }

    #[test]
    fn docker_publishes_the_same_port_on_loopback_only() {
        let args = docker_run_args("canopy-dev-x", 27018, "image:tag");
        let joined = args.join(" ");
        assert!(joined.contains("--publish 127.0.0.1:27018:27018"), "{joined}");
        assert!(joined.ends_with("image:tag --replSet rs0 --bind_ip_all --port 27018"), "{joined}");
    }

    #[test]
    fn archive_urls_name_the_official_builds() {
        assert_eq!(
            archive_url("8.0.34", "windows", "x86_64").as_deref(),
            Ok("https://fastdl.mongodb.org/windows/mongodb-windows-x86_64-8.0.34.zip")
        );
        assert_eq!(
            archive_url("8.0.34", "macos", "aarch64").as_deref(),
            Ok("https://fastdl.mongodb.org/osx/mongodb-macos-arm64-8.0.34.tgz")
        );
        assert!(archive_url("8.0.34", "windows", "aarch64").is_err());
        assert!(archive_url("8.0.34", "freebsd", "x86_64").is_err());
    }
}
