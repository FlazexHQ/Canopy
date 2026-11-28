//! graphql-js metadata and ordering for Apollo's introspection executor.

use crate::build::{GeneratedSchema, SCALAR_NAMES};
use apollo_compiler::ast::{DirectiveDefinition, DirectiveLocation, FieldDefinition, Value};
use apollo_compiler::executable::{Operation, Selection, SelectionSet};
use apollo_compiler::request::RequestError;
use apollo_compiler::response::{ExecutionResponse, JsonMap};
use apollo_compiler::schema::{Component, EnumValueDefinition, ExtendedType};
use apollo_compiler::validation::Valid;
use apollo_compiler::{ExecutableDocument, Name, Node, Schema, introspection, name, ty};
use serde_json_bytes::Value as Json;
use std::collections::{HashMap, HashSet};

/// Adapts a validated Canopy SDL schema before parsing executable GraphQL documents.
pub fn prepare_schema(schema: Valid<Schema>, generated: &GeneratedSchema) -> Valid<Schema> {
    let mut schema = schema.into_inner();
    let order = generated.model.ordered_names(&SCALAR_NAMES);
    let tail = [
        "Boolean",
        "String",
        "__Schema",
        "__Type",
        "__TypeKind",
        "__Field",
        "__InputValue",
        "__EnumValue",
        "__Directive",
        "__DirectiveLocation",
    ];
    let mut ranks = HashMap::new();
    for (rank, name) in order.into_iter().chain(tail).enumerate() {
        ranks.entry(name).or_insert(rank);
    }
    schema.types.sort_by(|a, _, b, _| ranks.get(a.as_str()).cmp(&ranks.get(b.as_str())));

    if let Some(ExtendedType::Object(object)) = schema.types.get_mut("__Schema")
        && let Some(field) = object.make_mut().fields.get_mut("directives")
    {
        field.node.make_mut().arguments.push(Node::new(apollo_compiler::ast::InputValueDefinition {
            name: name!("includeDeprecated"),
            description: None,
            ty: Node::new(ty!(Boolean!)),
            default_value: Some(Node::new(Value::Boolean(false))),
            directives: Default::default(),
        }));
    }
    if let Some(ExtendedType::Object(object)) = schema.types.get_mut("__Type") {
        let fields = &mut object.make_mut().fields;
        if let Some((index, _, _)) = fields.get_full("specifiedByURL") {
            fields.move_index(index, 3);
        }
        fields.insert(name!("isOneOf"), introspection_field(name!("isOneOf"), ty!(Boolean)));
    }
    if let Some(ExtendedType::Object(object)) = schema.types.get_mut("__Directive") {
        let fields = &mut object.make_mut().fields;
        if let Some((index, _, _)) = fields.get_full("isRepeatable") {
            fields.move_index(index, 2);
        }
        fields.insert(name!("isDeprecated"), introspection_field(name!("isDeprecated"), ty!(Boolean!)));
        fields
            .insert(name!("deprecationReason"), introspection_field(name!("deprecationReason"), ty!(String)));
    }
    if let Some(ExtendedType::Enum(location)) = schema.types.get_mut("__DirectiveLocation") {
        location.make_mut().values.insert(
            name!("DIRECTIVE_DEFINITION"),
            Component::new(EnumValueDefinition {
                value: name!("DIRECTIVE_DEFINITION"),
                description: Some(Node::new_str("Location adjacent to a directive definition.")),
                directives: Default::default(),
            }),
        );
    }
    schema.directive_definitions.insert(
        name!("oneOf"),
        Node::new(DirectiveDefinition {
            name: name!("oneOf"),
            description: Some(Node::new_str(
                "Indicates exactly one field must be supplied and this field must not be `null`.",
            )),
            arguments: Vec::new(),
            repeatable: false,
            locations: vec![DirectiveLocation::InputObject],
        }),
    );
    if let Some((index, _, _)) = schema.directive_definitions.get_full("include") {
        schema.directive_definitions.move_index(index, 0);
    }
    Valid::assume_valid(schema)
}

fn introspection_field(name: Name, ty: apollo_compiler::ast::Type) -> Component<FieldDefinition> {
    Component::new(FieldDefinition {
        name,
        ty,
        arguments: Vec::new(),
        description: None,
        directives: Default::default(),
    })
}

#[derive(Clone, Copy)]
enum Metadata {
    OneOf,
    DirectiveDeprecated,
    DirectiveReason,
    DirectiveLocations,
}

impl Metadata {
    fn selection(parent: &str, field: &str) -> Option<(Self, &'static str)> {
        Some(match (parent, field) {
            ("__Type", "isOneOf") => (Self::OneOf, "kind"),
            ("__Directive", "isDeprecated") => (Self::DirectiveDeprecated, "isRepeatable"),
            ("__Directive", "deprecationReason") => (Self::DirectiveReason, "description"),
            ("__Directive", "locations") => (Self::DirectiveLocations, "locations"),
            _ => return None,
        })
    }

    fn value(self, mut value: Json) -> Json {
        match self {
            Self::OneOf if value.as_str() == Some("INPUT_OBJECT") => Json::Bool(false),
            Self::OneOf | Self::DirectiveReason => Json::Null,
            Self::DirectiveDeprecated => Json::Bool(false),
            Self::DirectiveLocations => {
                if let Json::Array(locations) = &mut value
                    && locations.iter().any(|location| location.as_str() == Some("ENUM_VALUE"))
                {
                    locations.push(Json::from("DIRECTIVE_DEFINITION"));
                }
                value
            }
        }
    }
}

fn visit_fields(set: &SelectionSet, visit: &mut impl FnMut(&Name, &apollo_compiler::executable::Field)) {
    for selection in &set.selections {
        match selection {
            Selection::Field(field) => {
                visit(&set.ty, field);
                visit_fields(&field.selection_set, visit);
            }
            Selection::InlineFragment(fragment) => visit_fields(&fragment.selection_set, visit),
            Selection::FragmentSpread(_) => {}
        }
    }
}

fn adapt_selections(set: &mut SelectionSet, schema: &Schema, aliases: &HashMap<(Name, Name, Name), Name>) {
    for selection in &mut set.selections {
        match selection {
            Selection::Field(field) => {
                let field = field.make_mut();
                let key = (set.ty.clone(), field.name.clone(), field.response_key().clone());
                if let Some(alias) = aliases.get(&key)
                    && let Some((_, replacement)) = Metadata::selection(set.ty.as_str(), field.name.as_str())
                    && let Ok(definition) = schema.type_field(set.ty.as_str(), replacement)
                {
                    field.alias = Some(alias.clone());
                    field.name = definition.name.clone();
                    field.definition = definition.node.clone();
                    field.arguments.clear();
                }
                adapt_selections(&mut field.selection_set, schema, aliases);
            }
            Selection::InlineFragment(fragment) => {
                adapt_selections(&mut fragment.make_mut().selection_set, schema, aliases);
            }
            Selection::FragmentSpread(_) => {}
        }
    }
}

fn restore_values(data: JsonMap, metadata: &HashMap<String, (Name, Metadata)>) -> JsonMap {
    data.into_iter()
        .map(|(key, value)| match metadata.get(key.as_str()) {
            Some((original, kind)) => (original.as_str().into(), kind.value(value)),
            None => (key, restore_children(value, metadata)),
        })
        .collect()
}

fn restore_children(value: Json, metadata: &HashMap<String, (Name, Metadata)>) -> Json {
    match value {
        Json::Object(data) => Json::Object(restore_values(data, metadata)),
        Json::Array(items) => Json::Array(items.into_iter().map(|v| restore_children(v, metadata)).collect()),
        other => other,
    }
}

/// Executes the introspection selections in a validated operation on a prepared schema.
pub fn partial_execute(
    schema: &Valid<Schema>,
    document: &Valid<ExecutableDocument>,
    operation: &Operation,
    variables: &Valid<JsonMap>,
) -> Result<ExecutionResponse, RequestError> {
    let mut keys = HashSet::new();
    let mut replacements = Vec::new();
    let mut collect = |parent: &Name, field: &apollo_compiler::executable::Field| {
        keys.insert(field.response_key().clone());
        if let Some((kind, _)) = Metadata::selection(parent.as_str(), field.name.as_str()) {
            replacements.push((parent.clone(), field.name.clone(), field.response_key().clone(), kind));
        }
    };
    visit_fields(&operation.selection_set, &mut collect);
    for fragment in document.fragments.values() {
        visit_fields(&fragment.selection_set, &mut collect);
    }
    let implementers = schema.implementers_map();
    if replacements.is_empty() {
        return introspection::partial_execute(schema, &implementers, document, operation, variables);
    }

    let mut aliases = HashMap::new();
    let mut metadata = HashMap::new();
    let mut index = 0;
    for (parent, field, original, kind) in replacements {
        aliases.entry((parent, field, original.clone())).or_insert_with(|| {
            let alias = loop {
                let candidate = format!("_canopyMetadata{index}");
                index += 1;
                if !keys.contains(candidate.as_str())
                    && let Ok(name) = Name::new(&candidate)
                {
                    break name;
                }
            };
            metadata.insert(alias.to_string(), (original, kind));
            alias
        });
    }
    let mut adapted = (**document).clone();
    for fragment in adapted.fragments.values_mut() {
        adapt_selections(&mut fragment.make_mut().selection_set, schema, &aliases);
    }
    let mut operation = operation.clone();
    adapt_selections(&mut operation.selection_set, schema, &aliases);
    let mut response = introspection::partial_execute(
        schema,
        &implementers,
        &Valid::assume_valid(adapted),
        &operation,
        variables,
    )?;
    response.data = response.data.map(|data| restore_values(data, &metadata));
    Ok(response)
}
