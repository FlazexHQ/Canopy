use std::{collections::BTreeMap, time::Duration};

use canopy_protocol::{CanopyError, ErrorCode};
use canopy_sigv4::{Credentials, SignInput, sha256, sign_request};
use lettre::{
    AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor,
    message::{
        MultiPart, SinglePart,
        header::{ContentTransferEncoding, ContentType},
    },
    transport::smtp::{
        authentication::{Credentials as SmtpCredentials, Mechanism},
        client::{Tls, TlsParameters},
        extension::ClientId,
    },
};
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

use crate::Template;

/// SMTP settings from resolved built in auth configuration.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SmtpSettings {
    /// SMTP relay hostname.
    pub host: String,
    /// Relay port, defaulting to 465 for implicit TLS and 587 otherwise.
    pub port: Option<u16>,
    /// Use implicit TLS.
    #[serde(default)]
    pub secure: bool,
    /// Require TLS, as enabled by default.
    #[serde(default = "require_tls")]
    pub require_tls: bool,
    /// Optional SMTP username.
    pub user: Option<String>,
    /// SMTP password.
    pub pass: Option<String>,
}

fn require_tls() -> bool {
    true
}

/// The configured delivery provider from resolved built in auth configuration.
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", rename_all_fields = "camelCase")]
pub enum TransportSettings {
    /// Deliver through an SMTP relay.
    Smtp(SmtpSettings),
    /// Deliver through Resend.
    Resend {
        /// Resend API key.
        api_key: String,
    },
    /// Deliver through Postmark.
    Postmark {
        /// Postmark server token.
        server_token: String,
        /// Optional message stream, defaulting to outbound.
        message_stream: Option<String>,
    },
    /// Deliver through the Amazon SES v2 API.
    Ses {
        /// AWS region.
        region: String,
        /// AWS access key ID.
        access_key_id: String,
        /// AWS secret access key.
        secret_access_key: String,
        /// AWS session token for temporary credentials.
        session_token: Option<String>,
    },
    /// Log the message in development without delivering it.
    Log,
}

pub(crate) enum Transport {
    Smtp(Box<AsyncSmtpTransport<Tokio1Executor>>),
    Http { settings: TransportSettings, client: Client, endpoint: Url },
    Log,
}

const TIMEOUT: Duration = Duration::from_secs(10);

fn unavailable(message: impl Into<String>) -> CanopyError {
    CanopyError::new(ErrorCode::Unavailable, message)
}

pub(crate) fn invalid(message: &str) -> CanopyError {
    CanopyError::new(ErrorCode::ValidationFailed, message)
}

impl Transport {
    pub(crate) fn new(settings: TransportSettings) -> Result<Self, CanopyError> {
        match settings {
            TransportSettings::Smtp(options) => {
                let parameters = TlsParameters::new(options.host.clone())
                    .map_err(|_| invalid("Invalid SMTP TLS settings"))?;
                let tls = if options.secure {
                    Tls::Wrapper(parameters)
                } else if options.require_tls {
                    Tls::Required(parameters)
                } else {
                    Tls::Opportunistic(parameters)
                };
                let mut smtp = AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(options.host)
                    .port(options.port.unwrap_or(if options.secure { 465 } else { 587 }))
                    .hello_name(ClientId::Domain("canopy".into()))
                    .timeout(Some(TIMEOUT))
                    .tls(tls);
                if let Some(user) = options.user {
                    smtp = smtp
                        .credentials(SmtpCredentials::new(user, options.pass.unwrap_or_default()))
                        .authentication(vec![Mechanism::Plain]);
                }
                Ok(Self::Smtp(Box::new(smtp.build())))
            }
            TransportSettings::Log => Ok(Self::Log),
            settings => {
                let endpoint = match &settings {
                    TransportSettings::Resend { .. } => "https://api.resend.com/emails".into(),
                    TransportSettings::Postmark { .. } => "https://api.postmarkapp.com/email".into(),
                    TransportSettings::Ses { region, .. } => {
                        if region.is_empty()
                            || !region.bytes().all(|byte| {
                                byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-'
                            })
                        {
                            return Err(invalid("Invalid Amazon SES region"));
                        }
                        format!("https://email.{region}.amazonaws.com/v2/email/outbound-emails")
                    }
                    _ => return Err(invalid("Invalid HTTP mail provider")),
                };
                Self::http(settings, &endpoint)
            }
        }
    }

    fn http(settings: TransportSettings, endpoint: &str) -> Result<Self, CanopyError> {
        let endpoint = Url::parse(endpoint).map_err(|_| invalid("Invalid mail provider endpoint"))?;
        let _ = rustls::crypto::ring::default_provider().install_default();
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .timeout(TIMEOUT)
            .build()
            .map_err(|_| unavailable("Could not start the mail provider client"))?;
        Ok(Self::Http { settings, client, endpoint })
    }

    pub(crate) async fn send(
        &self,
        from: &str,
        to: &str,
        rendered: Template,
        now: OffsetDateTime,
    ) -> Result<(), CanopyError> {
        match self {
            Self::Log => {
                tracing::warn!(
                    to,
                    subject = rendered.subject,
                    body = rendered.text,
                    "auth email (email.log() transport, not delivered)"
                );
                Ok(())
            }
            Self::Smtp(smtp) => {
                let message = mime(from, to, rendered)?;
                tokio::time::timeout(TIMEOUT, smtp.send(message))
                    .await
                    .map_err(|_| unavailable("The SMTP server timed out"))?
                    .map_err(|_| unavailable("The SMTP server could not accept the email"))?;
                Ok(())
            }
            Self::Http { settings, client, endpoint } => {
                let (provider, headers, body) = request(settings, endpoint, from, to, rendered, now)?;
                let mut request = client.post(endpoint.clone()).body(body);
                for (name, value) in headers {
                    request = request.header(name, value);
                }
                let response = request
                    .send()
                    .await
                    .map_err(|_| unavailable(format!("{provider} could not accept the email")))?;
                if !response.status().is_success() {
                    return Err(unavailable(format!(
                        "{provider} refused the email with HTTP {}",
                        response.status().as_u16()
                    )));
                }
                Ok(())
            }
        }
    }
}

fn mime(from: &str, to: &str, rendered: Template) -> Result<Message, CanopyError> {
    if [from, to, &rendered.subject].iter().any(|value| value.contains(['\r', '\n'])) {
        return Err(invalid("Email headers must not contain line breaks"));
    }
    let from = from.parse().map_err(|_| invalid("Invalid email address"))?;
    let to = to.parse().map_err(|_| invalid("Invalid email address"))?;
    let message = Message::builder().from(from).to(to).subject(rendered.subject).message_id(None);
    let part = |content_type, body: String| {
        SinglePart::builder()
            .header(content_type)
            .header(ContentTransferEncoding::Base64)
            .body(body.into_bytes())
    };
    let text = part(ContentType::TEXT_PLAIN, rendered.text);
    match rendered.html {
        Some(html) => message.multipart(
            MultiPart::alternative().singlepart(text).singlepart(part(ContentType::TEXT_HTML, html)),
        ),
        None => message.singlepart(text),
    }
    .map_err(|_| invalid("Invalid email message"))
}

fn request(
    settings: &TransportSettings,
    endpoint: &Url,
    from: &str,
    to: &str,
    mail: Template,
    now: OffsetDateTime,
) -> Result<(&'static str, BTreeMap<String, String>, String), CanopyError> {
    let mut headers = BTreeMap::from([("content-type".into(), "application/json".into())]);
    let (provider, body) = match settings {
        TransportSettings::Resend { api_key } => {
            headers.insert("authorization".into(), format!("Bearer {api_key}"));
            (
                "Resend",
                encode(ResendBody {
                    from,
                    to: [to],
                    subject: mail.subject,
                    text: mail.text,
                    html: mail.html,
                })?,
            )
        }
        TransportSettings::Postmark { server_token, message_stream } => {
            headers.insert("accept".into(), "application/json".into());
            headers.insert("x-postmark-server-token".into(), server_token.clone());
            (
                "Postmark",
                encode(PostmarkBody {
                    from,
                    to,
                    subject: mail.subject,
                    text_body: mail.text,
                    html_body: mail.html,
                    message_stream: message_stream.as_deref().unwrap_or("outbound"),
                })?,
            )
        }
        TransportSettings::Ses { region, access_key_id, secret_access_key, session_token } => {
            let part = |data| SesPart { data, charset: "UTF-8" };
            let body = encode(SesBody {
                from_email_address: from,
                destination: SesDestination { to_addresses: [to] },
                content: SesContent {
                    simple: SesSimple {
                        subject: part(mail.subject),
                        body: SesParts { text: part(mail.text), html: mail.html.map(part) },
                    },
                },
            })?;
            let credentials = Credentials {
                access_key_id: access_key_id.clone(),
                secret_access_key: secret_access_key.clone(),
                session_token: session_token.clone(),
            };
            let mut signed = sign_request(
                SignInput {
                    method: "POST",
                    url: endpoint,
                    headers,
                    payload_hash: &sha256(body.as_bytes()),
                    region,
                    service: "ses",
                    credentials: &credentials,
                    now,
                },
                false,
            )?;
            signed.headers.remove("host");
            return Ok(("Amazon SES", signed.headers, body));
        }
        _ => return Err(invalid("Invalid HTTP mail provider")),
    };
    Ok((provider, headers, body))
}

fn encode(body: impl Serialize) -> Result<String, CanopyError> {
    serde_json::to_string(&body)
        .map_err(|_| CanopyError::new(ErrorCode::Internal, "Could not encode the email"))
}

#[derive(Serialize)]
struct ResendBody<'a> {
    from: &'a str,
    to: [&'a str; 1],
    subject: String,
    text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    html: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "PascalCase")]
struct PostmarkBody<'a> {
    from: &'a str,
    to: &'a str,
    subject: String,
    text_body: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    html_body: Option<String>,
    message_stream: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "PascalCase")]
struct SesBody<'a> {
    from_email_address: &'a str,
    destination: SesDestination<'a>,
    content: SesContent,
}

#[derive(Serialize)]
#[serde(rename_all = "PascalCase")]
struct SesDestination<'a> {
    to_addresses: [&'a str; 1],
}

#[derive(Serialize)]
#[serde(rename_all = "PascalCase")]
struct SesContent {
    simple: SesSimple,
}

#[derive(Serialize)]
#[serde(rename_all = "PascalCase")]
struct SesSimple {
    subject: SesPart,
    body: SesParts,
}

#[derive(Serialize)]
#[serde(rename_all = "PascalCase")]
struct SesParts {
    text: SesPart,
    #[serde(skip_serializing_if = "Option::is_none")]
    html: Option<SesPart>,
}

#[derive(Serialize)]
#[serde(rename_all = "PascalCase")]
struct SesPart {
    data: String,
    charset: &'static str,
}

#[cfg(test)]
mod tests;
