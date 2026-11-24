use std::collections::HashSet;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use canopy_engine::Principal;
use canopy_matcher::compile_projection;
use canopy_mongo::mongodb::{Client, Database};
use canopy_policy::{
    Compiled, FieldAccess, Operation, Role, TEXT_SEARCH_DENIED, and, denied_paths, denies_text_search,
    intersect_projection, project_readable,
};
use canopy_protocol::{CanopyError, DocRef, Document, ErrorCode, RawDocument, Value};
use canopy_query::{DEFAULT_LIMITS, QueryInput, QueryLimits, parse_query, paths_overlap};

use crate::caller::Caller;
use crate::contexts::ContextResolver;
use crate::cursor::{
    CursorKey, cursor_keys, cursor_query_hash, decode_cursor, encode_cursor, keyset_filter, position_of,
    sort_document,
};
use crate::errors::{from_driver_error, internal};
use crate::fail;
use crate::limits::ReadLimits;
use crate::page::{CountMode, FindPage};
use crate::policies::Policies;
use crate::reads::DocumentResult;
use crate::schema::js_cmp;
use crate::snapshot::{PageRead, read_page};

/// A find request, after the transport parsed its parameters. Values are already typed.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct FindRequest {
    /// The collection.
    pub collection: String,
    /// The caller's filter.
    pub filter: Document,
    /// The sort, such as `{ createdAt: -1 }`. Any other value is refused by the query parser.
    pub sort: Option<Value>,
    /// An inclusion or exclusion projection, intersected with the readable fields. Any other value is refused
    /// by the query parser.
    pub fields: Option<Value>,
    /// The page size.
    pub limit: Option<u32>,
    /// How many documents to skip. Not combinable with `after`.
    pub skip: Option<u64>,
    /// The cursor of the previous page.
    pub after: Option<String>,
    /// Also count every matching document.
    pub count: Option<CountMode>,
}

/// A collection and the operations the caller can perform on it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CollectionInfo {
    /// The collection name.
    pub name: String,
    /// The operations granted to the caller, in canonical order.
    pub operations: Vec<Operation>,
    /// Whether realtime subscriptions are enabled.
    pub realtime: bool,
}

/// Rejects names MongoDB would refuse or that address system collections.
pub fn validate_collection_name(name: &str) -> Result<(), CanopyError> {
    if name.is_empty()
        || name.encode_utf16().count() > 255
        || name.contains('$')
        || name.contains('\0')
        || name.starts_with("system.")
    {
        return fail("Invalid collection name");
    }
    Ok(())
}

/// The DLS enforced read path of the Data API. Every read runs `filter AND USING(read)` inside a snapshot
/// session and reports the snapshot's cluster time, so a page lines up with realtime events: every change
/// with `ct <= T` is already in it. Filters and sorts may only reference readable fields, and returned
/// documents keep only readable fields.
pub struct ReadPath {
    pub(crate) client: Client,
    pub(crate) db: Database,
    pub(crate) policies: Policies,
    pub(crate) limits: ReadLimits,
    pub(crate) query_limits: QueryLimits,
    pub(crate) search: HashSet<String>,
    contexts: ContextResolver,
}

impl ReadPath {
    /// Creates a read path over the app database.
    pub fn new(client: Client, database: &str, policies: Policies, limits: ReadLimits) -> ReadPath {
        let db = client.database(database);
        ReadPath {
            contexts: ContextResolver::new(db.clone()),
            client,
            db,
            policies,
            limits,
            query_limits: DEFAULT_LIMITS,
            search: HashSet::new(),
        }
    }

    /// Lets aggregations on these collections start with `$search` or `$vectorSearch` (they need a MongoDB
    /// Search index). The policy filters the search results before any later stage.
    #[must_use]
    pub fn with_search(mut self, collections: impl IntoIterator<Item = String>) -> ReadPath {
        self.search = collections.into_iter().collect();
        self
    }

    /// The app database the read path reads.
    pub fn database(&self) -> &Database {
        &self.db
    }

    /// The read limits in force.
    pub fn limits(&self) -> &ReadLimits {
        &self.limits
    }

    /// The policies in force, replaceable while the server runs.
    pub fn policies(&self) -> &Policies {
        &self.policies
    }

    /// The context lookups, whose cached results can be cleared.
    pub fn contexts(&self) -> &ContextResolver {
        &self.contexts
    }

    /// Lists collections with at least one grant for the caller.
    pub async fn collections(&self, caller: &Caller) -> Result<Vec<CollectionInfo>, CanopyError> {
        let engine = self.policies.current();
        let ctx = &caller.context;
        let mut names: Vec<_> = engine
            .set()
            .collections()
            .iter()
            .filter(|def| engine.is_exposed(&def.collection))
            .map(|def| def.collection.clone())
            .collect();
        if ctx.roles.contains(Role::SERVICE) {
            let listed =
                self.db.list_collection_names().await.map_err(|error| from_driver_error(&error, true))?;
            names.extend(listed.into_iter().filter(|name| !name.starts_with("system.")));
        }
        names.sort_unstable_by(|a, b| js_cmp(a, b));
        names.dedup();
        Ok(names
            .into_iter()
            .filter_map(|name| {
                let operations: Vec<_> =
                    Operation::ALL.into_iter().filter(|op| engine.has_grant(&name, *op, ctx)).collect();
                (!operations.is_empty()).then(|| CollectionInfo {
                    realtime: engine.is_realtime(&name),
                    name,
                    operations,
                })
            })
            .collect())
    }

    /// The caller of a request from its verified principal. The context lookups (`$ctx`) the policies of
    /// `collections` need for the caller's roles are resolved (every collection when `None`). A principal that
    /// may not read over HTTP (a view token) is refused.
    pub async fn caller(
        &self,
        principal: &Principal,
        collections: Option<&[&str]>,
    ) -> Result<Caller, CanopyError> {
        if principal.read_only {
            return Err(CanopyError::named(
                ErrorCode::Forbidden,
                "ForbiddenError",
                "A view token only follows data over realtime",
            ));
        }
        let now = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_millis());
        let mut context = principal.context(None, u64::try_from(now).unwrap_or(u64::MAX));
        let engine = self.policies.current();
        let names = engine.context_names(collections, &context.roles);
        if !names.is_empty() {
            context.ctx = Some(self.contexts.resolve(engine.set().contexts(), &names, &context).await);
        }
        Ok(Caller { context, subject: principal.subject.clone() })
    }

    /// Reads one page. Pages continue from `after`, a cursor that is only valid for the same collection,
    /// filter and sort. Fails with an invalid query error for malformed queries, references to unreadable
    /// fields and cursors of another query, and with `CANOPY_NOT_FOUND` for unknown collections.
    pub async fn find(&self, caller: &Caller, request: FindRequest) -> Result<FindPage, CanopyError> {
        self.find_page(caller, request, None).await
    }

    /// Reads one bounded snapshot for a transport that batches the result itself.
    /// An omitted limit uses the maximum permitted find limit.
    pub async fn find_bounded(
        &self,
        caller: &Caller,
        mut request: FindRequest,
        max_bytes: usize,
    ) -> Result<FindPage, CanopyError> {
        request.limit = request.limit.or(Some(self.limits.max_limit));
        self.find_page(caller, request, Some(max_bytes)).await
    }

    async fn find_page(
        &self,
        caller: &Caller,
        request: FindRequest,
        max_bytes: Option<usize>,
    ) -> Result<FindPage, CanopyError> {
        let engine = self.policies.current();
        let ctx = &caller.context;
        let name = request.collection.as_str();
        validate_collection_name(name)?;
        if !ctx.roles.contains(Role::SERVICE) && !engine.is_exposed(name) {
            return Err(CanopyError::new(ErrorCode::NotFound, format!("Unknown collection '{name}'")));
        }
        let readable = engine.readable(name, ctx);
        let parsed = parse_query(
            &QueryInput {
                filter: Some(Value::Document(request.filter.clone())),
                sort: request.sort.clone(),
                limit: None,
                fields: request.fields.clone(),
            },
            &self.query_limits,
        )?;
        if denies_text_search(&readable, &parsed.filter.filter) {
            return fail(TEXT_SEARCH_DENIED);
        }
        let denied = denied_paths(&readable, &parsed.paths);
        if !denied.is_empty() {
            return fail(format!("The query may not reference unreadable fields: {}", denied.join(", ")));
        }
        let limit = self.page_limit(request.limit)?;
        if request.skip.is_some() && request.after.is_some() {
            return fail("skip and after cannot be combined");
        }
        let skip = self.skip_of(request.skip)?;
        let keys = cursor_keys(parsed.sort.as_ref().map(|sort| &sort.sort));
        let hash = || cursor_query_hash(name, &parsed.filter.filter, &keys);
        let effective = engine.effective_read(name, &parsed.filter.filter, ctx).map_err(|_| internal())?;
        let ranged = match &request.after {
            None => effective.clone(),
            Some(after) => {
                let position = decode_cursor(after, &keys, &hash()?)?;
                and(&[effective.clone(), Compiled::Filter(keyset_filter(&keys, &position)?)])
                    .map_err(|_| internal())?
            }
        };
        let user_projection = parsed.fields.as_ref().map(|fields| &fields.projection);
        let kept = user_projection.and_then(|projection| keep_paths(projection, &keys));
        let pushdown = intersect_projection(kept.as_ref(), &readable);
        let shape =
            user_projection.map(|projection| compile_projection(&Value::Document(projection.clone())));
        let shape = shape.transpose()?;
        let filter = ranged.to_filter();
        let count_filter = request.count.map(|_| effective.to_filter());
        let sort = sort_document(&keys);
        let service = ctx.roles.contains(Role::SERVICE);
        let read = PageRead {
            collection: name,
            filter: &filter,
            sort: &sort,
            limit: limit.saturating_add(u32::from(max_bytes.is_none())),
            max_bytes,
            skip,
            projection: pushdown.as_ref(),
            max_time: Duration::from_millis(self.limits.max_time_ms),
            count_filter: count_filter.as_ref(),
        };
        let result = read_page(&self.client, &self.db, read, service).await?;
        let page_len = usize::try_from(limit).unwrap_or(usize::MAX);
        let more = result.documents.len() > page_len;
        let mut raws = result.documents;
        raws.truncate(page_len);
        let next = match raws.last() {
            Some(last) if more => {
                let document = RawDocument::new(last.as_bytes()).map_err(|_| internal())?;
                Some(encode_cursor(&position_of(&document, &keys)?, &hash()?)?)
            }
            _ => None,
        };
        if matches!(readable, FieldAccess::All) && shape.is_none() {
            let bytes =
                raws.into_iter().map(canopy_mongo::mongodb::bson::RawDocumentBuf::into_bytes).collect();
            return Ok(FindPage::raw(bytes, limit, next, result.total, result.ct));
        }
        let mut documents = Vec::with_capacity(raws.len());
        for raw in &raws {
            let stored = RawDocument::new(raw.as_bytes()).map_err(|_| internal())?.to_document();
            let visible = project_readable(&readable, &stored)?;
            documents.push(match &shape {
                Some(shape) => shape.apply(DocRef::Owned(&visible)),
                None => visible,
            });
        }
        Ok(FindPage::new(documents, limit, next, result.total, result.ct))
    }

    /// Reads one document by its `_id` through `USING(read)`, the read field rules and the caller's projection
    /// (`fields`), in a snapshot. `None` when the caller cannot see a document with that `_id`.
    pub async fn find_by_id(
        &self,
        caller: &Caller,
        collection: &str,
        id: &Value,
        fields: Option<Value>,
    ) -> Result<Option<DocumentResult>, CanopyError> {
        crate::writes::validate_id(Some(id))?;
        let engine = self.policies.current();
        let ctx = &caller.context;
        validate_collection_name(collection)?;
        if !ctx.roles.contains(Role::SERVICE) && !engine.is_exposed(collection) {
            return Err(CanopyError::new(ErrorCode::NotFound, format!("Unknown collection '{collection}'")));
        }
        let readable = engine.readable(collection, ctx);
        let parsed = parse_query(
            &QueryInput { filter: Some(Value::Document(Document::new())), sort: None, limit: None, fields },
            &self.query_limits,
        )?;
        let denied = denied_paths(&readable, &parsed.paths);
        if !denied.is_empty() {
            return fail(format!("The query may not reference unreadable fields: {}", denied.join(", ")));
        }
        let mut by_id = Document::new();
        let mut equals = Document::new();
        equals.insert("$eq", id.clone());
        by_id.insert("_id", Value::Document(equals));
        let effective = engine.effective_read(collection, &by_id, ctx).map_err(|_| internal())?;
        let user_projection = parsed.fields.as_ref().map(|fields| &fields.projection);
        let pushdown = intersect_projection(user_projection, &readable);
        let shape = user_projection
            .map(|projection| compile_projection(&Value::Document(projection.clone())))
            .transpose()?;
        let filter = effective.to_filter();
        let sort = Document::new();
        let read = PageRead {
            collection,
            filter: &filter,
            sort: &sort,
            limit: 1,
            max_bytes: None,
            skip: 0,
            projection: pushdown.as_ref(),
            max_time: Duration::from_millis(self.limits.max_time_ms),
            count_filter: None,
        };
        let result = read_page(&self.client, &self.db, read, ctx.roles.contains(Role::SERVICE)).await?;
        let Some(raw) = result.documents.first() else { return Ok(None) };
        let stored = RawDocument::new(raw.as_bytes()).map_err(|_| internal())?.to_document();
        let visible = project_readable(&readable, &stored)?;
        let document = match &shape {
            Some(shape) => shape.apply(DocRef::Owned(&visible)),
            None => visible,
        };
        Ok(Some(DocumentResult { document, ct: result.ct }))
    }

    fn page_limit(&self, limit: Option<u32>) -> Result<u32, CanopyError> {
        let max = self.limits.max_limit;
        match limit {
            None => Ok(self.limits.default_limit.min(max)),
            Some(limit) if limit >= 1 && limit <= max => Ok(limit),
            Some(_) => fail(format!("limit must be between 1 and {max}")),
        }
    }

    fn skip_of(&self, skip: Option<u64>) -> Result<u64, CanopyError> {
        match skip {
            None => Ok(0),
            Some(skip) if skip <= self.limits.max_skip => Ok(skip),
            Some(_) => fail(format!("skip must be between 0 and {}", self.limits.max_skip)),
        }
    }
}

/// Adjusts a caller projection so the sort fields and `_id` reach the server side page, which needs them for
/// the next cursor. The caller's own projection is applied again in process afterwards.
fn keep_paths(projection: &Document, keys: &[CursorKey]) -> Option<Document> {
    let flag = |path: &str| projection.get(path);
    let paths: Vec<&str> = projection.keys().filter(|path| *path != "_id").collect();
    let include = paths.iter().any(|path| matches!(flag(path), Some(Value::Int32(1))));
    if include {
        let mut out: Vec<String> = paths.iter().map(|path| (*path).to_owned()).collect();
        for key in keys {
            if key.path != "_id" && !out.contains(&key.path) {
                out.push(key.path.clone());
            }
        }
        let pruned: Vec<&String> = out
            .iter()
            .filter(|path| !out.iter().any(|other| other != *path && is_descendant(path, other)))
            .collect();
        return Some(pruned.into_iter().map(|path| (path.clone(), Value::Int32(1))).collect());
    }
    let kept: Vec<&str> =
        paths.into_iter().filter(|path| !keys.iter().any(|key| paths_overlap(path, &key.path))).collect();
    if kept.is_empty() {
        None
    } else {
        Some(kept.into_iter().map(|path| (path.to_owned(), Value::Int32(0))).collect())
    }
}

fn is_descendant(path: &str, ancestor: &str) -> bool {
    path.strip_prefix(ancestor).is_some_and(|rest| rest.starts_with('.'))
}
