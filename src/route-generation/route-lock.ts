import { createHash } from 'node:crypto';
import { validateModuleBlockDecision } from './module-blocks.ts';

const FORBIDDEN_TEACHING_FIELDS = new Set([
  'why_now',
  'whyNow',
  'explanation',
  'explain',
  'focus_questions',
  'focusQuestions',
  'verification',
  'chapters',
]);

export class RouteDecisionValidationError extends Error {
  constructor(report) {
    super(
      `路线决策校验失败：${report.issues.filter((issue) => issue.severity === 'error').length} 个错误`,
    );
    this.name = 'RouteDecisionValidationError';
    this.code = 'INVALID_ROUTE_DECISION';
    this.report = report;
  }
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function present(value) {
  return typeof value === 'string' && value.trim().length > 0;
}
function stringList(value) {
  return Array.isArray(value) && value.every(present);
}
function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!object(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, canonicalValue(value[key])]),
  );
}
function digest(value) {
  return createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(canonicalValue(value)))
    .digest('hex');
}
function unique(values) {
  return [...new Set(values)];
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
function executionVariant(name) {
  const match = String(name ?? '').match(/^(.*?)(sequential|parallel)(.*)$/i);
  return match
    ? {
        key: `${match[1]}<execution-variant>${match[3]}`.toLowerCase(),
        variant: match[2].toLowerCase(),
      }
    : undefined;
}
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function blockContainsInvocation(item, callee, evidenceById) {
  if (!item?.candidate?.file || !present(callee?.name)) return false;
  const pattern = new RegExp(`\\b${escapeRegExp(callee.name)}\\s*\\(`);
  for (const ref of item.evidence_refs ?? []) {
    const evidence = evidenceById.get(ref);
    if (evidence?.file !== item.candidate.file || typeof evidence.content !== 'string') continue;
    const lines = evidence.content.split('\n'),
      start = Math.max(item.range.start_line, evidence.range.start_line),
      end = Math.min(item.range.end_line, evidence.range.end_line);
    for (let line = start; line <= end; line++)
      if (pattern.test(lines[line - evidence.range.start_line] ?? '')) return true;
  }
  return false;
}
function variantAssignmentPattern(variant) {
  return new RegExp(
    `(?:toolExecution|executionMode|executionStrategy)\\s*=\\s*[^;\\n]*(?:\\?\\?|=)\\s*["']${variant}["']`,
    'i',
  );
}
function deepFreeze(value) {
  if (!object(value) && !Array.isArray(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
function forbiddenField(value) {
  if (!object(value) && !Array.isArray(value)) return undefined;
  if (object(value))
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_TEACHING_FIELDS.has(key)) return key;
      const nested = forbiddenField(value[key]);
      if (nested) return nested;
    }
  if (Array.isArray(value))
    for (const item of value) {
      const nested = forbiddenField(item);
      if (nested) return nested;
    }
  return undefined;
}
function collectivelyCovers(items, candidate, range, snapshotId) {
  const intervals = items
    .filter(
      (item) =>
        item?.snapshot_id === snapshotId &&
        item.file === candidate.file &&
        present(item.content_digest) &&
        item.range?.start_line <= range.end_line &&
        item.range?.end_line >= range.start_line,
    )
    .map((item) => item.range)
    .sort((left, right) => left.start_line - right.start_line);
  let cursor = range.start_line;
  for (const interval of intervals) {
    if (interval.start_line > cursor) return false;
    cursor = Math.max(cursor, interval.end_line + 1);
    if (cursor > range.end_line) return true;
  }
  return false;
}
function overlaps(left, right) {
  return left.start_line <= right.end_line && right.start_line <= left.end_line;
}
function connectionSupport(connection, previous, current, seed, evidenceById, snapshotId) {
  const facts = stringList(connection?.fact_refs) ? connection.fact_refs : [],
    refs = stringList(connection?.evidence_refs) ? connection.evidence_refs : [];
  const returnsToCaller = connection?.relation === 'returns_to';
  const expectedFrom = returnsToCaller ? current.candidate_id : previous.candidate_id,
    expectedTo = returnsToCaller ? previous.candidate_id : current.candidate_id;
  const relation = seed.relations.find(
    (item) =>
      item.from_candidate_id === expectedFrom &&
      item.to_candidate_id === expectedTo &&
      (facts.includes(item.id) || item.fact_refs?.some((ref) => facts.includes(ref))),
  );
  const allRefs = unique([
    ...refs,
    ...(previous.evidence_refs ?? []),
    ...(current.evidence_refs ?? []),
  ]);
  const evidence = allRefs.map((id) => evidenceById.get(id));
  const source =
    collectivelyCovers(evidence, previous.candidate, previous.range, snapshotId) &&
    collectivelyCovers(evidence, current.candidate, current.range, snapshotId);
  const sameCandidateSequence =
    previous.candidate_id === current.candidate_id &&
    previous.range.end_line < current.range.start_line;
  return { relation, source, sameCandidateSequence, facts, refs: allRefs };
}

function selectedModuleDecisions(modulePlan, moduleDecisions, assemblyDecision, add) {
  const decisionByModule = new Map(),
    assemblyByModule = new Map();
  for (const decision of Array.isArray(moduleDecisions) ? moduleDecisions : [])
    if (!decisionByModule.has(decision?.module_id))
      decisionByModule.set(decision?.module_id, decision);
  for (const module of Array.isArray(assemblyDecision?.modules) ? assemblyDecision.modules : [])
    if (!assemblyByModule.has(module?.module_id)) assemblyByModule.set(module?.module_id, module);
  return (modulePlan?.modules ?? []).map((module, moduleIndex) => {
    const decision = decisionByModule.get(module.id),
      assembly = assemblyByModule.get(module.id),
      orders = assembly?.selected_block_orders;
    const details = { module_index: moduleIndex, module_id: module.id };
    if (!Array.isArray(orders) || !orders.length) {
      add('MISSING_BLOCK_SELECTION', '最终组装必须为每个模块选择至少一个代码块', details);
      return decision ? { ...decision, blocks: [] } : undefined;
    }
    if (orders[0] !== 1)
      add('MODULE_ROOT_NOT_SELECTED', '每个模块必须保留第 1 个根代码块', details);
    if (
      orders.some(
        (value, index) =>
          !Number.isInteger(value) ||
          value < 1 ||
          value > (decision?.blocks?.length ?? 0) ||
          (index > 0 && value <= orders[index - 1]),
      )
    )
      add('INVALID_BLOCK_SELECTION', '代码块选择必须使用有效、唯一且严格递增的原始顺序', {
        ...details,
        selected_block_orders: orders,
      });
    const blocks = orders.map((order) => decision?.blocks?.[order - 1]).filter(Boolean);
    return decision ? { ...decision, blocks } : undefined;
  });
}

export function validateRouteDecision({
  request,
  seed,
  modulePlan,
  moduleDecisions,
  assemblyDecision,
  evidence = [],
}) {
  const issues = [],
    add = (code, message, details = {}) =>
      issues.push({ severity: 'error', code, message, ...details });
  if (request?.schema_version !== '1' || seed?.schema_version !== '1')
    add('INVALID_INPUT', '路线请求或候选包无效');
  if (modulePlan?.schema_version !== '1' || assemblyDecision?.schema_version !== '1')
    add('INVALID_DECISION', '模块计划或组装确认无效');
  if (
    [seed?.snapshot_id, modulePlan?.snapshot_id, assemblyDecision?.snapshot_id].some(
      (value) => value !== request?.snapshot_id,
    )
  )
    add('SNAPSHOT_MISMATCH', '路线产物与请求快照不一致');
  if (!Array.isArray(moduleDecisions)) add('INVALID_MODULE_DECISIONS', '模块展开结果必须是数组');
  if (!present(assemblyDecision?.rationale))
    add('MISSING_ASSEMBLY_RATIONALE', '主 Agent 必须说明最终组装判断');
  if (!present(assemblyDecision?.selected_scenario))
    add('MISSING_SELECTED_SCENARIO', '最终组装必须锁定一个具体生产场景');
  for (const field of ['title', 'resolved', 'rationale'])
    if (!present(assemblyDecision?.goal?.[field]))
      add('INVALID_ASSEMBLY_GOAL', `最终路线目标缺少 ${field}`);
  const forbidden = forbiddenField({ modulePlan, moduleDecisions, assemblyDecision });
  if (forbidden) add('TEACHING_CONTENT_NOT_ALLOWED', `规划阶段包含教学字段：${forbidden}`);

  const modules = Array.isArray(modulePlan?.modules) ? modulePlan.modules : [],
    decisions = Array.isArray(moduleDecisions) ? moduleDecisions : [];
  const assemblyModules = Array.isArray(assemblyDecision?.modules) ? assemblyDecision.modules : [];
  const expectedIds = modules.map((module) => module.id),
    actualIds = assemblyModules.map((module) => module.module_id);
  if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds))
    add('MODULE_ORDER_CHANGED', '最终组装必须保留已锁定的模块数量和顺序');
  const decisionByModule = new Map();
  for (const decision of decisions) {
    if (decisionByModule.has(decision?.module_id))
      add('DUPLICATE_MODULE_RESULT', `模块展开结果重复：${decision?.module_id}`);
    else decisionByModule.set(decision?.module_id, decision);
  }
  for (const module of modules)
    if (!decisionByModule.has(module.id))
      add('MISSING_MODULE_RESULT', `缺少模块展开结果：${module.id}`);
  for (let index = 0; index < assemblyModules.length; index++) {
    const module = assemblyModules[index],
      details = { module_index: index, module_id: module?.module_id };
    for (const field of ['title', 'objective', 'reason'])
      if (!present(module?.[field]))
        add('INVALID_ASSEMBLY_MODULE', `最终模块缺少 ${field}`, details);
  }

  const selectedDecisions = selectedModuleDecisions(
    modulePlan,
    moduleDecisions,
    assemblyDecision,
    add,
  );
  const selectedByModule = new Map(
    selectedDecisions.filter(Boolean).map((decision) => [decision.module_id, decision]),
  );

  const candidateById = new Map(seed.candidates.map((candidate) => [candidate.id, candidate])),
    evidenceById = new Map(evidence.map((item) => [item.id, item]));
  const flattened = [],
    selectedCandidates = new Set(),
    selectedSymbols = new Set(),
    omittedSymbols = new Set(),
    referencedEvidence = new Set();
  for (let moduleIndex = 0; moduleIndex < modules.length; moduleIndex++) {
    const module = modules[moduleIndex],
      decision = selectedByModule.get(module.id);
    if (!decision) continue;
    for (const omitted of decision.omitted_symbols ?? [])
      if (present(omitted?.symbol_id)) omittedSymbols.add(omitted.symbol_id);
    const report = validateModuleBlockDecision({ request, seed, module, decision, evidence });
    for (const issue of report.issues)
      issues.push({ ...issue, module_index: moduleIndex, module_id: module.id });
    for (let blockIndex = 0; blockIndex < decision.blocks.length; blockIndex++) {
      const block = decision.blocks[blockIndex],
        candidate = candidateById.get(block.candidate_id);
      if (!candidate) continue;
      selectedCandidates.add(candidate.id);
      selectedSymbols.add(candidate.entity_id);
      for (const ref of block.evidence_refs ?? []) referencedEvidence.add(ref);
      const item = { ...block, candidate, moduleIndex, blockIndex };
      for (const previous of flattened)
        if (previous.candidate.file === candidate.file && overlaps(previous.range, block.range))
          add(
            'OVERLAPPING_ROUTE_BLOCKS',
            previous.candidate_id === block.candidate_id
              ? `路线重复覆盖候选范围：${candidate.id}`
              : `路线中的不同代码块重复展示源码范围：${candidate.file} ${Math.max(previous.range.start_line, block.range.start_line)}-${Math.min(previous.range.end_line, block.range.end_line)}`,
            {
              module_index: moduleIndex,
              block_index: blockIndex,
              candidate_id: candidate.id,
              previous_candidate_id: previous.candidate_id,
            },
          );
      flattened.push(item);
    }
  }
  if (flattened.length > request.limits.max_blocks)
    add('TOO_MANY_BLOCKS', `路线最多允许 ${request.limits.max_blocks} 个代码块`);
  const variants = new Map(),
    scenario = String(assemblyDecision?.selected_scenario ?? '').toLowerCase();
  for (let index = 0; index < flattened.length; index++) {
    const item = flattened[index],
      variant = executionVariant(item.candidate.name);
    if (
      request.goal?.source === 'default_main' &&
      /continue|continuation|follow[-_ ]?up|steer/i.test(item.candidate.name ?? '')
    ) {
      add(
        'NON_MAINLINE_CONTROL_PATH',
        `默认首次执行主线不能选择续跑/干预函数：${item.candidate.entity_id}`,
        {
          module_index: item.moduleIndex,
          block_index: item.blockIndex,
          candidate_id: item.candidate.id,
        },
      );
    }
    if (/post.*run|after.*run/i.test(item.candidate.name ?? '')) {
      const laterLoop = flattened
        .slice(index + 1)
        .find((later) => /run.*loop|loop/i.test(later.candidate.name ?? ''));
      if (laterLoop)
        add(
          'POST_RUN_BEFORE_CORE_LOOP',
          `返回后处理 ${item.candidate.entity_id} 不能出现在核心循环 ${laterLoop.candidate.entity_id} 之前`,
          {
            module_index: item.moduleIndex,
            block_index: item.blockIndex,
            candidate_id: item.candidate.id,
            later_candidate_id: laterLoop.candidate.id,
          },
        );
    }
    if (variant) {
      const previous = variants.get(variant.key);
      if (previous && previous.variant !== variant.variant)
        add(
          'MUTUALLY_EXCLUSIVE_VARIANTS_SELECTED',
          `路线同时选择了互斥实现 ${previous.item.candidate.entity_id} 与 ${item.candidate.entity_id}`,
          {
            module_index: item.moduleIndex,
            block_index: item.blockIndex,
            candidate_id: item.candidate.id,
            conflicting_candidate_id: previous.item.candidate.id,
          },
        );
      else variants.set(variant.key, { variant: variant.variant, item });
    }
    const member = classMember(item.candidate);
    if (member?.member === 'constructor') {
      const earlierMethod = flattened
        .slice(0, index)
        .find(
          (previous) =>
            classMember(previous.candidate)?.owner === member.owner &&
            classMember(previous.candidate)?.member !== 'constructor' &&
            likelyInstanceMethod(classMember(previous.candidate).member),
        );
      if (earlierMethod)
        add(
          'CONSTRUCTOR_AFTER_INSTANCE_METHOD',
          `构造函数 ${item.candidate.entity_id} 出现在实例方法 ${earlierMethod.candidate.entity_id} 之后，不符合执行时序`,
          {
            module_index: item.moduleIndex,
            block_index: item.blockIndex,
            candidate_id: item.candidate.id,
            earlier_candidate_id: earlierMethod.candidate.id,
          },
        );
    }
  }
  const firstIndexByCandidate = new Map();
  for (let index = 0; index < flattened.length; index++)
    if (!firstIndexByCandidate.has(flattened[index].candidate_id))
      firstIndexByCandidate.set(flattened[index].candidate_id, index);
  for (const relation of seed.relations.filter(
    (item) => item.relation === 'calls' || item.relation === 'call_path',
  )) {
    const callerIndex = firstIndexByCandidate.get(relation.from_candidate_id),
      calleeIndex = firstIndexByCandidate.get(relation.to_candidate_id);
    if (callerIndex === undefined || calleeIndex === undefined) continue;
    const reverse = seed.relations.some(
      (item) =>
        (item.relation === 'calls' || item.relation === 'call_path') &&
        item.from_candidate_id === relation.to_candidate_id &&
        item.to_candidate_id === relation.from_candidate_id,
    );
    if (callerIndex > calleeIndex && !reverse)
      add(
        'ROUTE_CALLER_AFTER_CALLEE',
        `路线把调用者 ${flattened[callerIndex].candidate.entity_id} 放在被调用者 ${flattened[calleeIndex].candidate.entity_id} 之后`,
        {
          module_index: flattened[callerIndex].moduleIndex,
          block_index: flattened[callerIndex].blockIndex,
          candidate_id: relation.from_candidate_id,
          callee_candidate_id: relation.to_candidate_id,
          relation_id: relation.id,
        },
      );
    const callerItems = flattened
      .map((item, index) =>
        item.candidate_id === relation.from_candidate_id ? { item, index } : undefined,
      )
      .filter(Boolean);
    if (callerItems.length < 2) continue;
    const callee = candidateById.get(relation.to_candidate_id),
      callSite = callerItems.find((entry) =>
        blockContainsInvocation(entry.item, callee, evidenceById),
      );
    if (!callSite) continue;
    const resumed = callerItems.find(
      (entry) => entry.index > callSite.index && entry.index < calleeIndex,
    );
    if (resumed)
      add(
        'ROUTE_CALLEE_AFTER_CALLER_RESUMED',
        `路线在 ${callee.name} 的实际调用点后先继续阅读了调用者，必须先下钻被调用实现`,
        {
          module_index: flattened[calleeIndex].moduleIndex,
          block_index: flattened[calleeIndex].blockIndex,
          candidate_id: callee.id,
          call_site_candidate_id: callSite.item.candidate_id,
        },
      );
  }
  if (request.goal?.source === 'default_main') {
    const dispatch = flattened.find((item) => /^execute.*calls?$/i.test(item.candidate.name ?? ''));
    const selectedVariants = flattened
      .map((item, index) => ({ item, index, variant: executionVariant(item.candidate.name) }))
      .filter((entry) => entry.variant);
    if (dispatch && !selectedVariants.length)
      add(
        'MISSING_EXECUTION_VARIANT',
        `默认主线展开了 ${dispatch.candidate.entity_id}，但没有沿已证明的实际分支进入具体执行实现`,
        {
          module_index: dispatch.moduleIndex,
          block_index: dispatch.blockIndex,
          candidate_id: dispatch.candidate.id,
        },
      );
    for (const entry of selectedVariants) {
      const assignment = variantAssignmentPattern(entry.variant.variant);
      const proven = flattened
        .slice(0, entry.index)
        .some((item) =>
          (item.evidence_refs ?? []).some((ref) =>
            assignment.test(evidenceById.get(ref)?.content ?? ''),
          ),
        );
      if (!proven)
        add(
          'UNPROVEN_EXECUTION_VARIANT',
          `路线选择了 ${entry.variant.variant} 实现，但此前没有代码块直接展示该执行模式的默认/确定赋值`,
          {
            module_index: entry.item.moduleIndex,
            block_index: entry.item.blockIndex,
            candidate_id: entry.item.candidate.id,
            suggested_repair: {
              required_earlier_source: `${entry.variant.variant} execution mode assignment`,
            },
          },
        );
      if (entry.variant.variant === 'parallel') {
        const dispatcherHasToolOverride = flattened
          .slice(0, entry.index)
          .some((item) =>
            (item.evidence_refs ?? []).some((ref) =>
              /hasSequentialToolCall|executionMode\s*===\s*["']sequential["']/i.test(
                evidenceById.get(ref)?.content ?? '',
              ),
            ),
          );
        const scenarioFixesNonSequentialCall =
          /non[-_ ]?sequential|not\s+(?:marked\s+)?sequential|未(?:标记|设置|声明).*sequential|不(?:是|含|使用|强制).*顺序|executionMode[^。；;]*(?:undefined|parallel)/i.test(
            scenario,
          );
        if (dispatcherHasToolOverride && !scenarioFixesNonSequentialCall)
          add(
            'PARALLEL_SCENARIO_CONDITION_MISSING',
            '并行分发还要求本次工具调用未被标记为 sequential；selected_scenario 必须固定这一运行条件',
            {
              module_index: entry.item.moduleIndex,
              block_index: entry.item.blockIndex,
              candidate_id: entry.item.candidate.id,
            },
          );
      }
    }
  }
  if (request.goal?.source === 'default_main' && /stdout|标准输出|终端/.test(scenario)) {
    const lastModule = selectedDecisions.at(-1),
      lastCandidates = (lastModule?.blocks ?? [])
        .map((block) => candidateById.get(block.candidate_id))
        .filter(Boolean);
    if (
      !lastCandidates.some((candidate) =>
        /stdout|write|print|output/i.test(`${candidate.name} ${candidate.entity_id}`),
      )
    ) {
      add(
        'RESULT_SINK_NOT_LAST',
        '场景以 stdout/终端输出为结果时，最后一个模块必须落到独立的写出实现',
        { module_index: modules.length - 1 },
      );
    }
  }
  const startIds = new Set(request.constraints?.start_candidate_ids ?? []);
  if (startIds.size && flattened[0] && !startIds.has(flattened[0].candidate_id))
    add('INVALID_START_BLOCK', `默认主线必须从允许的入口候选开始：${flattened[0].candidate_id}`);
  for (const required of request.constraints?.required_candidate_ids ?? [])
    if (!selectedCandidates.has(required))
      add('REQUIRED_CANDIDATE_MISSING', `路线遗漏必选候选：${required}`, {
        candidate_id: required,
      });

  let supportedConnections = 0;
  for (let index = 0; index < modules.length; index++) {
    const assembly = assemblyModules[index],
      details = { module_index: index, module_id: modules[index]?.id };
    if (index === 0) {
      if (assembly?.connection_from_previous !== undefined)
        add('UNEXPECTED_FIRST_MODULE_CONNECTION', '首模块不能声明前序关系', details);
      continue;
    }
    const previousDecision = selectedByModule.get(modules[index - 1].id),
      currentDecision = selectedByModule.get(modules[index].id);
    const previousBlock = previousDecision?.blocks?.at(-1),
      currentBlock = currentDecision?.blocks?.[0],
      connection = assembly?.connection_from_previous;
    if (!previousBlock || !currentBlock) continue;
    if (!connection || !present(connection.relation) || !present(connection.description)) {
      add('MISSING_MODULE_CONNECTION', '后续模块必须说明与前一模块代码边界的关系', details);
      continue;
    }
    const previousCandidate = candidateById.get(previousBlock.candidate_id),
      currentCandidate = candidateById.get(currentBlock.candidate_id);
    if (!previousCandidate || !currentCandidate) continue;
    const support = connectionSupport(
      connection,
      { ...previousBlock, candidate: previousCandidate },
      { ...currentBlock, candidate: currentCandidate },
      seed,
      evidenceById,
      request.snapshot_id,
    );
    for (const ref of support.refs) referencedEvidence.add(ref);
    if (support.facts.length && !support.relation)
      add(
        'IRRELEVANT_MODULE_FACT',
        `模块边界事实不支持 ${previousBlock.candidate_id} -> ${currentBlock.candidate_id}`,
        details,
      );
    if (!support.relation && !support.source && !support.sameCandidateSequence)
      add(
        'UNSUPPORTED_MODULE_CONNECTION',
        '模块边界缺少有向图谱、源码证据或同一候选内的前后顺序',
        details,
      );
    else supportedConnections++;
    if (support.relation?.relation === 'call_path')
      for (const symbolId of support.relation.metadata?.intermediary_entity_ids ?? []) {
        if (!selectedSymbols.has(symbolId) && !omittedSymbols.has(symbolId))
          add(
            'UNDISPOSITIONED_MODULE_PATH_SYMBOL',
            `跨模块调用路径中的符号既未阅读也未说明省略原因：${symbolId}`,
            { ...details, symbol_id: symbolId },
          );
      }
  }

  return {
    valid: !issues.some((issue) => issue.severity === 'error'),
    issues,
    stats: {
      selected_modules: modules.length,
      selected_blocks: flattened.length,
      distinct_candidates: selectedCandidates.size,
      referenced_evidence: referencedEvidence.size,
      supported_connections: supportedConnections,
    },
  };
}

export function lockRouteDecision(args) {
  const report = validateRouteDecision(args);
  if (!report.valid) throw new RouteDecisionValidationError(report);
  const { request, seed, modulePlan, moduleDecisions, assemblyDecision } = args,
    candidateById = new Map(seed.candidates.map((candidate) => [candidate.id, candidate]));
  const selectedDecisions = selectedModuleDecisions(
      modulePlan,
      moduleDecisions,
      assemblyDecision,
      () => {},
    ),
    decisionByModule = new Map(
      selectedDecisions.filter(Boolean).map((decision) => [decision.module_id, decision]),
    );
  const decisionDigest = digest({ modulePlan, moduleDecisions, assemblyDecision }),
    planId = `lp_${digest(`${request.request_id}:${request.snapshot_id}:${decisionDigest}`).slice(0, 20)}`;
  const modules = modulePlan.modules.map((module, moduleIndex) => ({
    id: `lpm_${digest(`${planId}:${moduleIndex}:${module.id}`).slice(0, 16)}`,
    order: moduleIndex + 1,
    title: assemblyDecision.modules[moduleIndex].title,
    objective: assemblyDecision.modules[moduleIndex].objective,
    reason: assemblyDecision.modules[moduleIndex].reason,
    omitted_symbols: decisionByModule.get(module.id).omitted_symbols ?? [],
    ...(assemblyDecision.modules[moduleIndex].connection_from_previous
      ? { connection_from_previous: assemblyDecision.modules[moduleIndex].connection_from_previous }
      : {}),
    blocks: decisionByModule.get(module.id).blocks.map((block, blockIndex) => {
      const candidate = candidateById.get(block.candidate_id);
      return {
        id: `lpb_${digest(`${planId}:${moduleIndex}:${blockIndex}:${candidate.id}:${block.range.start_line}:${block.range.end_line}`).slice(0, 16)}`,
        order: blockIndex + 1,
        candidate_id: candidate.id,
        symbol_id: candidate.entity_id,
        name: candidate.name,
        kind: candidate.kind,
        file: candidate.file,
        range: block.range,
        title: block.title,
        reason: block.reason,
        evidence_refs: unique(block.evidence_refs),
        ...(block.focus_ranges?.length ? { focus_ranges: block.focus_ranges } : {}),
        ...(block.connection_from_previous
          ? { connection_from_previous: block.connection_from_previous }
          : {}),
      };
    }),
  }));
  // The assembly Agent has seen every module result and is the only stage able to
  // distinguish still-open questions from uncertainties resolved by later reads.
  // Treat its list as authoritative instead of accumulating stale stage-local notes.
  const unresolved = unique(assemblyDecision.unresolved_questions ?? []);
  const plan = canonicalValue({
    schema_version: '1',
    id: planId,
    request_id: request.request_id,
    snapshot_id: request.snapshot_id,
    decision_digest: decisionDigest,
    goal: {
      ...modulePlan.goal,
      ...assemblyDecision.goal,
      original: modulePlan.goal.original,
      metadata: {
        ...(modulePlan.goal.metadata ?? {}),
        ...(assemblyDecision.goal.metadata ?? {}),
        selected_scenario: assemblyDecision.selected_scenario,
      },
    },
    modules,
    excluded_candidates: modulePlan.excluded_candidates ?? [],
    unresolved_questions: unresolved,
  });
  const size = Buffer.byteLength(JSON.stringify(plan));
  if (size > request.limits.max_locked_plan_bytes)
    throw new RouteDecisionValidationError({
      ...report,
      valid: false,
      issues: [
        ...report.issues,
        {
          severity: 'error',
          code: 'LOCKED_PLAN_TOO_LARGE',
          message: `锁定路线 ${size} bytes，超过 ${request.limits.max_locked_plan_bytes} bytes`,
        },
      ],
    });
  return deepFreeze(plan);
}
