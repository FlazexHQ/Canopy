//! Canopy's control plane in Rust: the `/admin/v1` API. Admin accounts live in the meta database's
//! `admin_users`, apart from app users, with their own password and TOTP sign in, cookie and bearer sessions
//! (cookie sessions need the CSRF token and an allowed `Origin` on every change), long lived admin API
//! tokens, and the RBAC of the owner, admin, developer and viewer roles. Every state changing request is
//! audited in `audit_log`, refused ones included.
//!
//! The routes the control plane owns are served here: setup, login and the own account, admins, admin API
//! tokens, API keys, the doctor, the audit and request logs, settings, the danger zone and the webhook queue.
//! The route groups other parts of Canopy own (policies, email templates, the data routes, the realtime
//! inspector, app users and signing keys) are served through [`Delegate`]s, after the same authentication,
//! CSRF, RBAC and audit.

mod accounts;
mod api;
mod api_keys;
mod auth_keys;
mod core;
mod data;
mod http;
mod openapi;
mod passwords;
mod policies;
mod rate_limit;
mod rbac;
mod realtime;
mod routes;
mod schema;
mod secrets;
mod services;
mod settings;
mod templates;
mod tokens;
pub use canopy_authn::totp;

use std::sync::Arc;

use canopy_mongo::mongodb::bson::{Document, doc};
use canopy_mongo::mongodb::{Client, Database};
use canopy_protocol::CanopyError;

pub use crate::auth_keys::{Algorithm as SigningAlgorithm, SigningKeyOptions, SigningKeyRoutes};
pub use crate::core::{Actor, Clock, RequestOrigin, system_clock};
pub use crate::data::DataRoutes;
pub use crate::http::{API_CSP, CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE};
pub use crate::policies::PolicyRoutes;
pub use crate::rbac::{ADMIN_ROLES, AdminRole, Permission, ROLE_NAMES, can};
pub use crate::realtime::{InspectionQuery, Inspector, RealtimeRoutes, ViewSigner};
pub use crate::services::{
    BoxFuture, Call, Delegate, MetaStatus, NoStatus, PolicyStatus, RealtimeStatus, Reply, Status,
};
pub use crate::templates::TemplateRoutes;

use crate::accounts::AdminAccounts;
use crate::api_keys::ApiKeyStore;
use crate::core::AuditLog;
use crate::secrets::SecretBox;
use crate::settings::SettingsStore;
use crate::tokens::AdminTokens;

/// The environment the server runs in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Environment {
    /// Local development.
    Development,
    /// Production: developers may not publish or edit data, and missing protections fail the doctor.
    Production,
    /// Automated tests.
    Test,
}

/// The webhooks the admin API shows and operates.
pub struct WebhookAdmin {
    /// The running webhooks.
    pub webhooks: Arc<canopy_webhooks::Webhooks>,
    /// The hook definitions in config order, as given to `canopy_webhooks::Webhooks::new`.
    pub definitions: Vec<Document>,
}

/// The route groups served elsewhere. A missing group answers `404`.
#[derive(Default, Clone)]
pub struct Services {
    /// Collections, schemas, statistics, OpenAPI, the GraphQL explorer and document reads and writes.
    pub data: Option<Arc<dyn Delegate>>,
    /// Policies and context lookups: reads, validation, simulation, explain, publishing and rollback.
    pub policies: Option<Arc<dyn Delegate>>,
    /// App users of built in auth.
    pub users: Option<Arc<dyn Delegate>>,
    /// The signing keys of built in auth.
    pub auth_keys: Option<Arc<dyn Delegate>>,
    /// The email templates of built in auth.
    pub templates: Option<Arc<dyn Delegate>>,
    /// The realtime inspector and view tokens.
    pub realtime: Option<Arc<dyn Delegate>>,
}

/// Reports a failed admin request with its static route path and error code.
pub type ErrorLogger = Arc<dyn Fn(Option<&'static str>, canopy_protocol::ErrorCode) + Send + Sync>;

/// Everything the admin API works on.
pub struct ControlOptions {
    /// The deployment's MongoDB client.
    pub client: Client,
    /// The application database.
    pub database: String,
    /// The meta database.
    pub meta_database: String,
    /// The environment.
    pub environment: Environment,
    /// The public URL, whose origin may send state changing requests.
    pub public_url: Option<String>,
    /// More origins allowed to send state changing requests.
    pub origins: Vec<String>,
    /// Seals stored secrets; required in production.
    pub master_key: Option<String>,
    /// Earlier master keys whose sealed secrets still open, during a rotation.
    pub previous_master_keys: Vec<String>,
    /// The private listener of `/admin`, when it has one.
    pub admin_listen: Option<String>,
    /// Collections whose config turns search on, for the doctor.
    pub search_collections: Vec<String>,
    /// The sign in methods of the config, without secrets, as `GET /admin/v1/auth/providers` shows them.
    pub auth_providers: Document,
    /// The webhooks, when the config has triggers or schedules.
    pub webhooks: Option<WebhookAdmin>,
    /// The route groups served elsewhere.
    pub services: Services,
    /// What the doctor and the danger zone read from the rest of the server.
    pub status: Arc<dyn Status>,
    /// Reports errors with a server status.
    pub error_logger: Option<ErrorLogger>,
    /// The clock.
    pub now: Clock,
}

impl ControlOptions {
    /// Options for a server with the system clock, no webhooks, no delegates and external auth.
    pub fn new(
        client: Client,
        database: &str,
        meta_database: &str,
        environment: Environment,
    ) -> ControlOptions {
        ControlOptions {
            client,
            database: database.to_owned(),
            meta_database: meta_database.to_owned(),
            environment,
            public_url: None,
            origins: Vec::new(),
            master_key: None,
            previous_master_keys: Vec::new(),
            admin_listen: None,
            search_collections: Vec::new(),
            auth_providers: doc! { "mode": "external", "providers": [] },
            webhooks: None,
            services: Services::default(),
            status: Arc::new(NoStatus),
            error_logger: None,
            now: system_clock(),
        }
    }
}

/// The admin API.
pub struct Control {
    client: Client,
    database: String,
    meta: Database,
    environment: Environment,
    allowed_origins: Vec<String>,
    admin_listen: Option<String>,
    search_collections: Vec<String>,
    auth_providers: Document,
    webhooks: Option<WebhookAdmin>,
    services: Services,
    status: Arc<dyn Status>,
    now: Clock,
    error_logger: Option<ErrorLogger>,
    audit: AuditLog,
    accounts: AdminAccounts,
    tokens: AdminTokens,
    keys: ApiKeyStore,
    settings: SettingsStore,
}

fn origin_of(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    let authority = rest.split(['/', '?', '#']).next()?;
    Some(format!("{}://{}", scheme.to_ascii_lowercase(), authority.to_ascii_lowercase()))
}

impl Control {
    /// Builds the admin API. It reads and writes only the meta database, besides the application database
    /// commands of the doctor.
    pub fn new(options: ControlOptions) -> Control {
        let meta = options.client.database(&options.meta_database);
        let audit = AuditLog::new(&meta, Arc::clone(&options.now));
        let secrets = SecretBox::new(options.master_key.as_deref(), &options.previous_master_keys);
        let accounts =
            AdminAccounts::new(&options.client, &meta, audit.clone(), secrets, Arc::clone(&options.now));
        let tokens =
            AdminTokens::new(meta.collection("admin_tokens"), audit.clone(), Arc::clone(&options.now));
        let keys = ApiKeyStore::new(meta.collection("api_keys"), Arc::clone(&options.now));
        let settings = SettingsStore::new(&meta, audit.clone(), Arc::clone(&options.now));
        let mut allowed_origins = options.origins;
        if let Some(origin) = options.public_url.as_deref().and_then(origin_of) {
            allowed_origins.push(origin);
        }
        Control {
            client: options.client,
            database: options.database,
            meta,
            environment: options.environment,
            allowed_origins,
            admin_listen: options.admin_listen,
            search_collections: options.search_collections,
            auth_providers: options.auth_providers,
            webhooks: options.webhooks,
            services: options.services,
            status: options.status,
            now: options.now,
            error_logger: options.error_logger,
            audit,
            accounts,
            tokens,
            keys,
            settings,
        }
    }

    fn now(&self) -> i64 {
        (self.now)()
    }

    fn production(&self) -> bool {
        self.environment == Environment::Production
    }

    /// On a server that was never claimed, makes a one time setup token for the first owner and stores its
    /// hash. Returns `None` once an owner exists. Print it where the operator sees it, never in a response.
    pub async fn create_setup_token(&self) -> Result<Option<String>, CanopyError> {
        self.accounts.create_setup_token().await
    }

    /// Creates an admin without a session, for bootstrap tools that already hold the meta database. Returns
    /// the account and its generated password, which must be changed at first login.
    pub async fn create_admin(
        &self,
        email: &str,
        role: AdminRole,
        name: Option<&str>,
        actor: &Actor,
    ) -> Result<Document, CanopyError> {
        self.accounts.create_bootstrap(email, role, name, actor).await
    }

    /// Every route as `METHOD path` with `:name` parameters, such as `GET users/:id`.
    pub fn routes() -> Vec<String> {
        api::ROUTES.iter().map(api::Route::key).collect()
    }
}

/// A sign in method of built in auth as `GET /admin/v1/auth/providers` shows it, without secrets.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderView {
    /// The provider id, such as `github` or the id of a generic OIDC provider.
    pub id: String,
    /// The OAuth client id, for social and OIDC providers.
    pub client_id: Option<String>,
    /// The discovery URL, for OIDC providers.
    pub issuer: Option<String>,
}

/// The built in sign in methods of a config.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuiltinMethods {
    /// Email and password.
    pub email_password: bool,
    /// Magic links.
    pub magic_link: bool,
    /// One time codes by email.
    pub email_otp: bool,
    /// Anonymous users.
    pub anonymous: bool,
    /// The configured social providers, in config order.
    pub social: Vec<ProviderView>,
    /// The generic OIDC providers, in config order.
    pub oidc: Vec<ProviderView>,
}

/// The `GET /admin/v1/auth/providers` document of built in auth: the four built in methods, then every well
/// known social provider and every configured one, then the OIDC providers.
pub fn builtin_providers(methods: &BuiltinMethods) -> Document {
    use canopy_mongo::mongodb::bson::Bson;
    let mut providers: Vec<Bson> = [
        ("email", methods.email_password),
        ("magic-link", methods.magic_link),
        ("email-otp", methods.email_otp),
        ("anonymous", methods.anonymous),
    ]
    .into_iter()
    .map(|(id, enabled)| Bson::Document(doc! { "id": id, "enabled": enabled, "configured": true }))
    .collect();
    let mut ids: Vec<String> =
        ["google", "github", "apple", "microsoft", "discord"].map(str::to_owned).to_vec();
    for provider in &methods.social {
        if !ids.contains(&provider.id) {
            ids.push(provider.id.clone());
        }
    }
    for id in ids {
        let entry = match methods.social.iter().find(|provider| provider.id == id) {
            None => doc! { "id": &id, "enabled": false, "configured": false },
            Some(provider) => {
                let mut entry = doc! { "id": &id, "enabled": true, "configured": true };
                if let Some(client) = &provider.client_id {
                    entry.insert("clientId", client);
                }
                entry
            }
        };
        providers.push(Bson::Document(entry));
    }
    for provider in &methods.oidc {
        let mut entry = doc! { "id": &provider.id, "enabled": true, "configured": true };
        if let Some(client) = &provider.client_id {
            entry.insert("clientId", client);
        }
        if let Some(issuer) = &provider.issuer {
            entry.insert("issuer", issuer);
        }
        providers.push(Bson::Document(entry));
    }
    doc! { "mode": "builtin", "providers": providers }
}
