use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, Command};

use crate::Res;
use crate::setup::{AUDIENCE, ISSUER};

/// The server under test.
pub struct Server {
    child: Child,
    pid: u32,
    system: System,
    pub label: String,
}

/// CPU time and memory of the server process.
#[derive(Clone, Copy, Debug)]
pub struct Sample {
    /// CPU milliseconds since the process started.
    pub cpu_ms: u64,
    /// Resident set (the working set on Windows), in bytes.
    pub rss: u64,
    /// Committed private memory (the page file usage on Windows), in bytes.
    pub private: u64,
}

pub struct Launch<'a> {
    pub kind: &'a str,
    pub engine: &'a str,
    pub node: Option<&'a str>,
    pub repo: &'a Path,
    pub prototype: &'a Path,
    pub uri: &'a str,
    pub database: &'a str,
    pub port: u16,
    pub jwks: &'a str,
    pub read_buffer: usize,
    pub workers: Option<usize>,
    pub shards: Option<usize>,
}

fn sidecar(program: &str, launch: &Launch<'_>) -> Command {
    let script = launch.repo.join("packages").join("realtime").join("src").join("bin").join("canopy-realtime.ts");
    let mut command = Command::new(program);
    command
        .arg("--conditions=@canopy/source")
        .arg(script)
        .current_dir(launch.repo)
        .env("MONGODB_URI", launch.uri)
        .env("CANOPY_DB", launch.database)
        .env("CANOPY_META_DB", format!("{}_meta", launch.database))
        .env("CANOPY_POLICIES", launch.prototype.join("policies"))
        .env("CANOPY_PUBLISHABLE_KEYS", "pk_bench")
        .env("CANOPY_JWT_JWKS_URL", launch.jwks)
        .env("CANOPY_JWT_ISSUER", ISSUER)
        .env("CANOPY_JWT_AUDIENCE", AUDIENCE)
        .env("CANOPY_JWT_ROLES_CLAIM", "roles")
        .env("CANOPY_LOG_LEVEL", "warn")
        .env("CANOPY_RATE_LIMITS", "false")
        .env("CANOPY_CHECKPOINTS", "off")
        .env("CANOPY_REALTIME_FULL_DOCUMENT", "updateLookup")
        .env("CANOPY_ENGINE", launch.engine)
        .env("PORT", launch.port.to_string())
        .env("METRICS_PORT", (launch.port + 1).to_string());
    command
}

impl Server {
    pub async fn start(launch: Launch<'_>) -> Res<Server> {
        let mut command = match launch.kind {
            "rust" => {
                let exe = std::env::current_exe()?;
                let dir = exe.parent().map(Path::to_path_buf).unwrap_or_else(PathBuf::new);
                let mut command = Command::new(dir.join(format!("gateway{}", std::env::consts::EXE_SUFFIX)));
                command
                    .arg("--uri")
                    .arg(launch.uri)
                    .arg("--db")
                    .arg(launch.database)
                    .arg("--port")
                    .arg(launch.port.to_string())
                    .arg("--read-buffer")
                    .arg(launch.read_buffer.to_string());
                if let Some(workers) = launch.workers {
                    command.arg("--workers").arg(workers.to_string());
                }
                if let Some(shards) = launch.shards {
                    command.arg("--shards").arg(shards.to_string());
                }
                command
            }
            "bun" => sidecar("bun", &launch),
            "gateway" => {
                let mut command = sidecar("bun", &launch);
                command.env("CANOPY_REALTIME_SERVER", "gateway");
                if let Some(shards) = launch.shards {
                    command.env("CANOPY_GATEWAY_SHARDS", shards.to_string());
                }
                command
            }
            "node" => sidecar(launch.node.unwrap_or("node"), &launch),
            other => return Err(format!("unknown server {other}").into()),
        };
        let label = match launch.kind {
            "gateway" => "canopyd through canopy-realtime".to_owned(),
            "rust" => format!("rust gateway, read buffer {}, workers {}", launch.read_buffer, launch.workers.map_or("all".to_owned(), |w| w.to_string())) + &launch.shards.map_or(String::new(), |n| format!(", {n} shards")),
            kind => format!("{kind} sidecar, engine {}", launch.engine),
        };
        command.stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::inherit()).kill_on_drop(true);
        let child = command.spawn()?;
        let pid = child.id().ok_or("the server exited at once")?;
        let mut server = Server { child, pid, system: System::new()?, label };
        let started = std::time::Instant::now();
        loop {
            if let Some(status) = server.child.try_wait()? {
                return Err(format!("the server exited with {status}").into());
            }
            if ready(launch.port).await {
                break;
            }
            if started.elapsed() > Duration::from_secs(60) {
                return Err("the server did not become ready in 60 s".into());
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        if launch.kind == "gateway" {
            server.system.refresh_processes(ProcessesToUpdate::All, true);
            let parent = Pid::from_u32(server.pid);
            let child = server
                .system
                .processes()
                .iter()
                .find(|(_, process)| {
                    process.parent() == Some(parent) && process.name().to_string_lossy().starts_with("canopyd")
                })
                .map(|(pid, _)| pid.as_u32());
            server.pid = child.ok_or("the canopyd process was not found")?;
        }
        Ok(server)
    }

    pub fn sample(&mut self) -> Sample {
        let pid = Pid::from_u32(self.pid);
        self.system.refresh_processes_specifics(
            ProcessesToUpdate::Some(&[pid]),
            true,
            ProcessRefreshKind::nothing().with_cpu().with_memory(),
        );
        match self.system.process(pid) {
            Some(process) => Sample {
                cpu_ms: process.accumulated_cpu_time(),
                rss: process.memory(),
                private: process.virtual_memory(),
            },
            None => Sample { cpu_ms: 0, rss: 0, private: 0 },
        }
    }

    pub async fn stop(mut self) {
        if let Some(mut stdin) = self.child.stdin.take() {
            let _ = stdin.shutdown().await;
        }
        drop(self.child.stdin.take());
        if tokio::time::timeout(Duration::from_secs(5), self.child.wait()).await.is_err() {
            let _ = self.child.kill().await;
        }
    }
}

async fn ready(port: u16) -> bool {
    let Ok(Ok(mut socket)) =
        tokio::time::timeout(Duration::from_secs(2), tokio::net::TcpStream::connect(("127.0.0.1", port))).await
    else {
        return false;
    };
    let request = format!("GET /readyz HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    if socket.write_all(request.as_bytes()).await.is_err() {
        return false;
    }
    let mut buffer = [0u8; 64];
    match tokio::time::timeout(Duration::from_secs(2), socket.read(&mut buffer)).await {
        Ok(Ok(read)) => buffer[..read].starts_with(b"HTTP/1.1 200"),
        _ => false,
    }
}
