use canopy_mongo::mongodb::{
    Database,
    bson::{Bson, Document, doc},
};
use canopy_protocol::CanopyError;

use crate::{has_code, mongo_error};

pub(super) const NAMES: [&str; 6] = [
    "create-meta-collections",
    "create-request-log",
    "create-admin-tokens",
    "create-webhooks",
    "create-storage",
    "create-storage-variants",
];

async fn create(meta: &Database, name: &str, indexes: &[Document]) -> Result<(), CanopyError> {
    match meta.create_collection(name).await {
        Ok(()) => {}
        Err(error) if has_code(&error, 48) => {}
        Err(error) => return Err(mongo_error(error)),
    }
    create_indexes(meta, name, indexes).await
}

async fn create_indexes(meta: &Database, name: &str, indexes: &[Document]) -> Result<(), CanopyError> {
    for index in indexes {
        match meta.run_command(doc! { "createIndexes": name, "indexes": [index.clone()] }).await {
            Ok(_) => {}
            Err(error) if has_code(&error, 85) || has_code(&error, 86) => {}
            Err(error) => return Err(mongo_error(error)),
        }
    }
    Ok(())
}

async fn create_meta(meta: &Database) -> Result<(), CanopyError> {
    create(meta, "policies", &[]).await?;
    create(
        meta,
        "policy_history",
        &[doc! { "key": { "collection": 1, "version": -1 }, "name": "collection_version", "unique": true }],
    )
    .await?;
    create(
        meta,
        "audit_log",
        &[
            doc! { "key": { "at": -1 }, "name": "at" },
            doc! { "key": { "action": 1, "at": -1 }, "name": "action_at" },
            doc! { "key": { "actor.id": 1, "at": -1 }, "name": "actor_at" },
        ],
    )
    .await?;
    create(meta, "api_keys", &[
        doc! { "key": { "hash": 1 }, "name": "hash", "unique": true, "partialFilterExpression": { "hash": { "$type": "string" } } },
        doc! { "key": { "key": 1 }, "name": "key", "unique": true, "partialFilterExpression": { "key": { "$type": "string" } } },
    ]).await?;
    create(meta, "admin_users", &[doc! { "key": { "email": 1 }, "name": "email", "unique": true }]).await?;
    create(
        meta,
        "admin_sessions",
        &[
            doc! { "key": { "expiresAt": 1 }, "name": "ttl_expires", "expireAfterSeconds": 0 },
            doc! { "key": { "userId": 1 }, "name": "user" },
        ],
    )
    .await?;
    create(
        meta,
        "revocations",
        &[doc! { "key": { "expiresAt": 1 }, "name": "ttl_expires", "expireAfterSeconds": 0 }],
    )
    .await?;
    create(meta, "mutations", &[doc! { "key": { "at": 1 }, "name": "ttl_at", "expireAfterSeconds": 86_400 }])
        .await?;
    create(meta, "settings", &[]).await
}

async fn create_request_log(meta: &Database) -> Result<(), CanopyError> {
    let settings = meta
        .collection::<Document>("settings")
        .find_one(doc! { "_id": "settings" })
        .await
        .map_err(mongo_error)?;
    let days = match settings.as_ref().and_then(|settings| settings.get("requestLogRetentionDays")) {
        Some(Bson::Int32(days)) if *days > 0 => f64::from(*days),
        Some(Bson::Int64(days)) if *days > 0 && *days <= 9_007_199_254_740_991 => *days as f64,
        Some(Bson::Double(days)) if days.is_finite() && *days > 0.0 && days.fract() == 0.0 => *days,
        _ => 7.0,
    };
    let seconds = days * 86_400.0;
    let seconds =
        if seconds <= f64::from(i32::MAX) { Bson::Int32(seconds as i32) } else { Bson::Double(seconds) };
    create(
        meta,
        "request_log",
        &[doc! { "key": { "at": 1 }, "name": "ttl_at", "expireAfterSeconds": seconds }],
    )
    .await
}

async fn create_webhooks(meta: &Database) -> Result<(), CanopyError> {
    create(
        meta,
        "webhook_deliveries",
        &[
            doc! { "key": { "status": 1, "nextAt": 1 }, "name": "status_next" },
            doc! { "key": { "status": 1, "lockedUntil": 1 }, "name": "status_locked" },
            doc! { "key": { "hook": 1, "status": 1 }, "name": "hook_status" },
            doc! { "key": { "expiresAt": 1 }, "name": "ttl_expires", "expireAfterSeconds": 0 },
        ],
    )
    .await?;
    create(
        meta,
        "webhook_dead_letters",
        &[
            doc! { "key": { "failedAt": -1 }, "name": "failed" },
            doc! { "key": { "hook": 1, "failedAt": -1 }, "name": "hook_failed" },
        ],
    )
    .await?;
    create(meta, "webhook_schedules", &[]).await
}

pub(super) async fn apply(meta: &Database, version: i32) -> Result<(), CanopyError> {
    match version {
        1 => create_meta(meta).await,
        2 => create_request_log(meta).await,
        3 => {
            create(
                meta,
                "admin_tokens",
                &[
                    doc! { "key": { "hash": 1 }, "name": "hash", "unique": true },
                    doc! { "key": { "userId": 1, "createdAt": -1 }, "name": "user_created" },
                ],
            )
            .await
        }
        4 => create_webhooks(meta).await,
        5 => {
            create(
                meta,
                "storage_objects",
                &[
                    doc! { "key": { "bucket": 1, "path": 1 }, "name": "bucket_path", "unique": true },
                    doc! { "key": { "owner": 1 }, "name": "owner" },
                ],
            )
            .await?;
            create(meta, "storage_uploads", &[doc! { "key": { "expiresAt": 1 }, "name": "expires" }]).await
        }
        6 => {
            let index = doc! { "key": { "key": 1 }, "name": "key" };
            create_indexes(meta, "storage_objects", std::slice::from_ref(&index)).await?;
            create(meta, "storage_variants", &[index]).await
        }
        _ => Err(CanopyError::new(canopy_protocol::ErrorCode::Internal, "Unknown meta migration")),
    }
}
