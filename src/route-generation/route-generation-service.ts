import { createHash } from 'node:crypto';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createPiAutonomousStageRunner } from './autonomous-agent.ts';
import { planAutonomousRoute } from './autonomous-workflow.ts';
import { publishRouteDelivery } from './delivery-publisher.ts';
import { createPiExplanationModuleRunner } from './explanation-agent.ts';
import { explainLockedRoute } from './explanation-workflow.ts';
import { ensureDekkoMap } from '../dekko-map.ts';
import { loadDekkoPlanningInput } from './input.ts';
import { validationFailureDetails } from '../validation-feedback.ts';
import { SourceRelationWorkflow } from './source-relation-workflow.ts';
import { RECOVERY_LIMITS, runWithRecovery } from '../recovery-controller.ts';
import { runSemanticRouteGenerationService } from './semantic-route-generation-service.ts';

const CHECKPOINT_KIND = 'autonomous-route-generation';
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const safeError = (error) =>
  String(error?.message ?? error)
    .replace(/(?:sk-|Bearer\s+)[A-Za-z0-9_.-]+/g, '[redacted]')
    .slice(0, 800);

const taskStatus = (phase) =>
  ({
    planning: 'investigating',
    researching: 'investigating',
    reviewing: 'investigating',
    explaining: 'explaining',
    publishing: 'finalizing',
  })[phase];

function findTask(store, id) {
  return store.list('task').find((task) => task.id === id);
}

function initialCheckpoint({ workspaceId, routeId, snapshot, request }) {
  return {
    kind: CHECKPOINT_KIND,
    version: 1,
    workspace_id: workspaceId,
    route_id: routeId,
    snapshot_id: snapshot.id,
    request_id: request.request_id,
    request_digest: digest(request),
    planning_stages: [],
    explanation_modules: [],
    explanation_source_manifest: [],
    explanation_input_manifest: [],
    validation_attempts: [],
    recovery_attempts: [],
  };
}

function loadCheckpoint(task, binding) {
  const checkpoint = task?.checkpoint;
  if (!checkpoint) return initialCheckpoint(binding);
  if (checkpoint.kind !== CHECKPOINT_KIND || checkpoint.version !== 1)
    throw new Error('路线生成 checkpoint 格式无效');
  const expected = initialCheckpoint(binding);
  for (const key of ['workspace_id', 'route_id', 'snapshot_id', 'request_id', 'request_digest']) {
    if (checkpoint[key] !== expected[key])
      throw new Error(`路线生成 checkpoint 的 ${key} 与当前请求不一致`);
  }
  checkpoint.validation_attempts ??= [];
  checkpoint.recovery_attempts ??= [];
  if (
    !Array.isArray(checkpoint.planning_stages) ||
    !Array.isArray(checkpoint.explanation_modules) ||
    !Array.isArray(checkpoint.explanation_source_manifest) ||
    !Array.isArray(checkpoint.explanation_input_manifest) ||
    !Array.isArray(checkpoint.validation_attempts) ||
    !Array.isArray(checkpoint.recovery_attempts)
  ) {
    throw new Error('路线生成 checkpoint 缺少阶段结果');
  }
  return structuredClone(checkpoint);
}

function assertRouteResult(routeResult, snapshot, request) {
  if (
    routeResult?.plan?.snapshot_id !== snapshot.id ||
    routeResult.plan.request_id !== request.request_id ||
    !Array.isArray(routeResult.plan.modules) ||
    !Array.isArray(routeResult.plan.relations)
  ) {
    throw new Error('checkpoint 中的锁定路线与当前请求不一致');
  }
}

function phaseForStage(kind) {
  if (kind === 'module') return 'researching';
  if (kind === 'review') return 'reviewing';
  return 'planning';
}

function assertSourceGraph(graph, snapshot) {
  if (!graph || !Array.isArray(graph.files) || !Array.isArray(graph.entities))
    throw new Error('CODE_GRAPH_INVALID: Dekko 代码图缺少文件或符号索引');
  if (graph.snapshot_id && graph.snapshot_id !== snapshot.id)
    throw new Error('CODE_GRAPH_SNAPSHOT_MISMATCH: Dekko 代码图不属于当前源码快照');
  return graph;
}

export async function prepareRouteSourceGraph({
  snapshot,
  signal,
  ensureMap = ensureDekkoMap,
  loadInput = loadDekkoPlanningInput,
}) {
  try {
    signal?.throwIfAborted();
    const codeMap = await ensureMap({ root: snapshot.root, signal });
    const input = await loadInput({ map_path: codeMap.path, snapshot });
    return {
      graph: assertSourceGraph(input.graph, snapshot),
      code_map: input.code_map,
    };
  } catch (error) {
    signal?.throwIfAborted();
    if (String(error?.message ?? error).startsWith('CODE_GRAPH_')) throw error;
    throw new Error(
      `CODE_GRAPH_UNAVAILABLE: 无法为当前源码快照准备 Dekko 代码图：${error.message}`,
      {
        cause: error,
      },
    );
  }
}

/**
 * Runs planning, explanation and publication as one resumable application job.
 * Every accepted Agent submission is revalidated before a retry reuses it.
 */
export async function runRouteGenerationService({
  store,
  workspace_id,
  snapshot,
  request,
  sourceGraph,
  model,
  dataDir,
  modelRuntime,
  task_id = request.request_id,
  route_id = request.request_id,
  signal = new AbortController().signal,
  emit = () => {},
  runStage,
  runExplanationModule,
  relationWorkflow,
  retryAgentFailures = true,
  prepareSourceGraph = prepareRouteSourceGraph,
  workflows = {},
  semanticWorkflows = {},
}) {
  if (!store?.put || !store?.list) throw new Error('路线生成服务需要可持久化 task 的 Store');
  if (!workspace_id) throw new Error('路线生成服务缺少 workspace_id');
  if (snapshot?.id !== request?.snapshot_id) throw new Error('路线请求与源码快照不一致');
  if ((!runStage || !runExplanationModule) && (!model || !dataDir)) {
    throw new Error('创建真实 Agent runner 时必须提供 model 和 dataDir');
  }
  signal.throwIfAborted();

  if (!sourceGraph) ({ graph: sourceGraph } = await prepareSourceGraph({ snapshot, signal }));
  else assertSourceGraph(sourceGraph, snapshot);

  const taskBeforeDispatch = findTask(store, task_id),
    semanticCheckpoint = taskBeforeDispatch?.checkpoint?.kind === 'semantic-route-generation',
    legacyCheckpoint = taskBeforeDispatch?.checkpoint?.kind === CHECKPOINT_KIND,
    productionInvocation =
      !runStage &&
      !runExplanationModule &&
      !relationWorkflow &&
      Object.keys(workflows).length === 0;
  if ((productionInvocation && !legacyCheckpoint) || semanticCheckpoint)
    return runSemanticRouteGenerationService({
      store,
      workspace_id,
      snapshot,
      request,
      sourceGraph,
      model,
      dataDir,
      modelRuntime,
      task_id,
      route_id,
      signal,
      emit,
      ...semanticWorkflows,
    });

  const existingTask = findTask(store, task_id);
  if (existingTask && existingTask.kind !== 'route-generation')
    throw new Error('task_id 已被其他任务占用');
  if (['investigating', 'explaining', 'finalizing'].includes(existingTask?.status))
    throw new Error('路线生成任务正在运行');
  const binding = { workspaceId: workspace_id, routeId: route_id, snapshot, request };
  let checkpoint = loadCheckpoint(existingTask, binding);
  let task = existingTask ?? {
    schemaVersion: 1,
    id: task_id,
    kind: 'route-generation',
    ownerId: route_id,
    workspaceId: workspace_id,
    snapshotId: snapshot.id,
    requestId: request.request_id,
    request: structuredClone(request),
    model,
    createdAt: Date.now(),
  };
  let phase;

  const persist = (nextPhase = phase) => {
    phase = nextPhase;
    task = {
      ...task,
      model,
      phase,
      status: taskStatus(phase),
      checkpoint: structuredClone(checkpoint),
      error: undefined,
      finishedAt: undefined,
      updatedAt: Date.now(),
    };
    store.put('task', task);
    emit('checkpoint', {
      task_id,
      phase,
      planning_stages: checkpoint.planning_stages.length,
      explanation_modules: checkpoint.explanation_modules.length,
      route_locked: Boolean(checkpoint.route_result),
      published: Boolean(checkpoint.publication),
    });
  };
  const setPhase = (nextPhase) => {
    signal.throwIfAborted();
    if (phase !== nextPhase) {
      persist(nextPhase);
      emit('phase', { task_id, phase: nextPhase, status: taskStatus(nextPhase) });
    }
  };

  try {
    let sharedRuntime = modelRuntime;
    let planningRunner = runStage,
      explanationRunner = runExplanationModule;
    const activeRelationWorkflow =
      relationWorkflow ??
      (!runStage ? new SourceRelationWorkflow({ store, snapshot, sourceGraph }) : undefined);
    const runtime = async () => (sharedRuntime ??= await ModelRuntime.create());
    const retryAgentStage = async (kind, details, action) => {
      const maxAttempts =
        kind === 'explanation'
          ? RECOVERY_LIMITS.explanation_module
          : RECOVERY_LIMITS.planning_stage;
      return runWithRecovery({
        scope: kind,
        details,
        maxAttempts,
        action,
        shouldRetry: () => !signal.aborted,
        onFailure: (record, error) => {
          if (signal.aborted) return;
          checkpoint.recovery_attempts.push(record);
          checkpoint.validation_attempts.push({
            kind,
            ...details,
            attempt: record.attempt,
            code: record.code,
            message: record.message,
            issues: record.issues,
            ...(record.decision !== undefined ? { decision: record.decision } : {}),
            ...(record.submissions !== undefined ? { submissions: record.submissions } : {}),
            fingerprint: record.fingerprint,
            decision_fingerprint: record.decision_fingerprint,
            strategy: record.strategy,
            repeated: record.repeated,
            created_at: record.created_at,
          });
          persist();
          emit(
            record.attempt < maxAttempts && !signal.aborted ? 'stage_retry' : 'recovery_exhausted',
            {
              task_id,
              kind,
              ...details,
              attempt: record.attempt < maxAttempts ? record.attempt + 1 : record.attempt,
              strategy: record.strategy,
              repeated: record.repeated,
              failure_fingerprint: record.fingerprint,
              reason: safeError(error),
              issues: record.issues,
            },
          );
        },
      });
    };
    const invokePlanning = async (args) => {
      const invoke = async (retryContext) => {
        planningRunner ??= await createPiAutonomousStageRunner({
          snapshot,
          model,
          dataDir,
          modelRuntime: await runtime(),
          signal,
          relationWorkflow: activeRelationWorkflow,
          emit,
        });
        return planningRunner({
          ...args,
          ...(retryContext ? { input: { ...args.input, retry_context: retryContext } } : {}),
        });
      };
      return !retryAgentFailures
        ? invoke()
        : retryAgentStage(
            'planning',
            {
              stage: args.kind,
              ...(args.module_id ? { module_id: args.module_id } : {}),
            },
            invoke,
          );
    };
    const invokeExplanation = async (args) => {
      const invoke = async (retryContext) => {
        explanationRunner ??= await createPiExplanationModuleRunner({
          snapshot,
          model,
          dataDir,
          modelRuntime: await runtime(),
          signal,
          emit,
        });
        return explanationRunner({
          ...args,
          ...(retryContext ? { input: { ...args.input, retry_context: retryContext } } : {}),
        });
      };
      return !retryAgentFailures
        ? invoke()
        : retryAgentStage(
            'explanation',
            {
              module_id: args.input?.current_module?.module_id,
            },
            invoke,
          );
    };
    const planRoute = workflows.planRoute ?? planAutonomousRoute;
    const explainRoute = workflows.explainRoute ?? explainLockedRoute;
    const publishRoute = workflows.publishRoute ?? publishRouteDelivery;

    let routeResult = checkpoint.route_result;
    if (routeResult) assertRouteResult(routeResult, snapshot, request);
    else {
      let routeRecoveryContext;
      const checkpointedStage = async (args) => {
        setPhase(phaseForStage(args.kind));
        const stageArgs = routeRecoveryContext
          ? {
              ...args,
              input: {
                ...args.input,
                route_recovery_context: routeRecoveryContext,
              },
            }
          : args;
        const key = digest({
          kind: stageArgs.kind,
          module_id: stageArgs.module_id ?? null,
          input: stageArgs.input,
        });
        const cached = checkpoint.planning_stages.find((stage) => stage.key === key);
        if (cached) {
          const issues = await stageArgs.validate(structuredClone(cached.result));
          if (!issues.length) {
            emit('stage_reused', {
              task_id,
              kind: stageArgs.kind,
              module_id: stageArgs.module_id,
              key,
            });
            return structuredClone(cached.result);
          }
          checkpoint.planning_stages = checkpoint.planning_stages.filter(
            (stage) => stage.key !== key,
          );
          persist();
        }
        const result = await invokePlanning(stageArgs);
        const issues = await stageArgs.validate(structuredClone(result));
        if (issues.length)
          throw new Error(
            `已接受的路线阶段结果重新校验失败：${JSON.stringify(issues.slice(0, 8))}`,
          );
        checkpoint.planning_stages.push({
          key,
          kind: stageArgs.kind,
          ...(stageArgs.module_id ? { module_id: stageArgs.module_id } : {}),
          result: structuredClone(result),
        });
        persist();
        return result;
      };
      setPhase('planning');
      const planOnce = async (recoveryContext) => {
        if (recoveryContext) {
          routeRecoveryContext = {
            ...recoveryContext,
            strategy: 'replan_route',
            instruction:
              '局部阶段恢复已经耗尽。重新规划整条路线，不复用被拒绝的模块划分或关系；只保留通过确定性检查的源码事实。',
          };
          checkpoint.planning_stages = [];
          persist('planning');
        }
        return planRoute({
          snapshot,
          request,
          runStage: checkpointedStage,
          sourceGraph,
          relationWorkflow: activeRelationWorkflow,
          emit,
        });
      };
      routeResult = !retryAgentFailures
        ? await planOnce()
        : await runWithRecovery({
            scope: 'route_plan',
            details: { request_id: request.request_id },
            maxAttempts: RECOVERY_LIMITS.route_plan,
            action: planOnce,
            shouldRetry: () => !signal.aborted,
            onFailure: (record, error) => {
              if (signal.aborted) return;
              checkpoint.recovery_attempts.push(record);
              persist();
              emit(
                record.attempt < RECOVERY_LIMITS.route_plan && !signal.aborted
                  ? 'recovery_escalated'
                  : 'recovery_exhausted',
                {
                  task_id,
                  scope: 'route_plan',
                  strategy:
                    record.attempt < RECOVERY_LIMITS.route_plan ? 'replan_route' : record.strategy,
                  attempt:
                    record.attempt < RECOVERY_LIMITS.route_plan
                      ? record.attempt + 1
                      : record.attempt,
                  repeated: record.repeated,
                  failure_fingerprint: record.fingerprint,
                  reason: safeError(error),
                  issues: record.issues,
                },
              );
            },
          });
      assertRouteResult(routeResult, snapshot, request);
      checkpoint.route_result = structuredClone(routeResult);
      persist('reviewing');
    }

    setPhase('explaining');
    const explanation = await explainRoute({
      snapshot,
      plan: routeResult.plan,
      runModule: invokeExplanation,
      previousModules: checkpoint.explanation_modules,
      previousInputManifest: checkpoint.explanation_input_manifest,
      onModuleComplete: async (result, { input, input_digest }) => {
        const index = checkpoint.explanation_modules.findIndex(
          (item) => item.module_id === result.module_id,
        );
        if (index < 0) checkpoint.explanation_modules.push(result);
        else checkpoint.explanation_modules[index] = result;
        const manifest = new Map(
          checkpoint.explanation_source_manifest.map((item) => [item.block_id, item]),
        );
        for (const block of input.current_module.blocks)
          manifest.set(block.block_id, {
            module_id: input.current_module.module_id,
            block_id: block.block_id,
            content_digest: block.content_digest,
          });
        checkpoint.explanation_source_manifest = routeResult.plan.modules.flatMap((module) =>
          module.blocks.map((block) => manifest.get(block.id)).filter(Boolean),
        );
        const inputManifest = new Map(
          checkpoint.explanation_input_manifest.map((item) => [item.module_id, item]),
        );
        inputManifest.set(input.current_module.module_id, {
          module_id: input.current_module.module_id,
          input_digest,
        });
        checkpoint.explanation_input_manifest = routeResult.plan.modules
          .map((module) => inputManifest.get(module.id))
          .filter(Boolean);
        persist('explaining');
      },
    });
    checkpoint.explanation = structuredClone(explanation);
    persist('explaining');
    if (explanation.status === 'route_issue') {
      task = {
        ...task,
        phase: 'explaining',
        status: 'route_issue',
        checkpoint: structuredClone(checkpoint),
        recoveryAttempts: checkpoint.recovery_attempts.length,
        finishedAt: Date.now(),
        updatedAt: Date.now(),
      };
      store.put('task', task);
      emit('route_issue', { task_id, issues: explanation.issues });
      return { status: 'route_issue', task, route_result: routeResult, explanation };
    }

    setPhase('publishing');
    const publication = await publishRoute({
      store,
      workspace_id,
      snapshot,
      plan: routeResult.plan,
      explanation,
      route_id,
    });
    checkpoint.publication = {
      route_id: publication.route.id,
      revision_id: publication.route.revision_id,
    };
    task = {
      ...task,
      phase: 'complete',
      status: 'complete',
      checkpoint: structuredClone(checkpoint),
      routeId: publication.route.id,
      routeRevisionId: publication.route.revision_id,
      recoveryAttempts: checkpoint.recovery_attempts.length,
      error: undefined,
      validationIssues: undefined,
      failureKind: undefined,
      finishedAt: Date.now(),
      updatedAt: Date.now(),
    };
    store.put('task', task);
    emit('complete', {
      task_id,
      route_id: publication.route.id,
      revision_id: publication.route.revision_id,
      published: publication.published,
    });
    return { status: 'complete', task, route_result: routeResult, explanation, publication };
  } catch (error) {
    const cancelled = signal.aborted,
      cause = signal.reason ?? error,
      latestRecovery = cause?.recovery,
      failure = latestRecovery ?? validationFailureDetails(cause);
    task = {
      ...task,
      phase: phase ?? 'planning',
      status: cancelled ? 'cancelled' : 'failed',
      checkpoint: structuredClone(checkpoint),
      error: safeError(cause),
      validationIssues: failure.issues,
      validationAttempts: checkpoint.validation_attempts.length,
      recoveryAttempts: checkpoint.recovery_attempts.length,
      failureKind: latestRecovery?.external ? 'external' : 'generation',
      finishedAt: Date.now(),
      updatedAt: Date.now(),
    };
    store.put('task', task);
    emit('failure', {
      task_id,
      phase: task.phase,
      status: task.status,
      error: task.error,
      issues: task.validationIssues,
      validation_attempts: task.validationAttempts,
      recovery_attempts: task.recoveryAttempts,
      failure_kind: task.failureKind,
    });
    throw error;
  }
}
