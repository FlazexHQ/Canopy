/// A BSON value. Documents keep their field order, as MongoDB does. Rare or large types are boxed so a value
/// takes 32 bytes.
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    /// BSON double.
    Double(f64),
    /// UTF-8 string.
    String(String),
    /// Embedded document.
    Document(Document),
    /// Array.
    Array(Vec<Value>),
    /// Binary data with its subtype.
    Binary(Box<Binary>),
    /// The deprecated BSON `undefined`.
    Undefined,
    /// A 12 byte ObjectId.
    ObjectId([u8; 12]),
    /// Boolean.
    Bool(bool),
    /// Milliseconds since the Unix epoch.
    DateTime(i64),
    /// BSON null.
    Null,
    /// Regular expression with sorted option letters.
    Regex(Box<Regex>),
    /// The deprecated DBPointer.
    DbPointer(Box<DbPointer>),
    /// JavaScript code, with its scope when the BSON type was code with scope.
    JavaScript(Box<JavaScript>),
    /// The deprecated symbol type.
    Symbol(String),
    /// 32 bit integer.
    Int32(i32),
    /// Timestamp: seconds and increment.
    Timestamp {
        /// Seconds.
        t: u32,
        /// Increment.
        i: u32,
    },
    /// 64 bit integer.
    Int64(i64),
    /// Decimal128 in its string form, as the TypeScript packages keep it.
    Decimal128(String),
    /// MinKey, which sorts before every other value.
    MinKey,
    /// MaxKey, which sorts after every other value.
    MaxKey,
}

/// The deprecated DBPointer: a namespace and an ObjectId.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DbPointer {
    /// The namespace.
    pub namespace: String,
    /// The ObjectId.
    pub id: [u8; 12],
}

/// JavaScript code, with its scope when the BSON type was code with scope.
#[derive(Debug, Clone, PartialEq)]
pub struct JavaScript {
    /// The code.
    pub code: String,
    /// The scope document.
    pub scope: Option<Document>,
}

/// Binary data with a subtype.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Binary {
    /// The subtype, from 0 to 255.
    pub subtype: u8,
    /// The bytes.
    pub bytes: Vec<u8>,
}

/// A regular expression with MongoDB option letters, kept sorted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Regex {
    /// The pattern.
    pub pattern: String,
    /// The option letters, sorted.
    pub options: String,
}

impl Regex {
    /// Creates a regular expression, sorting the option letters.
    pub fn new(pattern: &str, options: &str) -> Regex {
        let letters: std::collections::BinaryHeap<char> = options.chars().collect();
        Regex { pattern: pattern.to_owned(), options: letters.into_sorted_vec().into_iter().collect() }
    }
}

/// An ordered document. Field names are unique; inserting an existing name replaces its value in place.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Document {
    fields: Vec<(String, Value)>,
}

impl Document {
    /// Creates an empty document.
    pub fn new() -> Document {
        Document { fields: Vec::new() }
    }

    /// Creates an empty document with room for `capacity` fields.
    pub fn with_capacity(capacity: usize) -> Document {
        Document { fields: Vec::with_capacity(capacity) }
    }

    /// Wraps fields whose names the caller has already checked to be unique.
    pub(crate) fn from_unique_fields(fields: Vec<(String, Value)>) -> Document {
        Document { fields }
    }

    /// Returns the value of a field.
    pub fn get(&self, name: &str) -> Option<&Value> {
        self.fields.iter().find(|(key, _)| key == name).map(|(_, value)| value)
    }

    /// Returns a mutable reference to the value of a field.
    pub fn get_mut(&mut self, name: &str) -> Option<&mut Value> {
        self.fields.iter_mut().find(|(key, _)| key == name).map(|(_, value)| value)
    }

    /// Sets a field, keeping its position when it exists and appending it otherwise. The name is copied only
    /// when the field is new.
    pub fn insert(&mut self, name: impl AsRef<str> + Into<String>, value: Value) {
        match self.get_mut(name.as_ref()) {
            Some(slot) => *slot = value,
            None => self.fields.push((name.into(), value)),
        }
    }

    /// Removes a field and returns its value.
    pub fn remove(&mut self, name: &str) -> Option<Value> {
        let position = self.fields.iter().position(|(key, _)| key == name)?;
        Some(self.fields.remove(position).1)
    }

    /// Returns true when the field exists.
    pub fn contains_key(&self, name: &str) -> bool {
        self.get(name).is_some()
    }

    /// The fields in order, as a slice.
    pub fn fields(&self) -> &[(String, Value)] {
        &self.fields
    }

    /// The fields in order.
    pub fn iter(&self) -> impl ExactSizeIterator<Item = (&str, &Value)> {
        self.fields.iter().map(|(key, value)| (key.as_str(), value))
    }

    /// The field names in order.
    pub fn keys(&self) -> impl ExactSizeIterator<Item = &str> {
        self.fields.iter().map(|(key, _)| key.as_str())
    }

    /// The name of the first field.
    pub fn first_key(&self) -> Option<&str> {
        self.fields.first().map(|(key, _)| key.as_str())
    }

    /// The number of fields.
    pub fn len(&self) -> usize {
        self.fields.len()
    }

    /// Returns true when the document has no fields.
    pub fn is_empty(&self) -> bool {
        self.fields.is_empty()
    }
}

impl<K: AsRef<str> + Into<String>> FromIterator<(K, Value)> for Document {
    fn from_iter<I: IntoIterator<Item = (K, Value)>>(iter: I) -> Document {
        let iter = iter.into_iter();
        let mut document = Document::with_capacity(iter.size_hint().0);
        for (name, value) in iter {
            document.insert(name, value);
        }
        document
    }
}

impl IntoIterator for Document {
    type Item = (String, Value);
    type IntoIter = std::vec::IntoIter<(String, Value)>;

    fn into_iter(self) -> Self::IntoIter {
        self.fields.into_iter()
    }
}

impl Value {
    /// Returns the document when the value is one.
    pub fn as_document(&self) -> Option<&Document> {
        match self {
            Value::Document(document) => Some(document),
            _ => None,
        }
    }

    /// Returns the elements when the value is an array.
    pub fn as_array(&self) -> Option<&[Value]> {
        match self {
            Value::Array(items) => Some(items),
            _ => None,
        }
    }

    /// Returns the string when the value is a string.
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::String(text) => Some(text),
            _ => None,
        }
    }

    /// Classifies a JavaScript number the way the `bson` serializer stores it: integers in the int32 range (other
    /// than negative zero) become `Int32`, everything else `Double`.
    pub fn from_js_number(number: f64) -> Value {
        if is_int32(number) {
            #[allow(clippy::cast_possible_truncation)]
            Value::Int32(number as i32)
        } else {
            Value::Double(number)
        }
    }
}

/// Returns true for numbers the `bson` serializer stores as int32.
pub fn is_int32(number: f64) -> bool {
    number.fract() == 0.0
        && (-2_147_483_648.0..=2_147_483_647.0).contains(&number)
        && !(number == 0.0 && number.is_sign_negative())
}

/// Returns the lower case hexadecimal form of an ObjectId.
pub fn object_id_hex(id: &[u8; 12]) -> String {
    hex(id)
}

/// Returns the lower case hexadecimal form of some bytes.
pub fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(char::from(DIGITS[usize::from(byte >> 4)]));
        out.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
    }
    out
}

/// Parses 24 hexadecimal characters (either case) into an ObjectId.
pub fn parse_object_id(text: &str) -> Option<[u8; 12]> {
    let bytes = text.as_bytes();
    if bytes.len() != 24 {
        return None;
    }
    let mut id = [0u8; 12];
    for (index, slot) in id.iter_mut().enumerate() {
        let high = hex_digit(bytes[index * 2])?;
        let low = hex_digit(bytes[index * 2 + 1])?;
        *slot = (high << 4) | low;
    }
    Some(id)
}

pub(crate) fn hex_digit(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn values_stay_small() {
        assert_eq!(std::mem::size_of::<Value>(), 32);
    }

    #[test]
    fn insert_keeps_the_position_of_an_existing_field() {
        let mut document = Document::new();
        document.insert("a", Value::Int32(1));
        document.insert("b", Value::Int32(2));
        document.insert("a", Value::Int32(3));
        let keys: Vec<&str> = document.keys().collect();
        assert_eq!(keys, ["a", "b"]);
        assert_eq!(document.get("a"), Some(&Value::Int32(3)));
    }

    #[test]
    fn collecting_repeated_names_keeps_the_first_position_and_the_last_value() {
        let document: Document =
            [("a", Value::Int32(1)), ("b", Value::Int32(2)), ("a", Value::Int32(3))].into_iter().collect();
        assert_eq!(document.keys().collect::<Vec<_>>(), ["a", "b"]);
        assert_eq!(document.get("a"), Some(&Value::Int32(3)));
        let names: Vec<String> = document.into_iter().map(|(name, _)| name).collect();
        assert_eq!(names, ["a", "b"]);
    }

    #[test]
    fn js_numbers_are_classified_like_the_bson_serializer() {
        assert_eq!(Value::from_js_number(5.0), Value::Int32(5));
        assert_eq!(Value::from_js_number(-2_147_483_648.0), Value::Int32(i32::MIN));
        assert_eq!(Value::from_js_number(2_147_483_648.0), Value::Double(2_147_483_648.0));
        assert_eq!(Value::from_js_number(0.5), Value::Double(0.5));
        assert!(matches!(Value::from_js_number(-0.0), Value::Double(z) if z.is_sign_negative()));
    }

    #[test]
    fn object_ids_round_trip_through_hex() {
        let id = parse_object_id("5F1D7A2B9C0E4F6A8B3C2D1E").unwrap();
        assert_eq!(object_id_hex(&id), "5f1d7a2b9c0e4f6a8b3c2d1e");
        assert_eq!(parse_object_id("5f1d"), None);
        assert_eq!(parse_object_id("zz1d7a2b9c0e4f6a8b3c2d1e"), None);
    }

    #[test]
    fn regex_options_are_sorted() {
        assert_eq!(Regex::new("a", "xmi").options, "imx");
    }
}
