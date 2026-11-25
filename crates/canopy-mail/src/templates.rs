use canopy_protocol::{CanopyError, ErrorCode};
use regex::{Captures, Regex};
use serde::{Deserialize, Serialize};
use std::sync::LazyLock;

/// An auth email kind, serialized as in the meta database.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EmailKind {
    /// Confirm a new user's address.
    Verification,
    /// Sign in using a link.
    MagicLink,
    /// Deliver a one time code.
    Otp,
    /// Choose a new password.
    ResetPassword,
    /// Accept an invitation.
    Invite,
    /// Confirm a change of address.
    EmailChange,
}

/// Plain text template variables.
pub struct TemplateData<'a> {
    /// The app's display name.
    pub app_name: &'a str,
    /// The recipient address.
    pub email: &'a str,
    /// The link to follow.
    pub url: Option<&'a str>,
    /// The one time code.
    pub otp: Option<&'a str>,
    /// The proposed new address.
    pub new_email: Option<&'a str>,
}

/// A rendered message or an editable template containing markers.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Template {
    /// The subject line.
    pub subject: String,
    /// The plain text body.
    pub text: String,
    /// The optional HTML body.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub html: Option<String>,
}

const IGNORE: &str = "If you did not ask for this, you can ignore this email.";
pub(crate) const SPACE: &str =
    r"[\x09-\x0d\x20\u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]";
pub(crate) static MARKER: LazyLock<Result<Regex, regex::Error>> =
    LazyLock::new(|| Regex::new(&format!(r"\{{\{{{SPACE}*([A-Za-z]+){SPACE}*\}}\}}")));

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn replace_app(template: &str, app_name: &str) -> String {
    let Some((before, after)) = template.split_once("{app}") else {
        return template.into();
    };
    let mut result = String::from(before);
    let mut replacement = app_name.chars().peekable();
    while let Some(ch) = replacement.next() {
        if ch == '$' {
            let value = match replacement.peek() {
                Some('$') => Some("$"),
                Some('&') => Some("{app}"),
                Some('\x60') => Some(before),
                Some('\'') => Some(after),
                _ => None,
            };
            if let Some(value) = value {
                replacement.next();
                result.push_str(value);
                continue;
            }
        }
        result.push(ch);
    }
    result.push_str(after);
    result
}

fn link(subject: String, intro: &str, action: &str, outro: &str, url: &str) -> Template {
    Template {
        subject,
        text: format!("{intro}\n\n{url}\n\n{outro}\n"),
        html: Some(format!(
            "<p>{}</p><p><a href=\"{}\">{action}</a></p><p>{outro}</p>",
            escape_html(intro),
            escape_html(url)
        )),
    }
}

/// Renders a built in email with the supplied variables.
pub fn render_default(kind: EmailKind, data: &TemplateData<'_>) -> Template {
    let app = data.app_name;
    let url = data.url.unwrap_or_default();
    let (subject, intro, action, outro) = match kind {
        EmailKind::Verification => (
            "Confirm your email for {app}",
            "Follow this link to confirm your email address for {app}:",
            "Confirm email",
            IGNORE,
        ),
        EmailKind::MagicLink => {
            ("Your sign in link for {app}", "Follow this link to sign in to {app}:", "Sign in", IGNORE)
        }
        EmailKind::ResetPassword => (
            "Reset your password for {app}",
            "Follow this link to choose a new password for {app}:",
            "Reset password",
            IGNORE,
        ),
        EmailKind::Invite => (
            "You are invited to {app}",
            "You have been invited to {app}. Follow this link to accept and sign in:",
            "Accept invite",
            "If you were not expecting this invite, you can ignore this email.",
        ),
        EmailKind::EmailChange => {
            let target = data.new_email.unwrap_or("a new address");
            return link(
                format!("Confirm your email change for {app}"),
                &format!("Follow this link to confirm changing your {app} email to {target}:"),
                "Confirm change",
                IGNORE,
                url,
            );
        }
        EmailKind::Otp => {
            let code = data.otp.unwrap_or_default();
            return Template {
                subject: format!("Your {app} code is {code}"),
                text: format!(
                    "Your one time code for {app} is {code}. It expires in a few minutes.\n\n{IGNORE}\n"
                ),
                html: Some(format!(
                    "<p>Your one time code for {} is</p><p><strong>{}</strong></p><p>{IGNORE}</p>",
                    escape_html(app),
                    escape_html(code)
                )),
            };
        }
    };
    link(replace_app(subject, app), &replace_app(intro, app), action, outro, url)
}

/// Renders a stored template, escaping inserted HTML values and flattening subject line breaks.
pub fn render_stored(template: &Template, data: &TemplateData<'_>) -> Result<Template, CanopyError> {
    let marker =
        MARKER.as_ref().map_err(|_| CanopyError::new(ErrorCode::Internal, "Invalid email marker pattern"))?;
    let fill = |text: &str, html: bool| {
        marker
            .replace_all(text, |captures: &Captures<'_>| {
                let value = match captures.get(1).map(|name| name.as_str()) {
                    Some("appName") => data.app_name,
                    Some("email") => data.email,
                    Some("url") => data.url.unwrap_or_default(),
                    Some("otp") => data.otp.unwrap_or_default(),
                    Some("newEmail") => data.new_email.unwrap_or_default(),
                    _ => "",
                };
                if html { escape_html(value) } else { value.to_owned() }
            })
            .into_owned()
    };
    let mut subject = String::new();
    let mut line_break = false;
    for ch in fill(&template.subject, false).chars() {
        if matches!(ch, '\r' | '\n') {
            if !line_break {
                subject.push(' ');
            }
            line_break = true;
        } else {
            subject.push(ch);
            line_break = false;
        }
    }
    Ok(Template {
        subject,
        text: fill(&template.text, false),
        html: template.html.as_deref().map(|html| fill(html, true)),
    })
}
