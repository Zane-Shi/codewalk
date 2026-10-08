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
import { createSubmitModuleBlocksTool } from './module-blocks.ts';
import {
  buildModulePlanningSeed,
  compactModuleResults,
  mentionedModuleSymbolNames,
  mergePlanningSeed,
  promoteMentionedModuleSymbols,
} from './module-context.ts';
import { createSubmitModulePlanTool } from './module-plan.ts';
import { createPlanningSourceTools, createSubmitRouteAssemblyTool } from './planning-tools.ts';
import { auditExpandedRoute, createSubmitRouteReviewTool } from './route-review.ts';

const MODULE_INVESTIGATION_TOOLS = ROUTE_INVESTIGATION_TOOL_NAMES;

export class RoutePlanningBudgetError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RoutePlanningBudgetError';
    this.code = 'ROUTE_PLANNING_BUDGET_EXCEEDED';
  }
}

function assertBudget(value, name) {
  for (const key of ['max_tool_calls', 'max_source_reads', 'max_source_bytes'])
    if (!Number.isInteger(value?.[key]) || value[key] < 1)
      throw new Error(`路线规划预算 ${name}.${key} 无效`);
}

function assertInputs(snapshot, request, seed) {
  if (!snapshot?.root || !snapshot?.id) throw new Error('路线规划缺少源码快照');
  if (request?.schema_version !== '1' || seed?.schema_version !== '1')
    throw new Error('路线规划请求或 PlanningSeed 版本无效');
  if (snapshot.id !== request.snapshot_id || seed.snapshot_id !== request.snapshot_id)
    throw new Error('源码快照、路线请求和 PlanningSeed 不一致');
  if (!Array.isArray(seed.candidates) || !seed.candidates.length)
    throw new Error('PlanningSeed 没有可规划候选');
  for (const key of [
    'min_modules',
    'max_modules',
    'max_blocks',
    'max_blocks_per_module',
    'max_submission_attempts',
    'max_revision_rounds',
    'max_source_lines_per_read',
    'max_locked_plan_bytes',
  ]) {
    if (!Number.isInteger(request.limits?.[key]) || request.limits[key] < 1)
      throw new Error(`路线规划预算 ${key} 无效`);
  }
  assertBudget(request.limits.main_agent, 'main_agent');
  assertBudget(request.limits.module_agent, 'module_agent');
  assertBudget(request.limits.global, 'global');
}

function budgetFailure(budget, limit) {
  return new RoutePlanningBudgetError(
    `当前 Agent 调查工具已达到 ${limit} 次上限（拒绝：${budget.lastTool}）`,
  );
}

const defaultToolRuntime = Object.freeze({
  createResourceLoader: createDekkoResourceLoader,
  activateTools: activateRoutePlanningTools,
  bindExtensions: true,
  disposeSession: disposeRoutePlanningSession,
});

function stageLimits(local, global, usage) {
  const limits = {
    max_tool_calls: Math.min(local.max_tool_calls, global.max_tool_calls - usage.toolCalls),
    max_source_reads: Math.min(local.max_source_reads, global.max_source_reads - usage.sourceReads),
    max_source_bytes: Math.min(local.max_source_bytes, global.max_source_bytes - usage.sourceBytes),
  };
  if (Object.values(limits).some((value) => value < 1))
    throw new RoutePlanningBudgetError('分层路线规划的全局调查预算已经耗尽');
  return limits;
}

async function openSession({
  snapshot,
  selectedModel,
  runtime,
  dataDir,
  name,
  prompt,
  tools,
  workflowNames,
  investigationTools,
  signal,
  routeToolRuntime,
}) {
  const agentDir = path.join(dataDir, `pi-config-${name}`);
  await mkdir(agentDir, { recursive: true });
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 1 } });
  const loader = await routeToolRuntime.createResourceLoader({
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
    customTools: tools,
    tools: [
      ...new Set([
        ...tools.map((tool) => tool.name),
        ...(routeToolRuntime.bindExtensions ? DEKKO_ROUTE_TOOL_NAMES : []),
      ]),
    ],
  });
  const session = created.session;
  try {
    if (routeToolRuntime.bindExtensions) await session.bindExtensions({ mode: 'print' });
    const active = await routeToolRuntime.activateTools(session, workflowNames, {
      signal,
      investigationToolNames: investigationTools,
    });
    const allowed = new Set([...investigationTools, ...workflowNames]),
      unexpected = active.filter((name) => !allowed.has(name));
    if (unexpected.length) throw new Error(`路线规划激活了白名单外工具：${unexpected.join(', ')}`);
    return { session, active };
  } catch (error) {
    if (routeToolRuntime.disposeSession) await routeToolRuntime.disposeSession(session);
    else session.dispose();
    throw error;
  }
}

function instrumentStage({
  session,
  limits,
  budget,
  globalUsage,
  submitName,
  state,
  emit,
  phase,
  signal,
}) {
  const enterFinalization = (reason) => {
    if (state.accepted || state.finalizing) return;
    state.finalizing = true;
    session.setActiveToolsByName([submitName]);
    emit('phase', { phase, status: 'finalizing', reason });
  };
  const chargeTool = (name) => {
    budget.lastTool = name;
    if (budget.toolCalls >= limits.max_tool_calls) {
      budget.deniedToolCalls++;
      enterFinalization('tool-budget');
      throw budgetFailure(budget, limits.max_tool_calls);
    }
    budget.toolCalls++;
    globalUsage.toolCalls++;
  };
  const originalStream = session.agent.streamFunction;
  session.agent.streamFunction = (selected, context, options) => {
    budget.modelRequests++;
    globalUsage.modelRequests++;
    return originalStream(selected, context, { ...options, maxRetries: 1 });
  };
  const off = session.subscribe((event) => {
    if (event.type === 'tool_execution_start' && DEKKO_ROUTE_TOOL_NAMES.includes(event.toolName)) {
      budget.lastTool = event.toolName;
      if (budget.toolCalls >= limits.max_tool_calls) {
        budget.deniedToolCalls++;
        enterFinalization('tool-budget');
      } else {
        budget.toolCalls++;
        globalUsage.toolCalls++;
        emit('progress', { phase, tool: event.toolName });
      }
      return;
    }
    if (
      event.type !== 'tool_execution_end' ||
      state.accepted ||
      state.finalizing ||
      !ROUTE_INVESTIGATION_TOOL_NAMES.includes(event.toolName)
    )
      return;
    if (
      budget.toolCalls >= limits.max_tool_calls ||
      budget.sourceReads >= limits.max_source_reads ||
      budget.sourceBytes >= limits.max_source_bytes
    ) {
      enterFinalization(
        budget.sourceReads >= limits.max_source_reads
          ? 'source-read-budget'
          : budget.sourceBytes >= limits.max_source_bytes
            ? 'source-byte-budget'
            : 'tool-budget',
      );
    }
  });
  const abort = () => {
    void session.abort().catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  return {
    chargeTool,
    dispose: () => {
      signal.removeEventListener('abort', abort);
      off();
    },
    enterFinalization,
  };
}

function addSourceUsage(globalUsage, budget) {
  globalUsage.sourceReads += budget.sourceReads;
  globalUsage.sourceBytes += budget.sourceBytes;
  globalUsage.deniedToolCalls += budget.deniedToolCalls;
}

function lastAssistantMessage(session) {
  return [...(session?.agent?.state?.messages ?? [])]
    .reverse()
    .find((message) => message?.role === 'assistant');
}

function submissionDiagnostic(session) {
  const assistant = lastAssistantMessage(session);
  const rawError = assistant?.errorMessage ?? session?.agent?.state?.errorMessage;
  const errorMessage = rawError === undefined ? undefined : String(rawError).slice(0, 800);
  if (!assistant) return { error_message: errorMessage };
  const text = Array.isArray(assistant.content)
    ? assistant.content
        .filter((item) => item?.type === 'text')
        .map((item) => item.text)
        .join('\n')
        .slice(0, 800)
    : undefined;
  return {
    stop_reason: assistant.stopReason,
    error_message: errorMessage,
    ...(text ? { text } : {}),
  };
}

async function promptForSubmission(session, input, { submitted, submitTool, task }) {
  await session.prompt(JSON.stringify(input), { expandPromptTemplates: false });
  if (
    submitted() ||
    session?.agent?.state?.errorMessage ||
    ['error', 'aborted'].includes(lastAssistantMessage(session)?.stopReason)
  )
    return;
  await session.prompt(
    JSON.stringify({
      task: 'submit_required',
      original_task: task,
      submit_tool: submitTool,
      instruction: `上一轮没有形成可消费的结构化结果。不要解释过程；现在必须调用 ${submitTool} 提交当前阶段结果。`,
    }),
    { expandPromptTemplates: false },
  );
}

async function runModuleAgent({
  module,
  moduleIndex,
  modulePlan,
  fixedDecisions = [],
  previousDecision,
  revision,
  revisionRound = 0,
  releasedCandidateIds = [],
  snapshot,
  request,
  seed,
  graph,
  selectedModel,
  runtime,
  dataDir,
  signal,
  emit,
  globalUsage,
  routeToolRuntime,
  prompt,
}) {
  const planningModule = {
    ...module,
    objective: `${module.objective}${revision?.required_focus ? `\n修订重点：${revision.required_focus}` : ''}`,
    reason: `${module.reason}${revision?.reason ? `\n修订原因：${revision.reason}` : ''}`,
    candidate_ids: [...new Set([...module.candidate_ids, ...(revision?.candidate_hints ?? [])])],
  };
  const promotedCandidates = promoteMentionedModuleSymbols(seed, graph, planningModule),
    mentionedNames = mentionedModuleSymbolNames(planningModule);
  const moduleHints = new Set(planningModule.candidate_ids);
  const namedCandidates = seed.candidates.filter(
    (candidate) =>
      moduleHints.has(candidate.id) &&
      mentionedNames.has(candidate.name) &&
      /function|method|constructor|procedure/i.test(candidate.kind ?? ''),
  );
  const localModuleSeed = {
    ...planningModule,
    candidate_ids: [
      ...new Set([
        ...planningModule.candidate_ids,
        ...namedCandidates.map((candidate) => candidate.id),
      ]),
    ],
  };
  const localSeed = buildModulePlanningSeed(seed, localModuleSeed),
    evidence = [],
    state = { submissionAttempts: 0 },
    budget = {
      toolCalls: 0,
      deniedToolCalls: 0,
      sourceReads: 0,
      sourceBytes: 0,
      modelRequests: 0,
      lastTool: undefined,
    };
  const candidateById = new Map(seed.candidates.map((candidate) => [candidate.id, candidate]));
  const moduleIndexById = new Map(modulePlan.modules.map((item, index) => [item.id, index]));
  const disallowedBlocks = fixedDecisions.flatMap(({ module_id, decision }) =>
    decision.blocks.map((block) => {
      const candidate = candidateById.get(block.candidate_id);
      return {
        module_id,
        candidate_id: block.candidate_id,
        symbol_id: candidate?.entity_id,
        name: candidate?.name,
        file: candidate?.file,
        range: block.range,
      };
    }),
  );
  const priorBlockOwnership = disallowedBlocks.filter(
    (block) => (moduleIndexById.get(block.module_id) ?? Infinity) < moduleIndex,
  );
  const otherModuleOwnership = disallowedBlocks.filter(
    (block) => (moduleIndexById.get(block.module_id) ?? -1) > moduleIndex,
  );
  const repeatedLongCandidates = new Set(
    module.candidate_ids.filter((candidateId) => {
      const candidate = candidateById.get(candidateId);
      return (
        candidate &&
        /function|method|constructor|procedure/i.test(candidate.kind ?? '') &&
        candidate.range.end_line - candidate.range.start_line + 1 >
          request.limits.max_source_lines_per_read &&
        modulePlan.modules
          .slice(moduleIndex + 1)
          .some((future) => future.candidate_ids.includes(candidateId))
      );
    }),
  );
  const released = new Set(releasedCandidateIds);
  const reservedCandidates = modulePlan.modules.slice(moduleIndex + 1).flatMap((future) =>
    future.candidate_ids
      .filter(
        (candidateId) => !repeatedLongCandidates.has(candidateId) && !released.has(candidateId),
      )
      .map((candidate_id) => {
        const candidate = candidateById.get(candidate_id);
        return {
          module_id: future.id,
          candidate_id,
          symbol_id: candidate?.entity_id,
          name: candidate?.name,
          file: candidate?.file,
        };
      }),
  );
  const requiredNamedCandidates = namedCandidates.filter(
    (candidate) => !repeatedLongCandidates.has(candidate.id),
  );
  const limits = stageLimits(request.limits.module_agent, request.limits.global, globalUsage),
    toolState = { accepted: false, finalizing: false };
  let controller, session;
  const evidencePrefix = revisionRound
    ? `me${moduleIndex + 1}r${revisionRound}_`
    : `me${moduleIndex + 1}_`;
  const sourceTools = createPlanningSourceTools({
    snapshot,
    seed: localSeed,
    graph,
    request,
    investigationLimits: limits,
    evidencePrefix,
    evidence,
    signal,
    budget,
    chargeTool: (name) => controller.chargeTool(name),
    onProgress: (progress) =>
      emit('progress', { phase: 'module', module_id: module.id, ...progress }),
  });
  const submit = createSubmitModuleBlocksTool({
    request,
    seed: localSeed,
    module,
    evidence,
    state,
    signal,
    startCandidateIds: moduleIndex === 0 ? request.constraints?.start_candidate_ids : undefined,
    disallowedBlocks,
    reservedCandidates,
    requiredCandidateIds: requiredNamedCandidates.map((candidate) => candidate.id),
    onAccepted: (decision) => {
      toolState.accepted = true;
      emit('module', { status: 'accepted', module_id: module.id, blocks: decision.blocks.length });
      session?.setActiveToolsByName([]);
    },
  });
  const sessionName = revisionRound
    ? `module-${moduleIndex + 1}-revision-${revisionRound}`
    : `module-${moduleIndex + 1}`;
  ({ session } = await openSession({
    snapshot,
    selectedModel,
    runtime,
    dataDir,
    name: sessionName,
    prompt,
    tools: [...sourceTools, submit],
    workflowNames: [submit.name],
    investigationTools: MODULE_INVESTIGATION_TOOLS,
    signal,
    routeToolRuntime,
  }));
  controller = instrumentStage({
    session,
    limits,
    budget,
    globalUsage,
    submitName: submit.name,
    state: toolState,
    emit,
    phase: `module:${module.id}`,
    signal,
  });
  try {
    const input = {
      task: 'expand_semantic_module',
      request: {
        goal: request.goal,
        limits: {
          max_blocks_per_module: request.limits.max_blocks_per_module,
          max_source_lines_per_read: request.limits.max_source_lines_per_read,
        },
      },
      module,
      previous_module: modulePlan.modules[moduleIndex - 1] ?? null,
      next_module: modulePlan.modules[moduleIndex + 1] ?? null,
      constraints: {
        start_candidate_ids:
          moduleIndex === 0 ? (request.constraints?.start_candidate_ids ?? []) : [],
      },
      revision_request: revision ?? null,
      previous_result: previousDecision ?? null,
      prior_block_ownership: priorBlockOwnership,
      other_module_ownership: otherModuleOwnership,
      future_module_reservations: reservedCandidates,
      deterministically_promoted_named_candidates: promotedCandidates.map(
        (candidate) => candidate.id,
      ),
      explicitly_named_function_candidates: requiredNamedCandidates.map(
        (candidate) => candidate.id,
      ),
      shared_long_function_candidates: [...repeatedLongCandidates],
      planning_seed: localSeed,
      evidence_policy: {
        submit_tool: submit.name,
        complete_function_max_lines: request.limits.max_source_lines_per_read,
        short_functions_must_use_full_symbol_range: true,
        focus_ranges_are_not_route_blocks: true,
      },
    };
    await promptForSubmission(session, input, {
      submitted: () => Boolean(state.decision),
      submitTool: submit.name,
      task: input.task,
    });
    if (!state.decision) {
      const error = new Error(`模块子 Agent 未提交有效代码块：${module.id}`);
      error.code = 'MODULE_PLANNING_FAILED';
      error.details = {
        module,
        decision: state.lastDecision,
        validation: state.lastReport,
        submission_attempts: state.submissionAttempts,
        last_response: submissionDiagnostic(session),
        usage: budget,
      };
      throw error;
    }
    mergePlanningSeed(seed, localSeed);
    addSourceUsage(globalUsage, budget);
    return {
      decision: state.decision,
      evidence,
      usage: { ...budget, submissionAttempts: state.submissionAttempts },
    };
  } finally {
    controller.dispose();
    if (routeToolRuntime.disposeSession) await routeToolRuntime.disposeSession(session);
    else session.dispose();
  }
}

export async function planRoute({
  snapshot,
  request,
  planningSeed,
  codeGraph,
  model,
  dataDir,
  signal: inputSignal,
  emit = () => {},
  modelRuntime: injectedRuntime,
  routeToolRuntime = defaultToolRuntime,
}) {
  assertInputs(snapshot, request, planningSeed);
  if (typeof dataDir !== 'string' || !dataDir) throw new Error('路线规划缺少 dataDir');
  if (codeGraph && codeGraph.snapshot_id !== request.snapshot_id)
    throw new Error('候选扩展图谱与路线请求不属于同一快照');
  const signal = inputSignal ?? new AbortController().signal;
  signal.throwIfAborted?.();
  const runtime = injectedRuntime ?? (await ModelRuntime.create()),
    models = await runtime.getAvailable();
  const selectedModel = model
    ? models.find((item) => `${item.provider}/${item.id}` === model)
    : models[0];
  if (!selectedModel)
    throw new Error(model ? `路线规划模型不可用：${model}` : '没有可用的路线规划模型');
  const mainPrompt = await readFile(
      new URL('../prompts/route-planner.md', import.meta.url),
      'utf8',
    ),
    modulePrompt = await readFile(
      new URL('../prompts/route-module-planner.md', import.meta.url),
      'utf8',
    );
  const seed = structuredClone(planningSeed),
    evidence = [],
    moduleDecisions = [],
    moduleUsage = [],
    reviewHistory = [],
    globalUsage = {
      toolCalls: 0,
      deniedToolCalls: 0,
      sourceReads: 0,
      sourceBytes: 0,
      modelRequests: 0,
    };
  const mainState = {
      moduleSubmissionAttempts: 0,
      reviewSubmissionAttempts: 0,
      reviewRoundSubmissionAttempts: 0,
      assemblySubmissionAttempts: 0,
      moduleDecisions,
    },
    mainToolState = { accepted: false, finalizing: false };
  const mainBudget = {
      toolCalls: 0,
      deniedToolCalls: 0,
      sourceReads: 0,
      sourceBytes: 0,
      modelRequests: 0,
      lastTool: undefined,
    },
    mainLimits = stageLimits(request.limits.main_agent, request.limits.global, globalUsage);
  let mainController, mainSession;
  const mainSourceTools = createPlanningSourceTools({
    snapshot,
    seed,
    graph: codeGraph,
    request,
    investigationLimits: mainLimits,
    evidencePrefix: 'pe',
    evidence,
    signal,
    budget: mainBudget,
    chargeTool: (name) => mainController.chargeTool(name),
    onProgress: (progress) => emit('progress', { phase: 'modules', ...progress }),
  });
  const submitModules = createSubmitModulePlanTool({
    request,
    seed,
    evidence,
    state: mainState,
    signal,
    onAccepted: (modulePlan) => {
      mainToolState.accepted = true;
      emit('modules', { status: 'drafted', modules: modulePlan.modules.length });
      mainSession?.setActiveToolsByName([]);
    },
  });
  const currentAudit = () =>
    auditExpandedRoute({
      request,
      seed,
      modulePlan: mainState.modulePlan,
      moduleDecisions,
      evidence,
    });
  const submitReview = createSubmitRouteReviewTool({
    request,
    seed,
    modulePlan: () => mainState.modulePlan,
    moduleDecisions: () => moduleDecisions,
    audit: currentAudit,
    state: mainState,
    signal,
    onAccepted: (review) => {
      mainToolState.accepted = true;
      emit('review', {
        status: review.status,
        revisions: review.revisions.map((item) => item.module_id),
      });
      mainSession?.setActiveToolsByName([]);
    },
  });
  const submitAssembly = createSubmitRouteAssemblyTool({
    request,
    seed,
    evidence,
    state: mainState,
    signal,
    onLocked: (plan) => {
      emit('locked', {
        plan_id: plan.id,
        modules: plan.modules.length,
        blocks: plan.modules.reduce((sum, module) => sum + module.blocks.length, 0),
      });
      mainSession?.setActiveToolsByName([]);
    },
  });
  ({ session: mainSession } = await openSession({
    snapshot,
    selectedModel,
    runtime,
    dataDir,
    name: 'main',
    prompt: mainPrompt,
    tools: [...mainSourceTools, submitModules, submitReview, submitAssembly],
    workflowNames: [submitModules.name],
    investigationTools: ROUTE_INVESTIGATION_TOOL_NAMES,
    signal,
    routeToolRuntime,
  }));
  mainController = instrumentStage({
    session: mainSession,
    limits: mainLimits,
    budget: mainBudget,
    globalUsage,
    submitName: submitModules.name,
    state: mainToolState,
    emit,
    phase: 'modules',
    signal,
  });
  try {
    const moduleInput = {
      task: 'plan_semantic_modules',
      request,
      planning_seed: seed,
      evidence_policy: { submit_tool: submitModules.name },
    };
    await promptForSubmission(mainSession, moduleInput, {
      submitted: () => Boolean(mainState.modulePlan),
      submitTool: submitModules.name,
      task: moduleInput.task,
    });
    if (!mainState.modulePlan) {
      const error = new Error('主规划 Agent 未提交有效语义模块骨架');
      error.code = 'MODULE_ROUTE_PLANNING_FAILED';
      error.details = {
        decision: mainState.lastModulePlan,
        validation: mainState.lastModuleReport,
        last_response: submissionDiagnostic(mainSession),
        usage: mainBudget,
      };
      throw error;
    }
    addSourceUsage(globalUsage, mainBudget);
    for (let index = 0; index < mainState.modulePlan.modules.length; index++) {
      signal.throwIfAborted?.();
      const fixedDecisions = moduleDecisions.map((decision, decisionIndex) => ({
        module_id: mainState.modulePlan.modules[decisionIndex].id,
        decision,
      }));
      const result = await runModuleAgent({
        module: mainState.modulePlan.modules[index],
        moduleIndex: index,
        modulePlan: mainState.modulePlan,
        fixedDecisions,
        snapshot,
        request,
        seed,
        graph: codeGraph,
        selectedModel,
        runtime,
        dataDir,
        signal,
        emit,
        globalUsage,
        routeToolRuntime,
        prompt: modulePrompt,
      });
      moduleDecisions.push(result.decision);
      evidence.push(...result.evidence);
      moduleUsage.push({ module_id: mainState.modulePlan.modules[index].id, ...result.usage });
    }
    for (let reviewRound = 0; ; reviewRound++) {
      const audit = currentAudit(),
        compactResults = compactModuleResults(
          mainState.modulePlan,
          moduleDecisions,
          seed,
          evidence,
        );
      mainState.routeReview = undefined;
      mainState.reviewRoundSubmissionAttempts = 0;
      mainToolState.accepted = false;
      mainSession.setActiveToolsByName([submitReview.name]);
      const reviewInput = {
        task: 'review_expanded_route',
        module_plan: mainState.modulePlan,
        module_results: compactResults,
        deterministic_audit: audit,
        revision_policy: {
          current_round: reviewRound,
          max_rounds: request.limits.max_revision_rounds,
          remaining_rounds: Math.max(0, request.limits.max_revision_rounds - reviewRound),
          submit_tool: submitReview.name,
        },
      };
      await promptForSubmission(mainSession, reviewInput, {
        submitted: () => Boolean(mainState.routeReview),
        submitTool: submitReview.name,
        task: reviewInput.task,
      });
      if (!mainState.routeReview) {
        const error = new Error('主规划 Agent 未提交模块展开复核结果');
        error.code = 'ROUTE_REVIEW_FAILED';
        error.details = {
          validation: mainState.lastRouteReviewReport,
          last_response: submissionDiagnostic(mainSession),
          module_results: compactResults,
          audit,
        };
        throw error;
      }
      reviewHistory.push({
        round: reviewRound,
        submission_attempts: mainState.reviewRoundSubmissionAttempts,
        decision: structuredClone(mainState.routeReview),
        audit,
      });
      if (mainState.routeReview.status === 'accept') break;
      if (reviewRound >= request.limits.max_revision_rounds) {
        const error = new Error(`模块定向修订已达到 ${request.limits.max_revision_rounds} 轮上限`);
        error.code = 'ROUTE_REVISION_LIMIT_EXCEEDED';
        error.details = { review: mainState.routeReview, audit, history: reviewHistory };
        throw error;
      }
      const orderedRevisions = [...mainState.routeReview.revisions].sort(
        (left, right) =>
          mainState.modulePlan.modules.findIndex((module) => module.id === left.module_id) -
          mainState.modulePlan.modules.findIndex((module) => module.id === right.module_id),
      );
      for (const revision of orderedRevisions) {
        signal.throwIfAborted?.();
        const index = mainState.modulePlan.modules.findIndex(
            (module) => module.id === revision.module_id,
          ),
          previousDecision = moduleDecisions[index];
        const revisedModuleIds = new Set(
          mainState.routeReview.revisions.map((item) => item.module_id),
        );
        const fixedDecisions = moduleDecisions.flatMap((decision, decisionIndex) =>
          revisedModuleIds.has(mainState.modulePlan.modules[decisionIndex].id)
            ? []
            : [{ module_id: mainState.modulePlan.modules[decisionIndex].id, decision }],
        );
        for (const completed of orderedRevisions) {
          const completedIndex = mainState.modulePlan.modules.findIndex(
            (module) => module.id === completed.module_id,
          );
          if (completedIndex < index)
            fixedDecisions.push({
              module_id: completed.module_id,
              decision: moduleDecisions[completedIndex],
            });
        }
        const result = await runModuleAgent({
          module: mainState.modulePlan.modules[index],
          moduleIndex: index,
          modulePlan: mainState.modulePlan,
          fixedDecisions,
          previousDecision,
          revision,
          revisionRound: reviewRound + 1,
          releasedCandidateIds: revision.candidate_hints ?? [],
          snapshot,
          request,
          seed,
          graph: codeGraph,
          selectedModel,
          runtime,
          dataDir,
          signal,
          emit,
          globalUsage,
          routeToolRuntime,
          prompt: modulePrompt,
        });
        moduleDecisions[index] = result.decision;
        evidence.push(...result.evidence);
        moduleUsage.push({
          module_id: revision.module_id,
          revision_round: reviewRound + 1,
          ...result.usage,
        });
      }
    }
    const compactResults = compactModuleResults(
      mainState.modulePlan,
      moduleDecisions,
      seed,
      evidence,
    );
    mainToolState.accepted = false;
    mainSession.setActiveToolsByName([submitAssembly.name]);
    const assemblyInput = {
      task: 'assemble_route',
      module_plan: mainState.modulePlan,
      module_results: compactResults,
      route_review: reviewHistory.at(-1),
      submit_tool: submitAssembly.name,
    };
    await promptForSubmission(mainSession, assemblyInput, {
      submitted: () => Boolean(mainState.plan),
      submitTool: submitAssembly.name,
      task: assemblyInput.task,
    });
    if (!mainState.plan) {
      const error = new Error('主规划 Agent 未确认可锁定的分层路线');
      error.code = 'ROUTE_ASSEMBLY_FAILED';
      error.details = {
        decision: mainState.lastAssemblyDecision,
        validation: mainState.lastAssemblyReport,
        last_response: submissionDiagnostic(mainSession),
        module_results: compactResults,
      };
      throw error;
    }
    return {
      plan: mainState.plan,
      module_plan: mainState.modulePlan,
      module_decisions: moduleDecisions,
      route_reviews: reviewHistory,
      assembly_decision: mainState.assemblyDecision,
      evidence,
      planning_seed: seed,
      usage: {
        global: globalUsage,
        main: {
          ...mainBudget,
          moduleSubmissionAttempts: mainState.moduleSubmissionAttempts,
          reviewSubmissionAttempts: mainState.reviewSubmissionAttempts,
          assemblySubmissionAttempts: mainState.assemblySubmissionAttempts,
        },
        modules: moduleUsage,
      },
    };
  } finally {
    mainController.dispose();
    if (routeToolRuntime.disposeSession) await routeToolRuntime.disposeSession(mainSession);
    else mainSession.dispose();
  }
}
