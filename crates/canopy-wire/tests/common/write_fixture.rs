use std::sync::Arc;

use canopy_data::writes::WritePath;
use canopy_data::{Policies, ReadLimits, ReadPath};
use canopy_mongo::mongodb::{Client, Database, bson::doc};
use canopy_mongo::policies_from_stored;
use canopy_policy::PolicyEngine;
use canopy_protocol::json::{Json, parse_json};

const POLICIES: &str = r#"[
{"_id":"notes","version":1,"exposed":true,"realtime":false,"policies":[
{"name":"read notes","kind":"permissive","ops":["read"],"roles":["authenticated"],"using":"{\"visible\":{\"$ne\":false}}"},
{"name":"own notes","kind":"permissive","ops":["insert","update"],"roles":["authenticated"],"using":"{\"blocked\":{\"$ne\":true}}","check":"{\"owner\":{\"$auth\":\"sub\"}}"},
{"name":"remove notes","kind":"permissive","ops":["delete"],"roles":["editor"]}],
"fields":{"read":{"default":{"omit":["secret"]}},"write":{"default":{"omit":["locked"]}}},"immutable":["fixed"]}
]"#;

pub(crate) struct Fixture {
    pub(crate) db: Database,
    pub(crate) meta: Database,
    pub(crate) reads: Arc<ReadPath>,
    pub(crate) writes: Arc<WritePath>,
}

pub(crate) async fn fixture(uri: &str, label: &str) -> Result<Fixture, Box<dyn std::error::Error>> {
    let client = Client::with_uri_str(uri).await?;
    let name = format!("wire_writes_{label}_{}", std::process::id());
    let meta_name = format!("{name}_meta");
    let db = client.database(&name);
    let meta = client.database(&meta_name);
    db.collection("notes")
        .insert_many([
            doc! { "_id": 1, "owner": "oidc-user", "rank": 1, "secret": "hidden" },
            doc! { "_id": 2, "owner": "oidc-user", "rank": 2, "secret": "hidden" },
        ])
        .await?;
    let Json::Array(stored) = parse_json(POLICIES)? else { return Err("Expected a policy list".into()) };
    let policies = Policies::new(PolicyEngine::new(policies_from_stored(&stored, None)?));
    let reads = Arc::new(ReadPath::new(client.clone(), &name, policies.clone(), ReadLimits::default()));
    let writes = Arc::new(WritePath::new(client, &name, &meta_name, policies)?);
    Ok(Fixture { db, meta, reads, writes })
}
