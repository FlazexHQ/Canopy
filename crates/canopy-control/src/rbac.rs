//! The admin roles and what each may do.

/// An admin role, from most to least privileged.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AdminRole {
    /// Everything, including managing owners.
    Owner,
    /// Everything except managing owners.
    Admin,
    /// Policies, data and the realtime inspector; publishing and data edits only outside production.
    Developer,
    /// Dashboards and data, with fields hidden by DLS masked.
    Viewer,
}

/// Every admin role, from most to least privileged.
pub const ADMIN_ROLES: [AdminRole; 4] =
    [AdminRole::Owner, AdminRole::Admin, AdminRole::Developer, AdminRole::Viewer];

/// The names of the admin roles, in the same order.
pub const ROLE_NAMES: [&str; 4] = ["owner", "admin", "developer", "viewer"];

impl AdminRole {
    /// The role's name.
    pub fn as_str(self) -> &'static str {
        match self {
            AdminRole::Owner => "owner",
            AdminRole::Admin => "admin",
            AdminRole::Developer => "developer",
            AdminRole::Viewer => "viewer",
        }
    }

    /// The role of a name.
    pub fn parse(name: &str) -> Option<AdminRole> {
        ADMIN_ROLES.into_iter().find(|role| role.as_str() == name)
    }

    /// How much a role may do: higher is more.
    fn rank(self) -> usize {
        match self {
            AdminRole::Owner => 4,
            AdminRole::Admin => 3,
            AdminRole::Developer => 2,
            AdminRole::Viewer => 1,
        }
    }

    /// Whether this role may do no more than `limit`.
    pub fn at_most(self, limit: AdminRole) -> bool {
        self.rank() <= limit.rank()
    }

    /// The less privileged of two roles.
    pub fn lower(self, other: AdminRole) -> AdminRole {
        if self.rank() <= other.rank() { self } else { other }
    }
}

/// What an admin request may need.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Permission {
    /// `/me`, logout, the own password and TOTP.
    Session,
    /// Collections and their schemas.
    CollectionsRead,
    /// Expose and realtime toggles, which publish a new policy version.
    CollectionsWrite,
    /// Reading documents as `service` (viewers see fields hidden by DLS masked).
    DocumentsRead,
    /// Writing documents.
    DocumentsWrite,
    /// Reading through DLS as a role, user or claims.
    DocumentsViewAs,
    /// Writing as an impersonated caller, which also needs a reason.
    DocumentsWriteAs,
    /// Reading policies.
    PoliciesRead,
    /// Validating, simulating and explaining policies.
    PoliciesSimulate,
    /// Publishing and rolling back policies.
    PoliciesPublish,
    /// Listing API keys.
    KeysRead,
    /// Creating and revoking publishable keys.
    KeysPublishable,
    /// Creating and revoking secret keys.
    KeysSecret,
    /// Realtime counters.
    RealtimeStats,
    /// Connections, observers, the event tail and traces, which show subjects and filters.
    RealtimeInspect,
    /// The doctor checks.
    OpsDoctor,
    /// The audit and request logs.
    OpsAudit,
    /// Reading settings.
    SettingsRead,
    /// Changing settings.
    SettingsWrite,
    /// Listing admins.
    AdminsRead,
    /// Creating and changing admins below `owner`.
    AdminsManage,
    /// Creating, changing and removing owners.
    AdminsManageOwners,
    /// App users of built in auth, their sessions and the signing keys (read only).
    UsersRead,
    /// Creating, changing, banning and deleting app users, and ending their sessions.
    UsersManage,
    /// Triggers, schedules and dead letters, whose payloads hold documents.
    WebhooksRead,
    /// Retrying and deleting dead letters, and running schedules.
    WebhooksManage,
}

/// The permissions `GET /admin/v1/me` reports, in the order it reports them.
pub(crate) const REPORTED: [(Permission, &str); 23] = [
    (Permission::CollectionsRead, "collections.read"),
    (Permission::CollectionsWrite, "collections.write"),
    (Permission::DocumentsRead, "documents.read"),
    (Permission::DocumentsWrite, "documents.write"),
    (Permission::DocumentsViewAs, "documents.viewAs"),
    (Permission::DocumentsWriteAs, "documents.writeAs"),
    (Permission::PoliciesRead, "policies.read"),
    (Permission::PoliciesSimulate, "policies.simulate"),
    (Permission::PoliciesPublish, "policies.publish"),
    (Permission::KeysRead, "keys.read"),
    (Permission::KeysPublishable, "keys.publishable"),
    (Permission::KeysSecret, "keys.secret"),
    (Permission::RealtimeStats, "realtime.stats"),
    (Permission::RealtimeInspect, "realtime.inspect"),
    (Permission::OpsDoctor, "ops.doctor"),
    (Permission::OpsAudit, "ops.audit"),
    (Permission::SettingsRead, "settings.read"),
    (Permission::SettingsWrite, "settings.write"),
    (Permission::AdminsRead, "admins.read"),
    (Permission::AdminsManage, "admins.manage"),
    (Permission::AdminsManageOwners, "admins.manageOwners"),
    (Permission::UsersRead, "users.read"),
    (Permission::UsersManage, "users.manage"),
];

const DEVELOPER: [Permission; 17] = [
    Permission::Session,
    Permission::CollectionsRead,
    Permission::CollectionsWrite,
    Permission::DocumentsRead,
    Permission::DocumentsWrite,
    Permission::DocumentsViewAs,
    Permission::DocumentsWriteAs,
    Permission::PoliciesRead,
    Permission::PoliciesSimulate,
    Permission::PoliciesPublish,
    Permission::KeysRead,
    Permission::KeysPublishable,
    Permission::RealtimeStats,
    Permission::RealtimeInspect,
    Permission::OpsDoctor,
    Permission::UsersRead,
    Permission::WebhooksRead,
];

const DEVELOPER_NOT_IN_PRODUCTION: [Permission; 4] = [
    Permission::CollectionsWrite,
    Permission::DocumentsWrite,
    Permission::DocumentsWriteAs,
    Permission::PoliciesPublish,
];

const VIEWER: [Permission; 6] = [
    Permission::Session,
    Permission::CollectionsRead,
    Permission::DocumentsRead,
    Permission::PoliciesRead,
    Permission::RealtimeStats,
    Permission::OpsDoctor,
];

/// Whether `role` may do what `permission` covers. `owner` may do everything; `admin` everything except
/// managing owners; `developer` drafts, simulates and publishes policies, browses data, uses the realtime
/// inspector and manages publishable keys, and publishes and edits data only outside production; `viewer`
/// reads dashboards and data with DLS hidden fields masked.
pub fn can(role: AdminRole, permission: Permission, production: bool) -> bool {
    match role {
        AdminRole::Owner => true,
        AdminRole::Admin => permission != Permission::AdminsManageOwners,
        AdminRole::Developer => {
            !(production && DEVELOPER_NOT_IN_PRODUCTION.contains(&permission))
                && DEVELOPER.contains(&permission)
        }
        AdminRole::Viewer => VIEWER.contains(&permission),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_permission_table_matches_the_roles() {
        assert!(can(AdminRole::Owner, Permission::AdminsManageOwners, true));
        assert!(!can(AdminRole::Admin, Permission::AdminsManageOwners, false));
        assert!(can(AdminRole::Admin, Permission::UsersManage, true));
        assert!(can(AdminRole::Developer, Permission::PoliciesPublish, false));
        assert!(!can(AdminRole::Developer, Permission::PoliciesPublish, true));
        assert!(can(AdminRole::Developer, Permission::PoliciesSimulate, true));
        assert!(!can(AdminRole::Developer, Permission::KeysSecret, false));
        assert!(!can(AdminRole::Developer, Permission::WebhooksManage, false));
        assert!(can(AdminRole::Viewer, Permission::DocumentsRead, false));
        assert!(!can(AdminRole::Viewer, Permission::WebhooksRead, false));
        assert!(!can(AdminRole::Viewer, Permission::UsersRead, false));
    }

    #[test]
    fn roles_order_from_owner_to_viewer() {
        assert!(AdminRole::Viewer.at_most(AdminRole::Developer));
        assert!(!AdminRole::Owner.at_most(AdminRole::Admin));
        assert_eq!(AdminRole::Owner.lower(AdminRole::Developer), AdminRole::Developer);
        assert_eq!(AdminRole::parse("admin"), Some(AdminRole::Admin));
        assert_eq!(AdminRole::parse("root"), None);
        assert_eq!(ROLE_NAMES.map(AdminRole::parse), ADMIN_ROLES.map(Some));
    }
}
