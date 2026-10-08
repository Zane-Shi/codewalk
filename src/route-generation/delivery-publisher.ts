import { assembleExplanationDelivery } from './explanation-delivery.ts';
import {
  buildModuleExplanationInputs,
  explanationInputDigest,
  normalizeModuleExplanationResult,
  validateModuleExplanationResult,
} from './explanation-workflow.ts';

export const ROUTE_DELIVERY_RECORD_KINDS = Object.freeze({
  route: 'route',
  revision: 'route_revision',
  blockContent: 'route_block_content',
  workspaceCatalog: 'workspace_route_catalog',
});

const blockContentRecordId = (revisionId, blockId) => `${revisionId}:${blockId}`;

function assertStore(store) {
  if (!store?.db?.exec || typeof store.put !== 'function' || typeof store.list !== 'function') {
    throw new Error('路线发布需要支持 db.exec、put 和 list 的 Store');
  }
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

function routeSummary(route, createdAt) {
  return {
    id: route.id,
    revision_id: route.revision_id,
    revision: route.revision,
    title: route.goal.title,
    summary: route.summary,
    goal: route.goal,
    ...(route.kind ? { kind: route.kind } : {}),
    status: route.status,
    module_count: route.modules.length,
    block_count: route.modules.reduce((count, module) => count + module.blocks.length, 0),
    created_at: createdAt,
    updated_at: route.updated_at,
  };
}

function assertSourceManifest(explanation, inputs) {
  const expected = inputs.flatMap((input) =>
    input.current_module.blocks.map((block) => ({
      module_id: input.current_module.module_id,
      block_id: block.block_id,
      content_digest: block.content_digest,
    })),
  );
  if (JSON.stringify(explanation.source_manifest) !== JSON.stringify(expected)) {
    throw new Error('解释源码摘要与当前快照不一致，拒绝发布过期内容');
  }
  const expectedInputs = inputs.map((input) => ({
    module_id: input.current_module.module_id,
    input_digest: explanationInputDigest(input),
  }));
  if (JSON.stringify(explanation.input_manifest) !== JSON.stringify(expectedInputs)) {
    throw new Error('解释模块输入摘要与当前锁定路线不一致，拒绝发布过期内容');
  }
}

function canonicalExplanation(explanation, inputs) {
  if (explanation?.status !== 'ready') throw new Error('只有完整 ready 的解释结果才能发布');
  if (!Array.isArray(explanation.modules) || explanation.modules.length !== inputs.length) {
    throw new Error('解释结果没有覆盖锁定路线的全部模块');
  }
  const modules = inputs.map((input, index) => {
    const result = normalizeModuleExplanationResult(input, explanation.modules[index]);
    if (result?.module_id !== input.current_module.module_id)
      throw new Error('解释模块顺序与锁定路线不一致');
    const issues = validateModuleExplanationResult(input, result);
    if (issues.length)
      throw new Error(`解释模块未通过发布校验：${JSON.stringify(issues.slice(0, 8))}`);
    if (result.status !== 'ready')
      throw new Error(`模块 ${result.module_id} 报告了路线问题，不能发布`);
    return result;
  });
  return { ...explanation, modules };
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
      status = archived ? 'archived' : activeStatus;
    const summary = { ...current.summary, status, updated_at };
    const catalog = findRecord(
      store,
      ROUTE_DELIVERY_RECORD_KINDS.workspaceCatalog,
      current.workspace_id,
    );
    const routes = [
      ...(catalog?.routes ?? []).filter((item) => item.id !== route_id),
      summary,
    ].sort((left, right) => left.created_at - right.created_at || left.id.localeCompare(right.id));
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

/**
 * Verifies the explanation against the current snapshot and atomically publishes
 * an immutable revision, every block payload, and the workspace route catalogue.
 */
export async function publishRouteDelivery({
  store,
  workspace_id,
  snapshot,
  plan,
  explanation,
  route_id = plan.id,
  generated_at = Date.now(),
}) {
  assertStore(store);
  if (!workspace_id) throw new Error('发布路线缺少 workspace_id');
  if (snapshot?.id !== plan?.snapshot_id) throw new Error('源码快照与锁定路线不一致');
  if (
    explanation?.route_plan_id !== plan.id ||
    explanation?.decision_digest !== plan.decision_digest
  ) {
    throw new Error('解释结果与锁定路线版本不一致');
  }

  const inputs = await buildModuleExplanationInputs({ snapshot, plan });
  assertSourceManifest(explanation, inputs);
  const canonical = canonicalExplanation(explanation, inputs);

  return withTransaction(store, () => {
    const current = findRecord(store, ROUTE_DELIVERY_RECORD_KINDS.route, route_id);
    if (current && current.workspace_id !== workspace_id)
      throw new Error('路线 ID 已属于另一个工作区');
    const revision = (current?.revision ?? 0) + 1;
    const assembled = assembleExplanationDelivery({
      plan,
      explanation: canonical,
      workspace_id,
      route_id,
      revision,
      generated_at,
    });
    const existingRevision = findRecord(
      store,
      ROUTE_DELIVERY_RECORD_KINDS.revision,
      assembled.route.revision_id,
    );
    if (existingRevision) {
      if (
        existingRevision.route_id !== route_id ||
        existingRevision.workspace_id !== workspace_id ||
        existingRevision.decision_digest !== plan.decision_digest
      ) {
        throw new Error('相同 revision_id 已对应不同路线内容');
      }
      const existingCurrent = findRecord(store, ROUTE_DELIVERY_RECORD_KINDS.route, route_id);
      if (!existingCurrent) throw new Error('路线 revision 存在但当前路线索引缺失');
      const loaded = loadRevisionRecords(store, existingRevision);
      return {
        ...loaded,
        summary: routeSummary(loaded.route, existingCurrent.created_at),
        published: false,
      };
    }

    const createdAt = current?.created_at ?? generated_at;
    const summary = routeSummary(assembled.route, createdAt);
    const catalog = findRecord(store, ROUTE_DELIVERY_RECORD_KINDS.workspaceCatalog, workspace_id);
    const routes = [
      ...(catalog?.routes ?? []).filter((item) => item.id !== route_id),
      summary,
    ].sort((left, right) => left.created_at - right.created_at || left.id.localeCompare(right.id));

    for (const content of assembled.block_contents)
      store.put(ROUTE_DELIVERY_RECORD_KINDS.blockContent, {
        schema_version: '1',
        id: blockContentRecordId(content.revision_id, content.block_id),
        route_id,
        revision_id: content.revision_id,
        block_id: content.block_id,
        content,
      });
    store.put(ROUTE_DELIVERY_RECORD_KINDS.revision, {
      schema_version: '1',
      id: assembled.route.revision_id,
      route_id,
      workspace_id,
      decision_digest: plan.decision_digest,
      delivery: assembled.route,
      published_at: generated_at,
    });
    store.put(ROUTE_DELIVERY_RECORD_KINDS.workspaceCatalog, {
      schema_version: '1',
      id: workspace_id,
      workspace_id,
      routes,
      updated_at: generated_at,
    });
    store.put(ROUTE_DELIVERY_RECORD_KINDS.route, {
      schema_version: '1',
      id: route_id,
      workspace_id,
      snapshot_id: plan.snapshot_id,
      current_revision_id: assembled.route.revision_id,
      revision,
      status: 'ready',
      summary,
      created_at: createdAt,
      updated_at: generated_at,
    });
    return { ...assembled, summary, published: true };
  });
}
