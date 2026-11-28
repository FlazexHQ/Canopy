use canopy_mail::{EmailKind, Template, TemplateEdit, TemplateStore, template_document};
use canopy_mongo::mongodb::{
    Database,
    bson::{DateTime, doc},
};
use canopy_protocol::{CanopyError, ErrorCode, Value, ejson::js_string_to_number};

use crate::core::to_value;
use crate::schema::{Schema, integer, js_number, optional, string};
use crate::{BoxFuture, Call, Clock, Delegate, Reply};

const MAX_SAFE_VERSION: i64 = 9_007_199_254_740_991;

fn fields() -> Vec<(&'static str, Schema)> {
    vec![("subject", string(0, 1000)), ("text", string(0, 100_000)), ("html", optional(string(0, 200_000)))]
}

fn field<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    match value {
        Some(Value::Document(document)) => document.get(key),
        _ => None,
    }
}

fn text(value: Option<&Value>) -> Option<&str> {
    match value {
        Some(Value::String(text)) => Some(text),
        _ => None,
    }
}

fn template(body: Option<&Value>) -> Template {
    Template {
        subject: text(field(body, "subject")).unwrap_or_default().into(),
        text: text(field(body, "text")).unwrap_or_default().into(),
        html: text(field(body, "html")).map(str::to_owned),
    }
}

fn kind(call: &Call) -> Result<EmailKind, CanopyError> {
    let name = call.param("kind");
    EmailKind::ALL
        .into_iter()
        .find(|kind| kind.as_str() == name)
        .ok_or_else(|| CanopyError::new(ErrorCode::NotFound, format!("No email template {name}")))
}

/// Admin email template routes for deployments with built in auth.
pub struct TemplateRoutes {
    store: TemplateStore,
    app_name: String,
    clock: Clock,
}

impl TemplateRoutes {
    /// Uses the supplied meta database, app name, and admin clock.
    pub fn new(meta: &Database, app_name: String, clock: Clock) -> Self {
        Self { store: TemplateStore::new(meta), app_name, clock }
    }

    #[allow(clippy::cast_possible_truncation)]
    async fn dispatch(&self, call: &Call) -> Result<Reply, CanopyError> {
        let body = call.body.as_ref();
        let document = match call.route.as_str() {
            "GET auth/templates" => self.store.list().await?,
            "GET auth/templates/history" => {
                let limit = call
                    .query("limit")
                    .and_then(js_string_to_number)
                    .filter(|limit| *limit != 0.0 && !limit.is_nan())
                    .unwrap_or(50.0);
                self.store.history(limit.clamp(1.0, 200.0) as i64).await?
            }
            "POST auth/templates/:kind/preview" => {
                let kind = kind(call)?;
                Schema::Object(vec![("template", optional(Schema::Object(fields())))]).check(body, "")?;
                let draft = field(body, "template").map(|value| template(Some(value)));
                let preview = self.store.preview(kind, &self.app_name, draft.as_ref()).await?;
                doc! { "kind": kind.as_str(), "rendered": template_document(&preview)? }
            }
            "PUT auth/templates/:kind" | "DELETE auth/templates/:kind" => {
                let kind = kind(call)?;
                let (template, expected_version, comment) = if call.route.starts_with("PUT") {
                    let mut fields = fields();
                    fields.push(("expectedVersion", integer(0, MAX_SAFE_VERSION)));
                    fields.push(("comment", optional(string(0, 2000))));
                    Schema::Object(fields).check(body, "")?;
                    let version = field(body, "expectedVersion").and_then(js_number).unwrap_or_default();
                    (Some(template(body)), version as i64, text(field(body, "comment")))
                } else {
                    let version = js_string_to_number(call.query("expectedVersion").unwrap_or_default())
                        .filter(|version| {
                            version.fract() == 0.0 && (0.0..=9_007_199_254_740_991.0).contains(version)
                        })
                        .ok_or_else(|| {
                            CanopyError::new(
                                ErrorCode::ValidationFailed,
                                "expectedVersion must be a version number",
                            )
                        })?;
                    (None, version as i64, call.query("comment"))
                };
                let updated_by = call
                    .actor
                    .get_str("id")
                    .map_err(|_| CanopyError::new(ErrorCode::Internal, "Missing admin actor id"))?;
                let (result, mut audit) = self
                    .store
                    .save(TemplateEdit {
                        kind,
                        template,
                        expected_version,
                        updated_by,
                        updated_at: DateTime::from_millis((self.clock)()),
                        comment,
                    })
                    .await?;
                let action = audit.remove("action").ok_or_else(|| {
                    CanopyError::new(ErrorCode::Internal, "Missing email template audit action")
                })?;
                let mut entry = doc! { "action": action, "actor": &call.actor };
                entry.extend(audit);
                return Ok(Reply::json(200, to_value(&result)?).audited(entry));
            }
            _ => return Err(CanopyError::new(ErrorCode::NotFound, "No email template route")),
        };
        Ok(Reply::json(200, to_value(&document)?))
    }
}

impl Delegate for TemplateRoutes {
    fn serve<'a>(&'a self, call: &'a Call) -> BoxFuture<'a, Result<Reply, CanopyError>> {
        Box::pin(self.dispatch(call))
    }
}
