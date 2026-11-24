//! Signature vectors and HTTP behavior of the S3 storage backend.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::collections::BTreeMap;
use std::time::Duration;

use canopy_protocol::{CanopyError, ErrorCode};
use canopy_storage::backend::{ByteRange, StorageBackend, UploadedPart};
use canopy_storage::s3::{R2Options, S3Backend, S3Credentials, S3Options, SignInput, sign_request};
use futures_util::TryStreamExt;
use reqwest::Url;
use time::macros::datetime;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;

const KEY: &str = "a b/雪!'()*?#%";
const PATH: &str = "/base/bucket/prefix/a%20b/%E9%9B%AA%21%27%28%29%2A%3F%23%25";
const EMPTY: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const ABC: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

fn credentials() -> S3Credentials {
    S3Credentials {
        access_key_id: "AKIDEXAMPLE".into(),
        secret_access_key: "example-secret".into(),
        session_token: None,
    }
}

fn options(endpoint: Option<String>) -> S3Options {
    S3Options {
        endpoint,
        region: "us-west-2".into(),
        bucket: "bucket".into(),
        credentials: credentials(),
        force_path_style: None,
        prefix: "prefix/".into(),
        kind: None,
    }
}

fn sign(
    method: &str,
    url: &str,
    headers: BTreeMap<String, String>,
    payload_hash: &str,
    credentials: &S3Credentials,
) -> canopy_storage::s3::SignedRequest {
    sign_request(SignInput {
        method,
        url: &Url::parse(url).unwrap(),
        headers,
        payload_hash,
        region: "us-west-2",
        service: "s3",
        credentials,
        now: datetime!(2026-11-24 01:02:03.456 UTC),
    })
    .unwrap()
}

#[test]
fn signs_encoded_range_with_temporary_credentials() {
    let mut credentials = credentials();
    credentials.session_token = Some("test-token".into());
    let signed = sign(
        "GET",
        &format!("https://example.com:9443{PATH}"),
        BTreeMap::from([
            ("range".into(), "bytes=1-3".into()),
            ("x-note".into(), "  one\t\u{a0}two  ".into()),
        ]),
        "UNSIGNED-PAYLOAD",
        &credentials,
    );
    assert_eq!(
        signed.canonical_request,
        concat!(
            "GET\n/base/bucket/prefix/a%20b/%E9%9B%AA%21%27%28%29%2A%3F%23%25\n\n",
            "host:example.com:9443\nrange:bytes=1-3\nx-amz-content-sha256:UNSIGNED-PAYLOAD\n",
            "x-amz-date:20261124T010203Z\nx-amz-security-token:test-token\nx-note:one two\n\n",
            "host;range;x-amz-content-sha256;x-amz-date;x-amz-security-token;x-note\nUNSIGNED-PAYLOAD"
        )
    );
    assert_eq!(
        signed.string_to_sign,
        concat!(
            "AWS4-HMAC-SHA256\n20261124T010203Z\n20261124/us-west-2/s3/aws4_request\n",
            "3aaeb885a4617eec5a2df48c2855755768a51f76c124af6496e5aca896389fb1"
        )
    );
    assert_eq!(
        signed.headers["authorization"],
        concat!(
            "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261124/us-west-2/s3/aws4_request, ",
            "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date;x-amz-security-token;x-note, ",
            "Signature=2e6f39327213747a6743c6227b84f4c980b9ab77dcb04d4bb336740826b2eaed"
        )
    );
}

#[test]
fn signs_multipart_query_and_payload() {
    let signed = sign(
        "PUT",
        "https://bucket.s3.us-west-2.amazonaws.com/key?uploadId=z%2B%2F%3D+%E9%9B%AA&partNumber=2&uploads=&dup=~&dup=%21",
        BTreeMap::new(),
        ABC,
        &credentials(),
    );
    assert_eq!(
        signed.canonical_request,
        format!(
            concat!(
                "PUT\n/key\ndup=%21&dup=~&partNumber=2&uploadId=z%2B%2F%3D%20%E9%9B%AA&uploads=\n",
                "host:bucket.s3.us-west-2.amazonaws.com\nx-amz-content-sha256:{}\n",
                "x-amz-date:20261124T010203Z\n\nhost;x-amz-content-sha256;x-amz-date\n{}"
            ),
            ABC, ABC
        )
    );
    assert_eq!(
        signed.string_to_sign,
        concat!(
            "AWS4-HMAC-SHA256\n20261124T010203Z\n20261124/us-west-2/s3/aws4_request\n",
            "6fe9ee410409199e9bebfdfd8e72922ecf98cb26374bdbdf665a7fc6906e3890"
        )
    );
    assert_eq!(
        signed.headers["authorization"],
        concat!(
            "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261124/us-west-2/s3/aws4_request, ",
            "SignedHeaders=host;x-amz-content-sha256;x-amz-date, ",
            "Signature=15fd5d323720d035046f06c1fc7831602f7989370a144be3df72f330926a3504"
        )
    );
}

#[test]
fn addresses_aws_custom_endpoints_and_r2() {
    let aws = S3Backend::new(options(None)).unwrap();
    assert_eq!(aws.kind(), "s3");
    assert_eq!(
        aws.object_url("a", &[]).unwrap().as_str(),
        "https://bucket.s3.us-west-2.amazonaws.com/prefix/a"
    );
    let mut custom = options(Some("https://minio.example:9443/base/".into()));
    custom.force_path_style = Some(false);
    custom.kind = Some("custom".into());
    let custom = S3Backend::new(custom).unwrap();
    assert_eq!(custom.kind(), "custom");
    assert_eq!(custom.object_url("a", &[]).unwrap().as_str(), "https://bucket.minio.example:9443/prefix/a");

    let r2_options = |account_id: &str, jurisdiction: &str| R2Options {
        account_id: account_id.into(),
        jurisdiction: Some(jurisdiction.into()),
        bucket: "bucket".into(),
        access_key_id: "id".into(),
        secret_access_key: "secret".into(),
        prefix: "prefix/".into(),
    };
    let account = "0123456789abcdef0123456789abcdef";
    assert_eq!(
        S3Backend::r2(r2_options(account, "EU")).err().unwrap().message(),
        "An R2 jurisdiction is a lower case word such as eu"
    );
    assert_eq!(
        S3Backend::r2(r2_options("invalid", "eu")).err().unwrap().message(),
        "An R2 account id is 32 hexadecimal characters"
    );
    let r2 = S3Backend::r2(r2_options(account, "eu")).unwrap();
    assert_eq!(r2.kind(), "r2");
    assert_eq!(
        r2.object_url("a", &[]).unwrap().as_str(),
        "https://0123456789abcdef0123456789abcdef.eu.r2.cloudflarestorage.com/bucket/prefix/a"
    );
}

struct Captured {
    line: String,
    headers: BTreeMap<String, String>,
    body: Vec<u8>,
}

async fn capture(socket: &mut TcpStream) -> Captured {
    let mut bytes = Vec::new();
    let end = loop {
        if let Some(end) = bytes.windows(4).position(|chunk| chunk == b"\r\n\r\n") {
            break end;
        }
        let mut buffer = [0; 1024];
        let read = socket.read(&mut buffer).await.unwrap();
        assert_ne!(read, 0, "connection closed before request headers");
        bytes.extend_from_slice(&buffer[..read]);
    };
    let mut lines = std::str::from_utf8(&bytes[..end]).unwrap().split("\r\n");
    let line = lines.next().unwrap().to_owned();
    let headers: BTreeMap<_, _> = lines
        .map(|line| {
            let (name, value) = line.split_once(':').unwrap();
            (name.to_ascii_lowercase(), value.trim().to_owned())
        })
        .collect();
    let length = headers.get("content-length").map_or(0, |value| value.parse().unwrap());
    let mut body = bytes.split_off(end + 4);
    assert!(body.len() <= length);
    let buffered = body.len();
    body.resize(length, 0);
    socket.read_exact(&mut body[buffered..]).await.unwrap();
    Captured { line, headers, body }
}

struct Reply(u16, &'static str, &'static str);

async fn fake(replies: Vec<Reply>) -> (S3Backend, JoinHandle<Vec<Captured>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/base/", listener.local_addr().unwrap());
    let backend = S3Backend::new(options(Some(endpoint))).unwrap();
    let server = tokio::spawn(async move {
        let mut requests = Vec::new();
        for Reply(status, headers, body) in replies {
            let (mut socket, _) = listener.accept().await.unwrap();
            requests.push(capture(&mut socket).await);
            socket.write_all(format!(
                "HTTP/1.1 {status} Fake\r\nConnection: close\r\nContent-Length: {}\r\n{headers}\r\n{body}", body.len()
            ).as_bytes()).await.unwrap();
        }
        requests
    });
    (backend, server)
}

#[tokio::test]
async fn sends_every_operation_with_expected_target_headers_and_body() {
    let (backend, server) = fake(vec![
        Reply(200, "", ""),
        Reply(200, "", "abcd"),
        Reply(206, "Content-Range: bytes 1-2/4\r\n", "bc"),
        Reply(204, "", ""),
        Reply(404, "", "<Error><Code>NoSuchKey</Code></Error>"),
        Reply(
            200,
            "",
            "<InitiateMultipartUploadResult><UploadId>z+/= 雪</UploadId></InitiateMultipartUploadResult>",
        ),
        Reply(200, "ETag: \"tag\"\r\n", ""),
        Reply(200, "", "<CompleteMultipartUploadResult/>"),
        Reply(404, "", "<Error><Code>NoSuchUpload</Code></Error>"),
    ])
    .await;

    backend.put(KEY, b"abc".to_vec(), "text/plain").await.unwrap();
    let full: Vec<u8> = backend.get(KEY, None).await.unwrap().try_concat().await.unwrap();
    assert_eq!(full, b"abcd");
    let range: Vec<u8> =
        backend.get(KEY, Some(ByteRange { start: 1, end: 2 })).await.unwrap().try_concat().await.unwrap();
    assert_eq!(range, b"bc");
    backend.delete(KEY).await.unwrap();
    backend.delete(KEY).await.unwrap();
    let upload = backend.create_multipart(KEY, "text/plain").await.unwrap();
    assert_eq!(upload, "z+/= 雪");
    let etag = backend.put_part(KEY, &upload, 2, b"abc".to_vec()).await.unwrap();
    assert_eq!(etag, "\"tag\"");
    backend
        .complete_multipart(
            KEY,
            &upload,
            &[UploadedPart { part: 2, etag }, UploadedPart { part: 1, etag: "a&<>\"'".into() }],
        )
        .await
        .unwrap();
    backend.abort_multipart(KEY, &upload).await.unwrap();
    assert_eq!(backend.sweep(0).await.unwrap(), 0);

    let requests = server.await.unwrap();
    let targets = [
        ("PUT", ""),
        ("GET", ""),
        ("GET", ""),
        ("DELETE", ""),
        ("DELETE", ""),
        ("POST", "?uploads="),
        ("PUT", "?partNumber=2&uploadId=z%2B%2F%3D+%E9%9B%AA"),
        ("POST", "?uploadId=z%2B%2F%3D+%E9%9B%AA"),
        ("DELETE", "?uploadId=z%2B%2F%3D+%E9%9B%AA"),
    ];
    assert_eq!(requests.len(), targets.len());
    for (index, (request, (method, query))) in requests.iter().zip(targets).enumerate() {
        assert_eq!(request.line, format!("{method} {PATH}{query} HTTP/1.1"));
        let hash = &request.headers["x-amz-content-sha256"];
        assert!(request.headers["authorization"].starts_with("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/"));
        if index == 0 || index == 6 {
            assert_eq!(hash, ABC);
            assert_eq!(request.body, b"abc");
        } else if index != 7 {
            assert_eq!(hash, EMPTY);
            assert!(request.body.is_empty());
        }
    }
    assert_eq!(requests[0].headers["content-type"], "text/plain");
    assert!(!requests[1].headers.contains_key("range"));
    assert_eq!(requests[2].headers["range"], "bytes=1-2");
    assert!(requests[2].headers["authorization"].contains("SignedHeaders=host;range;"));
    assert_eq!(requests[5].headers["content-type"], "text/plain");
    assert_eq!(requests[7].headers["content-type"], "application/xml");
    assert_eq!(
        requests[7].headers["x-amz-content-sha256"],
        "9ddfab7192d62232c2ef205e688a50eec0986ab9a1cc799726d01f504a4ef4dd"
    );
    assert_eq!(
        requests[7].body,
        concat!(
            "<CompleteMultipartUpload><Part><PartNumber>1</PartNumber>",
            "<ETag>a&amp;&lt;&gt;&quot;'</ETag></Part><Part><PartNumber>2</PartNumber>",
            "<ETag>&quot;tag&quot;</ETag></Part></CompleteMultipartUpload>"
        )
        .as_bytes()
    );
}

fn assert_error(error: CanopyError, code: ErrorCode, message: &str) {
    assert_eq!(error.code(), code);
    assert_eq!(error.message(), message);
}

#[tokio::test]
async fn maps_store_status_transport_and_multipart_errors() {
    let (backend, server) = fake(vec![
        Reply(404, "", "<Error><Code>NoSuchKey</Code></Error>"),
        Reply(404, "", "<Error><Code>NoSuchBucket</Code></Error>"),
        Reply(416, "", "<Error><Code>InvalidRange</Code></Error>"),
        Reply(307, "Location: /redirected\r\n", ""),
        Reply(503, "", "<Error><Code><nested/></Code><Code>SlowDown</Code></Error>"),
        Reply(200, "", "<InitiateMultipartUploadResult/>"),
        Reply(200, "", ""),
        Reply(200, "", "<Error><Code>InvalidPart</Code></Error>"),
        Reply(200, "", "<Error></Error>"),
    ])
    .await;
    assert_error(
        backend.get(KEY, None).await.err().unwrap(),
        ErrorCode::NotFound,
        "The file content is missing",
    );
    assert_error(
        backend.put(KEY, vec![], "text/plain").await.unwrap_err(),
        ErrorCode::Unavailable,
        "The object store answered 404 (NoSuchBucket)",
    );
    assert_error(
        backend.get(KEY, Some(ByteRange { start: 99, end: 100 })).await.err().unwrap(),
        ErrorCode::Unavailable,
        "The object store answered 416 (InvalidRange)",
    );
    assert_error(
        backend.delete(KEY).await.unwrap_err(),
        ErrorCode::Unavailable,
        "The object store answered 307",
    );
    assert_error(
        backend.delete(KEY).await.unwrap_err(),
        ErrorCode::Unavailable,
        "The object store answered 503 (SlowDown)",
    );
    assert_error(
        backend.create_multipart(KEY, "text/plain").await.unwrap_err(),
        ErrorCode::Unavailable,
        "The object store did not start the upload",
    );
    assert_error(
        backend.put_part(KEY, "id", 1, vec![]).await.unwrap_err(),
        ErrorCode::Unavailable,
        "The object store did not return an ETag",
    );
    assert_error(
        backend.complete_multipart(KEY, "id", &[]).await.unwrap_err(),
        ErrorCode::Unavailable,
        "The object store could not join the parts (InvalidPart)",
    );
    assert_error(
        backend.complete_multipart(KEY, "id", &[]).await.unwrap_err(),
        ErrorCode::Unavailable,
        "The object store could not join the parts (unknown)",
    );
    assert_eq!(server.await.unwrap().len(), 9);
    assert_error(
        backend.get(KEY, None).await.err().unwrap(),
        ErrorCode::Unavailable,
        "The object store is unreachable",
    );
}

#[tokio::test]
async fn returns_first_download_chunk_before_the_response_finishes() {
    use futures_util::StreamExt;
    use tokio::sync::oneshot;

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let backend =
        S3Backend::new(options(Some(format!("http://{}", listener.local_addr().unwrap())))).unwrap();
    let (send_rest, wait_for_first) = oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let request = capture(&mut socket).await;
        assert_eq!(request.headers["range"], "bytes=1-4");
        socket
            .write_all(b"HTTP/1.1 206 Partial Content\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nbc\r\n")
            .await
            .unwrap();
        wait_for_first.await.unwrap();
        socket.write_all(b"2\r\nde\r\n0\r\n\r\n").await.unwrap();
    });
    tokio::time::timeout(Duration::from_secs(5), async {
        let mut stream = backend.get("key", Some(ByteRange { start: 1, end: 4 })).await.unwrap();
        assert_eq!(stream.next().await.unwrap().unwrap(), b"bc");
        send_rest.send(()).unwrap();
        assert_eq!(stream.try_concat().await.unwrap(), b"de");
    })
    .await
    .unwrap();
    server.await.unwrap();
}

#[tokio::test]
async fn minio_round_trip_when_reachable() {
    let Ok(endpoint) = std::env::var("CANOPY_TEST_S3_URL") else {
        return;
    };
    let url = Url::parse(&endpoint).unwrap();
    let address = (url.host_str().unwrap(), url.port_or_known_default().unwrap());
    if !matches!(tokio::time::timeout(Duration::from_secs(2), TcpStream::connect(address)).await, Ok(Ok(_))) {
        return;
    }
    let env = |name, default: &str| std::env::var(name).unwrap_or_else(|_| default.into());
    let mut config = options(Some(endpoint));
    config.region = env("CANOPY_TEST_S3_REGION", "us-east-1");
    config.bucket = env("CANOPY_TEST_S3_BUCKET", "canopy");
    config.credentials.access_key_id = env("CANOPY_TEST_S3_ACCESS_KEY_ID", "minioadmin");
    config.credentials.secret_access_key = env("CANOPY_TEST_S3_SECRET_ACCESS_KEY", "minioadmin");
    let backend = S3Backend::new(config).unwrap();
    let key = format!("probe/{}", uuid::Uuid::new_v4());
    backend.put(&key, b"abcd".to_vec(), "text/plain").await.unwrap();
    let result =
        async { backend.get(&key, Some(ByteRange { start: 1, end: 2 })).await?.try_concat().await }.await;
    backend.delete(&key).await.unwrap();
    assert_eq!(result.unwrap(), b"bc");
    assert_error(
        backend.get(&key, None).await.err().unwrap(),
        ErrorCode::NotFound,
        "The file content is missing",
    );
}
