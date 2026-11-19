//! What every port of the Canopy core shares, whatever the language on the other side: the Node-API addon and
//! the WebAssembly builds. Values cross the boundary as EJSON text or raw BSON, and every failure is a
//! [`CanopyError`](canopy_protocol::CanopyError), so a port only converts types and errors and cannot decide
//! anything differently from another port.

pub mod codec;
pub mod filter;
pub mod policy;
pub mod query;

pub use codec::{bson_to_ejson, canonical, document_of, ejson_to_bson, value_of};
pub use filter::{MATCH, NO_MATCH, UNDECIDED, compile_ejson, decide, decide_concatenated, split_documents};
pub use policy::{Access, Evaluation, EvaluationError, PortPolicyEngine, VariableIssue, request_of};
pub use query::{QueryKey, canonical_query_text, query_hash_text};
