use crate::USAGE;
use canopy_control::KeyKind;

const GLOBAL_FLAGS: &[&str] =
    &["help", "version", "debug", "config", "dir", "mongodb-uri", "database", "bundle"];
const BOOLEAN_FLAGS: &[&str] = &[
    "help",
    "version",
    "debug",
    "check",
    "js",
    "infer-enums",
    "sources",
    "with-mongo",
    "mongo-binary",
    "watch",
    "types",
    "yes",
    "dry-run",
    "fail-on-drift",
    "force",
    "status",
    "all",
];

struct Spec {
    name: &'static str,
    flags: &'static [&'static str],
    min: usize,
    max: usize,
    needs: Option<&'static str>,
}

impl Spec {
    const fn new(name: &'static str, flags: &'static [&'static str]) -> Self {
        Self { name, flags, min: 0, max: 0, needs: None }
    }

    const fn variadic(mut self) -> Self {
        self.max = usize::MAX;
        self
    }

    const fn requires(mut self, count: usize, needs: &'static str) -> Self {
        self.min = count;
        self.max = count;
        self.needs = Some(needs);
        self
    }
}

const COMMANDS: &[Spec] = &[
    Spec::new("doctor", &[]),
    Spec::new("pull", &["out", "js", "collection", "force", "infer-enums", "sample"]),
    Spec::new("schema diff", &["file", "sample", "infer-enums", "role"]),
    Spec::new("schema push", &["file", "yes"]),
    Spec::new("config print", &["sources"]),
    Spec::new("init", &[]),
    Spec::new("build", &["out"]),
    Spec::new("gen types", &["out", "check", "sample", "infer-enums"]),
    Spec::new("dev", &["with-mongo", "mongo-binary", "mongo-version", "port", "mongo-port", "mongo-image"]),
    Spec::new("realtime enable-images", &["yes"]).variadic(),
    Spec::new("realtime disable-images", &["yes"]).variadic(),
    Spec::new("indexes advise", &[]),
    Spec::new("indexes create", &["yes"]),
    Spec::new("policies lint", &[]),
    Spec::new("policies test", &[]),
    Spec::new("policies explain", &["as", "roles", "op", "filter", "ctx"])
        .requires(1, "exactly one collection"),
    Spec::new("policies diff", &["fail-on-drift", "env"]).variadic(),
    Spec::new("policies push", &["expect-version", "comment", "dry-run", "env"]).variadic(),
    Spec::new("policies pull", &["force", "env"]).variadic(),
    Spec::new("policies history", &["limit", "env"]).requires(1, "exactly one collection"),
    Spec::new("policies rollback", &["expect-version", "comment", "yes", "env"])
        .requires(2, "a collection and a version"),
    Spec::new("keys list", &[]),
    Spec::new("keys create", &["kind", "name"]),
    Spec::new("keys revoke", &["yes"]).requires(1, "the id of one key"),
    Spec::new("admin list", &[]),
    Spec::new("admin create", &["email", "role", "name"]),
    Spec::new("auth import", &["from", "hash-key", "salt-separator", "rounds", "mem-cost", "dry-run", "env"])
        .requires(1, "the export file"),
    Spec::new("admin reset-totp", &["yes"]).requires(1, "the id or email of one admin"),
    Spec::new("admin tokens create", &["name", "role", "expires", "env"]),
    Spec::new("admin tokens list", &["all", "env"]),
    Spec::new("admin tokens revoke", &["yes", "env"]).requires(1, "the id of one token"),
    Spec::new("migrate", &["status"]),
    Spec::new("login", &["token", "env"]).requires(1, "the project URL"),
    Spec::new("logout", &[]).requires(1, "the project URL"),
];

pub(crate) struct Invocation {
    positional: Vec<String>,
    flags: Vec<(String, Option<String>)>,
}

impl Invocation {
    pub(crate) fn parse(args: impl IntoIterator<Item = String>) -> Self {
        let mut positional = Vec::new();
        let mut flags: Vec<(String, Option<String>)> = Vec::new();
        let mut args = args.into_iter().peekable();
        while let Some(arg) = args.next() {
            let Some(flag) = arg.strip_prefix("--") else {
                positional.push(arg);
                continue;
            };
            let (name, inline) =
                flag.split_once('=').map_or((flag, None), |(name, value)| (name, Some(value)));
            let value = match inline {
                Some(inline) => Some(inline.to_owned()),
                None if !BOOLEAN_FLAGS.contains(&name)
                    && args.peek().is_some_and(|next| !next.starts_with("--")) =>
                {
                    args.next()
                }
                None => None,
            };
            if let Some((_, prior)) = flags.iter_mut().find(|(key, _)| key == name) {
                *prior = value;
            } else {
                flags.push((name.to_owned(), value));
            }
        }
        Self { positional, flags }
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.positional.is_empty()
    }

    pub(crate) fn has_flag(&self, flag: &str) -> bool {
        self.flags.iter().any(|(name, _)| name == flag)
    }

    pub(crate) fn text(&self, flag: &str) -> Option<&str> {
        self.flags.iter().find(|(name, _)| name == flag)?.1.as_deref()
    }

    pub(crate) fn key_create_options(&self) -> Result<(KeyKind, &str), String> {
        match (self.text("kind").and_then(KeyKind::parse), self.text("name")) {
            (Some(kind), Some(name)) => Ok((kind, name)),
            _ => Err("keys create needs --kind publishable|secret and --name <name>".into()),
        }
    }

    pub(crate) fn validate(&self) -> Result<(&'static str, &[String]), String> {
        let first = self.positional.first().map_or("", String::as_str);
        let words = if COMMANDS.iter().any(|spec| spec.name == first) {
            1
        } else if first == "admin" && self.positional.get(1).is_some_and(|word| word == "tokens") {
            3
        } else {
            2
        };
        let (prefix, args) = self.positional.split_at(words.min(self.positional.len()));
        let name = prefix.join(" ");
        let Some(spec) = COMMANDS.iter().find(|spec| spec.name == name) else {
            let near = suggest(&name, COMMANDS.iter().map(|spec| spec.name))
                .map_or_else(String::new, |near| format!(". Did you mean canopy {near}?"));
            return Err(format!(
                "Unknown command: {}{near}\n\n{}",
                self.positional.join(" "),
                USAGE.trim_end_matches('\n')
            ));
        };
        for (flag, _) in &self.flags {
            if GLOBAL_FLAGS.contains(&flag.as_str()) || spec.flags.contains(&flag.as_str()) {
                continue;
            }
            let near = suggest(flag, GLOBAL_FLAGS.iter().chain(spec.flags).copied())
                .map_or_else(String::new, |near| format!(" Did you mean --{near}?"));
            return Err(format!("Unknown option --{flag} for {name}.{near}"));
        }
        if args.len() < spec.min || args.len() > spec.max {
            return Err(match spec.needs {
                Some(needs) => format!("{name} needs {needs}"),
                None => format!(
                    "Unexpected argument {} for {name}",
                    args.get(spec.max..).unwrap_or_default().join(" ")
                ),
            });
        }
        if self.has_flag("env") {
            let environment =
                self.text("env").ok_or("--env needs an environment name, such as --env production")?;
            let mut bytes = environment.bytes();
            if environment.len() > 64
                || !bytes.next().is_some_and(|byte| byte.is_ascii_alphabetic())
                || !bytes.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
            {
                return Err(format!(
                    "--env {} is not an environment name: a letter, then letters, digits, _ or -",
                    serde_json::Value::String(environment.to_owned())
                ));
            }
        }
        Ok((spec.name, args))
    }
}

fn suggest<'a>(input: &str, candidates: impl Iterator<Item = &'a str>) -> Option<&'a str> {
    let limit = 2.max(input.encode_utf16().count() / 3);
    let input = input.to_lowercase();
    candidates
        .map(|candidate| (strsim::levenshtein(&input, &candidate.to_lowercase()), candidate))
        .filter(|(distance, _)| *distance <= limit)
        .min_by_key(|(distance, _)| *distance)
        .map(|(_, candidate)| candidate)
}

#[cfg(test)]
mod tests {
    use super::Invocation;

    fn parse(args: &[&str]) -> Invocation {
        Invocation::parse(args.iter().map(|arg| (*arg).to_owned()))
    }

    #[test]
    fn keeps_equals_signs_inside_an_inline_value() {
        let call = parse(&["policies", "explain", "todos", r#"--filter={"title":"a=b"}"#]);
        assert_eq!(call.text("filter"), Some(r#"{"title":"a=b"}"#));
        assert_eq!(call.validate().map(|(name, args)| (name, args.len())), Ok(("policies explain", 1)));
    }

    #[test]
    fn takes_the_next_word_as_the_value_of_a_valued_flag_only() {
        let call = parse(&["pull", "--out", "types.ts", "--js", "extra"]);
        assert_eq!(call.text("out"), Some("types.ts"));
        assert_eq!(call.text("js"), None);
        assert!(call.has_flag("js"));
        assert_eq!(call.validate().err(), Some("Unexpected argument extra for pull".to_owned()));
    }

    #[test]
    fn rejects_an_environment_name_that_does_not_start_with_a_letter() {
        let call = parse(&["policies", "push", "--env", "1prod"]);
        assert!(
            call.validate()
                .is_err_and(|error| error.starts_with("--env \"1prod\" is not an environment name"))
        );
    }
}
