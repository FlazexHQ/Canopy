use canopy_mongo::mongodb::error::{Error, ErrorKind};
use canopy_protocol::ErrorCode;

/// The oldest feature compatibility version Canopy supports.
pub(crate) const MIN_FEATURE_COMPATIBILITY_VERSION: &str = "8.0";

/// One problem explained for a developer: a code, what happened, why, the fix and a docs page.
pub(crate) struct Diagnostic {
    pub(crate) code: ErrorCode,
    pub(crate) summary: String,
    pub(crate) cause: Option<String>,
    pub(crate) fix: Option<String>,
    pub(crate) docs: Option<&'static str>,
}

/// Where a MongoDB failure happened: the hosts of the connection string (never its credentials) and the
/// database.
#[derive(Default)]
pub(crate) struct Target {
    pub(crate) host: Option<String>,
    pub(crate) database: Option<String>,
}

impl Target {
    pub(crate) fn of(uri: &str, database: Option<&str>) -> Target {
        let rest = uri.strip_prefix("mongodb://").or_else(|| uri.strip_prefix("mongodb+srv://"));
        let host = rest.and_then(|rest| {
            let authority = rest.split(['/', '?']).next().unwrap_or_default();
            let host = authority.rsplit_once('@').map_or(authority, |(_, host)| host);
            (!host.is_empty()).then(|| host.to_owned())
        });
        Target { host, database: database.map(str::to_owned) }
    }

    fn at(&self) -> String {
        self.host.as_ref().map_or_else(|| "MongoDB".to_owned(), |host| format!("MongoDB at {host}"))
    }
}

fn indent(text: &str, first: &str, rest: &str) -> String {
    text.split('\n')
        .enumerate()
        .map(|(index, line)| format!("{}{line}", if index == 0 { first } else { rest }))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Formats a diagnostic for a terminal, as the TypeScript CLI does.
pub(crate) fn format(diagnostic: &Diagnostic) -> String {
    let mut lines = vec![format!("error {}: {}", diagnostic.code.as_str(), diagnostic.summary)];
    if let Some(cause) = &diagnostic.cause {
        lines.push(indent(cause, "  ", "  "));
    }
    if let Some(fix) = &diagnostic.fix {
        lines.push(indent(fix, "  Fix: ", "       "));
    }
    if let Some(docs) = diagnostic.docs {
        lines.push(format!("  Docs: errors/{docs}"));
    }
    lines.join("\n")
}

fn standalone(target: &Target) -> Diagnostic {
    Diagnostic {
        code: ErrorCode::Unavailable,
        summary: "change streams are not available".to_owned(),
        cause: Some(format!(
            "{} is a standalone server; change streams and transactions need a replica set.",
            target.at()
        )),
        fix: Some(
            "convert it to a single node replica set: start mongod with --replSet rs0, run rs.initiate() once\nand add replicaSet=rs0 to the connection string."
                .to_owned(),
        ),
        docs: Some("standalone-mongodb"),
    }
}

/// The diagnostic for a deployment whose feature compatibility version is below the oldest supported.
pub(crate) fn feature_compatibility(version: Option<&str>, target: &Target) -> Diagnostic {
    let min = MIN_FEATURE_COMPATIBILITY_VERSION;
    let version = version.map_or_else(|| format!("below {min}"), str::to_owned);
    Diagnostic {
        code: ErrorCode::Unavailable,
        summary: format!("the feature compatibility version is below {min}"),
        cause: Some(format!(
            "{} runs with featureCompatibilityVersion {version}; Canopy needs {min} or newer.",
            target.at()
        )),
        fix: Some(format!(
            "after upgrading the binaries, run db.adminCommand({{ setFeatureCompatibilityVersion: \"{min}\", confirm: true }})."
        )),
        docs: Some("feature-compatibility-version"),
    }
}

fn contains(text: &str, needles: &[&str]) -> bool {
    let lower = text.to_ascii_lowercase();
    needles.iter().any(|needle| lower.contains(&needle.to_ascii_lowercase()))
}

fn action_of(command: &str) -> &str {
    match command {
        "aggregate" | "count" => "find",
        "delete" => "remove",
        other => other,
    }
}

fn unauthorized(text: &str, target: &Target) -> Diagnostic {
    let lower = text.to_ascii_lowercase();
    let parsed = lower.find("not authorized on ").and_then(|start| {
        let rest = text.get(start + "not authorized on ".len()..)?;
        let (database, rest) = rest.split_once(' ')?;
        let rest = rest.strip_prefix("to execute command ")?.trim_start_matches(['{', ' ']);
        let command: String = rest.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_').collect();
        Some((database.to_owned(), command))
    });
    let database = parsed
        .as_ref()
        .map(|(database, _)| database.clone())
        .or_else(|| target.database.clone())
        .unwrap_or_else(|| "the database".to_owned());
    let action = if text.contains("$changeStream") {
        Some("changeStream".to_owned())
    } else {
        parsed.as_ref().map(|(_, command)| action_of(command).to_owned()).filter(|action| !action.is_empty())
    };
    Diagnostic {
        code: ErrorCode::Unavailable,
        summary: format!(
            "the MongoDB user may not run {} on {database}",
            action.as_deref().unwrap_or("this command")
        ),
        cause: Some(format!("{} denied the command because the user lacks a privilege.", target.at())),
        fix: Some(format!(
            "grant the {} action on the database {database} to the user Canopy connects as.\nThe canopyRealtime and canopyPlatform roles in the operations guide list every action Canopy needs.",
            action.as_deref().unwrap_or("needed")
        )),
        docs: Some("missing-privilege"),
    }
}

/// Explains a MongoDB driver failure, or returns `None` when it matches no known problem.
pub(crate) fn diagnose(error: &Error, target: &Target) -> Option<Diagnostic> {
    let text = error.to_string();
    let (code, code_name) = match error.kind.as_ref() {
        ErrorKind::Command(command) => (Some(command.code), Some(command.code_name.as_str())),
        _ => (None, None),
    };
    let selection = matches!(error.kind.as_ref(), ErrorKind::ServerSelection { .. });
    if code == Some(40573)
        || code_name == Some("Location40573")
        || contains(
            &text,
            &[
                "only supported on replica sets",
                "Transaction numbers are only allowed on a replica set member or mongos",
            ],
        )
    {
        return Some(standalone(target));
    }
    if code == Some(18)
        || code_name == Some("AuthenticationFailed")
        || matches!(error.kind.as_ref(), ErrorKind::Authentication { .. })
        || contains(&text, &["Authentication failed"])
    {
        return Some(Diagnostic {
            code: ErrorCode::Unavailable,
            summary: "MongoDB rejected the credentials".to_owned(),
            cause: Some(format!("{} refused the user name and password of the connection string.", target.at())),
            fix: Some(
                "check the user name, the password (percent encoded) and authSource in the connection string."
                    .to_owned(),
            ),
            docs: Some("authentication-failed"),
        });
    }
    if code == Some(13) || code_name == Some("Unauthorized") || contains(&text, &["not authorized on"]) {
        return Some(unauthorized(&text, target));
    }
    if contains(&text, &["featureCompatibilityVersion"]) {
        return Some(feature_compatibility(None, target));
    }
    if contains(&text, &[" ssl", "tls", "certificate", "wrong version number", "handshake"]) {
        return Some(Diagnostic {
            code: ErrorCode::Unavailable,
            summary: "the TLS handshake with MongoDB failed".to_owned(),
            cause: Some(format!(
                "{} and the connection string disagree about TLS, or the server certificate is not trusted.",
                target.at()
            )),
            fix: Some(
                "set tls=true only when the server requires TLS, and pass tlsCAFile for a private certificate authority."
                    .to_owned(),
            ),
            docs: Some("tls-mismatch"),
        });
    }
    let unanswered = selection && {
        let types: Vec<&str> =
            text.match_indices("Type: ").filter_map(|(at, _)| text.get(at + 6..)).collect();
        types.len() > 1 && types.iter().all(|rest| rest.starts_with("Unknown"))
    };
    let refused = contains(
        &text,
        &[
            "refused",
            "No such host",
            "failed to lookup address",
            "unreachable",
            "timed out",
            "os error 10060",
            "os error 11001",
        ],
    );
    if refused || unanswered {
        return Some(Diagnostic {
            code: ErrorCode::Unavailable,
            summary: "cannot reach MongoDB".to_owned(),
            cause: Some(format!(
                "{} did not accept a connection: the host is wrong or mongod is not running.",
                target.at()
            )),
            fix: Some(
                "check that mongod is running and that the host and port of the connection string are right.\nIn Docker, use the service name instead of localhost."
                    .to_owned(),
            ),
            docs: Some("mongodb-unreachable"),
        });
    }
    if selection {
        return Some(Diagnostic {
            code: ErrorCode::Unavailable,
            summary: "no MongoDB server could be selected".to_owned(),
            cause: Some(format!(
                "{} answered, but no member matched the connection string: the replica set name may be wrong or no primary is elected.",
                target.at()
            )),
            fix: Some(
                "check that replicaSet in the connection string matches rs.status().set and that a primary exists."
                    .to_owned(),
            ),
            docs: Some("no-primary"),
        });
    }
    None
}

/// Any driver failure as a diagnostic: a known problem, or a plain account of the error.
pub(crate) fn of(error: &Error, target: &Target) -> Diagnostic {
    diagnose(error, target).unwrap_or_else(|| Diagnostic {
        code: ErrorCode::Internal,
        summary: error.to_string(),
        cause: None,
        fix: None,
        docs: None,
    })
}

#[cfg(test)]
mod tests {
    use super::{Diagnostic, Target, format};
    use canopy_protocol::ErrorCode;

    #[test]
    fn targets_name_hosts_without_credentials() {
        let target = Target::of("mongodb://user:secret@db1:27017,db2:27018/app?replicaSet=rs0", None);
        assert_eq!(target.host.as_deref(), Some("db1:27017,db2:27018"));
        assert_eq!(
            Target::of("mongodb+srv://cluster.example.net", None).host.as_deref(),
            Some("cluster.example.net")
        );
        assert_eq!(Target::of("not a uri", None).host, None);
    }

    #[test]
    fn formats_like_the_typescript_cli() {
        let diagnostic = Diagnostic {
            code: ErrorCode::Unavailable,
            summary: "cannot reach MongoDB".to_owned(),
            cause: Some("cause".to_owned()),
            fix: Some("first\nsecond".to_owned()),
            docs: Some("mongodb-unreachable"),
        };
        assert_eq!(
            format(&diagnostic),
            "error CANOPY_UNAVAILABLE: cannot reach MongoDB\n  cause\n  Fix: first\n       second\n  Docs: errors/mongodb-unreachable"
        );
    }
}
