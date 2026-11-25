use canopy_protocol::ejson::{DecodeOptions, decode};
use canopy_protocol::json::{Json, parse_json, write_json};
use canopy_protocol::{CanopyError, Value};

use crate::validate::{is_claim_path, is_lookup_name};
use crate::{CollectionPolicies, PolicySet, contexts_from_stored, create_policy_set, from_stored};

fn invalid(message: &str) -> CanopyError {
    CanopyError::invalid_query(message)
}

fn object<'a>(
    value: &'a Json,
    required: &[&str],
    optional: &[&str],
) -> Result<&'a [(String, Json)], CanopyError> {
    let Json::Object(fields) = value else { return Err(invalid("Expected a policy document")) };
    for key in required {
        if value.get(key).is_none() {
            return Err(CanopyError::invalid_query(format!("Missing policy field '{key}'")));
        }
    }
    for (key, _) in fields {
        if !required.contains(&key.as_str()) && !optional.contains(&key.as_str()) {
            return Err(CanopyError::invalid_query(format!("Unknown policy field '{key}'")));
        }
    }
    Ok(fields)
}

fn paths(value: &Json) -> Result<(), CanopyError> {
    match value {
        Json::Array(items)
            if items.iter().all(
                |item| matches!(item, Json::String(path) if (1..=512).contains(&path.chars().count())),
            ) =>
        {
            Ok(())
        }
        _ => Err(invalid("Expected an array of field paths of 1 to 512 characters")),
    }
}

fn filter_value(value: &Json) -> Result<(), CanopyError> {
    match value {
        Json::Object(fields) => {
            if let Some(auth) = value.get("$auth") {
                object(value, &["$auth"], &["as"])?;
                if !matches!(auth, Json::String(path) if is_claim_path(path))
                    || value.get("as").is_some_and(|kind| !matches!(kind, Json::String(kind) if matches!(kind.as_str(), "objectId" | "string" | "number" | "bool" | "date" | "uuid")))
                {
                    return Err(invalid("Invalid policy auth variable"));
                }
            }
            if let Some(ctx) = value.get("$ctx") {
                object(value, &["$ctx"], &[])?;
                if !matches!(ctx, Json::String(name) if is_lookup_name(name)) {
                    return Err(invalid("Invalid policy context variable"));
                }
            }
            if let Some(now) = value.get("$now") {
                object(value, &["$now"], &[])?;
                object(now, &[], &["offset"])?;
                if now.get("offset").is_some_and(|offset| !matches!(offset, Json::String(_))) {
                    return Err(invalid("A policy time offset must be a string"));
                }
            }
            fields.iter().try_for_each(|(_, item)| filter_value(item))
        }
        Json::Array(items) => items.iter().try_for_each(filter_value),
        _ => Ok(()),
    }
}

fn filter(value: &Json) -> Result<(), CanopyError> {
    let Json::Object(fields) = value else { return Err(invalid("Expected a policy filter document")) };
    fields.iter().try_for_each(|(_, item)| filter_value(item))
}

fn field_rules(value: &Json) -> Result<(), CanopyError> {
    for (_, roles) in object(value, &[], &["read", "write", "update"])? {
        let Json::Object(roles) = roles else { return Err(invalid("Expected field rules by role")) };
        for (role, rule) in roles {
            if role == "service" {
                return Err(invalid("Field rules cannot name the service role"));
            }
            let fields = object(rule, &[], &["only", "omit"])?;
            let [(_, listed)] = fields else { return Err(invalid("Expected exactly one of only or omit")) };
            paths(listed)?;
        }
    }
    Ok(())
}

fn collection(value: &Json) -> Result<CollectionPolicies, CanopyError> {
    let fields = object(value, &["collection", "exposed", "realtime", "policies"], &["fields", "immutable"])?;
    if !matches!(value.get("exposed"), Some(Json::Bool(_)))
        || !matches!(value.get("realtime"), Some(Json::Bool(_)))
        || !matches!(value.get("collection"), Some(Json::String(name)) if name != "_context")
    {
        return Err(invalid("Expected a collection name and boolean exposed and realtime fields"));
    }
    if let Some(rules) = value.get("fields") {
        field_rules(rules)?;
    }
    if let Some(immutable) = value.get("immutable") {
        paths(immutable)?;
    }
    let Some(Json::Array(policies)) = value.get("policies") else {
        return Err(invalid("Expected an array of policies"));
    };
    let policies = policies
        .iter()
        .map(|policy| {
            let fields = object(policy, &["name", "kind", "ops", "roles"], &["using", "check"])?;
            if !matches!(policy.get("ops"), Some(Json::Array(_)))
                || !matches!(policy.get("roles"), Some(Json::Array(_)))
            {
                return Err(invalid("Expected operation and role arrays"));
            }
            let stored = fields
                .iter()
                .map(|(key, value)| {
                    let value = if matches!(key.as_str(), "using" | "check") {
                        filter(value)?;
                        let mut text = String::new();
                        write_json(&mut text, value);
                        Json::String(text)
                    } else {
                        value.clone()
                    };
                    Ok((key.clone(), value))
                })
                .collect::<Result<_, CanopyError>>()?;
            Ok(Json::Object(stored))
        })
        .collect::<Result<_, CanopyError>>()?;
    let mut stored = fields.iter().filter(|(key, _)| key != "policies").cloned().collect::<Vec<_>>();
    if let Some((key, _)) = stored.iter_mut().find(|(key, _)| key == "collection") {
        *key = "_id".to_owned();
    }
    stored.push(("policies".to_owned(), Json::Array(policies)));
    from_stored(&decode(&Json::Object(stored), DecodeOptions::default())?)
}

/// Parses a canonical version 1 policy bundle and validates it with the policy compiler.
pub fn parse_policy_set(text: &str) -> Result<PolicySet, CanopyError> {
    let value = parse_json(text)?;
    object(&value, &["version", "collections", "contexts"], &[])?;
    if !matches!(value.get("version"), Some(Json::Number(1.0))) {
        return Err(invalid("Expected policy set version 1"));
    }
    let Some(Json::Array(collections)) = value.get("collections") else {
        return Err(invalid("Expected an array of policy collections"));
    };
    let Some(contexts @ Json::Object(lookups)) = value.get("contexts") else {
        return Err(invalid("Expected a document of context lookups"));
    };
    for (_, lookup) in lookups {
        object(lookup, &["from", "where", "select", "max", "ttl"], &[])?;
        if !matches!(lookup.get("select"), Some(Json::String(path)) if (1..=512).contains(&path.chars().count()))
            || !matches!(lookup.get("max"), Some(Json::Number(max)) if max.fract() == 0.0 && (1.0..=100_000.0).contains(max))
        {
            return Err(invalid("Invalid context select or max"));
        }
        filter(lookup.get("where").ok_or_else(|| invalid("Expected a context filter"))?)?;
    }
    let contexts = decode(contexts, DecodeOptions::default())?;
    let Value::Document(_) = contexts else { return Err(invalid("Expected context lookups")) };
    let definitions = collections.iter().map(collection).collect::<Result<_, _>>()?;
    create_policy_set(definitions, contexts_from_stored(Some(&contexts))?)
}
