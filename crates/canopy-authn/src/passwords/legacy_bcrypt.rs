use base64::{
    Engine, alphabet,
    engine::general_purpose::{GeneralPurpose, NO_PAD},
};
use subtle::ConstantTimeEq;
use zeroize::Zeroizing;

use super::{decimal, fields};

const BCRYPT_BASE64: GeneralPurpose = GeneralPurpose::new(&alphabet::BCRYPT, NO_PAD);

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
    let (salt, tag) = body.split_at_checked(22)?;
    let salt = BCRYPT_BASE64.decode(salt).ok()?.try_into().ok()?;
    let expected = BCRYPT_BASE64.decode(tag).ok()?;
    let mut key = Zeroizing::new(Vec::from(password.split(|byte| *byte == 0).next()?));
    if key.len() < 72 {
        key.push(0);
    }
    let actual = if version == "2x" {
        bcrypt::bcrypt(cost, salt, &*signed_key(&key))
    } else {
        bcrypt::bcrypt(cost, salt, &key)
    };
    bool::from(actual.get(..23)?.ct_eq(&expected)).then_some(())
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
