use canopy_config::TrustedProxy;
use hyper::HeaderMap;

fn normalize(text: &str) -> &str {
    let text = text.trim();
    if text.get(..7).is_some_and(|prefix| prefix.eq_ignore_ascii_case("::ffff:")) && text.contains('.') {
        return &text[7..];
    }
    text
}

/// Resolves the rightmost untrusted hop only when the socket peer is trusted.
pub(crate) fn resolve<'a>(headers: &'a HeaderMap, peer: &'a str, rules: &[TrustedProxy]) -> &'a str {
    let socket = normalize(peer);
    if socket.is_empty() {
        return "unknown";
    }
    if !TrustedProxy::matches_any(rules, socket) {
        return socket;
    }
    headers
        .get_all("x-forwarded-for")
        .iter()
        .rev()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.rsplit(','))
        .map(normalize)
        .find(|hop| !hop.is_empty() && !TrustedProxy::matches_any(rules, hop))
        .unwrap_or(socket)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rules(values: &[&str]) -> Vec<TrustedProxy> {
        values.iter().filter_map(|value| TrustedProxy::parse(value)).collect()
    }

    #[test]
    fn resolves_the_same_forwarded_chains_as_typescript() {
        for (forwarded, peer, rule, expected) in [
            ("1.2.3.4", "203.0.113.9", "127.0.0.1", "203.0.113.9"),
            ("", "", "", "unknown"),
            ("6.6.6.6, 1.2.3.4, 10.0.0.2", "10.0.0.1", "10.0.0.0/8", "1.2.3.4"),
            ("1.2.3.4", "::ffff:127.0.0.1", "127.0.0.1", "1.2.3.4"),
            ("", "127.0.0.1", "127.0.0.1", "127.0.0.1"),
            ("10.0.0.5", "10.0.0.1", "10.0.0.0/8", "10.0.0.1"),
            ("127.0.0.1, 10.0.0.9", "198.51.100.4", "10.0.0.0/8", "198.51.100.4"),
            ("", "10.0.0.1", "10.0.0.0/8", "10.0.0.1"),
            ("2001:db8::7", "::1", "::1", "2001:db8::7"),
            ("203.0.113.5", "fd00::2", "fd00::/8", "203.0.113.5"),
            ("203.0.113.5", "fe00::2", "fd00::/8", "fe00::2"),
            ("1.1.1.1", "192.168.1.255", "192.168.1.0/24", "1.1.1.1"),
            ("1.1.1.1", "192.168.2.0", "192.168.1.0/24", "192.168.2.0"),
            ("1.1.1.1", "192.168.2.0", "192.168.1.0/33", "192.168.2.0"),
        ] {
            let mut headers = HeaderMap::new();
            if !forwarded.is_empty() {
                headers.insert("x-forwarded-for", hyper::header::HeaderValue::from_static(forwarded));
            }
            assert_eq!(resolve(&headers, peer, &rules(&[rule])), expected);
        }
    }

    #[test]
    fn compares_ip_values_and_validates_rules() {
        assert!(TrustedProxy::matches_any(&rules(&["::1"]), "0:0:0:0:0:0:0:1"));
        assert!(TrustedProxy::matches_any(&rules(&["10.0.0.0/8"]), "::ffff:10.1.2.3"));
        assert!(TrustedProxy::matches_any(&rules(&["::ffff:10.1.2.3"]), "10.1.2.3"));
        assert!(!TrustedProxy::matches_any(&rules(&["::1"]), "127.0.0.1"));
        assert!(!TrustedProxy::matches_any(&rules(&["0.0.0.0/0", "::/0"]), "not an address"));
        assert!(TrustedProxy::matches_any(&rules(&["garbage", "1.2.3.0/24"]), "1.2.3.4"));
        assert!(TrustedProxy::parse("10.0.0.0/8").is_some());
        assert!(TrustedProxy::parse("2001:db8::/32").is_some());
        assert!(TrustedProxy::parse("10.0.0.0/33").is_none());
        assert!(TrustedProxy::parse("example.com").is_none());
    }
}
