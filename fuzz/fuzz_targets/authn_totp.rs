#![no_main]

use canopy_authn::totp::{Algorithm, TotpOptions, base32_decode, base32_encode, totp, verify_totp};
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let input = String::from_utf8_lossy(data);
    let (encoded, code) = input.split_once('\0').unwrap_or(("JBSWY3DPEHPK3PXP", &input));
    let decoded = base32_decode(encoded);
    if let Some(secret) = &decoded {
        assert_eq!(base32_decode(&base32_encode(secret)).as_ref(), Some(secret));
    }
    let secret = decoded.as_deref().unwrap_or(data);
    let selector = data.first().copied().unwrap_or_default();
    let algorithm = match selector % 3 {
        0 => Algorithm::Sha1,
        1 => Algorithm::Sha256,
        _ => Algorithm::Sha512,
    };
    let digits = u32::from(selector % 9) + 1;
    let options = TotpOptions { digits, algorithm, ..TotpOptions::default() };
    let _ = verify_totp(secret, code, 60_000, options, 1, None);
    let current = totp(secret, 60_000, options);
    assert_eq!(verify_totp(secret, &current, 60_000, options, 0, None), Some(2));
    assert_eq!(verify_totp(secret, &current, 60_000, options, 0, Some(2)), None);
});
