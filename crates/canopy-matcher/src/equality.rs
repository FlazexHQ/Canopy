//! Equality keys: values that compare equal under MongoDB's rules get equal keys, so `$in` sets and the
//! realtime predicate index can use hashing instead of comparing one by one.

use std::collections::HashSet;

use canopy_protocol::Value;

/// The key of a number: integral values that fit a 64 bit integer share one form whatever their BSON type,
/// other doubles are keyed by their bits (with NaN folded to one key).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum NumberKey {
    /// An integral value within the 64 bit range.
    Integer(i64),
    /// Any other double, by its bits.
    Bits(u64),
    /// NaN.
    NaN,
}

/// An equality key. Values without a cheap key (documents, arrays, decimals, binary data and others) have
/// none; callers compare those directly.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EqualityKey<'a> {
    /// A string or a symbol.
    String(&'a str),
    /// A number other than a decimal.
    Number(NumberKey),
    /// A boolean.
    Bool(bool),
    /// Null.
    Null,
    /// A date, in milliseconds.
    Date(i64),
    /// An ObjectId.
    ObjectId([u8; 12]),
}

fn double_key(value: f64) -> NumberKey {
    const TWO_POW_63: f64 = 9_223_372_036_854_775_808.0;
    if value.is_nan() {
        return NumberKey::NaN;
    }
    if value.fract() == 0.0 && (-TWO_POW_63..TWO_POW_63).contains(&value) {
        #[allow(clippy::cast_possible_truncation)]
        return NumberKey::Integer(value as i64);
    }
    NumberKey::Bits(value.to_bits())
}

/// Returns the equality key of a value, when it has one.
pub fn equality_key(value: &Value) -> Option<EqualityKey<'_>> {
    Some(match value {
        Value::String(text) | Value::Symbol(text) => EqualityKey::String(text),
        Value::Int32(n) => EqualityKey::Number(NumberKey::Integer(i64::from(*n))),
        Value::Int64(n) => EqualityKey::Number(NumberKey::Integer(*n)),
        Value::Double(n) => EqualityKey::Number(double_key(*n)),
        Value::Bool(flag) => EqualityKey::Bool(*flag),
        Value::Null => EqualityKey::Null,
        Value::DateTime(ms) => EqualityKey::Date(*ms),
        Value::ObjectId(id) => EqualityKey::ObjectId(*id),
        _ => return None,
    })
}

/// A set of equality keys that owns its strings and can be probed with borrowed keys.
#[derive(Debug, Default)]
pub struct KeySet {
    strings: HashSet<String>,
    others: HashSet<EqualityKey<'static>>,
}

impl KeySet {
    /// Adds a key.
    pub fn insert(&mut self, key: EqualityKey<'_>) {
        match key {
            EqualityKey::String(text) => {
                self.strings.insert(text.to_owned());
            }
            EqualityKey::Number(n) => {
                self.others.insert(EqualityKey::Number(n));
            }
            EqualityKey::Bool(flag) => {
                self.others.insert(EqualityKey::Bool(flag));
            }
            EqualityKey::Null => {
                self.others.insert(EqualityKey::Null);
            }
            EqualityKey::Date(ms) => {
                self.others.insert(EqualityKey::Date(ms));
            }
            EqualityKey::ObjectId(id) => {
                self.others.insert(EqualityKey::ObjectId(id));
            }
        }
    }

    /// Returns true when the set holds the key.
    pub fn contains(&self, key: EqualityKey<'_>) -> bool {
        match key {
            EqualityKey::String(text) => self.strings.contains(text),
            EqualityKey::Number(n) => self.others.contains(&EqualityKey::Number(n)),
            EqualityKey::Bool(flag) => self.others.contains(&EqualityKey::Bool(flag)),
            EqualityKey::Null => self.others.contains(&EqualityKey::Null),
            EqualityKey::Date(ms) => self.others.contains(&EqualityKey::Date(ms)),
            EqualityKey::ObjectId(id) => self.others.contains(&EqualityKey::ObjectId(id)),
        }
    }

    /// Returns true when the set is empty.
    pub fn is_empty(&self) -> bool {
        self.strings.is_empty() && self.others.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn equal_numbers_share_a_key_across_types() {
        assert_eq!(equality_key(&Value::Int32(5)), equality_key(&Value::Double(5.0)));
        assert_eq!(equality_key(&Value::Int64(5)), equality_key(&Value::Double(5.0)));
        assert_eq!(equality_key(&Value::Double(-0.0)), equality_key(&Value::Int32(0)));
        assert_ne!(
            equality_key(&Value::Int64(9_007_199_254_740_993)),
            equality_key(&Value::Double(9_007_199_254_740_992.0))
        );
        assert_eq!(equality_key(&Value::Double(f64::NAN)), equality_key(&Value::Double(-f64::NAN)));
        assert_eq!(equality_key(&Value::Decimal128("1".to_owned())), None);
    }

    #[test]
    fn symbols_share_keys_with_strings() {
        assert_eq!(equality_key(&Value::Symbol("a".into())), equality_key(&Value::String("a".into())));
    }

    #[test]
    fn key_sets_probe_with_borrowed_keys() {
        let mut set = KeySet::default();
        set.insert(EqualityKey::String("x"));
        set.insert(EqualityKey::Number(NumberKey::Integer(3)));
        assert!(set.contains(EqualityKey::String("x")));
        assert!(set.contains(equality_key(&Value::Double(3.0)).unwrap()));
        assert!(!set.contains(EqualityKey::Bool(true)));
    }
}
