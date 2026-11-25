use std::collections::BTreeSet;

use canopy_policy::{
    CollectionPolicies, ContextDefinitions, PolicyDefinition, PolicyKind, StoredMeta, contexts_value,
    to_stored,
};
use canopy_protocol::ejson::iso_string;
use canopy_protocol::json::{Json, js_number_string, write_json};
use canopy_protocol::{Document, Value};

/// A value the TypeScript DSL cannot spell, such as an ObjectId inside a clause.
pub(crate) struct Unwritable;

impl Unwritable {
    pub(crate) fn message(&self) -> &'static str {
        "No TypeScript literal for [object Object]"
    }
}

fn quote(text: &str) -> String {
    let mut out = String::new();
    write_json(&mut out, &Json::String(text.to_owned()));
    out
}

fn identifier(key: &str) -> bool {
    let mut chars = key.chars();
    chars.next().is_some_and(|first| first.is_ascii_alphabetic() || first == '_' || first == '$')
        && chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '$')
}

fn only_keys(document: &Document, keys: &[&str]) -> bool {
    document.iter().all(|(key, _)| keys.contains(&key))
}

#[derive(Default)]
struct Writer {
    helpers: BTreeSet<&'static str>,
}

impl Writer {
    fn literal(&mut self, value: &Value) -> Result<String, Unwritable> {
        Ok(match value {
            Value::Null => "null".to_owned(),
            Value::String(text) => quote(text),
            Value::Bool(flag) => flag.to_string(),
            Value::Int32(number) => number.to_string(),
            Value::Double(number) if number.is_finite() && !(*number == 0.0 && number.is_sign_negative()) => {
                js_number_string(*number)
            }
            Value::DateTime(ms) => format!("new Date({})", quote(&iso_string(*ms))),
            Value::Array(items) => {
                let items = items.iter().map(|item| self.literal(item)).collect::<Result<Vec<_>, _>>()?;
                format!("[{}]", items.join(", "))
            }
            Value::Document(document) => {
                if let Some(variable) = self.variable(document) {
                    return Ok(variable);
                }
                let mut entries = Vec::new();
                for (key, item) in document.iter() {
                    let key = if identifier(key) { key.to_owned() } else { quote(key) };
                    entries.push(format!("{key}: {}", self.literal(item)?));
                }
                if entries.is_empty() { "{}".to_owned() } else { format!("{{ {} }}", entries.join(", ")) }
            }
            _ => return Err(Unwritable),
        })
    }

    fn variable(&mut self, document: &Document) -> Option<String> {
        if let Some(Value::String(path)) = document.get("$auth")
            && only_keys(document, &["$auth", "as"])
        {
            let kind = match document.get("as") {
                None => String::new(),
                Some(Value::String(kind)) => format!(", {}", quote(kind)),
                Some(_) => return None,
            };
            self.helpers.insert("auth");
            return Some(format!("auth({}{kind})", quote(path)));
        }
        if let Some(Value::String(name)) = document.get("$ctx")
            && only_keys(document, &["$ctx"])
        {
            self.helpers.insert("ctx");
            return Some(format!("ctx({})", quote(name)));
        }
        if let Some(Value::Document(now)) = document.get("$now")
            && only_keys(document, &["$now"])
            && only_keys(now, &["offset"])
        {
            let offset = match now.get("offset") {
                None => String::new(),
                Some(Value::String(offset)) => quote(offset),
                Some(_) => return None,
            };
            self.helpers.insert("now");
            return Some(format!("now({offset})"));
        }
        None
    }

    fn policy(&mut self, policy: &PolicyDefinition) -> Result<String, Unwritable> {
        let builder = if policy.kind == PolicyKind::Permissive { "allow" } else { "restrict" };
        self.helpers.insert(builder);
        let roles: Vec<String> = policy.roles.iter().map(|role| quote(role)).collect();
        let start = match policy.ops.as_slice() {
            [single] => format!("{builder}.{}({})", single.as_str(), roles.join(", ")),
            ops => {
                let ops = Value::Array(ops.iter().map(|op| Value::String(op.as_str().to_owned())).collect());
                let mut arguments = vec![self.literal(&ops)?];
                arguments.extend(roles);
                format!("{builder}.ops({})", arguments.join(", "))
            }
        };
        let mut lines = vec![format!("    {start}")];
        if let Some(using) = &policy.using {
            lines.push(format!("      .where({})", self.literal(&Value::Document(using.clone()))?));
        }
        if let Some(check) = &policy.check {
            lines.push(format!("      .check({})", self.literal(&Value::Document(check.clone()))?));
        }
        lines.push(format!("      .named({}),", quote(&policy.name)));
        Ok(lines.join("\n"))
    }

    fn module(&self, body: &str) -> String {
        let names: Vec<&str> = self.helpers.iter().copied().collect();
        format!("import {{ {} }} from \"canopy.js/policy\"\n\n{body}", names.join(", "))
    }
}

/// Writes the policies of a collection as a TypeScript module in the policy DSL, the form `canopy init`
/// and hand written files use. Loading the module gives back a definition with the same hash.
pub(crate) fn collection_module(definition: &CollectionPolicies) -> Result<String, Unwritable> {
    let mut writer = Writer::default();
    writer.helpers.insert("collection");
    let mut options =
        vec![format!("  exposed: {},", definition.exposed), format!("  realtime: {},", definition.realtime)];
    if definition.policies.is_empty() {
        options.push("  policies: [],".to_owned());
    } else {
        let policies =
            definition.policies.iter().map(|policy| writer.policy(policy)).collect::<Result<Vec<_>, _>>()?;
        options.push(format!("  policies: [\n{}\n  ],", policies.join("\n")));
    }
    let stored = to_stored(definition, &StoredMeta { version: 0, updated_at: None, updated_by: None })
        .map_err(|_| Unwritable)?
        .to_document();
    for key in ["fields", "immutable"] {
        if let Some(value) = stored.get(key) {
            options.push(format!("  {key}: {},", writer.literal(value)?));
        }
    }
    Ok(writer.module(&format!(
        "export default collection({}, {{\n{}\n}})\n",
        quote(&definition.collection),
        options.join("\n")
    )))
}

/// Writes context lookup declarations as the `_context.ts` module of a policy directory.
pub(crate) fn context_module(contexts: &ContextDefinitions) -> Result<String, Unwritable> {
    let mut writer = Writer::default();
    writer.helpers.insert("context");
    let Value::Document(lookups) = contexts_value(contexts) else { return Err(Unwritable) };
    let mut entries = Vec::new();
    for (name, lookup) in lookups.iter() {
        let key = if identifier(name) { name.to_owned() } else { quote(name) };
        entries.push(format!("  {key}: {},", writer.literal(lookup)?));
    }
    Ok(writer.module(&format!("export default context({{\n{}\n}})\n", entries.join("\n"))))
}
