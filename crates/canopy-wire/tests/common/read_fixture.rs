use std::sync::Arc;

use canopy_data::{Policies, ReadLimits, ReadPath};
use canopy_mongo::mongodb::{Client, bson::doc};
use canopy_mongo::policies_from_stored;
use canopy_policy::PolicyEngine;
use canopy_protocol::json::{Json, parse_json};

const POLICIES: &str = r#"[
{"_id":"notes","version":1,"exposed":true,"realtime":false,"policies":[
{"name":"own notes","kind":"permissive","ops":["read"],"roles":["authenticated"],"using":"{\"owner\":{\"$auth\":\"sub\"}}"}],
"fields":{"read":{"default":{"omit":["secret"]}}}},
{"_id":"private","version":1,"exposed":false,"realtime":false,"policies":[
{"name":"private notes","kind":"permissive","ops":["read"],"roles":["authenticated"]}]},
{"_id":"restricted","version":1,"exposed":true,"realtime":false,"policies":[
{"name":"staff only","kind":"permissive","ops":["read"],"roles":["staff"]}]}]"#;

pub(crate) async fn fixture(uri: &str, label: &str) -> Result<Arc<ReadPath>, Box<dyn std::error::Error>> {
    let client = Client::with_uri_str(uri).await?;
    let name = format!("wire_{label}_{}", std::process::id());
    let db = client.database(&name);
    db.collection("notes")
        .insert_many([
            doc! { "_id": 1, "owner": "oidc-user", "tag": "first", "secret": "hidden" },
            doc! { "_id": 2, "owner": "other", "tag": "second", "secret": "hidden" },
            doc! { "_id": 3, "owner": "oidc-user", "tag": "third", "secret": "hidden" },
            doc! { "_id": 4, "owner": "oidc-user", "tag": "fourth", "secret": "hidden" },
        ])
        .await?;
    let Json::Array(stored) = parse_json(POLICIES)? else { return Err("Expected a policy list".into()) };
    let policy = PolicyEngine::new(policies_from_stored(&stored, None)?);
    Ok(Arc::new(ReadPath::new(client, &name, Policies::new(policy), ReadLimits::default())))
}
