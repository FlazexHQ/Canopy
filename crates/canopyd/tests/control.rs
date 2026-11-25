//! `CANOPY_ROLE=control` against a MongoDB replica set given by `CANOPY_TEST_MONGODB_URI`: the role migrates
//! the meta database, stores a setup token, starts the webhook schedules of `CANOPY_WEBHOOKS`, and serves
//! `/admin/v1` and health checks but no data route.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::print_stderr)]

use std::io::{BufRead as _, BufReader, Read as _, Write as _};
use std::net::TcpStream;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use mongodb::bson::{DateTime, Document, doc, oid::ObjectId};

const GATEWAY: &str = env!("CARGO_BIN_EXE_canopyd");

struct Control(Child, u16);

impl Drop for Control {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn get(port: u16, path: &str, headers: &str) -> (u16, String, String) {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    write!(stream, "GET {path} HTTP/1.1\r\nhost: admin.example.test\r\n{headers}connection: close\r\n\r\n")
        .unwrap();
    let mut text = String::new();
    stream.read_to_string(&mut text).unwrap();
    let (head, body) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
    let status = head.split(' ').nth(1).and_then(|code| code.parse().ok()).unwrap_or(0);
    (status, head.to_ascii_lowercase(), body.to_owned())
}

fn listening_port(child: &mut Child) -> u16 {
    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap()).read_line(&mut line).unwrap();
    let port =
        line.split("\"port\":").nth(1).and_then(|rest| rest.trim().trim_end_matches('}').parse::<u16>().ok());
    assert!(port.is_some(), "no listening line: {line}");
    port.unwrap()
}

#[tokio::test]
async fn the_control_role_migrates_and_serves_only_the_admin_api() {
    let Ok(uri) = std::env::var("CANOPY_TEST_MONGODB_URI") else {
        eprintln!("Skipping the control role test because CANOPY_TEST_MONGODB_URI is unset");
        return;
    };
    let database = format!("canopy_control_role_{}", &ObjectId::new().to_hex()[16..]);
    let meta_name = format!("{database}_meta");
    let mut child = Command::new(GATEWAY)
        .env("CANOPY_ROLE", "control")
        .env("MONGODB_URI", &uri)
        .env("CANOPY_DB", &database)
        .env("CANOPY_META_DB", &meta_name)
        .env("HOST", "127.0.0.1")
        .env("PORT", "0")
        .env("CANOPY_MASTER_KEY", "m".repeat(48))
        .env("CANOPY_WEBHOOK_SECRET", "whsec_Zml4dHVyZSB3ZWJob29rIHNlY3JldA==")
        .env(
            "CANOPY_WEBHOOKS",
            r#"{"schedules":{"nightly":{"cron":"0 3 * * *","url":"https://hooks.example.test/n"}}}"#,
        )
        .env_remove("CANOPY_POLICY_BUNDLE")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let port = listening_port(&mut child);
    let control = Control(child, port);

    let (status, _, body) = get(control.1, "/healthz", "");
    assert_eq!((status, body.as_str()), (200, "ok"));
    let (status, head, body) = get(control.1, "/admin/v1/setup", "x-request-id: role-test\r\n");
    assert_eq!((status, body.as_str()), (200, r#"{"claimed":false}"#));
    assert!(head.contains("content-security-policy: default-src 'none'"), "{head}");
    assert!(head.contains("x-request-id: role-test"), "{head}");
    let (status, _, body) = get(control.1, "/admin/v1/webhooks", "");
    assert_eq!(status, 401, "{body}");
    assert_eq!(get(control.1, "/rest/v1/notes", "").0, 404);
    assert_eq!(get(control.1, "/realtime/v1", "").0, 404);

    let client = mongodb::Client::with_uri_str(&uri).await.unwrap();
    let meta = client.database(&meta_name);
    let applied = meta
        .collection::<Document>("migrations")
        .count_documents(doc! { "_id": { "$type": "number" }, "appliedAt": { "$exists": true } })
        .await
        .unwrap();
    assert_eq!(applied, u64::try_from(canopy_migrations::LATEST_VERSION).unwrap());
    let setup =
        meta.collection::<Document>("settings").find_one(doc! { "_id": "setup" }).await.unwrap().unwrap();
    assert_eq!(setup.get_array("tokens").map(Vec::len).ok(), Some(1));
    let schedule =
        meta.collection::<Document>("webhook_schedules").find_one(doc! { "_id": "nightly" }).await.unwrap();
    assert!(schedule.is_some_and(|schedule| schedule.get_datetime("lastAt").is_ok()));
    drop(control);
    for name in [&database, &meta_name] {
        let _ = client.database(name).drop().await;
    }
}

#[tokio::test]
async fn split_realtime_inspection_requires_the_cluster_credential() {
    let Ok(uri) = std::env::var("CANOPY_TEST_MONGODB_URI") else {
        eprintln!("Skipping the split realtime test because CANOPY_TEST_MONGODB_URI is unset");
        return;
    };
    let master = "m".repeat(48);
    let database = format!("canopy_realtime_inspection_{}", &ObjectId::new().to_hex()[16..]);
    let meta_name = format!("{database}_meta");
    let mut child = Command::new(GATEWAY)
        .args(["--config", "-"])
        .env("CANOPY_ROLE", "api")
        .env("MONGODB_URI", &uri)
        .env("CANOPY_DB", &database)
        .env("CANOPY_META_DB", &meta_name)
        .env("HOST", "127.0.0.1")
        .env("PORT", "0")
        .env("CANOPY_MASTER_KEY", &master)
        .env_remove("CANOPY_POLICY_BUNDLE")
        .env_remove("CANOPY_GATEWAY_PROXY_URL")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    writeln!(child.stdin.as_mut().unwrap(), "{{}}").unwrap();
    let port = listening_port(&mut child);
    let gateway = Control(child, port);
    let path = "/internal/realtime?query=stats";
    assert_eq!(get(gateway.1, path, "").0, 404);
    let wrong = format!("authorization: Bearer {}\r\n", "0".repeat(64));
    assert_eq!(get(gateway.1, path, &wrong).0, 404);
    let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, master.as_bytes());
    let proof = canopy_protocol::hex(ring::hmac::sign(&key, b"canopy realtime inspection v1").as_ref());
    let credential = format!("authorization: Bearer {proof}\r\n");
    let (status, _, body) = get(gateway.1, path, &credential);
    assert_eq!(status, 200, "{body}");
    let stats: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(stats.get("connections").and_then(serde_json::Value::as_u64), Some(0));
    assert_eq!(stats.get("history").and_then(serde_json::Value::as_array).map(Vec::len), Some(1));
    assert_eq!(get(gateway.1, "/internal/realtime?query=trace&id=missing", &credential).0, 204);
    assert_eq!(get(gateway.1, "/healthz", "").0, 200);
    let client = mongodb::Client::with_uri_str(&uri).await.unwrap();
    let meta = client.database(&meta_name);
    let now = DateTime::now();
    let session = "canopy_admin_realtime_fixture";
    let digest = ring::digest::digest(&ring::digest::SHA256, session.as_bytes());
    meta.collection::<Document>("admin_users")
        .insert_one(doc! { "_id": "owner", "email": "owner@example.test", "role": "owner", "createdAt": now })
        .await
        .unwrap();
    meta.collection::<Document>("admin_sessions")
        .insert_one(doc! {
            "_id": canopy_protocol::hex(digest.as_ref()), "userId": "owner", "transport": "bearer",
            "lastSeenAt": now, "expiresAt": DateTime::from_millis(now.timestamp_millis() + 60_000)
        })
        .await
        .unwrap();

    let mut child = Command::new(GATEWAY)
        .env("CANOPY_ROLE", "control")
        .env("MONGODB_URI", &uri)
        .env("CANOPY_DB", &database)
        .env("CANOPY_META_DB", &meta_name)
        .env("HOST", "127.0.0.1")
        .env("PORT", "0")
        .env("CANOPY_MASTER_KEY", &master)
        .env("CANOPY_REALTIME_INTERNAL_URL", format!("http://127.0.0.1:{}", gateway.1))
        .env_remove("CANOPY_POLICY_BUNDLE")
        .env_remove("CANOPY_WEBHOOKS")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    let port = listening_port(&mut child);
    let control = Control(child, port);
    let auth = format!("authorization: Bearer {session}\r\n");
    let (status, _, body) = get(control.1, "/admin/v1/realtime/stats", &auth);
    assert_eq!(status, 200, "{body}");
    let remote: serde_json::Value = serde_json::from_str(&body).unwrap();
    for field in ["connections", "sessions", "observers", "policyVersion", "collections"] {
        assert_eq!(remote.get(field), stats.get(field), "{field}");
    }
    assert_eq!(get(control.1, "/admin/v1/realtime/trace/missing", &auth).0, 404);
    drop(control);
    assert_eq!(get(gateway.1, "/healthz", "").0, 200);
    assert_eq!(get(gateway.1, path, &credential).0, 200);
    drop(gateway);

    let mut child = Command::new(GATEWAY)
        .args(["--config", "-"])
        .env("CANOPY_ROLE", "all")
        .env("MONGODB_URI", &uri)
        .env("CANOPY_DB", &database)
        .env("CANOPY_META_DB", &meta_name)
        .env("HOST", "127.0.0.1")
        .env("PORT", "0")
        .env("CANOPY_MASTER_KEY", &master)
        .env_remove("CANOPY_ADMIN_LISTEN")
        .env_remove("CANOPY_POLICY_BUNDLE")
        .env_remove("CANOPY_WEBHOOKS")
        .env_remove("CANOPY_REALTIME_INTERNAL_URL")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    writeln!(child.stdin.as_mut().unwrap(), "{{}}").unwrap();
    let port = listening_port(&mut child);
    let all = Control(child, port);
    let (status, _, body) = get(all.1, "/admin/v1/realtime/stats", &auth);
    assert_eq!(status, 200, "{body}");
    assert_eq!(get(all.1, "/admin/v1/realtime/trace/missing", &auth).0, 404);
    drop(all);

    for name in [&database, &meta_name] {
        let _ = client.database(name).drop().await;
    }
}
