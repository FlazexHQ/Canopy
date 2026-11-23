use canopy_policy::{
    CollectionPolicies, Compiled, Operation, PolicyDefinition, PolicyEngine, PolicyKind, RequestContext, Roles,
    create_policy_set,
};
use canopy_protocol::ejson::{DecodeOptions, parse};
use canopy_protocol::{CanopyError, Document, Value};
use canopy_query::js_property_order;

/// The collection every scenario reads.
pub const COLLECTION: &str = "items";

fn document(source: &str) -> Result<Document, CanopyError> {
    match js_property_order(&parse(source, DecodeOptions::default())?) {
        Value::Document(document) => Ok(document),
        _ => Err(CanopyError::new(canopy_protocol::ErrorCode::InvalidQuery, "expected a document")),
    }
}

/// The policies of the TypeScript fan out benchmark: users read their own items, viewers read every item.
pub fn engine() -> Result<PolicyEngine, CanopyError> {
    let mut items = CollectionPolicies::new(COLLECTION);
    items.exposed = true;
    items.realtime = true;
    items.policies = vec![
        PolicyDefinition {
            name: "own items".to_owned(),
            kind: PolicyKind::Permissive,
            ops: vec![Operation::Read],
            roles: vec!["authenticated".to_owned()],
            using: Some(document(r#"{"ownerId": {"$auth": "sub"}}"#)?),
            check: None,
        },
        PolicyDefinition {
            name: "viewers".to_owned(),
            kind: PolicyKind::Permissive,
            ops: vec![Operation::Read],
            roles: vec!["viewer".to_owned()],
            using: None,
            check: None,
        },
    ];
    Ok(PolicyEngine::new(create_policy_set(vec![items], Vec::new())?))
}

/// The request context of a caller from the claims of its token: `authenticated` plus the `roles` claim.
pub fn context(claims: Document, now: i64) -> RequestContext {
    let mut roles = Roles::new();
    roles.insert("authenticated");
    if let Some(Value::Array(list)) = claims.get("roles") {
        for role in list {
            if let Value::String(role) = role {
                if role != "service" {
                    roles.insert(role.clone());
                }
            }
        }
    }
    RequestContext { roles, claims: Some(claims), ctx: None, now }
}

/// The effective read filter of a subscription: the caller's filter AND `USING(read)`.
pub fn effective(engine: &PolicyEngine, filter: &Document, ctx: &RequestContext) -> Result<Compiled, CanopyError> {
    engine.effective_read(COLLECTION, filter, ctx)
}
