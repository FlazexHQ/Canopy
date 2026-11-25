#![no_main]

use canopy_authn::passwords::verify_password;
use libfuzzer_sys::fuzz_target;

fn costly(value: &str, budget: u32, library_max: u32) -> bool {
    value.parse::<u32>().is_ok_and(|cost| (budget + 1..=library_max).contains(&cost))
}

fn expensive(stored: &str) -> bool {
    let (algorithm, encoded) = stored
        .strip_prefix("canopy-legacy$")
        .and_then(|legacy| legacy.split_once('$'))
        .unwrap_or(("", stored));
    match algorithm {
        "" | "argon2id" => {
            let Some(params) = encoded.strip_prefix("$argon2id$v=19$").and_then(|s| s.split('$').next())
            else {
                return false;
            };
            params.split(',').filter_map(|param| param.split_once('=')).any(|(key, value)| match key {
                "m" => costly(value, 128, 262_144),
                "t" => costly(value, 2, 32),
                "p" => costly(value, 2, 16),
                _ => false,
            })
        }
        "bcrypt" => encoded.split('$').nth(2).is_some_and(|cost| costly(cost, 5, 16)),
        "pbkdf2-sha1" | "pbkdf2-sha256" | "pbkdf2-sha512" => {
            encoded.split('$').next().is_some_and(|cost| costly(cost, 32, 10_000_000))
        }
        "firebase-scrypt" => {
            let mut fields = encoded.split('$').skip(2);
            fields.next().is_some_and(|rounds| costly(rounds, 2, 16))
                || fields.next().is_some_and(|memory| costly(memory, 5, 16))
        }
        _ => false,
    }
}

fuzz_target!(|data: &[u8]| {
    let input = String::from_utf8_lossy(data.get(..data.len().min(1024)).unwrap_or_default());
    let (stored, password) = input.split_once('\0').unwrap_or((&input, "fuzz password"));
    if !expensive(stored) {
        let _ = verify_password(password, stored);
    }
});
