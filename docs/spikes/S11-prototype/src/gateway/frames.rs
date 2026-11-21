pub type Body = std::sync::Arc<str>;
use canopy_protocol::json::write_json_string;
use canopy_protocol::{CanopyError, Value, ValueRef};

/// The `ct` of a cluster time: `(seconds << 32) | increment` in decimal.
pub fn cluster_time(t: u32, i: u32) -> String {
    ((u64::from(t) << 32) | u64::from(i)).to_string()
}

/// A value as relaxed EJSON text, the `canopy.v1` wire form.
pub fn relaxed(value: &Value) -> Result<String, CanopyError> {
    canopy_protocol::ejson::stringify(value)
}

/// A raw value as relaxed EJSON text.
pub fn relaxed_ref(value: ValueRef<'_>) -> Result<String, CanopyError> {
    relaxed(&value.to_value())
}

/// A frame without its sequence number. Every frame ends with `"seq":<n>}`, which the connection writes, so
/// one encoded body serves every connection that receives it.
pub fn body(text: String) -> Body {
    Body::from(text)
}

/// The body of a `changed` frame carrying `set`, shared by every receiving connection.
pub fn changed(id: &str, ct: &str, set: &str) -> Body {
    let mut out = String::with_capacity(64 + id.len() + set.len());
    out.push_str(r#"{"t":"changed","c":"items","id":"#);
    out.push_str(id);
    out.push_str(r#","ct":""#);
    out.push_str(ct);
    out.push_str(r#"","set":"#);
    out.push_str(set);
    out.push_str(r#","seq":"#);
    body(out)
}

/// The body of a `changed` frame that replaces the whole document.
pub fn replaced(id: &str, ct: &str, document: &str) -> Body {
    let mut out = String::with_capacity(64 + id.len() + document.len());
    out.push_str(r#"{"t":"changed","c":"items","id":"#);
    out.push_str(id);
    out.push_str(r#","ct":""#);
    out.push_str(ct);
    out.push_str(r#"","d":"#);
    out.push_str(document);
    out.push_str(r#","replace":true,"seq":"#);
    body(out)
}

fn subs(out: &mut String, subs: &[std::sync::Arc<str>]) {
    out.push('[');
    for (index, sub) in subs.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        write_json_string(out, sub);
    }
    out.push(']');
}

/// The body of an `added` frame for the subscriptions `s` of one connection.
pub fn added(id: &str, ct: &str, document: &str, s: &[std::sync::Arc<str>]) -> Body {
    let mut out = String::with_capacity(64 + id.len() + document.len());
    out.push_str(r#"{"t":"added","c":"items","id":"#);
    out.push_str(id);
    out.push_str(r#","d":"#);
    out.push_str(document);
    out.push_str(r#","ct":""#);
    out.push_str(ct);
    out.push_str(r#"","s":"#);
    subs(&mut out, s);
    out.push_str(r#","seq":"#);
    body(out)
}

/// The body of a `removed` frame for the subscriptions `s` of one connection.
pub fn removed(id: &str, ct: &str, s: &[std::sync::Arc<str>]) -> Body {
    let mut out = String::with_capacity(64 + id.len());
    out.push_str(r#"{"t":"removed","c":"items","id":"#);
    out.push_str(id);
    out.push_str(r#","ct":""#);
    out.push_str(ct);
    out.push_str(r#"","s":"#);
    subs(&mut out, s);
    out.push_str(r#","seq":"#);
    body(out)
}

/// The body of a `ready` frame.
pub fn ready(sub: &str, ct: &str) -> Body {
    let mut out = String::from(r#"{"t":"ready","s":"#);
    write_json_string(&mut out, sub);
    out.push_str(r#","ct":""#);
    out.push_str(ct);
    out.push_str(r#"","seq":"#);
    body(out)
}

/// The body of a `nosub` frame.
pub fn nosub(sub: &str, code: &str, message: &str) -> Body {
    let mut out = String::from(r#"{"t":"nosub","s":"#);
    write_json_string(&mut out, sub);
    out.push_str(r#","err":{"code":"#);
    write_json_string(&mut out, code);
    out.push_str(r#","msg":"#);
    write_json_string(&mut out, message);
    out.push_str(r#"},"seq":"#);
    body(out)
}

/// The body of a `resync` frame for every subscription.
pub fn resync(reason: &str) -> Body {
    let mut out = String::from(r#"{"t":"resync","reason":"#);
    write_json_string(&mut out, reason);
    out.push_str(r#","seq":"#);
    body(out)
}

/// The complete `welcome` frame, always `seq` 0.
pub fn welcome(sid: &str, pv: &str) -> String {
    let mut out = String::from(r#"{"t":"welcome","seq":0,"sid":"#);
    write_json_string(&mut out, sid);
    out.push_str(r#","v":1,"resumed":false,"hb":25000,"pv":"#);
    write_json_string(&mut out, pv);
    out.push_str(r#","ct":"0","caps":["diff"],"limits":{"subs":100}}"#);
    out
}
