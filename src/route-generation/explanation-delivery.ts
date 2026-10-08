import { createHash } from 'node:crypto';

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sourceRange = (file, range) => ({
  file,
  start: { line: range.start_line },
  end: { line: range.end_line },
});

function relationEvidence(relation) {
  const evidence = relation.evidence_refs.map((evidence_id) => ({ evidence_id }));
  for (const [label, site] of [
    ['关系来源', relation.source_site],
    ['关系目标', relation.target_site],
    ['调用位置', relation.call_site],
    ['恢复位置', relation.resume_site],
  ]) {
    if (site) evidence.push({ label, location: site.location });
  }
  for (const site of relation.condition?.evidence_sites ?? [])
    evidence.push({ label: '场景条件', location: site.location });
  return evidence;
}

/**
 * Merges immutable route facts and successful teaching prose. This function
 * performs no semantic generation and is therefore safe to rerun.
 */
export function assembleExplanationDelivery({
  plan,
  explanation,
  workspace_id,
  route_id = plan.id,
  revision = 1,
  revision_id,
  generated_at = Date.now(),
}) {
  if (explanation?.status !== 'ready') throw new Error('只有完整 ready 的解释结果才能组装交付数据');
  if (
    explanation.route_plan_id !== plan.id ||
    explanation.decision_digest !== plan.decision_digest
  ) {
    throw new Error('解释结果与锁定路线版本不一致');
  }
  const finalRevisionId =
    revision_id ??
    `rr_${digest({
      route_id,
      workspace_id,
      plan: plan.decision_digest,
      source: explanation.source_manifest,
      input: explanation.input_manifest,
      explanation: explanation.modules,
    }).slice(0, 20)}`;
  const moduleResultById = new Map(explanation.modules.map((item) => [item.module_id, item]));
  const sourceByBlockId = new Map(explanation.source_manifest.map((item) => [item.block_id, item]));
  const blockResultById = new Map(
    explanation.modules.flatMap((item) => item.blocks).map((item) => [item.block_id, item]),
  );
  const relationTextById = new Map(
    explanation.modules
      .flatMap((item) => item.relations)
      .map((item) => [item.relation_id, item.explanation]),
  );
  const blockIds = new Set(
    plan.modules.flatMap((module) => module.blocks.map((block) => block.id)),
  );
  const relationById = new Map(plan.relations.map((relation) => [relation.id, relation]));
  let routeOrder = 0;
  const block_contents = [];
  const modules = plan.modules.map((module) => {
    const explained = moduleResultById.get(module.id);
    if (!explained || explained.status !== 'ready') throw new Error(`缺少模块解释：${module.id}`);
    const moduleBlockIds = new Set(module.blocks.map((block) => block.id));
    const touching = plan.relations.filter(
      (relation) =>
        moduleBlockIds.has(relation.from_block_id) || moduleBlockIds.has(relation.to_block_id),
    );
    const blocks = module.blocks.map((block) => {
      const content = blockResultById.get(block.id),
        source = sourceByBlockId.get(block.id);
      if (!content || !source || source.module_id !== module.id)
        throw new Error(`缺少代码块解释或源码摘要：${block.id}`);
      block_contents.push({
        schema_version: '1',
        route_id,
        revision_id: finalRevisionId,
        snapshot_id: plan.snapshot_id,
        block_id: block.id,
        explanation: content,
        generated_at,
      });
      return {
        id: block.id,
        module_id: module.id,
        order: block.order,
        route_order: ++routeOrder,
        title: block.title,
        source: {
          symbol_id: block.symbol_id,
          name: block.name,
          kind: block.kind,
          location: sourceRange(block.file, block.range),
          content_digest: source.content_digest,
          evidence: block.evidence_refs.map((evidence_id) => ({ evidence_id })),
        },
        narrative: {
          summary: content.summary,
          why_read: content.why_read,
          takeaways: [...content.takeaways],
        },
        incoming_relation_ids: plan.relations
          .filter((relation) => relation.to_block_id === block.id)
          .map((relation) => relation.id),
        outgoing_relation_ids: plan.relations
          .filter((relation) => relation.from_block_id === block.id)
          .map((relation) => relation.id),
        content_status: 'ready',
      };
    });
    return {
      id: module.id,
      order: module.order,
      title: module.title,
      narrative: explained.module,
      blocks,
      incoming_relation_ids: touching
        .filter((relation) => !moduleBlockIds.has(relation.from_block_id))
        .map((relation) => relation.id),
      outgoing_relation_ids: touching
        .filter((relation) => !moduleBlockIds.has(relation.to_block_id))
        .map((relation) => relation.id),
    };
  });
  for (const id of blockResultById.keys())
    if (!blockIds.has(id)) throw new Error(`解释结果包含未知代码块：${id}`);
  for (const id of relationTextById.keys())
    if (!relationById.has(id)) throw new Error(`解释结果包含未知关系：${id}`);
  const relations = plan.relations.map((relation) => {
    const explanationText = relationTextById.get(relation.id);
    if (!explanationText) throw new Error(`缺少关系解释：${relation.id}`);
    return {
      id: relation.id,
      type: relation.type,
      from_block_id: relation.from_block_id,
      to_block_id: relation.to_block_id,
      crosses_module_boundary: relation.crosses_module_boundary,
      explanation: explanationText,
      ...(relation.candidate_id ? { candidate_id: relation.candidate_id } : {}),
      ...(relation.custom_relation ? { custom_relation: relation.custom_relation } : {}),
      ...(relation.source_site ? { source_site: relation.source_site } : {}),
      ...(relation.target_site ? { target_site: relation.target_site } : {}),
      ...(relation.call_site
        ? {
            call_site: {
              location: relation.call_site.location,
              ...(relation.call_site.callee ? { callee: relation.call_site.callee } : {}),
            },
          }
        : {}),
      ...(relation.resume_site ? { resume_site: { location: relation.resume_site.location } } : {}),
      ...(relation.condition
        ? {
            condition: {
              summary: relation.condition.summary,
              evidence: relation.condition.evidence_sites.map((site) => ({
                label: '场景条件',
                location: site.location,
              })),
            },
          }
        : {}),
      evidence: relationEvidence(relation),
      ...(relation.verification ? { verification: relation.verification } : {}),
    };
  });
  const observableResult = plan.goal.metadata?.observable_result;
  if (typeof observableResult !== 'string' || !observableResult.trim())
    throw new Error('锁定路线缺少可观察结果');
  return {
    route: {
      schema_version: '1',
      id: route_id,
      workspace_id,
      snapshot_id: plan.snapshot_id,
      revision_id: finalRevisionId,
      revision,
      goal: {
        title: plan.goal.title,
        scenario: plan.goal.resolved,
        observable_result: observableResult,
        reason: plan.goal.rationale,
      },
      // Catalogue summaries stay learner-facing; rationale remains available as planning provenance.
      summary: plan.goal.resolved,
      status: 'ready',
      modules,
      relations,
      created_at: generated_at,
      updated_at: generated_at,
    },
    block_contents,
  };
}
