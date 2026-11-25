use canopy_config::authoring::Command;
use canopy_policy::PolicySet;
use canopy_protocol::ejson::{DecodeOptions, decode};
use canopy_protocol::json::Json;
use canopy_protocol::{Document, Value};

use crate::project::LoadError;

/// Who a policy test case acts as.
pub(crate) struct Actor {
    pub(crate) label: String,
    pub(crate) roles: Vec<String>,
    pub(crate) claims: Option<Document>,
    pub(crate) ctx: Option<Document>,
}

/// What a policy test case runs against: one document, or every document a filter matches.
pub(crate) enum Subject {
    Document(Document),
    Filter(Document),
}

/// One policy test case of the bundle.
pub(crate) struct TestCase {
    pub(crate) suite: String,
    pub(crate) collection: String,
    pub(crate) actor: Actor,
    pub(crate) action: canopy_policy::Operation,
    pub(crate) expected: bool,
    pub(crate) subject: Subject,
    pub(crate) update: Option<Value>,
    pub(crate) with_fields: Vec<String>,
    pub(crate) without_fields: Vec<String>,
}

/// The canonical bundle of a project, validated: the documents `canopy.js/emit` printed.
pub(crate) struct Bundle {
    /// The bundle as it was emitted, which `canopy build` writes.
    pub(crate) json: Json,
    /// The policy folder relative to the project root, when the project has one.
    pub(crate) files_policies: Option<String>,
    /// The unresolved config document, or `None` in zero config mode.
    pub(crate) config: Option<Json>,
    /// The policy set of the policy folder.
    pub(crate) policies: Option<PolicySet>,
    /// The policy test cases.
    pub(crate) tests: Vec<TestCase>,
}

fn text(value: &Json, key: &str) -> Option<String> {
    match value.get(key) {
        Some(Json::String(text)) => Some(text.clone()),
        _ => None,
    }
}

fn strings(value: Option<&Json>) -> Vec<String> {
    match value {
        Some(Json::Array(items)) => items
            .iter()
            .filter_map(|item| match item {
                Json::String(text) => Some(text.clone()),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn document(value: Option<&Json>, path: &str) -> Result<Option<Document>, LoadError> {
    let Some(value) = value.filter(|value| !matches!(value, Json::Null)) else { return Ok(None) };
    match decode(value, DecodeOptions::default()) {
        Ok(Value::Document(document)) => Ok(Some(document)),
        Ok(_) => Err(invalid("tests", format!("{path}: Expected a document"))),
        Err(error) => Err(invalid("tests", format!("{path}: {}", error.message()))),
    }
}

fn invalid(part: &str, message: String) -> LoadError {
    LoadError::Invalid { part: part.to_owned(), message }
}

fn test_case(value: &Json, index: usize) -> Result<TestCase, LoadError> {
    let at = |key: &str| format!("/tests/{index}/{key}");
    let actor = value.get("actor").unwrap_or(&Json::Null);
    let action = text(value, "action").unwrap_or_default();
    let action = canopy_policy::Operation::parse(&action)
        .ok_or_else(|| invalid("tests", format!("{}: Unknown action {action}", at("action"))))?;
    let subject =
        match (document(value.get("doc"), &at("doc"))?, document(value.get("filter"), &at("filter"))?) {
            (Some(doc), _) => Subject::Document(doc),
            (None, Some(filter)) => Subject::Filter(filter),
            (None, None) => return Err(invalid("tests", format!("{}: Expected doc or filter", at("doc")))),
        };
    let update = match value.get("update") {
        Some(update) => Some(
            decode(update, DecodeOptions::default())
                .map_err(|error| invalid("tests", format!("{}: {}", at("update"), error.message())))?,
        ),
        None => None,
    };
    Ok(TestCase {
        suite: text(value, "suite").unwrap_or_default(),
        collection: text(value, "collection").unwrap_or_default(),
        actor: Actor {
            label: text(actor, "label").unwrap_or_default(),
            roles: strings(actor.get("roles")),
            claims: document(actor.get("claims"), &at("actor/claims"))?,
            ctx: document(actor.get("ctx"), &at("actor/ctx"))?,
        },
        action,
        expected: value.get("expected") == Some(&Json::Bool(true)),
        subject,
        update,
        with_fields: strings(value.get("withFields")),
        without_fields: strings(value.get("withoutFields")),
    })
}

impl Bundle {
    /// The bundle of a project without a config file or policy folder.
    pub(crate) fn empty(mode: &str, command: Command) -> Bundle {
        let json = Json::Object(vec![
            ("version".to_owned(), Json::Number(1.0)),
            (
                "context".to_owned(),
                Json::Object(vec![
                    ("mode".to_owned(), Json::String(mode.to_owned())),
                    ("command".to_owned(), Json::String(command.as_str().to_owned())),
                ]),
            ),
            (
                "files".to_owned(),
                Json::Object(vec![
                    ("config".to_owned(), Json::Null),
                    ("policies".to_owned(), Json::Null),
                    ("tests".to_owned(), Json::Array(Vec::new())),
                    ("schema".to_owned(), Json::Null),
                ]),
            ),
            ("config".to_owned(), Json::Null),
            ("policies".to_owned(), Json::Null),
            ("tests".to_owned(), Json::Array(Vec::new())),
            ("schema".to_owned(), Json::Null),
        ]);
        Bundle { json, files_policies: None, config: None, policies: None, tests: Vec::new() }
    }

    /// Validates a bundle against the canonical documents and reads its parts.
    pub(crate) fn parse(json: &Json) -> Result<Bundle, LoadError> {
        let validated = canopy_authoring::validate_bundle_json(json).map_err(|error| {
            let path = error.path();
            let part = ["config", "policies", "tests", "schema"]
                .into_iter()
                .find(|part| path.strip_prefix('/').is_some_and(|rest| rest.split('/').next() == Some(*part)))
                .unwrap_or("bundle");
            invalid(part, format!("{}: {}", if path.is_empty() { "/" } else { path }, error.message()))
        })?;
        let tests = match json.get("tests") {
            Some(Json::Array(items)) => items
                .iter()
                .enumerate()
                .map(|(index, item)| test_case(item, index))
                .collect::<Result<_, _>>()?,
            _ => Vec::new(),
        };
        Ok(Bundle {
            json: json.clone(),
            files_policies: json.get("files").and_then(|files| text(files, "policies")),
            config: json.get("config").filter(|config| !matches!(config, Json::Null)).cloned(),
            policies: validated.policies,
            tests,
        })
    }

    /// The policy set, or an empty one when the project has no policy folder.
    pub(crate) fn policy_set(&self) -> Result<PolicySet, String> {
        match &self.policies {
            Some(set) => Ok(set.clone()),
            None => {
                canopy_policy::create_policy_set(Vec::new(), canopy_policy::ContextDefinitions::default())
                    .map_err(|error| error.message().to_owned())
            }
        }
    }
}
