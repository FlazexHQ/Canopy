export const setup = {
  title: "Set up Canopy Studio",
  stepsLabel: "Setup steps",
  stepOf: "Step {current} of {total}",
  steps: {
    claim: "Claim this server",
    doctor: "Check the deployment",
    collections: "Expose collections",
    connect: "Connect your app",
  },
  claim: {
    description:
      "Only someone with access to the server can claim it. On its first start the server printed a one time setup token to its logs.",
    token: "Setup token",
    tokenHint:
      'Look for the line starting with "Setup token" in the server output, for example with docker compose logs canopy.',
    email: "Owner email",
    password: "Password",
    passwordHint: "At least {min} characters.",
    confirm: "Confirm password",
    tooShort: "The password needs at least {min} characters.",
    mismatch: "The passwords do not match.",
    submit: "Claim and create the owner",
    submitting: "Claiming…",
  },
  doctor: {
    description:
      "These are the canopy doctor checks. Fix errors before you put real traffic on this server.",
    blocked: "Some checks failed. Fix them, or continue anyway if this is a test deployment.",
    continueAnyway: "Continue anyway",
    rerun: "Run the checks again",
  },
  collections: {
    description:
      "Pick the collections your app reads and writes directly, and a starter policy for each. You can refine the policies later in Policies.",
    none: "This database has no collections yet. Create one from your app, then expose it in Data.",
    expose: "Expose {name}",
    template: "Starter policy for {name}",
    documents: "{count} documents",
    publish: "Expose and publish",
    publishing: "Publishing…",
    skip: "Skip for now",
    published: "Published starter policies for {count} collections",
    comment: "Starter template from the setup wizard",
  },
  templates: {
    "owner-only": {
      label: "Owner only",
      description:
        "Each signed in user reads and writes only the documents whose ownerId is their user id.",
    },
    "tenant-scoped": {
      label: "Tenant scoped",
      description:
        "Members of a tenant share its documents; the orgId field must match the org_id claim.",
    },
    "public-read": {
      label: "Public read / owner write",
      description: "Anyone can read; only the owner can create, change or delete a document.",
    },
    "write-only": {
      label: "Write only intake",
      description: "Signed in users submit documents (feedback, forms) that nobody else can read.",
    },
  },
  connect: {
    description:
      "Browsers use the publishable key. It is public by design; the policies decide what it can reach.",
    key: "Publishable key",
    snippet: "Install @canopy/client, then:",
    snippetLabel: "the SDK snippet",
    keyLabel: "the publishable key",
    creating: "Creating a publishable key…",
    open: "Open Studio",
  },
} as const
