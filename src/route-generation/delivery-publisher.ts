export const ROUTE_DELIVERY_RECORD_KINDS = Object.freeze({
  route: 'route',
  revision: 'route_revision',
  blockContent: 'route_block_content',
  workspaceCatalog: 'workspace_route_catalog',
});

function assertStore(store) {
  if (!store?.db?.exec || typeof store.put !== 'function' || typeof store.list !== 'function')
    throw new Error('路线存储需要支持 db.exec、put 和 list 的 Store');
}

function findRecord(store, kind, id) {
  return store.list(kind).find((record) => record.id === id);
}

function withTransaction(store, action) {
  store.db.exec('BEGIN IMMEDIATE');
  try {
    const result = action();
    store.db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      store.db.exec('ROLLBACK');
    } catch {}
    throw error;
  }
}

function blockContentRecordId(revisionId, blockId) {
  return `${revisionId}:${blockId}`;
}

function loadRevisionRecords(store, revisionRecord) {
  const route = revisionRecord.delivery;
  const blockContents = route.modules
    .flatMap((module) => module.blocks)
    .map((block) => {
      const record = findRecord(
        store,
        ROUTE_DELIVERY_RECORD_KINDS.blockContent,
        blockContentRecordId(route.revision_id, block.id),
      );
      if (!record?.content) throw new Error(`路线 revision 缺少代码块内容：${block.id}`);
      return record.content;
    });
  return { route, block_contents: blockContents };
}

/** Returns the current complete route revision and its separately stored block content. */
export function loadPublishedRoute(store, routeId) {
  assertStore(store);
  const routeRecord = findRecord(store, ROUTE_DELIVERY_RECORD_KINDS.route, routeId);
  if (!routeRecord) throw new Error('已发布路线不存在');
  const revisionRecord = findRecord(
    store,
    ROUTE_DELIVERY_RECORD_KINDS.revision,
    routeRecord.current_revision_id,
  );
  if (!revisionRecord) throw new Error('已发布路线缺少当前 revision');
  return { ...loadRevisionRecords(store, revisionRecord), summary: routeRecord.summary };
}

/** Reads compact route cards without loading revision source content. */
export function listPublishedRouteSummaries(store, workspaceId) {
  assertStore(store);
  return findRecord(store, ROUTE_DELIVERY_RECORD_KINDS.workspaceCatalog, workspaceId)?.routes ?? [];
}

/** Archives or restores the mutable route pointer without deleting immutable revisions. */
export function setPublishedRouteArchived({ store, route_id, archived, updated_at = Date.now() }) {
  assertStore(store);
  return withTransaction(store, () => {
    const current = findRecord(store, ROUTE_DELIVERY_RECORD_KINDS.route, route_id);
    if (!current) throw new Error('已发布路线不存在');
    const activeStatus =
        current.status === 'archived'
          ? (current.active_status ?? 'ready')
          : current.status === 'partial'
            ? 'partial'
            : 'ready',
      status = archived ? 'archived' : activeStatus,
      summary = { ...current.summary, status, updated_at },
      catalog = findRecord(
        store,
        ROUTE_DELIVERY_RECORD_KINDS.workspaceCatalog,
        current.workspace_id,
      ),
      routes = [...(catalog?.routes ?? []).filter((item) => item.id !== route_id), summary].sort(
        (left, right) => left.created_at - right.created_at || left.id.localeCompare(right.id),
      );
    store.put(ROUTE_DELIVERY_RECORD_KINDS.workspaceCatalog, {
      schema_version: '1',
      id: current.workspace_id,
      workspace_id: current.workspace_id,
      routes,
      updated_at,
    });
    store.put(ROUTE_DELIVERY_RECORD_KINDS.route, {
      ...current,
      status,
      summary,
      ...(archived ? { active_status: activeStatus } : {}),
      updated_at,
    });
    return summary;
  });
}
