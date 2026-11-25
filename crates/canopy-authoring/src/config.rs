//! Unresolved config documents: `defineConfig` output with `env()` references kept symbolic.

use canopy_protocol::ejson::{DecodeOptions, decode};
use canopy_protocol::json::Json;

use crate::pointer::Pointer;
use crate::{AuthoringCode, AuthoringError, Kind, check_schema, parse};

const CODE: AuthoringCode = AuthoringCode::ConfigInvalid;

/// Checks the payload of a `$ejson` envelope: a document whose `$` keys are Extended JSON, except inside a
/// `$literal` wrapper, which holds a plain document.
fn check_raw(value: &Json, path: &mut Pointer) -> Result<(), AuthoringError> {
    match value {
        Json::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                path.push(&index.to_string());
                check_raw(item, path)?;
                path.pop();
            }
            Ok(())
        }
        Json::Object(fields) => {
            if let Some(literal @ Json::Object(_)) = value.get("$literal")
                && fields.len() == 1
            {
                path.push("$literal");
                let Json::Object(inner) = literal else { return Ok(()) };
                for (key, item) in inner {
                    path.push(key);
                    check_raw(item, path)?;
                    path.pop();
                }
                path.pop();
                return Ok(());
            }
            if fields.iter().any(|(key, _)| key.starts_with('$')) {
                return decode(value, DecodeOptions::default()).map(|_| ()).map_err(|error| {
                    AuthoringError::new(CODE, path.to_string(), error.message().to_owned())
                });
            }
            for (key, item) in fields {
                path.push(key);
                check_raw(item, path)?;
                path.pop();
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

fn check_envelopes(value: &Json, path: &mut Pointer) -> Result<(), AuthoringError> {
    match value {
        Json::Object(fields) => {
            if let (Some(payload), 1) = (value.get("$ejson"), fields.len()) {
                path.push("$ejson");
                check_raw(payload, path)?;
                path.pop();
                return Ok(());
            }
            for (key, item) in fields {
                path.push(key);
                check_envelopes(item, path)?;
                path.pop();
            }
            Ok(())
        }
        Json::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                path.push(&index.to_string());
                check_envelopes(item, path)?;
                path.pop();
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

/// Validates a version 1 unresolved config document given as JSON.
pub fn validate_config_json(document: &Json) -> Result<(), AuthoringError> {
    check_schema(Kind::Config, CODE, document)?;
    check_envelopes(document, &mut Pointer::default())
}

/// Validates a version 1 unresolved config document given as JSON text (the canonical document of
/// `canopy.js/config`).
pub fn validate_config(text: &str) -> Result<(), AuthoringError> {
    validate_config_json(&parse(CODE, text)?)
}
