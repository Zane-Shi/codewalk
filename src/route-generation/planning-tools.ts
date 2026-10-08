import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { relativeSourcePath, safePath } from '../snapshot.ts';
import { createCandidateExpansion } from './candidate-expansion.ts';
import { lockRouteDecision, RouteDecisionValidationError } from './route-lock.ts';

const shortText = { type: 'string', minLength: 1, maxLength: 1600 };
const id = { type: 'string', minLength: 1, maxLength: 200 };
const ids = (maxItems = 20) => ({ type: 'array', maxItems, uniqueItems: true, items: id });
const metadata = { type: 'object', additionalProperties: true };
const connection = {
  type: 'object',
  additionalProperties: false,
  required: ['relation', 'description', 'fact_refs', 'evidence_refs'],
  properties: {
    relation: { ...id, description: '开放关系标签；必须准确描述相邻模块边界。' },
    description: shortText,
    fact_refs: { ...ids(), description: '只放精确匹配前一模块末块到当前模块首块的有向图谱事实。' },
    evidence_refs: { ...ids(), description: '静态图无法支持时使用的源码证据 ID。' },
    metadata,
  },
};

export const SUBMIT_ROUTE_ASSEMBLY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['schema_version', 'snapshot_id', 'selected_scenario', 'goal', 'modules', 'rationale'],
  properties: {
    schema_version: { type: 'string', enum: ['1'] },
    snapshot_id: id,
    selected_scenario: {
      ...shortText,
      description:
        '本路线唯一采用的具体生产场景，说明触发方式、关键前提和最终结果；不能同时包含互斥模式。',
    },
    goal: {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'resolved', 'rationale'],
      properties: {
        title: { ...shortText, maxLength: 200 },
        resolved: shortText,
        rationale: shortText,
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
        required: ['module_id', 'title', 'objective', 'reason', 'selected_block_orders'],
        properties: {
          module_id: id,
          title: { ...shortText, maxLength: 160 },
          objective: shortText,
          reason: shortText,
          selected_block_orders: {
            type: 'array',
            minItems: 1,
            maxItems: 10,
            uniqueItems: true,
            items: { type: 'integer', minimum: 1 },
            description:
              '保留该模块候选结果中的哪些代码块，使用从 1 开始的原始数组顺序；必须包含第 1 块且保持递增。',
          },
          connection_from_previous: connection,
          metadata,
        },
      },
    },
    rationale: { ...shortText, maxLength: 2400 },
    unresolved_questions: { type: 'array', maxItems: 20, items: shortText },
    metadata,
  },
};

function toolText(result) {
  return result.content
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n');
}

function nextEvidenceId(evidence, prefix) {
  let number = evidence.length + 1;
  while (evidence.some((item) => item.id === `${prefix}${number}`)) number++;
  return `${prefix}${number}`;
}

export function createPlanningSourceTools({
  snapshot,
  seed,
  graph,
  request,
  investigationLimits,
  evidencePrefix = 'pe',
  evidence,
  signal,
  onProgress = () => {},
  budget,
  chargeTool = () => {},
}) {
  const read = createReadToolDefinition(snapshot.root),
    ls = createLsToolDefinition(snapshot.root);
  const grep = createGrepToolDefinition(snapshot.root),
    find = createFindToolDefinition(snapshot.root),
    cache = new Map();
  const limits = investigationLimits ?? request.limits.main_agent;
  const expansion = createCandidateExpansion(graph, seed, {
    max_promoted_candidates: request.limits.max_blocks * 2,
  });
  const candidatesByFile = new Map();
  for (const candidate of seed.candidates) {
    const items = candidatesByFile.get(candidate.file) ?? [];
    items.push(candidate);
    candidatesByFile.set(candidate.file, items);
  }
  const guardedRead = {
    ...read,
    description: `${read.description} 每次最多读取 ${request.limits.max_source_lines_per_read} 行；返回的 Evidence ID 必须用于规划提交。`,
    executionMode: 'sequential',
    async execute(toolCallId, args, toolSignal, update, context) {
      chargeTool('read');
      signal?.throwIfAborted();
      if (budget.sourceReads >= limits.max_source_reads)
        throw new Error(`源码读取已达到 ${limits.max_source_reads} 次上限`);
      const target = await safePath(snapshot.root, args.path),
        relative = relativeSourcePath(snapshot.root, target);
      const offset = args.offset ?? 1,
        limit = args.limit ?? Math.min(160, request.limits.max_source_lines_per_read);
      if (!Number.isInteger(offset) || offset < 1) throw new Error('read.offset 必须是正整数');
      if (!Number.isInteger(limit) || limit < 1 || limit > request.limits.max_source_lines_per_read)
        throw new Error(`read.limit 必须在 1–${request.limits.max_source_lines_per_read} 之间`);
      const key = JSON.stringify([relative, offset, limit]);
      if (cache.has(key)) return cache.get(key);
      onProgress({ tool: 'read', path: relative, offset, limit });
      const result = await read.execute(
        toolCallId,
        { path: target, offset, limit },
        toolSignal,
        update,
        context,
      );
      if (result.content.some((item) => item.type !== 'text'))
        throw new Error('路线规划只允许读取文本源码');
      const source = await readFile(target, 'utf8'),
        sourceLines = source.split('\n');
      let outputLines = Math.min(limit, sourceLines.length - offset + 1);
      if (
        result.details?.truncation?.truncated ||
        result.details?.truncation?.firstLineExceedsLimit
      )
        outputLines = result.details.truncation.outputLines;
      if (!positiveLineCount(outputLines)) throw new Error('read 没有返回可用的源码行');
      const endLine = offset + outputLines - 1,
        content = sourceLines.slice(offset - 1, endLine).join('\n'),
        contentBytes = Buffer.byteLength(content);
      if (budget.sourceBytes + contentBytes > limits.max_source_bytes)
        throw new Error(`源码证据将超过 ${limits.max_source_bytes} bytes 当前 Agent 预算`);
      const promoted = expansion.promoteSourceRange(relative, {
        start_line: offset,
        end_line: endLine,
      });
      for (const candidate of promoted.candidates) {
        const items = candidatesByFile.get(candidate.file) ?? [];
        items.push(candidate);
        candidatesByFile.set(candidate.file, items);
      }
      const candidateIds = (candidatesByFile.get(relative) ?? [])
        .filter(
          (candidate) =>
            offset <= candidate.range.start_line && endLine >= candidate.range.end_line,
        )
        .map((candidate) => candidate.id);
      const intersectingCandidateIds = (candidatesByFile.get(relative) ?? [])
        .filter(
          (candidate) =>
            offset <= candidate.range.end_line && endLine >= candidate.range.start_line,
        )
        .map((candidate) => candidate.id);
      const evidenceId = nextEvidenceId(evidence, evidencePrefix),
        item = {
          id: evidenceId,
          snapshot_id: snapshot.id,
          kind: 'source_read',
          candidate_ids: candidateIds,
          intersecting_candidate_ids: intersectingCandidateIds,
          file: relative,
          range: { start_line: offset, end_line: endLine },
          content_digest: `sha256:${createHash('sha256').update(content).digest('hex')}`,
          content,
          metadata: { tool_call_id: toolCallId, offset, limit },
        };
      evidence.push(item);
      budget.sourceReads++;
      budget.sourceBytes += contentBytes;
      const remainingReads = limits.max_source_reads - budget.sourceReads,
        remainingTools = limits.max_tool_calls - budget.toolCalls;
      const promotedText = promoted.candidates.length
        ? `\n新晋升候选: ${promoted.candidates.map((candidate) => `${candidate.id}=${candidate.entity_id}[${candidate.range.start_line}-${candidate.range.end_line}]`).join('; ')}`
        : '';
      const relationText = promoted.relations.length
        ? `\n新候选关系: ${promoted.relations.map((relation) => `${relation.id}:${relation.from_candidate_id}-${relation.relation}->${relation.to_candidate_id}${relation.metadata?.intermediary_entity_ids?.length ? `(via ${relation.metadata.intermediary_entity_ids.join(' -> ')})` : ''}`).join('; ')}`
        : '';
      const truncatedText = promoted.truncated
        ? '\n候选晋升达到本次规划上限，后续新符号不会再晋升。'
        : '';
      const decorated = {
        ...result,
        content: [
          {
            type: 'text',
            text: `Evidence ID: ${evidenceId}\n完整覆盖候选: ${candidateIds.join(', ') || '(none)'}\n相交候选: ${intersectingCandidateIds.join(', ') || '(none)'}\n源码快照: ${snapshot.id}\n剩余源码读取: ${remainingReads}；剩余调查工具调用: ${remainingTools}${promotedText}${relationText}${truncatedText}\n${toolText(result)}`,
          },
        ],
        details: {
          ...result.details,
          routeEvidenceId: evidenceId,
          candidateIds,
          intersectingCandidateIds,
          promotedCandidateIds: promoted.candidates.map((candidate) => candidate.id),
          promotedRelationIds: promoted.relations.map((relation) => relation.id),
          range: item.range,
        },
      };
      cache.set(key, decorated);
      return decorated;
    },
  };
  const guardedLs = {
    ...ls,
    executionMode: 'sequential',
    async execute(toolCallId, args, toolSignal, update, context) {
      chargeTool('ls');
      signal?.throwIfAborted();
      const target = await safePath(snapshot.root, args.path ?? '.'),
        relative = relativeSourcePath(snapshot.root, target) || '.';
      const limit = args.limit ?? 100;
      if (!Number.isInteger(limit) || limit < 1 || limit > 200)
        throw new Error('ls.limit 必须在 1–200 之间');
      onProgress({ tool: 'ls', path: relative, limit });
      const result = await ls.execute(
        toolCallId,
        { path: target, limit },
        toolSignal,
        update,
        context,
      );
      return {
        ...result,
        content: [
          {
            type: 'text',
            text: `剩余调查工具调用: ${limits.max_tool_calls - budget.toolCalls}\n${toolText(result)}`,
          },
        ],
      };
    },
  };
  const guardedGrep = {
    ...grep,
    description: `${grep.description} 本工作流最多返回 100 条匹配、每处最多 3 行上下文，搜索范围限于项目内。`,
    executionMode: 'sequential',
    async execute(toolCallId, args, toolSignal, update, context) {
      chargeTool('grep');
      signal?.throwIfAborted();
      const target = await safePath(snapshot.root, args.path ?? '.');
      const limit = args.limit ?? 100,
        contextLines = args.context ?? 0;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        throw new Error('grep.limit 必须在 1–100 之间');
      if (!Number.isInteger(contextLines) || contextLines < 0 || contextLines > 3)
        throw new Error('grep.context 必须在 0–3 之间');
      onProgress({ tool: 'grep', path: relativeSourcePath(snapshot.root, target) || '.', limit });
      return grep.execute(
        toolCallId,
        { ...args, path: target, limit, context: contextLines },
        toolSignal,
        update,
        context,
      );
    },
  };
  const guardedFind = {
    ...find,
    description: `${find.description} 本工作流最多返回 200 个路径，搜索范围限于项目内。`,
    executionMode: 'sequential',
    async execute(toolCallId, args, toolSignal, update, context) {
      chargeTool('find');
      signal?.throwIfAborted();
      const target = await safePath(snapshot.root, args.path ?? '.');
      const limit = args.limit ?? 200;
      if (!Number.isInteger(limit) || limit < 1 || limit > 200)
        throw new Error('find.limit 必须在 1–200 之间');
      onProgress({ tool: 'find', path: relativeSourcePath(snapshot.root, target) || '.', limit });
      return find.execute(
        toolCallId,
        { ...args, path: target, limit },
        toolSignal,
        update,
        context,
      );
    },
  };
  return [guardedRead, guardedLs, guardedGrep, guardedFind];
}

function positiveLineCount(value) {
  return Number.isInteger(value) && value > 0;
}

export function createSubmitRouteAssemblyTool({
  request,
  seed,
  modulePlan,
  moduleDecisions,
  evidence,
  state,
  signal,
  onLocked = () => {},
}) {
  return {
    name: 'submit_route_decision',
    label: '确认分层路线',
    description:
      '消费模块子 Agent 的压缩候选结果，锁定唯一场景，筛除旁支代码块，收紧最终目标与模块语义，并补充相邻模块边界。不能新增或重排代码块。',
    parameters: SUBMIT_ROUTE_ASSEMBLY_SCHEMA,
    executionMode: 'sequential',
    async execute(_toolCallId, decision) {
      signal?.throwIfAborted();
      if (state.plan) throw new Error('路线已经锁定，不要重复提交');
      if (state.assemblySubmissionAttempts >= request.limits.max_submission_attempts)
        throw new Error(`路线组装已达到 ${request.limits.max_submission_attempts} 次提交上限`);
      state.assemblySubmissionAttempts++;
      state.lastAssemblyDecision = structuredClone(decision);
      try {
        const plan = lockRouteDecision({
          request,
          seed,
          modulePlan: modulePlan ?? state.modulePlan,
          moduleDecisions: moduleDecisions ?? state.moduleDecisions,
          assemblyDecision: decision,
          evidence,
        });
        state.assemblyDecision = decision;
        state.plan = plan;
        state.lastAssemblyReport = undefined;
        onLocked(plan);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                status: 'locked',
                plan_id: plan.id,
                modules: plan.modules.length,
                blocks: plan.modules.reduce((sum, module) => sum + module.blocks.length, 0),
              }),
            },
          ],
        };
      } catch (error) {
        if (!(error instanceof RouteDecisionValidationError)) throw error;
        state.lastAssemblyReport = error.report;
        const errors = error.report.issues
          .filter((issue) => issue.severity === 'error')
          .slice(0, 20);
        throw new Error(
          `路线组装未通过校验（第 ${state.assemblySubmissionAttempts}/${request.limits.max_submission_attempts} 次）：${JSON.stringify(errors)}`,
        );
      }
    },
  };
}
