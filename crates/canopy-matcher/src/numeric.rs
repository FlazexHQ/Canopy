//! Numbers across int, long, double and Decimal128, compared by exact value as MongoDB does.

use std::cmp::Ordering;

use canopy_protocol::Value;
use canopy_protocol::ejson::js_string_to_number;

/// A number read from any supported representation.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Numeric<'a> {
    /// A 32 bit integer.
    Int(i32),
    /// A double.
    Double(f64),
    /// A 64 bit integer.
    Long(i64),
    /// A Decimal128 in its string form.
    Decimal(&'a str),
}

/// Reads a numeric value, or `None` for values that are not numbers.
pub fn read_numeric(value: &Value) -> Option<Numeric<'_>> {
    match value {
        Value::Int32(n) => Some(Numeric::Int(*n)),
        Value::Double(n) => Some(Numeric::Double(*n)),
        Value::Int64(n) => Some(Numeric::Long(*n)),
        Value::Decimal128(text) => Some(Numeric::Decimal(text)),
        _ => None,
    }
}

#[derive(Debug, PartialEq)]
enum Exact {
    NaN,
    Infinite(bool),
    Finite(Decimal),
}

/// A finite number as a sign, its significant decimal digits (no leading or trailing zeros) and the power of
/// ten of the last digit. Zero has no digits.
#[derive(Debug, PartialEq)]
struct Decimal {
    negative: bool,
    digits: Vec<u8>,
    exponent: i64,
}

impl Decimal {
    fn new(negative: bool, mut digits: Vec<u8>, mut exponent: i64) -> Decimal {
        let leading = digits.iter().take_while(|digit| **digit == 0).count();
        digits.drain(..leading);
        while digits.last() == Some(&0) {
            digits.pop();
            exponent += 1;
        }
        let negative = negative && !digits.is_empty();
        Decimal { negative, digits, exponent }
    }

    fn top(&self) -> i64 {
        self.exponent.saturating_add(i64::try_from(self.digits.len()).unwrap_or(i64::MAX))
    }

    fn compare_magnitude(&self, other: &Decimal) -> Ordering {
        match (self.digits.is_empty(), other.digits.is_empty()) {
            (true, true) => return Ordering::Equal,
            (true, false) => return Ordering::Less,
            (false, true) => return Ordering::Greater,
            (false, false) => {}
        }
        self.top().cmp(&other.top()).then_with(|| {
            let length = self.digits.len().max(other.digits.len());
            for index in 0..length {
                let x = self.digits.get(index).copied().unwrap_or(0);
                let y = other.digits.get(index).copied().unwrap_or(0);
                if x != y {
                    return x.cmp(&y);
                }
            }
            Ordering::Equal
        })
    }

    fn compare(&self, other: &Decimal) -> Ordering {
        match (self.negative, other.negative) {
            (false, true) => Ordering::Greater,
            (true, false) => Ordering::Less,
            (false, false) => self.compare_magnitude(other),
            (true, true) => other.compare_magnitude(self),
        }
    }
}

/// An unsigned integer in base 10^9 limbs, least significant first, for the exact expansion of a double.
struct Big(Vec<u32>);

impl Big {
    const BASE: u64 = 1_000_000_000;

    fn from_u64(mut n: u64) -> Big {
        let mut limbs = Vec::new();
        while n > 0 {
            limbs.push(u32::try_from(n % Big::BASE).unwrap_or(0));
            n /= Big::BASE;
        }
        Big(limbs)
    }

    fn multiply(&mut self, factor: u64) {
        let mut carry = 0u64;
        for limb in &mut self.0 {
            let product = u64::from(*limb) * factor + carry;
            *limb = u32::try_from(product % Big::BASE).unwrap_or(0);
            carry = product / Big::BASE;
        }
        while carry > 0 {
            self.0.push(u32::try_from(carry % Big::BASE).unwrap_or(0));
            carry /= Big::BASE;
        }
    }

    fn digits(&self) -> Vec<u8> {
        let mut out = Vec::new();
        for (index, limb) in self.0.iter().rev().enumerate() {
            let text = if index == 0 { limb.to_string() } else { format!("{limb:09}") };
            out.extend(text.bytes().map(|byte| byte - b'0'));
        }
        out
    }
}

fn exact_of_double(value: f64) -> Exact {
    if value.is_nan() {
        return Exact::NaN;
    }
    if value.is_infinite() {
        return Exact::Infinite(value < 0.0);
    }
    if value == 0.0 {
        return Exact::Finite(Decimal::new(false, Vec::new(), 0));
    }
    let bits = value.to_bits();
    let negative = bits >> 63 == 1;
    let exponent_bits = i64::try_from((bits >> 52) & 0x7ff).unwrap_or(0);
    let mut mantissa = bits & 0x000f_ffff_ffff_ffff;
    let exponent = if exponent_bits == 0 {
        -1074
    } else {
        mantissa |= 1 << 52;
        exponent_bits - 1075
    };
    let mut big = Big::from_u64(mantissa);
    if exponent >= 0 {
        for _ in 0..exponent {
            big.multiply(2);
        }
        Exact::Finite(Decimal::new(negative, big.digits(), 0))
    } else {
        for _ in 0..(-exponent) {
            big.multiply(5);
        }
        Exact::Finite(Decimal::new(negative, big.digits(), exponent))
    }
}

fn exact_of_long(value: i64) -> Exact {
    let digits = value.unsigned_abs().to_string().bytes().map(|byte| byte - b'0').collect();
    Exact::Finite(Decimal::new(value < 0, digits, 0))
}

fn exact_of_decimal(text: &str) -> Exact {
    match text.to_ascii_lowercase().as_str() {
        "nan" | "+nan" | "-nan" => return Exact::NaN,
        "inf" | "infinity" | "+inf" | "+infinity" => return Exact::Infinite(false),
        "-inf" | "-infinity" => return Exact::Infinite(true),
        _ => {}
    }
    let (negative, unsigned) = match text.as_bytes().first() {
        Some(b'-') => (true, &text[1..]),
        Some(b'+') => (false, &text[1..]),
        _ => (false, text),
    };
    let (mantissa, written) = match unsigned.find(['e', 'E']) {
        Some(index) => (&unsigned[..index], Some(&unsigned[index + 1..])),
        None => (unsigned, None),
    };
    let (whole, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let digits_only = |part: &str| part.bytes().all(|byte| byte.is_ascii_digit());
    if !digits_only(whole) || !digits_only(fraction) {
        return Exact::NaN;
    }
    let written = match written {
        None => 0,
        Some(exponent) => {
            let unsigned = exponent.strip_prefix(['+', '-']).unwrap_or(exponent);
            if unsigned.is_empty() || !digits_only(unsigned) {
                return Exact::NaN;
            }
            exponent.parse::<i64>().unwrap_or(if exponent.starts_with('-') {
                i64::MIN / 2
            } else {
                i64::MAX / 2
            })
        }
    };
    let digits: Vec<u8> = whole.bytes().chain(fraction.bytes()).map(|byte| byte - b'0').collect();
    let exponent = written.saturating_sub(i64::try_from(fraction.len()).unwrap_or(0));
    Exact::Finite(Decimal::new(negative, digits, exponent))
}

fn exact_of(value: Numeric<'_>) -> Exact {
    match value {
        Numeric::Int(n) => exact_of_long(i64::from(n)),
        Numeric::Double(n) => exact_of_double(n),
        Numeric::Long(n) => exact_of_long(n),
        Numeric::Decimal(text) => exact_of_decimal(text),
    }
}

fn compare_doubles(x: f64, y: f64) -> Ordering {
    match (x.is_nan(), y.is_nan()) {
        (true, true) => Ordering::Equal,
        (true, false) => Ordering::Less,
        (false, true) => Ordering::Greater,
        (false, false) => x.partial_cmp(&y).unwrap_or(Ordering::Equal),
    }
}

fn compare_long_double(long: i64, double: f64) -> Ordering {
    const TWO_POW_63: f64 = 9_223_372_036_854_775_808.0;
    if double.is_nan() {
        return Ordering::Greater;
    }
    if double >= TWO_POW_63 {
        return Ordering::Less;
    }
    if double < -TWO_POW_63 {
        return Ordering::Greater;
    }
    #[allow(clippy::cast_possible_truncation)]
    let whole = double.trunc() as i64;
    long.cmp(&whole).then_with(|| 0.0f64.partial_cmp(&double.fract()).unwrap_or(Ordering::Equal))
}

/// Compares two numbers by exact value, the way MongoDB does across int, long, double and decimal. NaN equals
/// NaN and sorts before every other number; negative zero equals zero.
pub fn compare_numeric(a: Numeric<'_>, b: Numeric<'_>) -> Ordering {
    use Numeric::{Decimal, Double, Int, Long};
    match (a, b) {
        (Int(x), Int(y)) => x.cmp(&y),
        (Int(x), Double(y)) => compare_doubles(f64::from(x), y),
        (Double(x), Int(y)) => compare_doubles(x, f64::from(y)),
        (Double(x), Double(y)) => compare_doubles(x, y),
        (Long(x), Long(y)) => x.cmp(&y),
        (Long(x), Int(y)) => x.cmp(&i64::from(y)),
        (Int(x), Long(y)) => i64::from(x).cmp(&y),
        (Long(x), Double(y)) => compare_long_double(x, y),
        (Double(x), Long(y)) => compare_long_double(y, x).reverse(),
        (Decimal(_), _) | (_, Decimal(_)) => match (exact_of(a), exact_of(b)) {
            (Exact::NaN, Exact::NaN) => Ordering::Equal,
            (Exact::NaN, _) => Ordering::Less,
            (_, Exact::NaN) => Ordering::Greater,
            (Exact::Infinite(x), Exact::Infinite(y)) => y.cmp(&x),
            (Exact::Infinite(negative), _) => {
                if negative {
                    Ordering::Less
                } else {
                    Ordering::Greater
                }
            }
            (_, Exact::Infinite(negative)) => {
                if negative {
                    Ordering::Greater
                } else {
                    Ordering::Less
                }
            }
            (Exact::Finite(x), Exact::Finite(y)) => x.compare(&y),
        },
    }
}

/// Returns true when the number is NaN in any representation.
pub fn is_nan(value: Numeric<'_>) -> bool {
    match value {
        Numeric::Double(n) => n.is_nan(),
        Numeric::Decimal(text) => exact_of_decimal(text) == Exact::NaN,
        Numeric::Int(_) | Numeric::Long(_) => false,
    }
}

/// Converts a number to a double, as MongoDB does for `$mod` and `$size` operands. Decimal values are parsed
/// as JavaScript's `Number` would, which rounds to the nearest double.
pub fn to_double(value: Numeric<'_>) -> f64 {
    match value {
        Numeric::Int(n) => f64::from(n),
        Numeric::Double(n) => n,
        #[allow(clippy::cast_precision_loss)]
        Numeric::Long(n) => n as f64,
        Numeric::Decimal(text) => js_string_to_number(text).unwrap_or(f64::NAN),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use Numeric::{Decimal, Double, Int, Long};

    #[test]
    fn compares_across_representations_by_exact_value() {
        assert_eq!(compare_numeric(Int(1), Double(1.0)), Ordering::Equal);
        assert_eq!(
            compare_numeric(Long(9_007_199_254_740_993), Double(9_007_199_254_740_992.0)),
            Ordering::Greater
        );
        assert_eq!(compare_numeric(Double(0.1), Decimal("0.1")), Ordering::Greater);
        assert_eq!(compare_numeric(Decimal("0.10"), Decimal("1E-1")), Ordering::Equal);
        assert_eq!(compare_numeric(Long(i64::MAX), Double(9_223_372_036_854_775_808.0)), Ordering::Less);
        assert_eq!(compare_numeric(Long(-3), Double(-2.5)), Ordering::Less);
        assert_eq!(compare_numeric(Long(-2), Double(-2.5)), Ordering::Greater);
        assert_eq!(compare_numeric(Double(-0.0), Int(0)), Ordering::Equal);
        assert_eq!(compare_numeric(Decimal("-0"), Double(0.0)), Ordering::Equal);
        assert_eq!(compare_numeric(Decimal("1E+6111"), Double(f64::MAX)), Ordering::Greater);
        assert_eq!(compare_numeric(Decimal("5E-324"), Double(5e-324)), Ordering::Greater);
        assert_eq!(compare_numeric(Decimal("-1"), Decimal("-2")), Ordering::Greater);
    }

    #[test]
    fn nan_equals_nan_and_sorts_first() {
        assert_eq!(compare_numeric(Double(f64::NAN), Decimal("NaN")), Ordering::Equal);
        assert_eq!(compare_numeric(Double(f64::NAN), Double(f64::NEG_INFINITY)), Ordering::Less);
        assert_eq!(compare_numeric(Long(i64::MIN), Double(f64::NAN)), Ordering::Greater);
        assert_eq!(compare_numeric(Decimal("-Infinity"), Long(i64::MIN)), Ordering::Less);
        assert!(is_nan(Decimal("nan")));
        assert!(!is_nan(Decimal("1")));
    }

    #[test]
    fn decimals_convert_to_doubles_like_javascript() {
        assert_eq!(to_double(Decimal("1.5E+3")), 1500.0);
        assert!(to_double(Decimal("inf")).is_nan());
        assert_eq!(to_double(Decimal("-Infinity")), f64::NEG_INFINITY);
    }
}
