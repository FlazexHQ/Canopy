use base64ct::{Base64Bcrypt, Encoding};
use subtle::ConstantTimeEq;
use zeroize::Zeroizing;

use super::{decimal, fields};

pub(super) fn verify(password: &[u8], encoded: &str) -> Option<()> {
    let [version, cost, body] = fields(encoded.strip_prefix('$')?, '$')?;
    if !matches!(version, "2a" | "2b" | "2x" | "2y")
        || cost.len() != 2
        || body.len() != 53
        || !body.is_ascii()
        || !(1..=72).contains(&password.len())
    {
        return None;
    }
    let cost = decimal(cost)?;
    if !(4..=16).contains(&cost) {
        return None;
    }
    let (salt_text, tag) = body.split_at_checked(22)?;
    let mut salt = [0; 16];
    if Base64Bcrypt::decode(salt_text, &mut salt).ok()?.len() != salt.len() {
        return None;
    }
    let mut expected = [0; 23];
    if Base64Bcrypt::decode(tag, &mut expected).ok()?.len() != expected.len() {
        return None;
    }
    let mut key = Zeroizing::new(Vec::from(password.split(|byte| *byte == 0).next()?));
    if key.len() < 72 {
        key.push(0);
    }
    let actual = if version == "2x" {
        bcrypt::bcrypt(cost, salt, &*signed_key(&key))
    } else {
        bcrypt::bcrypt(cost, salt, &key)
    };
    bool::from(actual.get(..23)?.ct_eq(&expected[..])).then_some(())
}

fn signed_key(key: &[u8]) -> Zeroizing<[u8; 72]> {
    let mut expanded = Zeroizing::new([0; 72]);
    let mut bytes = key.iter().copied().cycle();
    // The 2x subtype sign extends bytes while packing the 18 Blowfish P words.
    // The 2a collision safeguard only applies to input containing 0xff, which UTF-8 excludes.
    for word in expanded.as_chunks_mut::<4>().0 {
        let mut signed = 0_u32;
        for byte in bytes.by_ref().take(4) {
            signed = (signed << 8) | (byte as i8 as i32 as u32);
        }
        word.copy_from_slice(&signed.to_be_bytes());
    }
    expanded
}

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used)]

    use base64ct::{Base64Bcrypt, Encoding};

    use super::verify;

    fn stored(version: &str, password: &[u8], salt: [u8; 16]) -> String {
        let mut key = password.to_vec();
        key.push(0);
        let hash = bcrypt::bcrypt(4, salt, &key);
        let (mut salt_text, mut hash_text) = ([0; 22], [0; 31]);
        let salt_text = Base64Bcrypt::encode(&salt, &mut salt_text).expect("encoded salt");
        let hash_text = Base64Bcrypt::encode(&hash[..23], &mut hash_text).expect("encoded hash");
        format!("${version}$04${salt_text}{hash_text}")
    }

    #[test]
    fn verifies_a_hash_and_refuses_another_password_or_a_noncanonical_encoding() {
        let encoded = stored("2b", b"correct horse", *b"sixteen byte slt");
        assert_eq!(verify(b"correct horse", &encoded), Some(()));
        assert_eq!(verify(b"correct horsf", &encoded), None);
        let (head, body) = encoded.split_at(7);
        let (salt, hash) = body.split_at(22);
        let alphabet = b"./ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
        // Sets the lowest bit of the last character: a bit past the encoded bytes, which a lenient decoder
        // would ignore and decode to the same salt or hash.
        let bump = |text: &str| {
            let (rest, last) = text.split_at(text.len() - 1);
            let index = alphabet.iter().position(|byte| last.as_bytes() == [*byte]).expect("bcrypt digit");
            assert_eq!(index % 2, 0, "a canonical last digit leaves its lowest bit clear");
            format!("{rest}{}", char::from(alphabet[index ^ 1]))
        };
        assert_eq!(verify(b"correct horse", &format!("{head}{}{hash}", bump(salt))), None);
        assert_eq!(verify(b"correct horse", &format!("{head}{salt}{}", bump(hash))), None);
    }
}
