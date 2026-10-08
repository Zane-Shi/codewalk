import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { safePath } from '../snapshot.ts';

const digest = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const present = (value) => typeof value === 'string' && value.trim().length > 0;
const unique = (values) => [...new Set(values)];
const issue = (code, message, details = {}) => ({ code, message, ...details });

export const explanationInputDigest = (input) => digest(JSON.stringify(input));

function sourceRange(file, startLine, endLine = startLine) {
  return { file, start: { line: startLine }, end: { line: endLine } };
}

function numbered(lines, startLine) {
  const width = String(startLine + lines.length - 1).length;
  return lines
    .map((line, index) => `${String(startLine + index).padStart(width)} | ${line}`)
    .join('\n');
}

async function sourceExcerpt(snapshot, location, cache) {
  const absolute = await safePath(snapshot.root, location.file);
  if (!cache.has(location.file))
    cache.set(location.file, (await readFile(absolute, 'utf8')).split('\n'));
  const lines = cache.get(location.file);
  const startLine = location.start.line,
    endLine = location.end.line;
  if (
    !Number.isInteger(startLine) ||
    !Number.isInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine ||
    endLine > lines.length
  ) {
    throw new Error(`解释输入引用了无效源码范围：${location.file}:${startLine}-${endLine}`);
  }
  const selected = lines.slice(startLine - 1, endLine);
  return {
    location,
    content_digest: digest(selected.join('\n')),
    numbered_source: numbered(selected, startLine),
  };
}

function relationSites(relation) {
  return [
    relation.source_site,
    relation.target_site,
    relation.call_site,
    relation.resume_site,
    ...(relation.condition?.evidence_sites ?? []),
  ].filter(Boolean);
}

function outlineGoal(plan) {
  const observableResult = plan.goal?.metadata?.observable_result;
  if (
    !present(plan.goal?.title) ||
    !present(plan.goal?.resolved) ||
    !present(plan.goal?.rationale) ||
    !present(observableResult)
  ) {
    throw new Error('锁定路线缺少解释所需的场景标题、具体场景、选择理由或可观察结果');
  }
  return {
    title: plan.goal.title,
    scenario: plan.goal.resolved,
    observable_result: observableResult,
    reason: plan.goal.rationale,
  };
}

/** Builds a compact route view without asking another Agent to rewrite summaries. */
export function buildExplanationRouteOutline(plan) {
  if (!Array.isArray(plan?.relations)) throw new Error('锁定路线缺少结构化 execution relations');
  const blockIds = new Set(),
    blockModules = new Map();
  let routeOrder = 0;
  const modules = plan.modules.map((module) => ({
    id: module.id,
    order: module.order,
    title: module.title,
    objective: module.objective,
    reason: module.reason,
    blocks: module.blocks.map((block) => {
      if (blockIds.has(block.id)) throw new Error(`锁定路线包含重复 block ID：${block.id}`);
      blockIds.add(block.id);
      blockModules.set(block.id, module.id);
      return {
        id: block.id,
        module_id: module.id,
        order: block.order,
        route_order: ++routeOrder,
        title: block.title,
        route_role: block.reason,
        symbol_id: block.symbol_id,
        symbol: block.name,
        kind: block.kind,
        location: sourceRange(block.file, block.range.start_line, block.range.end_line),
        ...(block.focus_ranges?.length
          ? {
              focus_ranges: block.focus_ranges.map((range) => ({
                location: sourceRange(block.file, range.start_line, range.end_line),
                ...(range.label ? { label: range.label } : {}),
              })),
            }
          : {}),
      };
    }),
  }));
  const relationIds = new Set();
  const relations = plan.relations.map((relation) => {
    if (relationIds.has(relation.id))
      throw new Error(`锁定路线包含重复 relation ID：${relation.id}`);
    relationIds.add(relation.id);
    if (!blockIds.has(relation.from_block_id) || !blockIds.has(relation.to_block_id)) {
      throw new Error(`关系 ${relation.id} 引用了不存在的代码块`);
    }
    const crosses =
      blockModules.get(relation.from_block_id) !== blockModules.get(relation.to_block_id);
    if (crosses !== relation.crosses_module_boundary)
      throw new Error(`关系 ${relation.id} 的跨模块标记与端点不一致`);
    return {
      id: relation.id,
      type: relation.type,
      from_block_id: relation.from_block_id,
      to_block_id: relation.to_block_id,
      crosses_module_boundary: crosses,
      ...(relation.candidate_id ? { candidate_id: relation.candidate_id } : {}),
      ...(relation.custom_relation ? { custom_relation: relation.custom_relation } : {}),
      ...(relation.source_site ? { source_site: relation.source_site } : {}),
      ...(relation.target_site ? { target_site: relation.target_site } : {}),
      ...(relation.call_site ? { call_site: relation.call_site } : {}),
      ...(relation.resume_site ? { resume_site: relation.resume_site } : {}),
      ...(relation.condition ? { condition: relation.condition.summary } : {}),
      planning_note: relation.planning_note,
      evidence_refs: [...relation.evidence_refs],
      ...(relation.verification ? { verification: relation.verification } : {}),
    };
  });
  return { goal: outlineGoal(plan), modules, relations };
}

/** Creates one independent, source-complete explanation input per semantic module. */
export async function buildModuleExplanationInputs({ snapshot, plan }) {
  if (snapshot.id !== plan.snapshot_id) throw new Error('源码快照与锁定路线不一致');
  const outline = buildExplanationRouteOutline(plan),
    cache = new Map();
  const blockById = new Map(
    outline.modules.flatMap((module) => module.blocks).map((block) => [block.id, block]),
  );
  const relationById = new Map(plan.relations.map((relation) => [relation.id, relation]));
  const inputs = [];
  for (const module of outline.modules) {
    const blocks = [];
    for (const block of module.blocks) {
      const excerpt = await sourceExcerpt(snapshot, block.location, cache);
      blocks.push({
        block_id: block.id,
        content_digest: excerpt.content_digest,
        numbered_source: excerpt.numbered_source,
      });
    }
    const touching = plan.relations.filter(
      (relation) =>
        blockById.get(relation.from_block_id)?.module_id === module.id ||
        blockById.get(relation.to_block_id)?.module_id === module.id,
    );
    const relationEvidence = [];
    for (const relation of touching) {
      const excerpts = [],
        seen = new Set();
      for (const site of relationSites(relation)) {
        const key = `${site.location.file}:${site.location.start.line}-${site.location.end.line}`;
        if (seen.has(key)) continue;
        seen.add(key);
        excerpts.push(await sourceExcerpt(snapshot, site.location, cache));
      }
      relationEvidence.push({ relation_id: relation.id, excerpts });
    }
    const ownedRelationIds = plan.relations
      .filter((relation) => blockById.get(relation.from_block_id)?.module_id === module.id)
      .map((relation) => relation.id);
    for (const id of ownedRelationIds)
      if (!relationById.has(id)) throw new Error(`无法分配关系解释：${id}`);
    inputs.push({
      schema_version: '1',
      route_plan_id: plan.id,
      decision_digest: plan.decision_digest,
      snapshot_id: plan.snapshot_id,
      route_outline: { ...outline, current_module_id: module.id },
      current_module: { module_id: module.id, blocks, relation_evidence: relationEvidence },
      relation_ids_to_explain: ownedRelationIds,
    });
  }
  return inputs;
}

function validateEnvelope(input, result, add) {
  for (const key of ['route_plan_id', 'decision_digest', 'snapshot_id']) {
    if (result?.[key] !== input[key]) add('EXPLANATION_ENVELOPE', `解释结果的 ${key} 与输入不一致`);
  }
  if (result?.schema_version !== '1') add('EXPLANATION_SCHEMA', '解释结果 schema_version 必须为 1');
  if (result?.module_id !== input.current_module.module_id)
    add('EXPLANATION_MODULE', '解释结果属于错误的模块');
}

function validateLineSection(section, block, label, add) {
  const outline = block.outline,
    start = section?.start_line,
    end = section?.end_line;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < outline.location.start.line ||
    end < start ||
    end > outline.location.end.line
  ) {
    add('EXPLANATION_LINE_RANGE', `${label} 的行号必须位于代码块 ${outline.id} 内`, {
      block_id: outline.id,
      provided: [start, end],
      allowed: [outline.location.start.line, outline.location.end.line],
    });
  }
}

/** Removes optional presentation noise without changing any teaching claim. */
export function normalizeModuleExplanationResult(input, result) {
  const normalized = structuredClone(result);
  if (normalized?.status !== 'ready') return normalized;
  const outlineModule = input.route_outline.modules.find(
    (module) => module.id === input.current_module.module_id,
  );
  const outlineById = new Map((outlineModule?.blocks ?? []).map((block) => [block.id, block]));
  for (const block of normalized.blocks ?? []) {
    if (Array.isArray(block.skip_guidance) && !block.skip_guidance.length)
      delete block.skip_guidance;
    const outline = outlineById.get(block.block_id);
    const lineCount = outline ? outline.location.end.line - outline.location.start.line + 1 : 0;
    if (block.skip_guidance !== undefined && lineCount < 40) delete block.skip_guidance;
    if (block.pseudocode !== undefined && lineCount < 40) delete block.pseudocode;
  }
  return normalized;
}

/** Structural and source-bound validation; it never judges writing style. */
export function validateModuleExplanationResult(input, result) {
  const issues = [],
    add = (code, message, details) => issues.push(issue(code, message, details));
  validateEnvelope(input, result, add);
  const outlineModule = input.route_outline.modules.find(
    (module) => module.id === input.current_module.module_id,
  );
  const sourceById = new Map(input.current_module.blocks.map((block) => [block.block_id, block]));
  const blockById = new Map(
    (outlineModule?.blocks ?? []).map((block) => [
      block.id,
      { outline: block, source: sourceById.get(block.id) },
    ]),
  );
  const routeRelationIds = new Set(input.route_outline.relations.map((relation) => relation.id));

  if (result?.status === 'route_issue') {
    if (
      result.module !== undefined ||
      result.blocks !== undefined ||
      result.relations !== undefined
    ) {
      add('ROUTE_ISSUE_WITH_TEACHING', 'route_issue 不能同时提交模块、代码块或关系教学内容');
    }
    if (!Array.isArray(result.issues) || !result.issues.length)
      add('EMPTY_ROUTE_ISSUE', 'route_issue 必须提交至少一个可核查问题');
    for (const reported of result.issues ?? []) {
      if (!present(reported?.code) || !present(reported?.summary))
        add('INVALID_ROUTE_ISSUE', '路线问题缺少 code 或 summary');
      for (const id of reported?.affected_block_ids ?? [])
        if (!blockById.has(id)) add('UNKNOWN_ISSUE_BLOCK', `路线问题引用未知代码块：${id}`);
      for (const id of reported?.affected_relation_ids ?? [])
        if (!routeRelationIds.has(id)) add('UNKNOWN_ISSUE_RELATION', `路线问题引用未知关系：${id}`);
      if (
        !Array.isArray(reported?.evidence) ||
        !reported.evidence.length ||
        reported.evidence.some((item) => !present(item?.observation))
      )
        add('INVALID_ISSUE_EVIDENCE', '路线问题必须附带源码观察证据');
    }
    return issues;
  }
  if (result?.status !== 'ready') {
    add('EXPLANATION_STATUS', '解释结果状态必须为 ready 或 route_issue');
    return issues;
  }
  if (result.issues !== undefined)
    add('READY_WITH_ROUTE_ISSUE', 'ready 不能同时携带 issues；确认路线错误时应改为 route_issue');

  for (const key of ['summary', 'why_read', 'expected_input', 'expected_outcome', 'takeaway']) {
    if (!present(result.module?.[key])) add('MODULE_EXPLANATION_FIELD', `模块解释缺少 ${key}`);
  }
  const expectedBlockIds = [...blockById.keys()],
    actualBlockIds = (result.blocks ?? []).map((block) => block?.block_id);
  if (JSON.stringify(actualBlockIds) !== JSON.stringify(expectedBlockIds))
    add('BLOCK_EXPLANATION_COVERAGE', '代码块解释必须与锁定块一一对应并保持顺序', {
      expected: expectedBlockIds,
      actual: actualBlockIds,
    });
  for (const blockResult of result.blocks ?? []) {
    const block = blockById.get(blockResult?.block_id);
    if (!block) continue;
    if (!present(blockResult.summary) || !present(blockResult.why_read))
      add('BLOCK_EXPLANATION_FIELD', `代码块 ${blockResult.block_id} 缺少 summary 或 why_read`);
    if (!Array.isArray(blockResult.walkthrough) || !blockResult.walkthrough.length)
      add('EMPTY_WALKTHROUGH', `代码块 ${blockResult.block_id} 必须至少有一个 walkthrough 段落`);
    let priorStart = -1;
    for (const section of blockResult.walkthrough ?? []) {
      if (!present(section?.title) || !present(section?.explanation))
        add('WALKTHROUGH_FIELD', `代码块 ${blockResult.block_id} 的 walkthrough 缺少标题或解释`);
      validateLineSection(section, block, 'walkthrough', add);
      if (Number.isInteger(section?.start_line) && section.start_line < priorStart)
        add('WALKTHROUGH_ORDER', `代码块 ${blockResult.block_id} 的 walkthrough 未按源码顺序排列`);
      priorStart = section?.start_line ?? priorStart;
    }
    if (
      !Array.isArray(blockResult.takeaways) ||
      blockResult.takeaways.length < 1 ||
      blockResult.takeaways.length > 3 ||
      blockResult.takeaways.some((item) => !present(item))
    )
      add('TAKEAWAY_COUNT', `代码块 ${blockResult.block_id} 需要 1-3 条有效 takeaway`);
    if (blockResult.skip_guidance !== undefined) {
      if (!Array.isArray(blockResult.skip_guidance) || !blockResult.skip_guidance.length)
        add('EMPTY_SKIP_GUIDANCE', `代码块 ${blockResult.block_id} 的 skip_guidance 为空时应省略`);
      for (const skipped of blockResult.skip_guidance ?? []) {
        if (!present(skipped?.reason))
          add('SKIP_GUIDANCE_FIELD', `代码块 ${blockResult.block_id} 的跳读区域缺少理由`);
        validateLineSection(skipped, block, 'skip_guidance', add);
      }
    }
    if (blockResult.pseudocode !== undefined && !present(blockResult.pseudocode))
      add('EMPTY_PSEUDOCODE', `代码块 ${blockResult.block_id} 的 pseudocode 为空时应省略`);
  }

  const expectedRelationIds = input.relation_ids_to_explain,
    actualRelationIds = (result.relations ?? []).map((item) => item?.relation_id);
  if (JSON.stringify(actualRelationIds) !== JSON.stringify(expectedRelationIds))
    add('RELATION_EXPLANATION_COVERAGE', '关系解释必须与本任务分配的 relation ID 一一对应', {
      expected: expectedRelationIds,
      actual: actualRelationIds,
    });
  for (const relation of result.relations ?? [])
    if (!present(relation?.explanation))
      add('RELATION_EXPLANATION_FIELD', `关系 ${relation?.relation_id ?? '(unknown)'} 缺少解释`);
  return issues;
}

/** Deterministic stage order; each injected runner still receives a fresh context. */
export async function explainLockedRoute({
  snapshot,
  plan,
  runModule,
  previousModules = [],
  previousInputManifest = [],
  onModuleComplete = async () => {},
}) {
  const inputs = await buildModuleExplanationInputs({ snapshot, plan }),
    results = [];
  const previousByModule = new Map(previousModules.map((result) => [result.module_id, result]));
  const source_manifest = inputs.flatMap((input) =>
    input.current_module.blocks.map((block) => ({
      module_id: input.current_module.module_id,
      block_id: block.block_id,
      content_digest: block.content_digest,
    })),
  );
  const input_manifest = inputs.map((input) => ({
    module_id: input.current_module.module_id,
    input_digest: explanationInputDigest(input),
  }));
  const previousInputByModule = new Map(
    previousInputManifest.map((item) => [item.module_id, item.input_digest]),
  );
  for (const input of inputs) {
    const previous = previousByModule.get(input.current_module.module_id);
    const inputDigest = input_manifest.find(
      (item) => item.module_id === input.current_module.module_id,
    ).input_digest;
    let reused = Boolean(
      previous && previousInputByModule.get(input.current_module.module_id) === inputDigest,
    );
    let result = reused ? normalizeModuleExplanationResult(input, previous) : undefined;
    if (!result || validateModuleExplanationResult(input, result).length) {
      result = await runModule({
        input,
        validate: (decision) =>
          validateModuleExplanationResult(input, normalizeModuleExplanationResult(input, decision)),
      });
      result = normalizeModuleExplanationResult(input, result);
      reused = false;
    }
    const validationIssues = validateModuleExplanationResult(input, result);
    if (validationIssues.length)
      throw new Error(`模块解释未通过校验：${JSON.stringify(validationIssues.slice(0, 8))}`);
    results.push(result);
    await onModuleComplete(structuredClone(result), { input, input_digest: inputDigest, reused });
    if (result.status === 'route_issue')
      return {
        status: 'route_issue',
        route_plan_id: plan.id,
        decision_digest: plan.decision_digest,
        modules: results,
        source_manifest,
        input_manifest,
        issues: result.issues,
      };
  }
  return {
    status: 'ready',
    route_plan_id: plan.id,
    decision_digest: plan.decision_digest,
    modules: results,
    source_manifest,
    input_manifest,
  };
}
