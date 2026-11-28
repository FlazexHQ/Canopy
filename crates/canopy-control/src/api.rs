//! The admin API router: the route table, authentication by session cookie, bearer session or admin API
//! token, the Origin and CSRF checks of cookie sessions, the routes tokens may not use, the forced password
//! change, RBAC, and the audit of every state changing request, refused ones included.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use canopy_http::{Request, Response, read_body};
use canopy_mongo::mongodb::bson::{Bson, Document, doc};
use canopy_protocol::{CanopyError, ErrorCode, Value};

use crate::accounts::{AdminSession, Transport, csrf_hash};
use crate::core::{Actor, RequestOrigin, details, err, to_value};
use crate::http::{
    CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE, check_origin, cookie, csrf_failure, empty, is_mutating,
    problem, same_secret, secure, set_header,
};
use crate::rbac::{Permission, can};
use crate::services::{Call, Delegate, Reply};
use crate::tokens::AdminTokens;
use crate::{Control, routes};

const MAX_BODY: u64 = 1024 * 1024;
const JSON_TYPES: [&str; 2] = ["application/json", "application/ejson"];

/// The route groups served by a delegate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Area {
    Data,
    Policies,
    Users,
    AuthKeys,
    Templates,
    Realtime,
}

/// The routes this crate serves itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Native {
    SetupStatus,
    SetupClaim,
    Login,
    Logout,
    Me,
    MePassword,
    MeTotp,
    MeTotpConfirm,
    Admins,
    AdminCreate,
    AdminUpdate,
    AdminResetTotp,
    AdminRemove,
    Tokens,
    TokenCreate,
    TokenRevoke,
    ApiKeys,
    ApiKeyCreate,
    ApiKeyRevoke,
    AuthProviders,
    Doctor,
    Audit,
    Logs,
    Settings,
    SettingsUpdate,
    RevokeAll,
    RotateMasterKey,
    Webhooks,
    DeadLetters,
    DeadLetterRetry,
    DeadLetterDiscard,
    WebhookRun,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Handler {
    Native(Native),
    Delegate(Area),
}

/// A route: its method and path, what it needs (`None` for public routes), its audit action and handler.
pub(crate) struct Route {
    pub(crate) method: &'static str,
    pub(crate) path: &'static str,
    pub(crate) permission: Option<Permission>,
    pub(crate) action: Option<&'static str>,
    pub(crate) handler: Handler,
}

impl Route {
    pub(crate) fn key(&self) -> String {
        format!("{} {}", self.method, self.path)
    }
}

const fn route(
    method: &'static str,
    path: &'static str,
    permission: Option<Permission>,
    action: Option<&'static str>,
    handler: Handler,
) -> Route {
    Route { method, path, permission, action, handler }
}

use Area::{AuthKeys, Data, Policies, Realtime, Templates, Users};
use Handler::{Delegate as D, Native as N};
use Permission as P;

/// Every route, in the order the TypeScript server registers them, which decides matching and `Allow`.
pub(crate) const ROUTES: &[Route] = &[
    route("GET", "setup", None, None, N(Native::SetupStatus)),
    route("POST", "setup", None, Some("setup.claim"), N(Native::SetupClaim)),
    route("POST", "login", None, Some("session.login"), N(Native::Login)),
    route("POST", "logout", Some(P::Session), Some("session.logout"), N(Native::Logout)),
    route("GET", "me", Some(P::Session), None, N(Native::Me)),
    route("POST", "me/password", Some(P::Session), Some("admin.password.change"), N(Native::MePassword)),
    route("POST", "me/totp", Some(P::Session), Some("admin.totp.enroll"), N(Native::MeTotp)),
    route("POST", "me/totp/confirm", Some(P::Session), Some("admin.totp.confirm"), N(Native::MeTotpConfirm)),
    route("GET", "admins", Some(P::AdminsRead), None, N(Native::Admins)),
    route("POST", "admins", Some(P::AdminsManage), Some("admin.create"), N(Native::AdminCreate)),
    route("PATCH", "admins/:id", Some(P::AdminsManage), Some("admin.update"), N(Native::AdminUpdate)),
    route(
        "POST",
        "admins/:id/reset-totp",
        Some(P::AdminsManage),
        Some("admin.totp.reset"),
        N(Native::AdminResetTotp),
    ),
    route("DELETE", "admins/:id", Some(P::AdminsManage), Some("admin.remove"), N(Native::AdminRemove)),
    route("GET", "tokens", Some(P::Session), None, N(Native::Tokens)),
    route("POST", "tokens", Some(P::Session), Some("admin_token.create"), N(Native::TokenCreate)),
    route("DELETE", "tokens/:id", Some(P::Session), Some("admin_token.revoke"), N(Native::TokenRevoke)),
    route("GET", "collections", Some(P::CollectionsRead), None, D(Data)),
    route(
        "PATCH",
        "collections/:collection",
        Some(P::CollectionsWrite),
        Some("collection.update"),
        D(Policies),
    ),
    route("GET", "collections/:collection/schema", Some(P::CollectionsRead), None, D(Data)),
    route("GET", "openapi", Some(P::CollectionsRead), None, D(Data)),
    route("POST", "graphql", Some(P::DocumentsRead), None, D(Data)),
    route("GET", "collections/:collection/stats", Some(P::CollectionsRead), None, D(Data)),
    route("GET", "collections/:collection/documents", Some(P::DocumentsRead), None, D(Data)),
    route("GET", "collections/:collection/documents/:id", Some(P::DocumentsRead), None, D(Data)),
    route(
        "POST",
        "collections/:collection/documents",
        Some(P::DocumentsWrite),
        Some("documents.insert"),
        D(Data),
    ),
    route(
        "PATCH",
        "collections/:collection/documents/:id",
        Some(P::DocumentsWrite),
        Some("documents.update"),
        D(Data),
    ),
    route(
        "PUT",
        "collections/:collection/documents/:id",
        Some(P::DocumentsWrite),
        Some("documents.replace"),
        D(Data),
    ),
    route(
        "DELETE",
        "collections/:collection/documents/:id",
        Some(P::DocumentsWrite),
        Some("documents.delete"),
        D(Data),
    ),
    route("GET", "policies", Some(P::PoliciesRead), None, D(Policies)),
    route("GET", "policies/:collection", Some(P::PoliciesRead), None, D(Policies)),
    route("POST", "policies/:collection/validate", Some(P::PoliciesSimulate), None, D(Policies)),
    route("POST", "policies/:collection/simulate", Some(P::PoliciesSimulate), None, D(Policies)),
    route("POST", "policies/:collection/explain", Some(P::PoliciesSimulate), None, D(Policies)),
    route(
        "POST",
        "policies/:collection/publish",
        Some(P::PoliciesPublish),
        Some("policy.publish"),
        D(Policies),
    ),
    route("GET", "policies/:collection/history", Some(P::PoliciesRead), None, D(Policies)),
    route(
        "POST",
        "policies/:collection/rollback",
        Some(P::PoliciesPublish),
        Some("policy.rollback"),
        D(Policies),
    ),
    route("GET", "contexts", Some(P::PoliciesRead), None, D(Policies)),
    route("POST", "contexts/validate", Some(P::PoliciesSimulate), None, D(Policies)),
    route("POST", "contexts/publish", Some(P::PoliciesPublish), Some("context.publish"), D(Policies)),
    route("GET", "contexts/history", Some(P::PoliciesRead), None, D(Policies)),
    route("POST", "contexts/rollback", Some(P::PoliciesPublish), Some("context.rollback"), D(Policies)),
    route("GET", "api-keys", Some(P::KeysRead), None, N(Native::ApiKeys)),
    route("POST", "api-keys", Some(P::KeysPublishable), Some("key.create"), N(Native::ApiKeyCreate)),
    route("DELETE", "api-keys/:id", Some(P::KeysPublishable), Some("key.revoke"), N(Native::ApiKeyRevoke)),
    route("GET", "users", Some(P::UsersRead), None, D(Users)),
    route("POST", "users/invite", Some(P::UsersManage), Some("user.invite"), D(Users)),
    route("POST", "users", Some(P::UsersManage), Some("user.create"), D(Users)),
    route("POST", "users/import", Some(P::UsersManage), Some("user.import"), D(Users)),
    route("GET", "users/:id", Some(P::UsersRead), None, D(Users)),
    route("PATCH", "users/:id", Some(P::UsersManage), Some("user.update"), D(Users)),
    route("POST", "users/:id/ban", Some(P::UsersManage), Some("user.ban"), D(Users)),
    route("POST", "users/:id/unban", Some(P::UsersManage), Some("user.unban"), D(Users)),
    route("DELETE", "users/:id", Some(P::UsersManage), Some("user.delete"), D(Users)),
    route("GET", "users/:id/sessions", Some(P::UsersRead), None, D(Users)),
    route("DELETE", "users/:id/sessions", Some(P::UsersManage), Some("user.sessions.revoke"), D(Users)),
    route("DELETE", "users/:id/sessions/:sid", Some(P::UsersManage), Some("user.sessions.revoke"), D(Users)),
    route("GET", "auth/providers", Some(P::SettingsRead), None, N(Native::AuthProviders)),
    route("GET", "auth/keys", Some(P::SettingsRead), None, D(AuthKeys)),
    route("POST", "auth/keys/rotate", Some(P::SettingsWrite), Some("auth.keys.rotate"), D(AuthKeys)),
    route("DELETE", "auth/keys/:kid", Some(P::SettingsWrite), Some("auth.keys.revoke"), D(AuthKeys)),
    route("GET", "auth/templates", Some(P::SettingsRead), None, D(Templates)),
    route("GET", "auth/templates/history", Some(P::SettingsRead), None, D(Templates)),
    route("POST", "auth/templates/:kind/preview", Some(P::SettingsRead), None, D(Templates)),
    route("PUT", "auth/templates/:kind", Some(P::SettingsWrite), Some("auth.templates.update"), D(Templates)),
    route(
        "DELETE",
        "auth/templates/:kind",
        Some(P::SettingsWrite),
        Some("auth.templates.reset"),
        D(Templates),
    ),
    route("GET", "realtime/stats", Some(P::RealtimeStats), None, D(Realtime)),
    route("GET", "realtime/connections", Some(P::RealtimeInspect), None, D(Realtime)),
    route("GET", "realtime/observers", Some(P::RealtimeInspect), None, D(Realtime)),
    route("GET", "realtime/events", Some(P::RealtimeInspect), None, D(Realtime)),
    route("GET", "realtime/trace/:eventId", Some(P::RealtimeInspect), None, D(Realtime)),
    route("POST", "realtime/token", Some(P::DocumentsRead), Some("realtime.token"), D(Realtime)),
    route("GET", "realtime/tail", Some(P::RealtimeInspect), None, D(Realtime)),
    route("GET", "doctor", Some(P::OpsDoctor), None, N(Native::Doctor)),
    route("GET", "audit", Some(P::OpsAudit), None, N(Native::Audit)),
    route("GET", "logs", Some(P::OpsAudit), None, N(Native::Logs)),
    route("GET", "settings", Some(P::SettingsRead), None, N(Native::Settings)),
    route("PATCH", "settings", Some(P::SettingsWrite), Some("settings.update"), N(Native::SettingsUpdate)),
    route(
        "POST",
        "settings/revoke-all-sessions",
        Some(P::AdminsManageOwners),
        Some("danger.revoke_all_sessions"),
        N(Native::RevokeAll),
    ),
    route(
        "POST",
        "settings/rotate-master-key",
        Some(P::AdminsManageOwners),
        Some("danger.rotate_master_key"),
        N(Native::RotateMasterKey),
    ),
    route("GET", "webhooks", Some(P::WebhooksRead), None, N(Native::Webhooks)),
    route("GET", "webhooks/dead-letters", Some(P::WebhooksRead), None, N(Native::DeadLetters)),
    route(
        "POST",
        "webhooks/dead-letters/:id/retry",
        Some(P::WebhooksManage),
        Some("webhooks.retry"),
        N(Native::DeadLetterRetry),
    ),
    route(
        "DELETE",
        "webhooks/dead-letters/:id",
        Some(P::WebhooksManage),
        Some("webhooks.discard"),
        N(Native::DeadLetterDiscard),
    ),
    route("POST", "webhooks/:name/run", Some(P::WebhooksManage), Some("webhooks.run"), N(Native::WebhookRun)),
];

/// Routes admin API tokens may not use: credentials and admin accounts, so a leaked token can neither outlive
/// its revocation through new credentials nor change who may do what.
const SESSION_ONLY: [&str; 12] = [
    "POST logout",
    "POST me/password",
    "POST me/totp",
    "POST me/totp/confirm",
    "POST admins",
    "PATCH admins/:id",
    "POST admins/:id/reset-totp",
    "DELETE admins/:id",
    "POST api-keys",
    "GET tokens",
    "POST tokens",
    "DELETE tokens/:id",
];

/// Actions whose stores write their own audit entries.
const SELF_AUDITED: [&str; 20] = [
    "setup.claim",
    "session.login",
    "session.logout",
    "admin.password.change",
    "admin.totp.enroll",
    "admin.totp.confirm",
    "admin.create",
    "admin.update",
    "admin.remove",
    "admin.totp.reset",
    "collection.update",
    "policy.publish",
    "policy.rollback",
    "context.publish",
    "context.rollback",
    "settings.update",
    "auth.templates.update",
    "auth.templates.reset",
    "admin_token.create",
    "admin_token.revoke",
];

/// Decodes `%XX` escapes as `decodeURIComponent` does, refusing malformed escapes and invalid UTF-8.
pub(crate) fn decode_component(text: &str, plus_is_space: bool) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while let Some(&byte) = bytes.get(index) {
        match byte {
            b'%' => {
                let hex = bytes.get(index + 1..index + 3)?;
                let value = u8::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok()?;
                out.push(value);
                index += 3;
            }
            b'+' if plus_is_space => {
                out.push(b' ');
                index += 1;
            }
            _ => {
                out.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8(out).ok()
}

/// Parses a query string as `URLSearchParams` does. Malformed escapes are kept as written.
pub(crate) fn parse_query(query: &str) -> Vec<(String, String)> {
    query
        .split('&')
        .filter(|part| !part.is_empty())
        .map(|part| {
            let (name, value) = part.split_once('=').unwrap_or((part, ""));
            let decode = |text: &str| {
                decode_component(text, true)
                    .unwrap_or_else(|| String::from_utf8_lossy(text.as_bytes()).replace('+', " "))
            };
            (decode(name), decode(value))
        })
        .collect()
}

/// One admin request in progress.
pub(crate) struct Context<'a> {
    pub(crate) request: &'a Request,
    pub(crate) query: Vec<(String, String)>,
    pub(crate) params: Vec<(String, String)>,
    pub(crate) origin: RequestOrigin,
    pub(crate) session: Option<AdminSession>,
    pub(crate) actor: Actor,
    pub(crate) route: &'static Route,
    audited: AtomicBool,
}

impl Context<'_> {
    pub(crate) fn param(&self, name: &str) -> &str {
        self.params.iter().find(|(key, _)| key == name).map_or("", |(_, value)| value.as_str())
    }

    pub(crate) fn query(&self, name: &str) -> Option<&str> {
        self.query.iter().find(|(key, _)| key == name).map(|(_, value)| value.as_str())
    }

    /// The request body as relaxed EJSON, `None` when empty.
    pub(crate) fn body(&self) -> Result<Option<Value>, CanopyError> {
        Ok(read_body(self.request, MAX_BODY, &JSON_TYPES)?.map(|(value, _)| value))
    }

    /// The session of a route that needs one.
    pub(crate) fn session(&self) -> Result<&AdminSession, CanopyError> {
        self.session.as_ref().ok_or_else(|| err(ErrorCode::Unauthorized, "Log in to use the admin API"))
    }

    pub(crate) fn params_document(&self) -> Document {
        self.params.iter().map(|(key, value)| (key.clone(), Bson::String(value.clone()))).collect()
    }

    /// An audit entry of this request: the fields given, then the actor and origin.
    pub(crate) fn entry(&self, fields: Document) -> Document {
        let mut entry = fields;
        if !entry.contains_key("actor") {
            entry.insert("actor", self.actor.to_document());
        }
        if !entry.contains_key("origin") {
            entry.insert("origin", self.origin.to_document());
        }
        entry
    }

    pub(crate) fn mark_audited(&self) {
        self.audited.store(true, Ordering::Relaxed);
    }

    /// Refuses the request unless the caller may do what `permission` covers.
    pub(crate) fn require(&self, control: &Control, permission: Permission) -> Result<(), CanopyError> {
        let role = self.session()?.user.role;
        if can(role, permission, control.production()) {
            Ok(())
        } else {
            Err(err(ErrorCode::Forbidden, format!("The {} role may not do this", role.as_str())))
        }
    }
}

/// A matched route with its path parameters.
type Matched = (&'static Route, Vec<(String, String)>);

fn find_route(method: &str, segments: &[String]) -> (Option<Matched>, Vec<&'static str>) {
    let mut allowed = Vec::new();
    for candidate in ROUTES {
        let parts: Vec<&str> = candidate.path.split('/').collect();
        if parts.len() != segments.len() {
            continue;
        }
        let mut params = Vec::new();
        let matched = parts.iter().zip(segments).all(|(part, segment)| match part.strip_prefix(':') {
            Some(name) => {
                params.push((name.to_owned(), segment.clone()));
                true
            }
            None => part == segment,
        });
        if !matched {
            continue;
        }
        allowed.push(candidate.method);
        if candidate.method == method {
            return (Some((candidate, params)), allowed);
        }
    }
    (None, allowed)
}

impl Control {
    async fn authenticate(
        &self,
        request: &Request,
        origin: &RequestOrigin,
    ) -> Result<Option<AdminSession>, CanopyError> {
        if let Some(header) = request.header("authorization") {
            let bearer = header
                .get(..6)
                .filter(|scheme| scheme.eq_ignore_ascii_case("bearer"))
                .and_then(|_| header.get(6..))
                .filter(|rest| rest.starts_with(' '))
                .map(|rest| rest.trim_start_matches(' '))
                .filter(|token| !token.is_empty() && !token.chars().any(char::is_whitespace));
            let Some(bearer) = bearer else { return Ok(None) };
            if AdminTokens::is_token(bearer) {
                return self.tokens.authenticate(bearer, &self.accounts, origin).await;
            }
            return Ok(self
                .accounts
                .session(bearer)
                .await?
                .filter(|session| session.transport == Transport::Bearer));
        }
        let Some(token) = cookie(request.header("cookie").as_deref(), SESSION_COOKIE) else {
            return Ok(None);
        };
        Ok(self.accounts.session(&token).await?.filter(|session| session.transport == Transport::Cookie))
    }

    async fn serve(
        &self,
        request: &Request,
        origin: RequestOrigin,
        route_path: &mut Option<&'static str>,
    ) -> Result<Response, CanopyError> {
        let (path, query) = request.target.split_once('?').unwrap_or((request.target.as_str(), ""));
        let rest = path.strip_prefix("/admin/v1").unwrap_or(path);
        let mut segments = Vec::new();
        for part in rest.split('/').filter(|part| !part.is_empty()) {
            segments.push(
                decode_component(part, false)
                    .ok_or_else(|| err(ErrorCode::ValidationFailed, "The path is not valid"))?,
            );
        }
        let (found, allowed) = find_route(&request.method, &segments);
        let Some((current, params)) = found else {
            if allowed.is_empty() {
                return Err(err(ErrorCode::NotFound, "Not found"));
            }
            let refusal = err(ErrorCode::InvalidQuery, format!("{} is not allowed here", request.method));
            let mut response = problem(&refusal, path, origin.request_id.as_deref().unwrap_or_default());
            response.status = 405;
            set_header(&mut response, "allow", allowed.join(", "));
            return Ok(response);
        };
        *route_path = Some(current.path);
        let mutating = is_mutating(&request.method);
        let mut own_origin = self.allowed_origins.clone();
        if let Some(host) = request.header("host") {
            own_origin.push(format!("http://{host}"));
            own_origin.push(format!("https://{host}"));
        }
        let session = match current.permission {
            None => None,
            Some(_) => Some(
                self.authenticate(request, &origin)
                    .await?
                    .ok_or_else(|| err(ErrorCode::Unauthorized, "Log in to use the admin API"))?,
            ),
        };
        let transport = session.as_ref().map(|session| session.transport);
        if mutating {
            check_origin(request, &own_origin, transport == Some(Transport::Cookie))?;
            if let Some(session) = session.as_ref().filter(|session| session.transport == Transport::Cookie) {
                let header = request.header(CSRF_HEADER).unwrap_or_default();
                let from_cookie =
                    cookie(request.header("cookie").as_deref(), CSRF_COOKIE).unwrap_or_default();
                if header.is_empty()
                    || !same_secret(&header, &from_cookie)
                    || !same_secret(&csrf_hash(&header), &session.csrf_hash)
                {
                    return Err(csrf_failure("The CSRF token is missing or does not match"));
                }
            }
        }
        let actor = match &session {
            None => Actor::system("anonymous"),
            Some(session) => {
                session.user.actor((session.transport == Transport::Token).then_some(session.id.as_str()))
            }
        };
        let context = Context {
            request,
            query: parse_query(query),
            params,
            origin,
            session,
            actor,
            route: current,
            audited: AtomicBool::new(false),
        };
        let fallback_action =
            || current.action.map_or_else(|| format!("{} {}", request.method, path), str::to_owned);
        if let Some(session) =
            context.session.as_ref().filter(|session| session.transport == Transport::Token)
        {
            self.audit
                .record(context.entry(doc! {
                    "action": "admin_token.use",
                    "actor": context.actor.to_document(),
                    "target": { "tokenId": &session.id },
                    "origin": context.origin.to_document(),
                    "details": { "method": &request.method, "path": path },
                }))
                .await?;
            if SESSION_ONLY.contains(&current.key().as_str()) {
                if mutating {
                    self.audit
                        .record(doc! {
                            "action": fallback_action(), "actor": context.actor.to_document(), "outcome": "denied",
                            "target": context.params_document(), "origin": context.origin.to_document(),
                            "details": { "reason": "session_required" },
                        })
                        .await?;
                }
                return Err(err(
                    ErrorCode::Forbidden,
                    "Admin API tokens cannot manage credentials or admins; sign in to do this",
                )
                .with_details("{\"reason\":\"session_required\"}"));
            }
        }
        if let Some(session) = &context.session {
            let open = matches!(current.permission, Some(Permission::Session))
                && ["me", "me/password", "logout"].contains(&current.path);
            if session.user.must_change_password && !open {
                return Err(err(ErrorCode::Forbidden, "Change your password first")
                    .with_details("{\"reason\":\"password_change_required\"}"));
            }
            if let Some(permission) = current.permission
                && !can(session.user.role, permission, self.production())
            {
                if mutating {
                    self.audit
                        .record(doc! {
                            "action": fallback_action(), "actor": context.actor.to_document(), "outcome": "denied",
                            "target": context.params_document(), "origin": context.origin.to_document(),
                        })
                        .await?;
                }
                return Err(err(
                    ErrorCode::Forbidden,
                    format!("The {} role may not do this", session.user.role.as_str()),
                ));
            }
        }
        let outcome = match current.handler {
            Handler::Native(native) => routes::serve(self, &context, native).await,
            Handler::Delegate(area) => self.delegate(&context, area).await,
        };
        let audited = context.audited.load(Ordering::Relaxed);
        match outcome {
            Ok(response) => {
                if mutating
                    && let Some(action) = current.action
                    && !audited
                    && response.status < 400
                    && !SELF_AUDITED.contains(&action)
                {
                    self.audit
                        .record(doc! {
                            "action": action, "actor": context.actor.to_document(),
                            "target": context.params_document(), "origin": context.origin.to_document(),
                        })
                        .await?;
                }
                Ok(response)
            }
            Err(error) => {
                if mutating && context.session.is_some() && error.code() == ErrorCode::Forbidden && !audited {
                    self.audit
                        .record(doc! {
                            "action": fallback_action(), "actor": context.actor.to_document(), "outcome": "denied",
                            "target": context.params_document(), "origin": context.origin.to_document(),
                            "details": { "message": error.message() },
                        })
                        .await?;
                }
                Err(error)
            }
        }
    }

    async fn delegate(&self, context: &Context<'_>, area: Area) -> Result<Response, CanopyError> {
        let missing = |message: &str| err(ErrorCode::NotFound, message);
        let delegate: &Arc<dyn Delegate> = match area {
            Area::Data => {
                self.services.data.as_ref().ok_or_else(|| missing("The data routes are not served here"))?
            }
            Area::Policies => {
                self.services.policies.as_ref().ok_or_else(|| missing("Policies are not served here"))?
            }
            Area::Users => {
                self.services.users.as_ref().ok_or_else(|| missing("Built in auth is not configured"))?
            }
            Area::AuthKeys => {
                self.services.auth_keys.as_ref().ok_or_else(|| missing("Built in auth is not configured"))?
            }
            Area::Templates => {
                self.services.templates.as_ref().ok_or_else(|| missing("Built in auth is not configured"))?
            }
            Area::Realtime => {
                self.services.realtime.as_ref().ok_or_else(|| missing("Realtime is turned off"))?
            }
        };
        let session = context.session()?;
        let call = Call {
            route: context.route.key(),
            params: context.params.clone(),
            query: context.query.clone(),
            headers: context.request.headers.clone(),
            body: context.body()?,
            role: session.user.role,
            production: self.production(),
            actor: context.actor.to_document(),
            origin: context.origin.to_document(),
        };
        let reply = delegate.serve(&call).await?;
        for entry in &reply.audit {
            self.audit.record(context.entry(entry.clone())).await?;
            context.mark_audited();
        }
        reply_response(reply)
    }

    /// Serves one `/admin/v1` request. `ip` is the client address the transport resolved, used for the login
    /// limits, the allowlist check and the audit log.
    pub async fn fetch(&self, request: &Request, ip: Option<&str>) -> Response {
        let request_id = request
            .header("x-request-id")
            .map(|id| id.encode_utf16().take(128).collect::<Vec<u16>>())
            .map_or_else(canopy_http::uuid_v7, |units| String::from_utf16_lossy(&units));
        let origin = RequestOrigin {
            ip: ip.map(str::to_owned),
            user_agent: request
                .header("user-agent")
                .map(|agent| String::from_utf16_lossy(&agent.encode_utf16().take(512).collect::<Vec<u16>>())),
            request_id: Some(request_id.clone()),
        };
        let path = request.target.split_once('?').map_or(request.target.as_str(), |(path, _)| path);
        let mut route_path = None;
        let mut response = match self.serve(request, origin, &mut route_path).await {
            Ok(response) => response,
            Err(error) => {
                if error.code().http_status() >= 500
                    && let Some(log) = &self.error_logger
                {
                    log(route_path, error.code());
                }
                problem(&error, path, &request_id)
            }
        };
        set_header(&mut response, "x-request-id", request_id);
        secure(&mut response);
        response
    }
}

/// A JSON response of a driver document.
pub(crate) fn respond(document: Document, status: u16) -> Result<Response, CanopyError> {
    crate::http::json(&to_value(&document)?, status)
}

fn reply_response(reply: Reply) -> Result<Response, CanopyError> {
    let mut response = match &reply.body {
        Some(body) => crate::http::json(body, reply.status)?,
        None => empty(reply.status),
    };
    if let Some(opening) = reply.stream_opening {
        response.body = opening;
    }
    for (name, value) in reply.headers {
        response.headers.push((name, value));
    }
    Ok(response)
}

/// The details text of a validation refusal with a reason.
pub(crate) fn reasoned(path: Option<&str>, reason: &str) -> String {
    match path {
        Some(path) => details(&doc! { "path": path, "reason": reason }),
        None => details(&doc! { "reason": reason }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_route_table_is_consistent() {
        let keys: Vec<String> = ROUTES.iter().map(Route::key).collect();
        let mut unique = keys.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(unique.len(), keys.len(), "a route is registered twice");
        for key in SESSION_ONLY {
            assert!(keys.iter().any(|route| route == key), "{key} is not a route");
        }
        for action in SELF_AUDITED {
            assert!(ROUTES.iter().any(|route| route.action == Some(action)), "{action} is no route's action");
        }
        for route in ROUTES.iter().filter(|route| is_mutating(route.method)) {
            let exempt = matches!(route.path, "graphql")
                || route.path.ends_with("/validate")
                || route.path.ends_with("/simulate")
                || route.path.ends_with("/explain")
                || route.path.ends_with("/preview");
            assert!(
                route.action.is_some() || exempt,
                "{} changes state without an audit action",
                route.key()
            );
        }
    }

    #[test]
    fn routes_match_by_length_and_report_allowed_methods() {
        let segments = |path: &str| path.split('/').map(str::to_owned).collect::<Vec<_>>();
        let (found, _) = find_route("POST", &segments("webhooks/nightly/run"));
        assert_eq!(
            found.map(|(route, params)| (route.path, params)),
            Some(("webhooks/:name/run", vec![("name".to_owned(), "nightly".to_owned())]))
        );
        let (found, allowed) = find_route("PUT", &segments("me"));
        assert!(found.is_none());
        assert_eq!(allowed, ["GET"]);
        let (found, allowed) = find_route("GET", &segments("nothing"));
        assert!(found.is_none() && allowed.is_empty());
        assert_eq!(decode_component("a%2Fb", false).as_deref(), Some("a/b"));
        assert_eq!(decode_component("%E0%A4", false), None);
        assert_eq!(
            parse_query("as=%7B%7D&limit=2&x"),
            vec![
                ("as".to_owned(), "{}".to_owned()),
                ("limit".to_owned(), "2".to_owned()),
                ("x".to_owned(), String::new())
            ]
        );
    }
}
