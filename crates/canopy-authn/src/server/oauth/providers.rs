use std::sync::Arc;

use serde_json::{Map, Value, json};
use url::Url;

use super::{
    ClientSecret, DEFAULT_OIDC_SCOPES, Discovered, OidcProvider, ProviderRequest, Registry, SocialProvider,
    SocialProviderKind, jwt,
};

const MICROSOFT_AUTHORITY: &str = "https://login.microsoftonline.com";
const MICROSOFT_CONSUMER_TENANT: &str = "9188040d-6c67-4c5b-b112-36a304b66dad";
const ONE_HOUR_S: f64 = 3600.0;

pub(in crate::server) enum Provider<'a> {
    Social(&'a SocialProvider),
    Oidc(&'a OidcProvider, Arc<Discovered>),
}

pub(super) struct Tokens {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub id_token: Option<String>,
    pub access_expires_in_s: Option<f64>,
    pub refresh_expires_in_s: Option<f64>,
    pub scopes: Vec<String>,
}

pub(super) struct Identity {
    pub account_id: String,
    pub email: Option<String>,
    pub name: String,
    pub image: Option<String>,
    pub email_verified: bool,
}

fn text(fields: &Map<String, Value>, name: &str) -> Option<String> {
    fields.get(name).and_then(Value::as_str).filter(|value| !value.is_empty()).map(str::to_owned)
}

fn truthy(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Bool(true))) || matches!(value, Some(Value::String(text)) if text == "true")
}

fn seconds(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.trim().parse().ok(),
        _ => None,
    }
    .filter(|seconds: &f64| seconds.is_finite() && *seconds > 0.0)
}

fn subject(value: Option<&Value>) -> Option<String> {
    let subject = match value? {
        Value::String(text) => text.clone(),
        Value::Number(number) if number.is_i64() || number.is_u64() => number.to_string(),
        _ => return None,
    };
    (!subject.trim().is_empty()).then_some(subject)
}

fn bearer(token: &str) -> (&'static str, String) {
    ("authorization", format!("Bearer {token}"))
}

impl Provider<'_> {
    pub(in crate::server) fn id(&self) -> &str {
        match self {
            Self::Social(provider) => provider.kind.id(),
            Self::Oidc(provider, _) => &provider.id,
        }
    }

    fn client_id(&self) -> &str {
        match self {
            Self::Social(provider) => &provider.client_id,
            Self::Oidc(provider, _) => &provider.client_id,
        }
    }

    fn kind(&self) -> Option<SocialProviderKind> {
        match self {
            Self::Social(provider) => Some(provider.kind),
            Self::Oidc(..) => None,
        }
    }

    fn tenant(&self) -> &str {
        match self {
            Self::Social(provider) => {
                provider.tenant_id.as_deref().filter(|tenant| !tenant.is_empty()).unwrap_or("common")
            }
            Self::Oidc(..) => "common",
        }
    }

    pub(in crate::server) fn requires_nonce(&self) -> bool {
        matches!(self, Self::Oidc(..))
    }

    pub(in crate::server) fn issuer(&self) -> Option<&str> {
        match self {
            Self::Oidc(_, discovered) => Some(&discovered.issuer),
            Self::Social(_) => None,
        }
    }

    fn uses_pkce(&self) -> bool {
        self.kind() != Some(SocialProviderKind::Discord)
    }

    fn token_endpoint(&self) -> Option<Url> {
        let url = match self.kind() {
            None => {
                return match self {
                    Self::Oidc(_, discovered) => Some(discovered.token_endpoint.clone()),
                    Self::Social(_) => None,
                };
            }
            Some(SocialProviderKind::Google) => "https://oauth2.googleapis.com/token".to_owned(),
            Some(SocialProviderKind::Github) => "https://github.com/login/oauth/access_token".to_owned(),
            Some(SocialProviderKind::Apple) => "https://appleid.apple.com/auth/token".to_owned(),
            Some(SocialProviderKind::Microsoft) => {
                format!("{MICROSOFT_AUTHORITY}/{}/oauth2/v2.0/token", self.tenant())
            }
            Some(SocialProviderKind::Discord) => "https://discord.com/api/oauth2/token".to_owned(),
        };
        Url::parse(&url).ok()
    }

    pub(in crate::server) fn authorization_url(
        &self,
        redirect_uri: &str,
        state: &str,
        verifier: &str,
        nonce: Option<&str>,
        extra_scopes: &[String],
        login_hint: Option<&str>,
    ) -> Option<Url> {
        let (endpoint, mut scopes, joiner) = match self.kind() {
            Some(SocialProviderKind::Google) => (
                "https://accounts.google.com/o/oauth2/v2/auth".to_owned(),
                vec!["email", "profile", "openid"],
                " ",
            ),
            Some(SocialProviderKind::Github) => {
                ("https://github.com/login/oauth/authorize".to_owned(), vec!["read:user", "user:email"], " ")
            }
            Some(SocialProviderKind::Apple) => {
                ("https://appleid.apple.com/auth/authorize".to_owned(), vec!["email", "name"], " ")
            }
            Some(SocialProviderKind::Microsoft) => (
                format!("{MICROSOFT_AUTHORITY}/{}/oauth2/v2.0/authorize", self.tenant()),
                vec!["openid", "profile", "email", "User.Read", "offline_access"],
                " ",
            ),
            Some(SocialProviderKind::Discord) => {
                ("https://discord.com/api/oauth2/authorize".to_owned(), vec!["identify", "email"], " ")
            }
            None => match self {
                Self::Oidc(provider, discovered) => {
                    let mut scopes: Vec<&str> = if provider.scopes.is_empty() {
                        DEFAULT_OIDC_SCOPES.to_vec()
                    } else {
                        provider.scopes.iter().map(String::as_str).collect()
                    };
                    if !scopes.contains(&"openid") {
                        scopes.insert(0, "openid");
                    }
                    (discovered.authorization_endpoint.to_string(), scopes, " ")
                }
                Self::Social(_) => return None,
            },
        };
        scopes.extend(extra_scopes.iter().map(String::as_str));
        let mut url = Url::parse(&endpoint).ok()?;
        {
            let mut query = url.query_pairs_mut();
            let apple = self.kind() == Some(SocialProviderKind::Apple);
            query.append_pair("response_type", if apple { "code id_token" } else { "code" });
            query.append_pair("client_id", self.client_id());
            query.append_pair("state", state);
            query.append_pair("scope", &scopes.join(joiner));
            query.append_pair("redirect_uri", redirect_uri);
            if let Some(hint) = login_hint {
                query.append_pair("login_hint", hint);
            }
            if let Some(nonce) = nonce {
                query.append_pair("nonce", nonce);
            }
            if self.kind() == Some(SocialProviderKind::Discord) {
                query.append_pair("prompt", "none");
            }
            if apple {
                query.append_pair("response_mode", "form_post");
            }
            if self.uses_pkce() {
                let digest = ring::digest::digest(&ring::digest::SHA256, verifier.as_bytes());
                use base64::Engine as _;
                query.append_pair("code_challenge_method", "S256");
                query.append_pair(
                    "code_challenge",
                    &base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest.as_ref()),
                );
            }
            if self.kind() == Some(SocialProviderKind::Google) {
                query.append_pair("include_granted_scopes", "true");
            }
        }
        Some(url)
    }

    fn client_secret(&self, now_ms: i64) -> Option<String> {
        match self {
            Self::Oidc(provider, _) => Some(provider.client_secret.clone()),
            Self::Social(provider) => match &provider.client_secret {
                ClientSecret::Static(secret) => Some(secret.clone()),
                ClientSecret::AppleKey { team_id, key_id, private_key } => {
                    let now = now_ms.div_euclid(1000);
                    let claims = json!({
                        "iss": team_id, "iat": now, "exp": now + 300,
                        "aud": "https://appleid.apple.com", "sub": provider.client_id,
                    });
                    jwt::sign_es256(&jwt::pem_der(private_key)?, key_id, &claims)
                }
            },
        }
    }

    pub(super) async fn exchange(
        &self,
        registry: &Registry,
        code: &str,
        verifier: &str,
        redirect_uri: &str,
        now_ms: i64,
    ) -> Option<Tokens> {
        let body = {
            let mut form = url::form_urlencoded::Serializer::new(String::new());
            form.append_pair("grant_type", "authorization_code");
            form.append_pair("code", code);
            if self.uses_pkce() {
                form.append_pair("code_verifier", verifier);
            }
            form.append_pair("redirect_uri", redirect_uri);
            form.append_pair("client_id", self.client_id());
            form.append_pair("client_secret", &self.client_secret(now_ms)?);
            form.finish()
        };
        let answer = registry
            .json(ProviderRequest {
                method: "POST",
                url: self.token_endpoint()?,
                headers: vec![
                    ("accept", "application/json".into()),
                    ("content-type", "application/x-www-form-urlencoded".into()),
                    ("user-agent", "canopy".into()),
                ],
                body: Some(body),
            })
            .await?;
        if answer.contains_key("error") {
            return None;
        }
        let scopes = match answer.get("scope") {
            Some(Value::String(scope)) => scope.split_whitespace().map(str::to_owned).collect(),
            Some(Value::Array(scopes)) => scopes
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|scope| !scope.is_empty())
                .map(str::to_owned)
                .collect(),
            _ => Vec::new(),
        };
        Some(Tokens {
            access_token: text(&answer, "access_token")?,
            refresh_token: text(&answer, "refresh_token"),
            id_token: text(&answer, "id_token"),
            access_expires_in_s: seconds(answer.get("expires_in")),
            refresh_expires_in_s: seconds(answer.get("refresh_token_expires_in")),
            scopes,
        })
    }

    pub(super) async fn identity(
        &self,
        registry: &Registry,
        tokens: &Tokens,
        nonce: Option<&str>,
        apple_user: Option<&str>,
        now_ms: i64,
    ) -> Option<Identity> {
        #[allow(clippy::cast_precision_loss)]
        let now_s = now_ms as f64 / 1000.0;
        let audience = self.client_id();
        match self {
            Self::Oidc(_, discovered) => {
                let issuers = [discovered.issuer.clone()];
                let expected = jwt::Expected { issuers: &issuers, audience, now_s, max_age_s: None, nonce };
                let claims = registry
                    .verified_claims(
                        tokens.id_token.as_deref()?,
                        &discovered.jwks_uri,
                        &discovered.algorithms,
                        &expected,
                        now_ms,
                    )
                    .await?;
                let account_id = subject(claims.get("sub"))?;
                let profile = if claims.contains_key("email") {
                    claims
                } else {
                    let profile = registry
                        .json(ProviderRequest {
                            method: "GET",
                            url: discovered.userinfo_endpoint.clone()?,
                            headers: vec![bearer(&tokens.access_token), ("user-agent", "canopy".into())],
                            body: None,
                        })
                        .await?;
                    if profile
                        .get("sub")
                        .is_some_and(|sub| subject(Some(sub)).as_deref() != Some(account_id.as_str()))
                    {
                        return None;
                    }
                    profile
                };
                Some(Identity {
                    account_id,
                    email: text(&profile, "email"),
                    name: text(&profile, "name").unwrap_or_default(),
                    image: text(&profile, "picture"),
                    email_verified: truthy(profile.get("email_verified")),
                })
            }
            Self::Social(provider) => match provider.kind {
                SocialProviderKind::Github => github(registry, &tokens.access_token).await,
                SocialProviderKind::Discord => discord(registry, &tokens.access_token).await,
                SocialProviderKind::Google => {
                    let claims = jwt::decode(tokens.id_token.as_deref()?)?.claims;
                    let issuers =
                        ["https://accounts.google.com".to_owned(), "accounts.google.com".to_owned()];
                    let expected = jwt::Expected {
                        issuers: &issuers,
                        audience,
                        now_s,
                        max_age_s: Some(ONE_HOUR_S),
                        nonce: None,
                    };
                    jwt::claims_hold(&claims, &expected).then_some(())?;
                    Some(Identity {
                        account_id: subject(claims.get("sub"))?,
                        email: text(&claims, "email"),
                        name: text(&claims, "name").unwrap_or_default(),
                        image: text(&claims, "picture"),
                        email_verified: truthy(claims.get("email_verified")),
                    })
                }
                SocialProviderKind::Apple => {
                    let issuers = ["https://appleid.apple.com".to_owned()];
                    let expected = jwt::Expected {
                        issuers: &issuers,
                        audience,
                        now_s,
                        max_age_s: Some(ONE_HOUR_S),
                        nonce: None,
                    };
                    let keys = Url::parse("https://appleid.apple.com/auth/keys").ok()?;
                    let claims = registry
                        .verified_claims(
                            tokens.id_token.as_deref()?,
                            &keys,
                            &["RS256".into()],
                            &expected,
                            now_ms,
                        )
                        .await?;
                    let named = apple_user
                        .and_then(|user| serde_json::from_str::<Value>(user).ok())
                        .map(|user| {
                            let part =
                                |name: &str| user["name"][name].as_str().unwrap_or_default().to_owned();
                            format!("{} {}", part("firstName"), part("lastName")).trim().to_owned()
                        })
                        .filter(|name| !name.is_empty());
                    Some(Identity {
                        account_id: subject(claims.get("sub"))?,
                        email: text(&claims, "email"),
                        name: named.or_else(|| text(&claims, "name")).unwrap_or_default(),
                        image: None,
                        email_verified: truthy(claims.get("email_verified")),
                    })
                }
                SocialProviderKind::Microsoft => {
                    let tenant = self.tenant();
                    let expected = jwt::Expected {
                        issuers: &[],
                        audience,
                        now_s,
                        max_age_s: Some(ONE_HOUR_S),
                        nonce: None,
                    };
                    let keys =
                        Url::parse(&format!("{MICROSOFT_AUTHORITY}/{tenant}/discovery/v2.0/keys")).ok()?;
                    let claims = registry
                        .verified_claims(
                            tokens.id_token.as_deref()?,
                            &keys,
                            &["RS256".into()],
                            &expected,
                            now_ms,
                        )
                        .await?;
                    let tid = claims.get("tid").and_then(Value::as_str)?;
                    let issuer = claims.get("iss").and_then(Value::as_str)?;
                    let tenant_bound = issuer == format!("{MICROSOFT_AUTHORITY}/{tid}/v2.0")
                        && match tenant {
                            "common" => true,
                            "organizations" => tid != MICROSOFT_CONSUMER_TENANT,
                            "consumers" => tid == MICROSOFT_CONSUMER_TENANT,
                            tenant => issuer == format!("{MICROSOFT_AUTHORITY}/{tenant}/v2.0"),
                        };
                    if !tenant_bound {
                        return None;
                    }
                    let email = text(&claims, "email");
                    let listed = |name: &str| {
                        claims.get(name).and_then(Value::as_array).is_some_and(|addresses| {
                            email
                                .as_deref()
                                .is_some_and(|email| addresses.iter().any(|address| address == email))
                        })
                    };
                    let email_verified = match claims.get("email_verified") {
                        Some(value) => truthy(Some(value)),
                        None => listed("verified_primary_email") || listed("verified_secondary_email"),
                    };
                    Some(Identity {
                        account_id: claims
                            .get("oid")
                            .and_then(Value::as_str)
                            .filter(|oid| !oid.trim().is_empty())?
                            .to_owned(),
                        email,
                        name: text(&claims, "name").unwrap_or_default(),
                        image: None,
                        email_verified,
                    })
                }
            },
        }
    }
}

async fn github(registry: &Registry, access_token: &str) -> Option<Identity> {
    let get = |path: &str| {
        Some(ProviderRequest {
            method: "GET",
            url: Url::parse(&format!("https://api.github.com{path}")).ok()?,
            headers: vec![bearer(access_token), ("user-agent", "canopy".into())],
            body: None,
        })
    };
    let profile = registry.json(get("/user")?).await?;
    let emails: Vec<Value> = match registry.call(get("/user/emails")?).await {
        Some(response) if (200..300).contains(&response.status) => {
            serde_json::from_slice(&response.body).unwrap_or_default()
        }
        _ => Vec::new(),
    };
    let email = text(&profile, "email").or_else(|| {
        emails
            .iter()
            .find(|entry| entry["primary"] == Value::Bool(true))
            .or_else(|| emails.first())
            .and_then(|entry| entry["email"].as_str())
            .map(str::to_owned)
    });
    let email_verified = emails
        .iter()
        .find(|entry| email.as_deref().is_some_and(|email| entry["email"] == email))
        .is_some_and(|entry| entry["verified"] == Value::Bool(true));
    Some(Identity {
        account_id: subject(profile.get("id"))?,
        name: text(&profile, "name").or_else(|| text(&profile, "login")).unwrap_or_default(),
        image: text(&profile, "avatar_url"),
        email,
        email_verified,
    })
}

async fn discord(registry: &Registry, access_token: &str) -> Option<Identity> {
    let profile = registry
        .json(ProviderRequest {
            method: "GET",
            url: Url::parse("https://discord.com/api/users/@me").ok()?,
            headers: vec![bearer(access_token), ("user-agent", "canopy".into())],
            body: None,
        })
        .await?;
    let id = subject(profile.get("id"))?;
    let image = match profile.get("avatar").and_then(Value::as_str) {
        Some(avatar) => {
            let format = if avatar.starts_with("a_") { "gif" } else { "png" };
            format!("https://cdn.discordapp.com/avatars/{id}/{avatar}.{format}")
        }
        None => {
            let discriminator = profile.get("discriminator").and_then(Value::as_str).unwrap_or("0");
            let index = if discriminator == "0" {
                (id.parse::<u64>().ok()? >> 22) % 6
            } else {
                discriminator.parse::<u64>().ok()? % 5
            };
            format!("https://cdn.discordapp.com/embed/avatars/{index}.png")
        }
    };
    Some(Identity {
        name: text(&profile, "global_name").or_else(|| text(&profile, "username")).unwrap_or_default(),
        email: text(&profile, "email"),
        email_verified: truthy(profile.get("verified")),
        image: Some(image),
        account_id: id,
    })
}
