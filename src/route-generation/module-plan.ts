const text = (maxLength = 1600) => ({ type: 'string', minLength: 1, maxLength });
const id = text(200);
const ids = (maxItems = 16) => ({
  type: 'array',
  minItems: 1,
  maxItems,
  uniqueItems: true,
  items: id,
});
const metadata = { type: 'object', additionalProperties: true };

export const SUBMIT_MODULE_PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['schema_version', 'snapshot_id', 'goal', 'modules'],
  properties: {
    schema_version: { type: 'string', enum: ['1'] },
    snapshot_id: id,
    goal: {
      type: 'object',
      additionalProperties: false,
      required: ['original', 'title', 'resolved', 'rationale', 'evidence_refs'],
      properties: {
        original: text(4000),
        title: text(200),
        resolved: text(2000),
        rationale: text(2400),
        evidence_refs: { type: 'array', minItems: 1, maxItems: 20, uniqueItems: true, items: id },
        metadata,
      },
    },
    modules: {
      type: 'array',
      minItems: 1,
      maxItems: 12,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'objective', 'reason', 'candidate_ids'],
        properties: {
          id,
          title: text(160),
          objective: text(1200),
          reason: text(1600),
          candidate_ids: ids(),
          transition_from_previous: text(1200),
          metadata,
        },
      },
    },
    excluded_candidates: {
      type: 'array',
      maxItems: 80,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['candidate_id', 'reason'],
        properties: { candidate_id: id, reason: text(1200), metadata },
      },
    },
    unresolved_questions: { type: 'array', maxItems: 20, items: text(1200) },
    metadata,
  },
};

function present(value) {
  return typeof value === 'string' && value.trim().length > 0;
}
function list(value) {
  return Array.isArray(value) && value.every(present);
}
function functionLike(candidate) {
  return /function|method|constructor|procedure/i.test(candidate?.kind ?? '');
}
function overlaps(left, right) {
  return left?.start_line <= right?.end_line && right?.start_line <= left?.end_line;
}
function completeBlockRequired(candidate, maxLines) {
  return (
    functionLike(candidate) &&
    candidate.range?.end_line - candidate.range?.start_line + 1 <= maxLines
  );
}
function classMember(candidate) {
  const entity = candidate?.entity_id,
    separator = entity?.lastIndexOf('::') ?? -1,
    member = entity?.slice(separator + 2);
  const dot = member?.lastIndexOf('.') ?? -1;
  if (separator < 0 || dot < 1) return undefined;
  return {
    owner: `${entity.slice(0, separator + 2)}${member.slice(0, dot)}`,
    member: member.slice(dot + 1),
  };
}
function likelyInstanceMethod(member) {
  return !/^(create|from|build|make|new|of|parse|load|open)/i.test(member);
}
export function validateModuleRouteDecision({ request, seed, decision, evidence = [] }) {
  const issues = [],
    add = (code, message, details = {}) =>
      issues.push({ severity: 'error', code, message, ...details });
  if (decision?.schema_version !== '1') add('INVALID_MODULE_PLAN', '模块路线版本无效');
  if (decision?.snapshot_id !== request.snapshot_id || seed.snapshot_id !== request.snapshot_id)
    add('SNAPSHOT_MISMATCH', '模块路线与输入快照不一致');
  if (decision?.goal?.original !== request.goal.original)
    add('GOAL_ORIGINAL_CHANGED', '主规划 Agent 修改了用户原始目标');
  for (const field of ['title', 'resolved', 'rationale'])
    if (!present(decision?.goal?.[field])) add('INVALID_GOAL', `模块路线目标缺少 ${field}`);
  const evidenceIds = new Set(
    evidence.filter((item) => item?.snapshot_id === request.snapshot_id).map((item) => item.id),
  );
  if (
    !list(decision?.goal?.evidence_refs) ||
    !decision.goal.evidence_refs.some((value) => evidenceIds.has(value))
  )
    add(
      'MISSING_GOAL_EVIDENCE',
      '模块级个性化目标必须引用当前快照调查产生的 Evidence ID，不能填写 candidate_id',
      {
        provided_refs: Array.isArray(decision?.goal?.evidence_refs)
          ? decision.goal.evidence_refs
          : [],
        suggested_repair: { use_one_or_more_evidence_refs: [...evidenceIds].slice(0, 20) },
      },
    );

  const modules = Array.isArray(decision?.modules) ? decision.modules : [];
  if (!Array.isArray(decision?.modules)) add('INVALID_MODULES', 'modules 必须是数组');
  if (modules.length < request.limits.min_modules)
    add('TOO_FEW_MODULES', `至少需要 ${request.limits.min_modules} 个语义模块`);
  if (modules.length > request.limits.max_modules)
    add('TOO_MANY_MODULES', `最多允许 ${request.limits.max_modules} 个语义模块`);
  const candidateById = new Map(seed.candidates.map((candidate) => [candidate.id, candidate])),
    moduleIds = new Set(),
    selectedHints = new Set(),
    candidateOwners = new Map(),
    assignedCandidates = [];
  const excluded = new Set(request.constraints?.excluded_candidate_ids ?? []),
    starts = new Set(request.constraints?.start_candidate_ids ?? []);
  for (let index = 0; index < modules.length; index++) {
    const module = modules[index],
      details = { module_index: index, module_id: module?.id };
    if (!present(module?.id) || moduleIds.has(module.id))
      add('INVALID_MODULE_ID', `模块 ID 缺失或重复：${module?.id ?? '(missing)'}`, details);
    else moduleIds.add(module.id);
    for (const field of ['title', 'objective', 'reason'])
      if (!present(module?.[field])) add('INVALID_MODULE', `模块缺少 ${field}`, details);
    if (!list(module?.candidate_ids))
      add('INVALID_MODULE_CANDIDATES', '模块必须提供候选符号', details);
    else
      for (const candidateId of module.candidate_ids) {
        const candidate = candidateById.get(candidateId);
        selectedHints.add(candidateId);
        if (!candidate)
          add('UNKNOWN_CANDIDATE', `模块引用未知候选：${candidateId}`, {
            ...details,
            candidate_id: candidateId,
          });
        else if (excluded.has(candidateId))
          add('EXCLUDED_CANDIDATE_SELECTED', `模块引用请求排除候选：${candidateId}`, {
            ...details,
            candidate_id: candidateId,
          });
        else if (
          request.constraints?.allow_test_candidates !== true &&
          candidate.warnings?.includes('test_code')
        )
          add('TEST_CANDIDATE_SELECTED', `模块不能以测试符号为主线候选：${candidateId}`, {
            ...details,
            candidate_id: candidateId,
          });
        if (
          request.goal?.source === 'default_main' &&
          candidate &&
          /continue|continuation|follow[-_ ]?up|steer/i.test(candidate.name ?? '')
        ) {
          add(
            'NON_MAINLINE_MODULE_CANDIDATE',
            `默认首次执行主线不能把续跑/干预候选作为模块锚点：${candidate.entity_id}`,
            { ...details, candidate_id: candidate.id },
          );
        }
        const owners = candidateOwners.get(candidateId) ?? [];
        const reusableLongFunction =
          candidate &&
          functionLike(candidate) &&
          !completeBlockRequired(candidate, request.limits.max_source_lines_per_read);
        if (owners.length && !reusableLongFunction)
          add(
            'CANDIDATE_ASSIGNED_TO_MULTIPLE_MODULES',
            `候选 ${candidateId} 已归属于模块 ${owners[0]}，不能再次分配给 ${module?.id}`,
            { ...details, candidate_id: candidateId, owner_module_id: owners[0] },
          );
        candidateOwners.set(candidateId, [...owners, module?.id]);
        if (candidate)
          for (const assigned of assignedCandidates) {
            if (
              assigned.module_id === module?.id ||
              assigned.candidate.id === candidate.id ||
              assigned.candidate.file !== candidate.file ||
              !overlaps(assigned.candidate.range, candidate.range)
            )
              continue;
            if (
              !completeBlockRequired(
                assigned.candidate,
                request.limits.max_source_lines_per_read,
              ) &&
              !completeBlockRequired(candidate, request.limits.max_source_lines_per_read)
            )
              continue;
            const outer =
              assigned.candidate.range.start_line <= candidate.range.start_line &&
              assigned.candidate.range.end_line >= candidate.range.end_line
                ? assigned.candidate
                : candidate.range.start_line <= assigned.candidate.range.start_line &&
                    candidate.range.end_line >= assigned.candidate.range.end_line
                  ? candidate
                  : undefined;
            if (!outer || !completeBlockRequired(outer, request.limits.max_source_lines_per_read))
              continue;
            add(
              'UNSPLITTABLE_CANDIDATES_ACROSS_MODULES',
              `不可拆的完整函数 ${outer.entity_id} 与其内部符号不能分配到不同模块`,
              {
                ...details,
                candidate_id: candidate.id,
                conflicting_candidate_id: assigned.candidate.id,
                owner_module_id: assigned.module_id,
                suggested_repair: {
                  keep_in_one_module: [assigned.module_id, module?.id],
                  prefer_outer_candidate_id: outer.id,
                },
              },
            );
          }
        const currentMember = classMember(candidate);
        if (currentMember?.member === 'constructor') {
          const earlierMethod = assignedCandidates.find(
            (assigned) =>
              assigned.module_index < index &&
              classMember(assigned.candidate)?.owner === currentMember.owner &&
              classMember(assigned.candidate)?.member !== 'constructor' &&
              likelyInstanceMethod(classMember(assigned.candidate).member),
          );
          if (earlierMethod)
            add(
              'CONSTRUCTOR_ASSIGNED_AFTER_INSTANCE_METHOD',
              `构造函数 ${candidate.entity_id} 不能分配在实例方法 ${earlierMethod.candidate.entity_id} 之后`,
              {
                ...details,
                candidate_id: candidate.id,
                earlier_candidate_id: earlierMethod.candidate.id,
                earlier_module_id: earlierMethod.module_id,
                suggested_repair: { move_constructor_to_or_before_module: earlierMethod.module_id },
              },
            );
        }
        if (candidate)
          assignedCandidates.push({ module_id: module?.id, module_index: index, candidate });
      }
    if (index === 0 && module?.transition_from_previous !== undefined)
      add('UNEXPECTED_FIRST_TRANSITION', '第一个模块不能声明前序过渡', details);
    if (index > 0 && !present(module?.transition_from_previous))
      add('MISSING_MODULE_TRANSITION', '后续模块必须说明与前一模块的语义过渡', details);
  }
  for (const assigned of assignedCandidates)
    if (/post.*run|after.*run/i.test(assigned.candidate.name ?? '')) {
      const laterLoop = assignedCandidates.find(
        (item) =>
          item.module_index > assigned.module_index &&
          /run.*loop|loop/i.test(item.candidate.name ?? ''),
      );
      if (laterLoop)
        add(
          'POST_RUN_ASSIGNED_BEFORE_CORE_LOOP',
          `返回后处理 ${assigned.candidate.entity_id} 不能分配在核心循环 ${laterLoop.candidate.entity_id} 之前`,
          {
            candidate_id: assigned.candidate.id,
            module_id: assigned.module_id,
            later_candidate_id: laterLoop.candidate.id,
            later_module_id: laterLoop.module_id,
          },
        );
    }
  if (
    request.goal?.source === 'default_main' &&
    /stdout|终端|print|打印/i.test(decision?.goal?.resolved ?? '')
  ) {
    const printWrapper = assignedCandidates.find((item) =>
      /^run.*print.*mode$/i.test(item.candidate.name ?? ''),
    );
    if (printWrapper) {
      const lastCandidates =
        modules
          .at(-1)
          ?.candidate_ids?.map((candidateId) => candidateById.get(candidateId))
          .filter(Boolean) ?? [];
      const hasIndependentSink = lastCandidates.some(
        (candidate) =>
          candidate.id !== printWrapper.candidate.id &&
          /stdout|write|flush|output|send|persist|save/i.test(
            `${candidate.name} ${candidate.entity_id}`,
          ),
      );
      if (!hasIndependentSink)
        add(
          'MISSING_RESULT_SINK_MODULE',
          `已选择 ${printWrapper.candidate.entity_id} 的 print/stdout 场景，但末模块没有独立输出 sink 锚点；最终组装不能凭文字补出这个代码块`,
          {
            candidate_id: printWrapper.candidate.id,
            module_id: modules.at(-1)?.id,
            suggested_repair: {
              get_callees: printWrapper.candidate.entity_id,
              instruction:
                '为最后一个模块预留包装器在核心执行返回后调用的 writeRawStdout/flushRawStdout 等独立写出实现。完整包装函数仍留在 prompt 之前。',
            },
          },
        );
    }
  }
  const firstAssignment = new Map();
  for (const assigned of assignedCandidates)
    if (!firstAssignment.has(assigned.candidate.id))
      firstAssignment.set(assigned.candidate.id, assigned);
  for (const relation of seed.relations.filter(
    (item) => item.relation === 'calls' || item.relation === 'call_path',
  )) {
    const caller = firstAssignment.get(relation.from_candidate_id),
      callee = firstAssignment.get(relation.to_candidate_id);
    if (!caller || !callee || caller.module_index <= callee.module_index) continue;
    const reverse = seed.relations.some(
      (item) =>
        (item.relation === 'calls' || item.relation === 'call_path') &&
        item.from_candidate_id === relation.to_candidate_id &&
        item.to_candidate_id === relation.from_candidate_id,
    );
    if (reverse) continue;
    add(
      'CALLER_ASSIGNED_AFTER_CALLEE',
      `调用者 ${caller.candidate.entity_id} 不能分配在被调用者 ${callee.candidate.entity_id} 之后`,
      {
        candidate_id: caller.candidate.id,
        module_id: caller.module_id,
        callee_candidate_id: callee.candidate.id,
        callee_module_id: callee.module_id,
        suggested_repair: {
          move_caller_to_or_before_module: callee.module_id,
          relation_id: relation.id,
        },
      },
    );
  }
  if (
    starts.size &&
    modules[0] &&
    !modules[0].candidate_ids?.some((candidateId) => starts.has(candidateId))
  )
    add('INVALID_START_MODULE', '默认主线第一个模块必须包含允许的入口候选');
  for (const required of request.constraints?.required_candidate_ids ?? [])
    if (!selectedHints.has(required))
      add('REQUIRED_CANDIDATE_MISSING', `模块骨架遗漏必选候选：${required}`, {
        candidate_id: required,
      });
  return {
    valid: !issues.length,
    issues,
    stats: { selected_modules: modules.length, candidate_hints: selectedHints.size },
  };
}

export function createSubmitModulePlanTool({
  request,
  seed,
  evidence,
  state,
  signal,
  onAccepted = () => {},
}) {
  return {
    name: 'submit_module_plan',
    label: '提交语义模块骨架',
    description:
      '提交路线目标和有序语义模块；不要提交模块内部代码块。goal.evidence_refs 只能填写 read 产生的 Evidence ID（例如 pe1），不能填写候选 ID（例如 c123）。',
    parameters: SUBMIT_MODULE_PLAN_SCHEMA,
    executionMode: 'sequential',
    async execute(_toolCallId, decision) {
      signal?.throwIfAborted();
      if (state.modulePlan) throw new Error('语义模块骨架已经锁定');
      if (state.moduleSubmissionAttempts >= request.limits.max_submission_attempts)
        throw new Error(`模块骨架已达到 ${request.limits.max_submission_attempts} 次提交上限`);
      state.moduleSubmissionAttempts++;
      state.lastModulePlan = structuredClone(decision);
      const report = validateModuleRouteDecision({ request, seed, decision, evidence });
      if (!report.valid) {
        state.lastModuleReport = report;
        throw new Error(
          `模块骨架未通过校验（第 ${state.moduleSubmissionAttempts}/${request.limits.max_submission_attempts} 次）：${JSON.stringify(report.issues.slice(0, 20))}`,
        );
      }
      state.modulePlan = structuredClone(decision);
      state.lastModuleReport = undefined;
      onAccepted(state.modulePlan);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'accepted',
              modules: decision.modules.map((module) => module.id),
            }),
          },
        ],
      };
    },
  };
}
