use std::error::Error;
use std::sync::Arc;

use canopy_authn::server::AuthMail;
use canopy_control::{Control, ControlOptions, Environment, UserOptions, UserRoutes};
use canopy_http::Request;
use canopy_mail::{EmailKind, Recipient};
use canopy_mongo::mongodb::{
    Database,
    bson::{DateTime, Document, doc},
};
use http_body_util::{BodyExt as _, Full};
use hyper::{
    Request as HttpRequest, Response,
    body::{Bytes, Incoming},
    server::conn::http1,
    service::service_fn,
};
use hyper_util::rt::TokioIo;
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

pub(crate) const ADMIN_ID: &str = "adm_remote_cli_fixture";
pub(crate) const TOKEN: &str = "canopy_admin_cli_fixture";

pub(crate) struct NoMail;

impl AuthMail for NoMail {
    fn send<'a>(
        self: Arc<Self>,
        _kind: EmailKind,
        _recipient: Recipient<'a>,
    ) -> futures_util::future::BoxFuture<'a, ()> {
        Box::pin(async {})
    }
}

pub(crate) async fn start(
    app: &Database,
    meta: &Database,
    auth: &Database,
) -> Result<(String, JoinHandle<()>), Box<dyn Error + Send + Sync>> {
    let at = DateTime::now();
    meta.collection::<Document>("admin_users")
        .insert_one(doc! {
            "_id": ADMIN_ID, "email": "remote@example.test", "role": "admin", "createdAt": at,
        })
        .await?;
    meta.collection::<Document>("admin_sessions")
        .insert_one(doc! {
            "_id": canopy_protocol::sha256::sha256_hex(TOKEN.as_bytes()), "userId": ADMIN_ID,
            "expiresAt": DateTime::from_millis(at.timestamp_millis() + 60_000), "lastSeenAt": at,
            "transport": "bearer",
        })
        .await?;

    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let url = format!("http://{}", listener.local_addr()?);
    let mut options =
        ControlOptions::new(app.client().clone(), app.name(), meta.name(), Environment::Development);
    options.services.users = Some(Arc::new(UserRoutes::new(
        auth.clone(),
        meta.clone(),
        UserOptions {
            public_url: url::Url::parse(&url)?,
            redirect_origins: Vec::new(),
            min_password_length: 10,
            access_token_ttl_seconds: 600,
        },
        Arc::new(NoMail),
        Arc::clone(&options.now),
    )));
    let control = Control::new(options);
    let server = tokio::spawn(async move {
        while let Ok((stream, peer)) = listener.accept().await {
            let peer = peer.ip().to_string();
            let service = service_fn(|request| serve(request, &control, &peer));
            http1::Builder::new()
                .keep_alive(false)
                .serve_connection(TokioIo::new(stream), service)
                .await
                .unwrap();
        }
    });
    Ok((url, server))
}

async fn serve(
    request: HttpRequest<Incoming>,
    control: &Control,
    peer: &str,
) -> Result<Response<Full<Bytes>>, Box<dyn Error + Send + Sync>> {
    let (parts, body) = request.into_parts();
    let mut request = Request::new(parts.method.as_str(), parts.uri.to_string())
        .with_body(body.collect().await?.to_bytes().to_vec());
    for (name, value) in &parts.headers {
        request = request.with_header(name.as_str(), value.to_str()?);
    }
    let reply = control.fetch(&request, Some(peer)).await;
    let mut response = Response::builder().status(reply.status);
    for (name, value) in reply.headers {
        response = response.header(name, value);
    }
    Ok(response.body(Full::new(Bytes::from(reply.body)))?)
}
