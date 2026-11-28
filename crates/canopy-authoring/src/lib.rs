//! Validation of the canonical authoring documents that `canopy.js` builders emit and the CLI and `canopyd`
//! read: policy sets, policy test cases, unresolved config, collection schemas, and the bundle that carries
//! them. Each document is checked against its JSON Schema (embedded from `conformance/authoring`) and then
//! against the Rust semantics (the policy compiler, Extended JSON decoding, the collection schema rules).
//! A refusal names a stable code and an RFC 6901 pointer to the offending value.

mod bundle;
mod collection;
mod config;
mod json_schema;
mod pointer;
mod policy;

use std::fmt;
use std::sync::OnceLock;

use canopy_protocol::json::{Json, parse_json};

pub use bundle::{Bundle, validate_bundle, validate_bundle_json};
pub use collection::{validate_collection_schema, validate_collection_schema_json};
pub use config::{validate_config, validate_config_json};
pub use policy::{
    validate_policy_set, validate_policy_set_json, validate_policy_test, validate_policy_test_json,
};

use crate::json_schema::{Failure, Schema};

/// The stable code of an authoring refusal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AuthoringCode {
    /// `CANOPY_INVALID_QUERY`: a policy set or a policy test case.
    InvalidQuery,
    /// `CANOPY_CONFIG_INVALID`: an unresolved config, or a bundle's envelope.
    ConfigInvalid,
    /// `CANOPY_SCHEMA_INVALID`: a collection schema.
    SchemaInvalid,
}

impl AuthoringCode {
    /// The code as it appears on the wire and in error output.
    pub fn as_str(self) -> &'static str {
        match self {
            AuthoringCode::InvalidQuery => "CANOPY_INVALID_QUERY",
            AuthoringCode::ConfigInvalid => "CANOPY_CONFIG_INVALID",
            AuthoringCode::SchemaInvalid => "CANOPY_SCHEMA_INVALID",
        }
    }
}

/// Why an authoring document was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthoringError {
    code: AuthoringCode,
    path: String,
    message: String,
}

impl AuthoringError {
    /// A refusal at `path`, an escaped RFC 6901 pointer (empty for the whole document).
    pub fn new(code: AuthoringCode, path: impl Into<String>, message: impl Into<String>) -> AuthoringError {
        AuthoringError { code, path: path.into(), message: message.into() }
    }

    /// The stable code.
    pub fn code(&self) -> AuthoringCode {
        self.code
    }

    /// The RFC 6901 pointer to the refused value, empty for the whole document.
    pub fn path(&self) -> &str {
        &self.path
    }

    /// What is wrong, without the path.
    pub fn message(&self) -> &str {
        &self.message
    }

    /// The same refusal inside an enclosing document, at `prefix` (an escaped pointer).
    pub fn within(self, prefix: &str) -> AuthoringError {
        AuthoringError { path: pointer::join(prefix, &self.path), ..self }
    }

    fn from_failure(code: AuthoringCode, failure: Failure) -> AuthoringError {
        AuthoringError::new(code, failure.path, failure.message)
    }
}

impl fmt::Display for AuthoringError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        let path = if self.path.is_empty() { "/" } else { &self.path };
        write!(out, "{path}: {}", self.message)
    }
}

impl std::error::Error for AuthoringError {}

/// The JSON Schemas of the canonical documents, version 1.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    PolicySet,
    PolicyTest,
    Config,
    CollectionSchema,
}

fn schema(kind: Kind) -> Result<&'static Schema, AuthoringError> {
    static POLICY_SET: OnceLock<Result<Schema, String>> = OnceLock::new();
    static POLICY_TEST: OnceLock<Result<Schema, String>> = OnceLock::new();
    static CONFIG: OnceLock<Result<Schema, String>> = OnceLock::new();
    static COLLECTION_SCHEMA: OnceLock<Result<Schema, String>> = OnceLock::new();
    let (cell, text, code) = match kind {
        Kind::PolicySet => (
            &POLICY_SET,
            include_str!("../../../conformance/authoring/policy-set.schema.json"),
            AuthoringCode::InvalidQuery,
        ),
        Kind::PolicyTest => (
            &POLICY_TEST,
            include_str!("../../../conformance/authoring/policy-test.schema.json"),
            AuthoringCode::InvalidQuery,
        ),
        Kind::Config => (
            &CONFIG,
            include_str!("../../../conformance/authoring/config.schema.json"),
            AuthoringCode::ConfigInvalid,
        ),
        Kind::CollectionSchema => (
            &COLLECTION_SCHEMA,
            include_str!("../../../conformance/authoring/collection-schema.schema.json"),
            AuthoringCode::SchemaInvalid,
        ),
    };
    cell.get_or_init(|| Schema::new(text).map_err(|error| error.message().to_owned())).as_ref().map_err(
        |message| AuthoringError::new(code, "", format!("The embedded JSON Schema is invalid: {message}")),
    )
}

fn check_schema(kind: Kind, code: AuthoringCode, document: &Json) -> Result<(), AuthoringError> {
    schema(kind)?.validate(document).map_err(|failure| AuthoringError::from_failure(code, failure))
}

fn parse(code: AuthoringCode, text: &str) -> Result<Json, AuthoringError> {
    parse_json(text).map_err(|error| AuthoringError::new(code, "", error.message().to_owned()))
}
