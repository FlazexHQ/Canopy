use std::collections::{HashMap, HashSet};

use canopy_protocol::{Document, Value};

use super::{
    CollectionSchema, Field, ObjectShape, ScalarType, SchemaSource, Shape, field_cmp, js_cmp, union,
};

/// Options for inferring a collection schema.
#[derive(Clone, Copy, Debug, Default)]
pub struct InferOptions {
    /// When present, enabled string enum inference with these thresholds.
    pub enums: Option<EnumOptions>,
}

/// Limits for inferring low cardinality strings as literal unions.
#[derive(Clone, Copy, Debug)]
pub struct EnumOptions {
    /// Maximum distinct values. Defaults to 20.
    pub max_values: usize,
    /// Minimum string occurrences. Defaults to 200.
    pub min_samples: usize,
}

impl Default for EnumOptions {
    fn default() -> Self {
        Self { max_values: 20, min_samples: 200 }
    }
}

/// Infers an open collection schema from BSON documents. Fields present in every sample are required.
pub fn infer_schema(name: &str, docs: &[Document], options: &InferOptions) -> CollectionSchema {
    let mut stats = ObjectStats::default();
    for doc in docs {
        stats.add(doc, options.enums);
    }
    CollectionSchema {
        name: name.to_owned(),
        shape: stats.shape(options.enums),
        source: SchemaSource::Inferred,
        sampled: Some(docs.len()),
    }
}

#[derive(Default)]
struct ObjectStats<'a> {
    count: usize,
    fields: HashMap<&'a str, ValueStats<'a>>,
}

impl<'a> ObjectStats<'a> {
    fn add(&mut self, doc: &'a Document, enums: Option<EnumOptions>) {
        self.count += 1;
        for (key, value) in doc.iter() {
            if key != "__proto__" && !matches!(value, Value::Undefined) {
                self.fields.entry(key).or_default().add(value, enums);
            }
        }
    }

    fn shape(self, enums: Option<EnumOptions>) -> ObjectShape {
        let mut fields: Vec<_> = self
            .fields
            .into_iter()
            .map(|(key, stats)| {
                let required = stats.count == self.count;
                (key.to_owned(), Field { shape: stats.shape(enums), required })
            })
            .collect();
        fields.sort_unstable_by(|(a, _), (b, _)| field_cmp(a, b));
        ObjectShape { fields, open: true }
    }
}

struct ValueStats<'a> {
    count: usize,
    scalars: HashSet<ScalarType>,
    strings: Option<HashSet<&'a str>>,
    string_count: usize,
    object: Option<ObjectStats<'a>>,
    items: Option<Box<ValueStats<'a>>>,
    unknown: bool,
}

impl Default for ValueStats<'_> {
    fn default() -> Self {
        Self {
            count: 0,
            scalars: HashSet::new(),
            strings: Some(HashSet::new()),
            string_count: 0,
            object: None,
            items: None,
            unknown: false,
        }
    }
}

impl<'a> ValueStats<'a> {
    fn add(&mut self, value: &'a Value, enums: Option<EnumOptions>) {
        self.count += 1;
        let scalar = match value {
            Value::Document(doc) => {
                if matches!(doc.get("_bsontype"), Some(Value::String(_))) || is_db_ref(doc) {
                    self.unknown = true;
                } else {
                    self.object.get_or_insert_with(ObjectStats::default).add(doc, enums);
                }
                return;
            }
            Value::Array(items) => {
                let stats = self.items.get_or_insert_with(Box::default);
                for item in items {
                    stats.add(item, enums);
                }
                return;
            }
            Value::DbPointer(_) => {
                self.unknown = true;
                return;
            }
            Value::String(value) | Value::Symbol(value) => {
                if let Some(enums) = enums {
                    self.string_count += 1;
                    if let Some(strings) = &mut self.strings {
                        strings.insert(value);
                        if strings.len() > enums.max_values {
                            self.strings = None;
                        }
                    }
                }
                ScalarType::String
            }
            Value::Null | Value::Undefined => ScalarType::Null,
            Value::Bool(_) => ScalarType::Bool,
            Value::Int32(_) => ScalarType::Int,
            Value::Int64(_) => ScalarType::Long,
            Value::Double(_) => ScalarType::Double,
            Value::Decimal128(_) => ScalarType::Decimal,
            Value::ObjectId(_) => ScalarType::ObjectId,
            Value::Binary(binary) if binary.subtype == 4 => ScalarType::Uuid,
            Value::Binary(_) => ScalarType::BinData,
            Value::DateTime(_) => ScalarType::Date,
            Value::Timestamp { .. } => ScalarType::Timestamp,
            Value::Regex(_) => ScalarType::Regex,
            Value::JavaScript(_) => ScalarType::Javascript,
            Value::MinKey => ScalarType::MinKey,
            Value::MaxKey => ScalarType::MaxKey,
        };
        self.scalars.insert(scalar);
    }

    fn shape(self, enums: Option<EnumOptions>) -> Shape {
        if self.unknown {
            return Shape::Any;
        }
        let values =
            self.strings.filter(|_| enums.is_some_and(|enums| self.string_count >= enums.min_samples));
        let mut literals = values.map(|values| {
            let mut values: Vec<_> = values.into_iter().map(str::to_owned).collect();
            values.sort_unstable_by(|a, b| js_cmp(a, b));
            values
        });
        let scalars = ScalarType::INFERRED_ORDER.into_iter().filter(|scalar| self.scalars.contains(scalar));
        let scalars = scalars.map(|scalar| {
            let values = if scalar == ScalarType::String { literals.take() } else { None };
            Shape::Scalar { scalar, values }
        });
        let object = self.object.map(|stats| Shape::Object(stats.shape(enums)));
        let array = self.items.map(|stats| Shape::Array(Box::new(stats.shape(enums))));
        union(scalars.chain(object).chain(array))
    }
}

fn is_db_ref(doc: &Document) -> bool {
    matches!(doc.get("$ref"), Some(Value::String(_)))
        && doc.get("$id").is_some_and(|id| !matches!(id, Value::Null | Value::Undefined))
        && doc.get("$db").is_none_or(|value| matches!(value, Value::String(_)))
        && doc.keys().all(|key| !key.starts_with('$') || matches!(key, "$ref" | "$id" | "$db"))
}
