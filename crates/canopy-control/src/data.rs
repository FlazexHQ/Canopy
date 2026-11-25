use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use canopy_auth::Authenticator;
use canopy_config::WriteSettings;
use canopy_data::schema::{SchemaCache, SchemaCacheOptions};
use canopy_data::writes::{IdType, WriteOp, WriteOptions, WritePath, WriteRequest, parse_id};
use canopy_data::{Caller, FindRequest, Policies, ReadLimits, ReadPath};
use canopy_graphql::endpoint::{Graphql, GraphqlOptions};
use canopy_http::{PageLimits, Rest, RestOptions, find_params_from_query, uuid_v7};
use canopy_mongo::mongodb::bson::{Bson, Document as BsonDocument, doc};
use canopy_mongo::mongodb::results::CollectionType;
use canopy_mongo::mongodb::{Client, Database};
use canopy_policy::{PolicyEngine, RequestContext, Role, project_readable};
use canopy_protocol::ejson::{DecodeOptions, decode, stringify};
use canopy_protocol::json::parse_json;
use canopy_protocol::{CanopyError, Document, ErrorCode, Value};
use futures_util::TryStreamExt;

use crate::core::{details, err, mongo, to_value};
use crate::policies::{collection_name, impersonate};
use crate::schema::{Schema, optional, string};
use crate::{AdminRole, BoxFuture, Call, Clock, Delegate, Permission, Reply};

type WriteObserver = Arc<dyn Fn(&canopy_data::writes::WriteEvent) + Send + Sync>;

/// Admin access to collection metadata and the shared application data paths.
pub struct DataRoutes {
    client: Client,
    app: Database,
    meta: Database,
    schemas: SchemaCache,
    now: Clock,
    id_types: HashMap<String, IdType>,
    writes: WriteSettings,
    write_observer: Option<WriteObserver>,
    rest_enabled: bool,
    graphql: Option<(Authenticator, GraphqlOptions, ReadLimits)>,
}

impl DataRoutes {
    /// Serves admin data routes over the application and meta databases.
    pub fn new(client: Client, database: &str, meta_database: &str, now: Clock) -> Self {
        let app = client.database(database);
        let meta = client.database(meta_database);
        Self {
            client,
            schemas: SchemaCache::new(app.clone(), SchemaCacheOptions::default()),
            app,
            meta,
            now,
            id_types: HashMap::new(),
            writes: WriteSettings::default(),
            write_observer: None,
            rest_enabled: true,
            graphql: None,
        }
    }

    /// Applies the deployment's REST toggle and write settings.
    #[must_use]
    pub fn with_rest(mut self, enabled: bool, writes: WriteSettings) -> Self {
        self.id_types = writes
            .id_types
            .iter()
            .filter_map(|(name, kind)| IdType::parse(kind).map(|kind| (name.clone(), kind)))
            .collect();
        self.writes = writes;
        self.rest_enabled = enabled;
        self
    }

    /// Observes committed document and GraphQL writes.
    #[must_use]
    pub fn with_write_observer(mut self, observer: WriteObserver) -> Self {
        self.write_observer = Some(observer);
        self
    }

    /// Enables the GraphQL explorer with the deployment's GraphQL settings and page limits.
    #[must_use]
    pub fn with_graphql(mut self, auth: Authenticator, options: GraphqlOptions, limits: ReadLimits) -> Self {
        self.graphql = Some((auth, options, limits));
        self
    }

    async fn reads(&self, limits: ReadLimits) -> Result<ReadPath, CanopyError> {
        let set = canopy_mongo::load_policies(&self.meta).await?;
        Ok(ReadPath::new(self.client.clone(), self.app.name(), Policies::new(PolicyEngine::new(set)), limits))
    }

    fn writes(&self, reads: &ReadPath) -> Result<WritePath, CanopyError> {
        let writes =
            WritePath::new(self.client.clone(), self.app.name(), self.meta.name(), reads.policies().clone())?
                .with_mutation_ttl(self.writes.mutation_ttl_seconds)
                .with_explained_denials(self.writes.explain_denials);
        Ok(match &self.write_observer {
            Some(observer) => writes.with_observer(Arc::clone(observer)),
            None => writes,
        })
    }

    async fn caller(
        &self,
        reads: &ReadPath,
        collection: Option<&[&str]>,
        input: Option<&Value>,
    ) -> Result<Caller, CanopyError> {
        let now = (self.now)();
        let Some(input) = input else {
            return Ok(Caller {
                context: RequestContext {
                    roles: [Role::SERVICE].into_iter().collect(),
                    claims: None,
                    ctx: None,
                    now,
                },
                subject: Role::SERVICE.to_owned(),
            });
        };
        let context =
            impersonate(Some(input), collection, &reads.policies().current(), reads.contexts(), now).await?;
        let subject = context
            .claims
            .as_ref()
            .and_then(|claims| claims.get("sub"))
            .and_then(Value::as_str)
            .map_or_else(|| context.roles.iter().collect::<Vec<_>>().join(","), str::to_owned);
        Ok(Caller { context, subject })
    }

    async fn collections(&self) -> Result<Reply, CanopyError> {
        let set = canopy_mongo::load_policies(&self.meta).await?;
        let listed = self.app.list_collections().await.map_err(mongo)?;
        let mut names = BTreeMap::new();
        let listed = listed.try_collect::<Vec<_>>().await.map_err(mongo)?;
        for info in listed.into_iter().filter(|info| !info.name.starts_with("system.")) {
            names.insert(
                info.name,
                match info.collection_type {
                    CollectionType::Collection => "collection",
                    CollectionType::View => "view",
                    CollectionType::Timeseries => "timeseries",
                    _ => "collection",
                },
            );
        }
        let stored = self
            .meta
            .collection::<BsonDocument>("policies")
            .find(doc! {})
            .await
            .map_err(mongo)?
            .try_collect::<Vec<_>>()
            .await
            .map_err(mongo)?;
        for definition in set.collections() {
            names.entry(definition.collection.clone()).or_insert("missing");
        }
        let mut data = Vec::new();
        let mut names: Vec<_> = names.into_iter().collect();
        names.sort_by(|(left, _), (right, _)| left.encode_utf16().cmp(right.encode_utf16()));
        for (name, kind) in names {
            let definition = set.collection(&name);
            let version = stored
                .iter()
                .find(|entry| entry.get_str("_id").ok() == Some(name.as_str()))
                .and_then(|entry| entry.get("version").cloned())
                .unwrap_or(Bson::Int32(0));
            let mut entry = doc! {
                "name": &name, "type": kind, "exists": kind != "missing",
                "exposed": definition.is_some_and(|definition| definition.exposed),
                "realtime": definition.is_some_and(|definition| definition.realtime),
                "policies": definition.map_or(0, |definition| i64::try_from(definition.policies.len()).unwrap_or(i64::MAX)),
                "version": version,
            };
            if let Some((_, hash)) = set.hashes().iter().find(|(collection, _)| collection == &name) {
                entry.insert("hash", hash);
            }
            data.push(entry);
        }
        json(&doc! { "data": data })
    }

    async fn stats(&self, collection: &str) -> Result<Reply, CanopyError> {
        if self
            .app
            .list_collection_names()
            .filter(doc! { "name": collection })
            .await
            .map_err(mongo)?
            .is_empty()
        {
            return Err(err(ErrorCode::NotFound, format!("The collection {collection} does not exist")));
        }
        let handle = self.app.collection::<BsonDocument>(collection);
        let stats = handle
            .aggregate([doc! { "$collStats": { "storageStats": {} } }])
            .await
            .map_err(mongo)?
            .try_next()
            .await
            .map_err(mongo)?;
        let storage = stats.as_ref().and_then(|stats| stats.get_document("storageStats").ok());
        let count = |field| storage.and_then(|stats| stats.get(field).cloned()).unwrap_or(Bson::Int32(0));
        let indexes =
            handle.list_indexes().await.map_err(mongo)?.try_collect::<Vec<_>>().await.map_err(mongo)?;
        let indexes: Vec<_> = indexes
            .into_iter()
            .map(|index| {
                let options = index.options.unwrap_or_default();
                let mut out = BsonDocument::new();
                if let Some(name) = options.name {
                    out.insert("name", name);
                }
                out.insert("key", index.keys);
                out.insert("unique", options.unique == Some(true));
                if let Some(expiration) = options.expire_after {
                    out.insert("expireAfterSeconds", i64::try_from(expiration.as_secs()).unwrap_or(i64::MAX));
                }
                out
            })
            .collect();
        json(&doc! {
            "collection": collection, "documents": count("count"), "size": count("size"),
            "averageDocumentSize": count("avgObjSize"), "storageSize": count("storageSize"),
            "totalIndexSize": count("totalIndexSize"), "indexes": indexes,
        })
    }

    fn id(&self, call: &Call, collection: &str) -> Result<Value, CanopyError> {
        parse_id(call.param("id"), self.id_types.get(collection).copied().unwrap_or(IdType::Auto))
    }

    async fn documents(&self, call: &Call, single: bool) -> Result<Reply, CanopyError> {
        let collection = collection_name(call.param("collection"))?;
        let input = view_param(call)?;
        if input.is_some() {
            call.require(Permission::DocumentsViewAs)?;
        }
        let query: Vec<_> =
            call.query.iter().filter(|(key, _)| key != "as" && key != "count").cloned().collect();
        let reads = self.reads(ReadLimits::default()).await?;
        let caller = self.caller(&reads, Some(&[collection]), input.as_ref()).await?;
        let masked = input.is_none() && call.role == AdminRole::Viewer;
        let engine = reads.policies().current();
        let access = masked.then(|| {
            engine.readable(
                collection,
                &RequestContext {
                    roles: [Role::AUTHENTICATED].into_iter().collect(),
                    claims: None,
                    ctx: None,
                    now: caller.context.now,
                },
            )
        });
        let present = |document: Document| -> Result<Value, CanopyError> {
            let document = match &access {
                Some(access) => mask(&document, &project_readable(access, &document)?),
                None => document,
            };
            Ok(Value::Document(document))
        };
        let mut out = Document::new();
        let ct = if single {
            let found = reads
                .find_by_id(&caller, collection, &self.id(call, collection)?, None)
                .await?
                .ok_or_else(|| err(ErrorCode::NotFound, "Document not found"))?;
            out.insert("data", present(found.document)?);
            found.ct
        } else {
            let params =
                find_params_from_query(&query, PageLimits { max_limit: 1000, max_skip: 10_000 }, None)?;
            let page = reads
                .find(
                    &caller,
                    FindRequest {
                        collection: collection.to_owned(),
                        filter: params.filter,
                        sort: params.sort,
                        fields: params.fields,
                        limit: params.limit,
                        skip: params.skip,
                        after: params.after,
                        count: None,
                    },
                )
                .await?;
            out.insert(
                "data",
                Value::Array(page.documents()?.into_iter().map(present).collect::<Result<_, _>>()?),
            );
            out.insert("page", to_value(&doc! { "limit": i64::from(page.limit), "next": page.next })?);
            page.ct
        };
        out.insert("ct", Value::String(ct.to_string()));
        if masked {
            out.insert("masked", Value::Bool(true));
        }
        let mut reply = Reply::json(200, Value::Document(out));
        if let Some(input) = input {
            let mut target = doc! { "collection": collection };
            if single {
                target.insert("id", call.param("id"));
            }
            let query: BsonDocument =
                query.into_iter().map(|(key, value)| (key, Bson::String(value))).collect();
            reply = reply.audited(doc! {
                "action": "documents.viewAs", "target": target,
                "details": { "as": audit_identity(&input)?, "query": query },
            });
        }
        Ok(reply)
    }

    async fn write(&self, call: &Call, op: WriteOp) -> Result<Reply, CanopyError> {
        let collection = collection_name(call.param("collection"))?;
        if call.production
            && !call
                .headers
                .iter()
                .find(|(key, _)| key.eq_ignore_ascii_case("x-canopy-confirm"))
                .is_some_and(|(_, value)| value == collection)
        {
            return Err(err(
                ErrorCode::Forbidden,
                format!(
                    "Data edits in production need typed confirmation: send x-canopy-confirm: {collection}"
                ),
            )
            .with_details(details(&doc! { "reason": "confirmation" })));
        }
        let input = view_param(call)?;
        let reason = if input.is_some() {
            call.require(Permission::DocumentsWriteAs)?;
            Some(call.query("reason").map(str::trim).filter(|reason| !reason.is_empty()).ok_or_else(
                || err(ErrorCode::ValidationFailed, "Writing as another caller needs a reason"),
            )?)
        } else {
            None
        };
        let reads = self.reads(ReadLimits::default()).await?;
        let caller = self.caller(&reads, Some(&[collection]), input.as_ref()).await?;
        let mut request = WriteRequest::new(op, collection);
        if op != WriteOp::Insert {
            request = request.with("id", self.id(call, collection)?);
        }
        if op != WriteOp::Delete {
            request = request.with(
                if op == WriteOp::Update { "update" } else { "doc" },
                call.body.clone().unwrap_or(Value::Null),
            );
        }
        let before = if let Some(id) = request.get("id") {
            self.app
                .collection::<BsonDocument>(collection)
                .find_one(doc! { "_id": { "$eq": bson(id)? } })
                .await
                .map_err(mongo)?
                .map_or(Bson::Null, Bson::Document)
        } else {
            Bson::Null
        };
        let result = self
            .writes(&reads)?
            .execute(&caller, &request, &WriteOptions { mutation_id: Some(uuid_v7()), skip_documents: false })
            .await?;
        let outcome = result.outcome;
        let after = outcome
            .documents
            .and_then(|documents| documents.into_iter().next().flatten())
            .map_or(Value::Null, Value::Document);
        let action = format!("documents.{}{}", op.as_str(), if input.is_some() { "As" } else { "" });
        let ids = if outcome.changed_ids.is_empty() { &outcome.inserted_ids } else { &outcome.changed_ids };
        let mut audit = doc! {
            "action": action, "target": { "collection": collection, "ids": bson(&Value::Array(ids.clone()))? },
            "diff": { "before": before, "after": bson(&after)? },
        };
        if let Some(reason) = reason {
            audit.insert("comment", reason);
        }
        if let Some(input) = input {
            audit.insert("details", doc! { "as": audit_identity(&input)? });
        }
        let mut out = Document::new();
        out.insert("data", after);
        out.insert("matched", number(outcome.matched));
        out.insert("modified", number(outcome.modified));
        out.insert("deleted", number(outcome.deleted));
        out.insert("insertedIds", Value::Array(outcome.inserted_ids));
        out.insert("ct", Value::String(result.ct.to_string()));
        Ok(Reply::json(if op == WriteOp::Insert { 201 } else { 200 }, Value::Document(out)).audited(audit))
    }

    async fn graphql(&self, call: &Call) -> Result<Reply, CanopyError> {
        let (auth, options, limits) =
            self.graphql.as_ref().ok_or_else(|| err(ErrorCode::NotFound, "GraphQL is turned off"))?;
        Schema::Object(vec![
            ("query", string(0, 100_000)),
            ("variables", optional(Schema::Document)),
            ("operationName", optional(string(0, 200))),
            ("as", optional(Schema::Unknown)),
        ])
        .check(call.body.as_ref(), "")?;
        let body = call
            .body
            .as_ref()
            .and_then(Value::as_document)
            .ok_or_else(|| err(ErrorCode::ValidationFailed, "Body must be an object"))?;
        let input = body.get("as");
        if input.is_some() {
            call.require(Permission::DocumentsViewAs)?;
        }
        let reads = Arc::new(self.reads(*limits).await?);
        let caller = self.caller(&reads, None, input).await?;
        let mutations = input.is_none() && !call.production && call.can(Permission::DocumentsWrite);
        let writes = Arc::new(self.writes(&reads)?);
        let rest =
            Rest::new(auth.clone(), reads, RestOptions::default()).with_writes(writes, self.id_types.clone());
        let graphql = Graphql::new(Arc::new(rest), options.clone());
        let mut params = body.clone();
        params.remove("as");
        let params = parse_json(&stringify(&Value::Document(params))?)?;
        let (result, mutation) = graphql.run_admin(&caller, &params, mutations).await?;
        let mut reply = Reply::json(200, crate::openapi::plain_value(result));
        if input.is_some() || mutation {
            let name = body.get("operationName").and_then(Value::as_str);
            let mut detail = doc! { "query": body.get("query").and_then(Value::as_str).unwrap_or_default() };
            if let Some(input) = input {
                detail.insert("as", audit_identity(input)?);
            }
            reply = reply.audited(doc! {
                "action": if input.is_some() { "graphql.viewAs" } else { "graphql.mutation" },
                "target": { "operationName": name }, "details": detail,
            });
        }
        Ok(reply)
    }
}

impl Delegate for DataRoutes {
    fn serve<'a>(&'a self, call: &'a Call) -> BoxFuture<'a, Result<Reply, CanopyError>> {
        Box::pin(async move {
            match call.route.as_str() {
                "GET collections" => self.collections().await,
                "GET collections/:collection/schema" => {
                    let name = collection_name(call.param("collection"))?;
                    let schema = self.schemas.get(name).await?;
                    let mut out = Document::new();
                    out.insert("collection", Value::String(name.to_owned()));
                    out.insert("schema", crate::openapi::schema_value(&schema));
                    Ok(Reply::json(200, Value::Document(out)))
                }
                "GET collections/:collection/stats" => {
                    self.stats(collection_name(call.param("collection"))?).await
                }
                "GET openapi" => {
                    if !self.rest_enabled {
                        return Err(err(ErrorCode::NotFound, "The Data API is turned off"));
                    }
                    let role = call.query("role").unwrap_or(Role::AUTHENTICATED);
                    crate::openapi::render(&self.app, &self.meta, &self.schemas, role, (self.now)()).await
                }
                "POST graphql" => self.graphql(call).await,
                "GET collections/:collection/documents" => self.documents(call, false).await,
                "GET collections/:collection/documents/:id" => self.documents(call, true).await,
                "POST collections/:collection/documents" => self.write(call, WriteOp::Insert).await,
                "PATCH collections/:collection/documents/:id" => self.write(call, WriteOp::Update).await,
                "PUT collections/:collection/documents/:id" => self.write(call, WriteOp::Replace).await,
                "DELETE collections/:collection/documents/:id" => self.write(call, WriteOp::Delete).await,
                _ => Err(err(ErrorCode::NotFound, "Unknown admin route")),
            }
        })
    }
}

fn view_param(call: &Call) -> Result<Option<Value>, CanopyError> {
    call.query("as")
        .map(|text| {
            parse_json(text)
                .and_then(|parsed| decode(&parsed, DecodeOptions::default()))
                .map_err(|_| err(ErrorCode::ValidationFailed, "as must be EJSON"))
        })
        .transpose()
}

fn mask(original: &Document, visible: &Document) -> Document {
    let mut out = Document::new();
    for (key, value) in original.iter() {
        let value = match (value, visible.get(key)) {
            (_, None) => Value::String("[masked]".to_owned()),
            (Value::Document(original), Some(Value::Document(visible))) => {
                Value::Document(mask(original, visible))
            }
            (_, Some(value)) => value.clone(),
        };
        out.insert(key, value);
    }
    out
}

fn json(document: &BsonDocument) -> Result<Reply, CanopyError> {
    Ok(Reply::json(200, to_value(document)?))
}

fn audit_identity(input: &Value) -> Result<Bson, CanopyError> {
    let mut ordered = Document::new();
    if let Some(input) = input.as_document() {
        for key in ["role", "roles", "user", "claims"] {
            if let Some(value) = input.get(key) {
                ordered.insert(key, value.clone());
            }
        }
    }
    bson(&Value::Document(ordered))
}

fn bson(value: &Value) -> Result<Bson, CanopyError> {
    let mut wrapper = Document::new();
    wrapper.insert("value", value.clone());
    canopy_mongo::to_bson(&wrapper)?
        .remove("value")
        .ok_or_else(|| err(ErrorCode::Internal, "Could not encode an admin value"))
}

fn number(value: u64) -> Value {
    Value::Int64(i64::try_from(value).unwrap_or(i64::MAX))
}
