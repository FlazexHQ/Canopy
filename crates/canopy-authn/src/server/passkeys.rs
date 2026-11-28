use base64::Engine;
use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD, URL_SAFE_NO_PAD};
use canopy_mongo::mongodb::options::ReturnDocument;
use canopy_webauthn::{
    AuthenticationExpectation, AuthenticationResponse, CoseKey, Error as WebAuthnError,
    RegistrationExpectation, RegistrationResponse, RelyingParty, StoredCredential, UserVerification,
};

use super::*;
use documents::{Passkey, Session, Verification};

const CEREMONY_TTL: u64 = 300;
const CEREMONY_TTL_MS: i64 = 300_000;

pub(super) fn method(route: &str) -> Option<&'static str> {
    match route {
        "/passkey/generate-register-options"
        | "/passkey/generate-authenticate-options"
        | "/passkey/list-user-passkeys" => Some("GET"),
        "/passkey/verify-registration"
        | "/passkey/verify-authentication"
        | "/passkey/update-passkey"
        | "/passkey/delete-passkey" => Some("POST"),
        _ => None,
    }
}

fn challenge_not_found() -> Response {
    error(400, "CHALLENGE_NOT_FOUND", "Challenge not found")
}

fn passkey_not_found() -> Response {
    error(401, "PASSKEY_NOT_FOUND", "Passkey not found")
}

fn authentication_failed(status: u16) -> Response {
    error(status, "AUTHENTICATION_FAILED", "Authentication failed")
}

fn registration_failed() -> Response {
    error(400, "FAILED_TO_VERIFY_REGISTRATION", "Failed to verify registration")
}

fn decode(value: &Value, field: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD.decode(value.get(field)?.as_str()?).ok().filter(|bytes| !bytes.is_empty())
}

fn credential_id(value: &Value) -> Option<&str> {
    let id = value.get("id")?.as_str()?;
    (value.get("rawId")?.as_str()? == id && value.get("type")?.as_str()? == "public-key").then_some(id)
}

fn counter_value(counter: u32) -> Bson {
    i32::try_from(counter).map_or_else(|_| Bson::Double(f64::from(counter)), Bson::Int32)
}

fn read_counter(value: &Bson) -> Option<u32> {
    match *value {
        Bson::Int32(counter) => u32::try_from(counter).ok(),
        Bson::Int64(counter) => u32::try_from(counter).ok(),
        Bson::Double(counter) if (0.0..=f64::from(u32::MAX)).contains(&counter) && counter.fract() == 0.0 => {
            Some(counter as u32)
        }
        _ => None,
    }
}

impl Call<'_> {
    pub(super) async fn passkey_route(
        &self,
        body: &Value,
        params: &BTreeMap<String, String>,
    ) -> Result<Response> {
        if self.route == "/passkey/verify-authentication" {
            return self.verify_passkey_authentication(&body["response"]).await;
        }
        let authenticated = self.authenticated().await?;
        if self.route == "/passkey/generate-authenticate-options" {
            return self.passkey_options(authenticated.as_ref().map(|(_, user)| user), false, params).await;
        }
        let Some((session, user)) = authenticated else {
            return Ok(error(401, "UNAUTHORIZED", "Unauthorized"));
        };
        if matches!(
            self.route,
            "/passkey/generate-register-options" | "/passkey/verify-registration" | "/passkey/delete-passkey"
        ) && !self.fresh(&session)
        {
            return Ok(error(403, "SESSION_NOT_FRESH", "Session is not fresh"));
        }
        match self.route {
            "/passkey/generate-register-options" => self.passkey_options(Some(&user), true, params).await,
            "/passkey/verify-registration" => self.verify_passkey_registration(body, &user).await,
            "/passkey/list-user-passkeys" => {
                let passkeys = self.user_passkeys(&user).await?;
                Ok(response(200, passkeys.iter().map(Passkey::public).collect::<Vec<_>>()))
            }
            _ => self.manage_passkey(body, &user).await,
        }
    }

    fn passkeys(&self) -> Collection<Passkey> {
        self.router.auth.collection("passkeys")
    }

    async fn user_passkeys(&self, user: &User) -> Result<Vec<Passkey>> {
        self.passkeys()
            .find(doc! {"userId": &user.id})
            .sort(doc! {"createdAt": 1, "_id": 1})
            .await
            .map_err(internal)?
            .try_collect()
            .await
            .map_err(internal)
    }

    fn rp_id(&self) -> &str {
        self.router.options.public_url.host_str().unwrap_or_default()
    }

    fn relying_party(&self) -> Result<RelyingParty> {
        let options = &self.router.options;
        let origins = std::iter::once(options.public_url.origin().ascii_serialization())
            .chain(options.trusted_origins.iter().filter(|origin| !origin.is_empty()).cloned());
        RelyingParty::new(self.rp_id(), origins).map_err(internal)
    }

    async fn passkey_options(
        &self,
        user: Option<&User>,
        registration: bool,
        params: &BTreeMap<String, String>,
    ) -> Result<Response> {
        let mut nonce = [0; 32];
        getrandom::fill(&mut nonce).map_err(internal)?;
        let challenge = URL_SAFE_NO_PAD.encode(nonce);
        let descriptors = if let Some(user) = user {
            self.user_passkeys(user).await?.iter().map(Passkey::descriptor).collect::<Vec<_>>()
        } else {
            Vec::new()
        };
        let (options, proof) = if registration {
            let user = user.ok_or_else(|| internal("Passkey registration requires a session"))?;
            let mut selection = serde_json_bytes::Map::from_iter([
                ("residentKey".into(), json!("preferred")),
                ("userVerification".into(), json!("required")),
                ("requireResidentKey".into(), json!(false)),
            ]);
            if let Some(attachment) = params
                .get("authenticatorAttachment")
                .filter(|value| matches!(value.as_str(), "platform" | "cross-platform"))
            {
                selection.insert("authenticatorAttachment", json!(attachment));
            }
            (
                object!(
                    "challenge": challenge,
                    "rp": object!("name": self.router.options.app_name, "id": self.rp_id()),
                    "user": object!(
                        "id": URL_SAFE_NO_PAD.encode(random_token_from(32, b"abcdefghijklmnopqrstuvwxyz0123456789")?),
                        "name": params.get("name").filter(|name| !name.is_empty()).unwrap_or(&user.email),
                        "displayName": user.email
                    ),
                    "pubKeyCredParams": [-8, -7, -257].map(|alg| object!("alg": alg, "type": "public-key")),
                    "timeout": 60_000,
                    "attestation": "none",
                    "excludeCredentials": descriptors,
                    "authenticatorSelection": selection,
                    "extensions": object!("credProps": true),
                    "hints": Vec::<Value>::new()
                ),
                object!(
                    "type": "registration", "expectedChallenge": challenge,
                    "userData": object!("id": id_text(&user.id), "name": user.email, "displayName": user.email),
                    "context": params.get("context")
                ),
            )
        } else {
            let mut options = serde_json_bytes::Map::from_iter([
                ("rpId".into(), json!(self.rp_id())),
                ("challenge".into(), json!(challenge)),
                ("timeout".into(), json!(60_000)),
                ("userVerification".into(), json!("required")),
            ]);
            if !descriptors.is_empty() {
                options.insert("allowCredentials", json!(descriptors));
            }
            (
                Value::Object(options),
                object!(
                    "type": "authentication", "expectedChallenge": challenge,
                    "userData": object!("id": user.map(|user| id_text(&user.id)).unwrap_or_default())
                ),
            )
        };
        let identifier = random_token(32)?;
        self.router
            .collection("verifications")
            .insert_one(doc! {
                "_id": object_id(self.now), "identifier": &identifier, "value": proof.to_string(),
                "expiresAt": self.date_after(CEREMONY_TTL_MS), "createdAt": self.now, "updatedAt": self.now,
            })
            .await
            .map_err(internal)?;
        let signed = sign_value(&self.router.options.secret, &identifier);
        let mut reply = response(200, options);
        self.set_cookie(&mut reply, AuthCookie::Passkey, &signed, Expiration::MaxAge(CEREMONY_TTL));
        header(
            &mut reply,
            "set-auth-ceremony",
            format!("{}={signed}", AuthCookie::Passkey.name(self.router.secure())),
        );
        Ok(reply)
    }

    async fn consume_passkey_challenge(&self, kind: &str) -> Result<Option<(Vec<u8>, String)>> {
        let Some(identifier) = self
            .cookie(AuthCookie::Passkey)
            .or_else(|| self.ceremony_cookie(AuthCookie::Passkey))
            .and_then(|signed| verify_session(&self.router.options.secret, &signed))
        else {
            return Ok(None);
        };
        let verification = self
            .router
            .auth
            .collection::<Verification>("verifications")
            .find_one_and_delete(doc! {"identifier": identifier, "expiresAt": {"$gt": self.now}})
            .await
            .map_err(internal)?;
        Ok(verification.and_then(|verification| {
            let proof: Value = serde_json::from_str(&verification.value).ok()?;
            if proof.get("type")?.as_str()? != kind {
                return None;
            }
            Some((decode(&proof, "expectedChallenge")?, proof["userData"]["id"].as_str()?.to_owned()))
        }))
    }

    async fn verify_passkey_registration(&self, body: &Value, user: &User) -> Result<Response> {
        let Some((challenge, owner)) = self.consume_passkey_challenge("registration").await? else {
            return Ok(challenge_not_found());
        };
        if owner != id_text(&user.id) {
            return Ok(error(
                401,
                "YOU_ARE_NOT_ALLOWED_TO_REGISTER_THIS_PASSKEY",
                "You are not allowed to register this passkey",
            ));
        }
        let incoming = &body["response"];
        let nested = &incoming["response"];
        let (Some(id), Some(raw_id), Some(client_data_json), Some(attestation_object)) = (
            credential_id(incoming),
            decode(incoming, "rawId"),
            decode(nested, "clientDataJSON"),
            decode(nested, "attestationObject"),
        ) else {
            return Ok(registration_failed());
        };
        let Ok(credential) = self.relying_party()?.verify_registration(
            &RegistrationResponse {
                raw_id: &raw_id,
                client_data_json: &client_data_json,
                attestation_object: &attestation_object,
            },
            &RegistrationExpectation { challenge: &challenge, user_verification: UserVerification::Required },
        ) else {
            return Ok(registration_failed());
        };
        if self.passkeys().count_documents(doc! {"credentialID": id}).limit(1).await.map_err(internal)? != 0 {
            return Ok(registration_failed());
        }
        let transports = nested["transports"]
            .as_array()
            .map(|values| values.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(","))
            .unwrap_or_default();
        let passkey = Passkey {
            id: Bson::ObjectId(object_id(self.now)),
            name: body["name"].as_str().filter(|name| !name.is_empty()).map(str::to_owned),
            public_key: STANDARD.encode(&credential.public_key_cose),
            user_id: user.id.clone(),
            credential_id: id.to_owned(),
            counter: counter_value(credential.sign_count),
            device_type: if credential.backup_eligible { "multiDevice" } else { "singleDevice" }.into(),
            backed_up: credential.backed_up,
            transports: Some(transports),
            created_at: Some(self.now),
            aaguid: Some(uuid::Uuid::from_bytes(credential.aaguid).to_string()),
            extra: Document::new(),
        };
        match self.passkeys().insert_one(&passkey).await {
            Ok(_) => {}
            Err(error) if duplicate_key(&error) => return Ok(registration_failed()),
            Err(error) => return Err(internal(error)),
        }
        self.audit("auth.passkey_added", doc! {"type": "user"}, None, None, true).await?;
        Ok(response(200, passkey.public()))
    }

    async fn verify_passkey_authentication(&self, incoming: &Value) -> Result<Response> {
        let Some((challenge, owner)) = self.consume_passkey_challenge("authentication").await? else {
            return Ok(challenge_not_found());
        };
        let nested = &incoming["response"];
        let (Some(id), Some(raw_id), Some(client_data_json), Some(authenticator_data), Some(signature)) = (
            credential_id(incoming),
            decode(incoming, "rawId"),
            decode(nested, "clientDataJSON"),
            decode(nested, "authenticatorData"),
            decode(nested, "signature"),
        ) else {
            return Ok(authentication_failed(400));
        };
        let mut matches = self.passkeys().find(doc! {"credentialID": id}).limit(2).await.map_err(internal)?;
        let Some(passkey) = matches.try_next().await.map_err(internal)? else {
            return Ok(passkey_not_found());
        };
        if matches.try_next().await.map_err(internal)?.is_some()
            || (!owner.is_empty() && owner != id_text(&passkey.user_id))
        {
            return Ok(authentication_failed(401));
        }
        let Ok(key_bytes) = STANDARD_NO_PAD.decode(passkey.public_key.trim_end_matches('=')) else {
            return Ok(authentication_failed(400));
        };
        let (Ok(public_key), Some(sign_count)) =
            (CoseKey::from_cbor(&key_bytes), read_counter(&passkey.counter))
        else {
            return Ok(authentication_failed(400));
        };
        let backup_eligible = match passkey.device_type.as_str() {
            "multiDevice" => true,
            "singleDevice" => false,
            _ => return Ok(authentication_failed(400)),
        };
        let user_handle = decode(nested, "userHandle");
        let identified_user =
            (!owner.is_empty() && nested["userHandle"].is_null()).then_some(owner.as_bytes());
        let outcome = self.relying_party()?.verify_authentication(
            &AuthenticationResponse {
                raw_id: &raw_id,
                client_data_json: &client_data_json,
                authenticator_data: &authenticator_data,
                signature: &signature,
                user_handle: user_handle.as_deref(),
            },
            &AuthenticationExpectation {
                challenge: &challenge,
                user_verification: UserVerification::Required,
                allow_credentials: &[],
                identified_user,
            },
            &StoredCredential {
                credential_id: &raw_id,
                public_key: &public_key,
                sign_count,
                backup_eligible,
                user_handle: None,
            },
        );
        let verified = match outcome {
            Ok(verified) => verified,
            Err(WebAuthnError::InvalidSignature) => return Ok(authentication_failed(401)),
            Err(_) => return Ok(authentication_failed(400)),
        };
        let Some(user) = self.user(doc! {"_id": &passkey.user_id}).await?.filter(|user| !self.banned(user))
        else {
            return Ok(authentication_failed(401));
        };
        let session = self.new_session(&user, true, "aal2")?;
        if !self.commit_passkey_assertion(&passkey, &session, verified.sign_count, verified.backed_up).await?
        {
            return Ok(authentication_failed(400));
        }
        let mut reply = response(200, object!("session": session.public(), "user": user.public()));
        self.set_session(&mut reply, &session.token, true);
        Ok(reply)
    }

    async fn commit_passkey_assertion(
        &self,
        passkey: &Passkey,
        session: &Session,
        counter: u32,
        backed_up: bool,
    ) -> Result<bool> {
        let mut tx = self.router.auth.client().start_session().await.map_err(internal)?;
        let filter = doc! {
            "_id": &passkey.id, "userId": &passkey.user_id,
            "counter": &passkey.counter, "backedUp": passkey.backed_up,
        };
        let update = doc! {"$set": {"counter": counter_value(counter), "backedUp": backed_up}};
        tx.start_transaction()
            .and_run((self, &session, &filter, &update), |tx, (call, session, filter, update)| {
                Box::pin(async move {
                    let result =
                        call.passkeys().update_one(filter.clone(), update.clone()).session(&mut *tx).await?;
                    if result.matched_count == 0 {
                        return Ok(false);
                    }
                    call.insert_session_in(tx, session, "passkey").await?;
                    Ok(true)
                })
            })
            .await
            .map_err(internal)
    }

    async fn manage_passkey(&self, body: &Value, user: &User) -> Result<Response> {
        let Some(id) = body["id"].as_str() else { return Ok(validation(body, "id")) };
        let filter = match bson::oid::ObjectId::parse_str(id) {
            Ok(object) => doc! {"_id": {"$in": [Bson::ObjectId(object), Bson::String(id.into())]}},
            Err(_) => doc! {"_id": id},
        };
        let Some(passkey) = self.passkeys().find_one(filter).await.map_err(internal)? else {
            return Ok(error(404, "PASSKEY_NOT_FOUND", "Passkey not found"));
        };
        let updating = self.route == "/passkey/update-passkey";
        if passkey.user_id != user.id {
            return Ok(if updating {
                error(
                    401,
                    "YOU_ARE_NOT_ALLOWED_TO_REGISTER_THIS_PASSKEY",
                    "You are not allowed to register this passkey",
                )
            } else {
                error(401, "UNAUTHORIZED", "Unauthorized")
            });
        }
        let filter = doc! {"_id": &passkey.id, "userId": &user.id};
        if updating {
            let Some(name) = body["name"].as_str().map(str::trim).filter(|name| !name.is_empty()) else {
                return Ok(validation(body, "name"));
            };
            let updated = self
                .passkeys()
                .find_one_and_update(filter, doc! {"$set": {"name": name}})
                .return_document(ReturnDocument::After)
                .await
                .map_err(internal)?;
            return Ok(match updated {
                Some(passkey) => response(200, object!("passkey": passkey.public())),
                None => error(500, "FAILED_TO_UPDATE_PASSKEY", "Failed to update passkey"),
            });
        }
        if self.passkeys().delete_one(filter).await.map_err(internal)?.deleted_count == 1 {
            self.audit("auth.passkey_deleted", doc! {"type": "user"}, None, None, true).await?;
        }
        Ok(status())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use canopy_mongo::mongodb::Client;

    type TestResult = std::result::Result<(), Box<dyn std::error::Error>>;

    struct NoMail;

    impl AuthMail for NoMail {
        fn send<'a>(
            self: Arc<Self>,
            _: EmailKind,
            _: Recipient<'a>,
        ) -> futures_util::future::BoxFuture<'a, ()> {
            Box::pin(std::future::ready(()))
        }
    }

    const FIXTURE: &str = include_str!("../../../../conformance/auth/documents/passkeys.json");

    fn fixture() -> std::result::Result<Vec<Document>, Box<dyn std::error::Error>> {
        Ok(serde_json::from_str::<Vec<serde_json::Value>>(FIXTURE)?
            .into_iter()
            .map(|value| bson::deserialize_from_bson(Bson::try_from(value)?))
            .collect::<std::result::Result<_, _>>()?)
    }

    #[test]
    fn round_trips_typescript_passkey_documents_and_unknown_fields() -> TestResult {
        for mut document in fixture()? {
            document.insert("futureField", doc! {"enabled": true, "value": [1, 2]});
            let decoded: Passkey = bson::deserialize_from_document(document.clone())?;
            assert_eq!(bson::serialize_to_document(&decoded)?, document);
            for optional in ["name", "transports", "createdAt", "aaguid"] {
                document.remove(optional);
            }
            let decoded: Passkey = bson::deserialize_from_document(document.clone())?;
            assert_eq!(bson::serialize_to_document(&decoded)?, document);
        }
        Ok(())
    }

    #[tokio::test]
    async fn concurrent_assertions_with_the_same_stored_counter_create_one_session() -> TestResult {
        let Ok(uri) = std::env::var("CANOPY_TEST_MONGODB_URI") else { return Ok(()) };
        let _ = rustls::crypto::ring::default_provider().install_default();
        let client = Client::with_uri_str(uri).await?;
        let suffix = uuid::Uuid::new_v4().simple();
        let auth = client.database(&format!("auth_passkey_race_{suffix}"));
        let meta = client.database(&format!("meta_passkey_race_{suffix}"));
        let result = async {
            let options = AuthOptions::new(Url::parse("https://auth.canopy.test")?, "a".repeat(32));
            let router = AuthRouter::open(auth.clone(), meta.clone(), options, Arc::new(NoMail)).await?;
            let request = Request::new("POST", "/auth/v1/passkey/verify-authentication");
            let call = Call {
                router: &router,
                request: &request,
                route: "/passkey/verify-authentication",
                now: DateTime::now(),
            };
            let mut document = fixture()?
                .into_iter()
                .find(|document| document.get_str("deviceType").ok() == Some("multiDevice"))
                .ok_or("Synced passkey fixture")?;
            document.insert("counter", 1);
            document.insert("backedUp", false);
            document.insert("futureField", "retained");
            let passkey: Passkey = bson::deserialize_from_document(document.clone())?;
            router.collection("passkeys").insert_one(document).await?;
            let user = User {
                id: passkey.user_id.clone(),
                name: "Ada".into(),
                email: "ada@example.com".into(),
                email_verified: true,
                created_at: call.now,
                updated_at: call.now,
                extra: Document::new(),
            };
            let first = call.new_session(&user, true, "aal2")?;
            let second = call.new_session(&user, true, "aal2")?;
            let (first, second) = tokio::join!(
                call.commit_passkey_assertion(&passkey, &first, 2, true),
                call.commit_passkey_assertion(&passkey, &second, 2, true),
            );
            assert_ne!(first?, second?, "Exactly one assertion must win the counter update");
            let stored = router
                .collection("passkeys")
                .find_one(doc! {"_id": &passkey.id})
                .await?
                .ok_or("Stored passkey")?;
            assert_eq!(stored.get_i32("counter")?, 2);
            assert!(stored.get_bool("backedUp")?);
            assert_eq!(stored.get_str("futureField")?, "retained");
            assert_eq!(router.collection("sessions").count_documents(doc! {"aal": "aal2"}).await?, 1);
            assert_eq!(
                meta.collection::<Document>("audit_log")
                    .count_documents(doc! {"details.method": "passkey"})
                    .await?,
                1
            );
            Ok::<_, Box<dyn std::error::Error>>(())
        }
        .await;
        auth.drop().await?;
        meta.drop().await?;
        result
    }
}
