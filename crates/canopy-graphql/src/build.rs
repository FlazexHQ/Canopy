//! Builds the schema one role set sees: a type per collection the caller can read with only the fields its
//! roles may read, queries and mutations for the operations its policies grant, relations to readable
//! collections, and live queries when realtime is on. Names, field order and type order follow the
//! TypeScript `buildSchema`, so introspection gives the same answers.

use crate::model::{FieldDef, FieldPlan, InputValue, MutationKind, Relation, SchemaModel, TypeDef, TypeRef};
use crate::names::{CollectionNames, collection_names, field_name, pascal_case};
use canopy_data::schema::{
    CollectionSchema, Field, ObjectShape, RestrictMode, ScalarType, SchemaSource, Shape, restrict_shape,
};
use canopy_policy::{Operation, PolicyEngine, RequestContext};
use std::collections::{HashMap, HashSet};

/// A relation between two collections, declared in config.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RelationConfig {
    /// The target collection.
    pub to: String,
    /// The field of this collection that holds the key.
    pub local: String,
    /// The field of the target collection the key is matched against; `_id` when absent.
    pub foreign: Option<String>,
    /// Whether many target documents may match, so the field is a list.
    pub many: bool,
}

/// GraphQL settings of one collection.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CollectionConfig {
    /// Overrides the singular type name, such as `Person` for `people`.
    pub type_name: Option<String>,
    /// Relations by GraphQL field name, in order.
    pub relations: Vec<(String, RelationConfig)>,
}

/// What [`build_schema`] builds from.
pub struct SchemaInput<'a> {
    /// The policies in force.
    pub engine: &'a PolicyEngine,
    /// The caller's request context.
    pub ctx: &'a RequestContext,
    /// The collections the caller can reach, in a stable order.
    pub collections: &'a [String],
    /// Their schemas.
    pub schemas: &'a HashMap<String, CollectionSchema>,
    /// Type names and relations per collection.
    pub config: &'a HashMap<String, CollectionConfig>,
    /// Whether live queries are available (realtime is on).
    pub subscriptions: bool,
    /// The default `limit` of list queries.
    pub default_limit: u32,
    /// The largest `limit` of list queries.
    pub max_limit: u32,
}

/// The custom scalars, in the order the schema lists them, with their descriptions.
pub const SCALARS: [(&str, &str); 6] = [
    ("ObjectId", "A BSON ObjectId as 24 hexadecimal characters."),
    ("DateTime", "A BSON date as an ISO 8601 string in UTC; inputs also accept epoch milliseconds."),
    ("Long", "A 64 bit integer, serialized as a decimal string so no precision is lost."),
    ("Decimal", "A BSON Decimal128, serialized as a string."),
    ("Binary", "BSON binary data as standard base64. Inputs are stored with subtype 0."),
    (
        "JSON",
        "Any BSON value as relaxed Extended JSON. Inputs are read as Extended JSON, so {\"$oid\": \"…\"} is an ObjectId.",
    ),
];

/// The names of the custom scalars.
pub const SCALAR_NAMES: [&str; 6] = ["ObjectId", "DateTime", "Long", "Decimal", "Binary", "JSON"];

const RESERVED_FILTER: [&str; 4] = ["and", "or", "nor", "raw"];
const INHERITED_INPUT_FIELDS: [&str; 7] = [
    "constructor",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
    "toString",
    "valueOf",
];

/// How the GraphQL names of a collection's fields map to the document fields they stand for, per input or
/// output type.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FieldMap {
    /// GraphQL field name to document field name, in order.
    pub fields: Vec<(String, String)>,
}

impl FieldMap {
    /// The document field of a GraphQL name.
    pub fn get(&self, gql: &str) -> Option<&str> {
        self.fields.iter().find(|(name, _)| name == gql).map(|(_, field)| field.as_str())
    }
}

/// What the executor needs to know about a collection of the schema.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CollectionPlan {
    /// The collection.
    pub name: String,
    /// The object type of its documents.
    pub type_name: String,
    /// The filter input type.
    pub filter: String,
    /// Filter field names to document fields.
    pub filter_map: FieldMap,
    /// The insert (and replace) input type, when it has fields.
    pub insert: Option<String>,
    /// Insert input field names to document fields.
    pub insert_map: FieldMap,
    /// Set input field names to document fields (also the `inc` input and the `unset` enum).
    pub set_map: FieldMap,
}

/// One caller's generated schema: its types and the plan of every collection.
#[derive(Clone, Debug, Default)]
pub struct GeneratedSchema {
    /// The types, in the order clients list them.
    pub model: SchemaModel,
    /// The collections by name.
    pub collections: HashMap<String, CollectionPlan>,
    /// The default `limit` of list queries.
    pub default_limit: u32,
    /// The largest `limit` of list queries.
    pub max_limit: u32,
}

impl GeneratedSchema {
    /// The schema as SDL.
    pub fn sdl(&self) -> String {
        self.model.sdl(&SCALAR_NAMES)
    }
}

fn graphql_scalar(scalar: ScalarType) -> Option<&'static str> {
    Some(match scalar {
        ScalarType::String => "String",
        ScalarType::Int => "Int",
        ScalarType::Double => "Float",
        ScalarType::Bool => "Boolean",
        ScalarType::Long => "Long",
        ScalarType::Decimal => "Decimal",
        ScalarType::Date => "DateTime",
        ScalarType::ObjectId => "ObjectId",
        ScalarType::BinData => "Binary",
        _ => return None,
    })
}

/// The GraphQL scalar of a shape: a scalar type, or a union of one type and null, or of numbers only.
pub fn scalar_of(shape: &Shape) -> Option<&'static str> {
    match shape {
        Shape::Scalar { scalar, .. } => graphql_scalar(*scalar),
        Shape::Union(of) => {
            let present: Vec<&Shape> = of
                .iter()
                .filter(|member| !matches!(member, Shape::Scalar { scalar: ScalarType::Null, .. }))
                .collect();
            if let [only] = present.as_slice() {
                return scalar_of(only);
            }
            let numeric = !present.is_empty()
                && present.iter().all(|member| {
                    matches!(member, Shape::Scalar { scalar: ScalarType::Int | ScalarType::Double, .. })
                });
            if numeric { Some("Float") } else { None }
        }
        _ => None,
    }
}

struct Builder<'a> {
    input: &'a SchemaInput<'a>,
    used: HashSet<String>,
    model: SchemaModel,
    scalar_filters: HashMap<&'static str, String>,
}

struct Model {
    name: String,
    names: CollectionNames,
    id_type: TypeRef,
    filter: String,
    filter_map: FieldMap,
    sort: Option<String>,
}

fn any_field() -> Field {
    Field { shape: Shape::Any, required: true }
}

impl<'a> Builder<'a> {
    fn unique(&mut self, name: &str) -> String {
        let mut candidate = name.to_owned();
        let mut n = 2;
        while self.used.contains(&candidate) {
            candidate = format!("{name}{n}");
            n += 1;
        }
        self.used.insert(candidate.clone());
        candidate
    }

    fn scalar_filter(&mut self, scalar: &'static str) -> String {
        if let Some(existing) = self.scalar_filters.get(scalar) {
            return existing.clone();
        }
        let name = self.unique(&format!("{scalar}Filter"));
        let of = || TypeRef::named(scalar);
        let mut fields = vec![
            InputValue::new("eq", of()),
            InputValue::new("ne", of()),
            InputValue::new("in", of().non_null().list()),
            InputValue::new("nin", of().non_null().list()),
            InputValue::new("exists", TypeRef::named("Boolean")),
        ];
        if scalar != "Boolean" {
            for operator in ["gt", "gte", "lt", "lte"] {
                fields.push(InputValue::new(operator, of()));
            }
        }
        if scalar == "String" {
            fields.push(InputValue::new("regex", TypeRef::named("String")));
            fields.push(
                InputValue::new("options", TypeRef::named("String"))
                    .described("Regular expression options such as i"),
            );
        }
        self.model.add(TypeDef::Input { name: name.clone(), fields });
        self.scalar_filters.insert(scalar, name.clone());
        name
    }

    fn output_type(&mut self, shape: &Shape, owner: &str, field: &str) -> TypeRef {
        if let Some(scalar) = scalar_of(shape) {
            return TypeRef::named(scalar);
        }
        match shape {
            Shape::Array(items) => self.output_type(items, owner, field).list(),
            Shape::Object(object) if !object.fields.is_empty() => {
                let name = self.unique(&format!("{owner}{}", pascal_case(field)));
                let fields = self.object_fields(object, &name);
                self.model.add(TypeDef::Object { name: name.clone(), description: None, fields });
                TypeRef::Named(name)
            }
            _ => TypeRef::named("JSON"),
        }
    }

    fn object_fields(&mut self, shape: &ObjectShape, owner: &str) -> Vec<FieldDef> {
        let mut taken: HashSet<String> = HashSet::new();
        let mut out = Vec::with_capacity(shape.fields.len());
        for (name, field) in &shape.fields {
            let mut gql = field_name(name);
            while taken.contains(&gql) {
                gql.push('_');
            }
            taken.insert(gql.clone());
            let ty = self.output_type(&field.shape, owner, &gql);
            let ty = if name == "_id" { ty.non_null() } else { ty };
            out.push(FieldDef::new(&gql, ty, FieldPlan::Value { source: name.clone() }));
        }
        out
    }

    fn input_type(shape: &Shape) -> TypeRef {
        if let Some(scalar) = scalar_of(shape) {
            return TypeRef::named(scalar);
        }
        if let Shape::Array(items) = shape
            && let Some(item) = scalar_of(items)
        {
            return TypeRef::named(item).list();
        }
        TypeRef::named("JSON")
    }

    fn list_args(&self, model: &Model) -> Vec<InputValue> {
        let mut args = vec![InputValue::new("filter", TypeRef::Named(model.filter.clone()))];
        if let Some(sort) = &model.sort {
            args.push(InputValue::new("sort", TypeRef::Named(sort.clone()).non_null().list()));
        }
        args.push(
            InputValue::new("limit", TypeRef::named("Int")).defaulting(&self.input.default_limit.to_string()),
        );
        args
    }
}

/// Builds the schema one caller sees.
pub fn build_schema(input: &SchemaInput<'_>) -> GeneratedSchema {
    let mut builder = Builder {
        input,
        used: ["Query", "Mutation", "Subscription", "SortDirection", "BulkResult", "ChangeKind"]
            .into_iter()
            .chain(SCALAR_NAMES)
            .map(str::to_owned)
            .collect(),
        model: SchemaModel::default(),
        scalar_filters: HashMap::new(),
    };
    for (name, description) in SCALARS {
        builder.model.add(TypeDef::Scalar { name: name.to_owned(), description: description.to_owned() });
    }
    builder.model.add(TypeDef::Enum {
        name: "SortDirection".into(),
        values: vec![("ASC".into(), "ASC".into()), ("DESC".into(), "DESC".into())],
    });
    builder.model.add(TypeDef::Object {
        name: "BulkResult".into(),
        description: Some("The outcome of a bulk write.".into()),
        fields: vec![
            FieldDef::new("matched", TypeRef::named("Int").non_null(), FieldPlan::Entry),
            FieldDef::new("modified", TypeRef::named("Int").non_null(), FieldPlan::Entry),
            FieldDef::new("deleted", TypeRef::named("Int").non_null(), FieldPlan::Entry),
            FieldDef::new("ct", TypeRef::named("String").non_null(), FieldPlan::Entry)
                .described("Cluster time of the commit"),
        ],
    });
    builder.model.add(TypeDef::Enum {
        name: "ChangeKind".into(),
        values: ["ADDED", "CHANGED", "REMOVED", "READY"]
            .iter()
            .map(|kind| ((*kind).into(), (*kind).into()))
            .collect(),
    });

    let engine = input.engine;
    let ctx = input.ctx;
    let open = ObjectShape::open();
    let mut models: Vec<Model> = Vec::new();
    let mut document_fields: HashMap<String, Vec<FieldDef>> = HashMap::new();
    for name in input.collections.iter().filter(|name| engine.has_grant(name, Operation::Read, ctx)) {
        let config = input.config.get(name);
        let base = collection_names(name, config.and_then(|config| config.type_name.as_deref()));
        let type_name = builder.unique(&base.type_name);
        let names = CollectionNames { type_name: type_name.clone(), ..base };
        let source = input.schemas.get(name).map_or(&open, |schema| &schema.shape);
        let shape = restrict_shape(source, &engine.readable(name, ctx), RestrictMode::Remove);
        let with_id = if shape.field("_id").is_none() {
            let mut fields = vec![("_id".to_owned(), any_field())];
            fields.extend(shape.fields.iter().cloned());
            ObjectShape { fields, open: shape.open }
        } else {
            shape
        };
        let mut filter_map = FieldMap::default();
        let mut taken: HashSet<String> = RESERVED_FILTER.iter().map(|name| (*name).to_owned()).collect();
        for (field, _) in &with_id.fields {
            let mut gql = field_name(field);
            while taken.contains(&gql) {
                gql.push('_');
            }
            taken.insert(gql.clone());
            filter_map.fields.push((gql, field.clone()));
        }
        let fields = builder.object_fields(&with_id, &type_name);
        document_fields.insert(name.clone(), fields);
        let id_shape = with_id.field("_id").map_or(Shape::Any, |field| field.shape.clone());
        let id_type = Builder::input_type(&id_shape);
        let mut filter_fields = Vec::new();
        let mut sort_values = Vec::new();
        for (gql, field) in &filter_map.fields {
            let field_shape = with_id.field(field).map_or(Shape::Any, |field| field.shape.clone());
            let (element, array) = match &field_shape {
                Shape::Array(items) => (items.as_ref().clone(), true),
                other => (other.clone(), false),
            };
            let scalar = scalar_of(&element);
            let filter_type = builder.scalar_filter(scalar.unwrap_or("JSON"));
            filter_fields.push(InputValue::new(gql, TypeRef::Named(filter_type)));
            if scalar.is_some() && !array {
                sort_values.push((gql.clone(), field.clone()));
            }
        }
        let sort = if sort_values.is_empty() {
            None
        } else {
            let sort_name = builder.unique(&format!("{type_name}Sort"));
            let field_enum = builder.unique(&format!("{type_name}SortField"));
            builder.model.add(TypeDef::Enum { name: field_enum.clone(), values: sort_values });
            builder.model.add(TypeDef::Input {
                name: sort_name.clone(),
                fields: vec![
                    InputValue::new("field", TypeRef::Named(field_enum).non_null()),
                    InputValue::new("direction", TypeRef::named("SortDirection")).defaulting("ASC"),
                ],
            });
            Some(sort_name)
        };
        let filter = builder.unique(&format!("{type_name}Filter"));
        let recursive = || TypeRef::Named(filter.clone()).non_null().list();
        let mut fields = vec![
            InputValue::new("and", recursive()),
            InputValue::new("or", recursive()),
            InputValue::new("nor", recursive()),
        ];
        fields.extend(filter_fields);
        fields.push(
            InputValue::new("raw", TypeRef::named("JSON"))
                .described("An Extended JSON filter, validated like REST filters"),
        );
        builder.model.add(TypeDef::Input { name: filter.clone(), fields });
        models.push(Model { name: name.clone(), names, id_type, filter, filter_map, sort });
    }

    let mut query: Vec<FieldDef> = Vec::new();
    let mut mutation: Vec<FieldDef> = Vec::new();
    let mut subscription: Vec<FieldDef> = Vec::new();
    let mut plans: HashMap<String, CollectionPlan> = HashMap::new();
    let model_types: HashMap<String, String> =
        models.iter().map(|model| (model.name.clone(), model.names.type_name.clone())).collect();

    for model in &models {
        let name = &model.name;
        let names = &model.names;
        let type_ref = || TypeRef::Named(names.type_name.clone());
        let mut relation_fields = Vec::new();
        if let Some(config) = input.config.get(name) {
            for (field, relation) in &config.relations {
                let Some(target) = model_types.get(&relation.to) else { continue };
                let gql = field_name(field);
                let foreign = relation.foreign.clone().unwrap_or_else(|| "_id".to_owned());
                let plan = FieldPlan::Relation(Relation {
                    key: format!("{name}.{field}"),
                    to: relation.to.clone(),
                    local: relation.local.clone(),
                    foreign: foreign.clone(),
                    many: relation.many,
                });
                let def = if relation.many {
                    FieldDef::new(&gql, TypeRef::Named(target.clone()).non_null().list().non_null(), plan)
                        .described(&format!(
                            "Documents of {} whose {foreign} matches {}.",
                            relation.to, relation.local
                        ))
                        .with_args(vec![
                            InputValue::new("limit", TypeRef::named("Int"))
                                .defaulting(&input.default_limit.to_string()),
                        ])
                } else {
                    FieldDef::new(&gql, TypeRef::Named(target.clone()), plan).described(&format!(
                        "The document of {} whose {foreign} matches {}.",
                        relation.to, relation.local
                    ))
                };
                relation_fields.push(def);
            }
        }
        let mut fields = document_fields.remove(name).unwrap_or_default();
        for relation in relation_fields {
            match fields.iter_mut().find(|existing| existing.name == relation.name) {
                Some(existing) => *existing = relation,
                None => fields.push(relation),
            }
        }
        builder.model.add(TypeDef::Object {
            name: names.type_name.clone(),
            description: Some(format!("A document of the {name} collection.")),
            fields,
        });

        let connection = builder.unique(&format!("{}Connection", names.type_name));
        builder.model.add(TypeDef::Object {
            name: connection.clone(),
            description: Some(format!("One page of {name}.")),
            fields: vec![
                FieldDef::new("nodes", type_ref().non_null().list().non_null(), FieldPlan::Entry),
                FieldDef::new("next", TypeRef::named("String"), FieldPlan::Entry)
                    .described("The cursor of the next page, or null on the last"),
                FieldDef::new("total", TypeRef::named("Int"), FieldPlan::Entry)
                    .described("Every matching document, counted when selected"),
                FieldDef::new("ct", TypeRef::named("String").non_null(), FieldPlan::Entry)
                    .described("The snapshot's cluster time"),
            ],
        });
        let mut list_args = builder.list_args(model);
        list_args.push(InputValue::new("after", TypeRef::named("String")));
        list_args.push(InputValue::new("skip", TypeRef::named("Int")));
        query.push(
            FieldDef::new(
                &names.list,
                TypeRef::Named(connection).non_null(),
                FieldPlan::List { collection: name.clone() },
            )
            .with_args(list_args),
        );
        query.push(
            FieldDef::new(&names.one, type_ref(), FieldPlan::One { collection: name.clone() })
                .with_args(vec![InputValue::new("id", model.id_type.clone().non_null())]),
        );
        query.push(
            FieldDef::new(
                &names.count,
                TypeRef::named("Int").non_null(),
                FieldPlan::Count { collection: name.clone() },
            )
            .with_args(vec![InputValue::new("filter", TypeRef::Named(model.filter.clone()))]),
        );

        let plan = add_mutations(&mut builder, model, &mut mutation);
        plans.insert(name.clone(), plan);

        if input.subscriptions && engine.is_realtime(name) {
            let args = builder.list_args(model);
            subscription.push(
                FieldDef::new(
                    &format!("live{}", names.plural),
                    type_ref().non_null().list().non_null(),
                    FieldPlan::Live { collection: name.clone() },
                )
                .described(&format!("The full result of a {name} query, sent again on every change."))
                .with_args(args.clone()),
            );
            let change = builder.unique(&format!("{}Change", names.type_name));
            builder.model.add(TypeDef::Object {
                name: change.clone(),
                description: None,
                fields: vec![
                    FieldDef::new("kind", TypeRef::named("ChangeKind").non_null(), FieldPlan::Entry),
                    FieldDef::new("id", TypeRef::named("JSON"), FieldPlan::Entry),
                    FieldDef::new("doc", type_ref(), FieldPlan::Entry),
                    FieldDef::new("index", TypeRef::named("Int"), FieldPlan::Entry),
                ],
            });
            subscription.push(
                FieldDef::new(
                    &format!("{}Changes", names.one),
                    TypeRef::Named(change).non_null(),
                    FieldPlan::Changes { collection: name.clone() },
                )
                .described(&format!(
                    "Changes of a {name} query: added, changed and removed documents, then ready."
                ))
                .with_args(args),
            );
        }
    }

    if query.is_empty() {
        query.push(
            FieldDef::new("_empty", TypeRef::named("Boolean"), FieldPlan::Empty)
                .described("Present because the caller can read no collection"),
        );
    }
    builder.model.add(TypeDef::Object {
        name: "Query".into(),
        description: None,
        fields: root_fields(query),
    });
    if !mutation.is_empty() {
        builder.model.mutation = true;
        builder.model.add(TypeDef::Object {
            name: "Mutation".into(),
            description: None,
            fields: root_fields(mutation),
        });
    }
    if !subscription.is_empty() {
        builder.model.subscription = true;
        builder.model.add(TypeDef::Object {
            name: "Subscription".into(),
            description: None,
            fields: root_fields(subscription),
        });
    }
    GeneratedSchema {
        model: builder.model,
        collections: plans,
        default_limit: input.default_limit,
        max_limit: input.max_limit,
    }
}

fn root_fields(fields: Vec<FieldDef>) -> Vec<FieldDef> {
    let mut positions = HashMap::new();
    let mut unique: Vec<FieldDef> = Vec::new();
    for field in fields {
        match positions.get(&field.name) {
            Some(&index) => unique[index] = field,
            None => {
                positions.insert(field.name.clone(), unique.len());
                unique.push(field);
            }
        }
    }
    unique
}

struct WritableInput {
    type_name: Option<String>,
    map: FieldMap,
    shape: ObjectShape,
}

fn writable_input(builder: &mut Builder<'_>, model: &Model, op: Operation, suffix: &str) -> WritableInput {
    let input = builder.input;
    let name = &model.name;
    let schema = input.schemas.get(name);
    let open = ObjectShape::open();
    let strict = schema.is_some_and(|schema| schema.source == SchemaSource::Validator);
    let shape = restrict_shape(
        schema.map_or(&open, |schema| &schema.shape),
        &input.engine.writable(name, op, input.ctx),
        RestrictMode::Remove,
    );
    let require = op == Operation::Insert;
    let mut fields: Vec<InputValue> = Vec::new();
    let mut map = FieldMap::default();
    for (field, spec) in &shape.fields {
        if op == Operation::Update && field == "_id" {
            continue;
        }
        let gql = field_name(field);
        if gql == "_extra"
            || INHERITED_INPUT_FIELDS.contains(&gql.as_str())
            || fields.iter().any(|existing| existing.name == gql)
        {
            continue;
        }
        map.fields.push((gql.clone(), field.clone()));
        let ty = Builder::input_type(&spec.shape);
        let ty = if require && strict && spec.required && field != "_id" { ty.non_null() } else { ty };
        fields.push(InputValue::new(&gql, ty));
    }
    if op == Operation::Insert && !fields.iter().any(|existing| existing.name == "_id") {
        fields.push(InputValue::new("_id", model.id_type.clone()));
        map.fields.push(("_id".to_owned(), "_id".to_owned()));
    }
    if shape.open {
        fields.push(
            InputValue::new("_extra", TypeRef::named("JSON")).described("More fields, as Extended JSON"),
        );
    }
    let type_name = if fields.is_empty() {
        None
    } else {
        let type_name = builder.unique(&format!("{}{suffix}", model.names.type_name));
        builder.model.add(TypeDef::Input { name: type_name.clone(), fields });
        Some(type_name)
    };
    WritableInput { type_name, map, shape }
}

fn add_mutations(builder: &mut Builder<'_>, model: &Model, mutation: &mut Vec<FieldDef>) -> CollectionPlan {
    let engine = builder.input.engine;
    let ctx = builder.input.ctx;
    let name = &model.name;
    let names = &model.names;
    let mut plan = CollectionPlan {
        name: name.clone(),
        type_name: names.type_name.clone(),
        filter: model.filter.clone(),
        filter_map: model.filter_map.clone(),
        insert: None,
        insert_map: FieldMap::default(),
        set_map: FieldMap::default(),
    };
    let insert = engine.has_grant(name, Operation::Insert, ctx);
    let update = engine.has_grant(name, Operation::Update, ctx);
    let delete = engine.has_grant(name, Operation::Delete, ctx);
    if !insert && !update && !delete {
        return plan;
    }
    let type_ref = || TypeRef::Named(names.type_name.clone());
    let id = || InputValue::new("id", model.id_type.clone().non_null());
    let filter = || TypeRef::Named(model.filter.clone());
    let where_arg = || InputValue::new("where", filter());
    let field = |gql: String, ty: TypeRef, kind: MutationKind, args: Vec<InputValue>| {
        FieldDef::new(&gql, ty, FieldPlan::Mutation { collection: name.clone(), kind }).with_args(args)
    };

    if insert || update {
        let input = writable_input(builder, model, Operation::Insert, "Insert");
        let doc = TypeRef::Named(input.type_name.clone().unwrap_or_else(|| "JSON".to_owned()));
        plan.insert = input.type_name.clone();
        plan.insert_map = input.map;
        if insert {
            mutation.push(field(
                format!("insert{}", names.singular),
                type_ref(),
                MutationKind::Insert,
                vec![InputValue::new("doc", doc.clone().non_null())],
            ));
            mutation.push(field(
                format!("insert{}", names.plural),
                type_ref().list().non_null(),
                MutationKind::InsertMany,
                vec![InputValue::new("docs", doc.clone().non_null().list().non_null())],
            ));
        }
        if update {
            mutation.push(field(
                format!("replace{}", names.singular),
                type_ref(),
                MutationKind::Replace,
                vec![
                    id(),
                    InputValue::new("doc", doc.non_null()),
                    where_arg(),
                    InputValue::new("upsert", TypeRef::named("Boolean")),
                ],
            ));
        }
    }

    if update {
        let set = writable_input(builder, model, Operation::Update, "Set");
        let mut numeric = Vec::new();
        let mut unset_values = Vec::new();
        for (gql, field) in &set.map.fields {
            unset_values.push((gql.clone(), field.clone()));
            let scalar = set.shape.field(field).and_then(|spec| scalar_of(&spec.shape));
            if let Some(scalar @ ("Int" | "Float" | "Long" | "Decimal")) = scalar {
                numeric.push(InputValue::new(gql, TypeRef::named(scalar)));
            }
        }
        let mut update_fields =
            vec![InputValue::new("raw", TypeRef::named("JSON")).described("Extended JSON update operators")];
        if let Some(set_type) = &set.type_name {
            update_fields.push(InputValue::new("set", TypeRef::Named(set_type.clone())));
        }
        if !numeric.is_empty() {
            let inc = builder.unique(&format!("{}Inc", names.type_name));
            builder.model.add(TypeDef::Input { name: inc.clone(), fields: numeric });
            update_fields.push(InputValue::new("inc", TypeRef::Named(inc)));
        }
        if !unset_values.is_empty() {
            let unset = builder.unique(&format!("{}Field", names.type_name));
            builder.model.add(TypeDef::Enum { name: unset.clone(), values: unset_values });
            update_fields.push(InputValue::new("unset", TypeRef::Named(unset).non_null().list()));
        }
        let update_type = builder.unique(&format!("{}Update", names.type_name));
        builder.model.add(TypeDef::Input { name: update_type.clone(), fields: update_fields });
        plan.set_map = set.map;
        let update_arg = || InputValue::new("update", TypeRef::Named(update_type.clone()).non_null());
        mutation.push(field(
            format!("update{}", names.singular),
            type_ref(),
            MutationKind::Update,
            vec![id(), update_arg(), where_arg()],
        ));
        mutation.push(field(
            format!("update{}", names.plural),
            TypeRef::named("BulkResult").non_null(),
            MutationKind::UpdateMany,
            vec![InputValue::new("filter", filter().non_null()), update_arg()],
        ));
    }

    if delete {
        mutation.push(field(
            format!("delete{}", names.singular),
            type_ref(),
            MutationKind::Delete,
            vec![id(), where_arg()],
        ));
        mutation.push(field(
            format!("delete{}", names.plural),
            TypeRef::named("BulkResult").non_null(),
            MutationKind::DeleteMany,
            vec![InputValue::new("filter", filter().non_null())],
        ));
    }
    plan
}
