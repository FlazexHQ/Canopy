use std::sync::{Arc, RwLock};

use canopy_policy::PolicyEngine;

/// The policy engine in force, replaceable while requests run: a request keeps the engine it started with.
#[derive(Debug, Clone)]
pub struct Policies {
    current: Arc<RwLock<Arc<PolicyEngine>>>,
}

impl Policies {
    /// Starts with `engine`.
    pub fn new(engine: PolicyEngine) -> Policies {
        Policies { current: Arc::new(RwLock::new(Arc::new(engine))) }
    }

    /// The engine in force now.
    pub fn current(&self) -> Arc<PolicyEngine> {
        Arc::clone(&self.current.read().unwrap_or_else(std::sync::PoisonError::into_inner))
    }

    /// Replaces the engine, for policies published while the server runs.
    pub fn replace(&self, engine: PolicyEngine) {
        *self.current.write().unwrap_or_else(std::sync::PoisonError::into_inner) = Arc::new(engine);
    }
}
