//! Canopy's Document Level Security in Rust: the stored policy format read from the meta database, validation,
//! the compiler that turns permissive and restrictive policies into one MongoDB filter and the in process
//! matcher of that filter, policy variables and context lookups, field rules, immutable fields and explain.
//! It mirrors the TypeScript `@canopy/policy` package; vectors recorded from that package keep the two
//! byte identical. Every failure denies: a variable that cannot be resolved drops its policy, and an error
//! during evaluation yields DENY.

mod aggregate;
mod canonical;
mod context;
mod dates;
mod engine;
mod explain;
mod fields;
mod implication;
mod indexes;
mod lint;
mod model;
mod search;
mod simulation;
mod stored;
mod validate;
mod values;
mod variables;

pub use aggregate::{DEFAULT_PIPELINE_LIMITS, PipelineLimits, SecurePipelineOptions, secure_pipeline};
pub use canonical::parse_policy_set;
pub use context::{ContextQuery, context_names, context_query, lookup_values, select_values, ttl_ms};
pub use engine::{
    Clause, Compiled, EngineHooks, ExplainedPolicy, Explanation, NoHooks, PolicyEngine, PolicySet,
    PolicyVariableIssue, and, create_policy_set, deny_filter,
};
pub use explain::{
    AccessReport, ExplainRequest, OnceVariableIssue, access_report_document, describe_issue, explain_access,
    explain_context, explanation_document, field_access_document, format_access_report,
};
pub use fields::{
    FieldAccess, TEXT_SEARCH_DENIED, can_access, denied_paths, denies_text_search, document_paths,
    field_access, immutable_violations, intersect_projection, project_readable, to_projection,
};
pub use implication::{check_implied, equality_fields};
pub use indexes::{IndexAdvice, IndexCreation, IndexMode, IndexPlan, advise_indexes, plan_indexes};
pub use lint::{LintEnvironment, LintFinding, lint_policies};
pub use model::{
    CollectionFields, CollectionPolicies, ContextDefinitions, ContextLookup, FieldKind, FieldRule,
    FieldRules, Operation, PolicyDefinition, PolicyKind, RequestContext, Role, Roles, STORAGE_COLLECTION,
    context_lookup,
};
pub use search::{SEARCH_STAGES, SearchScope, secure_search_stage};
pub use simulation::{SimulationCase, SimulationOutcome, evaluate_in_memory};
pub use stored::{
    CONTEXT_DOCUMENT_ID, StoredCollectionPolicies, StoredMeta, StoredPolicy, contexts_from_stored,
    contexts_value, from_stored, hash_collection, hash_contexts, hash_policy_set, read_stored, to_stored,
};
pub use validate::{
    POLICY_LIMITS, PolicyLimits, policy_validation_error, validate_collection_policies, validate_contexts,
};
pub use variables::{
    MAX_VARIABLE_LIST, Resolution, VariableIssue, VariableIssueKind, claim_paths, read_claim, resolve_clause,
    shift_date, uses_now,
};
