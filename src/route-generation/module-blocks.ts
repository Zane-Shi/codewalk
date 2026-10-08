const text = (maxLength = 1600) => ({ type: 'string', minLength: 1, maxLength });
const id = text(240);
const idList = (maxItems = 20) => ({ type: 'array', maxItems, uniqueItems: true, items: id });
const metadata = { type: 'object', additionalProperties: true };
const lineRange = {
  type: 'object',
  additionalProperties: false,
  required: ['start_line', 'end_line'],
  properties: {
    start_line: { type: 'integer', minimum: 1 },
    end_line: { type: 'integer', minimum: 1 },
  },
};
const connection = {
  type: 'object',
  additionalProperties: false,
  required: ['relation', 'description', 'fact_refs', 'evidence_refs'],
  properties: {
    relation: {
      ...text(200),
      description:
        '开放关系标签；同一候选内按行向后使用 sequence，从直接被调用者回到直接调用者使用 returns_to；读完一个子调用、回到已读调用者再进入其另一个子调用时使用 resumes_caller_then_calls。',
    },
    description: text(1600),
    fact_refs: {
      ...idList(),
      description: '只放精确支持当前相邻块的图谱事实；同一候选内的 sequence 必须为空数组。',
    },
    evidence_refs: {
      ...idList(),
      description: '关系额外依赖的源码证据；两个代码块自身的 evidence_refs 已自动参与校验。',
    },
    metadata,
  },
};

export const SUBMIT_MODULE_BLOCKS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['schema_version', 'snapshot_id', 'module_id', 'blocks'],
  properties: {
    schema_version: { type: 'string', enum: ['1'] },
    snapshot_id: id,
    module_id: id,
    blocks: {
      type: 'array',
      minItems: 1,
      maxItems: 10,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['candidate_id', 'title', 'range', 'reason', 'evidence_refs'],
        properties: {
          candidate_id: id,
          title: text(200),
          range: lineRange,
          focus_ranges: {
            type: 'array',
            maxItems: 8,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['start_line', 'end_line'],
              properties: {
                start_line: { type: 'integer', minimum: 1 },
                end_line: { type: 'integer', minimum: 1 },
                label: text(200),
              },
            },
          },
          reason: text(1600),
          evidence_refs: idList(),
          connection_from_previous: connection,
          metadata,
        },
      },
    },
    omitted_symbols: {
      type: 'array',
      maxItems: 40,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['symbol_id', 'reason'],
        properties: { symbol_id: id, reason: text(1200), metadata },
      },
    },
    unresolved_questions: { type: 'array', maxItems: 20, items: text(1200) },
    metadata,
  },
};

export class ModuleBlockValidationError extends Error {
  constructor(report) {
    super(`模块代码块校验失败：${report.issues.length} 个错误`);
    this.name = 'ModuleBlockValidationError';
    this.code = 'INVALID_MODULE_BLOCKS';
    this.report = report;
  }
}

function present(value) {
  return typeof value === 'string' && value.trim().length > 0;
}
function stringList(value) {
  return Array.isArray(value) && value.every(present);
}
function range(value) {
  return (
    Number.isInteger(value?.start_line) &&
    Number.isInteger(value?.end_line) &&
    value.start_line > 0 &&
    value.end_line >= value.start_line
  );
}
function functionLike(candidate) {
  return /function|method|constructor|procedure/i.test(candidate?.kind ?? '');
}
function lineCount(value) {
  return value.end_line - value.start_line + 1;
}
function sameRange(left, right) {
  return left.start_line === right.start_line && left.end_line === right.end_line;
}
function boundedChunks(value, maxLines) {
  const chunks = [];
  for (let startLine = value.start_line; startLine <= value.end_line; startLine += maxLines)
    chunks.push({
      start_line: startLine,
      end_line: Math.min(value.end_line, startLine + maxLines - 1),
    });
  return chunks;
}
function coverageReport(items, candidate, blockRange, snapshotId) {
  const intervals = items
    .filter(
      (item) =>
        item?.snapshot_id === snapshotId &&
        item.file === candidate.file &&
        present(item.content_digest) &&
        item.range?.start_line <= blockRange.end_line &&
        item.range?.end_line >= blockRange.start_line,
    )
    .map((item) => ({
      id: item.id,
      start_line: Math.max(item.range.start_line, blockRange.start_line),
      end_line: Math.min(item.range.end_line, blockRange.end_line),
    }))
    .sort((left, right) => left.start_line - right.start_line);
  let cursor = blockRange.start_line;
  const missing = [];
  for (const interval of intervals) {
    if (interval.start_line > cursor)
      missing.push({ start_line: cursor, end_line: interval.start_line - 1 });
    cursor = Math.max(cursor, interval.end_line + 1);
    if (cursor > blockRange.end_line) break;
  }
  if (cursor <= blockRange.end_line)
    missing.push({ start_line: cursor, end_line: blockRange.end_line });
  return { complete: missing.length === 0, intervals, missing };
}
function collectivelyCovers(items, candidate, blockRange, snapshotId) {
  return coverageReport(items, candidate, blockRange, snapshotId).complete;
}
function overlaps(left, right) {
  return left.start_line <= right.end_line && right.start_line <= left.end_line;
}
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function blockContainsInvocation(block, candidate, callee, evidenceById) {
  if (!range(block?.range) || !candidate?.file || !present(callee?.name)) return false;
  const pattern = new RegExp(`\\b${escapeRegExp(callee.name)}\\s*\\(`);
  for (const ref of block.evidence_refs ?? []) {
    const item = evidenceById.get(ref);
    if (item?.file !== candidate.file || !range(item.range) || typeof item.content !== 'string')
      continue;
    const lines = item.content.split('\n');
    const start = Math.max(block.range.start_line, item.range.start_line),
      end = Math.min(block.range.end_line, item.range.end_line);
    for (let line = start; line <= end; line++)
      if (pattern.test(lines[line - item.range.start_line] ?? '')) return true;
  }
  return false;
}
function injectedCallbackTargets(evidence) {
  const targets = [];
  const pattern =
    /([A-Za-z_$][\w$]*)\s*:\s*async\s*\([^)]*\)\s*=>\s*\{[\s\S]{0,6000}?return\s+([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*\(/g;
  for (const item of evidence) {
    if (typeof item?.content !== 'string') continue;
    pattern.lastIndex = 0;
    for (let match = pattern.exec(item.content); match; match = pattern.exec(item.content))
      targets.push({
        property: match[1],
        receiver: match[2],
        method: match[3],
        evidence_id: item.id,
      });
  }
  return targets;
}
function blocksCoverCandidate(blocks, candidate, candidateById) {
  const intervals = blocks
    .map((block) => ({ block, selected: candidateById.get(block.candidate_id) }))
    .filter(
      (item) =>
        item.selected?.file === candidate.file &&
        range(item.block.range) &&
        overlaps(item.block.range, candidate.range),
    )
    .map((item) => ({
      start_line: Math.max(item.block.range.start_line, candidate.range.start_line),
      end_line: Math.min(item.block.range.end_line, candidate.range.end_line),
    }))
    .sort((left, right) => left.start_line - right.start_line);
  let cursor = candidate.range.start_line;
  for (const interval of intervals) {
    if (interval.start_line > cursor) return false;
    cursor = Math.max(cursor, interval.end_line + 1);
    if (cursor > candidate.range.end_line) return true;
  }
  return false;
}

function connectionCatalog(decision, relations) {
  const blocks = Array.isArray(decision?.blocks) ? decision.blocks : [],
    catalog = [];
  for (let index = 1; index < blocks.length; index++) {
    const previous = blocks[index - 1],
      current = blocks[index],
      returnsToCaller = current.connection_from_previous?.relation === 'returns_to';
    const expectedFrom = returnsToCaller ? current.candidate_id : previous.candidate_id,
      expectedTo = returnsToCaller ? previous.candidate_id : current.candidate_id;
    const available = relations
      .filter(
        (relation) =>
          relation.from_candidate_id === expectedFrom && relation.to_candidate_id === expectedTo,
      )
      .map((relation) => ({
        id: relation.id,
        relation: relation.relation,
        from_candidate_id: relation.from_candidate_id,
        to_candidate_id: relation.to_candidate_id,
        fact_refs: relation.fact_refs,
        metadata: relation.metadata,
      }));
    const earlier = new Set(blocks.slice(0, index - 1).map((block) => block.candidate_id)),
      viaPriorCaller = [];
    for (const caller of earlier) {
      const toPrevious = relations.find(
        (relation) =>
          relation.relation === 'calls' &&
          relation.from_candidate_id === caller &&
          relation.to_candidate_id === previous.candidate_id,
      );
      const toCurrent = relations.find(
        (relation) =>
          relation.relation === 'calls' &&
          relation.from_candidate_id === caller &&
          relation.to_candidate_id === current.candidate_id,
      );
      if (toPrevious && toCurrent)
        viaPriorCaller.push({
          caller_candidate_id: caller,
          fact_refs: [...toPrevious.fact_refs, ...toCurrent.fact_refs],
          relations: [toPrevious.id, toCurrent.id],
        });
    }
    catalog.push({
      block_index: index,
      from_candidate_id: previous.candidate_id,
      to_candidate_id: current.candidate_id,
      expected_graph_direction: `${expectedFrom} -> ${expectedTo}`,
      available,
      via_prior_caller: viaPriorCaller,
    });
  }
  return catalog;
}

function connectionSupport({
  connection: value,
  previous,
  current,
  priorBlocks,
  relations,
  evidenceById,
  snapshotId,
}) {
  const factRefs = stringList(value?.fact_refs) ? value.fact_refs : [],
    evidenceRefs = stringList(value?.evidence_refs) ? value.evidence_refs : [];
  const returnsToCaller = value?.relation === 'returns_to';
  const expectedFrom = returnsToCaller ? current.candidate_id : previous.candidate_id,
    expectedTo = returnsToCaller ? previous.candidate_id : current.candidate_id;
  const graphRelations = relations.filter(
    (relation) =>
      relation.from_candidate_id === expectedFrom && relation.to_candidate_id === expectedTo,
  );
  const graphRelation = graphRelations.find(
    (relation) =>
      factRefs.includes(relation.id) || relation.fact_refs?.some((ref) => factRefs.includes(ref)),
  );
  const siblingOptions = [];
  for (const caller of new Set(priorBlocks.map((block) => block.candidate_id))) {
    const toPrevious = relations.find(
      (relation) =>
        relation.relation === 'calls' &&
        relation.from_candidate_id === caller &&
        relation.to_candidate_id === previous.candidate_id,
    );
    const toCurrent = relations.find(
      (relation) =>
        relation.relation === 'calls' &&
        relation.from_candidate_id === caller &&
        relation.to_candidate_id === current.candidate_id,
    );
    if (toPrevious && toCurrent)
      siblingOptions.push({
        caller_candidate_id: caller,
        fact_refs: [...toPrevious.fact_refs, ...toCurrent.fact_refs],
        relations: [toPrevious.id, toCurrent.id],
      });
  }
  const siblingSupport =
    value?.relation === 'resumes_caller_then_calls'
      ? siblingOptions.find((option) => option.fact_refs.every((ref) => factRefs.includes(ref)))
      : undefined;
  const allRefs = [
    ...new Set([
      ...evidenceRefs,
      ...(previous.evidence_refs ?? []),
      ...(current.evidence_refs ?? []),
    ]),
  ];
  const referenced = allRefs.map((evidenceId) => evidenceById.get(evidenceId));
  const sourceSupported =
    collectivelyCovers(referenced, previous.candidate, previous.range, snapshotId) &&
    collectivelyCovers(referenced, current.candidate, current.range, snapshotId);
  const sameCandidateSequence =
    previous.candidate_id === current.candidate_id &&
    previous.range.end_line < current.range.start_line;
  return {
    graphRelation,
    siblingSupport,
    siblingOptions,
    sourceSupported,
    sameCandidateSequence,
    factRefs,
    evidenceRefs,
  };
}

export function validateModuleBlockDecision({
  request,
  seed,
  module,
  decision,
  evidence = [],
  startCandidateIds = [],
  disallowedBlocks = [],
  reservedCandidates = [],
  requiredCandidateIds = [],
}) {
  const issues = [],
    add = (code, message, details = {}) =>
      issues.push({ severity: 'error', code, message, ...details });
  const warn = (code, message, details = {}) =>
    issues.push({ severity: 'warning', code, message, ...details });
  if (decision?.schema_version !== '1' || decision?.module_id !== module.id)
    add('MODULE_MISMATCH', '子 Agent 输出的模块 ID 无效');
  if (decision?.snapshot_id !== request.snapshot_id || seed.snapshot_id !== request.snapshot_id)
    add('SNAPSHOT_MISMATCH', '模块代码块与输入快照不一致');
  const blocks = Array.isArray(decision?.blocks) ? decision.blocks : [];
  if (!Array.isArray(decision?.blocks) || !blocks.length)
    add('EMPTY_MODULE', '语义模块至少需要一个代码块');
  if (blocks.length > request.limits.max_blocks_per_module)
    add('TOO_MANY_BLOCKS', `单模块最多允许 ${request.limits.max_blocks_per_module} 个代码块`);
  const candidateById = new Map(seed.candidates.map((candidate) => [candidate.id, candidate])),
    evidenceById = new Map(evidence.map((item) => [item.id, item]));
  const selectedCandidates = new Set(),
    selectedSymbols = new Set(),
    hintSet = new Set(module.candidate_ids),
    omitted = new Set();
  const blockCountByCandidate = new Map();
  for (const block of blocks) {
    const candidate = candidateById.get(block?.candidate_id);
    if (candidate) {
      selectedCandidates.add(candidate.id);
      selectedSymbols.add(candidate.entity_id);
      blockCountByCandidate.set(candidate.id, (blockCountByCandidate.get(candidate.id) ?? 0) + 1);
    }
  }
  for (const item of decision?.omitted_symbols ?? []) {
    if (!present(item?.symbol_id) || !present(item?.reason))
      add('INVALID_OMISSION', '被省略符号必须包含 symbol_id 和 reason');
    else omitted.add(item.symbol_id);
  }
  for (const target of injectedCallbackTargets(evidence)) {
    const sameNamed = blocks
      .map((block, index) => ({ block, index, candidate: candidateById.get(block.candidate_id) }))
      .filter((item) => item.candidate?.name === target.method);
    for (const item of sameNamed)
      if (
        !String(item.candidate.entity_id)
          .toLowerCase()
          .includes(`${target.receiver}.${target.method}`.toLowerCase())
      ) {
        add(
          'INJECTED_CALLBACK_TARGET_MISMATCH',
          `源码已把 ${target.property} 注入为 ${target.receiver}.${target.method}，不能改走同名默认/兼容实现 ${item.candidate.entity_id}`,
          {
            module_id: module.id,
            block_index: item.index,
            candidate_id: item.candidate.id,
            evidence_id: target.evidence_id,
            suggested_repair: {
              query_symbol: `${target.receiver}.${target.method}`,
              instruction: '选择实际注入回调指向的实现；不要选择未生效的默认函数。',
            },
          },
        );
      }
  }
  for (const candidateId of requiredCandidateIds) {
    const candidate = candidateById.get(candidateId);
    if (
      candidate &&
      !blocksCoverCandidate([...disallowedBlocks, ...blocks], candidate, candidateById)
    )
      add(
        'NAMED_IMPLEMENTATION_NOT_COVERED',
        `模块目标明确点名的函数 ${candidate.entity_id} 未被当前或前序代码块范围完整覆盖`,
        {
          module_id: module.id,
          candidate_id: candidate.id,
          expected_range: candidate.range,
        },
      );
  }
  const rootCandidate = candidateById.get(blocks[0]?.candidate_id);
  if (
    request.goal?.source === 'default_main' &&
    rootCandidate &&
    !functionLike(rootCandidate) &&
    !/module/i.test(rootCandidate.kind ?? '')
  ) {
    add(
      'NON_EXECUTABLE_MODULE_ROOT',
      `默认生产主线模块不能以 ${rootCandidate.kind} 作为根代码块：${rootCandidate.entity_id}`,
      { module_id: module.id, block_index: 0, candidate_id: rootCandidate.id },
    );
  }
  const firstIndexByCandidate = new Map();
  for (let index = 0; index < blocks.length; index++)
    if (!firstIndexByCandidate.has(blocks[index]?.candidate_id))
      firstIndexByCandidate.set(blocks[index]?.candidate_id, index);
  for (const relation of seed.relations.filter((item) => item.relation === 'calls')) {
    const callerIndex = firstIndexByCandidate.get(relation.from_candidate_id),
      calleeIndex = firstIndexByCandidate.get(relation.to_candidate_id);
    if (callerIndex === undefined || calleeIndex === undefined) continue;
    if (callerIndex > calleeIndex) {
      const hasEarlierCaller = seed.relations.some(
        (item) =>
          item.relation === 'calls' &&
          item.to_candidate_id === relation.to_candidate_id &&
          firstIndexByCandidate.has(item.from_candidate_id) &&
          firstIndexByCandidate.get(item.from_candidate_id) < calleeIndex,
      );
      const isCycle = seed.relations.some(
        (item) =>
          item.relation === 'calls' &&
          item.from_candidate_id === relation.to_candidate_id &&
          item.to_candidate_id === relation.from_candidate_id,
      );
      if (!hasEarlierCaller && !isCycle)
        add(
          'CALLEE_BEFORE_CALLER',
          `代码块应先阅读调用者 ${relation.from_candidate_id}，再追踪其子函数 ${relation.to_candidate_id}`,
          {
            module_id: module.id,
            block_index: calleeIndex,
            candidate_id: relation.to_candidate_id,
            suggested_repair: {
              move_caller_before_callee: [relation.from_candidate_id, relation.to_candidate_id],
              fact_refs: relation.fact_refs,
            },
          },
        );
    }
    const callerCandidate = candidateById.get(relation.from_candidate_id),
      calleeCandidate = candidateById.get(relation.to_candidate_id);
    const callerIndexes = blocks
      .map((block, index) => (block.candidate_id === relation.from_candidate_id ? index : -1))
      .filter((index) => index >= 0);
    if (callerIndexes.length < 2 || calleeIndex === undefined) continue;
    const callSiteIndex = callerIndexes.find((index) =>
      blockContainsInvocation(blocks[index], callerCandidate, calleeCandidate, evidenceById),
    );
    if (callSiteIndex === undefined) continue;
    if (calleeIndex <= callSiteIndex)
      add(
        'CALLEE_BEFORE_ACTUAL_CALL_SITE',
        `被调用函数 ${calleeCandidate.entity_id} 必须排在调用者中实际调用它的代码段之后`,
        {
          module_id: module.id,
          block_index: calleeIndex,
          candidate_id: calleeCandidate.id,
          call_site_block_index: callSiteIndex,
        },
      );
    const resumedIndex = callerIndexes.find(
      (index) => index > callSiteIndex && index < calleeIndex,
    );
    if (resumedIndex !== undefined)
      add(
        'CALLEE_AFTER_CALLER_RESUMED',
        `调用者 ${callerCandidate.entity_id} 已越过 ${calleeCandidate.name} 的调用点并继续到后续代码，必须先下钻被调用函数`,
        {
          module_id: module.id,
          block_index: calleeIndex,
          candidate_id: calleeCandidate.id,
          suggested_repair: {
            block_order: [callSiteIndex + 1, calleeIndex + 1, resumedIndex + 1],
            instruction: '把被调用函数放到包含实际调用点的代码段之后、调用者后续代码段之前。',
          },
        },
      );
  }
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index],
      details = { module_id: module.id, block_index: index, candidate_id: block?.candidate_id },
      candidate = candidateById.get(block?.candidate_id);
    if (!candidate) {
      add(
        'UNKNOWN_CANDIDATE',
        `代码块引用未知候选：${block?.candidate_id ?? '(missing)'}`,
        details,
      );
      continue;
    }
    if (!present(block.title) || !present(block.reason))
      add('INVALID_BLOCK', '代码块缺少 title 或 reason', details);
    if (
      !range(block.range) ||
      block.range.start_line < candidate.range.start_line ||
      block.range.end_line > candidate.range.end_line
    )
      add('INVALID_BLOCK_RANGE', `代码块范围必须位于候选 ${candidate.id} 内`, details);
    else {
      if (lineCount(block.range) > request.limits.max_source_lines_per_read)
        add(
          'BLOCK_TOO_LARGE',
          `代码块超过 ${request.limits.max_source_lines_per_read} 行，必须拆成多个不重叠且递增的逻辑段`,
          {
            ...details,
            suggested_repair: {
              required_max_lines: request.limits.max_source_lines_per_read,
              minimum_segments: Math.ceil(
                lineCount(block.range) / request.limits.max_source_lines_per_read,
              ),
              hard_cap_windows: boundedChunks(
                block.range,
                request.limits.max_source_lines_per_read,
              ),
              instruction:
                '优先在 hard_cap_windows 内选择真实逻辑边界；每段不得超过 required_max_lines，后续段使用 sequence 且 fact_refs 为空。',
            },
          },
        );
      const completeFunctionRequired =
        functionLike(candidate) &&
        lineCount(candidate.range) <= request.limits.max_source_lines_per_read;
      if (completeFunctionRequired && !sameRange(block.range, candidate.range))
        add(
          'INCOMPLETE_FUNCTION_BLOCK',
          `候选 ${candidate.id} 是可在一次读取内完成的 ${lineCount(candidate.range)} 行函数，必须选择完整符号范围 ${candidate.range.start_line}-${candidate.range.end_line}；函数内部重点请放入 focus_ranges`,
          { ...details, expected_range: candidate.range },
        );
      if (completeFunctionRequired && blockCountByCandidate.get(candidate.id) > 1)
        add(
          'DUPLICATE_FUNCTION_BLOCK',
          `可完整读取的函数 ${candidate.id} 在同一模块只能作为一个代码块出现`,
          details,
        );
    }
    if (block.focus_ranges !== undefined && !Array.isArray(block.focus_ranges))
      add('INVALID_FOCUS_RANGES', 'focus_ranges 必须是数组', details);
    for (const focus of Array.isArray(block.focus_ranges) ? block.focus_ranges : []) {
      if (
        !range(focus) ||
        !range(block.range) ||
        focus.start_line < block.range.start_line ||
        focus.end_line > block.range.end_line ||
        (focus.label !== undefined && !present(focus.label))
      ) {
        add('INVALID_FOCUS_RANGE', '重点范围必须位于完整代码块范围内，且可选 label 不能为空', {
          ...details,
          focus_range: focus,
        });
      }
    }
    for (const owned of disallowedBlocks) {
      const ownedCandidate = candidateById.get(owned.candidate_id);
      if (
        ownedCandidate?.file === candidate.file &&
        range(owned.range) &&
        range(block.range) &&
        overlaps(owned.range, block.range)
      ) {
        add(
          'BLOCK_ALREADY_ASSIGNED',
          `源码范围已归属于前序模块 ${owned.module_id}：${ownedCandidate.file} ${owned.range.start_line}-${owned.range.end_line}`,
          details,
        );
      }
    }
    const refs = stringList(block.evidence_refs) ? block.evidence_refs : [];
    if (!stringList(block.evidence_refs))
      add('INVALID_EVIDENCE_REFS', '代码块 evidence_refs 必须是字符串数组', details);
    for (const evidenceId of refs)
      if (!evidenceById.has(evidenceId))
        add('UNKNOWN_EVIDENCE', `代码块引用未知证据：${evidenceId}`, {
          ...details,
          evidence_id: evidenceId,
        });
    if (range(block.range)) {
      const submittedCoverage = coverageReport(
        refs.map((evidenceId) => evidenceById.get(evidenceId)),
        candidate,
        block.range,
        request.snapshot_id,
      );
      if (!submittedCoverage.complete) {
        const availableCoverage = coverageReport(
          evidence,
          candidate,
          block.range,
          request.snapshot_id,
        );
        const availableRefs = [
          ...new Set(availableCoverage.intervals.map((interval) => interval.id)),
        ];
        add('MISSING_SOURCE_EVIDENCE', `代码块 ${candidate.id} 缺少连续覆盖所选范围的源码证据`, {
          ...details,
          suggested_repair: {
            required_range: block.range,
            submitted_evidence_ranges: submittedCoverage.intervals,
            missing_ranges: submittedCoverage.missing,
            ...(availableCoverage.complete
              ? { use_existing_evidence_refs: availableRefs }
              : {
                  read: {
                    path: candidate.file,
                    offset: submittedCoverage.missing[0].start_line,
                    limit: lineCount(submittedCoverage.missing[0]),
                  },
                }),
          },
        });
      }
    }
    if (
      request.constraints?.allow_test_candidates !== true &&
      candidate.warnings?.includes('test_code')
    )
      add('TEST_CANDIDATE_SELECTED', `代码块不能选择测试候选：${candidate.id}`, details);
    if (
      request.goal?.source === 'default_main' &&
      /continue|continuation|follow[-_ ]?up|steer/i.test(candidate.name ?? '')
    ) {
      add(
        'NON_MAINLINE_CONTROL_PATH',
        `默认首次执行主线不能选择续跑/干预函数：${candidate.entity_id}`,
        details,
      );
    }
    if (
      /post.*run|after.*run/i.test(candidate.name ?? '') &&
      reservedCandidates.some((reserved) => {
        const future = candidateById.get(reserved.candidate_id);
        return /run.*loop|loop/i.test(future?.name ?? '');
      })
    )
      add(
        'POST_RUN_BEFORE_CORE_LOOP',
        `返回后处理 ${candidate.entity_id} 不能在后续核心循环之前展开`,
        details,
      );
    for (const reserved of reservedCandidates) {
      const reservedCandidate = candidateById.get(reserved.candidate_id);
      if (
        reservedCandidate?.file === candidate.file &&
        range(reservedCandidate.range) &&
        range(block.range) &&
        overlaps(reservedCandidate.range, block.range)
      ) {
        add(
          'BLOCK_RESERVED_FOR_LATER_MODULE',
          `源码范围已为后续模块 ${reserved.module_id} 保留：${reservedCandidate.entity_id} ${reservedCandidate.range.start_line}-${reservedCandidate.range.end_line}`,
          {
            ...details,
            reserved_candidate_id: reservedCandidate.id,
            reserved_module_id: reserved.module_id,
          },
        );
      }
    }
    for (let earlier = 0; earlier < index; earlier++) {
      const previous = blocks[earlier];
      const previousCandidate = candidateById.get(previous.candidate_id);
      if (
        previousCandidate?.file === candidate.file &&
        range(previous.range) &&
        range(block.range) &&
        overlaps(previous.range, block.range)
      ) {
        add(
          previous.candidate_id === block.candidate_id
            ? 'OVERLAPPING_BLOCKS'
            : 'OVERLAPPING_SOURCE_RANGES',
          previous.candidate_id === block.candidate_id
            ? `同一候选的代码块范围重叠：${candidate.id}`
            : `不同代码块重复展示源码范围：${candidate.file} ${Math.max(previous.range.start_line, block.range.start_line)}-${Math.min(previous.range.end_line, block.range.end_line)}`,
          details,
        );
      }
    }
    if (index === 0) {
      if (block.connection_from_previous !== undefined)
        add('UNEXPECTED_FIRST_BLOCK_CONNECTION', '模块首代码块不能声明模块内前序关系', details);
      continue;
    }
    const value = block.connection_from_previous,
      previousBlock = blocks[index - 1];
    if (!value || !present(value.relation) || !present(value.description)) {
      add('MISSING_BLOCK_CONNECTION', '后续代码块必须说明与前一代码块的关系', details);
      continue;
    }
    const forwardRelation = seed.relations.find(
      (item) =>
        item.from_candidate_id === previousBlock.candidate_id &&
        item.to_candidate_id === block.candidate_id,
    );
    if (
      value.relation === 'returns_to' &&
      !blocks.slice(0, index - 1).some((item) => item.candidate_id === block.candidate_id)
    ) {
      add(
        'RETURN_TO_UNSEEN_CALLER',
        forwardRelation
          ? `${previousBlock.candidate_id} 已在前且直接调用 ${block.candidate_id}；顺序正确，但关系不能标成 returns_to`
          : `不能从 ${previousBlock.candidate_id} 返回尚未阅读的调用者 ${block.candidate_id}；应先读调用者，再下钻被调用者`,
        {
          ...details,
          suggested_repair: forwardRelation
            ? {
                keep_block_order: [previousBlock.candidate_id, block.candidate_id],
                change_relation_to: forwardRelation.relation,
                required_fact_refs: forwardRelation.fact_refs,
              }
            : { move_caller_before_callee: [block.candidate_id, previousBlock.candidate_id] },
        },
      );
    }
    const previousCandidate = candidateById.get(previousBlock.candidate_id);
    if (!previousCandidate || !range(previousBlock.range) || !range(block.range)) continue;
    const support = connectionSupport({
      connection: value,
      previous: { ...previousBlock, candidate: previousCandidate },
      current: { ...block, candidate },
      priorBlocks: blocks.slice(0, index - 1),
      relations: seed.relations,
      evidenceById,
      snapshotId: request.snapshot_id,
    });
    if (support.factRefs.length && !support.graphRelation && !support.siblingSupport) {
      const repair = support.siblingOptions.length
        ? {
            suggested_relation: 'resumes_caller_then_calls',
            required_fact_refs: support.siblingOptions[0].fact_refs,
            prior_caller_candidate_id: support.siblingOptions[0].caller_candidate_id,
          }
        : forwardRelation
          ? {
              suggested_relation: forwardRelation.relation,
              required_fact_refs: forwardRelation.fact_refs,
              keep_block_order: [previousBlock.candidate_id, block.candidate_id],
            }
          : support.sourceSupported
            ? {
                suggested_action: 'remove_fact_refs',
                reason: '相邻代码块自身的源码证据已足以支持开放语义关系',
              }
            : {};
      add(
        'IRRELEVANT_CONNECTION_FACT',
        support.sameCandidateSequence
          ? `同一候选内的 sequence 已由非重叠递增行范围验证，fact_refs 必须清空；当前引用不支持 ${previousBlock.candidate_id} -> ${block.candidate_id}`
          : support.siblingOptions.length
            ? `前一块和当前块是某个已读调用者的兄弟调用；必须改用 resumes_caller_then_calls 并引用 suggested_repair 中的两条事实：${previousBlock.candidate_id} -> ${block.candidate_id}`
            : value.relation === 'returns_to'
              ? `returns_to 必须引用“当前块直接调用前一块”的原始调用事实；不能从深层被调用者直接跳到祖先的另一个子调用：${previousBlock.candidate_id} -> ${block.candidate_id}`
              : `关系事实不支持有向代码块对 ${previousBlock.candidate_id} -> ${block.candidate_id}；若源码证据已覆盖两端，删除 fact_refs，不要寻找或编造替代事实`,
        { ...details, suggested_repair: repair },
      );
    }
    if (
      !support.graphRelation &&
      !support.siblingSupport &&
      !support.sourceSupported &&
      !support.sameCandidateSequence
    )
      add(
        'UNSUPPORTED_CONNECTION',
        '相邻代码块关系缺少图谱、源码证据、共同已读调用者或同一候选内的前后顺序',
        details,
      );
    if (support.graphRelation?.relation === 'call_path')
      for (const symbolId of support.graphRelation.metadata?.intermediary_entity_ids ?? []) {
        if (!selectedSymbols.has(symbolId) && !omitted.has(symbolId))
          add(
            'UNDISPOSITIONED_PATH_SYMBOL',
            `间接调用中的符号既未阅读也未说明省略原因：${symbolId}`,
            details,
          );
      }
  }
  if (blocks.length && !blocks.some((block) => hintSet.has(block.candidate_id)))
    warn(
      'MODULE_HINT_NOT_COVERED',
      '模块代码块没有覆盖主 Agent 提供的候选锚点；已允许子 Agent 用源码证据替换粗粒度定位',
    );
  if (startCandidateIds.length && blocks[0] && !startCandidateIds.includes(blocks[0].candidate_id))
    add('INVALID_MODULE_START', `首模块必须从允许的入口候选开始：${blocks[0].candidate_id}`);
  for (const symbolId of omitted)
    if (selectedSymbols.has(symbolId))
      add('SELECTED_SYMBOL_OMITTED', `符号同时被选择和省略：${symbolId}`);
  return {
    valid: !issues.some((issue) => issue.severity === 'error'),
    issues,
    stats: {
      selected_blocks: blocks.length,
      distinct_candidates: selectedCandidates.size,
      omitted_symbols: omitted.size,
    },
  };
}

export function createSubmitModuleBlocksTool({
  request,
  seed,
  module,
  evidence,
  state,
  signal,
  startCandidateIds = [],
  disallowedBlocks = [],
  reservedCandidates = [],
  requiredCandidateIds = [],
  onAccepted = () => {},
}) {
  return {
    name: 'submit_module_blocks',
    label: '提交模块代码块',
    description: `提交当前语义模块内按阅读顺序排列的代码块和省略说明。硬约束：任何单个代码块都不得超过 ${request.limits.max_source_lines_per_read} 行；不超过该长度的函数必须提交完整候选范围且只出现一次，只有更长函数可拆成递增逻辑段；内部重点用 focus_ranges 标记。${requiredCandidateIds.length ? `模块目标明确点名的函数必须由当前或其他模块代码块完整覆盖：${requiredCandidateIds.join(', ')}。` : ''}${startCandidateIds.length ? `第一个代码块 candidate_id 必须是 ${startCandidateIds.join(' 或 ')}。` : ''}${disallowedBlocks.length ? `其他模块已占用 ${disallowedBlocks.length} 个候选范围，不能重叠；详见输入中的 ownership 字段。` : ''}${reservedCandidates.length ? `后续模块保留了 ${reservedCandidates.length} 个候选范围，当前模块不得提前占用；详见 input.future_module_reservations。` : ''}`,
    parameters: SUBMIT_MODULE_BLOCKS_SCHEMA,
    executionMode: 'sequential',
    async execute(_toolCallId, decision) {
      signal?.throwIfAborted();
      if (state.decision) throw new Error('当前模块代码块已经锁定');
      if (state.submissionAttempts >= request.limits.max_submission_attempts)
        throw new Error(`模块代码块已达到 ${request.limits.max_submission_attempts} 次提交上限`);
      state.submissionAttempts++;
      state.lastDecision = structuredClone(decision);
      const report = validateModuleBlockDecision({
        request,
        seed,
        module,
        decision,
        evidence,
        startCandidateIds,
        disallowedBlocks,
        reservedCandidates,
        requiredCandidateIds,
      });
      if (!report.valid) {
        state.lastReport = report;
        const evidenceCatalog = evidence.map((item) => ({
          id: item.id,
          file: item.file,
          range: item.range,
          candidate_ids: item.candidate_ids,
          intersecting_candidate_ids: item.intersecting_candidate_ids,
        }));
        const availableConnections = connectionCatalog(decision, seed.relations);
        throw new Error(
          `模块代码块未通过校验（第 ${state.submissionAttempts}/${request.limits.max_submission_attempts} 次）：${JSON.stringify({ issues: report.issues.slice(0, 20), evidence_catalog: evidenceCatalog, connection_catalog: availableConnections })}`,
        );
      }
      state.decision = structuredClone(decision);
      state.lastReport = undefined;
      onAccepted(state.decision);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'accepted',
              module_id: module.id,
              blocks: decision.blocks.length,
            }),
          },
        ],
      };
    },
  };
}
