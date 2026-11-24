//! Limits on one operation: how deep its fields nest, how many aliases it uses, and what it costs, where
//! every field costs 1 multiplied by the `limit` of each list field above it.

use crate::errors::GraphqlError;
use apollo_compiler::ast::{OperationType, Value as AstValue};
use apollo_compiler::executable::{Fragment, Operation, Selection, SelectionSet};
use apollo_compiler::schema::{ExtendedType, FieldDefinition};
use apollo_compiler::validation::Valid;
use apollo_compiler::{ExecutableDocument, Node, Schema};
use canopy_protocol::json::{Json, js_number_string};
use std::collections::HashMap;

/// Limits on one GraphQL operation.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct OperationLimits {
    /// The deepest field nesting. Defaults to 10.
    pub max_depth: u32,
    /// The largest cost. Defaults to 5,000.
    pub max_complexity: f64,
    /// The most aliased fields. Defaults to 30.
    pub max_aliases: u32,
}

impl Default for OperationLimits {
    fn default() -> OperationLimits {
        OperationLimits { max_depth: 10, max_complexity: 5000.0, max_aliases: 30 }
    }
}

/// What an operation measures.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct OperationCost {
    /// The deepest field nesting, root fields at 1.
    pub depth: u32,
    /// The cost.
    pub complexity: f64,
    /// The aliased fields.
    pub aliases: u32,
}

struct Walk<'a> {
    schema: &'a Schema,
    fragments: &'a apollo_compiler::collections::IndexMap<apollo_compiler::Name, Node<Fragment>>,
    variables: HashMap<String, Json>,
    aliases: u32,
    depth: u32,
}

fn untyped(value: &AstValue, variables: &HashMap<String, Json>) -> Option<Json> {
    Some(match value {
        AstValue::Null => Json::Null,
        AstValue::Variable(name) => return variables.get(name.as_str()).cloned(),
        AstValue::Int(number) => Json::Number(number.as_str().parse::<f64>().unwrap_or(f64::NAN)),
        AstValue::Float(number) => Json::Number(number.as_str().parse::<f64>().unwrap_or(f64::NAN)),
        AstValue::String(text) => Json::String(text.clone()),
        AstValue::Boolean(flag) => Json::Bool(*flag),
        AstValue::Enum(name) => Json::String(name.to_string()),
        AstValue::List(items) => {
            Json::Array(items.iter().filter_map(|item| untyped(item, variables)).collect())
        }
        AstValue::Object(fields) => Json::Object(
            fields
                .iter()
                .filter_map(|(key, item)| Some((key.to_string(), untyped(item, variables)?)))
                .collect(),
        ),
    })
}

fn multiplier(
    field: Option<&FieldDefinition>,
    arguments: &[Node<apollo_compiler::ast::Argument>],
    variables: &HashMap<String, Json>,
) -> f64 {
    let fallback = field
        .and_then(|field| field.arguments.iter().find(|argument| argument.name == "limit"))
        .and_then(|argument| argument.default_value.as_ref())
        .and_then(|value| untyped(value, variables));
    let supplied = arguments
        .iter()
        .find(|argument| argument.name == "limit")
        .and_then(|argument| untyped(&argument.value, variables));
    let value = match supplied {
        None | Some(Json::Null) => fallback,
        some => some,
    };
    match value {
        Some(Json::Number(number)) if number.is_finite() && number > 0.0 => number,
        _ => 1.0,
    }
}

fn field_of<'a>(schema: &'a Schema, parent: Option<&str>, name: &str) -> Option<&'a FieldDefinition> {
    match schema.types.get(parent?)? {
        ExtendedType::Object(object) => object.fields.get(name).map(|field| &***field),
        ExtendedType::Interface(interface) => interface.fields.get(name).map(|field| &***field),
        _ => None,
    }
}

fn cost(
    walk: &mut Walk<'_>,
    set: &SelectionSet,
    parent: Option<&str>,
    factor: f64,
    depth: u32,
    visiting: &mut Vec<String>,
) -> f64 {
    let mut total = 0.0;
    for selection in &set.selections {
        match selection {
            Selection::Field(field) => {
                if field.name.as_str().starts_with("__") {
                    continue;
                }
                if field.alias.is_some() {
                    walk.aliases += 1;
                }
                walk.depth = walk.depth.max(depth);
                total += factor;
                if field.selection_set.selections.is_empty() {
                    continue;
                }
                let definition = field_of(walk.schema, parent, field.name.as_str());
                let child = definition.map(|definition| definition.ty.inner_named_type().to_string());
                let factor = factor * multiplier(definition, &field.arguments, &walk.variables);
                total += cost(walk, &field.selection_set, child.as_deref(), factor, depth + 1, visiting);
            }
            Selection::InlineFragment(fragment) => {
                let condition = fragment.type_condition.as_ref().map(|name| name.to_string());
                let ty = match condition {
                    Some(name) => walk.schema.types.contains_key(name.as_str()).then_some(name),
                    None => parent.map(str::to_owned),
                };
                total += cost(walk, &fragment.selection_set, ty.as_deref(), factor, depth, visiting);
            }
            Selection::FragmentSpread(spread) => {
                let name = spread.fragment_name.to_string();
                if visiting.contains(&name) {
                    continue;
                }
                let Some(fragment) = walk.fragments.get(name.as_str()).cloned() else { continue };
                visiting.push(name);
                let condition = fragment.selection_set.ty.to_string();
                let ty = walk.schema.types.contains_key(condition.as_str()).then_some(condition);
                total += cost(walk, &fragment.selection_set, ty.as_deref(), factor, depth, visiting);
                visiting.pop();
            }
        }
    }
    total
}

/// Measures the depth, aliases and cost of the operation that will run.
pub fn measure_operation(
    schema: &Valid<Schema>,
    document: &Valid<ExecutableDocument>,
    operation: &Operation,
    variables: &[(String, Json)],
) -> OperationCost {
    let mut effective: HashMap<String, Json> = HashMap::new();
    for definition in &operation.variables {
        if let Some(default) = &definition.default_value
            && let Some(value) = untyped(default, &HashMap::new())
        {
            effective.insert(definition.name.to_string(), value);
        }
    }
    for (name, value) in variables {
        effective.insert(name.clone(), value.clone());
    }
    let root = match operation.operation_type {
        OperationType::Query => schema.schema_definition.query.as_ref(),
        OperationType::Mutation => schema.schema_definition.mutation.as_ref(),
        OperationType::Subscription => schema.schema_definition.subscription.as_ref(),
    }
    .map(|name| name.to_string());
    let mut walk =
        Walk { schema, fragments: &document.fragments, variables: effective, aliases: 0, depth: 0 };
    let complexity = cost(&mut walk, &operation.selection_set, root.as_deref(), 1.0, 1, &mut Vec::new());
    OperationCost { depth: walk.depth, complexity, aliases: walk.aliases }
}

fn limit_error(message: String, limit: &str, value: f64, max: f64) -> GraphqlError {
    let mut error = GraphqlError::coded(message, "CANOPY_INVALID_QUERY");
    error.extensions.push((
        "details".to_owned(),
        Json::Object(vec![
            ("limit".to_owned(), Json::String(limit.to_owned())),
            ("value".to_owned(), Json::Number(value)),
            ("max".to_owned(), Json::Number(max)),
        ]),
    ));
    error
}

/// Checks an operation against the limits; an empty list when it fits.
pub fn check_operation(
    schema: &Valid<Schema>,
    document: &Valid<ExecutableDocument>,
    operation: &Operation,
    variables: &[(String, Json)],
    limits: &OperationLimits,
) -> Vec<GraphqlError> {
    let measured = measure_operation(schema, document, operation, variables);
    let mut errors = Vec::new();
    if measured.depth > limits.max_depth {
        errors.push(limit_error(
            format!(
                "The operation is {} fields deep; at most {} are allowed",
                measured.depth, limits.max_depth
            ),
            "depth",
            f64::from(measured.depth),
            f64::from(limits.max_depth),
        ));
    }
    if measured.aliases > limits.max_aliases {
        errors.push(limit_error(
            format!(
                "The operation uses {} aliases; at most {} are allowed",
                measured.aliases, limits.max_aliases
            ),
            "aliases",
            f64::from(measured.aliases),
            f64::from(limits.max_aliases),
        ));
    }
    if measured.complexity > limits.max_complexity {
        errors.push(limit_error(
            format!(
                "The operation costs {}; the budget is {}",
                js_number_string(measured.complexity),
                js_number_string(limits.max_complexity)
            ),
            "complexity",
            measured.complexity,
            limits.max_complexity,
        ));
    }
    errors
}
