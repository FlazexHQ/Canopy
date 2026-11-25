use canopy_mongo::mongodb::{
    Database,
    bson::{self, Bson, DateTime, Document, doc},
    error::{Error, ErrorKind, WriteFailure},
};
use canopy_protocol::{CanopyError, ErrorCode};
use futures_util::{FutureExt as _, TryStreamExt as _};
use regex::Regex;
use serde::{Deserialize as _, Deserializer, de};
use std::{collections::HashSet, sync::LazyLock};

use crate::templates::{MARKER, SPACE};
use crate::{EmailKind, Template, TemplateData, TemplateSettings, render_default, render_stored};

impl EmailKind {
    /// Built in kinds in Studio display order.
    pub const ALL: [Self; 6] = [
        Self::Verification,
        Self::MagicLink,
        Self::Otp,
        Self::ResetPassword,
        Self::Invite,
        Self::EmailChange,
    ];

    /// The name used in paths and settings.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Verification => "verification",
            Self::MagicLink => "magic_link",
            Self::Otp => "otp",
            Self::ResetPassword => "reset_password",
            Self::Invite => "invite",
            Self::EmailChange => "email_change",
        }
    }

    fn placeholders(self) -> &'static [&'static str] {
        match self {
            Self::Otp => &["appName", "email", "otp"],
            Self::EmailChange => &["appName", "email", "url", "newEmail"],
            _ => &["appName", "email", "url"],
        }
    }

    fn required(self) -> &'static [&'static str] {
        match self {
            Self::Otp => &["otp"],
            Self::EmailChange => &["url", "newEmail"],
            _ => &["url"],
        }
    }
}

static UNSAFE_HTML: LazyLock<Result<Regex, regex::Error>> = LazyLock::new(|| {
    Regex::new(&format!(r"<{SPACE}*(?i-u:script\b)|(?i-u:\bjavascript:)|{SPACE}(?i-u:on[a-z]+){SPACE}*="))
});

fn trim(text: &str) -> &str {
    text.trim_matches(|ch: char| (ch.is_whitespace() && ch != '\u{85}') || ch == '\u{feff}')
}

fn markers<'a>(pattern: &'a Regex, text: &'a str) -> impl Iterator<Item = &'a str> {
    pattern.captures_iter(text).filter_map(|capture| capture.get(1).map(|name| name.as_str()))
}

fn internal(message: &str) -> CanopyError {
    CanopyError::new(ErrorCode::Internal, message)
}

fn validate(kind: EmailKind, input: &Template) -> Result<Template, CanopyError> {
    let mut problems = Vec::new();
    let subject = trim(&input.subject);
    if subject.is_empty() {
        problems.push("the subject is empty".into());
    }
    if subject.encode_utf16().count() > 200 {
        problems.push("the subject has more than 200 characters".into());
    }
    if subject.contains(['\r', '\n']) {
        problems.push("the subject must be a single line".into());
    }
    if trim(&input.text).is_empty() {
        problems.push("the text body is empty".into());
    }
    if input.text.encode_utf16().count() > 20_000 {
        problems.push("the text body has more than 20000 characters".into());
    }
    let html = input.html.as_deref().filter(|html| !trim(html).is_empty());
    if let Some(html) = html {
        if html.encode_utf16().count() > 100_000 {
            problems.push("the HTML body has more than 100000 characters".into());
        }
        let pattern = UNSAFE_HTML.as_ref().map_err(|_| internal("Invalid email HTML pattern"))?;
        if pattern.is_match(html) {
            problems
                .push("the HTML body may not contain scripts, javascript: links or event handlers".into());
        }
    }
    let marker = MARKER.as_ref().map_err(|_| internal("Invalid email marker pattern"))?;
    let bodies = || markers(marker, &input.text).chain(markers(marker, html.unwrap_or_default()));
    let mut seen = HashSet::new();
    for name in markers(marker, subject).chain(bodies()).filter(|name| seen.insert(*name)) {
        if !["appName", "email", "url", "otp", "newEmail"].contains(&name) {
            problems.push(format!("{{{{{name}}}}} is not a placeholder"));
        } else if !kind.placeholders().contains(&name) {
            problems.push(format!("{{{{{name}}}}} has no value in {} emails", kind.as_str()));
        }
    }
    for name in kind.required() {
        if !bodies().any(|used| used == *name) {
            problems.push(format!("the body must contain {{{{{name}}}}}"));
        }
    }
    if !problems.is_empty() {
        return Err(CanopyError::new(
            ErrorCode::ValidationFailed,
            format!("The {} template is not valid: {}", kind.as_str(), problems.join("; ")),
        )
        .with_details(serde_json::json!({ "kind": kind.as_str(), "problems": problems }).to_string()));
    }
    Ok(Template { subject: subject.into(), text: input.text.clone(), html: html.map(str::to_owned) })
}

fn default_text(kind: EmailKind) -> Template {
    render_default(
        kind,
        &TemplateData {
            app_name: "{{appName}}",
            email: "{{email}}",
            url: Some("{{url}}"),
            otp: Some("{{otp}}"),
            new_email: Some("{{newEmail}}"),
        },
    )
}

fn view(kind: EmailKind, stored: Option<&Document>) -> Result<Document, CanopyError> {
    let mut result = doc! { "kind": kind.as_str() };
    if let Some(stored) = stored {
        result.extend(stored.clone());
        result.insert("source", "studio");
    } else {
        result.extend(template_document(&default_text(kind))?);
        result.insert("source", "default");
    }
    result.extend(doc! { "placeholders": kind.placeholders(), "required": kind.required() });
    Ok(result)
}

/// Encodes a template in API and persistence field order.
pub fn template_document(template: &Template) -> Result<Document, CanopyError> {
    bson::serialize_to_document(template).map_err(|_| internal("Could not encode email template"))
}

#[allow(clippy::cast_possible_truncation)]
fn stored_version(value: &Bson) -> Option<i64> {
    match value {
        Bson::Int32(value) if *value >= 0 => Some(i64::from(*value)),
        Bson::Int64(value) if *value >= 0 => Some(*value),
        Bson::Double(value) if value.fract() == 0.0 && (0.0..=9_007_199_254_740_992.0).contains(value) => {
            Some(*value as i64)
        }
        _ => None,
    }
}

pub(crate) fn deserialize_version<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
    stored_version(&Bson::deserialize(deserializer)?)
        .and_then(|version| u64::try_from(version).ok())
        .ok_or_else(|| de::Error::custom("Invalid stored email template version"))
}

fn version(current: Option<&Document>) -> i64 {
    current.and_then(|document| document.get("version")).and_then(stored_version).unwrap_or_default()
}

#[allow(clippy::cast_precision_loss)]
fn version_bson(version: i64) -> Bson {
    i32::try_from(version).map_or_else(|_| Bson::Double(version as f64), Bson::Int32)
}

fn overrides(current: Option<&Document>) -> Option<&Document> {
    current.and_then(|document| document.get_document("templates").ok())
}

fn load_error(_: Error) -> CanopyError {
    CanopyError::new(ErrorCode::Unavailable, "Could not load email templates")
}

/// An optimistic update or reset of an email template.
pub struct TemplateEdit<'a> {
    /// The template kind.
    pub kind: EmailKind,
    /// The draft to save, or none to restore the default.
    pub template: Option<Template>,
    /// The version the editor started from.
    pub expected_version: i64,
    /// The admin's id.
    pub updated_by: &'a str,
    /// The edit timestamp.
    pub updated_at: DateTime,
    /// An optional explanation of the change.
    pub comment: Option<&'a str>,
}

/// Versioned Studio overrides in the Canopy meta database.
pub struct TemplateStore {
    meta: Database,
}

impl TemplateStore {
    /// Opens the email template store in a meta database.
    pub fn new(meta: &Database) -> Self {
        Self { meta: meta.clone() }
    }

    /// Lists the effective templates and current version in Studio display order.
    pub async fn list(&self) -> Result<Document, CanopyError> {
        let current = self
            .meta
            .collection::<Document>("settings")
            .find_one(doc! { "_id": "email_templates" })
            .await
            .map_err(load_error)?;
        let templates = overrides(current.as_ref());
        let data = EmailKind::ALL
            .into_iter()
            .map(|kind| view(kind, templates.and_then(|all| all.get_document(kind.as_str()).ok())))
            .collect::<Result<Vec<_>, _>>()?;
        let version = version_bson(version(current.as_ref()));
        Ok(doc! { "version": version, "data": data })
    }

    /// Reads the most recent published versions.
    pub async fn history(&self, limit: i64) -> Result<Document, CanopyError> {
        let data: Vec<Document> = self
            .meta
            .collection::<Document>("settings")
            .find(doc! { "kind": "email_templates_version" })
            .sort(doc! { "version": -1 })
            .limit(limit.clamp(1, 200))
            .await
            .map_err(load_error)?
            .map_ok(|document| {
                let mut entry = Document::new();
                for (source, target) in [
                    ("version", "version"),
                    ("changed", "kind"),
                    ("change", "change"),
                    ("templates", "templates"),
                    ("updatedAt", "updatedAt"),
                    ("updatedBy", "updatedBy"),
                    ("comment", "comment"),
                ] {
                    if let Some(value) = document.get(source) {
                        entry.insert(target, value.clone());
                    }
                }
                entry
            })
            .try_collect()
            .await
            .map_err(load_error)?;
        Ok(doc! { "data": data })
    }

    /// Renders a draft or the effective template with sample values.
    pub async fn preview(
        &self,
        kind: EmailKind,
        app_name: &str,
        draft: Option<&Template>,
    ) -> Result<Template, CanopyError> {
        let current = TemplateSettings::load(&self.meta).await?;
        if let Some(draft) = draft {
            validate(kind, draft)?;
        }
        let default;
        let template = match draft.or_else(|| current.templates.get(&kind)) {
            Some(template) => template,
            None => {
                default = default_text(kind);
                &default
            }
        };
        render_stored(
            template,
            &TemplateData {
                app_name,
                email: "ada@example.com",
                url: Some("https://app.example.com/auth/v1/verify?token=preview"),
                otp: Some("482913"),
                new_email: Some("ada.lovelace@example.com"),
            },
        )
    }

    /// Saves or resets a template atomically with its history and returns the reply and audit fields.
    pub async fn save(&self, edit: TemplateEdit<'_>) -> Result<(Document, Document), CanopyError> {
        let template = edit
            .template
            .as_ref()
            .map(|draft| validate(edit.kind, draft).and_then(|valid| template_document(&valid)))
            .transpose()?;
        let settings = self.meta.collection::<Document>("settings");
        let mut session = settings.client().start_session().await.map_err(load_error)?;
        let result = session.start_transaction().and_run(
            (&settings, &edit, &template),
            |session, (settings, edit, template)| async move {
                let key = doc! { "_id": "email_templates" };
                let current = settings.find_one(key.clone()).session(&mut *session).await?;
                let version = version(current.as_ref());
                if version != edit.expected_version {
                    return Err(Error::custom(CanopyError::new(ErrorCode::Conflict,
                        format!("The email templates changed since you loaded them: version {version} is in force"))
                        .with_details(format!(r#"{{"currentVersion":{version}}}"#))));
                }
                let mut templates = overrides(current.as_ref()).cloned().unwrap_or_default();
                let name = edit.kind.as_str();
                let before = templates.get(name).cloned().unwrap_or(Bson::Null);
                let after = if let Some(template) = template {
                    templates.insert(name, template.clone());
                    Bson::Document(template.clone())
                } else {
                    templates.remove(name);
                    Bson::Null
                };
                let next_version = version.checked_add(1).ok_or_else(|| Error::custom(internal("Email template version overflow")))?;
                let next = version_bson(next_version);
                let change = if template.is_some() { "update" } else { "reset" };
                settings.update_one(key, doc! { "$set": {
                    "templates": &templates, "updatedAt": edit.updated_at,
                    "updatedBy": edit.updated_by, "version": &next,
                }}).upsert(true).session(&mut *session).await?;
                let mut history = doc! {
                    "_id": format!("email_templates@{next_version}"), "kind": "email_templates_version",
                    "version": &next, "changed": name, "change": change, "templates": templates,
                    "updatedAt": edit.updated_at, "updatedBy": edit.updated_by,
                };
                let mut audit = doc! {
                    "action": format!("auth.templates.{change}"), "target": { "template": name },
                    "diff": { "before": before, "after": after }, "details": { "version": &next },
                };
                if let Some(comment) = edit.comment.filter(|comment| !comment.is_empty()) {
                    history.insert("comment", comment);
                    audit.insert("comment", comment);
                }
                settings.insert_one(history).session(session).await?;
                let data = view(edit.kind, template.as_ref()).map_err(Error::custom)?;
                Ok((doc! { "version": next, "data": data }, audit))
            }.boxed(),
        ).await;
        result.map_err(|error| {
            if let Some(custom) = error.get_custom::<CanopyError>() {
                custom.clone()
            } else if matches!(error.kind.as_ref(), ErrorKind::Write(WriteFailure::WriteError(write)) if write.code == 11000) {
                CanopyError::new(ErrorCode::Conflict, "The email templates changed while saving; reload and try again")
            } else {
                CanopyError::new(ErrorCode::Unavailable, "Could not save email templates")
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn typescript_versions_above_int32_decode_as_integers() -> Result<(), Box<dyn std::error::Error>> {
        let document = doc! { "version": 2_147_483_648.0, "templates": {} };
        assert_eq!(version(Some(&document)), 2_147_483_648);
        let settings: TemplateSettings = bson::deserialize_from_document(document)?;
        assert_eq!(settings.version, 2_147_483_648);
        assert_eq!(version_bson(2_147_483_649), Bson::Double(2_147_483_649.0));
        Ok(())
    }

    #[test]
    fn validation_counts_utf16_and_reports_problems_in_template_order() -> Result<(), CanopyError> {
        let draft = Template {
            subject: format!("{{{{unknown}}}}{}", "🙂".repeat(100)),
            text: "{{otp}}".into(),
            html: Some("<div\u{a0}onClick = 'bad()'>{{unknown}}</div>".into()),
        };
        let error = validate(EmailKind::Verification, &draft)
            .err()
            .ok_or_else(|| internal("Expected invalid email template"))?;
        assert_eq!(error.code(), ErrorCode::ValidationFailed);
        assert_eq!(
            error.message(),
            concat!(
                "The verification template is not valid: the subject has more than 200 characters; ",
                "the HTML body may not contain scripts, javascript: links or event handlers; ",
                "{{unknown}} is not a placeholder; {{otp}} has no value in verification emails; ",
                "the body must contain {{url}}",
            )
        );
        Ok(())
    }
}
