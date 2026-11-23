use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::{Signer, SigningKey};
use mongodb::bson::{Document, doc};
use mongodb::{Client, IndexModel};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::Res;

pub const ISSUER: &str = "https://issuer.bench/";
pub const AUDIENCE: &str = "https://api.bench";

/// The shape of the TypeScript fan out benchmark: `_id` is the position, owner `u<k>` holds every document
/// whose position is `k` modulo the owner count, and the first `hot` documents are hot.
#[derive(Clone, Copy)]
pub struct Shape {
    pub docs: u32,
    pub owners: u32,
    pub hot: u32,
}

/// Seeds the `items` collection unless it already holds the expected documents.
pub async fn seed(client: &Client, database: &str, shape: Shape) -> Res<()> {
    let items = client.database(database).collection::<Document>("items");
    if items.estimated_document_count().await? == u64::from(shape.docs) {
        items.update_many(doc! {}, doc! { "$set": { "ts": 0, "n": 0 } }).await?;
        return Ok(());
    }
    items.drop().await?;
    let started = std::time::Instant::now();
    let mut from = 0u32;
    while from < shape.docs {
        let to = shape.docs.min(from + 10_000);
        let batch: Vec<Document> = (from..to)
            .map(|i| {
                doc! {
                    "_id": i64::from(i) as i32,
                    "ownerId": format!("u{}", i % shape.owners),
                    "hot": i < shape.hot,
                    "status": if i % 3 == 0 { "open" } else { "done" },
                    "score": ((u64::from(i) * 7919) % 10_007) as i32,
                    "title": format!("Item {i} with a modest amount of text in it"),
                    "ts": 0,
                    "n": 0,
                }
            })
            .collect();
        items.insert_many(batch).ordered(false).await?;
        from = to;
    }
    items
        .create_indexes([
            IndexModel::builder().keys(doc! { "ownerId": 1 }).build(),
            IndexModel::builder().keys(doc! { "hot": 1 }).build(),
        ])
        .await?;
    eprintln!("seeded {} documents in {:.1} s", shape.docs, started.elapsed().as_secs_f64());
    Ok(())
}

/// Signs `EdDSA` tokens the TypeScript sidecar accepts through the JWKS this module serves.
pub struct Keys {
    key: SigningKey,
}

impl Keys {
    pub fn new() -> Keys {
        Keys { key: SigningKey::from_bytes(&[42u8; 32]) }
    }

    pub fn jwks(&self) -> String {
        let x = URL_SAFE_NO_PAD.encode(self.key.verifying_key().to_bytes());
        format!(r#"{{"keys":[{{"kty":"OKP","crv":"Ed25519","x":"{x}","kid":"k1","alg":"EdDSA","use":"sig"}}]}}"#)
    }

    pub fn token(&self, sub: &str, roles: &[&str]) -> String {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
        let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"EdDSA","kid":"k1","typ":"JWT"}"#);
        let roles = roles.iter().map(|role| format!("\"{role}\"")).collect::<Vec<_>>().join(",");
        let payload = format!(
            r#"{{"sub":"{sub}","roles":[{roles}],"iss":"{ISSUER}","aud":"{AUDIENCE}","iat":{now},"exp":{}}}"#,
            now + 4 * 3600
        );
        let signing_input = format!("{header}.{}", URL_SAFE_NO_PAD.encode(payload));
        let signature = URL_SAFE_NO_PAD.encode(self.key.sign(signing_input.as_bytes()).to_bytes());
        format!("{signing_input}.{signature}")
    }
}

/// Serves the JWKS on a loopback port and returns its URL.
pub async fn serve_jwks(jwks: String) -> Res<String> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://127.0.0.1:{}/jwks.json", listener.local_addr()?.port());
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let body = jwks.clone();
            tokio::spawn(async move {
                let mut buffer = [0u8; 2048];
                let _ = socket.read(&mut buffer).await;
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(response.as_bytes()).await;
                let _ = socket.shutdown().await;
            });
        }
    });
    Ok(url)
}
