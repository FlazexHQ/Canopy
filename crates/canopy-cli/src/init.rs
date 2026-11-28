use std::path::{Path, PathBuf};
use std::process::ExitCode;

use canopy_mongo::mongodb::bson::{Document, doc};

use crate::invocation::Invocation;
use crate::meta::with_client;
use crate::templates::{
    OWNER_ONLY, PUBLIC_READ_OWNER_WRITE, PolicyTemplate, TEMPLATES, TENANT_SCOPED, closed_policy,
};
use crate::{error_line, output};

const CONFIG: &str = r#"import { defineConfig, env } from "canopy.js/config"

export default defineConfig({
  mongodb: { uri: env.secret("MONGODB_URI") },
  keys: {
    publishable: env.list.optional("CANOPY_PUBLISHABLE_KEYS"),
    secret: env.list.optional("CANOPY_SECRET_KEYS"),
  },
  policies: { dir: "./policies" },
  // Verify user tokens from your identity provider, for example:
  // auth: external.auth0({ domain: env("AUTH0_DOMAIN"), audience: "https://api.example.com" }),
  // (import external from "canopy.js/config" as well)
})
"#;

const ENV_EXAMPLE: &str =
    "# Copy to canopy/.env.local and fill in. canopy dev reads .env, .env.local, .env.development and
# .env.development.local next to canopy.config.ts; real environment variables always win.

# A replica set: change streams and transactions do not work on a standalone server.
# The database in the path is the app database.
MONGODB_URI=mongodb://localhost:27017/app?replicaSet=rs0

# Comma separated. A publishable key (canopy_pk_...) lets browsers connect as anon or with a user token;
# a secret key (canopy_sk_...) is the service role and bypasses every policy, so keep it on servers.
CANOPY_PUBLISHABLE_KEYS=
CANOPY_SECRET_KEYS=
";

const GITIGNORE_LINES: [&str; 4] = ["canopy/.env", "canopy/.env.*", "!canopy/.env.example", ".canopy/"];
const OWNER_FIELDS: [&str; 6] = ["ownerId", "userId", "owner", "createdBy", "authorId", "uid"];
const TENANT_FIELDS: [&str; 6] =
    ["tenantId", "orgId", "organizationId", "workspaceId", "teamId", "accountId"];

/// A package manager and the commands it uses: add, add as a development dependency, and run a binary.
struct PackageManager {
    add: &'static str,
    add_dev: &'static str,
    exec: &'static str,
}

const MANAGERS: [(&str, PackageManager); 5] = [
    ("bun.lock", PackageManager { add: "bun add", add_dev: "bun add -d", exec: "bunx" }),
    ("bun.lockb", PackageManager { add: "bun add", add_dev: "bun add -d", exec: "bunx" }),
    ("pnpm-lock.yaml", PackageManager { add: "pnpm add", add_dev: "pnpm add -D", exec: "pnpm exec" }),
    ("yarn.lock", PackageManager { add: "yarn add", add_dev: "yarn add -D", exec: "yarn" }),
    ("package-lock.json", PackageManager { add: "npm install", add_dev: "npm install -D", exec: "npx" }),
];
const NPM: PackageManager = PackageManager { add: "npm install", add_dev: "npm install -D", exec: "npx" };

fn package_manager(root: &Path) -> &'static PackageManager {
    MANAGERS.iter().find(|(lockfile, _)| root.join(lockfile).exists()).map_or(&NPM, |(_, manager)| manager)
}

/// The template a collection's documents suggest, from the fields of a sampled document.
fn suggest(fields: &[String]) -> Option<(&'static PolicyTemplate, &'static str)> {
    let has = |field: &str| fields.iter().any(|known| known == field);
    if let Some(tenant) = TENANT_FIELDS.into_iter().find(|field| has(field)) {
        return Some((&TENANT_SCOPED, tenant));
    }
    let owner = OWNER_FIELDS.into_iter().find(|field| has(field))?;
    Some((if has("published") { &PUBLIC_READ_OWNER_WRITE } else { &OWNER_ONLY }, owner))
}

fn file_name(collection: &str) -> String {
    let safe: String = collection
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') { c } else { '_' })
        .collect();
    format!("{safe}.ts")
}

fn shown(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .components()
        .map(|part| part.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

/// One policy file per collection of the app database, each starting closed.
fn introspect(uri: &str, database: &str, dir: &Path) -> Result<Vec<(PathBuf, String, String)>, String> {
    with_client(uri, |client| async move {
        let db = client.database(database);
        let mut names: Vec<String> = db
            .list_collection_names()
            .await
            .map_err(|error| error.to_string())?
            .into_iter()
            .filter(|name| !name.starts_with("system."))
            .collect();
        names.sort_by(|a, b| canopy_schema::js_cmp(a, b));
        output(format_args!("Connected to {database}: {} collections", names.len()))?;
        let mut files = Vec::new();
        for name in names {
            let sample = db
                .collection::<Document>(&name)
                .find_one(doc! {})
                .await
                .map_err(|error| error.to_string())?;
            let fields: Vec<String> =
                sample.map(|document| document.keys().cloned().collect()).unwrap_or_default();
            let path = dir.join("policies").join(file_name(&name));
            match suggest(&fields) {
                None => {
                    files.push((path, closed_policy(&name), "exposed: false, no policies yet".to_owned()))
                }
                Some((template, field)) => files.push((
                    path,
                    format!(
                        "// Suggested by canopy init from the {field} field.\n{}",
                        template.render(&name, field)
                    ),
                    format!("exposed: false, {} suggested", template.title.to_lowercase()),
                )),
            }
        }
        Ok(files)
    })
}

/// `canopy init`: adds a `canopy/` folder to an existing project (the config file, starter policy templates,
/// `.env.example`, and with `--mongodb-uri` one closed policy file per collection). Existing files are never
/// overwritten; outside `canopy/` only `.gitignore` changes.
pub(crate) fn run(call: &Invocation) -> Result<ExitCode, String> {
    let root = std::env::current_dir().map_err(|error| error.to_string())?;
    let uri = call.text("mongodb-uri");
    let database = call
        .text("database")
        .map(str::to_owned)
        .or_else(|| uri.and_then(canopy_config::authoring::database_from_uri))
        .unwrap_or_default();
    if uri.is_some() && database.is_empty() {
        return Err("init --mongodb-uri needs --database or a database in the URI path".to_owned());
    }
    if !root.join("package.json").exists() {
        return Err(format!(
            "No package.json in {}. canopy init adds Canopy to an existing project; it does not create one.",
            root.display()
        ));
    }
    let manager = package_manager(&root);
    let dir = root.join("canopy");
    let mut files: Vec<(PathBuf, String, Option<String>)> = vec![
        (dir.join("canopy.config.ts"), CONFIG.to_owned(), None),
        (dir.join(".env.example"), ENV_EXAMPLE.to_owned(), None),
    ];
    for (template, collection, field) in TEMPLATES {
        files.push((
            dir.join("policies").join("templates").join(template.file),
            template.render(collection, field),
            None,
        ));
    }
    if let Some(uri) = uri {
        match introspect(uri, &database, &dir) {
            Ok(introspected) => {
                files.extend(introspected.into_iter().map(|(path, text, note)| (path, text, Some(note))))
            }
            Err(message) => {
                error_line(format_args!("Cannot introspect the database: {message}"))?;
                return Ok(ExitCode::FAILURE);
            }
        }
    }
    for (path, content, note) in files {
        let name = shown(&root, &path);
        if path.exists() {
            output(format_args!("  exists  {name}  (kept)"))?;
            continue;
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| format!("{}: {error}", parent.display()))?;
        }
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .and_then(|mut file| std::io::Write::write_all(&mut file, content.as_bytes()))
            .map_err(|error| format!("{}: {error}", path.display()))?;
        match note {
            Some(note) => output(format_args!("  create  {name}  {note}"))?,
            None => output(format_args!("  create  {name}"))?,
        }
    }
    std::fs::create_dir_all(dir.join("policies")).map_err(|error| error.to_string())?;
    let gitignore = root.join(".gitignore");
    let current = match std::fs::read_to_string(&gitignore) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(format!("{}: {error}", gitignore.display())),
    };
    let have: Vec<&str> = current.lines().map(str::trim).collect();
    let missing: Vec<&str> = GITIGNORE_LINES.into_iter().filter(|line| !have.contains(line)).collect();
    if !missing.is_empty() {
        let prefix = if current.is_empty() || current.ends_with('\n') { "" } else { "\n" };
        std::fs::write(&gitignore, format!("{current}{prefix}{}\n", missing.join("\n")))
            .map_err(|error| format!("{}: {error}", gitignore.display()))?;
        output(format_args!(
            "  {}  .gitignore  + {}",
            if current.is_empty() { "create" } else { "update" },
            missing.join(", ")
        ))?;
    }
    output(format_args!(""))?;
    output(format_args!("Next:"))?;
    output(format_args!("  1. {} canopy.js && {} @canopy/cli", manager.add, manager.add_dev))?;
    output(format_args!(
        "  2. {} canopy dev --with-mongo  (starts a local MongoDB; or set MONGODB_URI in canopy/.env.local and run canopy dev)",
        manager.exec
    ))?;
    output(format_args!("  3. Open the Studio URL it prints and claim the project with the setup token"))?;
    output(format_args!(
        "  4. Write the policies of a collection in canopy/policies (start from ./templates), then set exposed: true"
    ))?;
    Ok(ExitCode::SUCCESS)
}

#[cfg(test)]
mod tests {
    use super::{file_name, suggest};

    #[test]
    fn suggests_tenants_before_owners_and_public_read_for_published_documents() {
        let fields = |names: &[&str]| names.iter().map(|name| (*name).to_owned()).collect::<Vec<_>>();
        assert_eq!(
            suggest(&fields(&["ownerId", "orgId"])).map(|(t, f)| (t.file, f)),
            Some(("tenant-scoped.ts", "orgId"))
        );
        assert_eq!(
            suggest(&fields(&["authorId", "published"])).map(|(t, f)| (t.file, f)),
            Some(("public-read-owner-write.ts", "authorId"))
        );
        assert_eq!(suggest(&fields(&["uid"])).map(|(t, f)| (t.file, f)), Some(("owner-only.ts", "uid")));
        assert!(suggest(&fields(&["title"])).is_none());
        assert_eq!(file_name("a b/c:d.é"), "a_b_c_d._.ts");
    }
}
