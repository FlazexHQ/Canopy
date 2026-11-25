//! Replays the config authoring vectors recorded from the TypeScript resolver.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::{BTreeMap, HashMap};

use canopy_config::authoring::{
    Command, ResolveError, ResolveOptions, Source, format_config, parse_env_file, pointer, resolve_config,
};
use canopy_protocol::json::{Json, parse_json, write_json};

fn text(value: &Json) -> String {
    let mut out = String::new();
    write_json(&mut out, value);
    out
}

fn string<'a>(value: &'a Json, key: &str) -> Option<&'a str> {
    match value.get(key) {
        Some(Json::String(text)) => Some(text),
        _ => None,
    }
}

fn options(case: &Json) -> ResolveOptions {
    let mut env = HashMap::new();
    let mut env_files = HashMap::new();
    if let Some(env_text) = string(case, "envText") {
        for (key, value) in parse_env_file(env_text) {
            env_files.insert(key.clone(), "/project/.env.local".to_owned());
            env.insert(key, value);
        }
    }
    if let Some(Json::Object(environment)) = case.get("environment") {
        for (key, value) in environment {
            if let Json::String(value) = value {
                env.insert(key.clone(), value.clone());
                env_files.remove(key);
            }
        }
    }
    let context = case.get("context").unwrap();
    ResolveOptions {
        env,
        env_files,
        file: Some("/project/canopy.config.ts".to_owned()),
        base_dir: "/project".to_owned(),
        cwd: "/working".to_owned(),
        command: Command::parse(string(context, "command").unwrap()).unwrap(),
    }
}

fn source_json(source: &Source) -> Json {
    let mut fields = Vec::new();
    match source {
        Source::Default => fields.push(("kind".to_owned(), Json::String("default".to_owned()))),
        Source::File => fields.push(("kind".to_owned(), Json::String("file".to_owned()))),
        Source::Env { name, env_file } => {
            fields.push(("kind".to_owned(), Json::String("env".to_owned())));
            fields.push(("name".to_owned(), Json::String(name.clone())));
            if let Some(file) = env_file {
                fields.push(("envFile".to_owned(), Json::String(file.clone())));
            }
        }
    }
    Json::Object(fields)
}

#[test]
fn replays_the_config_vectors() {
    let vectors = parse_json(include_str!("../../../conformance/authoring/config/vectors.json")).unwrap();
    let Json::Array(cases) = vectors else { panic!("expected a list of cases") };
    let mut replayed = 0;
    for case in &cases {
        let name = string(case, "name").unwrap();
        let Some(document) = case.get("document") else { continue };
        let expected = case.get("expected").unwrap();
        let result = resolve_config(document, &options(case));
        if let Some(code) = string(expected, "code") {
            assert_eq!(code, "CANOPY_CONFIG_INVALID", "{name}");
            let Err(ResolveError::Config(error)) = result else {
                panic!("{name}: expected problems, got {result:?}")
            };
            let Some(Json::Array(problems)) = expected.get("problems") else { panic!("{name}: no problems") };
            let future_claims = case.get("futureClaims") == Some(&Json::Bool(true));
            let wanted: Vec<_> = problems
                .iter()
                .filter(|problem| !future_claims || string(problem, "resolverPath") != Some("auth.claims"))
                .map(|problem| {
                    (
                        string(problem, "path").unwrap().to_owned(),
                        string(problem, "resolverPath").unwrap().to_owned(),
                        string(problem, "message").unwrap().to_owned(),
                        problem.get("missing") == Some(&Json::Bool(true)),
                    )
                })
                .collect();
            let claims = |path: &str| future_claims && path.starts_with("auth.claims");
            if future_claims {
                assert!(
                    error
                        .problems
                        .iter()
                        .any(|problem| problem.path == "auth.claims.secret" && problem.missing),
                    "{name}: the HTTPS claims hook reads its secret reference"
                );
            }
            let actual: Vec<_> = error
                .problems
                .iter()
                .filter(|problem| !claims(&problem.path))
                .map(|problem| {
                    (pointer(&problem.path), problem.path.clone(), problem.message.clone(), problem.missing)
                })
                .collect();
            assert_eq!(actual, wanted, "{name}");
            replayed += 1;
            continue;
        }
        let resolution = match result {
            Ok(resolution) => resolution,
            Err(error) => panic!("{name}: {}", error.message()),
        };
        assert_eq!(text(&resolution.config), text(expected.get("config").unwrap()), "{name}: config");
        let Some(Json::Object(sources)) = expected.get("sources") else { panic!("{name}: no sources") };
        let wanted: BTreeMap<_, _> =
            sources.iter().map(|(path, source)| (path.clone(), text(source))).collect();
        let actual: BTreeMap<_, _> = resolution
            .sources
            .iter()
            .map(|(path, source)| (path.clone(), text(&source_json(source))))
            .collect();
        assert_eq!(actual, wanted, "{name}: sources");
        let Some(Json::Array(secrets)) = expected.get("secrets") else { panic!("{name}: no secrets") };
        let wanted: Vec<_> = secrets.iter().map(text).collect();
        let actual: Vec<_> =
            resolution.secrets.iter().map(|secret| text(&Json::String(secret.clone()))).collect();
        assert_eq!(actual, wanted, "{name}: secrets");
        assert_eq!(
            format_config(&resolution, true),
            string(expected, "printWithSources").unwrap(),
            "{name}: print"
        );
        replayed += 1;
    }
    assert_eq!(replayed, 49);
}

#[test]
fn accepts_an_https_claims_hook_with_a_secret_reference() {
    let document = parse_json(
        r#"{"version":1,"config":{"mongodb":{"uri":"mongodb://127.0.0.1:27017/app"},"auth":{"kind":"builtin","secret":"ssssssssssssssssssssssssssssssss","claims":{"url":"https://hooks.example.test/claims","secret":{"$env":{"name":"CLAIMS_KEY","type":"string","secret":true,"optional":false}}}}}}"#,
    )
    .unwrap();
    let mut options = ResolveOptions {
        env: HashMap::from([("CLAIMS_KEY".to_owned(), "whsec_claims_fixture".to_owned())]),
        env_files: HashMap::new(),
        file: Some("/project/canopy.config.ts".to_owned()),
        base_dir: "/project".to_owned(),
        cwd: "/project".to_owned(),
        command: Command::Print,
    };
    let resolution = resolve_config(&document, &options).unwrap();
    assert_eq!(resolution.text("auth.claims.url"), Some("https://hooks.example.test/claims"));
    assert_eq!(resolution.text("auth.claims.secret"), Some("whsec_claims_fixture"));
    let printed = format_config(&resolution, true);
    assert!(printed.contains("auth.claims.secret = \"••••\"  (env CLAIMS_KEY)\n"), "{printed}");
    assert!(!printed.contains("whsec_claims_fixture"));

    options.env.clear();
    let Err(ResolveError::Config(error)) = resolve_config(&document, &options) else {
        panic!("expected problems")
    };
    assert_eq!(error.problems.len(), 1);
    assert_eq!(error.problems[0].path, "auth.claims.secret");
    assert!(error.problems[0].missing);

    let plain = parse_json(
        r#"{"version":1,"config":{"mongodb":{"uri":"mongodb://127.0.0.1:27017/app"},"auth":{"kind":"builtin","claims":{"url":"http://hooks.example.test/claims","secret":"whsec_x"}}}}"#,
    )
    .unwrap();
    options.env.clear();
    let Err(ResolveError::Config(error)) = resolve_config(&plain, &options) else {
        panic!("expected problems")
    };
    assert_eq!(error.problems[0].path, "auth.claims.url");
}

#[test]
fn refuses_malformed_documents_with_a_pointer() {
    let options = ResolveOptions {
        env: HashMap::new(),
        env_files: HashMap::new(),
        file: None,
        base_dir: "/project".to_owned(),
        cwd: "/project".to_owned(),
        command: Command::Print,
    };
    for (document, path) in [
        (r#"{"version":2,"config":{}}"#, "/version"),
        (r#"{"version":1,"config":[]}"#, "/config"),
        (r#"{"version":1,"config":{},"extra":1}"#, "/extra"),
        (
            r#"{"version":1,"config":{"server":{"port":{"$env":{"name":"9X","type":"int","secret":false,"optional":false}}}}}"#,
            "/config/server/port/$env",
        ),
        (
            r#"{"version":1,"config":{"masterKey":{"$env":{"name":"K","type":"string","secret":true,"optional":false,"default":"x"}}}}"#,
            "/config/masterKey/$env",
        ),
        (
            r#"{"version":1,"config":{"a/b":{"$env":{"name":"K","type":"text","secret":false,"optional":false}}}}"#,
            "/config/a~1b/$env",
        ),
    ] {
        let Err(ResolveError::Document(error)) = resolve_config(&parse_json(document).unwrap(), &options)
        else {
            panic!("{document}: expected a document error")
        };
        assert_eq!(error.path, path, "{document}");
    }
}

#[test]
fn parses_env_files_like_the_typescript_loader() {
    let parsed = parse_env_file(
        "# comment\r\nexport A=1\r\nB = \"two\\nlines\" # note\nC='single # kept'\nD=plain # dropped\nbad line\nE=\nA=3\n",
    );
    assert_eq!(
        parsed,
        vec![
            ("A".to_owned(), "3".to_owned()),
            ("B".to_owned(), "two\nlines".to_owned()),
            ("C".to_owned(), "single # kept".to_owned()),
            ("D".to_owned(), "plain".to_owned()),
            ("E".to_owned(), String::new()),
        ]
    );
}
