//! S3 compatible object storage through the Signature Version 4 REST API.

use std::collections::BTreeMap;
use std::fmt::Write;

use canopy_protocol::{CanopyError, ErrorCode};
use futures_util::stream;
use reqwest::{Client, Method, Response, Url};
use ring::{digest, hmac};
use time::{OffsetDateTime, macros::format_description};

use crate::backend::{BoxFuture, ByteRange, ByteStream, StorageBackend, UploadedPart};

/// AWS credentials, including the token when using temporary credentials.
pub struct S3Credentials {
    /// The access key ID.
    pub access_key_id: String,
    /// The secret access key.
    pub secret_access_key: String,
    /// The optional session token.
    pub session_token: Option<String>,
}

/// Configuration for AWS S3 or an S3 compatible endpoint.
pub struct S3Options {
    /// Custom endpoint, defaulting to the regional AWS endpoint.
    pub endpoint: Option<String>,
    /// Region used to sign requests.
    pub region: String,
    /// Bucket that stores the objects.
    pub bucket: String,
    /// Credentials used to sign requests.
    pub credentials: S3Credentials,
    /// Use path addressing. Defaults to true for custom endpoints.
    pub force_path_style: Option<bool>,
    /// Prefix prepended verbatim to every object key.
    pub prefix: String,
    /// Backend name, defaulting to `s3`.
    pub kind: Option<String>,
}

/// Configuration for a Cloudflare R2 bucket.
pub struct R2Options {
    /// The 32 digit hexadecimal Cloudflare account ID.
    pub account_id: String,
    /// The optional bucket jurisdiction.
    pub jurisdiction: Option<String>,
    /// Bucket that stores the objects.
    pub bucket: String,
    /// Access key ID of an R2 API token.
    pub access_key_id: String,
    /// Secret access key of an R2 API token.
    pub secret_access_key: String,
    /// Prefix prepended verbatim to every object key.
    pub prefix: String,
}

/// A Signature Version 4 request with its clock supplied by the caller.
pub struct SignInput<'a> {
    /// HTTP method as sent on the wire.
    pub method: &'a str,
    /// Request URL with its path already encoded.
    pub url: &'a Url,
    /// Headers to sign, with lowercase names.
    pub headers: BTreeMap<String, String>,
    /// Hexadecimal SHA 256 digest or `UNSIGNED-PAYLOAD`.
    pub payload_hash: &'a str,
    /// Signing region.
    pub region: &'a str,
    /// Signing service.
    pub service: &'a str,
    /// Credentials used to derive the signing key.
    pub credentials: &'a S3Credentials,
    /// Request timestamp.
    pub now: OffsetDateTime,
}

/// Signed headers and the canonical inputs used to derive their signature.
pub struct SignedRequest {
    /// All headers to send, including authorization.
    pub headers: BTreeMap<String, String>,
    /// Canonical request hashed into the string to sign.
    pub canonical_request: String,
    /// String signed with the derived signing key.
    pub string_to_sign: String,
}

fn aws_encode(value: &str, keep_slash: bool) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                encoded.push(char::from(byte));
            }
            b'/' if keep_slash => encoded.push('/'),
            _ => {
                let _ = write!(encoded, "%{byte:02X}");
            }
        }
    }
    encoded
}

fn hex(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(output, "{byte:02x}");
    }
    output
}

fn sha256(bytes: &[u8]) -> String {
    hex(digest::digest(&digest::SHA256, bytes).as_ref())
}

fn mac(key: &[u8], data: &str) -> hmac::Tag {
    hmac::sign(&hmac::Key::new(hmac::HMAC_SHA256, key), data.as_bytes())
}

fn js_whitespace(c: char) -> bool {
    matches!(c, '\t'..='\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' |
        '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

/// Signs a request at the supplied UTC instant.
pub fn sign_request(input: SignInput<'_>) -> Result<SignedRequest, CanopyError> {
    let amz_date = input
        .now
        .to_utc()
        .format(format_description!("[year][month][day]T[hour][minute][second]Z"))
        .map_err(|_| CanopyError::invalid_query("Invalid object store signing timestamp"))?;
    let date = amz_date.chars().take(8).collect::<String>();
    let mut headers = input.headers;
    headers.insert("host".into(), authority(input.url).into());
    headers.insert("x-amz-date".into(), amz_date.clone());
    headers.insert("x-amz-content-sha256".into(), input.payload_hash.into());
    if let Some(token) = &input.credentials.session_token {
        headers.insert("x-amz-security-token".into(), token.clone());
    }

    let mut names: Vec<_> = headers.keys().map(|name| name.to_ascii_lowercase()).collect();
    names.sort_unstable();
    let mut canonical_headers = String::new();
    for name in &names {
        let value = headers.get(name).map_or("", String::as_str);
        let normalized =
            value.split(js_whitespace).filter(|word| !word.is_empty()).collect::<Vec<_>>().join(" ");
        let _ = writeln!(canonical_headers, "{name}:{normalized}");
    }
    let signed_headers = names.join(";");
    let mut query: Vec<_> = input
        .url
        .query_pairs()
        .map(|(name, value)| (aws_encode(&name, false), aws_encode(&value, false)))
        .collect();
    query.sort_unstable();
    let query =
        query.into_iter().map(|(name, value)| format!("{name}={value}")).collect::<Vec<_>>().join("&");
    let canonical_request = format!(
        "{}\n{}\n{query}\n{canonical_headers}\n{signed_headers}\n{}",
        input.method,
        input.url.path(),
        input.payload_hash
    );
    let scope = format!("{date}/{}/{}/aws4_request", input.region, input.service);
    let string_to_sign =
        format!("AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}", sha256(canonical_request.as_bytes()));
    let date_key = mac(format!("AWS4{}", input.credentials.secret_access_key).as_bytes(), &date);
    let region_key = mac(date_key.as_ref(), input.region);
    let service_key = mac(region_key.as_ref(), input.service);
    let signing_key = mac(service_key.as_ref(), "aws4_request");
    let signature = hex(mac(signing_key.as_ref(), &string_to_sign).as_ref());
    headers.insert(
        "authorization".into(),
        format!(
            "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed_headers}, Signature={signature}",
            input.credentials.access_key_id
        ),
    );
    Ok(SignedRequest { headers, canonical_request, string_to_sign })
}

fn authority(url: &Url) -> &str {
    &url[url::Position::BeforeHost..url::Position::AfterPort]
}

fn unavailable(message: impl Into<String>) -> CanopyError {
    CanopyError::new(ErrorCode::Unavailable, message)
}

fn unreachable_store() -> CanopyError {
    unavailable("The object store is unreachable")
}

fn xml_value<'a>(xml: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    xml.match_indices(&open).find_map(|(index, _)| {
        let tail = &xml[index + open.len()..];
        let first_tag = tail.find('<')?;
        tail[first_tag..].starts_with(&close).then_some(&tail[..first_tag])
    })
}

fn xml_escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

async fn response_text(response: Response) -> Result<String, CanopyError> {
    let bytes = response.bytes().await.map_err(|_| unreachable_store())?;
    Ok(String::from_utf8_lossy(bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(&bytes)).into_owned())
}

/// AWS S3, MinIO and Cloudflare R2 storage using signed HTTP requests.
pub struct S3Backend {
    options: S3Options,
    endpoint: Url,
    path_style: bool,
    client: Client,
}

struct Request<'a> {
    query: &'a [(&'a str, &'a str)],
    header: Option<(&'a str, &'a str)>,
    body: Option<Vec<u8>>,
    expect: &'a [u16],
}

impl Default for Request<'_> {
    fn default() -> Self {
        Self { query: &[], header: None, body: None, expect: &[200] }
    }
}

impl S3Backend {
    /// Opens an AWS S3 or S3 compatible backend.
    pub fn new(options: S3Options) -> Result<Self, CanopyError> {
        let path_style = options.force_path_style.unwrap_or(options.endpoint.is_some());
        let endpoint = options
            .endpoint
            .clone()
            .unwrap_or_else(|| format!("https://s3.{}.amazonaws.com", options.region));
        let endpoint =
            Url::parse(&endpoint).map_err(|_| CanopyError::invalid_query("Invalid object store endpoint"))?;
        if !matches!(endpoint.scheme(), "http" | "https") {
            return Err(CanopyError::invalid_query("Invalid object store endpoint"));
        }
        let _ = rustls::crypto::ring::default_provider().install_default();
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .build()
            .map_err(|_| unreachable_store())?;
        Ok(Self { options, endpoint, path_style, client })
    }

    /// Opens Cloudflare R2 with path addressing and the `auto` signing region.
    pub fn r2(options: R2Options) -> Result<Self, CanopyError> {
        if options.account_id.len() != 32 || !options.account_id.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(CanopyError::invalid_query("An R2 account id is 32 hexadecimal characters"));
        }
        let jurisdiction = options.jurisdiction.as_deref().map_or_else(
            || Ok(String::new()),
            |value| {
                if value.is_empty() || !value.bytes().all(|b| b.is_ascii_lowercase()) {
                    return Err(CanopyError::invalid_query(
                        "An R2 jurisdiction is a lower case word such as eu",
                    ));
                }
                Ok(format!(".{value}"))
            },
        )?;
        Self::new(S3Options {
            endpoint: Some(format!("https://{}{jurisdiction}.r2.cloudflarestorage.com", options.account_id)),
            region: "auto".into(),
            bucket: options.bucket,
            credentials: S3Credentials {
                access_key_id: options.access_key_id,
                secret_access_key: options.secret_access_key,
                session_token: None,
            },
            force_path_style: Some(true),
            prefix: options.prefix,
            kind: Some("r2".into()),
        })
    }

    /// Builds the same object URL used for HTTP requests and signing.
    pub fn object_url(&self, key: &str, query: &[(&str, &str)]) -> Result<Url, CanopyError> {
        let encoded = aws_encode(&format!("{}{key}", self.options.prefix), true);
        let endpoint = &self.endpoint;
        let bucket = &self.options.bucket;
        let base = if self.path_style {
            let path = endpoint.path().strip_suffix('/').unwrap_or(endpoint.path());
            format!(
                "{}{path}/{}/{encoded}",
                endpoint.origin().ascii_serialization(),
                aws_encode(bucket, false)
            )
        } else {
            format!("{}://{bucket}.{}/{encoded}", endpoint.scheme(), authority(endpoint))
        };
        let mut url =
            Url::parse(&base).map_err(|_| CanopyError::invalid_query("Invalid object store URL"))?;
        if !query.is_empty() {
            url.query_pairs_mut().extend_pairs(query.iter().copied());
        }
        Ok(url)
    }

    async fn request(&self, method: Method, key: &str, init: Request<'_>) -> Result<Response, CanopyError> {
        let url = self.object_url(key, init.query)?;
        let payload_hash = sha256(init.body.as_deref().unwrap_or_default());
        let signed = sign_request(SignInput {
            method: method.as_str(),
            url: &url,
            headers: init.header.into_iter().map(|(name, value)| (name.into(), value.into())).collect(),
            payload_hash: &payload_hash,
            region: &self.options.region,
            service: "s3",
            credentials: &self.options.credentials,
            now: OffsetDateTime::now_utc(),
        })?;
        let mut request = self.client.request(method.clone(), url);
        for (name, value) in signed.headers {
            if name != "host" {
                request = request.header(name, value.trim_matches([' ', '\t', '\r', '\n']));
            }
        }
        if let Some(body) = init.body {
            request = request.body(body);
        }
        let response = request.send().await.map_err(|_| unreachable_store())?;
        let status = response.status().as_u16();
        if init.expect.contains(&status) {
            return Ok(response);
        }
        let text = response_text(response).await.unwrap_or_default();
        if status == 404 && method == Method::GET {
            return Err(CanopyError::named(
                ErrorCode::NotFound,
                "NotFoundError",
                "The file content is missing",
            ));
        }
        let code = xml_value(&text, "Code").map_or_else(String::new, |code| format!(" ({code})"));
        Err(unavailable(format!("The object store answered {status}{code}")))
    }
}

impl StorageBackend for S3Backend {
    fn kind(&self) -> &str {
        self.options.kind.as_deref().unwrap_or("s3")
    }

    fn put<'a>(
        &'a self,
        key: &'a str,
        body: Vec<u8>,
        content_type: &'a str,
    ) -> BoxFuture<'a, Result<(), CanopyError>> {
        Box::pin(async move {
            self.request(
                Method::PUT,
                key,
                Request {
                    header: Some(("content-type", content_type)),
                    body: Some(body),
                    ..Request::default()
                },
            )
            .await?;
            Ok(())
        })
    }

    fn get<'a>(
        &'a self,
        key: &'a str,
        range: Option<ByteRange>,
    ) -> BoxFuture<'a, Result<ByteStream, CanopyError>> {
        Box::pin(async move {
            let range = range.map(|range| format!("bytes={}-{}", range.start, range.end));
            let response = self
                .request(
                    Method::GET,
                    key,
                    Request {
                        header: range.as_deref().map(|value| ("range", value)),
                        expect: &[200, 206],
                        ..Request::default()
                    },
                )
                .await?;
            let chunks = stream::unfold(Some(response), |response| async move {
                let mut response = response?;
                match response.chunk().await {
                    Ok(Some(chunk)) => Some((Ok(chunk.to_vec()), Some(response))),
                    Ok(None) => None,
                    Err(_) => Some((Err(unreachable_store()), None)),
                }
            });
            Ok(Box::pin(chunks) as ByteStream)
        })
    }

    fn delete<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<(), CanopyError>> {
        Box::pin(async move {
            self.request(Method::DELETE, key, Request { expect: &[200, 204, 404], ..Request::default() })
                .await?;
            Ok(())
        })
    }

    fn create_multipart<'a>(
        &'a self,
        key: &'a str,
        content_type: &'a str,
    ) -> BoxFuture<'a, Result<String, CanopyError>> {
        Box::pin(async move {
            let response = self
                .request(
                    Method::POST,
                    key,
                    Request {
                        query: &[("uploads", "")],
                        header: Some(("content-type", content_type)),
                        ..Request::default()
                    },
                )
                .await?;
            xml_value(&response_text(response).await?, "UploadId")
                .map(str::to_owned)
                .ok_or_else(|| unavailable("The object store did not start the upload"))
        })
    }

    fn put_part<'a>(
        &'a self,
        key: &'a str,
        upload_id: &'a str,
        part: u32,
        body: Vec<u8>,
    ) -> BoxFuture<'a, Result<String, CanopyError>> {
        Box::pin(async move {
            let response = self
                .request(
                    Method::PUT,
                    key,
                    Request {
                        query: &[("partNumber", &part.to_string()), ("uploadId", upload_id)],
                        body: Some(body),
                        ..Request::default()
                    },
                )
                .await?;
            let etags = response.headers().get_all("etag");
            let mut values = etags.iter().peekable();
            if values.peek().is_none() {
                return Err(unavailable("The object store did not return an ETag"));
            }
            Ok(values
                .map(|value| value.as_bytes().iter().copied().map(char::from).collect::<String>())
                .collect::<Vec<_>>()
                .join(", "))
        })
    }

    fn complete_multipart<'a>(
        &'a self,
        key: &'a str,
        upload_id: &'a str,
        parts: &'a [UploadedPart],
    ) -> BoxFuture<'a, Result<(), CanopyError>> {
        Box::pin(async move {
            let mut parts: Vec<_> = parts.iter().collect();
            parts.sort_by_key(|part| part.part);
            let mut xml = String::from("<CompleteMultipartUpload>");
            for part in parts {
                let _ = write!(
                    xml,
                    "<Part><PartNumber>{}</PartNumber><ETag>{}</ETag></Part>",
                    part.part,
                    xml_escape(&part.etag)
                );
            }
            xml.push_str("</CompleteMultipartUpload>");
            let response = self
                .request(
                    Method::POST,
                    key,
                    Request {
                        query: &[("uploadId", upload_id)],
                        header: Some(("content-type", "application/xml")),
                        body: Some(xml.into_bytes()),
                        ..Request::default()
                    },
                )
                .await?;
            let text = response_text(response).await?;
            if text.contains("<Error>") {
                let code = xml_value(&text, "Code").unwrap_or("unknown");
                return Err(unavailable(format!("The object store could not join the parts ({code})")));
            }
            Ok(())
        })
    }

    fn abort_multipart<'a>(
        &'a self,
        key: &'a str,
        upload_id: &'a str,
    ) -> BoxFuture<'a, Result<(), CanopyError>> {
        Box::pin(async move {
            self.request(
                Method::DELETE,
                key,
                Request { query: &[("uploadId", upload_id)], expect: &[200, 204, 404], ..Request::default() },
            )
            .await?;
            Ok(())
        })
    }
}
