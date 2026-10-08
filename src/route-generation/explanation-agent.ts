import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';

const string = (maxLength = 2000) => ({ type: 'string', minLength: 1, maxLength });
const strings = (maxItems, maxLength = 1200) => ({
  type: 'array',
  minItems: 1,
  maxItems,
  items: string(maxLength),
});
const walkthrough = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'start_line', 'end_line', 'explanation'],
  properties: {
    title: string(200),
    start_line: { type: 'integer', minimum: 1 },
    end_line: { type: 'integer', minimum: 1 },
    explanation: string(2400),
  },
};
const skipGuidance = {
  type: 'object',
  additionalProperties: false,
  required: ['start_line', 'end_line', 'reason'],
  properties: {
    start_line: { type: 'integer', minimum: 1 },
    end_line: { type: 'integer', minimum: 1 },
    reason: string(1200),
  },
};
const blockExplanation = {
  type: 'object',
  additionalProperties: false,
  required: ['block_id', 'summary', 'why_read', 'walkthrough', 'takeaways'],
  properties: {
    block_id: string(160),
    summary: string(1800),
    why_read: string(1800),
    walkthrough: { type: 'array', minItems: 1, maxItems: 16, items: walkthrough },
    takeaways: strings(3, 800),
    skip_guidance: { type: 'array', maxItems: 8, items: skipGuidance },
    pseudocode: string(2400),
  },
};
const moduleExplanation = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'why_read', 'expected_input', 'expected_outcome', 'takeaway'],
  properties: {
    summary: string(2400),
    why_read: string(1600),
    expected_input: string(1200),
    expected_outcome: string(1200),
    takeaway: string(1200),
  },
};
const relationExplanation = {
  type: 'object',
  additionalProperties: false,
  required: ['relation_id', 'explanation'],
  properties: { relation_id: string(160), explanation: string(1600) },
};
const issueEvidence = {
  type: 'object',
  additionalProperties: false,
  required: ['observation'],
  properties: {
    block_id: string(160),
    relation_id: string(160),
    location: {
      type: 'object',
      additionalProperties: false,
      required: ['file', 'start', 'end'],
      properties: {
        file: string(500),
        start: {
          type: 'object',
          additionalProperties: false,
          required: ['line'],
          properties: { line: { type: 'integer', minimum: 1 } },
        },
        end: {
          type: 'object',
          additionalProperties: false,
          required: ['line'],
          properties: { line: { type: 'integer', minimum: 1 } },
        },
      },
    },
    observation: string(1600),
  },
};
const routeIssue = {
  type: 'object',
  additionalProperties: false,
  required: ['code', 'summary', 'affected_block_ids', 'affected_relation_ids', 'evidence'],
  properties: {
    code: {
      type: 'string',
      enum: [
        'missing_implementation',
        'unsupported_relation',
        'incorrect_order',
        'scenario_mismatch',
        'source_mismatch',
        'invalid_module_boundary',
      ],
    },
    summary: string(1600),
    affected_block_ids: { type: 'array', maxItems: 12, uniqueItems: true, items: string(160) },
    affected_relation_ids: { type: 'array', maxItems: 16, uniqueItems: true, items: string(160) },
    evidence: { type: 'array', minItems: 1, maxItems: 8, items: issueEvidence },
  },
};

/** Conditional completeness is enforced by validateModuleExplanationResult. */
export const MODULE_EXPLANATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schema_version',
    'route_plan_id',
    'decision_digest',
    'snapshot_id',
    'module_id',
    'status',
  ],
  properties: {
    schema_version: { type: 'string', const: '1' },
    route_plan_id: string(200),
    decision_digest: string(200),
    snapshot_id: string(200),
    module_id: string(200),
    status: { type: 'string', enum: ['ready', 'route_issue'] },
    module: moduleExplanation,
    blocks: { type: 'array', maxItems: 20, items: blockExplanation },
    relations: { type: 'array', maxItems: 32, items: relationExplanation },
    issues: { type: 'array', minItems: 1, maxItems: 8, items: routeIssue },
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

/** Creates a fresh, tool-free Pi context for each module explanation. */
export async function createPiExplanationModuleRunner({
  snapshot,
  model,
  dataDir,
  signal = new AbortController().signal,
  modelRuntime,
  emit = () => {},
}) {
  const runtime = modelRuntime ?? (await ModelRuntime.create());
  const available = await runtime.getAvailable(),
    selectedModel = available.find((item) => `${item.provider}/${item.id}` === model);
  if (!selectedModel) throw new Error(`解释模型不可用：${model}`);
  const prompt = await readFile(
    new URL('../prompts/autonomous-route-explanation.md', import.meta.url),
    'utf8',
  );
  let sequence = 0;
  return async ({ input, validate }) => {
    signal.throwIfAborted();
    const stage = `explanation-${++sequence}-${input.current_module.module_id.replace(/[^\w-]/g, '_')}`;
    const agentDir = path.join(dataDir, `pi-config-${stage}`);
    await mkdir(agentDir, { recursive: true });
    const settingsManager = SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 1 } });
    const loader = new DefaultResourceLoader({
      cwd: snapshot.root,
      agentDir,
      settingsManager,
      systemPrompt: prompt,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    let session,
      submissions = 0,
      result,
      lastDecision,
      lastIssues = [];
    const submit = {
      name: 'submit_module_explanation',
      label: '提交模块解释',
      description: '提交当前模块的完整教学解释，或提交由源码证据支持的路线问题。不得修改路线结构。',
      parameters: MODULE_EXPLANATION_SCHEMA,
      executionMode: 'sequential',
      async execute(_id, decision) {
        signal.throwIfAborted();
        if (++submissions > 3) throw new Error('当前模块解释已达到 3 次提交上限');
        lastDecision = structuredClone(decision);
        const issues = validate(decision);
        emit('validation', { stage, submission: submissions, decision, issues });
        if (issues.length) {
          lastIssues = issues;
          throw new Error(
            `只修正这些结构或源码锚点问题后重新提交：${JSON.stringify(issues.slice(0, 8))}`,
          );
        }
        result = structuredClone(decision);
        session?.setActiveToolsByName([]);
        return { content: [{ type: 'text', text: JSON.stringify({ accepted: true, stage }) }] };
      },
    };
    const created = await createAgentSession({
      cwd: snapshot.root,
      agentDir,
      model: selectedModel,
      modelRuntime: runtime,
      thinkingLevel: 'off',
      settingsManager,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(snapshot.root),
      customTools: [submit],
      tools: [submit.name],
    });
    session = created.session;
    const abort = () => {
      void session.abort().catch(() => {});
    };
    signal.addEventListener('abort', abort, { once: true });
    const off = session.subscribe((event) => {
      if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end')
        emit('trace', {
          stage,
          event: event.type,
          tool: event.toolName,
          id: event.toolCallId,
          ...(event.type === 'tool_execution_start'
            ? { args: event.args }
            : { is_error: event.isError }),
        });
    });
    try {
      await session.prompt(
        JSON.stringify({ task: 'explain_locked_route_module', input, output_tool: submit.name }),
        { expandPromptTemplates: false },
      );
      if (modelFailure(session))
        throw new Error(`${stage} 模型调用失败：${JSON.stringify(modelFailure(session))}`);
      if (!result)
        await session.prompt(
          JSON.stringify({
            task: 'submit_now',
            output_tool: submit.name,
            instruction:
              '不要继续分析。根据给定源码立即提交完整解释；只有路线事实确实错误时才提交 route_issue。',
            validation_issues: lastIssues,
          }),
          { expandPromptTemplates: false },
        );
      if (!result)
        throw new Error(
          `${stage} 未提交有效解释：${JSON.stringify({
            issues: lastIssues.slice(0, 8),
            model: modelFailure(session),
            decision: lastDecision,
          }).slice(0, 8000)}`,
        );
      emit('stage', {
        stage,
        submissions,
        status: result.status,
        blocks: result.blocks?.map((item) => item.block_id),
      });
      return result;
    } finally {
      off();
      signal.removeEventListener('abort', abort);
      session.dispose();
    }
  };
}
