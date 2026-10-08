import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { safePath } from '../snapshot.ts';
import {
  findFunctionRange,
  findLocalLoopCallees,
  nearbyFunctionEntries,
} from './function-ranges.ts';

const digest = (value) =>
  createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
const unique = (values) => [...new Set(values)];

function issue(code, message, details = {}) {
  return { code, message, ...details };
}
function relativePath(root, absolute) {
  return path.relative(root, absolute).split(path.sep).join('/');
}
function declarationSymbol(submitted, declared) {
  if (!declared) return submitted;
  return submitted?.split('.').at(-1) === declared ? submitted : declared;
}

/** A small discovery card, not a required reading list or a call-graph slice. */
export async function buildProjectBrief(snapshot) {
  const files = (snapshot.files ?? []).filter(
    (file) => typeof file === 'string' && !file.startsWith('.dekko/'),
  );
  const topLevel = unique(files.map((file) => file.split('/')[0])).slice(0, 30);
  const manifestPaths = files
    .filter((file) => /(^|\/)(package\.json|pyproject\.toml|Cargo\.toml|go\.mod)$/.test(file))
    .sort(
      (left, right) =>
        left.split('/').length - right.split('/').length || left.localeCompare(right),
    )
    .slice(0, 24);
  const manifests = [];
  for (const file of manifestPaths) {
    if (!file.endsWith('package.json')) {
      manifests.push({ file });
      continue;
    }
    try {
      const absolute = await safePath(snapshot.root, file),
        data = JSON.parse(await readFile(absolute, 'utf8'));
      manifests.push({
        file,
        name: data.name,
        description: data.description?.slice(0, 180),
        bin: data.bin,
        main: data.main,
        exports:
          typeof data.exports === 'string'
            ? data.exports
            : Object.keys(data.exports ?? {}).slice(0, 8),
        scripts: Object.keys(data.scripts ?? {})
          .filter((key) => /^(start|dev|serve|cli|test)$/.test(key))
          .slice(0, 8),
      });
    } catch {
      manifests.push({ file });
    }
  }
  const entryFileHints = files
    .filter(
      (file) =>
        /(^|\/)(main|cli|server|app|index)\.[cm]?[jt]sx?$/.test(file) &&
        !/(^|\/)(test|tests|examples|dist)\//.test(file),
    )
    .slice(0, 30);
  return {
    root_name: path.basename(snapshot.root),
    file_count: files.length,
    top_level: topLevel,
    manifests,
    entry_file_hints: entryFileHints,
  };
}

async function checkFile(snapshot, file, cache) {
  if (!nonempty(file)) throw new Error('文件路径不能为空');
  const absolute = await safePath(snapshot.root, file);
  const relative = relativePath(snapshot.root, absolute);
  if (!cache.has(relative)) cache.set(relative, (await readFile(absolute, 'utf8')).split('\n'));
  return { file: relative, lines: cache.get(relative) };
}

export async function validateSemanticPlan(snapshot, request, decision, cache = new Map()) {
  const issues = [];
  if (
    !nonempty(decision?.goal?.title) ||
    !nonempty(decision?.goal?.scenario) ||
    !nonempty(decision?.goal?.result) ||
    !nonempty(decision?.goal?.reason)
  ) {
    issues.push(issue('GOAL_INCOMPLETE', '需要给出路线标题、具体场景、可观察结果和选择理由'));
  } else {
    const title = decision.goal.title.trim(),
      scenario = decision.goal.scenario.trim(),
      result = decision.goal.result.trim();
    if (title.length > 32)
      issues.push(
        issue('GOAL_TITLE_TOO_LONG', '路线标题应在 32 个字符内，直说用户做什么以及最后得到什么', {
          length: title.length,
        }),
      );
    if (/(主干流程|调用链|执行链|源码路线)/.test(title))
      issues.push(
        issue(
          'GOAL_TITLE_INTERNAL',
          '路线标题不要使用规划或实现术语，应改成学习者能直接理解的动作与结果',
        ),
      );
    if (scenario.length > 180)
      issues.push(
        issue(
          'GOAL_SCENARIO_TOO_LONG',
          '场景介绍应控制在 180 个字符内，只写具体案例、核心动作和可见结果',
          { length: scenario.length },
        ),
      );
    if (result.length > 80)
      issues.push(
        issue('GOAL_RESULT_TOO_LONG', '可观察结果应是一句不超过 80 个字符的直白描述', {
          length: result.length,
        }),
      );
  }
  if (
    !Array.isArray(decision?.modules) ||
    decision.modules.length < 1 ||
    decision.modules.length > 12
  )
    issues.push(issue('MODULE_COUNT', '语义模块数量必须在 1–12 之间'));
  const ids = new Set();
  for (const [index, module] of (Array.isArray(decision?.modules)
    ? decision.modules
    : []
  ).entries()) {
    if (!nonempty(module?.id) || ids.has(module.id))
      issues.push(issue('MODULE_ID', `模块 ${index + 1} 缺少唯一 ID`));
    ids.add(module?.id);
    if (
      !nonempty(module?.title) ||
      !nonempty(module?.objective) ||
      !nonempty(module?.reason) ||
      !nonempty(module?.expected_input) ||
      !nonempty(module?.expected_outcome)
    )
      issues.push(issue('MODULE_CONTENT', `模块 ${index + 1} 缺少标题、目标或职责输入与产出`));
    else if (module.title.trim().length > 32)
      issues.push(
        issue(
          'MODULE_TITLE_TOO_LONG',
          `模块 ${index + 1} 的标题应在 32 个字符内，只写本章的核心职责`,
        ),
      );
    if (!Array.isArray(module?.files) || module.files.length < 1 || module.files.length > 10) {
      issues.push(issue('MODULE_FILES', `模块 ${index + 1} 需要 1–10 个参考文件`));
      continue;
    }
    for (const file of module.files)
      try {
        await checkFile(snapshot, file, cache);
      } catch {
        issues.push(
          issue('UNKNOWN_FILE', `模块 ${index + 1} 的参考文件不存在或不在项目内：${file}`),
        );
      }
  }
  return issues;
}

export async function resolveModuleFlow(
  snapshot,
  module,
  decision,
  sourceGraph,
  cache = new Map(),
) {
  if ((decision?.outgoing || decision?.handoff_from_previous) && decision?.execution) {
    const { outgoing, handoff_from_previous, ...flow } = decision;
    const normalizedOutgoing = outgoing && (({ to_id: _ignored, ...value }) => value)(outgoing);
    decision = {
      ...flow,
      execution: {
        ...decision.execution,
        ...(!decision.execution.outgoing && normalizedOutgoing
          ? { outgoing: normalizedOutgoing }
          : {}),
        ...(!decision.execution.handoff_from_previous && handoff_from_previous
          ? { handoff_from_previous }
          : {}),
      },
    };
  }
  if (decision?.execution?.outgoing?.to_id) {
    const { to_id: _ignored, ...outgoing } = decision.execution.outgoing;
    decision = { ...decision, execution: { ...decision.execution, outgoing } };
  }
  if (decision?.status === 'blocked') return { flow: decision, issues: [] };
  const issues = [],
    blocks = [],
    groups = [];
  // Keep numeric indices internal; submitted IDs survive selection and reordering.
  if (
    decision?.execution?.entry_id !== undefined ||
    decision?.blocks?.some((block) => block.id !== undefined)
  ) {
    const orders = new Map();
    for (const [index, block] of (decision.blocks ?? []).entries()) {
      if (!nonempty(block.id) || orders.has(block.id))
        issues.push(issue('FUNCTION_ID', '每个函数需要唯一且稳定的 id', { id: block.id }));
      else orders.set(block.id, index + 1);
    }
    const order = (id) => {
      if (!orders.has(id))
        issues.push(
          issue('UNKNOWN_FUNCTION_ID', '执行关系引用了未提交的函数 ID', {
            id,
            available_ids: [...orders.keys()],
          }),
        );
      return orders.get(id);
    };
    const {
      entry_id,
      implementation_id,
      exit_id,
      links = [],
      outgoing,
      handoff_from_previous,
      ...rest
    } = decision.execution ?? {};
    const from = ({ from_id, ...link }) => ({ ...link, from_block_order: order(from_id) });
    const link = ({ to_id, ...value }) => ({ ...from(value), to_block_order: order(to_id) });
    decision = {
      ...decision,
      execution: {
        ...rest,
        entry_block_order: order(entry_id),
        implementation_block_order: order(implementation_id),
        exit_block_order: order(exit_id),
        links: links.map(link),
        ...(outgoing ? { outgoing: from(outgoing) } : {}),
        ...(handoff_from_previous
          ? {
              handoff_from_previous: {
                ...handoff_from_previous,
                to_block_order: order(handoff_from_previous.to_id),
              },
            }
          : {}),
      },
    };
    if (!decision.investigation)
      issues.push(
        issue(
          'MISSING_INVESTIGATION',
          '需要提交结果形成的源码证据和关键调用取舍；不必记录所有辅助函数',
        ),
      );
    else
      decision = {
        ...decision,
        investigation: {
          ...decision.investigation,
          decisions: (decision.investigation.decisions ?? []).map(from),
        },
      };
  }
  for (const [index, entry] of (Array.isArray(decision?.blocks) ? decision.blocks : []).entries()) {
    if (!Number.isInteger(entry?.entry_line) || entry.entry_line < 1) {
      issues.push(issue('FUNCTION_ENTRY', `函数 ${index + 1} 需要声明所在的 entry_line`));
      continue;
    }
    let source;
    try {
      source = await checkFile(snapshot, entry.file, cache);
    } catch {
      issues.push(
        issue('UNKNOWN_BLOCK_FILE', `函数 ${index + 1} 的文件不存在或不在项目内：${entry.file}`),
      );
      continue;
    }
    const range = findFunctionRange({
      file: source.file,
      lines: source.lines,
      entry_line: entry.entry_line,
      symbol: entry.symbol,
      sourceGraph,
    });
    if (!range) {
      issues.push(
        issue(
          'UNRESOLVED_FUNCTION',
          `无法在 ${source.file}:${entry.entry_line} 唯一定位函数 ${entry.symbol ?? ''}；请提交声明行和准确函数名`,
          {
            candidate_entry_lines: nearbyFunctionEntries({
              file: source.file,
              lines: source.lines,
              entry_line: entry.entry_line,
              symbol: entry.symbol,
              sourceGraph,
            }),
          },
        ),
      );
      continue;
    }
    const first = blocks.length + 1;
    const base = {
      ...entry,
      file: source.file,
      symbol: declarationSymbol(entry.symbol, range.name),
      kind: entry.kind ?? 'function',
      function_entry_line: range.start_line,
    };
    delete base.entry_line;
    delete base.split;
    if (!entry.split || range.end_line - range.start_line + 1 < 160)
      blocks.push({
        ...base,
        start_line: range.start_line,
        end_line: range.end_line,
        ...(entry.split ? { range_note: '普通函数保持完整，已忽略切分请求' } : {}),
      });
    else {
      const { boundary_line: boundary, reason, before, after } = entry.split;
      if (
        !nonempty(reason) ||
        !nonempty(before) ||
        !nonempty(after) ||
        !range.split_boundary_lines?.includes(boundary) ||
        boundary - range.start_line < 20 ||
        range.end_line - boundary + 1 < 20
      ) {
        issues.push(
          issue(
            'INVALID_FUNCTION_SPLIT',
            `${source.file}:${range.start_line} 的切分需要长函数、不同语义职责和有效语句边界`,
          ),
        );
        continue;
      }
      const split_group = `${source.file}:${range.start_line}`;
      blocks.push({
        ...base,
        start_line: range.start_line,
        end_line: boundary - 1,
        title: `${entry.title}：${before}`,
        split_group,
        split_part: 1,
        split_reason: reason,
      });
      blocks.push({
        ...base,
        start_line: boundary,
        end_line: range.end_line,
        title: `${entry.title}：${after}`,
        split_group,
        split_part: 2,
        split_reason: reason,
      });
    }
    groups.push({ first, last: blocks.length, file: source.file });
  }
  const original = decision?.execution;
  if (!original || groups.length !== decision.blocks?.length)
    return { flow: { ...decision, blocks }, issues };
  const segmentAt = (order, line, fallback) => {
    const group = groups[order - 1];
    if (!group) return order;
    if (Number.isInteger(line)) {
      for (let blockOrder = group.first; blockOrder <= group.last; blockOrder++) {
        const block = blocks[blockOrder - 1];
        if (line >= block.start_line && line <= block.end_line) return blockOrder;
      }
    }
    return group[fallback];
  };
  const links = (original.links ?? []).map((link) => ({
    ...link,
    from_block_order: segmentAt(link.from_block_order, link.call_line, 'last'),
    to_block_order: segmentAt(
      link.to_block_order,
      link.relation === 'returns' ? link.call_line : undefined,
      link.relation === 'returns' ? 'last' : 'first',
    ),
  }));
  for (const group of groups)
    if (group.first !== group.last)
      links.push({
        from_block_order: group.first,
        to_block_order: group.last,
        relation: 'continues',
        description: blocks[group.last - 1].split_reason,
      });
  const execution = {
    ...original,
    entry_block_order: segmentAt(original.entry_block_order, undefined, 'first'),
    implementation_block_order: segmentAt(original.implementation_block_order, undefined, 'first'),
    exit_block_order: segmentAt(original.exit_block_order, undefined, 'last'),
    links,
    ...(original.outgoing
      ? {
          outgoing: {
            ...original.outgoing,
            from_block_order: segmentAt(
              original.outgoing.from_block_order,
              original.outgoing.call_line,
              'last',
            ),
          },
        }
      : {}),
    ...(original.handoff_from_previous
      ? {
          handoff_from_previous: {
            ...original.handoff_from_previous,
            to_block_order: segmentAt(
              original.handoff_from_previous.to_block_order,
              undefined,
              'first',
            ),
          },
        }
      : {}),
  };
  const investigation = decision.investigation && {
    ...decision.investigation,
    decisions: (decision.investigation.decisions ?? []).map((item) => ({
      ...item,
      from_block_order: segmentAt(item.from_block_order, item.call_line, 'last'),
    })),
  };
  return {
    flow: { ...decision, blocks, execution, ...(investigation ? { investigation } : {}) },
    issues,
  };
}

export async function validateModuleFlow(
  snapshot,
  module,
  decision,
  cache = new Map(),
  sourceGraph,
) {
  const resolved = await resolveModuleFlow(snapshot, module, decision, sourceGraph, cache);
  return resolved.issues.length
    ? resolved.issues
    : validateResolvedModuleFlow(snapshot, module, resolved.flow, cache);
}

function executionPathExists(execution, start, end) {
  if (start === end) return true;
  const visited = new Set([start]),
    queue = [start];
  while (queue.length) {
    const current = queue.shift();
    for (const link of execution?.links ?? []) {
      if (link.relation === 'returns' || link.from_block_order !== current) continue;
      if (link.to_block_order === end) return true;
      if (!visited.has(link.to_block_order)) {
        visited.add(link.to_block_order);
        queue.push(link.to_block_order);
      }
    }
  }
  return false;
}

function directCallOnLine(line, symbol) {
  const name = symbol?.split('.').at(-1);
  if (!name) return null;
  const calls = [...line.matchAll(/([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/g)]
    .map((match) => match[1])
    .filter((callee) => callee.split('.').at(-1) === name);
  return calls.length === 1 ? calls[0] : null;
}

/** Fill a uniquely provable synchronous caller edge instead of asking the model to restate it. */
async function repairDirectReturnCalls(snapshot, flow, cache) {
  const execution = flow.execution;
  if (!execution?.links?.length) return;
  const repairs = [];
  for (const link of [...execution.links]) {
    if (
      link.candidate_id ||
      link.relation !== 'returns' ||
      executionPathExists(execution, link.to_block_order, link.from_block_order)
    )
      continue;
    const caller = flow.blocks?.[link.to_block_order - 1],
      callee = flow.blocks?.[link.from_block_order - 1];
    if (!caller || !callee) continue;
    let source;
    try {
      source = await checkFile(snapshot, caller.file, cache);
    } catch {
      continue;
    }
    const matches = [];
    for (let line = caller.start_line; line <= caller.end_line; line++) {
      const direct = directCallOnLine(source.lines[line - 1] ?? '', callee.symbol);
      if (direct) matches.push({ line, callee: direct });
    }
    if (matches.length !== 1) continue;
    const added = {
      from_block_order: link.to_block_order,
      to_block_order: link.from_block_order,
      relation: 'calls',
      description: `${caller.symbol} 在源码中直接调用 ${callee.symbol}`,
      call_line: matches[0].line,
      callee: matches[0].callee,
      derived: true,
    };
    execution.links.push(added);
    repairs.push({
      code: 'DERIVED_MISSING_CALL_EDGE',
      return_from: callee.id,
      return_to: caller.id,
      added_link: added,
    });
  }
  if (repairs.length) flow.deterministic_repairs = repairs;
}

async function validateResolvedModuleFlow(snapshot, module, decision, cache = new Map()) {
  const issues = [];
  if (decision?.module_id !== module.id)
    issues.push(issue('MODULE_MISMATCH', `输出必须属于模块 ${module.id}`));
  if (decision?.status === 'blocked')
    return nonempty(decision?.concern)
      ? issues
      : [...issues, issue('MISSING_CONCERN', '无法展开时请说明阻碍')];
  if (decision?.status !== 'ready')
    issues.push(issue('INVALID_STATUS', '模块状态必须为 ready 或 blocked'));
  if (
    !Array.isArray(decision?.blocks) ||
    decision.blocks.length < 1 ||
    decision.blocks.length > 12
  ) {
    const count = decision?.blocks?.length ?? 0;
    const splitFunctionIds = unique(
      (decision?.blocks ?? [])
        .filter((block) => block.split_group)
        .map((block) => block.id ?? block.symbol),
    );
    issues.push(
      issue(
        'BLOCK_COUNT',
        `完整函数与长函数切分后共有 ${count} 个代码块，需要收紧到 1–12 个；删除非必读函数或取消不必要的长函数切分`,
        {
          resolved_block_count: count,
          split_function_ids: splitFunctionIds,
        },
      ),
    );
  }
  for (const [index, block] of (Array.isArray(decision?.blocks) ? decision.blocks : []).entries()) {
    if (!nonempty(block?.title) || !nonempty(block?.reason))
      issues.push(issue('BLOCK_CONTENT', `代码块 ${index + 1} 缺少标题或选择理由`));
    if (
      !Number.isInteger(block?.start_line) ||
      !Number.isInteger(block?.end_line) ||
      block.start_line < 1 ||
      block.end_line < block.start_line
    ) {
      issues.push(issue('BLOCK_RANGE', `代码块 ${index + 1} 行范围无效`));
      continue;
    }
    try {
      const source = await checkFile(snapshot, block.file, cache);
      if (block.end_line > source.lines.length)
        issues.push(
          issue(
            'BLOCK_OUT_OF_FILE',
            `代码块 ${index + 1} 超过 ${source.file} 的 ${source.lines.length} 行`,
          ),
        );
    } catch {
      issues.push(
        issue('UNKNOWN_BLOCK_FILE', `代码块 ${index + 1} 的文件不存在或不在项目内：${block.file}`),
      );
    }
  }
  if (decision?.status === 'ready') {
    const count = decision.blocks?.length ?? 0,
      execution = decision.execution;
    if (execution && Array.isArray(decision.blocks))
      await repairDirectReturnCalls(snapshot, decision, cache);
    if (
      !execution ||
      !['entry_block_order', 'implementation_block_order', 'exit_block_order'].every(
        (key) => Number.isInteger(execution[key]) && execution[key] >= 1 && execution[key] <= count,
      )
    )
      issues.push(
        issue(
          'EXECUTION_ANCHORS',
          `模块 ${module.id} 必须标出入口、关键实现和出口；返回可指向前面的函数`,
        ),
      );
    if (!Array.isArray(execution?.links))
      issues.push(issue('EXECUTION_LINKS', `模块 ${module.id} 缺少代码块间的执行交接`));
    else
      for (const link of execution.links)
        issues.push(
          ...(link.candidate_id
            ? await validateCandidateBackedLink(snapshot, decision.blocks, link, cache, module.id)
            : await validateCallLink(snapshot, decision.blocks, link, cache, module.id)),
        );
    if (execution?.outgoing)
      issues.push(
        ...(execution.outgoing.candidate_id
          ? await validateCandidateBackedOutgoing(
              snapshot,
              decision.blocks,
              execution.outgoing,
              cache,
              module.id,
            )
          : await validateOutgoing(
              snapshot,
              decision.blocks,
              execution.outgoing,
              cache,
              module.id,
            )),
      );
    if (execution?.handoff_from_previous?.call_file)
      issues.push(
        ...(await validateBridgeHandoff(
          snapshot,
          decision.blocks,
          execution.handoff_from_previous,
          cache,
          module.id,
        )),
      );
    if (execution?.handoff_from_previous?.resume)
      issues.push(
        ...(await validateHandoffResume(
          snapshot,
          decision.blocks,
          execution.handoff_from_previous,
          cache,
          module.id,
        )),
      );
    if (execution?.outgoing?.relation === 'calls') {
      const delegated = execution.outgoing.callee?.split('.').at(-1);
      const repeated = decision.blocks.filter(
        (block) => block.symbol?.split('.').at(-1) === delegated,
      );
      if (repeated.length)
        issues.push(
          issue(
            'DELEGATED_FUNCTION_INCLUDED',
            '已交给下一模块的被调实现不应同时列为本模块阅读块；保留调用方和返回后的处理',
            {
              callee: delegated,
              function_ids: repeated.map((block) => block.id),
            },
          ),
        );
    }
    if (execution?.implementation_block_order && Array.isArray(decision.blocks))
      issues.push(
        ...(await auditCoreLoopDelegation(snapshot, decision.blocks, execution, cache, module.id)),
      );
    if (execution && Array.isArray(decision.blocks)) {
      issues.push(
        ...flowChainIssues(
          decision,
          decision.blocks.map((_, index) => index + 1),
          module.id,
        ),
      );
      issues.push(...callOrderIssues(decision, module.id));
    }
    if (decision.investigation) {
      issues.push(
        ...(await validateEvidence(
          snapshot,
          decision.investigation.outcome,
          cache,
          `${module.id} 的结果`,
        )),
      );
      for (const item of decision.investigation.decisions ?? []) {
        const from = decision.blocks[item.from_block_order - 1];
        if (!from) {
          issues.push(issue('INVESTIGATION_SOURCE', '调查取舍必须来自已提交函数的调用点'));
          continue;
        }
        const candidateOutgoing =
          item.disposition === 'next_module' && execution?.outgoing?.candidate_id;
        if (!candidateOutgoing) {
          issues.push(
            ...(await validateCallSite(
              snapshot,
              from,
              item.call_line,
              item.callee,
              cache,
              module.id,
            )),
          );
          issues.push(
            ...(await validateEvidence(
              snapshot,
              { description: item.reason, evidence: item.evidence },
              cache,
              `${module.id} 的调用取舍`,
            )),
          );
        }
        if (!['excluded', 'next_module'].includes(item.disposition))
          issues.push(issue('INVESTIGATION_DISPOSITION', '调用取舍必须为 excluded 或 next_module'));
        if (
          item.disposition === 'next_module' &&
          execution?.outgoing?.from_block_order !== item.from_block_order
        )
          issues.push(
            issue('INVESTIGATION_HANDOFF', '交给下一模块的调用必须与 outgoing 对应', {
              callee: item.callee,
            }),
          );
      }
    }
  }
  return issues;
}

function callOrderIssues(flow, label) {
  const callsBySource = new Map();
  for (const link of flow.execution?.links ?? []) {
    if (link.relation !== 'calls' || !Number.isInteger(link.call_line)) continue;
    const calls = callsBySource.get(link.from_block_order) ?? [];
    calls.push(link);
    callsBySource.set(link.from_block_order, calls);
  }
  const issues = [];
  for (const [fromOrder, calls] of callsBySource) {
    const bySource = [...calls].sort((left, right) => left.call_line - right.call_line);
    for (let index = 1; index < bySource.length; index++) {
      const previous = bySource[index - 1],
        current = bySource[index];
      if (
        previous.call_line < current.call_line &&
        previous.to_block_order > current.to_block_order
      ) {
        issues.push(
          issue('CALL_ORDER', `${label} 中同一调用方的被调函数没有按源码首次调用顺序排列`, {
            from_block_order: fromOrder,
            earlier: {
              call_line: previous.call_line,
              to_block_order: previous.to_block_order,
              callee: previous.callee,
            },
            later: {
              call_line: current.call_line,
              to_block_order: current.to_block_order,
              callee: current.callee,
            },
          }),
        );
      }
    }
  }
  return issues;
}

async function auditCoreLoopDelegation(snapshot, blocks, execution, cache, label) {
  const core = blocks[execution.implementation_block_order - 1];
  if (!core?.function_entry_line) return [];
  const source = await checkFile(snapshot, core.file, cache);
  const issues = [];
  for (const call of findLocalLoopCallees({
    file: core.file,
    lines: source.lines,
    entry_line: core.function_entry_line,
    symbol: core.symbol,
  })) {
    if (call.call_line < core.start_line || call.call_line > core.end_line) continue;
    if (
      blocks.some(
        (block) => block.file === core.file && block.function_entry_line === call.target_entry_line,
      )
    )
      continue;
    if (
      execution.outgoing?.relation === 'calls' &&
      execution.outgoing.call_line === call.call_line &&
      execution.outgoing.callee?.split('.').at(-1) === call.callee
    )
      continue;
    issues.push(
      issue(
        'POSSIBLE_MISSING_CORE_LOOP',
        `${label} 的核心块在 ${core.file}:${call.call_line} 调用同文件的循环函数 ${call.callee}，但没有阅读其实现或明确交给下一模块`,
        {
          source_file: core.file,
          call_line: call.call_line,
          callee: call.callee,
          target_entry_line: call.target_entry_line,
        },
      ),
    );
  }
  return issues;
}

async function validateCallLink(snapshot, blocks, link, cache, label) {
  const issues = [];
  const from = blocks?.[link?.from_block_order - 1],
    to = blocks?.[link?.to_block_order - 1];
  if (
    !from ||
    !to ||
    link.from_block_order === link.to_block_order ||
    !nonempty(link.description) ||
    !['calls', 'continues', 'returns'].includes(link.relation)
  )
    return [
      issue('INVALID_EXECUTION_LINK', `${label} 的执行交接指向无效代码块或缺少关系说明`, {
        from_block_order: link?.from_block_order,
        to_block_order: link?.to_block_order,
        block_count: blocks?.length,
      }),
    ];
  if (link.condition)
    issues.push(
      ...(await validateEvidence(snapshot, link.condition, cache, `${label} 的分支条件`)),
    );
  if (link.relation !== 'calls') return issues;
  issues.push(
    ...(await validateCallSite(snapshot, from, link.call_line, link.callee, cache, label)),
  );
  if (nonempty(link.callee) && !calleeMatchesSymbol(link.callee, to.symbol))
    issues.push(
      issue(
        'CALL_TARGET',
        `${label} 的被调函数 ${link.callee} 与目标块 ${to.symbol ?? to.file} 不符`,
      ),
    );
  return issues;
}

async function validateCandidateBackedLink(snapshot, blocks, link, cache, label) {
  const from = blocks?.[link?.from_block_order - 1],
    to = blocks?.[link?.to_block_order - 1],
    issues = [];
  if (
    !from ||
    !to ||
    link.from_block_order === link.to_block_order ||
    !nonempty(link.candidate_id) ||
    !nonempty(link.description) ||
    !['calls', 'continues', 'returns', 'handoff'].includes(link.relation)
  )
    return [
      issue('INVALID_EXECUTION_LINK', `${label} 的候选关系指向无效代码块`, {
        candidate_id: link?.candidate_id,
        from_block_order: link?.from_block_order,
        to_block_order: link?.to_block_order,
      }),
    ];
  if (link.condition)
    issues.push(
      ...(await validateEvidence(snapshot, link.condition, cache, `${label} 的分支条件`)),
    );
  return issues;
}

function calleeName(callee) {
  return callee
    ?.trim()
    .replace(/^new\s+/, '')
    .replace(/\(.*$/, '')
    .split('.')
    .at(-1);
}

function calleeMatchesSymbol(callee, symbol) {
  const parts = symbol?.split('.') ?? [];
  return parts.at(-1) === 'constructor'
    ? parts.at(-2) === calleeName(callee)
    : parts.at(-1) === calleeName(callee);
}

async function validateEvidence(snapshot, claim, cache, label) {
  if (!nonempty(claim?.description) || !Array.isArray(claim?.evidence) || !claim.evidence.length)
    return [issue('MISSING_SOURCE_EVIDENCE', `${label} 需要简短结论及源码证据`)];
  const issues = [];
  for (const evidence of claim.evidence) {
    try {
      const source = await checkFile(snapshot, evidence.file, cache);
      if (
        !Number.isInteger(evidence.line) ||
        !nonempty(evidence.quote) ||
        !source.lines[evidence.line - 1]?.includes(evidence.quote.trim())
      )
        issues.push(
          issue('SOURCE_EVIDENCE_MISMATCH', `${label} 的引文与源码行不符`, {
            file: evidence.file,
            line: evidence.line,
          }),
        );
    } catch {
      issues.push(
        issue('SOURCE_EVIDENCE_FILE', `${label} 的证据文件无效`, { file: evidence.file }),
      );
    }
  }
  return issues;
}

async function validateCallSite(snapshot, from, callLine, callee, cache, label) {
  if (
    !Number.isInteger(callLine) ||
    callLine < from.start_line ||
    callLine > from.end_line ||
    !nonempty(callee)
  )
    return [
      issue('CALL_SITE', `${label} 的调用交接需要源代码块内的调用行和目标函数名`, {
        call_line: callLine,
        callee,
        source_file: from.file,
        source_range: [from.start_line, from.end_line],
      }),
    ];
  try {
    const source = await checkFile(snapshot, from.file, cache);
    const name = calleeName(callee);
    if (source.lines[callLine - 1]?.includes(name)) return [];
    const candidateLines = source.lines
      .slice(from.start_line - 1, from.end_line)
      .flatMap((line, index) => (line.includes(name) ? [from.start_line + index] : []))
      .slice(0, 6);
    return [
      issue('CALL_TARGET', `${label} 的 ${from.file}:${callLine} 未出现被调函数 ${callee}`, {
        candidate_call_lines: candidateLines,
      }),
    ];
  } catch {
    return [issue('CALL_SITE', `${label} 的调用点文件无法读取`)];
  }
}

async function validateOutgoing(snapshot, blocks, outgoing, cache, label) {
  const from = blocks?.[outgoing?.from_block_order - 1];
  if (
    !from ||
    !nonempty(outgoing.description) ||
    !['calls', 'continues', 'returns'].includes(outgoing.relation)
  )
    return [issue('INVALID_OUTGOING', `${label} 的模块出口指向无效代码块`)];
  return [
    ...(outgoing.relation === 'calls'
      ? await validateCallSite(snapshot, from, outgoing.call_line, outgoing.callee, cache, label)
      : []),
    ...(outgoing.condition
      ? await validateEvidence(snapshot, outgoing.condition, cache, `${label} 的出口条件`)
      : []),
  ];
}

async function validateCandidateBackedOutgoing(snapshot, blocks, outgoing, cache, label) {
  const from = blocks?.[outgoing?.from_block_order - 1],
    issues = [];
  if (
    !from ||
    !nonempty(outgoing.candidate_id) ||
    !nonempty(outgoing.description) ||
    !['calls', 'continues', 'returns', 'handoff'].includes(outgoing.relation)
  )
    return [issue('INVALID_OUTGOING', `${label} 的候选模块出口指向无效代码块`)];
  if (outgoing.condition)
    issues.push(
      ...(await validateEvidence(snapshot, outgoing.condition, cache, `${label} 的出口条件`)),
    );
  return issues;
}

async function validateModuleHandoff(snapshot, previous, flow, cache) {
  const handoff = flow.execution?.handoff_from_previous;
  if (!previous) return handoff ? [issue('UNEXPECTED_HANDOFF', '第一个模块不应声明前序交接')] : [];
  if (previous.status !== 'ready' || flow.status !== 'ready') return [];
  if (!handoff)
    return [issue('MISSING_HANDOFF', `模块 ${flow.module_id} 缺少来自前一模块的执行交接`)];
  const from = previous.blocks?.[handoff.from_block_order - 1],
    to = flow.blocks?.[handoff.to_block_order - 1];
  if (
    !from ||
    !to ||
    !nonempty(handoff.description) ||
    !['calls', 'continues', 'returns', 'handoff'].includes(handoff.relation)
  )
    return [issue('INVALID_HANDOFF', `模块 ${flow.module_id} 的跨模块交接指向无效代码块`)];
  if (handoff.candidate_id) return [];
  if (handoff.relation !== 'calls') return [];
  if (nonempty(handoff.call_file)) return [];
  return validateCallLink(
    snapshot,
    [from, to],
    { ...handoff, from_block_order: 1, to_block_order: 2 },
    cache,
    flow.module_id,
  );
}

async function validateBridgeHandoff(snapshot, blocks, handoff, cache, label) {
  const issues = [],
    to = blocks?.[handoff.to_block_order - 1];
  try {
    const source = await checkFile(snapshot, handoff.call_file, cache);
    const name = calleeName(handoff.callee);
    if (
      !Number.isInteger(handoff.call_line) ||
      !nonempty(name) ||
      !source.lines[handoff.call_line - 1]?.includes(name)
    ) {
      issues.push(
        issue('HANDOFF_CALL_SITE', `${label} 的桥接调用点与源码不符`, {
          call_file: source.file,
          call_line: handoff.call_line,
          callee: handoff.callee,
        }),
      );
    }
  } catch {
    issues.push(
      issue('HANDOFF_CALL_SITE', `${label} 的桥接调用文件无效`, { call_file: handoff.call_file }),
    );
  }
  if (!to || (nonempty(handoff.callee) && !calleeMatchesSymbol(handoff.callee, to.symbol)))
    issues.push(
      issue(
        'CALL_TARGET',
        `${label} 的桥接被调函数 ${handoff.callee} 与目标块 ${to?.symbol ?? to?.file ?? '未知'} 不符`,
      ),
    );
  return issues;
}

async function validateHandoffResume(snapshot, blocks, handoff, cache, label) {
  const to = blocks?.[handoff.to_block_order - 1],
    resume = handoff.resume;
  if (
    handoff.relation !== 'continues' ||
    !to ||
    resume.file !== to.file ||
    resume.line < to.start_line ||
    resume.line > to.end_line
  ) {
    return [
      issue(
        'HANDOFF_RESUME_POINT',
        `${label} 的继续点必须位于当前目标函数内且 relation 为 continues`,
        {
          resume_file: resume.file,
          resume_line: resume.line,
          target_file: to?.file,
          target_range: to ? [to.start_line, to.end_line] : undefined,
        },
      ),
    ];
  }
  return validateEvidence(
    snapshot,
    { description: handoff.description, evidence: [resume] },
    cache,
    `${label} 的继续点`,
  );
}

export function inferHandoff(previous, flow) {
  if (
    !previous ||
    previous.status !== 'ready' ||
    flow.status !== 'ready' ||
    flow.execution?.handoff_from_previous
  )
    return;
  const outgoing = previous.execution?.outgoing;
  if (outgoing?.candidate_id) {
    const candidate = outgoing.candidate_target,
      order = flow.blocks?.findIndex(
        (block) =>
          candidate?.file === block.file &&
          candidate.start_line <= block.end_line &&
          block.start_line <= candidate.end_line,
      );
    if (order >= 0) {
      flow.execution ??= {};
      flow.execution.handoff_from_previous = {
        from_block_order: outgoing.from_block_order,
        to_block_order: order + 1,
        candidate_id: outgoing.candidate_id,
        relation: outgoing.relation,
        description: outgoing.description,
        call_line: outgoing.call_line,
        candidate_source: outgoing.candidate_source,
        candidate_target: outgoing.candidate_target,
        ...(outgoing.callee ? { callee: outgoing.callee } : {}),
      };
      return;
    }
  }
  if (outgoing?.relation === 'calls' && nonempty(outgoing.callee)) {
    const order = flow.blocks?.findIndex(
      (block) => block.symbol?.split('.').at(-1) === outgoing.callee.split('.').at(-1),
    );
    if (order >= 0) {
      flow.execution ??= {};
      flow.execution.handoff_from_previous = {
        from_block_order: outgoing.from_block_order,
        to_block_order: order + 1,
        relation: 'calls',
        description: outgoing.description,
        call_line: outgoing.call_line,
        callee: outgoing.callee,
      };
      return;
    }
  }
  for (const link of previous.execution?.links ?? []) {
    if (link.relation !== 'calls') continue;
    const target = previous.blocks?.[link.to_block_order - 1];
    const order = flow.blocks?.findIndex(
      (block) =>
        block.file === target?.file &&
        block.symbol?.split('.').at(-1) === target?.symbol?.split('.').at(-1) &&
        block.start_line <= target.end_line &&
        target.start_line <= block.end_line,
    );
    if (order < 0) continue;
    flow.execution ??= {};
    flow.execution.handoff_from_previous = {
      from_block_order: link.from_block_order,
      to_block_order: order + 1,
      relation: 'calls',
      description: link.description,
      call_line: link.call_line,
      callee: link.callee,
    };
    return;
  }
}

function flowChainIssues(flow, orders, label) {
  const execution = flow.execution;
  if (!execution) return [issue('MISSING_EXECUTION', `${label} 缺少执行链`)];
  const identify = (order) => {
    const block = flow.blocks[order - 1];
    return { id: block?.id, symbol: block?.symbol, file: block?.file, block_order: order };
  };
  const anchors = [
    execution.entry_block_order,
    execution.implementation_block_order,
    execution.exit_block_order,
  ];
  if (anchors.some((order) => !orders.includes(order)))
    return [issue('MISSING_IMPLEMENTATION', `${label} 的入口、关键实现或出口块被遗漏`)];
  const reachable = (start, end, allowReturns = true) => {
    if (start === end) return true;
    const visited = new Set([start]),
      queue = [start];
    while (queue.length) {
      const current = queue.shift();
      for (const link of execution.links ?? []) {
        if (!allowReturns && link.relation === 'returns') continue;
        if (link.from_block_order !== current || !orders.includes(link.to_block_order)) continue;
        if (link.to_block_order === end) return true;
        if (!visited.has(link.to_block_order)) {
          visited.add(link.to_block_order);
          queue.push(link.to_block_order);
        }
      }
    }
    return false;
  };
  for (const link of execution.links ?? []) {
    if (
      link.relation === 'returns' &&
      !reachable(link.to_block_order, link.from_block_order, false)
    ) {
      const returnedFrom = identify(link.from_block_order),
        claimedCaller = identify(link.to_block_order),
        knownCallers = (execution.links ?? [])
          .filter(
            (candidate) =>
              candidate.relation === 'calls' && candidate.to_block_order === link.from_block_order,
          )
          .map((candidate) => identify(candidate.from_block_order));
      return [
        issue(
          knownCallers.length ? 'RETURN_TARGET_NOT_CALLER' : 'MISSING_CALL_EDGE_FOR_RETURN',
          knownCallers.length
            ? `${label} 的返回目标不是已提交的上游调用者`
            : `${label} 的返回边缺少与之配套的上游 calls 边`,
          {
            from: returnedFrom,
            to: claimedCaller,
            known_callers: knownCallers,
            repair: {
              action: knownCallers.length ? 'change_return_target' : 'add_call_edge',
              expected_link: knownCallers.length
                ? {
                    from_id: returnedFrom.id,
                    to_id: knownCallers[0].id,
                    relation: 'returns',
                  }
                : {
                    from_id: claimedCaller.id,
                    to_id: returnedFrom.id,
                    relation: 'calls',
                    required: ['call_line', 'callee'],
                  },
            },
          },
        ),
      ];
    }
  }
  for (const [start, end] of [
    [anchors[0], anchors[1]],
    [anchors[1], anchors[2]],
  ]) {
    if (!reachable(start, end))
      return [
        issue(
          'BROKEN_EXECUTION_CHAIN',
          `${label} 的关键实现与出口之间没有执行交接；核查出口选择或缺失的调用/返回/回调，不要编造关系`,
          {
            from: identify(start),
            to: identify(end),
          },
        ),
      ];
  }
  const disconnected = orders.filter((order) => !reachable(anchors[0], order));
  if (disconnected.length)
    return [
      issue('DISCONNECTED_BLOCKS', `${label} 包含无法从入口沿交接到达的阅读块`, {
        block_orders: disconnected,
      }),
    ];
  return [];
}

function routeAudit(plan, flows) {
  const warnings = [],
    seen = [];
  for (const [index, flow] of flows.entries()) {
    if (flow.status === 'blocked')
      warnings.push(
        issue('MODULE_BLOCKED', `模块 ${plan.modules[index].id} 无法展开：${flow.concern}`, {
          module_id: plan.modules[index].id,
        }),
      );
    if (flow.status === 'ready' && !flow.blocks?.length)
      warnings.push(
        issue(
          'EMPTY_MODULE_AFTER_DEDUP',
          `模块 ${plan.modules[index].id} 的代码块均与前序模块重复`,
          { module_id: plan.modules[index].id },
        ),
      );
    for (const [blockIndex, block] of (flow.blocks ?? []).entries()) {
      for (const prior of seen) {
        if (prior.block.file !== block.file) continue;
        const location = {
          first_module_id: prior.module_id,
          first_block_order: prior.block_order,
          module_id: plan.modules[index].id,
          block_order: blockIndex + 1,
        };
        if (prior.block.start_line <= block.end_line && block.start_line <= prior.block.end_line)
          warnings.push(
            issue(
              'OVERLAPPING_BLOCKS',
              `代码块 ${prior.block.file}:${prior.block.start_line}-${prior.block.end_line} 与 ${block.start_line}-${block.end_line} 重叠`,
              location,
            ),
          );
        else if (
          block.symbol &&
          prior.block.symbol === block.symbol &&
          (!block.split_group || block.split_group !== prior.block.split_group) &&
          Math.max(prior.block.end_line, block.end_line) -
            Math.min(prior.block.start_line, block.start_line) <
            200
        )
          warnings.push(
            issue(
              'FRAGMENTED_SHORT_SYMBOL',
              `${block.file} 中的 ${block.symbol} 被拆成多个短代码块`,
              location,
            ),
          );
      }
      seen.push({ block, module_id: plan.modules[index].id, block_order: blockIndex + 1 });
    }
  }
  return { block_count: seen.length, warnings };
}

function retainedOrCallingBlockOrder(rawFlow, preparedFlow, originalOrder) {
  const retainedOrder = (order) => {
    const original = rawFlow.blocks?.[order - 1];
    if (!original) return undefined;
    const index = preparedFlow.blocks.findIndex(
      (block) =>
        block.file === original.file &&
        block.start_line <= original.start_line &&
        block.end_line >= original.end_line,
    );
    return index < 0 ? undefined : index + 1;
  };
  const direct = retainedOrder(originalOrder);
  if (direct) return direct;
  const visited = new Set([originalOrder]),
    queue = [originalOrder];
  while (queue.length) {
    const current = queue.shift();
    for (const link of rawFlow.execution?.links ?? []) {
      if (link.to_block_order !== current || visited.has(link.from_block_order)) continue;
      const order = retainedOrder(link.from_block_order);
      if (order) return order;
      visited.add(link.from_block_order);
      queue.push(link.from_block_order);
    }
  }
  return undefined;
}

function prepareFlows(plan, rawFlows) {
  const owners = new Map(),
    omitted = [];
  rawFlows.forEach((flow, moduleIndex) =>
    (flow.blocks ?? []).forEach((block, blockIndex) => {
      const key = `${block.file}:${block.start_line}-${block.end_line}`;
      if (!owners.has(key) || owners.get(key).module_index < moduleIndex)
        owners.set(key, { module_index: moduleIndex, original_block_order: blockIndex + 1 });
    }),
  );
  const flows = rawFlows.map((flow, index) => {
    const orderMap = new Map(),
      seen = new Map();
    let retainedCount = 0;
    const blocks = (flow.blocks ?? []).flatMap((block, blockIndex) => {
      const key = `${block.file}:${block.start_line}-${block.end_line}`;
      if (owners.get(key).module_index !== index || seen.has(key)) {
        omitted.push({
          module_id: plan.modules[index].id,
          original_block_order: blockIndex + 1,
          symbol: block.symbol,
          file: block.file,
          reason: `同一完整源码范围由模块 ${plan.modules[owners.get(key).module_index].id} 阅读`,
        });
        if (seen.has(key)) orderMap.set(blockIndex + 1, seen.get(key));
        return [];
      }
      const order = ++retainedCount;
      seen.set(key, order);
      orderMap.set(blockIndex + 1, order);
      return [block];
    });
    const originalExecution = flow.execution;
    const priorBlockOrder = (originalOrder) => {
      if (orderMap.has(originalOrder)) return orderMap.get(originalOrder);
      const visited = new Set([originalOrder]),
        queue = [originalOrder];
      while (queue.length) {
        const current = queue.shift();
        for (const link of originalExecution?.links ?? []) {
          if (link.to_block_order !== current || visited.has(link.from_block_order)) continue;
          if (orderMap.has(link.from_block_order)) return orderMap.get(link.from_block_order);
          visited.add(link.from_block_order);
          queue.push(link.from_block_order);
        }
      }
      return undefined;
    };
    const outgoing = originalExecution?.outgoing && {
      ...originalExecution.outgoing,
      from_block_order: orderMap.get(originalExecution.outgoing.from_block_order),
    };
    if (outgoing && !outgoing.from_block_order) {
      const crossing = (originalExecution.links ?? []).find(
        (link) =>
          link.to_block_order === originalExecution.outgoing.from_block_order &&
          link.relation === 'calls' &&
          orderMap.has(link.from_block_order),
      );
      if (crossing)
        Object.assign(outgoing, {
          from_block_order: orderMap.get(crossing.from_block_order),
          relation: 'calls',
          description: crossing.description,
          call_line: crossing.call_line,
          callee: crossing.callee,
        });
    }
    const execution = originalExecution && {
      ...originalExecution,
      entry_block_order:
        orderMap.get(originalExecution.entry_block_order) ??
        priorBlockOrder(originalExecution.entry_block_order),
      implementation_block_order:
        orderMap.get(originalExecution.implementation_block_order) ??
        priorBlockOrder(originalExecution.implementation_block_order),
      exit_block_order:
        orderMap.get(originalExecution.exit_block_order) ??
        priorBlockOrder(originalExecution.exit_block_order),
      links: (originalExecution.links ?? [])
        .filter((link) => orderMap.has(link.from_block_order) && orderMap.has(link.to_block_order))
        .map((link) => ({
          ...link,
          from_block_order: orderMap.get(link.from_block_order),
          to_block_order: orderMap.get(link.to_block_order),
        }))
        .filter((link) => link.from_block_order !== link.to_block_order),
      ...(outgoing ? { outgoing } : {}),
      ...(originalExecution.handoff_from_previous
        ? {
            handoff_from_previous: {
              ...originalExecution.handoff_from_previous,
              to_block_order: orderMap.get(originalExecution.handoff_from_previous.to_block_order),
            },
          }
        : {}),
    };
    const investigation = flow.investigation && {
      ...flow.investigation,
      decisions: (flow.investigation.decisions ?? []).map((item) => ({
        ...item,
        from_block_order: orderMap.get(item.from_block_order),
        ...(orderMap.has(item.from_block_order) ? {} : { source_omitted: true }),
      })),
    };
    return {
      ...flow,
      blocks,
      ...(execution ? { execution } : {}),
      ...(investigation ? { investigation } : {}),
    };
  });
  for (let index = 1; index < flows.length; index++) {
    const handoff = flows[index].execution?.handoff_from_previous;
    if (!handoff) continue;
    handoff.from_block_order = retainedOrCallingBlockOrder(
      rawFlows[index - 1],
      flows[index - 1],
      handoff.from_block_order,
    );
  }
  return { flows, omitted };
}

function selectFlows(plan, flows, selection) {
  const issues = [],
    byModule = new Map();
  if (!Array.isArray(selection) || selection.length !== plan.modules.length)
    return {
      issues: [issue('MISSING_SELECTION', '接受路线时必须为每个模块选择保留的代码块')],
      flows: [],
    };
  for (const item of selection) {
    if (byModule.has(item.module_id))
      issues.push(issue('DUPLICATE_SELECTION', `模块 ${item.module_id} 重复选择`));
    byModule.set(item.module_id, item.block_orders);
  }
  const selected = plan.modules.map((module, index) => {
    const orders = byModule.get(module.id),
      blocks = flows[index].blocks ?? [];
    if (
      !Array.isArray(orders) ||
      !orders.length ||
      orders.some(
        (value, i) =>
          !Number.isInteger(value) ||
          value < 1 ||
          value > blocks.length ||
          (i > 0 && value <= orders[i - 1]),
      )
    ) {
      issues.push(
        issue('INVALID_SELECTION', `模块 ${module.id} 必须按原顺序保留至少一个有效代码块`),
      );
      return { ...flows[index], blocks: [] };
    }
    issues.push(...flowChainIssues(flows[index], orders, module.id));
    if (
      index < plan.modules.length - 1 &&
      !orders.includes(flows[index].execution?.outgoing?.from_block_order)
    )
      issues.push(issue('BROKEN_MODULE_EXIT', `模块 ${module.id} 的出口调用块未被保留`));
    if (index) {
      const handoff = flows[index].execution?.handoff_from_previous;
      const previousOrders = byModule.get(plan.modules[index - 1].id);
      if (
        !handoff ||
        !previousOrders?.includes(handoff.from_block_order) ||
        !orders.includes(handoff.to_block_order)
      )
        issues.push(issue('BROKEN_MODULE_HANDOFF', `模块 ${module.id} 的跨模块执行交接未被保留`));
    }
    for (const order of orders) {
      const block = blocks[order - 1];
      if (
        block.split_group &&
        blocks.some(
          (candidate, candidateIndex) =>
            candidate.split_group === block.split_group && !orders.includes(candidateIndex + 1),
        )
      )
        issues.push(
          issue('INCOMPLETE_SPLIT', `模块 ${module.id} 必须一起保留同一函数的两个语义片段`),
        );
    }
    return {
      ...flows[index],
      selected_orders: orders,
      blocks: orders.map((order) => blocks[order - 1]),
    };
  });
  const audit = routeAudit(plan, selected);
  if (audit.block_count > 42)
    issues.push(
      issue(
        'ROUTE_TOO_WIDE',
        `最终主线包含 ${audit.block_count} 个代码块；请收紧到不超过 42 个必读块，其余留给支线`,
      ),
    );
  issues.push(...audit.warnings.filter((item) => item.code === 'OVERLAPPING_BLOCKS'));
  return { issues, flows: selected };
}

function compactFlow(flow) {
  return flow
    ? {
        module_id: flow.module_id,
        status: flow.status,
        blocks: (flow.blocks ?? []).map((block) => ({
          id: block.id,
          symbol: block.symbol,
          file: block.file,
          start_line: block.start_line,
          end_line: block.end_line,
        })),
        execution: flow.execution,
      }
    : null;
}

function lockedRelationType(relation) {
  if (relation === 'returns' || relation === 'returns_to') return 'returns';
  if (relation === 'continues' || relation === 'sequence') return 'continues';
  if (relation === 'callback') return 'callback';
  return 'calls';
}

function sourceLocation(file, startLine, endLine = startLine) {
  return { file, start: { line: startLine }, end: { line: endLine } };
}

async function materializeRelationSite(snapshot, cache, file, line, callee) {
  if (!nonempty(file) || !Number.isInteger(line) || line < 1) return undefined;
  const source = await checkFile(snapshot, file, cache);
  return {
    location: sourceLocation(source.file, line),
    ...(nonempty(callee) ? { callee } : {}),
    source_line: source.lines[line - 1] ?? '',
  };
}

async function materializeLockedRelation({
  snapshot,
  cache,
  planId,
  key,
  from,
  to,
  raw,
  crossesModuleBoundary,
  relationWorkflow,
}) {
  if (raw.candidate_id && relationWorkflow) {
    const accepted = relationWorkflow.materialize(raw.candidate_id),
      conditionSites = [];
    for (const item of raw.condition?.evidence ?? []) {
      const site = await materializeRelationSite(snapshot, cache, item.file, item.line);
      if (site) conditionSites.push(site);
    }
    const payload = {
      ...accepted,
      from_block_id: from.id,
      to_block_id: to.id,
      crosses_module_boundary: crossesModuleBoundary,
      ...(raw.condition
        ? {
            condition: {
              summary: raw.condition.description,
              evidence_sites: conditionSites,
            },
          }
        : {}),
      evidence_refs: unique([...(from.evidence_refs ?? []), ...(to.evidence_refs ?? [])]),
    };
    return {
      id: `lpr_${digest(`${planId}:${key}:${JSON.stringify(payload)}`).slice(0, 16)}`,
      ...payload,
    };
  }
  const type = lockedRelationType(raw.relation);
  const callFile = raw.call_file ?? from.file;
  const callSite =
    type === 'calls'
      ? await materializeRelationSite(snapshot, cache, callFile, raw.call_line, raw.callee)
      : undefined;
  const resumeSite = raw.resume
    ? await materializeRelationSite(snapshot, cache, raw.resume.file, raw.resume.line)
    : undefined;
  const conditionSites = [];
  for (const item of raw.condition?.evidence ?? []) {
    const site = await materializeRelationSite(snapshot, cache, item.file, item.line);
    if (site) conditionSites.push(site);
  }
  const payload = {
    type,
    from_block_id: from.id,
    to_block_id: to.id,
    crosses_module_boundary: crossesModuleBoundary,
    ...(callSite ? { call_site: callSite } : {}),
    ...(resumeSite ? { resume_site: resumeSite } : {}),
    ...(raw.condition
      ? { condition: { summary: raw.condition.description, evidence_sites: conditionSites } }
      : {}),
    planning_note: raw.description,
    evidence_refs: unique([...(from.evidence_refs ?? []), ...(to.evidence_refs ?? [])]),
  };
  return {
    id: `lpr_${digest(`${planId}:${key}:${JSON.stringify(payload)}`).slice(0, 16)}`,
    ...payload,
  };
}

async function materializeLockedRelations(
  snapshot,
  planId,
  modules,
  flows,
  cache,
  relationWorkflow,
) {
  const relations = [];
  for (const [moduleIndex, flow] of flows.entries()) {
    const lockedBlocks = modules[moduleIndex]?.blocks ?? [];
    if (moduleIndex) {
      const handoff = flow.execution?.handoff_from_previous;
      const from = modules[moduleIndex - 1]?.blocks?.[handoff?.from_block_order - 1];
      const to = lockedBlocks[handoff?.to_block_order - 1];
      if (handoff && from && to) {
        const outgoing = flows[moduleIndex - 1].execution?.outgoing;
        const raw =
          outgoing?.from_block_order === handoff.from_block_order
            ? { ...handoff, condition: outgoing.condition ?? handoff.condition }
            : handoff;
        relations.push(
          await materializeLockedRelation({
            snapshot,
            cache,
            planId,
            key: `handoff:${moduleIndex - 1}:${moduleIndex}`,
            from,
            to,
            raw,
            crossesModuleBoundary: true,
            relationWorkflow,
          }),
        );
      }
    }
    for (const [linkIndex, link] of (flow.execution?.links ?? []).entries()) {
      const from = lockedBlocks[link.from_block_order - 1],
        to = lockedBlocks[link.to_block_order - 1];
      if (!from || !to) continue;
      relations.push(
        await materializeLockedRelation({
          snapshot,
          cache,
          planId,
          key: `module:${moduleIndex}:link:${linkIndex}`,
          from,
          to,
          raw: link,
          crossesModuleBoundary: false,
          relationWorkflow,
        }),
      );
    }
  }
  return relations;
}

/** Upgrades an accepted pre-relation artifact without rerunning any Agent stage. */
export async function attachAutonomousPlanRelations({
  snapshot,
  plan,
  moduleResults,
  cache = new Map(),
}) {
  if (Array.isArray(plan.relations)) return plan;
  if (!Array.isArray(moduleResults) || moduleResults.length !== plan.modules?.length) {
    throw new Error('旧路线产物缺少完整 module_results，无法确定性补建执行关系');
  }
  return {
    ...plan,
    relations: await materializeLockedRelations(
      snapshot,
      plan.id,
      plan.modules,
      moduleResults,
      cache,
    ),
  };
}

async function materialize(
  snapshot,
  request,
  semanticPlan,
  flows,
  review,
  cache,
  relationWorkflow,
) {
  const id = `lp_${digest({ snapshot: snapshot.id, goal: semanticPlan.goal, modules: semanticPlan.modules, flows }).slice(0, 20)}`;
  const evidence = [];
  const modules = [];
  for (const [moduleIndex, module] of semanticPlan.modules.entries()) {
    const blocks = [];
    for (const [blockIndex, item] of flows[moduleIndex].blocks.entries()) {
      const originalOrder = flows[moduleIndex].selected_orders?.[blockIndex] ?? blockIndex + 1;
      const link = flows[moduleIndex].execution?.links?.find(
        (candidate) =>
          candidate.to_block_order === originalOrder &&
          flows[moduleIndex].selected_orders?.includes(candidate.from_block_order),
      );
      const { file, lines } = await checkFile(snapshot, item.file, cache);
      const range = { start_line: item.start_line, end_line: item.end_line };
      const excerpt = lines.slice(item.start_line - 1, item.end_line).join('\n');
      const evidenceId = `ev_${digest(`${snapshot.id}:${file}:${item.start_line}:${item.end_line}:${excerpt}`).slice(0, 20)}`;
      evidence.push({
        id: evidenceId,
        snapshot_id: snapshot.id,
        kind: 'source_range',
        file,
        range,
        content_digest: `sha256:${digest(excerpt)}`,
      });
      const name = item.symbol || item.title,
        symbolId = `${file}::${name}`;
      blocks.push({
        id: `lpb_${digest(`${id}:${moduleIndex}:${blockIndex}`).slice(0, 16)}`,
        order: blockIndex + 1,
        candidate_id: `src_${digest(`${file}:${item.start_line}:${item.end_line}`).slice(0, 16)}`,
        symbol_id: symbolId,
        name,
        kind: item.kind || 'code',
        file,
        range,
        title: item.title,
        reason: item.reason,
        evidence_refs: [evidenceId],
        ...(link || item.connection
          ? {
              connection_from_previous: {
                relation: link?.relation ?? 'narrative',
                description: link?.description ?? item.connection,
                fact_refs: [],
                evidence_refs: [],
              },
            }
          : {}),
      });
    }
    modules.push({
      id: `lpm_${digest(`${id}:${module.id}`).slice(0, 16)}`,
      order: moduleIndex + 1,
      title: module.title,
      objective: module.objective,
      reason: module.reason,
      reference_files: module.files,
      blocks,
      ...(moduleIndex && (flows[moduleIndex].execution?.handoff_from_previous || module.transition)
        ? {
            connection_from_previous: {
              relation:
                flows[moduleIndex].execution?.handoff_from_previous?.relation ?? 'narrative',
              description:
                flows[moduleIndex].execution?.handoff_from_previous?.description ??
                module.transition,
              fact_refs: [],
              evidence_refs: [],
            },
          }
        : {}),
    });
  }
  const relations = await materializeLockedRelations(
    snapshot,
    id,
    modules,
    flows,
    cache,
    relationWorkflow,
  );
  return {
    plan: {
      schema_version: '1',
      id,
      request_id: request.request_id,
      snapshot_id: snapshot.id,
      decision_digest: digest({ semanticPlan, flows, review }),
      goal: {
        original: request.goal.original,
        title: semanticPlan.goal.title,
        resolved: semanticPlan.goal.scenario,
        rationale: semanticPlan.goal.reason,
        metadata: {
          selected_scenario: semanticPlan.goal.scenario,
          observable_result: semanticPlan.goal.result,
        },
      },
      modules,
      relations,
      excluded_candidates: [],
      unresolved_questions: unique(flows.flatMap((flow) => flow.unresolved_questions ?? [])),
    },
    evidence,
  };
}

export async function planSemanticModules({ snapshot, request, runStage, cache = new Map() }) {
  const project_brief = await buildProjectBrief(snapshot);
  const draft = await runStage({
    kind: 'main',
    input: { task: 'plan_semantic_modules', goal: request.goal, project: project_brief },
    validate: (decision) => validateSemanticPlan(snapshot, request, decision, cache),
  });
  const reviewed = await reviewSemanticModules({ snapshot, request, runStage, draft, cache });
  return { ...reviewed, project_brief };
}

export async function reviewSemanticModules({
  snapshot,
  request,
  runStage,
  draft,
  cache = new Map(),
}) {
  const review = await runStage({
    kind: 'main_review',
    input: { task: 'review_semantic_modules', goal: request.goal, draft_plan: draft },
    validate: async (decision) => {
      if (!['accept', 'revise'].includes(decision?.status) || !nonempty(decision?.reason))
        return [issue('SEMANTIC_REVIEW_STATUS', '主规划复核需要 accept/revise 和理由')];
      if (decision.status === 'accept')
        return decision.replacement_plan
          ? [issue('UNEXPECTED_REPLACEMENT', '接受规划时不要提交替换方案')]
          : [];
      if (!decision.replacement_plan)
        return [issue('MISSING_REPLACEMENT', '修订规划时需要完整替换方案')];
      const issues = await validateSemanticPlan(
        snapshot,
        request,
        decision.replacement_plan,
        cache,
      );
      const priorFiles = new Set(draft.modules.flatMap((module) => module.files));
      for (const module of decision.replacement_plan.modules ?? [])
        for (const file of module.files ?? [])
          if (!priorFiles.has(file))
            issues.push(
              issue('NEW_REVIEW_FILE', `无源码复核不能新增主规划未调查的参考文件：${file}`),
            );
      return issues;
    },
  });
  return {
    semantic_plan: review.status === 'revise' ? review.replacement_plan : draft,
    semantic_review: review,
  };
}

/** The orchestrator owns stage order; the model only makes scoped semantic decisions. */
export async function planAutonomousRoute({
  snapshot,
  request,
  runStage,
  sourceGraph,
  relationWorkflow,
  emit = () => {},
}) {
  const cache = new Map();
  const { semantic_plan: initialPlan, project_brief: brief } = await planSemanticModules({
    snapshot,
    request,
    runStage,
    cache,
  });
  let semanticPlan = initialPlan;
  let flows,
    review,
    revisionRound = 0,
    replanRound = 0;
  for (;;) {
    flows = [];
    for (const [index, module] of semanticPlan.modules.entries()) {
      let resolvedFlow;
      const submitted = await runStage({
        kind: 'module',
        module_id: module.id,
        input: {
          task: 'trace_module_flow',
          goal: semanticPlan.goal,
          module,
          previous_module: semanticPlan.modules[index - 1] ?? null,
          previous_module_result: compactFlow(flows[index - 1]),
          next_module: semanticPlan.modules[index + 1] ?? null,
          previous_result: null,
        },
        validate: async (decision) => {
          const candidateIssues = relationWorkflow?.validateDecision(decision, {
            module_id: module.id,
          });
          if (candidateIssues?.length) return candidateIssues;
          const resolved = await resolveModuleFlow(snapshot, module, decision, sourceGraph, cache);
          resolvedFlow = resolved.flow;
          if (resolved.issues.length) return resolved.issues;
          inferHandoff(flows[index - 1], resolvedFlow);
          return [
            ...resolved.issues,
            ...(relationWorkflow?.validateResolvedFlow(resolvedFlow, flows[index - 1]) ?? []),
            ...(await validateResolvedModuleFlow(snapshot, module, resolvedFlow, cache)),
            ...(await validateModuleHandoff(snapshot, flows[index - 1], resolvedFlow, cache)),
            ...(index < semanticPlan.modules.length - 1 &&
            resolvedFlow.status === 'ready' &&
            !resolvedFlow.execution?.outgoing
              ? [issue('MISSING_OUTGOING', `模块 ${module.id} 需提交到下一模块的出口证据`)]
              : []),
            ...(index === semanticPlan.modules.length - 1 && resolvedFlow.execution?.outgoing
              ? [
                  issue(
                    'UNEXPECTED_OUTGOING',
                    `最后模块 ${module.id} 不应声明下一模块出口；用 investigation 和 exit_id 说明最终结果`,
                  ),
                ]
              : []),
          ];
        },
      });
      const flow =
        resolvedFlow ??
        (await resolveModuleFlow(snapshot, module, submitted, sourceGraph, cache)).flow;
      inferHandoff(flows[index - 1], flow);
      flows.push(flow);
      emit('module', {
        module_id: module.id,
        status: flow.status,
        blocks: flow.blocks?.length ?? 0,
      });
    }
    for (;;) {
      const prepared = prepareFlows(semanticPlan, flows);
      const audit = routeAudit(semanticPlan, prepared.flows);
      for (const omitted of prepared.omitted)
        if (
          flows.some(
            (flow) =>
              flow.module_id !== omitted.module_id &&
              flow.blocks?.some(
                (block) => block.file === omitted.file && block.symbol === omitted.symbol,
              ),
          )
        )
          audit.warnings.push(
            issue(
              'MODULE_BOUNDARY_SPLITS_FUNCTION',
              `函数 ${omitted.symbol} 被多个语义模块重复占用；应重新划分模块，让调用、返回和后续处理在同一执行链中闭合`,
              {
                module_id: omitted.module_id,
                file: omitted.file,
                symbol: omitted.symbol,
                repair: { action: 'replan_modules', preserve_function_owner: true },
              },
            ),
          );
      for (const [index, flow] of prepared.flows.entries()) {
        if (flow.status !== 'ready') continue;
        audit.warnings.push(
          ...flowChainIssues(
            flow,
            flow.blocks.map((_, blockIndex) => blockIndex + 1),
            semanticPlan.modules[index].id,
          ),
        );
        if (
          index &&
          (!flow.execution?.handoff_from_previous?.from_block_order ||
            !flow.execution?.handoff_from_previous?.to_block_order)
        )
          audit.warnings.push(
            issue('BROKEN_MODULE_HANDOFF', `模块 ${flow.module_id} 的交接块已在去重后消失`),
          );
        if (index < prepared.flows.length - 1 && !flow.execution?.outgoing?.from_block_order)
          audit.warnings.push(
            issue('BROKEN_MODULE_EXIT', `模块 ${flow.module_id} 的出口块已在去重后消失`),
          );
      }
      review = await runStage({
        kind: 'review',
        input: {
          task: 'review_complete_route',
          goal: request.goal,
          semantic_plan: semanticPlan,
          module_results: prepared.flows,
          automatically_omitted: prepared.omitted,
          audit,
          ...(relationWorkflow
            ? {
                relation_review_candidates: relationWorkflow.reviewInput(
                  relationWorkflow.candidateIds(prepared.flows),
                ),
              }
            : {}),
          revision_round: revisionRound,
          replan_round: replanRound,
        },
        validate: async (decision) => {
          const issues = [],
            relationRequirements = relationWorkflow
              ? relationWorkflow.recoveryRequirements(relationWorkflow.candidateIds(prepared.flows))
              : [],
            requiredModules = [
              ...new Set(
                relationRequirements
                  .filter((item) => item.action === 'revise')
                  .map((item) => item.module_id)
                  .filter(Boolean),
              ),
            ],
            relationReplanRequired =
              relationRequirements.some((item) => item.action === 'replan') ||
              requiredModules.length > 2;
          if (!['accept', 'revise', 'replan'].includes(decision?.status))
            issues.push(issue('REVIEW_STATUS', '复核状态必须是 accept、revise 或 replan'));
          if (
            decision?.status === 'accept' &&
            prepared.flows.some((flow) => flow.status !== 'ready')
          )
            issues.push(issue('BLOCKED_MODULE', '不能接受仍有 blocked 模块的路线'));
          if (decision?.status === 'accept') {
            issues.push(...selectFlows(semanticPlan, prepared.flows, decision.selection).issues);
            if (relationWorkflow)
              issues.push(
                ...relationWorkflow.acceptanceIssues(relationWorkflow.candidateIds(prepared.flows)),
              );
            for (const [index, flow] of prepared.flows.entries())
              issues.push(
                ...(await validateModuleHandoff(snapshot, prepared.flows[index - 1], flow, cache)),
              );
          }
          if (
            decision?.status === 'revise' &&
            (!Array.isArray(decision.revisions) ||
              !decision.revisions.length ||
              decision.revisions.length > 2 ||
              decision.revisions.some(
                (item) =>
                  !semanticPlan.modules.some((module) => module.id === item.module_id) ||
                  !nonempty(item.instruction),
              ))
          )
            issues.push(
              issue(
                'INVALID_REVISIONS',
                '局部修订最多指定两个模块及具体要求；更广泛的问题请 replan',
              ),
            );
          if (relationRequirements.length && decision?.status === 'revise') {
            if (relationReplanRequired)
              issues.push(
                issue(
                  'RELATION_REPLAN_REQUIRED',
                  '关系审核结论无法在最多两个模块的局部修订内完成，必须重新规划模块',
                  { requirements: relationRequirements, repair: { action: 'replan_modules' } },
                ),
              );
            else {
              const submittedModules = new Set(
                (decision.revisions ?? []).map((item) => item.module_id),
              );
              for (const moduleId of requiredModules)
                if (!submittedModules.has(moduleId))
                  issues.push(
                    issue(
                      'RELATION_REVISION_MODULE_MISSING',
                      `关系审核要求重新调查模块 ${moduleId}`,
                      {
                        module_id: moduleId,
                        requirements: relationRequirements.filter(
                          (item) => item.module_id === moduleId,
                        ),
                      },
                    ),
                  );
            }
          }
          if (
            relationRequirements.length &&
            decision?.status !== 'revise' &&
            decision?.status !== 'replan'
          )
            issues.push(
              issue(
                relationReplanRequired ? 'RELATION_REPLAN_REQUIRED' : 'RELATION_REVISION_REQUIRED',
                relationReplanRequired
                  ? '关系审核要求重新规划模块'
                  : '关系审核要求重新调查对应模块',
                { requirements: relationRequirements },
              ),
            );
          if (
            decision?.status === 'revise' &&
            audit.warnings.some((item) => item.code === 'MODULE_BOUNDARY_SPLITS_FUNCTION')
          )
            issues.push(
              issue(
                'REPLAN_REQUIRED_FOR_FUNCTION_BOUNDARY',
                '同一函数横跨多个模块，局部修订不能消除执行回返；请使用 replan 合并或重新划分相关模块',
                { repair: { action: 'replan_modules' } },
              ),
            );
          if (decision?.status === 'replan' && !decision.replacement_plan)
            issues.push(issue('MISSING_REPLACEMENT', '重新划分模块时必须提交 replacement_plan'));
          return issues;
        },
      });
      emit('review', {
        status: review.status,
        revision_round: revisionRound,
        replan_round: replanRound,
      });
      if (review.status === 'revise' && relationWorkflow) {
        const requirements = relationWorkflow.recoveryRequirements(
          relationWorkflow.candidateIds(prepared.flows),
        );
        review.revisions = review.revisions.map((revision) => {
          const required = requirements.filter(
            (item) => item.action === 'revise' && item.module_id === revision.module_id,
          );
          return required.length
            ? {
                ...revision,
                instruction: `${revision.instruction}\n系统关系审核要求：${required.map((item) => item.instruction).join('；')}`,
              }
            : revision;
        });
      }
      if (review.status === 'accept') {
        const chosen = selectFlows(semanticPlan, prepared.flows, review.selection);
        const result = await materialize(
          snapshot,
          request,
          semanticPlan,
          chosen.flows,
          review,
          cache,
          relationWorkflow,
        );
        return {
          ...result,
          semantic_plan: semanticPlan,
          module_results: prepared.flows,
          automatically_omitted: prepared.omitted,
          review,
          project_brief: brief,
        };
      }
      if (review.status === 'replan') {
        if (++replanRound > 1) throw new Error('语义模块重划超过 1 轮，请人工检查目标或项目范围');
        const issues = await validateSemanticPlan(
          snapshot,
          request,
          review.replacement_plan,
          cache,
        );
        if (issues.length) throw new Error(`主 Agent 重划的模块无效：${JSON.stringify(issues)}`);
        semanticPlan = review.replacement_plan;
        revisionRound = 0;
        break;
      }
      if (++revisionRound > 2) throw new Error('局部模块修订超过 2 轮，请重新划分模块');
      for (const revision of review.revisions) {
        const index = semanticPlan.modules.findIndex((module) => module.id === revision.module_id),
          module = semanticPlan.modules[index];
        let resolvedFlow;
        const submitted = await runStage({
          kind: 'module',
          module_id: module.id,
          input: {
            task: 'trace_module_flow',
            goal: semanticPlan.goal,
            module,
            previous_module: semanticPlan.modules[index - 1] ?? null,
            previous_module_result: compactFlow(flows[index - 1]),
            next_module: semanticPlan.modules[index + 1] ?? null,
            previous_result: flows[index],
            revision_instruction: revision.instruction,
          },
          validate: async (decision) => {
            const candidateIssues = relationWorkflow?.validateDecision(decision, {
              module_id: module.id,
            });
            if (candidateIssues?.length) return candidateIssues;
            const resolved = await resolveModuleFlow(
              snapshot,
              module,
              decision,
              sourceGraph,
              cache,
            );
            resolvedFlow = resolved.flow;
            if (resolved.issues.length) return resolved.issues;
            inferHandoff(flows[index - 1], resolvedFlow);
            return [
              ...resolved.issues,
              ...(relationWorkflow?.validateResolvedFlow(resolvedFlow, flows[index - 1]) ?? []),
              ...(await validateResolvedModuleFlow(snapshot, module, resolvedFlow, cache)),
              ...(await validateModuleHandoff(snapshot, flows[index - 1], resolvedFlow, cache)),
              ...(index < semanticPlan.modules.length - 1 &&
              resolvedFlow.status === 'ready' &&
              !resolvedFlow.execution?.outgoing
                ? [issue('MISSING_OUTGOING', `模块 ${module.id} 需提交到下一模块的出口证据`)]
                : []),
              ...(index === semanticPlan.modules.length - 1 && resolvedFlow.execution?.outgoing
                ? [
                    issue(
                      'UNEXPECTED_OUTGOING',
                      `最后模块 ${module.id} 不应声明下一模块出口；用 investigation 和 exit_id 说明最终结果`,
                    ),
                  ]
                : []),
            ];
          },
        });
        flows[index] =
          resolvedFlow ??
          (await resolveModuleFlow(snapshot, module, submitted, sourceGraph, cache)).flow;
        inferHandoff(flows[index - 1], flows[index]);
        if (flows[index + 1]?.execution?.handoff_from_previous) {
          delete flows[index + 1].execution.handoff_from_previous;
          inferHandoff(flows[index], flows[index + 1]);
        }
        emit('module', {
          module_id: module.id,
          status: flows[index].status,
          blocks: flows[index].blocks?.length ?? 0,
          revision_round: revisionRound,
        });
      }
    }
  }
}
