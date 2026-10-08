const text = (maxLength = 1600) => ({ type: 'string', minLength: 1, maxLength });
const id = text(240);
const metadata = { type: 'object', additionalProperties: true };

export const SUBMIT_ROUTE_REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['schema_version', 'snapshot_id', 'status', 'rationale', 'revisions'],
  properties: {
    schema_version: { type: 'string', enum: ['1'] },
    snapshot_id: id,
    status: { type: 'string', enum: ['accept', 'revise'] },
    rationale: text(2400),
    revisions: {
      type: 'array',
      maxItems: 12,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['module_id', 'reason', 'required_focus'],
        properties: {
          module_id: id,
          reason: text(1600),
          required_focus: text(1600),
          candidate_hints: { type: 'array', maxItems: 20, uniqueItems: true, items: id },
          metadata,
        },
      },
    },
    unresolved_questions: { type: 'array', maxItems: 20, items: text(1200) },
    metadata,
  },
};

function present(value) {
  return typeof value === 'string' && value.trim().length > 0;
}
function overlaps(left, right) {
  return left?.start_line <= right?.end_line && right?.start_line <= left?.end_line;
}
function methodOwner(candidate) {
  const member = String(candidate?.entity_id ?? '')
      .split('::')
      .at(-1),
    dot = member?.lastIndexOf('.') ?? -1;
  return dot > 0
    ? { owner: member.slice(0, dot).split('.').at(-1), method: member.slice(dot + 1) }
    : undefined;
}
function sourceLinesForBlock(block, candidate, evidenceById) {
  const lines = [];
  for (const ref of block.evidence_refs ?? []) {
    const item = evidenceById.get(ref);
    if (item?.file !== candidate.file || typeof item.content !== 'string') continue;
    const contentLines = item.content.split('\n');
    for (let index = 0; index < contentLines.length; index++) {
      const line = item.range.start_line + index;
      if (line >= block.range.start_line && line <= block.range.end_line)
        lines.push(contentLines[index]);
    }
  }
  return lines;
}

/**
 * Facts-only audit between isolated module runs. It deliberately does not decide
 * whether a semantically optional callee belongs in the route; the review Agent
 * owns that judgement.
 */
export function auditExpandedRoute({ request, seed, modulePlan, moduleDecisions, evidence = [] }) {
  const issues = [],
    add = (severity, code, message, details = {}) =>
      issues.push({ severity, code, message, ...details });
  const modules = Array.isArray(modulePlan?.modules) ? modulePlan.modules : [],
    decisions = Array.isArray(moduleDecisions) ? moduleDecisions : [];
  const candidateById = new Map(
      (seed?.candidates ?? []).map((candidate) => [candidate.id, candidate]),
    ),
    decisionByModule = new Map();
  for (const decision of decisions) {
    if (!modules.some((module) => module.id === decision?.module_id))
      add(
        'error',
        'UNKNOWN_MODULE_RESULT',
        `模块展开结果引用未知模块：${decision?.module_id ?? '(missing)'}`,
      );
    else if (decisionByModule.has(decision.module_id))
      add('error', 'DUPLICATE_MODULE_RESULT', `模块展开结果重复：${decision.module_id}`, {
        module_id: decision.module_id,
      });
    else decisionByModule.set(decision.module_id, decision);
  }
  const blocks = [];
  for (let moduleIndex = 0; moduleIndex < modules.length; moduleIndex++) {
    const module = modules[moduleIndex],
      decision = decisionByModule.get(module.id);
    if (!decision) {
      add('error', 'MISSING_MODULE_RESULT', `缺少模块展开结果：${module.id}`, {
        module_id: module.id,
      });
      continue;
    }
    if (!Array.isArray(decision.blocks) || !decision.blocks.length)
      add('error', 'EMPTY_MODULE_RESULT', `模块没有代码块：${module.id}`, { module_id: module.id });
    if (decision.unresolved_questions?.length)
      add(
        'warning',
        'MODULE_HAS_OPEN_QUESTIONS',
        `模块仍有 ${decision.unresolved_questions.length} 个未解决问题`,
        { module_id: module.id },
      );
    for (let blockIndex = 0; blockIndex < (decision.blocks ?? []).length; blockIndex++) {
      const block = decision.blocks[blockIndex],
        candidate = candidateById.get(block.candidate_id);
      if (!candidate) {
        add(
          'error',
          'UNKNOWN_BLOCK_CANDIDATE',
          `模块 ${module.id} 引用了未知候选：${block.candidate_id}`,
          { module_id: module.id, block_index: blockIndex },
        );
        continue;
      }
      const item = {
        module_id: module.id,
        module_index: moduleIndex,
        block_index: blockIndex,
        block,
        candidate,
      };
      for (const previous of blocks)
        if (
          previous.module_id !== module.id &&
          previous.candidate.file === candidate.file &&
          overlaps(previous.block.range, block.range)
        ) {
          add(
            'error',
            'CROSS_MODULE_SOURCE_OVERLAP',
            `模块 ${previous.module_id} 与 ${module.id} 重复展示同一源码范围`,
            {
              module_id: module.id,
              conflicting_module_id: previous.module_id,
              candidate_id: candidate.id,
              conflicting_candidate_id: previous.candidate.id,
              file: candidate.file,
              overlap: {
                start_line: Math.max(previous.block.range.start_line, block.range.start_line),
                end_line: Math.min(previous.block.range.end_line, block.range.end_line),
              },
            },
          );
        }
      blocks.push(item);
    }
  }
  if (blocks.length > request.limits.max_blocks)
    add(
      'error',
      'TOO_MANY_ROUTE_BLOCKS',
      `路线共有 ${blocks.length} 个代码块，超过上限 ${request.limits.max_blocks}`,
    );
  const selected = new Set(blocks.map((item) => item.block.candidate_id));
  for (const candidateId of request.constraints?.required_candidate_ids ?? [])
    if (!selected.has(candidateId)) {
      add('error', 'REQUIRED_CANDIDATE_NOT_EXPANDED', `路线展开结果遗漏必选候选：${candidateId}`, {
        candidate_id: candidateId,
      });
    }
  for (let index = 1; index < modules.length; index++) {
    const previous = decisionByModule.get(modules[index - 1].id)?.blocks?.at(-1),
      current = decisionByModule.get(modules[index].id)?.blocks?.[0];
    if (!previous || !current) continue;
    const connected = (seed.relations ?? []).some(
      (relation) =>
        relation.from_candidate_id === previous.candidate_id &&
        relation.to_candidate_id === current.candidate_id,
    );
    if (!connected)
      add(
        'warning',
        'UNPROVEN_MODULE_BOUNDARY',
        '相邻模块边界没有直接图谱关系，最终组装时必须用源码证据解释或要求模块重做',
        {
          module_id: modules[index].id,
          previous_module_id: modules[index - 1].id,
          from_candidate_id: previous.candidate_id,
          to_candidate_id: current.candidate_id,
        },
      );
  }
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  for (let index = 0; index < blocks.length; index++) {
    const caller = blocks[index],
      priorMethods = blocks
        .slice(0, index)
        .map((item) => ({ item, member: methodOwner(item.candidate) }))
        .filter((entry) => entry.member);
    if (!priorMethods.length) continue;
    const emitted = new Set();
    for (const line of sourceLinesForBlock(caller.block, caller.candidate, evidenceById)) {
      const invocations = line.matchAll(/\b([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*\(/g);
      for (const match of invocations) {
        const receiver = match[1].toLowerCase(),
          method = match[2];
        if (receiver.length < 3) continue;
        const targets = priorMethods.filter(
          (entry) =>
            entry.member.method === method && entry.member.owner.toLowerCase().endsWith(receiver),
        );
        if (targets.length !== 1 || emitted.has(targets[0].item.block.candidate_id)) continue;
        const target = targets[0].item;
        emitted.add(target.block.candidate_id);
        add(
          'error',
          'SOURCE_PROVEN_CALLER_AFTER_CALLEE',
          `后面的代码块 ${caller.candidate.entity_id} 实际调用前面已读的 ${target.candidate.entity_id}；完整调用者应先读，结果收尾应由独立 sink 承担`,
          {
            module_id: caller.module_id,
            candidate_id: caller.candidate.id,
            callee_candidate_id: target.candidate.id,
            callee_module_id: target.module_id,
          },
        );
      }
    }
  }
  return {
    valid: !issues.some((issue) => issue.severity === 'error'),
    issues,
    stats: {
      modules: modules.length,
      blocks: blocks.length,
      errors: issues.filter((issue) => issue.severity === 'error').length,
      warnings: issues.filter((issue) => issue.severity === 'warning').length,
    },
  };
}

export function validateRouteReview({ request, seed, modulePlan, decision, audit }) {
  const issues = [],
    add = (code, message, details = {}) =>
      issues.push({ severity: 'error', code, message, ...details });
  if (decision?.schema_version !== '1' || decision?.snapshot_id !== request.snapshot_id)
    add('INVALID_REVIEW', '路线复核版本或源码快照无效');
  if (!present(decision?.rationale)) add('MISSING_REVIEW_RATIONALE', '路线复核必须说明判断理由');
  if (!['accept', 'revise'].includes(decision?.status))
    add('INVALID_REVIEW_STATUS', '路线复核状态必须是 accept 或 revise');
  const revisions = Array.isArray(decision?.revisions) ? decision.revisions : [];
  if (!Array.isArray(decision?.revisions)) add('INVALID_REVISIONS', 'revisions 必须是数组');
  if (decision?.status === 'accept' && revisions.length)
    add('ACCEPT_WITH_REVISIONS', '接受路线时 revisions 必须为空');
  if (decision?.status === 'revise' && !revisions.length)
    add('REVISION_REQUIRED', '要求修订时必须指出至少一个模块');
  if (decision?.status === 'accept' && !audit.valid)
    add('AUDIT_ERRORS_NOT_REPAIRED', '确定性全局审计仍有错误，不能接受当前路线', {
      audit_errors: audit.issues.filter((issue) => issue.severity === 'error'),
    });
  const moduleIds = new Set((modulePlan?.modules ?? []).map((module) => module.id)),
    candidateIds = new Set((seed?.candidates ?? []).map((candidate) => candidate.id)),
    seen = new Set();
  for (const revision of revisions) {
    if (!moduleIds.has(revision?.module_id))
      add('UNKNOWN_REVISION_MODULE', `修订请求引用未知模块：${revision?.module_id ?? '(missing)'}`);
    else if (seen.has(revision.module_id))
      add('DUPLICATE_REVISION_MODULE', `同一轮不能重复修订模块：${revision.module_id}`);
    else seen.add(revision.module_id);
    if (!present(revision?.reason) || !present(revision?.required_focus))
      add('INVALID_REVISION_INSTRUCTION', '模块修订必须包含 reason 和 required_focus', {
        module_id: revision?.module_id,
      });
    for (const candidateId of revision?.candidate_hints ?? [])
      if (!candidateIds.has(candidateId))
        add('UNKNOWN_REVISION_CANDIDATE', `修订提示引用未知候选：${candidateId}`, {
          module_id: revision?.module_id,
          candidate_id: candidateId,
        });
  }
  for (const issue of audit.issues.filter(
    (item) => item.code === 'SOURCE_PROVEN_CALLER_AFTER_CALLEE',
  )) {
    if (decision?.status !== 'revise') continue;
    const earlier = revisions.find((item) => item.module_id === issue.callee_module_id),
      later = revisions.find((item) => item.module_id === issue.module_id);
    if (!earlier || !later || !(earlier.candidate_hints ?? []).includes(issue.candidate_id))
      add(
        'CALLER_MOVE_REVISION_INCOMPLETE',
        `修订必须把调用者 ${issue.candidate_id} 提前交给模块 ${issue.callee_module_id}，并重做原模块 ${issue.module_id} 以留下独立结果 sink`,
        {
          candidate_id: issue.candidate_id,
          required_module_ids: [issue.callee_module_id, issue.module_id],
        },
      );
  }
  return { valid: !issues.length, issues };
}

export function createSubmitRouteReviewTool({
  request,
  seed,
  modulePlan,
  moduleDecisions,
  audit,
  state,
  signal,
  onAccepted = () => {},
}) {
  return {
    name: 'submit_route_review',
    label: '复核模块展开结果',
    description:
      '全局检查各模块代码块是否形成完整、连贯且无重复的路线。接受当前结果，或仅指定需要重新规划的模块；不能在这里新增代码块。',
    parameters: SUBMIT_ROUTE_REVIEW_SCHEMA,
    executionMode: 'sequential',
    async execute(_toolCallId, decision) {
      signal?.throwIfAborted();
      if (state.routeReview) throw new Error('当前轮路线复核已经提交');
      if (state.reviewRoundSubmissionAttempts >= request.limits.max_submission_attempts)
        throw new Error(
          `当前轮路线复核已达到 ${request.limits.max_submission_attempts} 次提交上限`,
        );
      state.reviewRoundSubmissionAttempts++;
      state.reviewSubmissionAttempts++;
      state.lastRouteReview = structuredClone(decision);
      const currentModulePlan = typeof modulePlan === 'function' ? modulePlan() : modulePlan;
      const currentModuleDecisions =
        typeof moduleDecisions === 'function' ? moduleDecisions() : moduleDecisions;
      const currentAudit = typeof audit === 'function' ? audit() : audit;
      const report = validateRouteReview({
        request,
        seed,
        modulePlan: currentModulePlan,
        moduleDecisions: currentModuleDecisions,
        decision,
        audit: currentAudit,
      });
      if (!report.valid) {
        state.lastRouteReviewReport = report;
        throw new Error(
          `路线复核未通过校验（当前轮第 ${state.reviewRoundSubmissionAttempts}/${request.limits.max_submission_attempts} 次）：${JSON.stringify(report.issues.slice(0, 20))}`,
        );
      }
      state.routeReview = structuredClone(decision);
      state.lastRouteReviewReport = undefined;
      onAccepted(state.routeReview);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: decision.status,
              revisions: decision.revisions.map((item) => item.module_id),
            }),
          },
        ],
      };
    },
  };
}
