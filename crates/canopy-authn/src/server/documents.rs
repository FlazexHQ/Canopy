use bson::{Bson, DateTime, Document};
use serde::{Deserialize, Serialize};
use serde_json_bytes::{ByteString, Map, Value, json};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct User {
    #[serde(rename = "_id")]
    pub id: Bson,
    pub name: String,
    pub email: String,
    pub email_verified: bool,
    pub created_at: DateTime,
    pub updated_at: DateTime,
    #[serde(flatten)]
    pub extra: Document,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Session {
    #[serde(rename = "_id")]
    pub id: Bson,
    pub expires_at: DateTime,
    pub token: String,
    pub created_at: DateTime,
    pub updated_at: DateTime,
    pub ip_address: String,
    pub user_agent: String,
    pub user_id: Bson,
    #[serde(flatten)]
    pub extra: Document,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Account {
    #[serde(rename = "_id")]
    pub id: Bson,
    pub account_id: String,
    pub provider_id: String,
    pub user_id: Bson,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    pub created_at: DateTime,
    pub updated_at: DateTime,
    #[serde(flatten)]
    pub extra: Document,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Verification {
    pub identifier: String,
    pub value: String,
    pub expires_at: DateTime,
    pub created_at: DateTime,
    pub updated_at: DateTime,
    #[serde(flatten)]
    pub extra: Document,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AddressLimit {
    #[serde(rename = "_id")]
    id: Bson,
    key: String,
    pub count: i32,
    pub last_request: i64,
    #[serde(flatten)]
    extra: Document,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct IdentifierLimit {
    #[serde(rename = "_id")]
    id: String,
    expires_at: DateTime,
    #[serde(flatten)]
    pub extra: Document,
}
pub(super) fn id_text(id: &Bson) -> String {
    match id {
        Bson::ObjectId(id) => id.to_hex(),
        Bson::String(id) => id.clone(),
        _ => String::new(),
    }
}

fn iso(date: DateTime) -> String {
    OffsetDateTime::from_unix_timestamp(date.timestamp_millis().div_euclid(1000))
        .ok()
        .and_then(|time| time.format(&Rfc3339).ok())
        .and_then(|text| {
            text.strip_suffix('Z')
                .map(|base| format!("{base}.{:03}Z", date.timestamp_millis().rem_euclid(1000)))
        })
        .unwrap_or_default()
}

impl Session {
    pub(super) fn public(&self) -> Value {
        object!(
            "expiresAt": iso(self.expires_at), "token": self.token, "createdAt": iso(self.created_at),
            "updatedAt": iso(self.updated_at), "ipAddress": self.ip_address, "userAgent": self.user_agent,
            "userId": id_text(&self.user_id), "aal": self.extra.get_str("aal").unwrap_or("aal1"),
            "id": id_text(&self.id)
        )
    }
}

impl User {
    pub(super) fn metadata(&self, field: &str) -> Map<ByteString, Value> {
        self.extra.get_str(field).ok().and_then(|value| serde_json::from_str(value).ok()).unwrap_or_default()
    }

    pub(super) fn public(&self) -> Value {
        let mut output = Map::new();
        output.insert("name", json!(self.name));
        output.insert("email", json!(self.email));
        output.insert("emailVerified", json!(self.email_verified));
        if let Ok(image) = self.extra.get_str("image") {
            output.insert("image", json!(image));
        }
        output.insert("createdAt", json!(iso(self.created_at)));
        output.insert("updatedAt", json!(iso(self.updated_at)));
        for field in [
            "isAnonymous",
            "role",
            "banned",
            "banReason",
            "banExpires",
            "twoFactorEnabled",
            "roles",
            "appMetadata",
            "userMetadata",
        ] {
            if matches!(field, "appMetadata" | "userMetadata") && self.extra.contains_key(field) {
                output.insert(field, Value::Object(self.metadata(field)));
            } else if let Some(value) = self.extra.get(field) {
                output.insert(
                    field,
                    serde_json_bytes::to_value(value.clone().into_relaxed_extjson()).unwrap_or(Value::Null),
                );
            }
        }
        output.insert("id", json!(id_text(&self.id)));
        Value::Object(output)
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used)]

    use super::*;
    use serde::de::DeserializeOwned;

    fn round_trip<T: DeserializeOwned + Serialize>(source: &str) {
        for value in serde_json::from_str::<Vec<serde_json::Value>>(source).expect("fixture JSON") {
            let expected =
                Bson::try_from(value).expect("fixture EJSON").as_document().expect("document").clone();
            let decoded: T = bson::deserialize_from_document(expected.clone()).expect("read fixture");
            let actual = bson::serialize_to_document(&decoded).expect("write fixture");
            assert_eq!(actual, expected);
        }
    }

    #[test]
    fn typed_documents_preserve_fixture_fields() {
        round_trip::<User>(include_str!("../../../../conformance/auth/documents/users.json"));
        round_trip::<Account>(include_str!("../../../../conformance/auth/documents/accounts.json"));
        round_trip::<Session>(include_str!("../../../../conformance/auth/documents/sessions.json"));
        round_trip::<AddressLimit>(include_str!("../../../../conformance/auth/documents/rate_limits.json"));
        round_trip::<IdentifierLimit>(include_str!(
            "../../../../conformance/auth/documents/identifier_limits.json"
        ));
        round_trip::<Verification>(include_str!("../../../../conformance/auth/documents/verifications.json"));
    }
}
