//! AWS Signature Version 4 request signing.

use canopy_protocol::CanopyError;
use ring::{digest, hmac};
use std::{collections::BTreeMap, fmt::Write};
use time::{OffsetDateTime, macros::format_description};
use url::Url;

/// AWS credentials, including the token when using temporary credentials.
pub struct Credentials {
    /// The access key ID.
    pub access_key_id: String,
    /// The secret access key.
    pub secret_access_key: String,
    /// The optional session token.
    pub session_token: Option<String>,
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
    pub credentials: &'a Credentials,
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

/// Encodes a URI component using the AWS unreserved character set.
pub fn encode_uri(value: &str, keep_slash: bool) -> String {
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

/// Returns a lowercase SHA 256 digest.
pub fn sha256(bytes: &[u8]) -> String {
    hex(digest::digest(&digest::SHA256, bytes).as_ref())
}

fn mac(key: &[u8], data: &str) -> hmac::Tag {
    hmac::sign(&hmac::Key::new(hmac::HMAC_SHA256, key), data.as_bytes())
}

fn js_whitespace(c: char) -> bool {
    matches!(c, '\t'..='\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' |
        '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

/// Signs a request at the supplied UTC instant. S3 mode preserves the encoded path and sends the payload hash.
pub fn sign_request(input: SignInput<'_>, s3: bool) -> Result<SignedRequest, CanopyError> {
    let amz_date = input
        .now
        .to_utc()
        .format(format_description!("[year][month][day]T[hour][minute][second]Z"))
        .map_err(|_| CanopyError::invalid_query("Invalid AWS signing timestamp"))?;
    let date = amz_date.chars().take(8).collect::<String>();
    let mut headers: BTreeMap<_, _> =
        input.headers.into_iter().map(|(name, value)| (name.to_ascii_lowercase(), value)).collect();
    headers.insert("host".into(), authority(input.url).into());
    headers.insert("x-amz-date".into(), amz_date.clone());
    if s3 {
        headers.insert("x-amz-content-sha256".into(), input.payload_hash.into());
    }
    if let Some(token) = &input.credentials.session_token {
        headers.insert("x-amz-security-token".into(), token.clone());
    }

    let names: Vec<_> = headers.keys().cloned().collect();
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
        .map(|(name, value)| (encode_uri(&name, false), encode_uri(&value, false)))
        .collect();
    query.sort_unstable();
    let query =
        query.into_iter().map(|(name, value)| format!("{name}={value}")).collect::<Vec<_>>().join("&");
    let path = if s3 {
        input.url.path().to_owned()
    } else {
        input
            .url
            .path()
            .split('/')
            .map(|segment| {
                let decoded = percent_encoding::percent_decode_str(segment)
                    .decode_utf8()
                    .map_err(|_| CanopyError::invalid_query("Invalid AWS signing path"))?;
                Ok(encode_uri(&decoded, false))
            })
            .collect::<Result<Vec<_>, CanopyError>>()?
            .join("/")
    };
    let canonical_request = format!(
        "{}\n{}\n{query}\n{canonical_headers}\n{signed_headers}\n{}",
        input.method, path, input.payload_hash
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
