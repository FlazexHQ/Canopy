use std::collections::HashMap;

use canopy_protocol::json::{Json, write_json};
use indexmap::IndexMap;
use serde::Deserialize;

/// Who can run GraphQL introspection.
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Introspection {
    /// Everyone.
    #[default]
    Always,
    /// Authenticated callers and service callers.
    Authenticated,
    /// Nobody.
    Never,
}

/// The resolved allowlist of GraphQL operations.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PersistedSettings {
    /// Operation documents keyed by their lowercase SHA-256 hash.
    pub operations: HashMap<String, String>,
    /// Refuses operations outside the allowlist.
    #[serde(default)]
    pub only: bool,
}

/// A GraphQL relation to another collection.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RelationSettings {
    /// Target collection.
    pub to: String,
    /// Source field.
    pub local: String,
    /// Target field, with `_id` as the fallback.
    pub foreign: Option<String>,
    /// Whether this relation returns a list.
    #[serde(default)]
    pub many: bool,
}

/// The GraphQL type name and ordered relation fields of a collection.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct CollectionSettings {
    /// Overrides the inferred type name.
    pub type_name: Option<String>,
    /// Relations by field name, in schema order.
    pub relations: IndexMap<String, RelationSettings>,
}

/// Settings for GraphQL HTTP requests. The body limit comes from REST.
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct GraphqlSettings {
    /// HTTP endpoint path.
    pub path: String,
    /// Maximum field nesting depth.
    pub max_depth: u32,
    /// Maximum operation cost.
    pub max_complexity: f64,
    /// Maximum number of aliases.
    pub max_aliases: u32,
    /// Maximum operations in a batch. Zero disables batching.
    pub max_batch: usize,
    /// Introspection policy.
    pub introspection: Introspection,
    /// Optional persisted operation allowlist.
    pub persisted: Option<PersistedSettings>,
    /// Schema settings by collection.
    pub collections: HashMap<String, CollectionSettings>,
}

impl Default for GraphqlSettings {
    fn default() -> Self {
        Self {
            path: "/graphql/v1".to_owned(),
            max_depth: 10,
            max_complexity: 5000.0,
            max_aliases: 30,
            max_batch: 10,
            introspection: Introspection::default(),
            persisted: None,
            collections: HashMap::new(),
        }
    }
}

pub(super) fn settings(value: Option<&Json>) -> Result<Option<GraphqlSettings>, String> {
    let settings: GraphqlSettings = match value {
        None => GraphqlSettings::default(),
        Some(Json::Bool(false)) => return Ok(None),
        Some(value) => {
            let mut encoded = String::new();
            write_json(&mut encoded, value);
            serde_json::from_str(&encoded).map_err(|error| format!("graphql: {error}"))?
        }
    };
    if !settings.path.starts_with('/') || settings.path.contains(['?', '#']) {
        return Err("graphql.path must be an absolute HTTP path".to_owned());
    }
    if !(1..=50).contains(&settings.max_depth) || settings.max_complexity < 1.0 || settings.max_batch > 100 {
        return Err("graphql operation limits are out of range".to_owned());
    }
    if let Some(persisted) = &settings.persisted
        && persisted.operations.keys().any(|hash| {
            hash.len() != 64
                || !hash.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
    {
        return Err("graphql.persisted.operations must map SHA-256 hex hashes to documents".to_owned());
    }
    Ok(Some(settings))
}
