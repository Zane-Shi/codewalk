import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  createAgentSession,
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
import { createGetProjectOverviewTool } from '../overview-model.ts';
import { resourceLoader } from '../agent.ts';
import { ValidationFailure } from '../validation-feedback.ts';
import { createBoundedSourceTools } from './source-tools.ts';
import { createSourceUnitBatchTools } from './source-units.ts';
import { createSemanticRouteDraftTool } from './semantic-route-drafts.ts';
import { createSemanticRouteReviewTool } from './semantic-route-review.ts';
import {
  createBlockTeachingTool,
  createInspectTeachingSourceTool,
  createModuleTeachingTool,
  createTeachingRevisionTool,
  teachingSource,
} from './semantic-route-teaching.ts';

const CREATOR_LIMITS = Object.freeze({ maxCalls: 48, maxReads: 20 });
const REVIEWER_LIMITS = Object.freeze({ maxCalls: 40, maxReads: 16 });

export const SEMANTIC_REVIEWER_READ_ONLY_TOOL_NAMES = Object.freeze([
  ...ROUTE_INVESTIGATION_TOOL_NAMES,
  'get_project_overview',
]);

export const semanticReviewerThinkingLevel = (model) => (model?.reasoning ? 'high' : 'off');

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

function confirmedBatchSummaries(sourceUnitService) {
  return sourceUnitService.store
    .list('source_unit_batch_review')
    .filter(
      (review) =>
        review.snapshot_id === sourceUnitService.snapshot.id && review.status === 'confirmed',
    )
    .map((review) => sourceUnitService.getBatch(review.batch_id, review.revision))
    .map((state) => ({
      batch_id: state.batch.batch_id,
      revision: state.batch.revision,
      module_id: state.batch.module_id,
      units: state.units.map((item) => item.unit),
    }));
}

async function selectedModel(runtime, model) {
  const available = await runtime.getAvailable(),
    selected = available.find((item) => `${item.provider}/${item.id}` === model);
  if (!selected) throw new Error(`语义路线模型不可用：${model}`);
  return selected;
}

async function openSemanticSession({
  snapshot,
  selected,
  runtime,
  dataDir,
  stageName,
  promptName,
  tools,
  enabledTools,
  thinkingLevel = 'off',
}) {
  const agentDir = path.join(dataDir, `pi-config-${stageName}`);
  await mkdir(agentDir, { recursive: true });
  const prompt = await readFile(new URL(`../prompts/${promptName}`, import.meta.url), 'utf8'),
    settingsManager = SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 1 } }),
    loader = await createDekkoResourceLoader({
      cwd: snapshot.root,
      agentDir,
      settingsManager,
      prompt,
    });
  const { session } = await createAgentSession({
    cwd: snapshot.root,
    agentDir,
    model: selected,
    modelRuntime: runtime,
    thinkingLevel,
    settingsManager,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(snapshot.root),
    customTools: tools,
    tools: enabledTools,
  });
  return session;
}

function trackTeachingSession({ session, store, draft, stageName, target, maxTurns = 8 }) {
  let turns = 0;
  const validationErrors = [];
  const started = Date.now(),
    off = session.subscribe((event) => {
      if (event.type === 'turn_start' && ++turns > maxTurns) void session.abort().catch(() => {});
      if (event.type === 'tool_execution_end' && event.isError && validationErrors.length < 8)
        validationErrors.push({
          tool: event.toolName,
          error: (event.result?.content ?? [])
            .filter((item) => item.type === 'text')
            .map((item) => item.text)
            .join('\n')
            .slice(0, 800),
        });
    });
  return () => {
    off();
    const stats = session.getSessionStats();
    store.put('semantic_route_teaching_usage', {
      id: `${draft.id}:${stageName}:${started}`,
      draft_id: draft.id,
      stage: stageName,
      target,
      tokens: stats.tokens,
      tool_calls: stats.toolCalls,
      validation_errors: validationErrors,
      estimated_cost: stats.cost,
      duration_ms: Date.now() - started,
      created_at: started,
    });
  };
}

async function openTeachingSession({
  snapshot,
  selected,
  runtime,
  dataDir,
  stageName,
  promptName,
  tools,
  thinkingLevel = 'off',
}) {
  const agentDir = path.join(dataDir, `pi-config-${stageName}`);
  await mkdir(agentDir, { recursive: true });
  const prompt = await readFile(new URL(`../prompts/${promptName}`, import.meta.url), 'utf8'),
    settingsManager = SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 1 } }),
    { session } = await createAgentSession({
      cwd: snapshot.root,
      agentDir,
      model: selected,
      modelRuntime: runtime,
      thinkingLevel,
      settingsManager,
      resourceLoader: resourceLoader(prompt),
      sessionManager: SessionManager.inMemory(snapshot.root),
      customTools: tools,
      tools: tools.map((tool) => tool.name),
    });
  return session;
}

async function runPromptWithForcedSubmission({ session, input, submitName, submitted, signal }) {
  signal.throwIfAborted();
  await session.prompt(JSON.stringify(input), { expandPromptTemplates: false });
  if (modelFailure(session))
    throw new Error(`模型调用失败：${JSON.stringify(modelFailure(session))}`);
  if (!submitted())
    await session.prompt(
      JSON.stringify({
        task: 'submit_now',
        instruction: `停止继续调查，立即调用 ${submitName} 提交当前最可靠结果。`,
      }),
      { expandPromptTemplates: false },
    );
  if (!submitted())
    throw new ValidationFailure(`Agent 未调用 ${submitName} 提交结果`, {
      code: 'SEMANTIC_AGENT_NO_SUBMISSION',
      issues: [],
      decision: null,
      submissions: 0,
    });
}

// Teaching submits a complete, validated artifact. Stop at the successful tool
// turn rather than asking the model for a redundant final answer afterwards.
export async function runTeachingPrompt(options) {
  const { session, submitted, signal } = options;
  const previousStop = session.agent.shouldStopAfterTurn;
  session.agent.shouldStopAfterTurn = () => Boolean(submitted());
  try {
    await runPromptWithForcedSubmission(options);
    signal.throwIfAborted();
  } catch (error) {
    signal.throwIfAborted();
    if (submitted()) return;
    const rejected = [...(session.agent.state.messages ?? [])]
      .reverse()
      .find((message) => message.role === 'toolResult' && message.isError);
    const feedback = (rejected?.content ?? [])
      .filter((item) => item.type === 'text')
      .map((item) => item.text)
      .join('\n')
      .slice(0, 1200);
    if (feedback) throw new Error(`${error.message}；最近一次工具校验错误：${feedback}`);
    throw error;
  } finally {
    session.agent.shouldStopAfterTurn = previousStop;
  }
}

export async function createPiSemanticRouteRunners({
  store,
  snapshot,
  sourceGraph,
  model,
  dataDir,
  sourceUnitService,
  draftService,
  reviewService,
  signal = new AbortController().signal,
  modelRuntime,
  emit = () => {},
}) {
  const runtime = modelRuntime ?? (await ModelRuntime.create()),
    selected = await selectedModel(runtime, model);
  let creatorSequence = 0,
    reviewerSequence = 0,
    teacherSequence = 0,
    editorSequence = 0;

  const runCreator = async ({ request, previous_draft, previous_review, recovery_context }) => {
    signal.throwIfAborted();
    const stageName = `semantic-creator-${++creatorSequence}`,
      counters = { calls: 0, reads: 0 },
      sourceTools = createBoundedSourceTools(
        snapshot,
        CREATOR_LIMITS,
        counters,
        signal,
        (type, value) => emit(type, { stage: stageName, ...value }),
      );
    let draft, session;
    const unitTools = createSourceUnitBatchTools({
        service: sourceUnitService,
        reviewer_id: stageName,
      }),
      draftTool = createSemanticRouteDraftTool({
        service: draftService,
        creator_id: stageName,
        onCreated: (created) => {
          draft = created;
          session?.setActiveToolsByName([]);
        },
      }),
      workflowTools = [...unitTools, draftTool];
    session = await openSemanticSession({
      snapshot,
      selected,
      runtime,
      dataDir,
      stageName,
      promptName: 'semantic-route-creator.md',
      tools: [...sourceTools, ...workflowTools],
      enabledTools: [
        ...sourceTools.map((tool) => tool.name),
        ...DEKKO_ROUTE_TOOL_NAMES,
        ...workflowTools.map((tool) => tool.name),
      ],
    });
    const abort = () => void session.abort().catch(() => {});
    signal.addEventListener('abort', abort, { once: true });
    try {
      await session.bindExtensions({ mode: 'print' });
      await activateRoutePlanningTools(
        session,
        workflowTools.map((tool) => tool.name),
        { signal, investigationToolNames: ROUTE_INVESTIGATION_TOOL_NAMES },
      );
      const off = session.subscribe((event) => {
        if (
          event.type !== 'tool_execution_start' ||
          !DEKKO_ROUTE_TOOL_NAMES.includes(event.toolName)
        )
          return;
        counters.calls++;
        emit('tool', { stage: stageName, tool: event.toolName });
        if (counters.calls >= CREATOR_LIMITS.maxCalls && !draft)
          session.setActiveToolsByName(workflowTools.map((tool) => tool.name));
      });
      try {
        await runPromptWithForcedSubmission({
          session,
          submitName: draftTool.name,
          submitted: () => Boolean(draft),
          signal,
          input: {
            task: 'create_semantic_reading_route',
            request,
            code_graph_summary: {
              files: sourceGraph?.files?.length ?? 0,
              symbols: sourceGraph?.entities?.length ?? 0,
            },
            reusable_confirmed_source_batches: confirmedBatchSummaries(sourceUnitService),
            previous_draft: previous_draft ?? null,
            independent_review: previous_review ?? null,
            recovery_context: recovery_context ?? null,
            output_tool: draftTool.name,
            limits: {
              max_tool_calls: CREATOR_LIMITS.maxCalls,
              max_source_reads: CREATOR_LIMITS.maxReads,
              max_lines_per_read: 200,
            },
          },
        });
      } finally {
        off();
      }
      emit('stage', {
        stage: stageName,
        calls: counters.calls,
        reads: counters.reads,
        draft_id: draft.id,
      });
      return draft;
    } finally {
      signal.removeEventListener('abort', abort);
      await disposeRoutePlanningSession(session);
    }
  };

  const runReviewer = async ({ draft, recovery_context }) => {
    signal.throwIfAborted();
    const stageName = `semantic-reviewer-${++reviewerSequence}`,
      counters = { calls: 0, reads: 0 },
      sourceTools = createBoundedSourceTools(
        snapshot,
        REVIEWER_LIMITS,
        counters,
        signal,
        (type, value) => emit(type, { stage: stageName, ...value }),
      ),
      overviewTool = createGetProjectOverviewTool({
        snapshot,
        loadOverview: async () =>
          store
            .list('overview')
            .find((item) => item.snapshotId === snapshot.id || item.id === snapshot.id),
      });
    let review, session;
    const tool = createSemanticRouteReviewTool({
      service: reviewService,
      reviewer_id: stageName,
      draft_id: draft.id,
      onReviewed: (created) => {
        review = created;
        session?.setActiveToolsByName([]);
      },
    });
    session = await openSemanticSession({
      snapshot,
      selected,
      runtime,
      dataDir,
      stageName,
      promptName: 'semantic-route-reviewer.md',
      tools: [...sourceTools, overviewTool, tool],
      enabledTools: [...SEMANTIC_REVIEWER_READ_ONLY_TOOL_NAMES, tool.name],
      thinkingLevel: semanticReviewerThinkingLevel(selected),
    });
    const abort = () => void session.abort().catch(() => {});
    signal.addEventListener('abort', abort, { once: true });
    try {
      await session.bindExtensions({ mode: 'print' });
      await activateRoutePlanningTools(session, [tool.name], {
        signal,
        investigationToolNames: SEMANTIC_REVIEWER_READ_ONLY_TOOL_NAMES,
      });
      const off = session.subscribe((event) => {
        if (
          event.type !== 'tool_execution_start' ||
          (!DEKKO_ROUTE_TOOL_NAMES.includes(event.toolName) && event.toolName !== overviewTool.name)
        )
          return;
        counters.calls++;
        emit('tool', { stage: stageName, tool: event.toolName });
        if (counters.calls >= REVIEWER_LIMITS.maxCalls && !review)
          session.setActiveToolsByName([tool.name]);
      });
      try {
        await runPromptWithForcedSubmission({
          session,
          submitName: tool.name,
          submitted: () => Boolean(review),
          signal,
          input: {
            task: 'review_complete_semantic_route',
            review_packet: reviewService.reviewInput(draft.id),
            recovery_context: recovery_context ?? null,
            output_tool: tool.name,
          },
        });
      } finally {
        off();
      }
      emit('stage', {
        stage: stageName,
        calls: counters.calls,
        reads: counters.reads,
        decision: review.decision,
        issues: review.issues.length,
      });
      return review;
    } finally {
      signal.removeEventListener('abort', abort);
      await disposeRoutePlanningSession(session);
    }
  };

  const runModuleTeacher = async ({ request, draft, module, services, recovery_context }) => {
    signal.throwIfAborted();
    const stageName = `semantic-module-teacher-${++teacherSequence}`;
    let teaching, session;
    const tool = createModuleTeachingTool({
      service: services.teachingService,
      teacher_id: stageName,
      module_id: module.id,
      onCreated: (created) => {
        teaching = created;
        session?.setActiveToolsByName([]);
      },
    });
    session = await openTeachingSession({
      snapshot,
      selected,
      runtime,
      dataDir,
      stageName,
      promptName: 'semantic-route-teacher.md',
      tools: [tool],
    });
    const finishUsage = trackTeachingSession({
        session,
        store,
        draft,
        stageName,
        target: module.id,
      }),
      abort = () => void session.abort().catch(() => {});
    signal.addEventListener('abort', abort, { once: true });
    try {
      await runTeachingPrompt({
        session,
        submitName: tool.name,
        submitted: () => Boolean(teaching),
        signal,
        input: {
          task: 'explain_locked_module',
          draft_id: draft.id,
          recovery_context,
          reader: {
            level: 'beginner',
            assumption: '只掌握基础语法，不了解当前项目、框架约定和业务术语',
          },
          request: request.goal,
          route: { goal: draft.goal, summary: draft.summary },
          module: {
            id: module.id,
            title: module.title,
            objective: module.objective,
            transition_from_previous: module.transition_from_previous,
            blocks: module.steps.map((step) => ({
              id: step.id,
              order: step.order,
              title: step.title,
              planner_explanation: step.explanation,
              reading_guidance: step.reading_guidance,
              transition_from_previous: step.transition_from_previous,
              source: teachingSource(step.source_unit),
            })),
          },
          output_tool: tool.name,
        },
      });
      emit('stage', { stage: stageName, module_id: module.id, status: 'complete' });
      return teaching;
    } finally {
      signal.removeEventListener('abort', abort);
      finishUsage();
      session.dispose();
    }
  };

  const runBlockTeacher = async ({
    request,
    draft,
    module,
    step,
    module_teaching,
    services,
    recovery_context,
  }) => {
    signal.throwIfAborted();
    const stageName = `semantic-block-teacher-${++teacherSequence}`;
    let teaching, session;
    const tool = createBlockTeachingTool({
      service: services.teachingService,
      teacher_id: stageName,
      block_id: step.id,
      onCreated: (created) => {
        teaching = created;
        session?.setActiveToolsByName([]);
      },
    });
    session = await openTeachingSession({
      snapshot,
      selected,
      runtime,
      dataDir,
      stageName,
      promptName: 'semantic-route-teacher.md',
      tools: [tool],
    });
    const finishUsage = trackTeachingSession({ session, store, draft, stageName, target: step.id }),
      abort = () => void session.abort().catch(() => {}),
      index = module.steps.findIndex((item) => item.id === step.id),
      compactBlock = (item) =>
        item
          ? {
              id: item.id,
              title: item.title,
              planner_explanation: item.explanation,
            }
          : null;
    signal.addEventListener('abort', abort, { once: true });
    try {
      await runTeachingPrompt({
        session,
        submitName: tool.name,
        submitted: () => Boolean(teaching),
        signal,
        input: {
          task: 'explain_locked_block',
          draft_id: draft.id,
          recovery_context,
          reader: {
            level: 'beginner',
            assumption: '只掌握基础语法，不了解当前项目、框架约定和业务术语',
          },
          request: request.goal,
          route: { goal: draft.goal, summary: draft.summary },
          module: {
            id: module.id,
            title: module.title,
            objective: module.objective,
            teaching: module_teaching.explanation,
            ordered_blocks: module.steps.map((item) => ({
              id: item.id,
              order: item.order,
              title: item.title,
              role: item.explanation,
            })),
          },
          previous_block: compactBlock(module.steps[index - 1]),
          current_block: {
            id: step.id,
            title: step.title,
            planner_explanation: step.explanation,
            reading_guidance: step.reading_guidance,
            transition_from_previous: step.transition_from_previous,
            source: teachingSource(step.source_unit),
          },
          next_block: compactBlock(module.steps[index + 1]),
          output_tool: tool.name,
        },
      });
      emit('stage', {
        stage: stageName,
        module_id: module.id,
        block_id: step.id,
        status: 'complete',
      });
      return teaching;
    } finally {
      signal.removeEventListener('abort', abort);
      finishUsage();
      session.dispose();
    }
  };

  const runTeachingEditor = async ({ request, draft, teaching, services, recovery_context }) => {
    signal.throwIfAborted();
    const stageName = `semantic-teaching-editor-${++editorSequence}`;
    let revision, session;
    const inspectTool = createInspectTeachingSourceTool({
        service: services.teachingService,
        onLimit: () => session?.setActiveToolsByName(['submit_teaching_revision']),
      }),
      submitTool = createTeachingRevisionTool({
        service: services.teachingService,
        editor_id: stageName,
        onCreated: (created) => {
          revision = created;
          session?.setActiveToolsByName([]);
        },
      });
    session = await openTeachingSession({
      snapshot,
      selected,
      runtime,
      dataDir,
      stageName,
      promptName: 'semantic-route-teaching-editor.md',
      tools: [inspectTool, submitTool],
      thinkingLevel: semanticReviewerThinkingLevel(selected),
    });
    const finishUsage = trackTeachingSession({
        session,
        store,
        draft,
        stageName,
        target: draft.id,
        maxTurns: 16,
      }),
      abort = () => void session.abort().catch(() => {});
    signal.addEventListener('abort', abort, { once: true });
    try {
      await runTeachingPrompt({
        session,
        submitName: submitTool.name,
        submitted: () => Boolean(revision),
        signal,
        input: {
          task: 'revise_complete_route_teaching',
          draft_id: draft.id,
          recovery_context,
          reader: {
            level: 'beginner',
            assumption: '只掌握基础语法，不了解当前项目、框架约定和业务术语',
          },
          request: request.goal,
          route: {
            goal: draft.goal,
            summary: draft.summary,
            modules: draft.modules.map((module) => ({
              id: module.id,
              order: module.order,
              title: module.title,
              objective: module.objective,
              blocks: module.steps.map((step) => ({
                id: step.id,
                order: step.order,
                title: step.title,
                file: step.source_unit.file,
                start_line: step.source_unit.start_line,
                end_line: step.source_unit.end_line,
                planner_explanation: step.explanation,
              })),
            })),
          },
          teaching,
          source_tool: inspectTool.name,
          source_budget: { max_calls: 12, max_blocks_per_call: 8 },
          output_tool: submitTool.name,
        },
      });
      emit('stage', {
        stage: stageName,
        status: 'complete',
        decision: revision.decision,
        replacements:
          (revision.module_replacements?.length ?? 0) + (revision.block_replacements?.length ?? 0),
      });
      return revision;
    } finally {
      signal.removeEventListener('abort', abort);
      finishUsage();
      session.dispose();
    }
  };

  return { runCreator, runReviewer, runModuleTeacher, runBlockTeacher, runTeachingEditor };
}
