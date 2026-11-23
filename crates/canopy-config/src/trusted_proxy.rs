use std::net::{IpAddr, Ipv4Addr};

/// An IP address or CIDR range trusted to supply forwarded client addresses.
#[derive(Clone, Copy, Debug)]
pub struct TrustedProxy {
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

impl TrustedProxy {
    /// Parses an IP address or CIDR range. Invalid rules are ignored.
    pub fn parse(text: &str) -> Option<Self> {
        let (ip, suffix) = text.split_once('/').map_or((text, None), |(ip, bits)| (ip, Some(bits)));
        let (value, width) = address(ip)?;
        let bits = match suffix {
            Some(bits) => decimal(bits)?,
            None => width,
        };
        (bits <= width).then_some(Self { value, width, bits })
    }

    /// Checks whether an address belongs to any of the trusted proxy rules.
    pub fn matches_any(rules: &[Self], text: &str) -> bool {
        let Some((value, width)) = address(text) else { return false };
        rules.iter().any(|rule| {
            rule.width == width
                && (rule.bits == 0 || value >> (width - rule.bits) == rule.value >> (width - rule.bits))
        })
    }
}
