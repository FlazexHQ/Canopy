use canopy_policy::FieldAccess;

/// The BSON value types a schema distinguishes. `Uuid` is binary data of subtype 4.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum ScalarType {
    /// A string, or a deprecated symbol.
    String,
    /// A 64 bit binary floating point number.
    Double,
    /// A 32 bit integer.
    Int,
    /// A 64 bit integer.
    Long,
    /// A 128 bit decimal.
    Decimal,
    /// A boolean.
    Bool,
    /// A date.
    Date,
    /// An ObjectId.
    ObjectId,
    /// Binary data of any subtype but 4.
    BinData,
    /// Binary data of subtype 4.
    Uuid,
    /// Null, undefined or a missing value.
    Null,
    /// A timestamp.
    Timestamp,
    /// A regular expression.
    Regex,
    /// The min key.
    MinKey,
    /// The max key.
    MaxKey,
    /// JavaScript code, with or without scope.
    Javascript,
}

impl ScalarType {
    /// Every scalar type in the order a union of inferred types lists them.
    pub const INFERRED_ORDER: [ScalarType; 16] = [
        ScalarType::Null,
        ScalarType::Bool,
        ScalarType::Int,
        ScalarType::Long,
        ScalarType::Double,
        ScalarType::Decimal,
        ScalarType::String,
        ScalarType::ObjectId,
        ScalarType::Uuid,
        ScalarType::BinData,
        ScalarType::Date,
        ScalarType::Timestamp,
        ScalarType::Regex,
        ScalarType::Javascript,
        ScalarType::MinKey,
        ScalarType::MaxKey,
    ];

    /// The name the TypeScript schema model uses, such as `objectId` or `binData`.
    pub fn name(self) -> &'static str {
        match self {
            ScalarType::String => "string",
            ScalarType::Double => "double",
            ScalarType::Int => "int",
            ScalarType::Long => "long",
            ScalarType::Decimal => "decimal",
            ScalarType::Bool => "bool",
            ScalarType::Date => "date",
            ScalarType::ObjectId => "objectId",
            ScalarType::BinData => "binData",
            ScalarType::Uuid => "uuid",
            ScalarType::Null => "null",
            ScalarType::Timestamp => "timestamp",
            ScalarType::Regex => "regex",
            ScalarType::MinKey => "minKey",
            ScalarType::MaxKey => "maxKey",
            ScalarType::Javascript => "javascript",
        }
    }

    /// The scalar type of a TypeScript schema model name.
    pub fn from_name(name: &str) -> Option<ScalarType> {
        ScalarType::INFERRED_ORDER.into_iter().find(|scalar| scalar.name() == name)
    }
}

/// The shape of a value.
#[derive(Clone, Debug, PartialEq)]
pub enum Shape {
    /// Any value.
    Any,
    /// One scalar type. For strings, `values` lists the only values that occur when they form a small
    /// closed set, sorted.
    Scalar {
        /// The type.
        scalar: ScalarType,
        /// The closed set of string values, when there is one.
        values: Option<Vec<String>>,
    },
    /// A subdocument.
    Object(ObjectShape),
    /// An array whose elements have one shape.
    Array(Box<Shape>),
    /// One of several shapes, never nested and never containing [`Shape::Any`].
    Union(Vec<Shape>),
}

/// A field of an object shape.
#[derive(Clone, Debug, PartialEq)]
pub struct Field {
    /// The shape of its value.
    pub shape: Shape,
    /// Whether every document has it.
    pub required: bool,
}

/// An object shape: its fields in order, and whether others may occur.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct ObjectShape {
    /// The fields, in the order they are listed.
    pub fields: Vec<(String, Field)>,
    /// Whether fields beyond `fields` may occur.
    pub open: bool,
}

impl ObjectShape {
    /// The object that admits any field.
    pub fn open() -> ObjectShape {
        ObjectShape { fields: Vec::new(), open: true }
    }

    /// The field of that name.
    pub fn field(&self, name: &str) -> Option<&Field> {
        self.fields.iter().find(|(key, _)| key == name).map(|(_, field)| field)
    }
}

impl Shape {
    /// A scalar shape without a closed set of values.
    pub fn scalar(scalar: ScalarType) -> Shape {
        Shape::Scalar { scalar, values: None }
    }

    /// The members of a shape: the shapes of a union, or the shape itself.
    pub fn members(&self) -> &[Shape] {
        match self {
            Shape::Union(of) => of,
            other => std::slice::from_ref(other),
        }
    }
}

/// Builds a union, flattening nested unions and collapsing to [`Shape::Any`] when any member is `Any`.
pub fn union(shapes: impl IntoIterator<Item = Shape>) -> Shape {
    let mut flat = Vec::new();
    for shape in shapes {
        match shape {
            Shape::Any => return Shape::Any,
            Shape::Union(of) => flat.extend(of),
            other => flat.push(other),
        }
    }
    match flat.len() {
        0 => Shape::Any,
        1 => flat.pop().unwrap_or(Shape::Any),
        _ => Shape::Union(flat),
    }
}

/// What happens to fields a role cannot access.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RestrictMode {
    /// They are dropped.
    Remove,
    /// They stay, but are no longer required.
    Optional,
}

enum Decision {
    Keep,
    Drop,
    Descend,
}

fn within(path: &str, ancestor: &str) -> bool {
    path == ancestor || (path.starts_with(ancestor) && path.as_bytes().get(ancestor.len()) == Some(&b'.'))
}

fn decide(access: &FieldAccess, path: &str) -> Decision {
    if path == "_id" {
        return Decision::Keep;
    }
    match access {
        FieldAccess::All => Decision::Keep,
        FieldAccess::Only(paths) => {
            if paths.iter().any(|allowed| within(path, allowed)) {
                Decision::Keep
            } else if paths.iter().any(|allowed| within(allowed, path)) {
                Decision::Descend
            } else {
                Decision::Drop
            }
        }
        FieldAccess::Omit(paths) => {
            if paths.iter().any(|hidden| within(path, hidden)) {
                Decision::Drop
            } else if paths.iter().any(|hidden| within(hidden, path)) {
                Decision::Descend
            } else {
                Decision::Keep
            }
        }
    }
}

/// Applies field rules to a shape, the way documents are projected for a role: under `Only` a field stays
/// when it lies within an allowed path, and under `Omit` it stays unless it lies within a hidden path.
/// Subdocuments that are partly accessible are restricted field by field, through arrays as well. With
/// [`RestrictMode::Optional`], inaccessible fields are kept but no longer required.
pub fn restrict_shape(shape: &ObjectShape, access: &FieldAccess, mode: RestrictMode) -> ObjectShape {
    restrict_object(shape, access, mode, "")
}

fn restrict_object(
    shape: &ObjectShape,
    access: &FieldAccess,
    mode: RestrictMode,
    prefix: &str,
) -> ObjectShape {
    let mut fields = Vec::with_capacity(shape.fields.len());
    for (key, field) in &shape.fields {
        let path = if prefix.is_empty() { key.clone() } else { format!("{prefix}.{key}") };
        match decide(access, &path) {
            Decision::Keep => fields.push((key.clone(), field.clone())),
            Decision::Descend => fields.push((
                key.clone(),
                Field { shape: restrict_nested(&field.shape, access, mode, &path), required: field.required },
            )),
            Decision::Drop => {
                if mode == RestrictMode::Optional {
                    fields.push((key.clone(), Field { shape: field.shape.clone(), required: false }));
                }
            }
        }
    }
    ObjectShape { fields, open: shape.open && !matches!(access, FieldAccess::Only(_)) }
}

fn restrict_nested(shape: &Shape, access: &FieldAccess, mode: RestrictMode, path: &str) -> Shape {
    match shape {
        Shape::Object(object) => Shape::Object(restrict_object(object, access, mode, path)),
        Shape::Array(items) => Shape::Array(Box::new(restrict_nested(items, access, mode, path))),
        Shape::Union(of) => union(of.iter().map(|member| restrict_nested(member, access, mode, path))),
        other => other.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn object(fields: Vec<(&str, Shape, bool)>, open: bool) -> ObjectShape {
        ObjectShape {
            fields: fields
                .into_iter()
                .map(|(name, shape, required)| (name.to_owned(), Field { shape, required }))
                .collect(),
            open,
        }
    }

    fn names(shape: &ObjectShape) -> Vec<&str> {
        shape.fields.iter().map(|(name, _)| name.as_str()).collect()
    }

    #[test]
    fn a_union_flattens_and_collapses_to_any() {
        let string = Shape::scalar(ScalarType::String);
        let int = Shape::scalar(ScalarType::Int);
        assert_eq!(union([]), Shape::Any);
        assert_eq!(union([string.clone()]), string);
        assert_eq!(
            union([string.clone(), Shape::Union(vec![int.clone(), Shape::scalar(ScalarType::Null)])]),
            Shape::Union(vec![string.clone(), int.clone(), Shape::scalar(ScalarType::Null)])
        );
        assert_eq!(union([string, Shape::Any, int]), Shape::Any);
    }

    #[test]
    fn only_keeps_allowed_paths_and_descends_into_their_ancestors() {
        let address = object(
            vec![
                ("city", Shape::scalar(ScalarType::String), true),
                ("zip", Shape::scalar(ScalarType::String), true),
            ],
            true,
        );
        let shape = object(
            vec![
                ("_id", Shape::scalar(ScalarType::ObjectId), true),
                ("name", Shape::scalar(ScalarType::String), true),
                ("salary", Shape::scalar(ScalarType::Int), true),
                ("address", Shape::Array(Box::new(Shape::Object(address))), false),
                ("names", Shape::scalar(ScalarType::String), false),
            ],
            true,
        );
        let access = FieldAccess::Only(vec!["name".to_owned(), "address.city".to_owned()]);
        let restricted = restrict_shape(&shape, &access, RestrictMode::Remove);
        assert_eq!(names(&restricted), ["_id", "name", "address"]);
        assert!(!restricted.open, "only closes the object");
        let Some(Field { shape: Shape::Array(items), required: false }) = restricted.field("address") else {
            panic!("address stays an optional array: {restricted:?}")
        };
        let Shape::Object(inner) = items.as_ref() else { panic!("array of objects") };
        assert_eq!(names(inner), ["city"]);

        let optional = restrict_shape(&shape, &access, RestrictMode::Optional);
        assert_eq!(names(&optional), ["_id", "name", "salary", "address", "names"]);
        assert_eq!(optional.field("salary").map(|field| field.required), Some(false));
        assert_eq!(optional.field("name").map(|field| field.required), Some(true));
    }

    #[test]
    fn omit_drops_hidden_paths_and_keeps_the_object_open() {
        let shape = object(
            vec![
                ("_id", Shape::scalar(ScalarType::ObjectId), true),
                ("secret", Shape::scalar(ScalarType::String), true),
                ("secrets", Shape::scalar(ScalarType::String), true),
                (
                    "profile",
                    Shape::Object(object(
                        vec![
                            ("bio", Shape::scalar(ScalarType::String), false),
                            ("ssn", Shape::scalar(ScalarType::String), false),
                        ],
                        false,
                    )),
                    true,
                ),
            ],
            true,
        );
        let access = FieldAccess::Omit(vec!["secret".to_owned(), "profile.ssn".to_owned(), "_id".to_owned()]);
        let restricted = restrict_shape(&shape, &access, RestrictMode::Remove);
        assert_eq!(
            names(&restricted),
            ["_id", "secrets", "profile"],
            "_id is always kept, prefixes need a dot"
        );
        assert!(restricted.open);
        let Some(Field { shape: Shape::Object(profile), .. }) = restricted.field("profile") else {
            panic!("profile is restricted")
        };
        assert_eq!(names(profile), ["bio"]);
        assert!(!profile.open, "a closed subdocument stays closed");
    }

    #[test]
    fn scalar_names_round_trip() {
        for scalar in ScalarType::INFERRED_ORDER {
            assert_eq!(ScalarType::from_name(scalar.name()), Some(scalar));
        }
        assert_eq!(ScalarType::from_name("number"), None);
    }
}
