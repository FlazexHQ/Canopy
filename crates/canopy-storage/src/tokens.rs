//! The tokens of signed URLs: base64url JSON of the grant, a dot and its HMAC SHA-256, under a key derived from
//! the master key, so the data plane and the TypeScript server accept each other's tokens.

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use canopy_protocol::json::{Json, js_number_string, parse_json, write_json_string};
use ring::{hkdf, hmac, rand};

/// What a signed URL grants: reading one path of one bucket until it expires.
#[derive(Clone, Debug, PartialEq)]
pub struct SignedGrant {
    /// The bucket.
    pub bucket: String,
    /// The file path.
    pub path: String,
    /// When the grant expires, in milliseconds since the epoch.
    pub expires_at: f64,
}

/// Signs and checks the tokens of signed URLs.
pub struct UrlSigner {
    key: hmac::Key,
}

struct KeyLength;

impl hkdf::KeyType for KeyLength {
    fn len(&self) -> usize {
        32
    }
}

impl UrlSigner {
    /// A signer whose key is derived from the master key with HKDF SHA-256 (salt `canopy`, info `canopy storage
    /// signed urls`). Without a master key the signer makes its own random key, accepted by this process only.
    pub fn new(master_key: Option<&str>) -> UrlSigner {
        let mut key = [0u8; 32];
        match master_key {
            Some(master) => {
                let salt = hkdf::Salt::new(hkdf::HKDF_SHA256, b"canopy");
                let info: [&[u8]; 1] = [b"canopy storage signed urls"];
                let prk = salt.extract(master.as_bytes());
                if let Ok(derived) = prk.expand(&info, KeyLength) {
                    let _ = derived.fill(&mut key);
                }
            }
            None => {
                let _ = rand::SecureRandom::fill(&rand::SystemRandom::new(), &mut key);
            }
        }
        UrlSigner { key: hmac::Key::new(hmac::HMAC_SHA256, &key) }
    }

    /// The token of a grant.
    pub fn sign(&self, grant: &SignedGrant) -> String {
        let mut json = String::from("{\"b\":");
        write_json_string(&mut json, &grant.bucket);
        json.push_str(",\"p\":");
        write_json_string(&mut json, &grant.path);
        json.push_str(",\"e\":");
        json.push_str(&js_number_string(grant.expires_at));
        json.push('}');
        let payload = URL_SAFE_NO_PAD.encode(json.as_bytes());
        let mac = self.mac(&payload);
        format!("{payload}.{mac}")
    }

    /// The grant of a valid token that has not expired at `now` (milliseconds since the epoch).
    pub fn verify(&self, token: &str, now: f64) -> Option<SignedGrant> {
        let mut parts = token.split('.');
        let (payload, mac) = (parts.next()?, parts.next()?);
        if parts.next().is_some() {
            return None;
        }
        let given = base64url_decode(mac)?;
        hmac::verify(&self.key, payload.as_bytes(), &given).ok()?;
        if URL_SAFE_NO_PAD.encode(&given) != mac {
            return None;
        }
        let text = String::from_utf8(base64url_decode(payload)?).ok()?;
        let parsed = parse_json(&text).ok()?;
        let (Some(Json::String(bucket)), Some(Json::String(path)), Some(Json::Number(expires_at))) =
            (parsed.get("b"), parsed.get("p"), parsed.get("e"))
        else {
            return None;
        };
        if *expires_at <= now {
            return None;
        }
        Some(SignedGrant { bucket: bucket.clone(), path: path.clone(), expires_at: *expires_at })
    }

    fn mac(&self, payload: &str) -> String {
        URL_SAFE_NO_PAD.encode(hmac::sign(&self.key, payload.as_bytes()).as_ref())
    }
}

/// Decodes base64url as Node's `Buffer.from(text, "base64url")` does: either alphabet, padding optional,
/// other characters skipped.
fn base64url_decode(text: &str) -> Option<Vec<u8>> {
    let cleaned: String = text
        .chars()
        .filter_map(|c| match c {
            '-' => Some('+'),
            '_' => Some('/'),
            'A'..='Z' | 'a'..='z' | '0'..='9' | '+' | '/' => Some(c),
            _ => None,
        })
        .collect();
    canopy_protocol::ejson::forgiving_base64_decode(&cleaned)
}
