//! The bundle `canopy.js/emit` prints: one project's canonical documents.

use canopy_policy::PolicySet;
use canopy_protocol::json::Json;

use crate::pointer::escape;
use crate::{
    AuthoringCode, AuthoringError, parse, validate_collection_schema_json, validate_config_json,
    validate_policy_set_json, validate_policy_test_json,
};

const CODE: AuthoringCode = AuthoringCode::ConfigInvalid;
const FIELDS: [&str; 7] = ["version", "context", "files", "config", "policies", "tests", "schema"];
const COMMANDS: [&str; 7] = ["start", "dev", "realtime", "gen", "policies", "doctor", "print"];

/// A validated bundle: the compiled policy set, when the project has a policy folder.
#[derive(Debug)]
pub struct Bundle {
    /// The compiled policies of the `policies` part.
    pub policies: Option<PolicySet>,
}

fn refuse(path: &str, message: &str) -> AuthoringError {
    AuthoringError::new(CODE, path, message)
}

fn check_context(context: Option<&Json>) -> Result<(), AuthoringError> {
    let Some(context @ Json::Object(fields)) = context else {
        return Err(refuse("/context", "Expected the mode and command the config was evaluated for"));
    };
    if let Some((key, _)) = fields.iter().find(|(key, _)| key != "mode" && key != "command") {
        return Err(refuse(&format!("/context/{}", escape(key)), "Unknown bundle context field"));
    }
    if !matches!(context.get("mode"), Some(Json::String(mode)) if mode == "development" || mode == "production")
    {
        return Err(refuse("/context/mode", "Expected development or production"));
    }
    if !matches!(context.get("command"), Some(Json::String(command)) if COMMANDS.contains(&command.as_str()))
    {
        return Err(refuse(
            "/context/command",
            "Expected one of start, dev, realtime, gen, policies, doctor, print",
        ));
    }
    Ok(())
}

fn check_files(files: Option<&Json>) -> Result<(), AuthoringError> {
    let Some(files @ Json::Object(fields)) = files else {
        return Err(refuse("/files", "Expected the project files of the bundle"));
    };
    for (key, value) in fields {
        let path = format!("/files/{}", escape(key));
        match (key.as_str(), value) {
            ("config" | "policies" | "schema", Json::String(_) | Json::Null) => {}
            ("tests", Json::Array(items)) => {
                if let Some(index) = items.iter().position(|item| !matches!(item, Json::String(_))) {
                    return Err(refuse(&format!("{path}/{index}"), "Expected a file path"));
                }
            }
            ("config" | "policies" | "schema" | "tests", _) => {
                return Err(refuse(&path, "Expected a file path"));
            }
            _ => return Err(refuse(&path, "Unknown bundle file field")),
        }
    }
    for key in ["config", "policies", "tests", "schema"] {
        if files.get(key).is_none() {
            return Err(refuse(&format!("/files/{key}"), "Missing bundle file field"));
        }
    }
    Ok(())
}

/// Validates a version 1 bundle given as JSON: its envelope, then every part with the validator of its
/// document, with paths from the bundle's root.
pub fn validate_bundle_json(document: &Json) -> Result<Bundle, AuthoringError> {
    let Json::Object(fields) = document else { return Err(refuse("", "Expected a bundle object")) };
    if let Some((key, _)) = fields.iter().find(|(key, _)| !FIELDS.contains(&key.as_str())) {
        return Err(refuse(&format!("/{}", escape(key)), "Unknown bundle field"));
    }
    if let Some(missing) = FIELDS.iter().find(|key| document.get(key).is_none()) {
        return Err(refuse(&format!("/{missing}"), "Missing bundle field"));
    }
    if !matches!(document.get("version"), Some(Json::Number(version)) if *version == 1.0) {
        return Err(refuse("/version", "Expected bundle version 1"));
    }
    check_context(document.get("context"))?;
    check_files(document.get("files"))?;
    if let Some(config @ Json::Object(_)) = document.get("config") {
        validate_config_json(config).map_err(|error| error.within("/config"))?;
    } else if document.get("config") != Some(&Json::Null) {
        return Err(refuse("/config", "Expected a config document or null"));
    }
    let policies = match document.get("policies") {
        Some(set @ Json::Object(_)) => {
            Some(validate_policy_set_json(set).map_err(|error| error.within("/policies"))?)
        }
        Some(Json::Null) => None,
        _ => {
            return Err(AuthoringError::new(
                AuthoringCode::InvalidQuery,
                "/policies",
                "Expected a policy set or null",
            ));
        }
    };
    let Some(Json::Array(tests)) = document.get("tests") else {
        return Err(AuthoringError::new(
            AuthoringCode::InvalidQuery,
            "/tests",
            "Expected an array of policy test cases",
        ));
    };
    for (index, test) in tests.iter().enumerate() {
        validate_policy_test_json(test).map_err(|error| error.within(&format!("/tests/{index}")))?;
    }
    match document.get("schema") {
        Some(schema @ Json::Object(_)) => {
            validate_collection_schema_json(schema).map_err(|error| error.within("/schema"))?;
        }
        Some(Json::Null) => {}
        _ => {
            return Err(AuthoringError::new(
                AuthoringCode::SchemaInvalid,
                "/schema",
                "Expected a collection schema or null",
            ));
        }
    }
    Ok(Bundle { policies })
}

/// Validates a version 1 bundle given as JSON text, as `canopy.js/emit` prints it.
pub fn validate_bundle(text: &str) -> Result<Bundle, AuthoringError> {
    validate_bundle_json(&parse(CODE, text)?)
}
