use bson::{Bson, DateTime, Document, doc};
use canopy_http::Response;
use serde::Serialize;
use serde_json_bytes::Value;
use time::{OffsetDateTime, macros::format_description};

use super::flow::matching_ids;
use crate::server::{Call, Result, documents::id_text, empty, error, header, internal, response};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AccessToken<'a> {
    access_token: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    access_token_expires_at: Option<String>,
    scopes: Vec<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    id_token: Option<&'a Bson>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RefreshedToken<'a> {
    access_token: &'a str,
    refresh_token: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    access_token_expires_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    refresh_token_expires_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    scope: Option<&'a Bson>,
    #[serde(skip_serializing_if = "Option::is_none")]
    id_token: Option<&'a Bson>,
    provider_id: &'a str,
    account_id: String,
}

fn expiration(date: &Bson) -> Option<DateTime> {
    match date {
        Bson::DateTime(date) => Some(*date),
        Bson::String(date) => DateTime::parse_rfc3339_str(date).ok(),
        _ => None,
    }
}

fn expiry(date: Option<&Bson>) -> Option<String> {
    let millis = expiration(date?)?.timestamp_millis();
    let date = OffsetDateTime::from_unix_timestamp_nanos(i128::from(millis) * 1_000_000).ok()?;
    date.format(&format_description!("[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z"))
        .ok()
}

fn account_missing() -> Response {
    error(400, "ACCOUNT_NOT_FOUND", "Account not found")
}

impl Call<'_> {
    pub(in crate::server) async fn oauth_access_token(&self, body: &Value) -> Result<Response> {
        let Some(selection) = body.as_object() else {
            return Ok(error(400, "VALIDATION_ERROR", "[body] Invalid input"));
        };
        let account_id = body.get("accountId").and_then(Value::as_str);
        let cookie = body.get("useAccountCookie").and_then(Value::as_bool) == Some(true);
        if account_id.is_some() == cookie
            || selection.keys().any(|key| {
                !matches!(key.as_str(), "userId")
                    && key.as_str() != if cookie { "useAccountCookie" } else { "accountId" }
            })
            || body.get("userId").is_some_and(|id| !id.is_string())
        {
            return Ok(error(400, "VALIDATION_ERROR", "[body] Invalid input"));
        }
        let Some((_, user)) = self.authenticated().await? else {
            let mut reply = empty(401);
            header(&mut reply, "content-type", "application/json");
            return Ok(reply);
        };
        let Some(account_id) = account_id else {
            return Ok(account_missing());
        };
        let accounts = self.router.collection("accounts");
        let Some(account) = accounts
            .find_one(doc! {"_id": {"$in": matching_ids(account_id)}, "userId": &user.id})
            .await
            .map_err(internal)?
        else {
            return Ok(account_missing());
        };
        let provider_id = account.get_str("providerId").map_err(internal)?;
        let Some(provider) = self.router.oauth.provider(provider_id).await else {
            return Ok(error(
                400,
                "PROVIDER_NOT_SUPPORTED",
                &format!("Provider {provider_id} is not supported."),
            ));
        };
        let force = self.route == "/refresh-token";
        let stored_expiry = account.get("accessTokenExpiresAt");
        let expired = stored_expiry.and_then(expiration).is_some_and(|date| date < self.date_after(5000));
        let refresh = account.get_str("refreshToken").ok().filter(|token| !token.is_empty());
        let scope = account.get_str("scope").unwrap_or_default();
        let mut fields = Document::new();
        if force || (refresh.is_some() && expired) {
            let Some(refresh) = refresh else {
                return Ok(error(400, "REFRESH_TOKEN_NOT_FOUND", "Refresh token not found"));
            };
            let failure = || {
                if force {
                    error(400, "FAILED_TO_REFRESH_ACCESS_TOKEN", "Failed to refresh access token")
                } else {
                    error(400, "FAILED_TO_GET_ACCESS_TOKEN", "Failed to get a valid access token")
                }
            };
            let Some(tokens) =
                provider.refresh(&self.router.oauth, refresh, self.now.timestamp_millis()).await
            else {
                return Ok(failure());
            };
            fields = self.token_fields(&tokens);
            fields.insert("updatedAt", self.now);
            let id = account.get("_id").ok_or_else(|| internal("Account id missing"))?;
            let mut filter = doc! {"_id": id, "userId": &user.id, "providerId": provider_id};
            for field in
                ["accessToken", "accessTokenExpiresAt", "refreshToken", "refreshTokenExpiresAt", "idToken"]
            {
                filter.insert(field, account.get(field).cloned().unwrap_or(Bson::Null));
            }
            match accounts.update_one(filter, doc! {"$set": &fields}).await {
                Ok(updated) if updated.matched_count == 1 => {}
                _ => return Ok(failure()),
            }
            if force {
                return Ok(response(
                    200,
                    RefreshedToken {
                        access_token: fields.get_str("accessToken").map_err(internal)?,
                        refresh_token: fields.get_str("refreshToken").unwrap_or(refresh),
                        access_token_expires_at: expiry(fields.get("accessTokenExpiresAt")),
                        refresh_token_expires_at: expiry(
                            fields
                                .get("refreshTokenExpiresAt")
                                .or_else(|| account.get("refreshTokenExpiresAt")),
                        ),
                        scope: account.get("scope"),
                        id_token: fields.get("idToken").or_else(|| account.get("idToken")),
                        provider_id,
                        account_id: id_text(id),
                    },
                ));
            }
        }
        Ok(response(
            200,
            AccessToken {
                access_token: fields
                    .get_str("accessToken")
                    .or_else(|_| account.get_str("accessToken"))
                    .unwrap_or_default(),
                access_token_expires_at: expiry(fields.get("accessTokenExpiresAt").or(stored_expiry)),
                scopes: scope.split(',').map(str::trim).filter(|value| !value.is_empty()).collect(),
                id_token: fields
                    .get("idToken")
                    .or_else(|| account.get("idToken"))
                    .filter(|value| *value != &Bson::Null),
            },
        ))
    }
}
