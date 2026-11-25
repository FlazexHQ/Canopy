//! Replay of the TypeScript mail renderer.

use canopy_mail::{EmailKind, Template, TemplateData, render_default, render_stored};
use serde::Deserialize;

#[derive(Deserialize)]
struct Vector {
    kind: EmailKind,
    data: Data,
    template: Option<Template>,
    expected: Template,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Data {
    app_name: String,
    email: String,
    url: Option<String>,
    otp: Option<String>,
    new_email: Option<String>,
}

#[test]
fn typescript_templates_match_byte_for_byte() -> Result<(), Box<dyn std::error::Error>> {
    let vectors: Vec<Vector> =
        serde_json::from_str(include_str!("../../../conformance/mail/templates.json"))?;
    assert_eq!(vectors.len(), 16);
    for vector in vectors {
        let data = TemplateData {
            app_name: &vector.data.app_name,
            email: &vector.data.email,
            url: vector.data.url.as_deref(),
            otp: vector.data.otp.as_deref(),
            new_email: vector.data.new_email.as_deref(),
        };
        let actual = match vector.template {
            Some(template) => render_stored(&template, &data)?,
            None => render_default(vector.kind, &data),
        };
        assert_eq!(actual, vector.expected, "{:?}", vector.kind);
    }
    Ok(())
}
