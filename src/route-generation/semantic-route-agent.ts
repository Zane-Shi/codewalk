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
import { ValidationFailure } from '../validation-feedback.ts';
import { stageSourceTools } from './autonomous-agent.ts';
import { createSourceUnitBatchTools } from './source-units.ts';
import { createSemanticRouteDraftTool } from './semantic-route-drafts.ts';
import { createSemanticRouteReviewTool } from './semantic-route-review.ts';

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
    reviewerSequence = 0;

  const runCreator = async ({ request, previous_draft, previous_review, recovery_context }) => {
    signal.throwIfAborted();
    const stageName = `semantic-creator-${++creatorSequence}`,
      counters = { calls: 0, reads: 0 },
      sourceTools = stageSourceTools(snapshot, CREATOR_LIMITS, counters, signal, (type, value) =>
        emit(type, { stage: stageName, ...value }),
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
      sourceTools = stageSourceTools(snapshot, REVIEWER_LIMITS, counters, signal, (type, value) =>
        emit(type, { stage: stageName, ...value }),
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

  return { runCreator, runReviewer };
}
