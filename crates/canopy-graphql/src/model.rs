//! The generated schema as Canopy describes it: every type in the order GraphQL clients list them, with the
//! plan of each field (where its value comes from), written as SDL for the compiler.

use canopy_policy::Operation;
use std::collections::HashMap;
use std::fmt::Write as _;

/// A reference to a type: a named type, a list or a non null wrapper.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TypeRef {
    /// A named type.
    Named(String),
    /// A list of the inner type.
    List(Box<TypeRef>),
    /// The inner type, never null.
    NonNull(Box<TypeRef>),
}

impl TypeRef {
    /// A named type.
    pub fn named(name: &str) -> TypeRef {
        TypeRef::Named(name.to_owned())
    }

    /// This type, never null.
    pub fn non_null(self) -> TypeRef {
        TypeRef::NonNull(Box::new(self))
    }

    /// A list of this type.
    pub fn list(self) -> TypeRef {
        TypeRef::List(Box::new(self))
    }

    /// The named type under every wrapper.
    pub fn name(&self) -> &str {
        match self {
            TypeRef::Named(name) => name,
            TypeRef::List(inner) | TypeRef::NonNull(inner) => inner.name(),
        }
    }

    fn write(&self, out: &mut String) {
        match self {
            TypeRef::Named(name) => out.push_str(name),
            TypeRef::List(inner) => {
                out.push('[');
                inner.write(out);
                out.push(']');
            }
            TypeRef::NonNull(inner) => {
                inner.write(out);
                out.push('!');
            }
        }
    }
}

/// An argument of a field, or a field of an input object.
#[derive(Clone, Debug, PartialEq)]
pub struct InputValue {
    /// The name.
    pub name: String,
    /// The description.
    pub description: Option<String>,
    /// The type.
    pub ty: TypeRef,
    /// The default value as a GraphQL literal.
    pub default: Option<String>,
}

impl InputValue {
    /// An input value without a description or a default.
    pub fn new(name: &str, ty: TypeRef) -> InputValue {
        InputValue { name: name.to_owned(), description: None, ty, default: None }
    }

    /// The same input value with a description.
    pub fn described(mut self, description: &str) -> InputValue {
        self.description = Some(description.to_owned());
        self
    }

    /// The same input value with a default literal.
    pub fn defaulting(mut self, literal: &str) -> InputValue {
        self.default = Some(literal.to_owned());
        self
    }
}

/// A relation field: documents of another collection whose `foreign` field matches this document's
/// `local` field.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Relation {
    /// A stable key of the relation, `collection.field`, under which its keys are batched.
    pub key: String,
    /// The target collection.
    pub to: String,
    /// The field of this collection that holds the key.
    pub local: String,
    /// The field of the target collection the key is matched against.
    pub foreign: String,
    /// Whether many documents may match, so the field is a list.
    pub many: bool,
}

/// The write a mutation field runs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MutationKind {
    /// `insert<Singular>`.
    Insert,
    /// `insert<Plural>`.
    InsertMany,
    /// `replace<Singular>`.
    Replace,
    /// `update<Singular>`.
    Update,
    /// `update<Plural>`.
    UpdateMany,
    /// `delete<Singular>`.
    Delete,
    /// `delete<Plural>`.
    DeleteMany,
}

impl MutationKind {
    /// The policy operation the write needs.
    pub fn operation(self) -> Operation {
        match self {
            MutationKind::Insert | MutationKind::InsertMany => Operation::Insert,
            MutationKind::Replace | MutationKind::Update | MutationKind::UpdateMany => Operation::Update,
            MutationKind::Delete | MutationKind::DeleteMany => Operation::Delete,
        }
    }
}

/// Where the value of a field comes from.
#[derive(Clone, Debug, PartialEq)]
pub enum FieldPlan {
    /// A field of the document (or subdocument) being written: its value under `source`.
    Value {
        /// The document field.
        source: String,
    },
    /// Documents of another collection.
    Relation(Relation),
    /// `todos`: one page of a collection.
    List {
        /// The collection.
        collection: String,
    },
    /// `todo`: one document by `_id`.
    One {
        /// The collection.
        collection: String,
    },
    /// `todosCount`: the number of matching documents.
    Count {
        /// The collection.
        collection: String,
    },
    /// A mutation.
    Mutation {
        /// The collection.
        collection: String,
        /// The write.
        kind: MutationKind,
    },
    /// `liveTodos`: the full result of a query on every change.
    Live {
        /// The collection.
        collection: String,
    },
    /// `todoChanges`: the changes of a query.
    Changes {
        /// The collection.
        collection: String,
    },
    /// A field of a page (`nodes`, `next`, `total`, `ct`), a bulk result or a change: the entry of that name
    /// in the object the parent resolved.
    Entry,
    /// `_empty`, always null.
    Empty,
}

/// A field of an object type.
#[derive(Clone, Debug, PartialEq)]
pub struct FieldDef {
    /// The GraphQL name.
    pub name: String,
    /// The description.
    pub description: Option<String>,
    /// The type.
    pub ty: TypeRef,
    /// The arguments.
    pub args: Vec<InputValue>,
    /// Where the value comes from.
    pub plan: FieldPlan,
}

impl FieldDef {
    /// A field without arguments or a description.
    pub fn new(name: &str, ty: TypeRef, plan: FieldPlan) -> FieldDef {
        FieldDef { name: name.to_owned(), description: None, ty, args: Vec::new(), plan }
    }

    /// The same field with a description.
    pub fn described(mut self, description: &str) -> FieldDef {
        self.description = Some(description.to_owned());
        self
    }

    /// The same field with arguments.
    pub fn with_args(mut self, args: Vec<InputValue>) -> FieldDef {
        self.args = args;
        self
    }
}

/// A named type of the generated schema.
#[derive(Clone, Debug, PartialEq)]
pub enum TypeDef {
    /// A custom scalar.
    Scalar {
        /// The name.
        name: String,
        /// The description.
        description: String,
    },
    /// An object type.
    Object {
        /// The name.
        name: String,
        /// The description.
        description: Option<String>,
        /// The fields, in order.
        fields: Vec<FieldDef>,
    },
    /// An input object type.
    Input {
        /// The name.
        name: String,
        /// The fields, in order.
        fields: Vec<InputValue>,
    },
    /// An enum. Each value has the GraphQL name and the value it stands for, such as a document field.
    Enum {
        /// The name.
        name: String,
        /// The values: their GraphQL name and what they stand for.
        values: Vec<(String, String)>,
    },
}

impl TypeDef {
    /// The name of the type.
    pub fn name(&self) -> &str {
        match self {
            TypeDef::Scalar { name, .. }
            | TypeDef::Object { name, .. }
            | TypeDef::Input { name, .. }
            | TypeDef::Enum { name, .. } => name,
        }
    }
}

fn write_description(out: &mut String, description: Option<&str>, indent: &str) {
    if let Some(text) = description {
        out.push_str(indent);
        write_string(out, text);
        out.push('\n');
    }
}

fn write_string(out: &mut String, text: &str) {
    out.push('"');
    for character in text.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            other if u32::from(other) < 0x20 => {
                let _ = write!(out, "\\u{:04X}", u32::from(other));
            }
            other => out.push(other),
        }
    }
    out.push('"');
}

fn write_input_value(out: &mut String, value: &InputValue) {
    if let Some(description) = &value.description {
        write_string(out, description);
        out.push(' ');
    }
    out.push_str(&value.name);
    out.push_str(": ");
    value.ty.write(out);
    if let Some(default) = &value.default {
        out.push_str(" = ");
        out.push_str(default);
    }
}

/// The types of one caller's schema, by name, in the order clients list them, with the root types.
#[derive(Clone, Debug, Default)]
pub struct SchemaModel {
    types: Vec<TypeDef>,
    index: HashMap<String, usize>,
    /// Whether the schema has a `Mutation` type.
    pub mutation: bool,
    /// Whether the schema has a `Subscription` type.
    pub subscription: bool,
}

impl SchemaModel {
    /// Adds a type, replacing one of the same name.
    pub fn add(&mut self, def: TypeDef) {
        match self.index.get(def.name()) {
            Some(&position) => self.types[position] = def,
            None => {
                self.index.insert(def.name().to_owned(), self.types.len());
                self.types.push(def);
            }
        }
    }

    /// The type of that name.
    pub fn get(&self, name: &str) -> Option<&TypeDef> {
        self.index.get(name).map(|&position| &self.types[position])
    }

    /// The field of an object type.
    pub fn field(&self, type_name: &str, field: &str) -> Option<&FieldDef> {
        match self.get(type_name)? {
            TypeDef::Object { fields, .. } => fields.iter().find(|candidate| candidate.name == field),
            _ => None,
        }
    }

    /// The type names in the order GraphQL lists them in introspection: the custom scalars, then every type
    /// reachable from `Query`, `Mutation` and `Subscription`, depth first, field by field.
    pub fn ordered(&self, scalars: &[&str]) -> Vec<&TypeDef> {
        let mut seen: Vec<&str> = Vec::new();
        for scalar in scalars {
            self.collect(scalar, &mut seen);
        }
        for root in ["Query", "Mutation", "Subscription"] {
            self.collect(root, &mut seen);
        }
        seen.iter().filter_map(|name| self.get(name)).collect()
    }

    fn collect<'a>(&'a self, name: &'a str, seen: &mut Vec<&'a str>) {
        if seen.contains(&name) {
            return;
        }
        let Some(def) = self.get(name) else { return };
        seen.push(def.name());
        match def {
            TypeDef::Object { fields, .. } => {
                for field in fields {
                    self.collect(field.ty.name(), seen);
                    for arg in &field.args {
                        self.collect(arg.ty.name(), seen);
                    }
                }
            }
            TypeDef::Input { fields, .. } => {
                for field in fields {
                    self.collect(field.ty.name(), seen);
                }
            }
            TypeDef::Scalar { .. } | TypeDef::Enum { .. } => {}
        }
    }

    /// The schema as SDL, types in the given order.
    pub fn sdl(&self, scalars: &[&str]) -> String {
        let mut out = String::with_capacity(4096);
        out.push_str("schema {\n  query: Query\n");
        if self.mutation {
            out.push_str("  mutation: Mutation\n");
        }
        if self.subscription {
            out.push_str("  subscription: Subscription\n");
        }
        out.push_str("}\n");
        for def in self.ordered(scalars) {
            out.push('\n');
            match def {
                TypeDef::Scalar { name, description } => {
                    write_description(&mut out, Some(description), "");
                    let _ = writeln!(out, "scalar {name}");
                }
                TypeDef::Object { name, description, fields } => {
                    write_description(&mut out, description.as_deref(), "");
                    let _ = writeln!(out, "type {name} {{");
                    for field in fields {
                        write_description(&mut out, field.description.as_deref(), "  ");
                        out.push_str("  ");
                        out.push_str(&field.name);
                        if !field.args.is_empty() {
                            out.push('(');
                            for (position, arg) in field.args.iter().enumerate() {
                                if position > 0 {
                                    out.push_str(", ");
                                }
                                write_input_value(&mut out, arg);
                            }
                            out.push(')');
                        }
                        out.push_str(": ");
                        field.ty.write(&mut out);
                        out.push('\n');
                    }
                    out.push_str("}\n");
                }
                TypeDef::Input { name, fields } => {
                    let _ = writeln!(out, "input {name} {{");
                    for field in fields {
                        out.push_str("  ");
                        write_input_value(&mut out, field);
                        out.push('\n');
                    }
                    out.push_str("}\n");
                }
                TypeDef::Enum { name, values } => {
                    let _ = writeln!(out, "enum {name} {{");
                    for (value, _) in values {
                        let _ = writeln!(out, "  {value}");
                    }
                    out.push_str("}\n");
                }
            }
        }
        out
    }
}
