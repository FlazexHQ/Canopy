//! Executes one validated operation. Each root field is one read or write of `canopy-data`; documents are
//! written field by field from BSON; every relation requested at one level of the response is loaded with
//! one `$in` read per relation, under the target collection's policies, before the next level starts.

use crate::build::{CollectionPlan, GeneratedSchema};
use crate::errors::{GraphqlError, PathSegment};
use crate::filters::{NotADocument, to_mongo_document, to_mongo_filter, to_mongo_sort, to_mongo_update};
use crate::model::{FieldPlan, MutationKind, Relation, TypeDef};
use crate::values::{Input, parse_builtin, parse_custom, serialize};
use apollo_compiler::ast::{OperationType, Type, Value as AstValue};
use apollo_compiler::executable::{Field, Operation, Selection, SelectionSet};
use apollo_compiler::schema::ExtendedType;
use apollo_compiler::validation::Valid;
use apollo_compiler::{ExecutableDocument, Node, Schema};
use canopy_data::writes::{WriteOp, WriteOptions, WritePath, WriteRequest};
use canopy_data::{Caller, CountMode, FindRequest, ReadPath};
use canopy_protocol::ejson::canonical_string;
use canopy_protocol::json::Json;
use canopy_protocol::{CanopyError, Document, Value, ValueRef};
use std::collections::HashMap;
use std::sync::Arc;

/// What an operation reads and writes through: the caller's read and write paths.
pub struct Services<'a> {
    /// The read path.
    pub reads: &'a ReadPath,
    /// The write path, when writes are served.
    pub writes: Option<&'a WritePath>,
    /// The caller.
    pub caller: &'a Caller,
    /// The `Idempotency-Key` of the request, honored when the operation is a single mutation.
    pub idempotency_key: Option<String>,
}

/// The result of an operation: `data` (absent when the operation did not start) and the errors.
#[derive(Clone, Debug, PartialEq)]
pub struct ExecutionResult {
    /// The data; `None` when a request error stopped the operation before it ran.
    pub data: Option<Json>,
    /// The errors, in the order they happened.
    pub errors: Vec<GraphqlError>,
}

impl ExecutionResult {
    /// A result with errors only.
    pub fn failed(errors: Vec<GraphqlError>) -> ExecutionResult {
        ExecutionResult { data: None, errors }
    }
}

const INVALID_QUERY: &str = "CANOPY_INVALID_QUERY";
const RELATION_CHUNK: usize = 1000;
const RELATION_PAGES: usize = 10;

/// A value on its way into the response.
#[derive(Clone, Debug)]
enum Val {
    Null,
    Leaf(Json),
    Bson(Value),
    Doc(Arc<Document>),
    List(Vec<Val>),
    Entries(Vec<(&'static str, Val)>),
}

#[derive(Clone, Debug)]
enum Slot {
    Null,
    Failed,
    Leaf(Json),
    List(Vec<usize>, bool),
    Object(Vec<(String, usize, bool)>),
}

struct Pending<'d> {
    slot: usize,
    relation: Relation,
    key: Value,
    limit: i64,
    ty: &'d Type,
    fields: Vec<&'d Node<Field>>,
    path: Vec<PathSegment>,
    owner: String,
}

struct Exec<'d, 's> {
    generated: &'s GeneratedSchema,
    schema: &'d Valid<Schema>,
    document: &'d Valid<ExecutableDocument>,
    variables: HashMap<String, Input>,
    services: &'s Services<'s>,
    slots: Vec<Slot>,
    errors: Vec<GraphqlError>,
    pending: Vec<Pending<'d>>,
    root: &'static str,
    root_mutations: usize,
    writes: usize,
}

fn location_of<T>(node: &Node<T>, document: &ExecutableDocument) -> Vec<(usize, usize)> {
    node.line_column_range(&document.sources)
        .map(|range| vec![(range.start.line, range.start.column)])
        .unwrap_or_default()
}

fn type_label(ty: &Type) -> String {
    ty.to_string()
}

impl<'d, 's> Exec<'d, 's> {
    fn alloc(&mut self, slot: Slot) -> usize {
        self.slots.push(slot);
        self.slots.len() - 1
    }

    fn locations(&self, fields: &[&'d Node<Field>]) -> Vec<(usize, usize)> {
        fields.iter().flat_map(|field| location_of(field, self.document)).collect()
    }

    fn field_error(&mut self, error: GraphqlError, fields: &[&'d Node<Field>], path: &[PathSegment]) {
        let error = error.at(self.locations(fields), Some(path.to_vec()));
        self.errors.push(error);
    }

    fn skipped(&self, directives: &apollo_compiler::executable::DirectiveList) -> bool {
        for directive in directives.iter() {
            let condition = directive.specified_argument_by_name("if").map(|value| match value.as_ref() {
                AstValue::Boolean(flag) => *flag,
                AstValue::Variable(name) => {
                    matches!(self.variables.get(name.as_str()), Some(Input::Bool(true)))
                }
                _ => false,
            });
            match (directive.name.as_str(), condition) {
                ("skip", Some(true)) | ("include", Some(false)) => return true,
                _ => {}
            }
        }
        false
    }

    fn collect(
        &self,
        type_name: &str,
        set: &'d SelectionSet,
        out: &mut Vec<(String, Vec<&'d Node<Field>>)>,
        visited: &mut Vec<&'d str>,
    ) {
        for selection in &set.selections {
            match selection {
                Selection::Field(field) => {
                    if self.skipped(&field.directives) {
                        continue;
                    }
                    let key = field.response_key().as_str();
                    match out.iter_mut().find(|(existing, _)| existing == key) {
                        Some((_, fields)) => fields.push(field),
                        None => out.push((key.to_owned(), vec![field])),
                    }
                }
                Selection::InlineFragment(fragment) => {
                    if self.skipped(&fragment.directives) {
                        continue;
                    }
                    if fragment
                        .type_condition
                        .as_ref()
                        .is_some_and(|condition| condition.as_str() != type_name)
                    {
                        continue;
                    }
                    self.collect(type_name, &fragment.selection_set, out, visited);
                }
                Selection::FragmentSpread(spread) => {
                    let name = spread.fragment_name.as_str();
                    if self.skipped(&spread.directives) || visited.contains(&name) {
                        continue;
                    }
                    let Some(fragment) = self.document.fragments.get(name) else { continue };
                    visited.push(fragment.name.as_str());
                    if fragment.selection_set.ty.as_str() != type_name {
                        continue;
                    }
                    self.collect(type_name, &fragment.selection_set, out, visited);
                }
            }
        }
    }

    fn collected(&self, type_name: &str, fields: &[&'d Node<Field>]) -> Vec<(String, Vec<&'d Node<Field>>)> {
        let mut out = Vec::new();
        let mut visited = Vec::new();
        for field in fields {
            self.collect(type_name, &field.selection_set, &mut out, &mut visited);
        }
        out
    }

    fn arguments(&self, field: &'d Field) -> Result<Vec<(String, Input)>, String> {
        let mut out = Vec::new();
        for definition in &field.definition.arguments {
            let given = field.arguments.iter().find(|argument| argument.name == definition.name);
            let value = match given.map(|argument| argument.value.as_ref()) {
                Some(AstValue::Variable(name)) if !self.variables.contains_key(name.as_str()) => None,
                Some(value) => Some(self.literal(value, &definition.ty)?),
                None => None,
            };
            let value = match value {
                Some(value) => Some(value),
                None => match &definition.default_value {
                    Some(default) => Some(self.literal(default, &definition.ty)?),
                    None => None,
                },
            };
            if let Some(value) = value {
                out.push((definition.name.to_string(), value));
            }
        }
        Ok(out)
    }

    fn enum_value(&self, enum_name: &str, value: &str) -> Option<String> {
        match self.generated.model.get(enum_name) {
            Some(TypeDef::Enum { values, .. }) => {
                values.iter().find(|(name, _)| name == value).map(|(_, internal)| internal.clone())
            }
            _ => None,
        }
    }

    fn literal(&self, value: &AstValue, ty: &Type) -> Result<Input, String> {
        if let AstValue::Variable(name) = value {
            return Ok(self.variables.get(name.as_str()).cloned().unwrap_or(Input::Null));
        }
        if matches!(value, AstValue::Null) {
            return Ok(Input::Null);
        }
        match ty {
            Type::List(item) | Type::NonNullList(item) => match value {
                AstValue::List(items) => Ok(Input::List(
                    items
                        .iter()
                        .map(|item_value| self.literal(item_value, item))
                        .collect::<Result<_, _>>()?,
                )),
                other => Ok(Input::List(vec![self.literal(other, item)?])),
            },
            Type::Named(name) | Type::NonNullNamed(name) => self.named_literal(value, name.as_str()),
        }
    }

    fn named_literal(&self, value: &AstValue, name: &str) -> Result<Input, String> {
        match self.schema.types.get(name) {
            Some(ExtendedType::InputObject(object)) => {
                let AstValue::Object(given) = value else {
                    return Err(format!("Expected type \"{name}\" to be an object."));
                };
                let mut out = Vec::new();
                for (field_name, definition) in &object.fields {
                    let found =
                        given.iter().find(|(key, _)| key == field_name).map(|(_, value)| value.as_ref());
                    let value = match found {
                        Some(AstValue::Variable(variable))
                            if !self.variables.contains_key(variable.as_str()) =>
                        {
                            None
                        }
                        Some(found) => Some(self.literal(found, &definition.ty)?),
                        None => None,
                    };
                    let value = match (value, &definition.default_value) {
                        (Some(value), _) => Some(value),
                        (None, Some(default)) => Some(self.literal(default, &definition.ty)?),
                        (None, None) => None,
                    };
                    if let Some(value) = value {
                        out.push((field_name.to_string(), value));
                    }
                }
                Ok(Input::Object(out))
            }
            Some(ExtendedType::Enum(_)) => match value {
                AstValue::Enum(symbol) => self
                    .enum_value(name, symbol.as_str())
                    .map(Input::Enum)
                    .ok_or_else(|| format!("Value \"{symbol}\" does not exist in \"{name}\" enum.")),
                _ => Err(format!("Enum \"{name}\" cannot represent non-enum value.")),
            },
            _ => match name {
                "Int" | "Float" | "String" | "Boolean" | "ID" => builtin_literal(value, name),
                custom => parse_custom(custom, &literal_json(value, &self.variables)).map(Input::Bson),
            },
        }
    }

    fn coerce_variable(&self, value: &Json, ty: &Type) -> Result<Input, String> {
        if matches!(value, Json::Null) {
            return if ty.is_non_null() {
                Err(format!("Expected non-nullable type \"{}\" not to be null.", type_label(ty)))
            } else {
                Ok(Input::Null)
            };
        }
        match ty {
            Type::List(item) | Type::NonNullList(item) => match value {
                Json::Array(items) => Ok(Input::List(
                    items
                        .iter()
                        .map(|item_value| self.coerce_variable(item_value, item))
                        .collect::<Result<_, _>>()?,
                )),
                other => Ok(Input::List(vec![self.coerce_variable(other, item)?])),
            },
            Type::Named(name) | Type::NonNullNamed(name) => {
                let name = name.as_str();
                match self.schema.types.get(name) {
                    Some(ExtendedType::InputObject(object)) => {
                        let Json::Object(given) = value else {
                            return Err(format!("Expected type \"{name}\" to be an object."));
                        };
                        let mut out = Vec::new();
                        for (field_name, definition) in &object.fields {
                            match given.iter().find(|(key, _)| key == field_name.as_str()) {
                                Some((_, found)) => out.push((
                                    field_name.to_string(),
                                    self.coerce_variable(found, &definition.ty)?,
                                )),
                                None => match &definition.default_value {
                                    Some(default) => out.push((
                                        field_name.to_string(),
                                        self.literal(default, &definition.ty)?,
                                    )),
                                    None if definition.ty.is_non_null() => {
                                        return Err(format!(
                                            "Field \"{field_name}\" of required type \"{}\" was not provided.",
                                            type_label(&definition.ty)
                                        ));
                                    }
                                    None => {}
                                },
                            }
                        }
                        if let Some((unknown, _)) = given
                            .iter()
                            .find(|(key, _)| !object.fields.keys().any(|field| field.as_str() == key))
                        {
                            return Err(format!("Field \"{unknown}\" is not defined by type \"{name}\"."));
                        }
                        Ok(Input::Object(out))
                    }
                    Some(ExtendedType::Enum(_)) => match value {
                        Json::String(symbol) => self
                            .enum_value(name, symbol)
                            .map(Input::Enum)
                            .ok_or_else(|| format!("Value \"{symbol}\" does not exist in \"{name}\" enum.")),
                        other => Err(format!(
                            "Enum \"{name}\" cannot represent non-string value: {}.",
                            crate::values::inspect(other)
                        )),
                    },
                    _ => match name {
                        "Int" | "Float" | "String" | "Boolean" | "ID" => parse_builtin(name, value),
                        custom => parse_custom(custom, value).map(Input::Bson),
                    },
                }
            }
        }
    }

    fn coerce_variables(&mut self, operation: &'d Operation, given: &[(String, Json)]) -> Vec<GraphqlError> {
        let mut errors = Vec::new();
        for definition in &operation.variables {
            let name = definition.name.as_str();
            let locations = location_of(definition, self.document);
            let fail =
                |message: String| GraphqlError::coded(message, INVALID_QUERY).at(locations.clone(), None);
            match given.iter().find(|(key, _)| key == name) {
                None => match &definition.default_value {
                    Some(default) => match self.literal(default, &definition.ty) {
                        Ok(value) => {
                            self.variables.insert(name.to_owned(), value);
                        }
                        Err(message) => errors.push(fail(message)),
                    },
                    None if definition.ty.is_non_null() => errors.push(fail(format!(
                        "Variable \"${name}\" of required type \"{}\" was not provided.",
                        type_label(&definition.ty)
                    ))),
                    None => {}
                },
                Some((_, Json::Null)) if definition.ty.is_non_null() => errors.push(fail(format!(
                    "Variable \"${name}\" of non-null type \"{}\" must not be null.",
                    type_label(&definition.ty)
                ))),
                Some((_, value)) => match self.coerce_variable(value, &definition.ty) {
                    Ok(value) => {
                        self.variables.insert(name.to_owned(), value);
                    }
                    Err(message) => errors.push(fail(message)),
                },
            }
        }
        errors
    }

    fn complete(
        &mut self,
        slot: usize,
        ty: &'d Type,
        value: Val,
        fields: &[&'d Node<Field>],
        path: &[PathSegment],
        owner: &str,
    ) {
        if ty.is_non_null() {
            self.complete_nullable(slot, ty, value, fields, path, owner);
            if matches!(self.slots[slot], Slot::Null) {
                let field = fields.first().map_or("", |field| field.name.as_str());
                let error = GraphqlError::coded(
                    format!("Cannot return null for non-nullable field {owner}.{field}."),
                    INVALID_QUERY,
                );
                self.field_error(error, fields, path);
                self.slots[slot] = Slot::Failed;
            }
            return;
        }
        self.complete_nullable(slot, ty, value, fields, path, owner);
    }

    fn complete_nullable(
        &mut self,
        slot: usize,
        ty: &'d Type,
        value: Val,
        fields: &[&'d Node<Field>],
        path: &[PathSegment],
        owner: &str,
    ) {
        if matches!(value, Val::Null | Val::Bson(Value::Null | Value::Undefined)) {
            self.slots[slot] = Slot::Null;
            return;
        }
        match ty {
            Type::List(item) | Type::NonNullList(item) => {
                let items = match value {
                    Val::List(items) => items,
                    Val::Bson(Value::Array(items)) => items.into_iter().map(Val::Bson).collect(),
                    _ => {
                        let field = fields.first().map_or("", |field| field.name.as_str());
                        let error = GraphqlError::coded(
                            format!("Expected Iterable, but did not find one for field \"{owner}.{field}\"."),
                            INVALID_QUERY,
                        );
                        self.field_error(error, fields, path);
                        self.slots[slot] = Slot::Failed;
                        return;
                    }
                };
                let mut slots = Vec::with_capacity(items.len());
                for (index, item_value) in items.into_iter().enumerate() {
                    let child = self.alloc(Slot::Null);
                    let mut item_path = path.to_vec();
                    item_path.push(PathSegment::Index(index));
                    self.complete(child, item, item_value, fields, &item_path, owner);
                    slots.push(child);
                }
                self.slots[slot] = Slot::List(slots, item.is_non_null());
            }
            Type::Named(name) | Type::NonNullNamed(name) => {
                let name = name.as_str();
                match self.schema.types.get(name) {
                    Some(ExtendedType::Object(_)) => self.complete_object(slot, name, value, fields, path),
                    Some(ExtendedType::Enum(_)) => {
                        self.slots[slot] = match value {
                            Val::Leaf(json) => Slot::Leaf(json),
                            Val::Bson(Value::String(text)) => Slot::Leaf(Json::String(text)),
                            _ => Slot::Null,
                        };
                    }
                    _ => {
                        let written = match value {
                            Val::Leaf(json) => Ok(json),
                            Val::Bson(bson) => serialize(name, bson.view()),
                            Val::Doc(document) => {
                                serialize(name, ValueRef::Document(canopy_protocol::DocRef::Owned(&document)))
                            }
                            Val::List(_) | Val::Entries(_) | Val::Null => Ok(Json::Null),
                        };
                        match written {
                            Ok(json) => self.slots[slot] = Slot::Leaf(json),
                            Err(message) => {
                                self.field_error(GraphqlError::coded(message, INVALID_QUERY), fields, path);
                                self.slots[slot] = Slot::Failed;
                            }
                        }
                    }
                }
            }
        }
    }

    fn complete_object(
        &mut self,
        slot: usize,
        type_name: &str,
        value: Val,
        fields: &[&'d Node<Field>],
        path: &[PathSegment],
    ) {
        let document: Option<Arc<Document>> = match &value {
            Val::Doc(document) => Some(document.clone()),
            Val::Bson(Value::Document(document)) => Some(Arc::new(document.clone())),
            _ => None,
        };
        let entries = match value {
            Val::Entries(entries) => entries,
            _ => Vec::new(),
        };
        let collected = self.collected(type_name, fields);
        let mut out = Vec::with_capacity(collected.len());
        for (key, group) in collected {
            let Some(first) = group.first().copied() else { continue };
            let child = self.alloc(Slot::Null);
            let mut child_path = path.to_vec();
            child_path.push(PathSegment::Key(key.clone()));
            let ty = &first.definition.ty;
            out.push((key, child, ty.is_non_null()));
            if first.name == "__typename" {
                self.slots[child] = Slot::Leaf(Json::String(type_name.to_owned()));
                continue;
            }
            let plan =
                self.generated.model.field(type_name, first.name.as_str()).map(|field| field.plan.clone());
            let child_value = match plan {
                Some(FieldPlan::Value { source }) => document
                    .as_ref()
                    .and_then(|document| document.get(&source))
                    .cloned()
                    .map_or(Val::Null, Val::Bson),
                Some(FieldPlan::Relation(relation)) => {
                    let key_value =
                        document.as_ref().and_then(|document| document.get(&relation.local)).cloned();
                    match key_value {
                        None | Some(Value::Null | Value::Undefined) => {
                            if relation.many {
                                Val::List(Vec::new())
                            } else {
                                Val::Null
                            }
                        }
                        Some(key_value) => {
                            let limit = if relation.many {
                                match self.arguments(first) {
                                    Ok(arguments) => match arguments
                                        .iter()
                                        .find(|(name, _)| name == "limit")
                                        .map(|(_, value)| value)
                                    {
                                        Some(Input::Int(limit)) => i64::from(*limit),
                                        _ => i64::from(self.generated.default_limit),
                                    },
                                    Err(message) => {
                                        self.field_error(
                                            GraphqlError::coded(message, INVALID_QUERY),
                                            &group,
                                            &child_path,
                                        );
                                        self.slots[child] = Slot::Failed;
                                        continue;
                                    }
                                }
                                .min(i64::from(self.generated.max_limit))
                            } else {
                                1
                            };
                            self.pending.push(Pending {
                                slot: child,
                                relation,
                                key: key_value,
                                limit,
                                ty,
                                fields: group.clone(),
                                path: child_path,
                                owner: type_name.to_owned(),
                            });
                            continue;
                        }
                    }
                }
                Some(FieldPlan::Entry) => entries
                    .iter()
                    .find(|(name, _)| *name == first.name.as_str())
                    .map_or(Val::Null, |(_, value)| value.clone()),
                _ => Val::Null,
            };
            self.complete(child, ty, child_value, &group, &child_path, type_name);
        }
        self.slots[slot] = Slot::Object(out);
    }

    async fn load_relations(&mut self) {
        while !self.pending.is_empty() {
            let pending = std::mem::take(&mut self.pending);
            let mut groups: Vec<(String, Vec<Pending<'d>>)> = Vec::new();
            for item in pending {
                match groups.iter_mut().find(|(key, _)| *key == item.relation.key) {
                    Some((_, items)) => items.push(item),
                    None => groups.push((item.relation.key.clone(), vec![item])),
                }
            }
            for (_, items) in groups {
                let Some(first) = items.first() else { continue };
                let relation = first.relation.clone();
                match self.related(&relation, &items).await {
                    Ok(mut found) => {
                        for item in items {
                            let docs = std::mem::take(found.entry(item.slot).or_default());
                            let value = if relation.many {
                                Val::List(docs.into_iter().map(Val::Doc).collect())
                            } else {
                                docs.into_iter().next().map_or(Val::Null, Val::Doc)
                            };
                            self.complete(item.slot, item.ty, value, &item.fields, &item.path, &item.owner);
                        }
                    }
                    Err(error) => {
                        for item in items {
                            self.field_error(GraphqlError::from_canopy(&error), &item.fields, &item.path);
                            self.slots[item.slot] = Slot::Failed;
                        }
                    }
                }
            }
        }
    }

    async fn related(
        &self,
        relation: &Relation,
        items: &[Pending<'d>],
    ) -> Result<HashMap<usize, Vec<Arc<Document>>>, CanopyError> {
        let mut keys: Vec<(String, Value)> = Vec::new();
        let key_values = |value: &Value| -> Vec<Value> {
            match value {
                Value::Array(values) => values.clone(),
                other => vec![other.clone()],
            }
        };
        for item in items {
            for value in key_values(&item.key) {
                let id = canonical_string(&value)?;
                if !keys.iter().any(|(existing, _)| *existing == id) {
                    keys.push((id, value));
                }
            }
        }
        let mut by_key: HashMap<String, Vec<Arc<Document>>> = HashMap::new();
        let page_size = self.generated.max_limit;
        for chunk in keys.chunks(RELATION_CHUNK) {
            let mut after: Option<String> = None;
            for _ in 0..RELATION_PAGES {
                let mut condition = Document::new();
                condition.insert("$in", Value::Array(chunk.iter().map(|(_, value)| value.clone()).collect()));
                let mut filter = Document::new();
                filter.insert(&relation.foreign, Value::Document(condition));
                let page = self
                    .services
                    .reads
                    .find(
                        self.services.caller,
                        FindRequest {
                            collection: relation.to.clone(),
                            filter,
                            sort: None,
                            fields: None,
                            limit: Some(page_size),
                            skip: None,
                            after: after.take(),
                            count: None,
                        },
                    )
                    .await?;
                for document in page.documents()? {
                    let document = Arc::new(document);
                    let field = document.get(&relation.foreign).cloned().unwrap_or(Value::Undefined);
                    for value in key_values(&field) {
                        let id = canonical_string(&value).unwrap_or_default();
                        if !chunk.iter().any(|(existing, _)| *existing == id) {
                            continue;
                        }
                        by_key.entry(id).or_default().push(document.clone());
                    }
                }
                match page.next {
                    Some(next) => after = Some(next),
                    None => break,
                }
            }
        }
        let mut out = HashMap::new();
        for item in items {
            let mut docs: Vec<Arc<Document>> = Vec::new();
            for value in key_values(&item.key) {
                let id = canonical_string(&value)?;
                for document in by_key.get(&id).into_iter().flatten() {
                    if !docs.iter().any(|seen| Arc::ptr_eq(seen, document)) {
                        docs.push(document.clone());
                    }
                }
            }
            let length = i64::try_from(docs.len()).unwrap_or(i64::MAX);
            let end = if item.limit < 0 { (length + item.limit).max(0) } else { item.limit.min(length) };
            docs.truncate(usize::try_from(end).unwrap_or(0));
            out.insert(item.slot, docs);
        }
        Ok(out)
    }

    fn finish(&self, slot: usize) -> Option<Json> {
        match &self.slots[slot] {
            Slot::Null => Some(Json::Null),
            Slot::Failed => None,
            Slot::Leaf(json) => Some(json.clone()),
            Slot::List(items, non_null) => {
                let mut out = Vec::with_capacity(items.len());
                for item in items {
                    match self.finish(*item) {
                        Some(json) => out.push(json),
                        None if *non_null => return None,
                        None => out.push(Json::Null),
                    }
                }
                Some(Json::Array(out))
            }
            Slot::Object(entries) => {
                let mut out = Vec::with_capacity(entries.len());
                for (key, child, non_null) in entries {
                    match self.finish(*child) {
                        Some(json) => out.push((key.clone(), json)),
                        None if *non_null => return None,
                        None => out.push((key.clone(), Json::Null)),
                    }
                }
                Some(Json::Object(out))
            }
        }
    }

    async fn resolve_root(&mut self, field: &'d Node<Field>) -> Result<Val, GraphqlError> {
        let arguments =
            self.arguments(field).map_err(|message| GraphqlError::coded(message, INVALID_QUERY))?;
        let argument = |name: &str| arguments.iter().find(|(key, _)| key == name).map(|(_, value)| value);
        let plan = self
            .generated
            .model
            .field(self.root, field.name.as_str())
            .map(|definition| definition.plan.clone());
        let canopy = |error: CanopyError| GraphqlError::from_canopy(&error);
        let invalid = |NotADocument(message): NotADocument| GraphqlError::coded(message, INVALID_QUERY);
        match plan {
            Some(FieldPlan::List { collection }) => {
                let model = self.collection(&collection)?;
                let filter = to_mongo_filter(argument("filter"), &model.filter_map).map_err(invalid)?;
                let total =
                    field.selection_set.selections.iter().any(
                        |selection| matches!(selection, Selection::Field(child) if child.name == "total"),
                    );
                let limit = match argument("limit") {
                    Some(Input::Int(limit)) => {
                        Some(i64::from(*limit).min(i64::from(self.generated.max_limit)))
                    }
                    _ => None,
                };
                let limit = match limit {
                    Some(limit) if limit < 1 => {
                        return Err(GraphqlError::coded(
                            format!("limit must be between 1 and {}", self.services.reads.limits().max_limit),
                            INVALID_QUERY,
                        ));
                    }
                    Some(limit) => u32::try_from(limit).ok(),
                    None => None,
                };
                let skip = match argument("skip") {
                    Some(Input::Int(skip)) if *skip < 0 => {
                        return Err(GraphqlError::coded(
                            format!("skip must be between 0 and {}", self.services.reads.limits().max_skip),
                            INVALID_QUERY,
                        ));
                    }
                    Some(Input::Int(skip)) => u64::try_from(*skip).ok(),
                    _ => None,
                };
                let after = match argument("after") {
                    Some(Input::String(after)) => Some(after.clone()),
                    _ => None,
                };
                let page = self
                    .services
                    .reads
                    .find(
                        self.services.caller,
                        FindRequest {
                            collection,
                            filter,
                            sort: to_mongo_sort(argument("sort")).map(Value::Document),
                            fields: None,
                            limit,
                            skip,
                            after,
                            count: if total { Some(CountMode::Exact) } else { None },
                        },
                    )
                    .await
                    .map_err(canopy)?;
                let nodes = page
                    .documents()
                    .map_err(canopy)?
                    .into_iter()
                    .map(|document| Val::Doc(Arc::new(document)))
                    .collect();
                Ok(Val::Entries(vec![
                    ("nodes", Val::List(nodes)),
                    ("next", page.next.clone().map_or(Val::Null, |next| Val::Leaf(Json::String(next)))),
                    ("total", page.total.map_or(Val::Null, |total| Val::Leaf(Json::Number(total as f64)))),
                    ("ct", Val::Leaf(Json::String(page.ct.to_string()))),
                ]))
            }
            Some(FieldPlan::One { collection }) => {
                let id = argument("id").map_or(Value::Null, Input::to_value);
                let found = self
                    .services
                    .reads
                    .find_by_id(self.services.caller, &collection, &id, None)
                    .await
                    .map_err(canopy)?;
                Ok(found.map_or(Val::Null, |result| Val::Doc(Arc::new(result.document))))
            }
            Some(FieldPlan::Count { collection }) => {
                let model = self.collection(&collection)?;
                let filter = to_mongo_filter(argument("filter"), &model.filter_map).map_err(invalid)?;
                let counted = self
                    .services
                    .reads
                    .count(
                        self.services.caller,
                        &collection,
                        Some(&Value::Document(filter)),
                        CountMode::Exact,
                    )
                    .await
                    .map_err(canopy)?;
                Ok(Val::Leaf(Json::Number(counted.count as f64)))
            }
            Some(FieldPlan::Mutation { collection, kind }) => {
                self.mutate(&collection, kind, &arguments).await
            }
            Some(FieldPlan::Empty) => Ok(Val::Null),
            _ => Err(GraphqlError::coded("Subscriptions need a transport; use /graphql/v1", INVALID_QUERY)),
        }
    }

    fn collection(&self, name: &str) -> Result<&CollectionPlan, GraphqlError> {
        self.generated.collections.get(name).ok_or_else(|| {
            GraphqlError::from_canopy(&CanopyError::new(
                canopy_protocol::ErrorCode::Internal,
                "Unknown collection",
            ))
        })
    }

    async fn mutate(
        &mut self,
        collection: &str,
        kind: MutationKind,
        arguments: &[(String, Input)],
    ) -> Result<Val, GraphqlError> {
        let argument = |name: &str| arguments.iter().find(|(key, _)| key == name).map(|(_, value)| value);
        let invalid = |NotADocument(message): NotADocument| GraphqlError::coded(message, INVALID_QUERY);
        let model = self.collection(collection)?.clone();
        let Some(writes) = self.services.writes else {
            return Err(GraphqlError::from_canopy(&CanopyError::new(
                canopy_protocol::ErrorCode::Forbidden,
                "Mutations are not served here",
            )));
        };
        let doc_of = |value: &Input| -> Result<Value, GraphqlError> {
            if model.insert.is_none() {
                return Ok(value.to_value());
            }
            to_mongo_document(value, &model.insert_map).map_err(invalid)
        };
        let id = || argument("id").map_or(Value::Undefined, Input::to_value);
        let where_of = || -> Result<Value, GraphqlError> {
            match argument("where") {
                None | Some(Input::Null) => Ok(Value::Undefined),
                Some(value) => {
                    Ok(Value::Document(to_mongo_filter(Some(value), &model.filter_map).map_err(invalid)?))
                }
            }
        };
        let request = match kind {
            MutationKind::Insert => WriteRequest::new(WriteOp::Insert, collection)
                .with("doc", doc_of(argument("doc").unwrap_or(&Input::Null))?),
            MutationKind::InsertMany => {
                let docs = match argument("docs") {
                    Some(Input::List(items)) => items.iter().map(doc_of).collect::<Result<Vec<_>, _>>()?,
                    _ => Vec::new(),
                };
                WriteRequest::new(WriteOp::InsertMany, collection).with("docs", Value::Array(docs))
            }
            MutationKind::Replace => WriteRequest::new(WriteOp::Replace, collection)
                .with("id", id())
                .with("doc", doc_of(argument("doc").unwrap_or(&Input::Null))?)
                .with("where", where_of()?)
                .with(
                    "upsert",
                    if matches!(argument("upsert"), Some(Input::Bool(true))) {
                        Value::Bool(true)
                    } else {
                        Value::Undefined
                    },
                ),
            MutationKind::Update => WriteRequest::new(WriteOp::Update, collection)
                .with("id", id())
                .with(
                    "update",
                    Value::Document(to_mongo_update(argument("update"), &model.set_map).map_err(invalid)?),
                )
                .with("where", where_of()?),
            MutationKind::UpdateMany => WriteRequest::new(WriteOp::UpdateMany, collection)
                .with(
                    "filter",
                    Value::Document(to_mongo_filter(argument("filter"), &model.filter_map).map_err(invalid)?),
                )
                .with(
                    "update",
                    Value::Document(to_mongo_update(argument("update"), &model.set_map).map_err(invalid)?),
                )
                .with("bulk", Value::Bool(true)),
            MutationKind::Delete => {
                WriteRequest::new(WriteOp::Delete, collection).with("id", id()).with("where", where_of()?)
            }
            MutationKind::DeleteMany => WriteRequest::new(WriteOp::DeleteMany, collection)
                .with(
                    "filter",
                    Value::Document(to_mongo_filter(argument("filter"), &model.filter_map).map_err(invalid)?),
                )
                .with("bulk", Value::Bool(true)),
        };
        self.writes += 1;
        let keyed = self.root_mutations == 1 && self.writes == 1;
        let options = WriteOptions {
            mutation_id: if keyed { self.services.idempotency_key.clone() } else { None },
            skip_documents: false,
        };
        let result = writes
            .execute(self.services.caller, &request, &options)
            .await
            .map_err(|error| GraphqlError::from_canopy(&error))?;
        let documents = result.outcome.documents.clone().unwrap_or_default();
        Ok(match kind {
            MutationKind::InsertMany => Val::List(
                documents
                    .into_iter()
                    .map(|document| document.map_or(Val::Null, |document| Val::Doc(Arc::new(document))))
                    .collect(),
            ),
            MutationKind::UpdateMany | MutationKind::DeleteMany => Val::Entries(vec![
                ("matched", Val::Leaf(Json::Number(result.outcome.matched as f64))),
                ("modified", Val::Leaf(Json::Number(result.outcome.modified as f64))),
                ("deleted", Val::Leaf(Json::Number(result.outcome.deleted as f64))),
                ("ct", Val::Leaf(Json::String(result.ct.to_string()))),
            ]),
            _ => documents
                .into_iter()
                .next()
                .flatten()
                .map_or(Val::Null, |document| Val::Doc(Arc::new(document))),
        })
    }
}

fn builtin_literal(value: &AstValue, name: &str) -> Result<Input, String> {
    match (name, value) {
        ("Int", AstValue::Int(number)) => number
            .try_to_i32()
            .map(Input::Int)
            .map_err(|_| format!("Int cannot represent non 32-bit signed integer value: {number}")),
        ("Float", AstValue::Int(number)) => Ok(Input::Float(number.try_to_f64().unwrap_or(f64::NAN))),
        ("Float", AstValue::Float(number)) => Ok(Input::Float(number.try_to_f64().unwrap_or(f64::NAN))),
        ("String" | "ID", AstValue::String(text)) => Ok(Input::String(text.clone())),
        ("ID", AstValue::Int(number)) => Ok(Input::String(number.as_str().to_owned())),
        ("Boolean", AstValue::Boolean(flag)) => Ok(Input::Bool(*flag)),
        _ => Err(format!("{name} cannot represent {value}")),
    }
}

/// A literal as the JSON value the Canopy scalars read: numbers as numbers, enums as strings, variables
/// replaced by their values.
fn literal_json(value: &AstValue, variables: &HashMap<String, Input>) -> Json {
    match value {
        AstValue::Null => Json::Null,
        AstValue::Enum(name) => Json::String(name.to_string()),
        AstValue::Variable(name) => variables.get(name.as_str()).map_or(Json::Null, input_json),
        AstValue::String(text) => Json::String(text.clone()),
        AstValue::Float(number) => Json::Number(number.try_to_f64().unwrap_or(f64::NAN)),
        AstValue::Int(number) => Json::Number(number.try_to_f64().unwrap_or(f64::NAN)),
        AstValue::Boolean(flag) => Json::Bool(*flag),
        AstValue::List(items) => {
            Json::Array(items.iter().map(|item| literal_json(item, variables)).collect())
        }
        AstValue::Object(fields) => Json::Object(
            fields.iter().map(|(key, item)| (key.to_string(), literal_json(item, variables))).collect(),
        ),
    }
}

fn input_json(value: &Input) -> Json {
    match value {
        Input::Null => Json::Null,
        Input::Bool(flag) => Json::Bool(*flag),
        Input::Int(number) => Json::Number(f64::from(*number)),
        Input::Float(number) => Json::Number(*number),
        Input::String(text) | Input::Enum(text) => Json::String(text.clone()),
        Input::List(items) => Json::Array(items.iter().map(input_json).collect()),
        Input::Object(fields) => {
            Json::Object(fields.iter().map(|(key, item)| (key.clone(), input_json(item))).collect())
        }
        Input::Bson(bson) => canopy_protocol::ejson::encode(bson).unwrap_or(Json::Null),
    }
}

fn to_bytes_json(value: &Json) -> serde_json_bytes::Value {
    match value {
        Json::Null => serde_json_bytes::Value::Null,
        Json::Bool(flag) => serde_json_bytes::Value::Bool(*flag),
        Json::Number(number) => {
            if number.fract() == 0.0 && number.abs() < 9_007_199_254_740_992.0 {
                #[allow(clippy::cast_possible_truncation)]
                serde_json_bytes::Value::Number((*number as i64).into())
            } else {
                serde_json_bytes::serde_json::Number::from_f64(*number)
                    .map_or(serde_json_bytes::Value::Null, serde_json_bytes::Value::Number)
            }
        }
        Json::String(text) => serde_json_bytes::Value::String(text.as_str().into()),
        Json::Array(items) => serde_json_bytes::Value::Array(items.iter().map(to_bytes_json).collect()),
        Json::Object(entries) => serde_json_bytes::Value::Object(
            entries.iter().map(|(key, item)| (key.as_str().into(), to_bytes_json(item))).collect(),
        ),
    }
}

fn from_bytes_json(value: &serde_json_bytes::Value) -> Json {
    match value {
        serde_json_bytes::Value::Null => Json::Null,
        serde_json_bytes::Value::Bool(flag) => Json::Bool(*flag),
        serde_json_bytes::Value::Number(number) => Json::Number(number.as_f64().unwrap_or(0.0)),
        serde_json_bytes::Value::String(text) => Json::String(text.as_str().to_owned()),
        serde_json_bytes::Value::Array(items) => Json::Array(items.iter().map(from_bytes_json).collect()),
        serde_json_bytes::Value::Object(entries) => Json::Object(
            entries.iter().map(|(key, item)| (key.as_str().to_owned(), from_bytes_json(item))).collect(),
        ),
    }
}

fn introspect(
    schema: &Valid<Schema>,
    document: &Valid<ExecutableDocument>,
    operation: &Node<Operation>,
    variables: &[(String, Json)],
) -> Result<Vec<(String, Json)>, GraphqlError> {
    let raw: apollo_compiler::response::JsonMap =
        variables.iter().map(|(key, value)| (key.as_str().into(), to_bytes_json(value))).collect();
    let coerced = apollo_compiler::request::coerce_variable_values(schema, operation, &raw)
        .map_err(|error| GraphqlError::coded(error.message().to_string(), INVALID_QUERY))?;
    let response = crate::introspection::partial_execute(schema, document, operation, &coerced)
        .map_err(|error| GraphqlError::coded(error.message().to_string(), INVALID_QUERY))?;
    Ok(response
        .data
        .map(|data| {
            data.iter().map(|(key, value)| (key.as_str().to_owned(), from_bytes_json(value))).collect()
        })
        .unwrap_or_default())
}

/// Runs one operation of a validated document with the given variables (the members of the request's
/// `variables` object) for the caller of `services`. Subscriptions are refused: they need a transport.
pub async fn execute(
    generated: &GeneratedSchema,
    schema: &Valid<Schema>,
    document: &Valid<ExecutableDocument>,
    operation: &Node<Operation>,
    variables: &[(String, Json)],
    services: &Services<'_>,
) -> ExecutionResult {
    let root = match operation.operation_type {
        OperationType::Query => "Query",
        OperationType::Mutation => "Mutation",
        OperationType::Subscription => "Subscription",
    };
    let mut exec = Exec {
        generated,
        schema,
        document,
        variables: HashMap::new(),
        services,
        slots: Vec::new(),
        errors: Vec::new(),
        pending: Vec::new(),
        root,
        root_mutations: if root == "Mutation" { operation.selection_set.selections.len() } else { 0 },
        writes: 0,
    };
    let errors = exec.coerce_variables(operation, variables);
    if !errors.is_empty() {
        return ExecutionResult::failed(errors);
    }
    let mut collected = Vec::new();
    let mut visited = Vec::new();
    exec.collect(root, &operation.selection_set, &mut collected, &mut visited);
    let introspection = if collected.iter().any(|(_, group)| {
        group.first().is_some_and(|field| matches!(field.name.as_str(), "__schema" | "__type"))
    }) {
        match introspect(schema, document, operation, variables) {
            Ok(data) => data,
            Err(error) => return ExecutionResult::failed(vec![error]),
        }
    } else {
        Vec::new()
    };
    let mut entries = Vec::with_capacity(collected.len());
    for (key, group) in collected {
        let Some(first) = group.first().copied() else { continue };
        let child = exec.alloc(Slot::Null);
        let path = vec![PathSegment::Key(key.clone())];
        entries.push((key.clone(), child, first.definition.ty.is_non_null()));
        match first.name.as_str() {
            "__typename" => exec.slots[child] = Slot::Leaf(Json::String(root.to_owned())),
            "__schema" | "__type" => {
                let value = introspection
                    .iter()
                    .find(|(name, _)| *name == key)
                    .map_or(Json::Null, |(_, value)| value.clone());
                exec.slots[child] = Slot::Leaf(value);
            }
            _ => match exec.resolve_root(first).await {
                Ok(value) => exec.complete(child, &first.definition.ty, value, &group, &path, root),
                Err(error) => {
                    exec.field_error(error, &group, &path);
                    exec.slots[child] = Slot::Failed;
                }
            },
        }
        if root == "Mutation" {
            exec.load_relations().await;
        }
    }
    exec.load_relations().await;
    let top = exec.alloc(Slot::Object(entries));
    let data = exec.finish(top).unwrap_or(Json::Null);
    ExecutionResult { data: Some(data), errors: exec.errors }
}
