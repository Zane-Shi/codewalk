import { createHash } from 'node:crypto';
import { ROUTE_DELIVERY_RECORD_KINDS } from './delivery-publisher.ts';

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const blockContentRecordId = (revisionId, blockId) => `${revisionId}:${blockId}`;

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

function sourceRange(unit) {
  return {
    file: unit.file,
    start: { line: unit.start_line },
    end: { line: unit.end_line },
  };
}

function qualityFor(review, partialReason) {
  if (review?.status === 'accepted')
    return {
      level: 'accepted',
      review_id: review.id,
      summary: review.summary,
      issues: [],
    };
  if (review?.status === 'revision_required')
    return {
      level: 'partial',
      review_id: review.id,
      summary: review.summary,
      issues: structuredClone(review.issues),
    };
  return {
    level: 'partial',
    summary: partialReason || '独立语义审核未完成，以下内容是已经由 Agent 生成并固定到源码的草稿。',
    issues: [],
  };
}

export function assembleSemanticRouteDelivery({
  draft,
  review,
  workspace_id,
  route_id = draft.id,
  revision = 1,
  generated_at = Date.now(),
  partial_reason,
}) {
  if (!draft?.id || !draft?.snapshot_id || !Array.isArray(draft?.modules))
    throw new Error('语义路线草稿无效');
  if (review && (review.draft_id !== draft.id || review.draft_digest !== draft.decision_digest))
    throw new Error('语义审核与路线草稿版本不一致');
  const quality = qualityFor(review, partial_reason),
    status = quality.level === 'accepted' ? 'ready' : 'partial',
    revisionId = `rr_${digest({
      route_id,
      workspace_id,
      draft: draft.decision_digest,
      review: review?.id ?? null,
      quality,
    }).slice(0, 20)}`;
  let routeOrder = 0;
  const block_contents = [];
  const modules = draft.modules.map((module) => {
    const first = module.steps[0],
      last = module.steps.at(-1),
      blocks = module.steps.map((step) => {
        const unit = step.source_unit,
          explanation = {
            block_id: step.id,
            summary: step.explanation,
            why_read: step.transition_from_previous ?? step.reading_guidance,
            walkthrough: [
              {
                title: step.title,
                start_line: unit.start_line,
                end_line: unit.end_line,
                explanation: step.reading_guidance,
              },
            ],
            takeaways: [step.reading_guidance],
          };
        block_contents.push({
          schema_version: '1',
          route_id,
          revision_id: revisionId,
          snapshot_id: draft.snapshot_id,
          block_id: step.id,
          explanation,
          generated_at,
        });
        return {
          id: step.id,
          module_id: module.id,
          order: step.order,
          route_order: ++routeOrder,
          title: step.title,
          source: {
            symbol_id: unit.symbol?.entity_id ?? `source-unit:${unit.id}`,
            name: unit.symbol?.name ?? unit.file.split('/').at(-1),
            kind: unit.symbol?.kind ?? unit.kind,
            location: sourceRange(unit),
            content_digest: unit.digest,
            evidence: [],
          },
          narrative: {
            summary: step.explanation,
            why_read: step.transition_from_previous ?? step.reading_guidance,
            takeaways: [step.reading_guidance],
          },
          incoming_relation_ids: [],
          outgoing_relation_ids: [],
          content_status: 'ready',
        };
      });
    return {
      id: module.id,
      order: module.order,
      title: module.title,
      narrative: {
        summary: module.objective,
        why_read: module.transition_from_previous ?? module.objective,
        expected_input: first?.explanation ?? module.objective,
        expected_outcome: last?.explanation ?? module.objective,
        takeaway: module.objective,
      },
      blocks,
      incoming_relation_ids: [],
      outgoing_relation_ids: [],
    };
  });
  return {
    route: {
      schema_version: '1',
      id: route_id,
      workspace_id,
      snapshot_id: draft.snapshot_id,
      revision_id: revisionId,
      revision,
      goal: {
        title: draft.goal.title,
        scenario: draft.goal.scenario,
        observable_result: draft.goal.learning_outcome,
        reason: draft.summary,
      },
      summary: draft.summary,
      kind: 'semantic',
      status,
      quality,
      modules,
      relations: [],
      created_at: generated_at,
      updated_at: generated_at,
    },
    block_contents,
  };
}

function routeSummary(route, createdAt) {
  return {
    id: route.id,
    revision_id: route.revision_id,
    revision: route.revision,
    title: route.goal.title,
    summary: route.summary,
    goal: route.goal,
    kind: route.kind,
    status: route.status,
    module_count: route.modules.length,
    block_count: route.modules.reduce((count, module) => count + module.blocks.length, 0),
    created_at: createdAt,
    updated_at: route.updated_at,
  };
}

export function publishSemanticRouteDelivery({
  store,
  workspace_id,
  snapshot,
  draft,
  review,
  route_id = draft.id,
  generated_at = Date.now(),
  partial_reason,
}) {
  if (!store?.db?.exec || !store?.put || !store?.list)
    throw new Error('语义路线发布需要支持事务的 Store');
  if (!workspace_id) throw new Error('语义路线发布缺少 workspace_id');
  if (snapshot?.id !== draft?.snapshot_id) throw new Error('源码快照与语义路线草稿不一致');
  return withTransaction(store, () => {
    const current = findRecord(store, ROUTE_DELIVERY_RECORD_KINDS.route, route_id);
    if (current && current.workspace_id !== workspace_id)
      throw new Error('路线 ID 已属于另一个工作区');
    const revision = (current?.revision ?? 0) + 1,
      assembled = assembleSemanticRouteDelivery({
        draft,
        review,
        workspace_id,
        route_id,
        revision,
        generated_at,
        partial_reason,
      }),
      existing = findRecord(
        store,
        ROUTE_DELIVERY_RECORD_KINDS.revision,
        assembled.route.revision_id,
      );
    if (existing) {
      if (existing.route_id !== route_id || existing.decision_digest !== draft.decision_digest)
        throw new Error('相同 revision_id 已对应不同语义路线内容');
      return {
        route: structuredClone(existing.delivery),
        block_contents: store
          .list(ROUTE_DELIVERY_RECORD_KINDS.blockContent)
          .filter((item) => item.revision_id === existing.id)
          .map((item) => item.content),
        summary: structuredClone(current.summary),
        published: false,
      };
    }
    const createdAt = current?.created_at ?? generated_at,
      summary = routeSummary(assembled.route, createdAt),
      catalog = findRecord(store, ROUTE_DELIVERY_RECORD_KINDS.workspaceCatalog, workspace_id),
      routes = [...(catalog?.routes ?? []).filter((item) => item.id !== route_id), summary].sort(
        (left, right) => left.created_at - right.created_at || left.id.localeCompare(right.id),
      );
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
      decision_digest: draft.decision_digest,
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
      snapshot_id: draft.snapshot_id,
      current_revision_id: assembled.route.revision_id,
      revision,
      status: assembled.route.status,
      summary,
      created_at: createdAt,
      updated_at: generated_at,
    });
    return { ...assembled, summary, published: true };
  });
}
