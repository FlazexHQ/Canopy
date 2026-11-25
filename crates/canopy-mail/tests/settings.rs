//! Integration with the current meta database template settings.

use canopy_mail::{
    EmailKind, MailSettings, Mailer, Recipient, Template, TemplateEdit, TemplateSettings, TemplateStore,
};
use canopy_mongo::mongodb::{
    Client, Database,
    bson::{DateTime, doc, oid::ObjectId},
};
use canopy_protocol::ErrorCode;

type TestResult = Result<(), Box<dyn std::error::Error>>;

async fn check_settings(meta: &Database) -> TestResult {
    let empty = TemplateSettings::load(meta).await?;
    assert_eq!(empty.version, 0);
    assert!(empty.templates.is_empty());
    let settings = meta.collection("settings");
    settings
        .insert_one(doc! {
            "_id": "email_templates@2",
            "version": 2,
            "templates": { "verification": { "subject": "Old", "text": "{{url}}" } },
        })
        .await?;
    settings
        .insert_one(doc! {
            "_id": "email_templates",
            "version": 3,
            "templates": { "verification": { "subject": "{{appName}} for {{email}}", "text": "{{url}}" } },
        })
        .await?;
    assert_eq!(TemplateSettings::load(meta).await?.version, 3);

    let mailer = Mailer::open(meta.clone(), "Example".into(), Some(MailSettings::default())).await?;
    assert!(mailer.enabled());
    let recipient = Recipient {
        email: "ada@example.com",
        url: Some("https://example.com/?token=abc"),
        ..Default::default()
    };
    let verification = mailer.render(EmailKind::Verification, &recipient).await?;
    assert_eq!(verification.subject, "Example for ada@example.com");
    assert_eq!(verification.text, "https://example.com/?token=abc");
    assert!(verification.html.is_none());
    let invite = mailer.render(EmailKind::Invite, &recipient).await?;
    assert_eq!(invite.subject, "You are invited to Example");
    mailer.deliver(recipient.email, verification).await?;

    let disabled = Mailer::open(meta.clone(), "Example".into(), None).await?;
    assert!(!disabled.enabled());
    assert_eq!(
        disabled.deliver(recipient.email, invite).await.err().map(|error| error.code()),
        Some(ErrorCode::Unavailable)
    );
    Ok(())
}

#[tokio::test]
async fn loads_current_templates_from_meta_settings() -> TestResult {
    let Ok(uri) = std::env::var("CANOPY_TEST_MONGODB_URI") else {
        return Ok(());
    };
    let client = Client::with_uri_str(uri).await?;
    let meta = client.database(&format!("canopy_mail_test_{}", ObjectId::new().to_hex()));
    let result = check_settings(&meta).await;
    let cleanup = meta.drop().await;
    result?;
    cleanup?;
    Ok(())
}

#[tokio::test]
async fn concurrent_template_edits_leave_one_current_version_and_one_history_document() -> TestResult {
    let Ok(uri) = std::env::var("CANOPY_TEST_MONGODB_URI") else {
        return Ok(());
    };
    let client = Client::with_uri_str(uri).await?;
    let meta = client.database(&format!("canopy_mail_edit_{}", ObjectId::new().to_hex()));
    let store = TemplateStore::new(&meta);
    let edit = |subject: &str| TemplateEdit {
        kind: EmailKind::Verification,
        template: Some(Template { subject: subject.to_owned(), text: "{{url}}".into(), html: None }),
        expected_version: 0,
        updated_by: "owner",
        updated_at: DateTime::from_millis(123_000),
        comment: Some("First edit"),
    };
    let (first, second) = tokio::join!(store.save(edit("First")), store.save(edit("Second")));
    let current = TemplateSettings::load(&meta).await;
    let history = store.history(50).await;
    meta.drop().await?;
    let (saved, rejected) = match (first, second) {
        (Ok(saved), Err(rejected)) | (Err(rejected), Ok(saved)) => (saved, rejected),
        _ => return Err("Expected exactly one successful edit".into()),
    };
    assert_eq!(rejected.code(), ErrorCode::Conflict);
    let current = current?;
    let history = history?;
    let entries = history.get_array("data")?;
    assert_eq!(entries.len(), 1);
    let entry = entries.first().and_then(|item| item.as_document()).ok_or("Missing history document")?;
    assert_eq!(current.version, 1);
    assert_eq!(entry.get_i32("version")?, 1);
    assert_eq!(entry.get_str("comment")?, "First edit");
    let subject = saved.0.get_document("data")?.get_str("subject")?;
    assert_eq!(
        current.templates.get(&EmailKind::Verification).map(|template| template.subject.as_str()),
        Some(subject)
    );
    assert_eq!(entry.get_document("templates")?.get_document("verification")?.get_str("subject")?, subject);
    Ok(())
}
