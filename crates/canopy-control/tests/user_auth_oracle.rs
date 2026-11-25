//! Replays app user administration and its effects on built in authentication.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::print_stderr)]

use std::sync::{
    Arc, Mutex,
    atomic::{AtomicI64, Ordering},
};

use canopy_authn::server::{AuthMail, AuthOptions, AuthRouter};
use canopy_control::{
    AdminRole, BoxFuture, Call, Clock, Delegate, Reply, SigningAlgorithm, SigningKeyOptions,
    SigningKeyRoutes, UserOptions, UserRoutes,
};
use canopy_http::{Request, Response};
use canopy_mail::{EmailKind, Recipient};
use canopy_mongo::mongodb::{
    Client, Database,
    bson::{Document, doc, oid::ObjectId},
};
use canopy_protocol::{Value, ejson};

const AUTH_ORIGIN: &str = "https://auth.canopy.test";
const APP_ORIGIN: &str = "https://app.canopy.test";
const SECRET: &str = "app user oracle fixture signing secret";

type TestResult<T> = Result<T, Box<dyn std::error::Error>>;

#[derive(Default)]
struct Outbox(Mutex<Vec<(EmailKind, String, String)>>);

impl AuthMail for Outbox {
    fn send<'a>(self: Arc<Self>, kind: EmailKind, recipient: Recipient<'a>) -> BoxFuture<'a, ()> {
        self.0.lock().unwrap().push((kind, recipient.email.into(), recipient.url.unwrap_or_default().into()));
        Box::pin(std::future::ready(()))
    }
}

fn json(value: &serde_json::Value) -> TestResult<Value> {
    Ok(ejson::parse(&value.to_string(), ejson::DecodeOptions::default())?)
}

fn asserted_json(reply: Reply, status: u16) -> TestResult<serde_json::Value> {
    assert_eq!(reply.status, status);
    let value = reply.body.ok_or("Missing admin response")?;
    Ok(serde_json::from_str(&ejson::stringify(&value)?)?)
}

fn operation(route: &str, id: &str, body: Option<Value>) -> Call {
    Call {
        route: route.into(),
        params: vec![("id".into(), id.into())],
        query: Vec::new(),
        headers: Vec::new(),
        body,
        role: AdminRole::Owner,
        production: false,
        actor: doc! {},
        origin: doc! {},
    }
}

fn check_user(actual: &serde_json::Value, expected: &serde_json::Value, id: &str) -> TestResult<()> {
    let mut expected: serde_json::Value = serde_json::from_str(&ejson::stringify(&json(expected)?)?)?;
    let fields = expected.as_object_mut().ok_or("Missing expected user")?;
    fields.insert("id".into(), id.into());
    fields.retain(|_, value| !value.is_null());
    assert_eq!(actual, &expected);
    Ok(())
}

fn check_error(
    result: Result<Reply, canopy_protocol::CanopyError>,
    step: &serde_json::Value,
) -> TestResult<()> {
    let Err(error) = result else {
        return Err("Expected the user operation to fail".into());
    };
    assert_eq!(error.code().as_str(), step["error"]["code"].as_str().unwrap());
    assert_eq!(error.message(), step["error"]["message"].as_str().unwrap());
    Ok(())
}

async fn auth_request(
    router: &AuthRouter,
    capture: &serde_json::Value,
    target: Option<&str>,
    cookie: Option<&str>,
    at: i64,
) -> TestResult<Response> {
    let request = &capture["request"];
    let mut http = Request::new(
        request["method"].as_str().ok_or("Missing method")?,
        target.or_else(|| request["path"].as_str()).ok_or("Missing path")?,
    );
    http.client_address = request["ip"].as_str().map(str::to_owned);
    for (key, value) in request["headers"].as_object().ok_or("Missing headers")? {
        http = http.with_header(key, value.as_str().ok_or("Invalid header")?);
    }
    if let Some(body) = request.get("body") {
        http = http.with_body(body.to_string());
    }
    if let Some(cookie) = cookie {
        http = http.with_header("cookie", cookie);
    }
    let response = router.handle_endpoint_at(&http, at).await;
    assert_eq!(
        Some(u64::from(response.status)),
        capture["response"]["status"].as_u64(),
        "{}: {}",
        http.target,
        String::from_utf8_lossy(&response.body),
    );
    Ok(response)
}

fn cookie(response: &Response) -> TestResult<&str> {
    Ok(response
        .headers
        .iter()
        .find(|(name, value)| name == "set-cookie" && value.starts_with("__Secure-canopy.session_token="))
        .and_then(|(_, value)| value.split(';').next())
        .ok_or("Missing session cookie")?)
}

async fn session_effects(
    routes: &UserRoutes,
    router: &AuthRouter,
    steps: &[serde_json::Value],
    at: i64,
) -> TestResult<()> {
    let created = asserted_json(
        routes.serve(&operation("POST users", "", Some(json(&steps[0]["operation"]["input"])?))).await?,
        201,
    )?;
    let id = created["id"].as_str().ok_or("Missing user id")?;
    check_user(&created, &steps[0]["result"], id)?;
    for step in &steps[1..3] {
        let call = operation("POST users", "", Some(json(&step["operation"]["input"])?));
        check_error(routes.serve(&call).await, step)?;
    }
    let mut list = operation("GET users", "", None);
    list.query.push(("email".into(), steps[3]["operation"]["input"]["email"].as_str().unwrap().into()));
    let listed = asserted_json(routes.serve(&list).await?, 200)?;
    assert_eq!(listed["total"], steps[3]["result"]["total"]["$numberInt"].as_str().unwrap().parse::<u64>()?);
    assert_eq!(listed["data"].as_array().ok_or("Missing users")?.len(), 1);
    check_user(&listed["data"][0], &steps[3]["result"]["users"][0], id)?;
    let fetched = asserted_json(routes.serve(&operation("GET users/:id", id, None)).await?, 200)?;
    check_user(&fetched, &steps[4]["result"], id)?;
    let signed_in = auth_request(router, &steps[5], None, None, at).await?;
    let signed_cookie = cookie(&signed_in)?;
    let token = auth_request(router, &steps[6], None, Some(signed_cookie), at).await?;
    assert!(serde_json::from_slice::<serde_json::Value>(&token.body)?["access_token"].is_string());
    let mut changes = steps[7]["operation"]["input"].clone();
    changes.as_object_mut().ok_or("Missing changes")?.remove("id");
    let changed =
        asserted_json(routes.serve(&operation("PATCH users/:id", id, Some(json(&changes)?))).await?, 200)?;
    check_user(&changed, &steps[7]["result"], id)?;
    let listed = asserted_json(routes.serve(&operation("GET users/:id/sessions", id, None)).await?, 200)?;
    assert_eq!(listed["data"], steps[8]["result"]);
    let banned = asserted_json(
        routes
            .serve(&operation(
                "POST users/:id/ban",
                id,
                Some(json(&serde_json::json!({
                    "reason": steps[9]["operation"]["input"]["reason"],
                    "until": steps[9]["operation"]["input"]["until"],
                }))?),
            ))
            .await?,
        200,
    )?;
    check_user(&banned, &steps[9]["result"], id)?;
    auth_request(router, &steps[10], None, Some(signed_cookie), at).await?;
    auth_request(router, &steps[11], None, None, at).await?;
    let unbanned = asserted_json(routes.serve(&operation("POST users/:id/unban", id, None)).await?, 200)?;
    check_user(&unbanned, &steps[12]["result"], id)?;
    let restored = auth_request(router, &steps[13], None, None, at).await?;
    let revoked = asserted_json(routes.serve(&operation("DELETE users/:id/sessions", id, None)).await?, 200)?;
    assert_eq!(revoked["revoked"], steps[14]["result"]["$numberInt"].as_str().unwrap().parse::<u64>()?);
    auth_request(router, &steps[10], None, Some(cookie(&restored)?), at).await?;
    assert_eq!(routes.serve(&operation("DELETE users/:id", id, None)).await?.status, 204);
    assert_eq!(steps[15]["result"], true);
    assert!(steps[16]["result"].is_null());
    let found = routes.serve(&operation("GET users/:id", id, None)).await;
    assert_eq!(found.err().ok_or("Deleted user still exists")?.code(), canopy_protocol::ErrorCode::NotFound);
    Ok(())
}

async fn invites(
    routes: &UserRoutes,
    router: &AuthRouter,
    outbox: &Outbox,
    steps: &[serde_json::Value],
    at: i64,
) -> TestResult<()> {
    let invited = asserted_json(
        routes
            .serve(&operation("POST users/invite", "", Some(json(&steps[0]["operation"]["input"])?)))
            .await?,
        201,
    )?;
    check_user(&invited, &steps[0]["result"], invited["id"].as_str().ok_or("Missing invite user id")?)?;
    let (kind, address, link) = {
        let mail = outbox.0.lock().unwrap();
        assert_eq!(mail.len(), 1);
        mail.first().cloned().ok_or("Missing invite")?
    };
    assert_eq!(kind, EmailKind::Invite);
    assert_eq!(address, steps[0]["mails"][0]["to"].as_str().ok_or("Missing invite recipient")?);
    let link = url::Url::parse(&link)?;
    assert_eq!(link.origin().ascii_serialization(), AUTH_ORIGIN);
    let token = link.query_pairs().find(|(key, _)| key == "token").ok_or("Missing invite token")?.1;
    let target =
        steps[1]["request"]["path"].as_str().ok_or("Missing invite path")?.replace("<mail-token-1>", &token);
    assert_eq!(target, &link[url::Position::BeforePath..]);
    let accepted = auth_request(router, &steps[1], Some(&target), None, at).await?;
    assert!(
        accepted
            .headers
            .iter()
            .any(|(key, value)| key == "location" && value == "https://app.canopy.test/welcome")
    );
    let mut token_request =
        Request::new("GET", "/auth/v1/get-session").with_header("cookie", cookie(&accepted)?);
    token_request.client_address = Some("203.0.113.1".into());
    let session = router.handle_endpoint_at(&token_request, at).await;
    let session: serde_json::Value = serde_json::from_slice(&session.body)?;
    assert_eq!(session["user"]["email"], address);
    assert_eq!(session["user"]["emailVerified"], true);
    let rejected = operation("POST users/invite", "", Some(json(&steps[2]["operation"]["input"])?));
    check_error(routes.serve(&rejected).await, &steps[2])?;
    assert_eq!(outbox.0.lock().unwrap().len(), 1);
    Ok(())
}

async fn imported_passwords(
    routes: &UserRoutes,
    router: &AuthRouter,
    auth: &Database,
    outbox: &Outbox,
    steps: &[serde_json::Value],
    at: i64,
) -> TestResult<()> {
    let result = asserted_json(
        routes
            .serve(&operation(
                "POST users/import",
                "",
                Some(json(&serde_json::json!({
                    "users": steps[0]["operation"]["input"],
                }))?),
            ))
            .await?,
        200,
    )?;
    let expected: serde_json::Value = serde_json::from_str(&ejson::stringify(&json(&steps[0]["result"])?)?)?;
    assert_eq!(result, expected);
    let users = auth.collection::<Document>("users");
    let accounts = auth.collection::<Document>("accounts");
    for step in steps.iter().skip(1).filter(|step| step["request"]["path"] == "/auth/v1/sign-in/email") {
        let response = auth_request(router, step, None, None, at).await?;
        let input = &step["request"]["body"];
        let email = input["email"].as_str().ok_or("Missing email")?;
        let user = users.find_one(doc! { "email": email }).await?.ok_or("Missing imported user")?;
        let credential = accounts
            .find_one(doc! { "userId": user.get("_id").ok_or("Missing id")?, "providerId": "credential" })
            .await?;
        if let Some(credential) = credential {
            let password = credential.get_str("password")?;
            if response.status == 200 {
                let plaintext = input["password"].as_str().ok_or("Missing password")?;
                assert!(
                    canopy_authn::passwords::verify_password(plaintext, password)
                        .is_some_and(|verified| !verified.needs_rehash)
                );
            } else {
                assert!(password.starts_with("canopy-legacy$"));
                let body: serde_json::Value = serde_json::from_slice(&response.body)?;
                assert_eq!(body, step["response"]["body"]);
            }
        } else {
            assert_eq!(email, "gone@example.com");
        }
    }
    auth_request(router, &steps[14], None, None, at).await?;
    let (kind, address, link) = {
        let mail = outbox.0.lock().unwrap();
        assert_eq!(mail.len(), 1);
        mail.first().cloned().ok_or("Missing verification email")?
    };
    assert_eq!(kind, EmailKind::Verification);
    assert_eq!(address, steps[14]["mails"][0]["to"].as_str().ok_or("Missing verification recipient")?);
    let link = url::Url::parse(&link)?;
    assert_eq!(link.origin().ascii_serialization(), AUTH_ORIGIN);
    let target = &link[url::Position::BeforePath..];
    assert_eq!(link.path(), "/auth/v1/verify-email");
    let response = auth_request(router, &steps[15], Some(target), None, at).await?;
    assert!(response.headers.iter().any(|(key, value)| key == "location" && value == "/"));
    let user = users.find_one(doc! { "email": address }).await?.ok_or("Missing verified user")?;
    assert!(user.get_bool("emailVerified")?);
    Ok(())
}

async fn replay(case: &serde_json::Value, auth: &Database, meta: &Database) -> TestResult<()> {
    let steps = case["steps"].as_array().ok_or("Missing steps")?;
    let at =
        ejson::parse_iso_date(steps[0]["clock"].as_str().ok_or("Missing clock")?).ok_or("Invalid clock")?;
    let now = Arc::new(AtomicI64::new(at));
    let clock: Clock = Arc::new(move || now.load(Ordering::Relaxed));
    let url = url::Url::parse(AUTH_ORIGIN)?;
    let mut options = AuthOptions::new(url.clone(), SECRET.into());
    options.trusted_origins.push(APP_ORIGIN.into());
    options.external.insert("magic_link", true.into());
    let outbox = Arc::new(Outbox::default());
    let router = AuthRouter::open(auth.clone(), meta.clone(), options, outbox.clone()).await?;
    let keys = SigningKeyRoutes::new(
        auth.clone(),
        SigningKeyOptions {
            algorithm: SigningAlgorithm::EdDSA,
            interval_ms: 2_592_000_000,
            secret: Some(SECRET.into()),
        },
        clock.clone(),
    )?;
    assert!(keys.tick("admin-users-oracle", 30_000).await?);
    let routes = UserRoutes::new(
        auth.clone(),
        meta.clone(),
        UserOptions {
            public_url: url,
            redirect_origins: vec![APP_ORIGIN.into()],
            min_password_length: 10,
            access_token_ttl_seconds: 600,
        },
        outbox.clone(),
        clock,
    );
    match case["id"].as_str() {
        Some("create-update-ban-delete") => session_effects(&routes, &router, steps, at).await,
        Some("invite") => invites(&routes, &router, &outbox, steps, at).await,
        Some("import-and-rehash") => imported_passwords(&routes, &router, auth, &outbox, steps, at).await,
        _ => Err("Unexpected case".into()),
    }
}

#[tokio::test]
async fn app_user_routes_interoperate_with_auth_router() -> TestResult<()> {
    let Ok(uri) = std::env::var("CANOPY_TEST_MONGODB_URI") else {
        eprintln!("Skipping app user auth effects because CANOPY_TEST_MONGODB_URI is unset");
        return Ok(());
    };
    let client = Client::with_uri_str(uri).await?;
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../../../conformance/http/auth/cases/admin-users.json"))?;
    for case in fixture["cases"].as_array().ok_or("Missing cases")? {
        let suffix = ObjectId::new().to_hex();
        let auth = client.database(&format!("canopy_user_{suffix}_auth"));
        let meta = client.database(&format!("canopy_user_{suffix}_meta"));
        let result = replay(case, &auth, &meta).await;
        auth.drop().await?;
        meta.drop().await?;
        result?;
    }
    Ok(())
}
