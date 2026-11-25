//! Auth email rendering and delivery.

mod store;
mod templates;
mod transport;

pub use store::{TemplateEdit, TemplateStore, template_document};
pub use templates::{EmailKind, Template, TemplateData, render_default, render_stored};
pub use transport::{SmtpSettings, TransportSettings};

use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};

use canopy_mongo::mongodb::{Database, bson::doc};
use canopy_protocol::{CanopyError, ErrorCode};
use serde::Deserialize;
use time::OffsetDateTime;
use tokio::sync::Mutex;
use transport::Transport;

/// Built in auth email settings after environment and configuration resolution.
#[derive(Deserialize)]
pub struct MailSettings {
    /// Sender mailbox as passed to the transport.
    pub from: String,
    /// Configured transport.
    pub transport: TransportSettings,
}

impl Default for MailSettings {
    fn default() -> Self {
        Self { from: "Canopy <auth@localhost>".into(), transport: TransportSettings::Log }
    }
}

/// The current email template settings document in the meta database.
#[derive(Default, Deserialize)]
pub struct TemplateSettings {
    /// The current version, zero before the first edit.
    #[serde(deserialize_with = "store::deserialize_version")]
    pub version: u64,
    /// Overrides keyed by email kind.
    pub templates: HashMap<EmailKind, Template>,
}

impl TemplateSettings {
    /// Loads the current templates from the supplied Canopy meta database.
    pub async fn load(meta: &Database) -> Result<Self, CanopyError> {
        meta.collection::<Self>("settings")
            .find_one(doc! { "_id": "email_templates" })
            .await
            .map(Option::unwrap_or_default)
            .map_err(|_| CanopyError::new(ErrorCode::Unavailable, "Could not load email templates"))
    }

    /// Renders a stored override if it exists, or the built in template otherwise.
    pub fn render(&self, kind: EmailKind, data: &TemplateData<'_>) -> Result<Template, CanopyError> {
        match self.templates.get(&kind) {
            Some(template) => render_stored(template, data),
            None => Ok(render_default(kind, data)),
        }
    }
}

/// Recipient and optional variables for an email.
#[derive(Default)]
pub struct Recipient<'a> {
    /// The recipient mailbox.
    pub email: &'a str,
    /// The action link.
    pub url: Option<&'a str>,
    /// The one time code.
    pub otp: Option<&'a str>,
    /// The proposed new address.
    pub new_email: Option<&'a str>,
}

struct CachedTemplates {
    loaded_at: Instant,
    settings: TemplateSettings,
    refreshing: bool,
}

/// Shared renderer and sender for built in auth and the control role.
pub struct Mailer {
    app_name: String,
    transport: Option<(String, Transport)>,
    meta: Database,
    templates: Arc<Mutex<CachedTemplates>>,
    sent: Mutex<HashMap<(EmailKind, String), Vec<Instant>>>,
}

impl Mailer {
    /// Opens a mailer from resolved configuration and reads the current template overrides.
    pub async fn open(
        meta: Database,
        app_name: String,
        settings: Option<MailSettings>,
    ) -> Result<Self, CanopyError> {
        let transport = settings
            .map(|settings| Transport::new(settings.transport).map(|transport| (settings.from, transport)))
            .transpose()?;
        let templates = TemplateSettings::load(&meta).await?;
        Ok(Self {
            app_name,
            transport,
            meta,
            templates: Arc::new(Mutex::new(CachedTemplates {
                loaded_at: Instant::now(),
                settings: templates,
                refreshing: false,
            })),
            sent: Mutex::default(),
        })
    }

    /// Reports whether an email transport is configured.
    pub fn enabled(&self) -> bool {
        self.transport.is_some()
    }

    /// Renders an email without sending it. A failed refresh preserves the last loaded templates.
    pub async fn render(&self, kind: EmailKind, recipient: &Recipient<'_>) -> Result<Template, CanopyError> {
        let mut cache = self.templates.lock().await;
        if !cache.refreshing && cache.loaded_at.elapsed() >= Duration::from_secs(30) {
            cache.refreshing = true;
            let meta = self.meta.clone();
            let templates = Arc::clone(&self.templates);
            tokio::spawn(async move {
                let loaded = TemplateSettings::load(&meta).await;
                let mut cache = templates.lock().await;
                match loaded {
                    Ok(settings) => cache.settings = settings,
                    Err(error) => {
                        tracing::warn!(code = error.code().as_str(), "Could not refresh email templates")
                    }
                }
                cache.loaded_at = Instant::now();
                cache.refreshing = false;
            });
        }
        cache.settings.render(
            kind,
            &TemplateData {
                app_name: &self.app_name,
                email: recipient.email,
                url: recipient.url,
                otp: recipient.otp,
                new_email: recipient.new_email,
            },
        )
    }

    /// Delivers one rendered email and reports delivery errors to the caller.
    pub async fn deliver(&self, to: &str, rendered: Template) -> Result<(), CanopyError> {
        let (from, transport) = self
            .transport
            .as_ref()
            .ok_or_else(|| CanopyError::new(ErrorCode::Unavailable, "No email transport is configured"))?;
        transport.send(from, to, rendered, OffsetDateTime::now_utc()).await
    }

    /// Sends a preview using the current override or a validated draft and the configured transport.
    pub async fn send_test(
        &self,
        kind: EmailKind,
        to: &str,
        draft: Option<&Template>,
    ) -> Result<(), CanopyError> {
        let preview = TemplateStore::new(&self.meta).preview(kind, &self.app_name, draft).await?;
        self.deliver(to, preview).await
    }

    /// Sends an auth email, logging delivery failures and rate limited drops for uniform auth responses.
    pub async fn send(&self, kind: EmailKind, recipient: &Recipient<'_>) {
        if !self.enabled() {
            tracing::warn!(?kind, "No email transport is configured");
            return;
        }
        if !self.allow(kind, recipient.email).await {
            tracing::warn!(?kind, "Auth email dropped: too many to this recipient");
            return;
        }
        let result = match self.render(kind, recipient).await {
            Ok(rendered) => self.deliver(recipient.email, rendered).await,
            Err(error) => Err(error),
        };
        if let Err(error) = result {
            tracing::error!(?kind, code = error.code().as_str(), "Auth email failed");
        }
    }

    async fn allow(&self, kind: EmailKind, email: &str) -> bool {
        const WINDOW: Duration = Duration::from_secs(900);
        let mut sent = self.sent.lock().await;
        let now = Instant::now();
        let recent = sent.entry((kind, email.trim().to_lowercase())).or_default();
        recent.retain(|time| now.duration_since(*time) < WINDOW);
        if recent.len() >= 5 {
            return false;
        }
        recent.push(now);
        if sent.len() > 10_000 {
            sent.retain(|_, times| times.iter().any(|time| now.duration_since(*time) < WINDOW));
        }
        true
    }
}
