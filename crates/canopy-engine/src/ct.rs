use std::fmt;

/// A MongoDB cluster time, `(seconds << 32) | increment`. It orders events, but it is not unique per event:
/// a transaction and, since MongoDB 8.0, unrelated writes can share one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub struct Ct(pub u64);

impl Ct {
    /// The zero time, before any event.
    pub const ZERO: Ct = Ct(0);

    /// The cluster time of a BSON timestamp.
    pub const fn from_parts(seconds: u32, increment: u32) -> Ct {
        Ct(((seconds as u64) << 32) | increment as u64)
    }

    /// The seconds part.
    pub const fn seconds(self) -> u32 {
        (self.0 >> 32) as u32
    }

    /// The increment part.
    pub const fn increment(self) -> u32 {
        (self.0 & 0xffff_ffff) as u32
    }

    /// Parses the decimal wire form (`ct`).
    pub fn parse(text: &str) -> Option<Ct> {
        if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        text.parse::<u64>().ok().map(Ct)
    }
}

impl fmt::Display for Ct {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::Ct;

    #[test]
    fn packs_seconds_and_increment_like_the_wire_form() {
        let ct = Ct::from_parts(1_700_000_000, 7);
        assert_eq!(ct.to_string(), "7301444403200000007");
        assert_eq!(ct.seconds(), 1_700_000_000);
        assert_eq!(ct.increment(), 7);
        assert_eq!(Ct::parse("7301444403200000007"), Some(ct));
    }

    #[test]
    fn refuses_text_that_is_not_a_decimal_u64() {
        assert_eq!(Ct::parse(""), None);
        assert_eq!(Ct::parse("-1"), None);
        assert_eq!(Ct::parse("1e3"), None);
        assert_eq!(Ct::parse("18446744073709551616"), None);
    }

    #[test]
    fn orders_by_seconds_then_increment() {
        assert!(Ct::from_parts(1, 9) < Ct::from_parts(2, 0));
        assert!(Ct::from_parts(2, 1) > Ct::from_parts(2, 0));
    }
}
