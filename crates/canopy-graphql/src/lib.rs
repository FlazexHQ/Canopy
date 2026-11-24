//! Canopy's GraphQL API in the data plane: the schema each role set sees, generated from the policies and
//! collection schemas, and an executor that turns each root field into one read or write of `canopy-data`
//! and each relation level into one batched read.

pub mod build;
pub mod errors;
pub mod execute;
pub mod filters;
pub mod limits;
pub mod model;
pub mod names;
pub mod values;
