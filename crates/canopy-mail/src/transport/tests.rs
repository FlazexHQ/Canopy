use std::io;

use time::macros::datetime;
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream},
};

use super::*;

const FROM: &str = "Canopy <auth@example.com>";
const TO: &str = "ada@example.com";
const NOW: OffsetDateTime = datetime!(2024-01-02 03:04:05 UTC);
const SES_PATH: &str = "/v2/email/outbound-emails";
const SES_BODY: &str = r#"{"FromEmailAddress":"Canopy <auth@example.com>","Destination":{"ToAddresses":["ada@example.com"]},"Content":{"Simple":{"Subject":{"Data":"Hello","Charset":"UTF-8"},"Body":{"Text":{"Data":"Plain text","Charset":"UTF-8"},"Html":{"Data":"<p>Hello</p>","Charset":"UTF-8"}}}}}"#;

fn fixture() -> Template {
    Template { subject: "Hello".into(), text: "Plain text".into(), html: Some("<p>Hello</p>".into()) }
}

fn ses() -> TransportSettings {
    TransportSettings::Ses {
        region: "us-east-1".into(),
        access_key_id: "test-key".into(),
        secret_access_key: "test-secret".into(),
        session_token: Some("test-token".into()),
    }
}

#[test]
fn ses_signature_matches_typescript() -> Result<(), Box<dyn std::error::Error>> {
    let url = Url::parse("https://email.us-east-1.amazonaws.com/v2/email/outbound-emails")?;
    let (_, headers, body) = request(&ses(), &url, FROM, TO, fixture(), NOW)?;
    assert_eq!(body, SES_BODY);
    assert_eq!(
        headers.get("authorization").map(String::as_str),
        Some(
            "AWS4-HMAC-SHA256 Credential=test-key/20240102/us-east-1/ses/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token, Signature=1dad69bc72a0c4bcaf84911fdbfd4db216f00ff4d52d2dfbf21d06796cfd7fd3"
        )
    );
    Ok(())
}

async fn line(stream: &mut BufReader<TcpStream>) -> io::Result<String> {
    let mut line = String::new();
    if stream.read_line(&mut line).await? == 0 {
        return Err(io::ErrorKind::UnexpectedEof.into());
    }
    Ok(line)
}

async fn write(stream: &mut BufReader<TcpStream>, bytes: &[u8]) -> io::Result<()> {
    stream.get_mut().write_all(bytes).await
}

async fn receive_http(
    listener: TcpListener,
    path: &str,
    status: u16,
) -> io::Result<(BTreeMap<String, String>, String)> {
    let mut stream = BufReader::new(listener.accept().await?.0);
    assert_eq!(line(&mut stream).await?, format!("POST {path} HTTP/1.1\r\n"));
    let mut headers = BTreeMap::new();
    loop {
        let header = line(&mut stream).await?;
        if header == "\r\n" {
            break;
        }
        let (name, value) = header.split_once(':').ok_or(io::ErrorKind::InvalidData)?;
        headers.insert(name.to_ascii_lowercase(), value.trim().to_owned());
    }
    let length = headers
        .get("content-length")
        .and_then(|value| value.parse().ok())
        .ok_or(io::ErrorKind::InvalidData)?;
    let mut body = vec![0; length];
    stream.read_exact(&mut body).await?;
    write(
        &mut stream,
        format!("HTTP/1.1 {status} Test\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes(),
    )
    .await?;
    let body = String::from_utf8(body).map_err(io::Error::other)?;
    Ok((headers, body))
}

#[tokio::test]
async fn http_delivers_each_provider_request() -> Result<(), Box<dyn std::error::Error>> {
    let cases = [
        (
            TransportSettings::Resend { api_key: "resend-key".into() },
            "/emails",
            202,
            r#"{"from":"Canopy <auth@example.com>","to":["ada@example.com"],"subject":"Hello","text":"Plain text","html":"<p>Hello</p>"}"#,
            vec![("authorization", "Bearer resend-key")],
        ),
        (
            TransportSettings::Postmark { server_token: "postmark-key".into(), message_stream: None },
            "/email",
            429,
            r#"{"From":"Canopy <auth@example.com>","To":"ada@example.com","Subject":"Hello","TextBody":"Plain text","HtmlBody":"<p>Hello</p>","MessageStream":"outbound"}"#,
            vec![("x-postmark-server-token", "postmark-key"), ("accept", "application/json")],
        ),
        (
            ses(),
            SES_PATH,
            202,
            SES_BODY,
            vec![("x-amz-date", "20240102T030405Z"), ("x-amz-security-token", "test-token")],
        ),
    ];
    for (settings, path, status, expected, expected_headers) in cases {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let endpoint = format!("http://{}{path}", listener.local_addr()?);
        let ses_authorization = if path == SES_PATH {
            let (_, headers, _) = request(&settings, &Url::parse(&endpoint)?, FROM, TO, fixture(), NOW)?;
            headers.get("authorization").cloned()
        } else {
            None
        };
        let transport = Transport::http(settings, &endpoint)?;
        let server = tokio::spawn(receive_http(listener, path, status));
        let result = transport.send(FROM, TO, fixture(), NOW).await;
        if status == 429 {
            assert_eq!(result.err().map(|error| error.code()), Some(ErrorCode::Unavailable));
        } else {
            result?;
        }
        let (headers, body) = tokio::time::timeout(TIMEOUT, server).await???;
        assert_eq!(body, expected);
        assert_eq!(headers.get("content-type").map(String::as_str), Some("application/json"));
        for (name, value) in expected_headers {
            assert_eq!(headers.get(name).map(String::as_str), Some(value));
        }
        if let Some(authorization) = ses_authorization {
            assert_eq!(headers.get("authorization"), Some(&authorization));
            assert!(!headers.contains_key("x-amz-content-sha256"));
        }
    }
    Ok(())
}

async fn receive_smtp(listener: TcpListener) -> io::Result<String> {
    let mut stream = BufReader::new(listener.accept().await?.0);
    write(&mut stream, b"220 relay.example.com\r\n").await?;
    for (command, reply) in [
        ("EHLO canopy\r\n", "250 relay.example.com\r\n"),
        ("MAIL FROM:<auth@example.com>\r\n", "250 OK\r\n"),
        ("RCPT TO:<ada@example.com>\r\n", "250 OK\r\n"),
        ("DATA\r\n", "354 Send data\r\n"),
    ] {
        assert_eq!(line(&mut stream).await?, command);
        write(&mut stream, reply.as_bytes()).await?;
    }
    let mut message = String::new();
    loop {
        let next = line(&mut stream).await?;
        if next == ".\r\n" {
            break;
        }
        message.push_str(&next);
    }
    write(&mut stream, b"250 OK\r\n").await?;
    assert_eq!(line(&mut stream).await?, "QUIT\r\n");
    write(&mut stream, b"221 Bye\r\n").await?;
    Ok(message)
}

#[tokio::test]
async fn smtp_delivers_multipart_message() -> Result<(), Box<dyn std::error::Error>> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    let transport = Transport::new(TransportSettings::Smtp(SmtpSettings {
        host: "127.0.0.1".into(),
        port: Some(port),
        secure: false,
        require_tls: false,
        user: None,
        pass: None,
    }))?;
    let server = tokio::spawn(receive_smtp(listener));
    transport.send(FROM, TO, fixture(), NOW).await?;
    let message = server.await??;
    for part in [
        "From: Canopy <auth@example.com>",
        "To: ada@example.com",
        "Subject: Hello",
        "multipart/alternative",
        "Content-Transfer-Encoding: base64",
        "text/plain",
        "UGxhaW4gdGV4dA==",
        "text/html",
        "PHA+SGVsbG88L3A+",
    ] {
        assert!(message.contains(part), "{part:?} missing in {message}");
    }
    Ok(())
}

#[test]
fn smtp_rejects_header_injection() {
    let mut message = fixture();
    message.subject = "Hello\r\nBcc: other@example.com".into();
    assert_eq!(mime(FROM, TO, message).err().map(|error| error.code()), Some(ErrorCode::ValidationFailed));
}

#[tokio::test]
async fn test_send_renders_draft_and_delivers_via_smtp() -> Result<(), Box<dyn std::error::Error>> {
    use canopy_mongo::mongodb::{Client, bson::oid::ObjectId};

    let Ok(uri) = std::env::var("CANOPY_TEST_MONGODB_URI") else {
        return Ok(());
    };
    let client = Client::with_uri_str(uri).await?;
    let meta = client.database(&format!("canopy_test_send_{}", ObjectId::new().to_hex()));
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    let mailer = crate::Mailer::open(
        meta,
        "Example".into(),
        Some(crate::MailSettings {
            from: FROM.into(),
            transport: TransportSettings::Smtp(SmtpSettings {
                host: "127.0.0.1".into(),
                port: Some(port),
                secure: false,
                require_tls: false,
                user: None,
                pass: None,
            }),
        }),
    )
    .await?;
    let mut draft = Template { subject: "{{appName}} preview".into(), text: "No code".into(), html: None };
    let error = mailer
        .send_test(crate::EmailKind::Otp, TO, Some(&draft))
        .await
        .err()
        .ok_or("Expected the draft without an OTP marker to fail")?;
    assert_eq!(error.code(), ErrorCode::ValidationFailed);
    draft.text = "Code: {{otp}}".into();
    let server = tokio::spawn(receive_smtp(listener));
    mailer.send_test(crate::EmailKind::Otp, TO, Some(&draft)).await?;
    let message = tokio::time::timeout(TIMEOUT, server).await???;
    assert!(message.contains("Subject: Example preview"));
    assert!(message.contains("Q29kZTogNDgyOTEz"));
    Ok(())
}

#[test]
fn resolved_smtp_config_defaults_to_tls() -> Result<(), Box<dyn std::error::Error>> {
    let settings: crate::MailSettings = serde_json::from_str(
        r#"{
        "from":"Canopy <auth@example.com>",
        "transport":{"kind":"smtp","host":"relay.example.com","user":"canopy"}
    }"#,
    )?;
    assert_eq!(settings.from, FROM);
    assert!(matches!(
        settings.transport,
        TransportSettings::Smtp(SmtpSettings {
            secure: false,
            require_tls: true,
            port: None,
            user: Some(_),
            ..
        })
    ));
    Ok(())
}
