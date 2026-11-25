use canopy_mongo::mongodb::bson::{Bson, Document, doc};

/// Returns the public string form of an auth document identifier.
pub fn id_text(id: &Bson) -> String {
    match id {
        Bson::ObjectId(id) => id.to_hex(),
        Bson::String(id) => id.clone(),
        _ => String::new(),
    }
}

/// Matches both BSON representations used for auth identifiers.
pub fn id_filter(id: &str) -> Bson {
    match canopy_mongo::mongodb::bson::oid::ObjectId::parse_str(id) {
        Ok(object_id) => Bson::Document(doc! { "$in": [Bson::String(id.into()), Bson::ObjectId(object_id)] }),
        Err(_) => Bson::String(id.into()),
    }
}

/// Reads a metadata object from either representation used by stored users.
pub fn metadata(user: &Document, key: &str) -> Document {
    match user.get(key) {
        Some(Bson::Document(value)) => value.clone(),
        Some(Bson::String(value)) => serde_json::from_str(value).unwrap_or_default(),
        _ => Document::new(),
    }
}
