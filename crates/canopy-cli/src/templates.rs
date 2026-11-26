use canopy_protocol::json::write_json_string;

/// A starter policy template written by `canopy init`.
pub(crate) struct PolicyTemplate {
    /// The file name under `canopy/policies/templates/`.
    pub(crate) file: &'static str,
    pub(crate) title: &'static str,
    render: fn(&str, &str) -> String,
}

impl PolicyTemplate {
    /// The policy module for a collection, keyed on one field.
    pub(crate) fn render(&self, collection: &str, field: &str) -> String {
        (self.render)(collection, field)
    }
}

fn quote(text: &str) -> String {
    let mut out = String::new();
    write_json_string(&mut out, text);
    out
}

fn header(title: &str, lines: &[&str]) -> String {
    let mut out = vec![format!("// {title}")];
    out.extend(lines.iter().map(|line| if line.is_empty() { "//".to_owned() } else { format!("// {line}") }));
    out.join("\n")
}

fn owner_only(collection: &str, field: &str) -> String {
    let header = header(
        "Owner only",
        &[
            &format!("Every document belongs to the user in {field}; nobody else can see or change it."),
            "Set exposed: true once the policies below match your data.",
        ],
    );
    let (name, key) = (quote(collection), quote(field));
    format!(
        r#"{header}
import {{ allow, auth, collection }} from "canopy.js/policy"

export default collection({name}, {{
  exposed: false,
  realtime: true,
  policies: [
    allow
      .read("authenticated")
      .where({{ {field}: auth("sub") }})
      .named("owner reads"),
    allow
      .insert("authenticated")
      .check({{ {field}: auth("sub") }})
      .named("owner creates"),
    allow
      .update("authenticated")
      .where({{ {field}: auth("sub") }})
      .check({{ {field}: auth("sub") }})
      .named("owner edits"),
    allow
      .delete("authenticated")
      .where({{ {field}: auth("sub") }})
      .named("owner deletes"),
  ],
  immutable: [{key}],
}})
"#
    )
}

fn tenant_scoped(collection: &str, field: &str) -> String {
    let header = header(
        "Tenant scoped",
        &[
            &format!("Documents belong to the tenant in {field}; every member of that tenant may use them."),
            "The tenant comes from the org_id claim of the token. When membership lives in MongoDB instead, declare",
            "a context lookup in policies/_context.ts and compare with ctx(\"tenantIds\") using $in.",
            "Set exposed: true once the policies below match your data.",
        ],
    );
    let (name, key) = (quote(collection), quote(field));
    format!(
        r#"{header}
import {{ allow, auth, collection }} from "canopy.js/policy"

export default collection({name}, {{
  exposed: false,
  realtime: true,
  policies: [
    allow
      .ops(["read", "delete"], "authenticated")
      .where({{ {field}: auth("org_id") }})
      .named("members read and delete"),
    allow
      .insert("authenticated")
      .check({{ {field}: auth("org_id") }})
      .named("members create in their tenant"),
    allow
      .update("authenticated")
      .where({{ {field}: auth("org_id") }})
      .check({{ {field}: auth("org_id") }})
      .named("members edit"),
  ],
  immutable: [{key}],
}})
"#
    )
}

fn public_read_owner_write(collection: &str, field: &str) -> String {
    let header = header(
        "Public read, owner write",
        &[
            &format!(
                "Anyone, signed in or not, reads published documents. The user in {field} writes them and also"
            ),
            "sees their drafts.",
            "Set exposed: true once the policies below match your data.",
        ],
    );
    let (name, key) = (quote(collection), quote(field));
    format!(
        r#"{header}
import {{ allow, auth, collection }} from "canopy.js/policy"

export default collection({name}, {{
  exposed: false,
  realtime: true,
  policies: [
    allow.read("public").where({{ published: true }}).named("anyone reads published"),
    allow
      .read("authenticated")
      .where({{ {field}: auth("sub") }})
      .named("author reads drafts"),
    allow
      .insert("authenticated")
      .check({{ {field}: auth("sub") }})
      .named("author creates"),
    allow
      .update("authenticated")
      .where({{ {field}: auth("sub") }})
      .check({{ {field}: auth("sub") }})
      .named("author edits"),
    allow
      .delete("authenticated")
      .where({{ {field}: auth("sub") }})
      .named("author deletes"),
  ],
  immutable: [{key}],
}})
"#
    )
}

fn write_only_intake(collection: &str, field: &str) -> String {
    let header = header(
        "Write only intake",
        &[
            "A contact form or feedback box: anyone may insert a document, nobody can read, change or delete",
            "one through Canopy. Read submissions with a secret key on your server.",
            "Set exposed: true once the policies below match your data.",
        ],
    );
    let (name, key) = (quote(collection), quote(field));
    format!(
        r#"{header}
import {{ allow, collection }} from "canopy.js/policy"

export default collection({name}, {{
  exposed: false,
  realtime: false,
  policies: [
    allow
      .insert("public")
      .check({{ {field}: {{ $type: "string" }}, status: "new" }})
      .named("anyone submits"),
  ],
  fields: {{
    write: {{ default: {{ only: [{key}, "message", "status"] }} }},
  }},
}})
"#
    )
}

/// Every document belongs to one user, who alone may read and change it.
pub(crate) const OWNER_ONLY: PolicyTemplate =
    PolicyTemplate { file: "owner-only.ts", title: "Owner only", render: owner_only };
/// Documents belong to a tenant named by a token claim; every member of the tenant may use them.
pub(crate) const TENANT_SCOPED: PolicyTemplate =
    PolicyTemplate { file: "tenant-scoped.ts", title: "Tenant scoped", render: tenant_scoped };
/// Published documents are public; their author writes them.
pub(crate) const PUBLIC_READ_OWNER_WRITE: PolicyTemplate = PolicyTemplate {
    file: "public-read-owner-write.ts",
    title: "Public read, owner write",
    render: public_read_owner_write,
};
const WRITE_ONLY_INTAKE: PolicyTemplate =
    PolicyTemplate { file: "write-only-intake.ts", title: "Write only intake", render: write_only_intake };

/// The starter templates with the collection and key field each example uses.
pub(crate) const TEMPLATES: [(&PolicyTemplate, &str, &str); 4] = [
    (&OWNER_ONLY, "notes", "ownerId"),
    (&TENANT_SCOPED, "projects", "orgId"),
    (&PUBLIC_READ_OWNER_WRITE, "posts", "authorId"),
    (&WRITE_ONLY_INTAKE, "feedback", "email"),
];

/// A collection with no policies, so nothing is exposed until someone writes them.
pub(crate) fn closed_policy(collection: &str) -> String {
    let name = quote(collection);
    format!(
        r#"// Nothing in {collection} is reachable through Canopy yet. Copy a policy from ./templates,
// then set exposed: true.
import {{ collection }} from "canopy.js/policy"

export default collection({name}, {{
  exposed: false,
  policies: [],
}})
"#
    )
}
