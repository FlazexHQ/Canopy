use canopy_protocol::ejson::iso_string;
use canopy_protocol::json::{Json, js_number_string, write_json};

use super::spec::{Fields, Kind, SECRET_PATHS, Spec, auth_kind, claims_fields, policies_fields};
use super::{EnvReference, Problem, ResolveOptions, Source};

pub(crate) type Object = Vec<(String, Json)>;

/// Reads a key of an object.
pub(crate) fn field<'a>(object: &'a [(String, Json)], key: &str) -> Option<&'a Json> {
    object.iter().find(|(name, _)| name == key).map(|(_, value)| value)
}

/// Sets a key of an object, keeping its position when it exists.
pub(crate) fn set_own(object: &mut Object, key: &str, value: Json) {
    match object.iter_mut().find(|(name, _)| name == key) {
        Some((_, slot)) => *slot = value,
        None => object.push((key.to_owned(), value)),
    }
}

/// Reads a dotted path of a resolved tree.
pub(crate) fn get<'a>(tree: &'a [(String, Json)], path: &str) -> Option<&'a Json> {
    let mut keys = path.split('.');
    let mut value = field(tree, keys.next()?)?;
    for key in keys {
        let Json::Object(object) = value else { return None };
        value = field(object, key)?;
    }
    Some(value)
}

pub(crate) fn get_str<'a>(tree: &'a [(String, Json)], path: &str) -> Option<&'a str> {
    match get(tree, path) {
        Some(Json::String(text)) => Some(text),
        _ => None,
    }
}

pub(crate) fn get_number(tree: &[(String, Json)], path: &str) -> Option<f64> {
    match get(tree, path) {
        Some(Json::Number(value)) => Some(*value),
        _ => None,
    }
}

/// The JSON text of a value, as `JSON.stringify` writes it.
pub(crate) fn stringify(value: &Json) -> String {
    let mut out = String::new();
    write_json(&mut out, value);
    out
}

pub(crate) fn quote(text: &str) -> String {
    stringify(&Json::String(text.to_owned()))
}

fn describe(value: &Json) -> String {
    match value {
        Json::Null => "null".to_owned(),
        Json::Array(_) => "a list".to_owned(),
        Json::String(text) => quote(text),
        Json::Object(_) => "an object".to_owned(),
        Json::Number(number) => js_number_string(*number),
        Json::Bool(flag) => flag.to_string(),
    }
}

fn distance(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().flat_map(char::to_lowercase).collect();
    let b: Vec<char> = b.chars().flat_map(char::to_lowercase).collect();
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for (i, left) in a.iter().enumerate() {
        let mut previous = row.first().copied().unwrap_or(0);
        if let Some(first) = row.first_mut() {
            *first = i + 1;
        }
        for (j, right) in b.iter().enumerate() {
            let current = row.get(j + 1).copied().unwrap_or(0);
            let deletion = current + 1;
            let insertion = row.get(j).copied().unwrap_or(0) + 1;
            let substitution = previous + usize::from(left != right);
            if let Some(slot) = row.get_mut(j + 1) {
                *slot = deletion.min(insertion).min(substitution);
            }
            previous = current;
        }
    }
    row.last().copied().unwrap_or(0)
}

/// The closest candidate within a small edit distance, for "did you mean" hints.
pub(crate) fn suggest<'a>(input: &str, candidates: impl IntoIterator<Item = &'a str>) -> Option<&'a str> {
    let mut best = None;
    let mut best_distance = 2.max(input.encode_utf16().count() / 3) + 1;
    for candidate in candidates {
        let d = distance(input, candidate);
        if d < best_distance {
            best = Some(candidate);
            best_distance = d;
        }
    }
    best
}

/// Joins values as `"a", "b" or "c"` for messages.
pub(crate) fn quoted(values: &[&str]) -> String {
    let parts: Vec<String> = values.iter().map(|value| quote(value)).collect();
    match parts.split_last() {
        None => String::new(),
        Some((last, [])) => last.clone(),
        Some((last, rest)) => format!("{} or {last}", rest.join(", ")),
    }
}

/// Parses `500ms`, `30s`, `5m`, `24h` or `7d` into milliseconds; a bare number is milliseconds.
pub(crate) fn parse_duration(text: &str) -> Option<f64> {
    let trimmed = text.trim();
    if !trimmed.is_empty() && trimmed.bytes().all(|byte| byte.is_ascii_digit()) {
        return trimmed.parse().ok();
    }
    let split = trimmed.find(|ch: char| ch.is_ascii_alphabetic())?;
    let (number, unit) = trimmed.split_at(split);
    let unit_ms = match unit {
        "ms" => 1.0,
        "s" => 1000.0,
        "m" => 60_000.0,
        "h" => 3_600_000.0,
        "d" => 86_400_000.0,
        _ => return None,
    };
    let (whole, fraction) = number.split_once('.').map_or((number, None), |(w, f)| (w, Some(f)));
    let digits = |part: &str| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit());
    if !digits(whole) || fraction.is_some_and(|part| !digits(part)) {
        return None;
    }
    let value: f64 = number.parse().ok()?;
    Some(js_round(value * unit_ms))
}

/// Rounds as `Math.round` does: halves go towards positive infinity.
pub(crate) fn js_round(value: f64) -> f64 {
    (value + 0.5).floor()
}

/// Whether text parses as an absolute URL, as `URL.canParse` decides.
pub(crate) fn can_parse_url(text: &str) -> bool {
    url::Url::parse(text).is_ok()
}

/// Converts an Extended JSON payload into the plain values a config file holds: numbers, dates as ISO
/// strings and `$literal` escaped documents as their fields.
pub(crate) fn plain_from_ejson(value: &Json) -> Json {
    match value {
        Json::Array(items) => Json::Array(items.iter().map(plain_from_ejson).collect()),
        Json::Object(fields) => {
            if let [(key, payload)] = fields.as_slice() {
                match (key.as_str(), payload) {
                    ("$literal", Json::Object(literal)) => {
                        return Json::Object(
                            literal
                                .iter()
                                .map(|(name, item)| (name.clone(), plain_from_ejson(item)))
                                .collect(),
                        );
                    }
                    ("$numberInt" | "$numberLong" | "$numberDouble", Json::String(text)) => {
                        if let Ok(number) = text.parse::<f64>() {
                            return Json::Number(number);
                        }
                    }
                    ("$oid", Json::String(text)) => return Json::String(text.clone()),
                    ("$date", date) => {
                        let ms = match date {
                            Json::Object(_) => match date.get("$numberLong") {
                                Some(Json::String(text)) => text.parse::<i64>().ok(),
                                _ => None,
                            },
                            Json::String(text) => canopy_protocol::ejson::parse_iso_date(text),
                            #[allow(clippy::cast_possible_truncation)]
                            Json::Number(number) => Some(*number as i64),
                            _ => None,
                        };
                        if let Some(ms) = ms {
                            return Json::String(iso_string(ms));
                        }
                    }
                    _ => {}
                }
            }
            Json::Object(fields.iter().map(|(name, item)| (name.clone(), plain_from_ejson(item))).collect())
        }
        other => other.clone(),
    }
}

/// Walks a config tree against its spec: reads environment references and the well known variables,
/// applies defaults, records where every value came from and which values are secret, and collects
/// problems instead of stopping at the first one.
pub(crate) struct Resolver<'a> {
    pub(crate) problems: Vec<Problem>,
    pub(crate) sources: Vec<(String, Source)>,
    pub(crate) secrets: Vec<String>,
    pub(crate) options: &'a ResolveOptions,
}

impl<'a> Resolver<'a> {
    pub(crate) fn new(options: &'a ResolveOptions) -> Resolver<'a> {
        Resolver {
            problems: Vec::new(),
            sources: Vec::new(),
            secrets: SECRET_PATHS.iter().map(|path| (*path).to_owned()).collect(),
            options,
        }
    }

    pub(crate) fn problem(&mut self, path: impl Into<String>, message: impl Into<String>, missing: bool) {
        self.problems.push(Problem { path: path.into(), message: message.into(), missing });
    }

    pub(crate) fn has_problem(&self, test: impl Fn(&str) -> bool) -> bool {
        self.problems.iter().any(|problem| test(&problem.path))
    }

    pub(crate) fn source(&self, path: &str) -> Option<&Source> {
        self.sources.iter().find(|(key, _)| key == path).map(|(_, source)| source)
    }

    pub(crate) fn set_source(&mut self, path: &str, source: Source) {
        match self.sources.iter_mut().find(|(key, _)| key == path) {
            Some((_, slot)) => *slot = source,
            None => self.sources.push((path.to_owned(), source)),
        }
    }

    pub(crate) fn add_secret(&mut self, path: &str) {
        if !self.secrets.iter().any(|secret| secret == path) {
            self.secrets.push(path.to_owned());
        }
    }

    fn env_source(&self, name: &str) -> Source {
        Source::Env { name: name.to_owned(), env_file: self.options.env_files.get(name).cloned() }
    }

    /// Parses text from a variable for a spec.
    pub(crate) fn parse_text(&mut self, spec: &Spec, text: &str, path: &str, label: &str) -> Option<Json> {
        let fail = |resolver: &mut Resolver<'_>, expected: String| {
            let period = if expected.ends_with('?') { "" } else { "." };
            resolver.problem(
                path,
                format!("{label} is {}.\nExpected {expected}{period}", quote(text)),
                false,
            );
            None
        };
        let trimmed = text.trim();
        match &spec.kind {
            Kind::Str => Some(Json::String(text.to_owned())),
            Kind::Url => {
                if can_parse_url(trimmed) {
                    Some(Json::String(trimmed.to_owned()))
                } else {
                    fail(self, "an absolute URL".to_owned())
                }
            }
            Kind::Int => {
                let digits = trimmed.strip_prefix('-').unwrap_or(trimmed);
                if !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit()) {
                    trimmed.parse::<f64>().ok().map(Json::Number)
                } else {
                    fail(self, "an integer".to_owned())
                }
            }
            Kind::Bool => match trimmed.to_lowercase().as_str() {
                "true" | "1" => Some(Json::Bool(true)),
                "false" | "0" => Some(Json::Bool(false)),
                _ => fail(self, "true, false, 1 or 0".to_owned()),
            },
            Kind::List => Some(Json::Array(
                text.split(',')
                    .map(str::trim)
                    .filter(|item| !item.is_empty())
                    .map(|item| Json::String(item.to_owned()))
                    .collect(),
            )),
            Kind::Duration => match parse_duration(text) {
                Some(value) => Some(Json::Number(value)),
                None => fail(self, "a duration such as 500ms, 30s, 5m, 24h or 7d".to_owned()),
            },
            Kind::Enum(values) => {
                if values.contains(&trimmed) {
                    return Some(Json::String(trimmed.to_owned()));
                }
                let near = suggest(trimmed, values.iter().copied())
                    .map_or_else(String::new, |near| format!(". Did you mean \"{near}\"?"));
                fail(self, format!("{}{near}", quoted(values)))
            }
            Kind::Origins => {
                let items: Vec<&str> =
                    text.split(',').map(str::trim).filter(|item| !item.is_empty()).collect();
                if items.contains(&"*") {
                    Some(Json::String("*".to_owned()))
                } else {
                    Some(Json::Array(items.into_iter().map(|item| Json::String(item.to_owned())).collect()))
                }
            }
            _ => fail(self, "a value that can be given as text".to_owned()),
        }
    }

    /// Validates a literal from the config file.
    pub(crate) fn check_literal(&mut self, spec: &Spec, value: &Json, path: &str) -> Option<Json> {
        let wrong = |resolver: &mut Resolver<'_>, expected: String| {
            let period = if expected.ends_with('?') { "" } else { "." };
            resolver.problem(
                path,
                format!("Received {}.\nExpected {expected}{period}", describe(value)),
                false,
            );
            None
        };
        let strings = |items: &[Json]| items.iter().all(|item| matches!(item, Json::String(_)));
        match (&spec.kind, value) {
            (Kind::Str, Json::String(_)) => Some(value.clone()),
            (Kind::Str, _) => wrong(self, "a string".to_owned()),
            (Kind::Url, Json::String(text)) if can_parse_url(text) => Some(value.clone()),
            (Kind::Url, _) => wrong(self, "an absolute URL".to_owned()),
            (Kind::Int, Json::Number(number))
                if number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_991.0 =>
            {
                Some(value.clone())
            }
            (Kind::Int, _) => wrong(self, "an integer".to_owned()),
            (Kind::Bool, Json::Bool(_)) => Some(value.clone()),
            (Kind::Bool, _) => wrong(self, "true or false".to_owned()),
            (Kind::List, Json::Array(items)) if strings(items) => Some(value.clone()),
            (Kind::List, _) => wrong(self, "a list of strings".to_owned()),
            (Kind::Duration, Json::Number(number)) if number.is_finite() && *number >= 0.0 => {
                Some(value.clone())
            }
            (Kind::Duration, Json::String(text)) if parse_duration(text).is_some() => {
                parse_duration(text).map(Json::Number)
            }
            (Kind::Duration, _) => {
                wrong(self, "milliseconds or a duration such as 500ms, 30s, 5m, 24h or 7d".to_owned())
            }
            (Kind::Enum(values), Json::String(text)) if values.contains(&text.as_str()) => {
                Some(value.clone())
            }
            (Kind::Enum(values), _) => {
                let near = match value {
                    Json::String(text) => suggest(text, values.iter().copied()),
                    _ => None,
                };
                let near = near.map_or_else(String::new, |near| format!(". Did you mean \"{near}\"?"));
                wrong(self, format!("{}{near}", quoted(values)))
            }
            (Kind::Enums(values), Json::Array(items))
                if items
                    .iter()
                    .all(|item| matches!(item, Json::String(text) if values.contains(&text.as_str()))) =>
            {
                Some(value.clone())
            }
            (Kind::Enums(values), _) => wrong(self, format!("a list of {}", quoted(values))),
            (Kind::Origins, Json::String(text)) if text == "*" => Some(value.clone()),
            (Kind::Origins, Json::Array(items)) if strings(items) => Some(value.clone()),
            (Kind::Origins, _) => wrong(self, "\"*\" or a list of origins".to_owned()),
            (Kind::Raw, Json::Object(fields)) => match fields.as_slice() {
                [(key, payload)] if key == "$ejson" => match plain_from_ejson(payload) {
                    plain @ Json::Object(_) => Some(plain),
                    _ => wrong(self, "an object".to_owned()),
                },
                _ => Some(value.clone()),
            },
            (Kind::Raw, _) => wrong(self, "an object".to_owned()),
            (Kind::Claims, _) => wrong(self, "an HTTPS claims hook: { url, secret }".to_owned()),
            _ => wrong(self, "a value".to_owned()),
        }
    }

    /// Walks the config file against the spec, resolving environment references.
    pub(crate) fn walk(&mut self, spec: &Spec, value: &Json, path: &str) -> Option<Json> {
        if let Some(reference) = EnvReference::read(value) {
            return self.reference(spec, value, &reference, path);
        }
        let raw = Spec::of(Kind::Raw);
        match &spec.kind {
            Kind::Object(fields) => self.walk_object(fields, value, path),
            Kind::Record(of) => {
                let Json::Object(entries) = value else { return self.check_literal(&raw, value, path) };
                let mut out = Vec::new();
                for (key, item) in entries {
                    if let Some(resolved) = self.walk(of, item, &format!("{path}.{key}")) {
                        set_own(&mut out, key, resolved);
                    }
                }
                Some(Json::Object(out))
            }
            Kind::Toggle(of) => match value {
                Json::Bool(true) => Some(Json::Object(Vec::new())),
                Json::Bool(false) => {
                    self.set_source(path, Source::File);
                    Some(Json::Bool(false))
                }
                _ => self.walk(of, value, path),
            },
            Kind::Auth => {
                let Json::Object(_) = value else { return self.check_literal(&raw, value, path) };
                let kind = value.get("kind");
                let fields = match kind {
                    Some(Json::String(kind)) => auth_kind(kind),
                    _ => None,
                };
                let Some(fields) = fields else {
                    let received = kind.map_or_else(|| "undefined".to_owned(), describe);
                    self.problem(
                        format!("{path}.kind"),
                        format!(
                            "Received {received}.\nUse builtin(), external(), external.auth0(), external.clerk(), external.firebase() or external.supabase()."
                        ),
                        false,
                    );
                    return None;
                };
                self.walk_object(&fields, value, path)
            }
            Kind::Tagged(kinds, hint) => {
                let Json::Object(_) = value else { return self.check_literal(&raw, value, path) };
                let kind = value.get("kind");
                let fields = match kind {
                    Some(Json::String(kind)) => {
                        kinds.iter().find(|(name, _)| name == kind).map(|(_, fields)| fields)
                    }
                    _ => None,
                };
                let Some(fields) = fields else {
                    let received = kind.map_or_else(|| "undefined".to_owned(), describe);
                    self.problem(format!("{path}.kind"), format!("Received {received}.\n{hint}"), false);
                    return None;
                };
                self.walk_object(fields, value, path)
            }
            Kind::Objects(of) => {
                let Json::Array(items) = value else {
                    self.problem(path, format!("Received {}.\nExpected a list.", describe(value)), false);
                    return None;
                };
                Some(Json::Array(
                    items
                        .iter()
                        .enumerate()
                        .map(|(index, item)| {
                            self.walk(of, item, &format!("{path}.{index}")).unwrap_or(Json::Null)
                        })
                        .collect(),
                ))
            }
            Kind::Claims => {
                let Json::Object(_) = value else { return self.check_literal(spec, value, path) };
                let out = self.walk_object(&claims_fields(), value, path);
                self.set_source(path, Source::File);
                out
            }
            Kind::Policies => {
                let Json::Object(_) = value else { return self.check_literal(&raw, value, path) };
                let out = self.walk_object(&policies_fields(), value, path);
                if let Some(Json::Object(fields)) = &out {
                    let has_dir = field(fields, "dir").is_some();
                    let has_source = field(fields, "source").is_some();
                    if has_dir == has_source {
                        self.problem(
                            path,
                            "Set either dir (a directory of policy files) or source: \"database\".",
                            false,
                        );
                    }
                }
                out
            }
            _ => {
                let checked = self.check_literal(spec, value, path);
                if checked.is_some() {
                    self.set_source(path, Source::File);
                }
                checked
            }
        }
    }

    fn reference(&mut self, spec: &Spec, value: &Json, reference: &EnvReference, path: &str) -> Option<Json> {
        if matches!(
            spec.kind,
            Kind::Object(_)
                | Kind::Record(_)
                | Kind::Auth
                | Kind::Policies
                | Kind::Objects(_)
                | Kind::Tagged(..)
                | Kind::Claims
        ) {
            return self.check_literal(spec, value, path);
        }
        if reference.secret {
            self.add_secret(path);
        }
        let text = self.options.env.get(&reference.name).filter(|text| !text.is_empty()).cloned();
        let Some(text) = text else {
            if let Some(default) = &reference.default {
                self.set_source(path, Source::File);
                return self.check_literal(spec, default, path);
            }
            if !reference.optional {
                let next_to =
                    if self.options.file.is_some() { " or in an env file next to the config" } else { "" };
                self.problem(
                    path,
                    format!("{} is not set.\nSet it in the environment{next_to}.", reference.name),
                    true,
                );
            }
            return None;
        };
        let source = self.env_source(&reference.name);
        self.set_source(path, source);
        self.parse_text(spec, &text, path, &reference.name)
    }

    fn walk_object(&mut self, fields: &Fields, value: &Json, path: &str) -> Option<Json> {
        let Json::Object(entries) = value else {
            return self.check_literal(&Spec::of(Kind::Raw), value, path);
        };
        let mut out = Vec::new();
        let prefix = if path.is_empty() { String::new() } else { format!("{path}.") };
        for (key, item) in entries {
            let Some((_, spec)) = fields.iter().find(|(name, _)| name == key) else {
                let near = suggest(key, fields.iter().map(|(name, _)| *name))
                    .map_or_else(String::new, |near| format!(" Did you mean {prefix}{near}?"));
                self.problem(format!("{prefix}{key}"), format!("Unknown setting.{near}"), false);
                continue;
            };
            if let Some(resolved) = self.walk(spec, item, &format!("{prefix}{key}")) {
                set_own(&mut out, key, resolved);
            }
        }
        Some(Json::Object(out))
    }

    /// Fills every unset setting that has a default and checks numeric ranges. Sections turned off are
    /// skipped, and so is auth other than built in auth.
    pub(crate) fn fill_defaults(&mut self, fields: &Fields, node: &mut Object, prefix: &str) {
        for (key, spec) in fields {
            let path = format!("{prefix}{key}");
            let value = field(node, key);
            let builtin;
            let nested = match &spec.kind {
                Kind::Object(fields) => Some(fields),
                Kind::Toggle(of) => match &of.kind {
                    Kind::Object(fields) => Some(fields),
                    _ => None,
                },
                Kind::Auth
                    if value.and_then(|value| value.get("kind"))
                        == Some(&Json::String("builtin".to_owned())) =>
                {
                    builtin = auth_kind("builtin");
                    builtin.as_ref()
                }
                _ => None,
            };
            if let Some(nested) = nested {
                match value {
                    Some(Json::Bool(false)) => continue,
                    Some(Json::Object(_)) | None => {}
                    Some(_) => continue,
                }
                let child_prefix = format!("{path}.");
                if let Some((_, Json::Object(child))) = node.iter_mut().find(|(name, _)| name == key) {
                    self.fill_defaults(nested, child, &child_prefix);
                } else {
                    let mut child = Vec::new();
                    self.fill_defaults(nested, &mut child, &child_prefix);
                    if !child.is_empty() {
                        set_own(node, key, Json::Object(child));
                    }
                }
                continue;
            }
            if value.is_none()
                && let Some(default) = &spec.default
            {
                set_own(node, key, default.clone());
                self.set_source(&path, Source::Default);
            }
            if let (Some(range), Some(Json::Number(current))) = (&spec.range, field(node, key)) {
                let current = *current;
                if range.min.is_some_and(|min| current < min) || range.max.is_some_and(|max| current > max) {
                    self.problem(path, range.message(current), false);
                }
            }
        }
    }

    /// Applies a well known variable on top of the file, refusing contradictions.
    pub(crate) fn overlay(&mut self, tree: &mut Object, name: &str, path: &str, spec: &Spec) {
        let Some(text) = self.options.env.get(name).filter(|text| !text.is_empty()).cloned() else { return };
        let Some(parsed) = self.parse_text(spec, &text, path, name) else { return };
        if SECRET_PATHS.contains(&path) {
            self.add_secret(path);
        }
        let mut keys: Vec<&str> = path.split('.').collect();
        let Some(last) = keys.pop() else { return };
        let mut parent: &mut Object = tree;
        for key in &keys {
            let position = parent.iter().position(|(entry, _)| entry == key);
            if let Some(index) = position
                && matches!(parent.get(index), Some((_, Json::Bool(false))))
            {
                let section = keys.join(".");
                self.problem(
                    path,
                    format!(
                        "{name} is set, but {section} is turned off in the config file.\nUnset {name} or turn {section} on."
                    ),
                    false,
                );
                return;
            }
            let created = || {
                if *key == "auth" {
                    Json::Object(vec![("kind".to_owned(), Json::String("external".to_owned()))])
                } else {
                    Json::Object(Vec::new())
                }
            };
            let index = match position {
                Some(index) => {
                    if let Some((_, slot)) = parent.get_mut(index)
                        && !matches!(slot, Json::Object(_))
                    {
                        *slot = created();
                    }
                    index
                }
                None => {
                    parent.push(((*key).to_owned(), created()));
                    parent.len() - 1
                }
            };
            let Some((_, Json::Object(next))) = parent.get_mut(index) else { return };
            parent = next;
        }
        let env_source = self.env_source(name);
        let current = field(parent, last).cloned();
        let source = self.source(path).cloned();
        let (Some(current), Some(source)) = (current, source) else {
            set_own(parent, last, parsed);
            self.set_source(path, env_source);
            return;
        };
        if let Source::Env { name: from, .. } = &source
            && from == name
        {
            return;
        }
        if stringify(&current) == stringify(&parsed) {
            return;
        }
        let from = match &source {
            Source::Env { name: from, .. } => format!("the config file (through {from})"),
            _ => "the config file".to_owned(),
        };
        self.problem(
            path,
            format!(
                "{path} is set in {from} and by {name}, with different values.\nRemove one of them: the config file and the environment must not disagree."
            ),
            false,
        );
    }
}

/// The top level section of a dotted path.
pub(crate) fn section(path: &str) -> &str {
    path.split('.').next().unwrap_or(path)
}

/// Expands provider presets into plain external auth, keeping the source of what they were derived from.
pub(crate) fn expand_auth(resolver: &mut Resolver<'_>, tree: &mut Object) {
    let Some(Json::Object(auth)) = field(tree, "auth") else { return };
    let text = |key: &str| match field(auth, key) {
        Some(Json::String(text)) => Some(text.clone()),
        _ => None,
    };
    let host = |value: &str| {
        let authority =
            value.strip_prefix("https://").or_else(|| value.strip_prefix("http://")).unwrap_or(value);
        authority.trim_end_matches('/').to_owned()
    };
    let (from, fields) = match field(auth, "kind") {
        Some(Json::String(kind)) if kind == "auth0" => {
            let Some(domain) = text("domain") else { return };
            let domain = host(&domain);
            (
                "domain",
                vec![
                    ("jwksUrl", Some(Json::String(format!("https://{domain}/.well-known/jwks.json")))),
                    ("issuer", Some(Json::String(format!("https://{domain}/")))),
                    ("audience", field(auth, "audience").cloned()),
                    ("algorithms", Some(Json::Array(vec![Json::String("RS256".to_owned())]))),
                ],
            )
        }
        Some(Json::String(kind)) if kind == "clerk" => {
            let Some(api) = text("frontendApi") else { return };
            let api = host(&api);
            (
                "frontendApi",
                vec![
                    ("jwksUrl", Some(Json::String(format!("https://{api}/.well-known/jwks.json")))),
                    ("issuer", Some(Json::String(format!("https://{api}")))),
                    ("audience", field(auth, "audience").cloned()),
                    ("algorithms", Some(Json::Array(vec![Json::String("RS256".to_owned())]))),
                ],
            )
        }
        Some(Json::String(kind)) if kind == "firebase" => {
            let Some(project) = text("projectId") else { return };
            (
                "projectId",
                vec![
                    (
                        "jwksUrl",
                        Some(Json::String(
                            "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"
                                .to_owned(),
                        )),
                    ),
                    ("issuer", Some(Json::String(format!("https://securetoken.google.com/{project}")))),
                    ("audience", Some(Json::String(project))),
                    ("algorithms", Some(Json::Array(vec![Json::String("RS256".to_owned())]))),
                ],
            )
        }
        Some(Json::String(kind)) if kind == "supabase" => {
            let Some(reference) = text("projectRef") else { return };
            (
                "projectRef",
                vec![
                    (
                        "jwksUrl",
                        Some(Json::String(format!(
                            "https://{reference}.supabase.co/auth/v1/.well-known/jwks.json"
                        ))),
                    ),
                    ("issuer", Some(Json::String(format!("https://{reference}.supabase.co/auth/v1")))),
                    ("audience", Some(Json::String("authenticated".to_owned()))),
                    (
                        "algorithms",
                        Some(Json::Array(vec![
                            Json::String("ES256".to_owned()),
                            Json::String("RS256".to_owned()),
                        ])),
                    ),
                ],
            )
        }
        _ => return,
    };
    let source = resolver.source(&format!("auth.{from}")).cloned().unwrap_or(Source::File);
    let roles = text("rolesClaim");
    let mut next = vec![("kind".to_owned(), Json::String("external".to_owned()))];
    for (key, value) in &fields {
        resolver.set_source(&format!("auth.{key}"), source.clone());
        if let Some(value) = value {
            next.push(((*key).to_owned(), value.clone()));
        }
    }
    if let Some(roles) = roles {
        next.push(("rolesClaim".to_owned(), Json::String(roles)));
    }
    set_own(tree, "auth", Json::Object(next));
}

/// Whether a host name is the loopback interface, where plain HTTP is accepted.
pub(crate) fn is_local_host(hostname: &str) -> bool {
    matches!(hostname, "localhost" | "127.0.0.1" | "[::1]")
}

/// The host name of a URL as `URL.hostname` gives it, with brackets around IPv6 addresses.
pub(crate) fn hostname(url: &url::Url) -> String {
    match url.host() {
        Some(url::Host::Ipv6(address)) => format!("[{address}]"),
        Some(host) => host.to_string(),
        None => String::new(),
    }
}
