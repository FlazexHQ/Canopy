use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use canopy_auth::{Authenticator, RateLimits};
use canopy_config::{WireSettings, WireTls};
use canopy_data::ReadPath;
use canopy_data::writes::WritePath;
use canopy_mongo::mongodb::bson::doc;
use canopy_policy::Roles;
use canopy_realtime::EngineSender;
use canopy_wire::frame::{Header, WireError, encode_compressed, encode_reply, parse_request};
use canopy_wire::session::Session;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, pem::PemObject};
use tokio::io::{AsyncRead, AsyncReadExt as _, AsyncWrite, AsyncWriteExt as _};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{oneshot, watch};
use tokio::task::{JoinHandle, JoinSet};
use tokio::time::timeout;
use tokio_rustls::TlsAcceptor;

const HEADER_BYTES: usize = 16;

#[derive(Default)]
pub(crate) struct Metrics {
    connections: AtomicU64,
    commands: AtomicU64,
}

impl Metrics {
    pub(crate) fn render(&self) -> String {
        format!(
            "# HELP canopy_wire_connections Active MongoDB wire connections\n\
             # TYPE canopy_wire_connections gauge\ncanopy_wire_connections {}\n\
             # HELP canopy_wire_commands_total Parsed MongoDB wire commands\n\
             # TYPE canopy_wire_commands_total counter\ncanopy_wire_commands_total {}\n",
            self.connections.load(Ordering::Relaxed),
            self.commands.load(Ordering::Relaxed),
        )
    }
}

struct Connection(Arc<Metrics>);

impl Drop for Connection {
    fn drop(&mut self) {
        self.0.connections.fetch_sub(1, Ordering::Relaxed);
    }
}

struct Handler {
    auth: Authenticator,
    limits: Option<Arc<RateLimits>>,
    reads: Arc<ReadPath>,
    writes: Arc<WritePath>,
    realtime: EngineSender,
    metrics: Arc<Metrics>,
    tls: Option<TlsAcceptor>,
    idle: Duration,
    max_bytes: usize,
}

pub(crate) struct Listener {
    socket: TcpListener,
    handler: Arc<Handler>,
    max_connections: usize,
}

pub(crate) struct Running {
    shutdown: oneshot::Sender<Duration>,
    task: JoinHandle<()>,
}

impl Running {
    pub(crate) fn drain(self, window: Duration) -> JoinHandle<()> {
        let _ = self.shutdown.send(window);
        self.task
    }
}

impl Listener {
    pub(crate) async fn bind(
        settings: &WireSettings,
        auth: Authenticator,
        limits: Option<Arc<RateLimits>>,
        reads: Arc<ReadPath>,
        writes: Arc<WritePath>,
        realtime: EngineSender,
    ) -> Result<Self, String> {
        let tls = settings.tls.as_ref().map(tls_acceptor).transpose()?;
        let socket = TcpListener::bind((settings.host.as_str(), settings.port))
            .await
            .map_err(|error| format!("Could not listen for MongoDB wire on {}: {error}", settings.port))?;
        Ok(Self {
            socket,
            handler: Arc::new(Handler {
                auth,
                limits,
                reads,
                writes,
                realtime,
                metrics: Arc::default(),
                tls,
                idle: Duration::from_millis(settings.idle_timeout_ms),
                max_bytes: settings.max_message_bytes,
            }),
            max_connections: settings.max_connections,
        })
    }

    pub(crate) fn metrics(&self) -> Arc<Metrics> {
        Arc::clone(&self.handler.metrics)
    }

    pub(crate) fn port(&self) -> std::io::Result<u16> {
        self.socket.local_addr().map(|address| address.port())
    }

    pub(crate) fn start(self) -> Running {
        let (shutdown, stop) = oneshot::channel();
        let task = tokio::spawn(self.serve(stop));
        Running { shutdown, task }
    }

    async fn serve(self, mut stop: oneshot::Receiver<Duration>) {
        let (drain, _) = watch::channel(());
        let mut connections = JoinSet::new();
        let mut id = 0_i64;
        let window = loop {
            tokio::select! {
                biased;
                result = &mut stop => break result.unwrap_or_default(),
                _ = connections.join_next(), if !connections.is_empty() => {}
                accepted = self.socket.accept() => {
                    let Ok((socket, peer)) = accepted else {
                        if let Ok(result) = timeout(Duration::from_millis(100), &mut stop).await {
                            break result.unwrap_or_default();
                        }
                        continue;
                    };
                    if connections.len() == self.max_connections {
                        continue;
                    }
                    id = id.wrapping_add(1);
                    let handler = Arc::clone(&self.handler);
                    let draining = drain.subscribe();
                    let connection = Connection(Arc::clone(&handler.metrics));
                    handler.metrics.connections.fetch_add(1, Ordering::Relaxed);
                    connections.spawn(handler.connect(socket, peer.ip(), id, draining, connection));
                }
            }
        };
        drop(self.socket);
        drop(drain);
        let _ = timeout(window, async { while connections.join_next().await.is_some() {} }).await;
        connections.shutdown().await;
    }
}

fn tls_acceptor(files: &WireTls) -> Result<TlsAcceptor, String> {
    let certificates = CertificateDer::pem_file_iter(&files.cert_file)
        .and_then(Iterator::collect::<Result<Vec<_>, _>>)
        .map_err(|_| "Could not read wire.tls.certFile")?;
    let key = PrivateKeyDer::from_pem_file(&files.key_file).map_err(|_| "Could not read wire.tls.keyFile")?;
    let config = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certificates, key)
        .map_err(|_| "Invalid wire TLS certificate or private key")?;
    Ok(TlsAcceptor::from(Arc::new(config)))
}

impl Handler {
    async fn connect(
        self: Arc<Self>,
        socket: TcpStream,
        peer: std::net::IpAddr,
        id: i64,
        mut drain: watch::Receiver<()>,
        _connection: Connection,
    ) {
        let session = Session::new(self.auth.clone(), self.limits.clone(), peer, id)
            .with_read_path(Arc::clone(&self.reads))
            .with_write_path(Arc::clone(&self.writes))
            .with_realtime(self.realtime.clone());
        if let Some(tls) = &self.tls {
            let stream = tokio::select! {
                biased;
                _ = drain.changed() => return,
                stream = timeout(self.idle, tls.accept(socket)) => stream,
            };
            if let Ok(Ok(stream)) = stream {
                self.commands(stream, session, &peer.to_string(), drain).await;
            }
        } else {
            self.commands(socket, session, &peer.to_string(), drain).await;
        }
    }

    async fn commands(
        &self,
        mut stream: impl AsyncRead + AsyncWrite + Unpin,
        mut session: Session,
        address: &str,
        mut drain: watch::Receiver<()>,
    ) {
        loop {
            let frame = tokio::select! {
                biased;
                _ = drain.changed() => break,
                frame = timeout(self.idle, read_frame(&mut stream, self.max_bytes)) => frame,
            };
            let Ok(Some(frame)) = frame else { break };
            let (reply, compressor) = match parse_request(&frame, self.max_bytes, session.compressors()) {
                Ok((message, compressor)) => {
                    self.metrics.commands.fetch_add(1, Ordering::Relaxed);
                    let command = message.body.keys().next().map_or("", String::as_str);
                    let reply = if self.limited(command, address) {
                        if message.more_to_come {
                            continue;
                        }
                        encode_reply(
                            message.header,
                            &doc! { "ok": 0.0, "code": 16500, "codeName": "TooManyRequests", "errmsg": "Too many requests" },
                        )
                        .map(Some)
                    } else {
                        session.handle(message).await
                    };
                    (reply, compressor)
                }
                Err(WireError::Reply { header, document }) => {
                    (encode_reply(header, &document).map(Some), None)
                }
                Err(_) => break,
            };
            let reply = match reply {
                Ok(Some(reply)) => reply,
                Ok(None) => continue,
                Err(_) => break,
            };
            let reply = if let Some(compressor) = compressor {
                let Ok(compressed) = encode_compressed(&reply, compressor) else { break };
                compressed
            } else {
                reply
            };
            if !matches!(timeout(self.idle, stream.write_all(&reply)).await, Ok(Ok(()))) {
                break;
            }
        }
        let _ = timeout(self.idle, stream.shutdown()).await;
    }

    fn limited(&self, command: &str, address: &str) -> bool {
        !matches!(command, "hello" | "isMaster" | "ismaster" | "saslStart" | "saslContinue" | "endSessions")
            && self
                .limits
                .as_ref()
                .is_some_and(|limits| limits.request(None, "anon", &Roles::new(), address) > 0)
    }
}

async fn read_frame(stream: &mut (impl AsyncRead + Unpin), max_bytes: usize) -> Option<Vec<u8>> {
    let mut bytes = [0; HEADER_BYTES];
    stream.read_exact(&mut bytes).await.ok()?;
    let header = Header::parse(&bytes, max_bytes).ok()?;
    let mut frame = bytes.to_vec();
    let remaining = header.length - HEADER_BYTES;
    let count = stream.take(remaining as u64).read_to_end(&mut frame).await.ok()?;
    (count == remaining).then_some(frame)
}
