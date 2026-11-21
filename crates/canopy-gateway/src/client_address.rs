use std::net::{IpAddr, Ipv4Addr};

use hyper::HeaderMap;

#[derive(Clone, Copy, Debug)]
pub(crate) struct Rule {
    value: u128,
    width: u8,
    bits: u8,
}

fn ipv4(text: &str) -> Option<Ipv4Addr> {
    let mut octets = [0; 4];
    let mut parts = text.split('.');
    for octet in &mut octets {
        *octet = decimal(parts.next()?)?;
    }
    parts.next().is_none().then_some(octets.into())
}

fn decimal(text: &str) -> Option<u8> {
    if text.len() > 3 || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

fn address(text: &str) -> Option<(u128, u8)> {
    let text = text.trim();
    let text = text.strip_prefix('[').unwrap_or(text);
    let text = text.strip_suffix(']').unwrap_or(text);
    let text = text.split('%').next()?;
    if let Some(ip) = ipv4(text) {
        return Some((u128::from(u32::from(ip)), 32));
    }
    let embedded;
    let text = if let Some((head, tail)) = text.rsplit_once(':')
        && tail.contains('.')
    {
        embedded = format!("{head}:{}", ipv4(tail)?);
        &embedded
    } else {
        text
    };
    match text.parse::<IpAddr>().ok()?.to_canonical() {
        IpAddr::V4(ip) => Some((u128::from(u32::from(ip)), 32)),
        IpAddr::V6(ip) => Some((u128::from(ip), 128)),
    }
}

impl Rule {
    pub(crate) fn parse(text: &str) -> Option<Self> {
        let (ip, suffix) = text.split_once('/').map_or((text, None), |(ip, bits)| (ip, Some(bits)));
        let (value, width) = address(ip)?;
        let bits = match suffix {
            Some(bits) => decimal(bits)?,
            None => width,
        };
        (bits <= width).then_some(Self { value, width, bits })
    }
}

fn trusted(text: &str, rules: &[Rule]) -> bool {
    let Some((value, width)) = address(text) else { return false };
    rules.iter().any(|rule| {
        rule.width == width
            && (rule.bits == 0 || value >> (width - rule.bits) == rule.value >> (width - rule.bits))
    })
}

fn normalize(text: &str) -> &str {
    let text = text.trim();
    if text.get(..7).is_some_and(|prefix| prefix.eq_ignore_ascii_case("::ffff:")) && text.contains('.') {
        return &text[7..];
    }
    text
}

/// Resolves the rightmost untrusted hop only when the socket peer is trusted.
pub(crate) fn resolve<'a>(headers: &'a HeaderMap, peer: &'a str, rules: &[Rule]) -> &'a str {
    let socket = normalize(peer);
    if socket.is_empty() {
        return "unknown";
    }
    if !trusted(socket, rules) {
        return socket;
    }
    headers
        .get_all("x-forwarded-for")
        .iter()
        .rev()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.rsplit(','))
        .map(normalize)
        .find(|hop| !hop.is_empty() && !trusted(hop, rules))
        .unwrap_or(socket)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rules(values: &[&str]) -> Vec<Rule> {
        values.iter().filter_map(|value| Rule::parse(value)).collect()
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
        assert!(trusted("0:0:0:0:0:0:0:1", &rules(&["::1"])));
        assert!(trusted("::ffff:10.1.2.3", &rules(&["10.0.0.0/8"])));
        assert!(trusted("10.1.2.3", &rules(&["::ffff:10.1.2.3"])));
        assert!(!trusted("127.0.0.1", &rules(&["::1"])));
        assert!(!trusted("not an address", &rules(&["0.0.0.0/0", "::/0"])));
        assert!(trusted("1.2.3.4", &rules(&["garbage", "1.2.3.0/24"])));
        assert!(Rule::parse("10.0.0.0/8").is_some());
        assert!(Rule::parse("2001:db8::/32").is_some());
        assert!(Rule::parse("10.0.0.0/33").is_none());
        assert!(Rule::parse("example.com").is_none());
    }
}
