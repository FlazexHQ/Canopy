//! Local test listener for exercising the session through an official driver.
#![allow(clippy::print_stdout)]

#[path = "../tests/common/mod.rs"]
mod common;

#[path = "../tests/common/read_fixture.rs"]
mod read_fixture;

#[path = "../tests/common/write_fixture.rs"]
mod write_fixture;

use std::sync::Arc;

use std::sync::atomic::{AtomicI64, Ordering};

use canopy_mongo::mongodb::bson::DateTime;
use canopy_wire::Session;
use canopy_wire::frame::{Header, parse_message};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::{TcpListener, TcpStream};

const LIMIT: usize = 48_000_000;

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let auth = common::authenticator();
    let connection_id = AtomicI64::new(1);
    let jwt = common::token(DateTime::now().timestamp_millis() / 1000 + 600);
    let (path, write_path) = match std::env::var("CANOPY_TEST_MONGODB_URI") {
        Ok(uri) if !uri.is_empty() && std::env::args().any(|arg| arg == "--writes") => {
            let fixture = write_fixture::fixture(&uri, "probe").await?;
            println!("{} {jwt} {} {}", listener.local_addr()?.port(), fixture.db.name(), fixture.meta.name());
            (Some(fixture.reads), Some(fixture.writes))
        }
        Ok(uri) if !uri.is_empty() => (Some(read_fixture::fixture(&uri, "probe").await?), None),
        _ => (None, None),
    };
    if write_path.is_none() {
        if let Some(path) = &path {
            println!("{} {jwt} {}", listener.local_addr()?.port(), path.database().name());
        } else {
            println!("{} {jwt}", listener.local_addr()?.port());
        }
    }
    loop {
        let (stream, peer) = listener.accept().await?;
        let id = connection_id.fetch_add(1, Ordering::Relaxed);
        let mut session = Session::new(auth.clone(), None, peer.ip(), id);
        if let Some(path) = &path {
            session = session.with_read_path(Arc::clone(path));
        }
        if let Some(path) = &write_path {
            session = session.with_write_path(Arc::clone(path));
        }
        tokio::spawn(serve(stream, session));
    }
}

async fn serve(
    mut stream: TcpStream,
    mut session: Session,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    loop {
        let mut header = [0u8; 16];
        if stream.read(&mut header[..1]).await? == 0 {
            return Ok(());
        }
        stream.read_exact(&mut header[1..]).await?;
        let length = Header::parse(&header, LIMIT)?.length;
        let mut frame = Vec::from(header);
        frame.resize(length, 0);
        stream.read_exact(&mut frame[16..]).await?;
        if let Some(reply) = session.handle(parse_message(&frame, LIMIT)?).await? {
            stream.write_all(&reply).await?;
        }
    }
}
