//! Canopy's GraphQL API in the data plane: the schema each role set sees, generated from the policies and
//! collection schemas, and an executor that turns each root field into one read or write of `canopy-data`
//! and each relation level into one batched read.

// A GraphQL error carries its locations, path and extensions; errors are rare, so they are not boxed.
#![allow(clippy::result_large_err)]

pub mod build;
pub mod endpoint;
pub mod errors;
pub mod execute;
pub mod filters;
pub mod introspection;
pub mod limits;
pub mod model;
pub mod names;
pub mod values;
