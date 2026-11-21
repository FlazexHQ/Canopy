//! A regular expression, its options and a subject. Compiling and matching never panic, and for a pattern
//! without whitespace or `#` the `x` option changes nothing, which compares the literal fast paths with the
//! Pike VM on the same pattern.
//!
//! Input: one byte selecting the options `i`, `m` and `s`, then the pattern and the subject separated by the
//! first NUL.

#![no_main]

use canopy_matcher::compile_regex;
use libfuzzer_sys::fuzz_target;

const OPTIONS: [(char, u8); 3] = [('i', 1), ('m', 2), ('s', 4)];

fuzz_target!(|data: &[u8]| {
    let Some((&flags, rest)) = data.split_first() else { return };
    let Ok(text) = std::str::from_utf8(rest) else { return };
    let (pattern, subject) = text.split_once('\0').unwrap_or((text, ""));
    let options: String = OPTIONS.iter().filter(|(_, bit)| flags & bit != 0).map(|(name, _)| *name).collect();
    let Ok(regex) = compile_regex(pattern, &options) else { return };
    let result = regex.test(subject);
    if pattern.chars().any(|c| c.is_whitespace() || c == '#') {
        return;
    }
    let extended = compile_regex(pattern, &format!("{options}x"))
        .unwrap_or_else(|error| panic!("the x option refuses /{pattern}/{options}: {error:?}"));
    let other = extended.test(subject);
    match (&result, &other) {
        (Ok(a), Ok(b)) => assert_eq!(a, b, "/{pattern}/{options} and /{pattern}/{options}x disagree"),
        (Err(_), Err(_)) => {}
        _ => panic!("/{pattern}/{options} and its x form fail differently: {result:?} against {other:?}"),
    }
});
