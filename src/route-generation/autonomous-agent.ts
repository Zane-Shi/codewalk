import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  createAgentSession,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import {
  activateRoutePlanningTools,
  createDekkoResourceLoader,
  DEKKO_ROUTE_TOOL_NAMES,
  disposeRoutePlanningSession,
  ROUTE_INVESTIGATION_TOOL_NAMES,
} from '../dekko-mcp.ts';
import { safePath } from '../snapshot.ts';
import { ValidationFailure } from '../validation-feedback.ts';
import { numberSourceRead } from './source-read.ts';

const string = (maxLength = 1500) => ({ type: 'string', minLength: 1, maxLength });
const strings = (maxItems = 12) => ({ type: 'array', maxItems, items: string(300) });
const goal = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'scenario', 'result', 'reason'],
  properties: {
    title: string(48),
    scenario: string(240),
    result: string(120),
    reason: string(800),
  },
};
const semanticModule = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'title', 'objective', 'reason', 'files', 'expected_input', 'expected_outcome'],
  properties: {
    id: string(100),
    title: string(160),
    objective: string(800),
    reason: string(1000),
    files: { ...strings(10), minItems: 1 },
    expected_input: string(800),
    expected_outcome: string(800),
    transition: string(800),
  },
};
const semanticPlan = {
  type: 'object',
  additionalProperties: false,
  required: ['goal', 'modules'],
  properties: {
    goal,
    modules: { type: 'array', minItems: 1, maxItems: 12, items: semanticModule },
  },
};
const semanticReview = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'reason'],
  properties: {
    status: { type: 'string', enum: ['accept', 'revise'] },
    reason: string(1200),
    replacement_plan: semanticPlan,
  },
};
const codeBlock = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'file', 'entry_line', 'symbol', 'title', 'reason'],
  properties: {
    id: string(100),
    file: string(400),
    entry_line: { type: 'integer', minimum: 1 },
    symbol: string(300),
    title: string(200),
    reason: string(1200),
    connection: string(800),
    split: {
      type: 'object',
      additionalProperties: false,
      required: ['boundary_line', 'reason', 'before', 'after'],
      properties: {
        boundary_line: { type: 'integer', minimum: 1 },
        reason: string(1200),
        before: string(300),
        after: string(300),
      },
    },
  },
};
const sourceEvidence = {
  type: 'object',
  additionalProperties: false,
  required: ['file', 'line', 'quote'],
  properties: {
    file: string(400),
    line: { type: 'integer', minimum: 1 },
    quote: string(400),
  },
};
const condition = {
  type: 'object',
  additionalProperties: false,
  required: ['description', 'evidence'],
  properties: {
    description: string(800),
    evidence: { type: 'array', minItems: 1, maxItems: 4, items: sourceEvidence },
  },
};
const executionLink = {
  type: 'object',
  additionalProperties: false,
  required: ['from_id', 'to_id', 'candidate_id'],
  properties: {
    from_id: string(100),
    to_id: string(100),
    candidate_id: string(100),
    condition,
  },
};
const outgoing = {
  type: 'object',
  additionalProperties: false,
  required: ['from_id', 'candidate_id'],
  properties: {
    from_id: string(100),
    candidate_id: string(100),
    condition,
  },
};
const execution = {
  type: 'object',
  additionalProperties: false,
  required: ['entry_id', 'implementation_id', 'exit_id', 'links'],
  properties: {
    entry_id: string(100),
    implementation_id: string(100),
    exit_id: string(100),
    links: { type: 'array', maxItems: 24, items: executionLink },
    outgoing,
  },
};
const moduleFlow = {
  type: 'object',
  additionalProperties: false,
  required: ['module_id', 'status', 'blocks'],
  properties: {
    module_id: string(100),
    status: { type: 'string', enum: ['ready', 'blocked'] },
    blocks: { type: 'array', maxItems: 12, items: codeBlock },
    execution,
    investigation: {
      type: 'object',
      additionalProperties: false,
      required: ['outcome', 'decisions'],
      properties: {
        outcome: condition,
        decisions: {
          type: 'array',
          maxItems: 8,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['from_id', 'call_line', 'callee', 'disposition', 'reason', 'evidence'],
            properties: {
              from_id: string(100),
              call_line: { type: 'integer', minimum: 1 },
              callee: string(300),
              disposition: { type: 'string', enum: ['excluded', 'next_module'] },
              reason: string(800),
              evidence: { type: 'array', minItems: 1, maxItems: 4, items: sourceEvidence },
            },
          },
        },
      },
    },
    concern: string(1000),
    unresolved_questions: strings(12),
  },
};
const review = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'reason'],
  properties: {
    status: { type: 'string', enum: ['accept', 'revise', 'replan'] },
    reason: string(1200),
    selection: {
      type: 'array',
      maxItems: 12,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['module_id', 'block_orders'],
        properties: {
          module_id: string(100),
          block_orders: {
            type: 'array',
            minItems: 1,
            maxItems: 12,
            uniqueItems: true,
            items: { type: 'integer', minimum: 1 },
          },
        },
      },
    },
    revisions: {
      type: 'array',
      maxItems: 12,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['module_id', 'instruction'],
        properties: {
          module_id: string(100),
          instruction: string(1200),
        },
      },
    },
    replacement_plan: semanticPlan,
  },
};
const stageConfig = {
  main: {
    prompt: 'autonomous-route-main.md',
    submit: 'submit_semantic_modules',
    schema: semanticPlan,
    maxCalls: 45,
    maxReads: 16,
  },
  main_review: {
    prompt: 'autonomous-route-main-review.md',
    submit: 'submit_semantic_review',
    schema: semanticReview,
    maxCalls: 0,
    maxReads: 0,
  },
  module: {
    prompt: 'autonomous-route-module.md',
    submit: 'submit_module_flow',
    schema: moduleFlow,
    maxCalls: 42,
    maxReads: 18,
  },
  review: {
    prompt: 'autonomous-route-review.md',
    submit: 'submit_route_review',
    schema: review,
    maxCalls: 20,
    maxReads: 6,
  },
};

function modelFailure(session) {
  const assistant = [...(session?.agent?.state?.messages ?? [])]
    .reverse()
    .find((message) => message?.role === 'assistant');
  const reason = assistant?.stopReason;
  if (!['error', 'aborted'].includes(reason) && !session?.agent?.state?.errorMessage) return null;
  return {
    stop_reason: reason,
    error_message: String(assistant?.errorMessage ?? session.agent.state.errorMessage ?? '').slice(
      0,
      600,
    ),
  };
}

export function stageSourceTools(snapshot, config, counters, signal, emit) {
  const root = snapshot.root;
  const originals = [
    createReadToolDefinition(root),
    createLsToolDefinition(root),
    createGrepToolDefinition(root),
    createFindToolDefinition(root),
  ];
  return originals.map((tool) => ({
    ...tool,
    executionMode: 'sequential',
    async execute(id, args, toolSignal, update, context) {
      signal?.throwIfAborted();
      if (++counters.calls > config.maxCalls)
        throw new Error(`本阶段调查工具超过 ${config.maxCalls} 次，请提交现有判断`);
      const target = await safePath(root, args.path ?? '.');
      const relative = path.relative(root, target).split(path.sep).join('/') || '.';
      const bounded = { ...args, path: target };
      if (tool.name === 'read') {
        if (++counters.reads > config.maxReads)
          throw new Error(`本阶段源码读取超过 ${config.maxReads} 次，请提交现有判断`);
        bounded.offset ??= 1;
        bounded.limit ??= 160;
        if (
          !Number.isInteger(bounded.offset) ||
          bounded.offset < 1 ||
          !Number.isInteger(bounded.limit) ||
          bounded.limit < 1 ||
          bounded.limit > 200
        )
          throw new Error('read.offset 或 read.limit 无效；每次最多 200 行');
      } else if (tool.name === 'grep') {
        bounded.limit ??= 60;
        bounded.context ??= 0;
        if (
          !Number.isInteger(bounded.limit) ||
          bounded.limit < 1 ||
          bounded.limit > 100 ||
          !Number.isInteger(bounded.context) ||
          bounded.context < 0 ||
          bounded.context > 3
        )
          throw new Error('grep 最多 100 条匹配和 3 行上下文');
      } else if (tool.name === 'find') {
        bounded.limit ??= 100;
        if (!Number.isInteger(bounded.limit) || bounded.limit < 1 || bounded.limit > 200)
          throw new Error('find 最多返回 200 个路径');
      } else {
        bounded.limit ??= 100;
        if (!Number.isInteger(bounded.limit) || bounded.limit < 1 || bounded.limit > 200)
          throw new Error('ls 最多返回 200 项');
      }
      emit('tool', { tool: tool.name, path: relative, args: { ...bounded, path: relative } });
      const result = await tool.execute(id, bounded, toolSignal, update, context);
      return tool.name === 'read' && result.content.every((item) => item.type === 'text')
        ? numberSourceRead(result, await readFile(target, 'utf8'), bounded.offset, bounded.limit)
        : result;
    },
  }));
}

/** Opens a fresh Pi context for every module. No PlanningSeed is sent to the model. */
export async function createPiAutonomousStageRunner({
  snapshot,
  model,
  dataDir,
  signal = new AbortController().signal,
  modelRuntime,
  relationWorkflow,
  emit = () => {},
}) {
  const runtime = modelRuntime ?? (await ModelRuntime.create());
  const available = await runtime.getAvailable(),
    selectedModel = available.find((item) => `${item.provider}/${item.id}` === model);
  if (!selectedModel) throw new Error(`路线规划模型不可用：${model}`);
  let sequence = 0;
  return async ({ kind, module_id, input, validate }) => {
    signal.throwIfAborted();
    const config = stageConfig[kind];
    if (!config) throw new Error(`未知路线阶段：${kind}`);
    const stageInput =
      kind === 'review' && relationWorkflow && input.relation_review_candidates
        ? {
            ...input,
            relation_review_candidates: relationWorkflow.reviewInput(
              input.relation_review_candidates.map((item) => item.candidate.id),
            ),
          }
        : input;
    const stageName = `${kind}-${++sequence}${module_id ? `-${module_id.replace(/[^\w-]/g, '_')}` : ''}`;
    const agentDir = path.join(dataDir, `pi-config-${stageName}`);
    await mkdir(agentDir, { recursive: true });
    const prompt = await readFile(new URL(`../prompts/${config.prompt}`, import.meta.url), 'utf8');
    const counters = { calls: 0, reads: 0, submissions: 0 },
      state = {
        result: undefined,
        lastIssues: [],
        lastDecision: undefined,
        confirmedCandidateIds: undefined,
      };
    let session;
    const sourceTools =
      kind === 'main_review'
        ? []
        : stageSourceTools(snapshot, config, counters, signal, (type, value) =>
            emit(type, { stage: stageName, ...value }),
          );
    const relationTools = [];
    if (kind === 'module' && relationWorkflow) {
      relationTools.push(
        ...relationWorkflow.createModuleTools({
          module_id,
          reviewer_id: stageName,
          onConfirmed: (batch) => {
            state.confirmedCandidateIds = batch.candidates.map((item) => item.candidate.id);
          },
        }),
      );
    }
    if (kind === 'review' && relationWorkflow && stageInput.relation_review_candidates?.length) {
      const allowed = new Set(
          stageInput.relation_review_candidates.map((item) => item.candidate.id),
        ),
        reviewer = relationWorkflow.createReviewerTool({ reviewer_id: stageName });
      relationTools.push({
        ...reviewer,
        execute: async (id, value, ...rest) => {
          const submitted = value?.reviews?.map((item) => item.candidate_id) ?? [];
          if (submitted.some((candidateId) => !allowed.has(candidateId)))
            throw new Error('批量语义审核包含不属于当前路线的候选');
          return reviewer.execute(id, value, ...rest);
        },
      });
    }
    const submit = {
      name: config.submit,
      label: config.submit,
      description: `提交当前 ${kind} 阶段的结构化结果。代码位置和文件必须真实存在；校验只检查可交付性，不要求使用图谱候选。`,
      parameters: config.schema,
      executionMode: 'sequential',
      async execute(_id, decision) {
        signal.throwIfAborted();
        if (counters.submissions >= 4)
          throw new ValidationFailure('本阶段提交已达到 4 次上限', {
            code: 'STAGE_SUBMISSION_LIMIT',
            issues: state.lastIssues,
            decision: state.lastDecision,
            submissions: counters.submissions,
          });
        counters.submissions++;
        let prepared = decision,
          preparationIssues = [];
        if (kind === 'module' && relationWorkflow)
          try {
            prepared = relationWorkflow.hydrateDecision(decision, {
              module_id,
              allowed_candidate_ids: state.confirmedCandidateIds,
            });
          } catch (error) {
            preparationIssues = [
              {
                code: error.code ?? 'RELATION_CANDIDATE_INVALID',
                message: error.message ?? String(error),
                ...(error.details ?? {}),
              },
            ];
          }
        state.lastDecision = structuredClone(prepared);
        const issues = preparationIssues.length ? preparationIssues : await validate(prepared);
        emit('validation', {
          stage: stageName,
          submission: counters.submissions,
          decision: prepared,
          issues,
        });
        if (issues.length) {
          state.lastIssues = issues;
          if (counters.submissions >= 4)
            throw new ValidationFailure(
              `提交仍无效；已达到 4 次上限：${JSON.stringify(issues.slice(0, 8))}`,
              {
                code: 'STAGE_VALIDATION_FAILED',
                issues,
                decision,
                submissions: counters.submissions,
              },
            );
          throw new Error(
            `仅补查这些问题，保留已核实的函数 ID 和证据后重交：${JSON.stringify(issues.slice(0, 8))}`,
          );
        }
        state.result = structuredClone(prepared);
        session?.setActiveToolsByName([]);
        return {
          content: [{ type: 'text', text: JSON.stringify({ accepted: true, stage: stageName }) }],
        };
      },
    };
    const settingsManager = SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 1 } });
    const loader = await createDekkoResourceLoader({
      cwd: snapshot.root,
      agentDir,
      settingsManager,
      prompt,
    });
    const created = await createAgentSession({
      cwd: snapshot.root,
      agentDir,
      model: selectedModel,
      modelRuntime: runtime,
      thinkingLevel: 'off',
      settingsManager,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(snapshot.root),
      customTools: [...sourceTools, ...relationTools, submit],
      tools: [
        ...sourceTools.map((tool) => tool.name),
        ...(kind === 'main_review' ? [] : DEKKO_ROUTE_TOOL_NAMES),
        ...relationTools.map((tool) => tool.name),
        submit.name,
      ],
    });
    session = created.session;
    const abort = () => {
      void session.abort().catch(() => {});
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      await session.bindExtensions({ mode: 'print' });
      if (kind === 'main_review')
        session.setActiveToolsByName([
          ...sourceTools.map((tool) => tool.name),
          ...relationTools.map((tool) => tool.name),
          submit.name,
        ]);
      else
        await activateRoutePlanningTools(
          session,
          [...relationTools.map((tool) => tool.name), submit.name],
          {
            signal,
            investigationToolNames: ROUTE_INVESTIGATION_TOOL_NAMES,
          },
        );
      const off = session.subscribe((event) => {
        if (event.type === 'tool_execution_start')
          emit('trace', {
            stage: stageName,
            event: event.type,
            tool: event.toolName,
            id: event.toolCallId,
            args: event.args,
          });
        if (event.type === 'tool_execution_end')
          emit('trace', {
            stage: stageName,
            event: event.type,
            tool: event.toolName,
            id: event.toolCallId,
            is_error: event.isError,
            result: JSON.stringify(event.result ?? null).slice(0, 50000),
          });
        if (
          event.type !== 'tool_execution_start' ||
          !DEKKO_ROUTE_TOOL_NAMES.includes(event.toolName)
        )
          return;
        counters.calls++;
        emit('tool', { stage: stageName, tool: event.toolName });
        if (counters.calls >= config.maxCalls && !state.result)
          session.setActiveToolsByName([...relationTools.map((tool) => tool.name), submit.name]);
      });
      try {
        await session.prompt(
          JSON.stringify({
            ...stageInput,
            output_tool: submit.name,
            limits: {
              max_tool_calls: config.maxCalls,
              max_source_reads: config.maxReads,
              max_lines_per_read: 200,
              max_grep_context: 3,
            },
          }),
          { expandPromptTemplates: false },
        );
        if (modelFailure(session))
          throw new Error(`${stageName} 模型调用失败：${JSON.stringify(modelFailure(session))}`);
        if (!state.result)
          await session.prompt(
            JSON.stringify({
              task: 'submit_now',
              instruction: `现在调用 ${submit.name} 提交你已查明的结果；若模块无法展开，使用 blocked 并说明原因。`,
              validation_issues: state.lastIssues,
            }),
            { expandPromptTemplates: false },
          );
        if (!state.result)
          throw new ValidationFailure(
            `${stageName} 未提交有效结果：${JSON.stringify({ issues: state.lastIssues.slice(0, 8), model: modelFailure(session), decision: state.lastDecision }).slice(0, 8000)}`,
            {
              code: 'STAGE_VALIDATION_FAILED',
              issues: state.lastIssues,
              decision: state.lastDecision,
              submissions: counters.submissions,
            },
          );
        const summary =
          kind === 'main'
            ? {
                modules: state.result.modules.map((item) => ({
                  id: item.id,
                  expected_input: item.expected_input,
                  expected_outcome: item.expected_outcome,
                })),
              }
            : kind === 'main_review'
              ? {
                  status: state.result.status,
                  modules: state.result.replacement_plan?.modules?.map((item) => item.id),
                }
              : kind === 'module'
                ? {
                    blocks: state.result.blocks?.map((item) => item.symbol ?? item.title),
                    execution: state.result.execution,
                  }
                : {
                    status: state.result.status,
                    revisions: state.result.revisions?.map((item) => item.module_id),
                  };
        emit('stage', {
          stage: stageName,
          calls: counters.calls,
          reads: counters.reads,
          submissions: counters.submissions,
          summary,
        });
        return state.result;
      } finally {
        off();
      }
    } finally {
      signal.removeEventListener('abort', abort);
      await disposeRoutePlanningSession(session);
    }
  };
}
