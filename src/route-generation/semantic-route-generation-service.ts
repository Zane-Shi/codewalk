import { createHash } from 'node:crypto';
import { validationFailureDetails } from '../validation-feedback.ts';
import { recoveryFailure } from '../recovery-controller.ts';
import { SourceUnitService } from './source-units.ts';
import { SemanticRouteDraftService } from './semantic-route-drafts.ts';
import { SemanticRouteReviewService } from './semantic-route-review.ts';
import { createPiSemanticRouteRunners } from './semantic-route-agent.ts';
import { publishSemanticRouteDelivery } from './semantic-route-delivery.ts';

const CHECKPOINT_KIND = 'semantic-route-generation';
const CHECKPOINT_VERSION = 1;
export const SEMANTIC_ROUTE_RECOVERY_LIMITS = Object.freeze({
  creator_attempts: 3,
  reviewer_attempts_per_draft: 2,
  total_agent_invocations: 8,
});

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const safeError = (error) =>
  String(error?.message ?? error)
    .replace(/(?:sk-|Bearer\s+)[A-Za-z0-9_.-]+/g, '[redacted]')
    .slice(0, 800);

function findRecord(store, kind, id) {
  return store.list(kind).find((item) => item.id === id);
}

function initialCheckpoint({ workspace_id, route_id, snapshot, request }) {
  return {
    kind: CHECKPOINT_KIND,
    version: CHECKPOINT_VERSION,
    workspace_id,
    route_id,
    snapshot_id: snapshot.id,
    request_id: request.request_id,
    request_digest: digest(request),
    draft_ids: [],
    review_ids: [],
    creator_attempts: 0,
    reviewer_attempts: [],
    agent_invocations: 0,
    recovery_attempts: [],
    review_history: [],
  };
}

function loadCheckpoint(task, binding) {
  const expected = initialCheckpoint(binding),
    checkpoint = task?.checkpoint;
  if (!checkpoint) return expected;
  if (checkpoint.kind !== CHECKPOINT_KIND || checkpoint.version !== CHECKPOINT_VERSION)
    throw new Error('语义路线 checkpoint 格式无效');
  for (const key of ['workspace_id', 'route_id', 'snapshot_id', 'request_id', 'request_digest'])
    if (checkpoint[key] !== expected[key])
      throw new Error(`语义路线 checkpoint 的 ${key} 与当前请求不一致`);
  for (const key of [
    'draft_ids',
    'review_ids',
    'reviewer_attempts',
    'recovery_attempts',
    'review_history',
  ])
    if (!Array.isArray(checkpoint[key])) throw new Error(`语义路线 checkpoint 缺少 ${key}`);
  return structuredClone(checkpoint);
}

function reviewFingerprint(review, draft) {
  const unitByStep = new Map(
    draft.modules.flatMap((module) =>
      module.steps.map((step) => [step.id, { module_id: module.id, unit_id: step.unit_id }]),
    ),
  );
  return digest(
    review.issues.map((issue) => ({
      target: issue.target,
      module_id: issue.module_id,
      unit_id: issue.step_id ? unitByStep.get(issue.step_id)?.unit_id : undefined,
      category: issue.category,
      problem: issue.problem,
      required_change: issue.required_change,
    })),
  );
}

function reviewerAttempts(checkpoint, draftId) {
  return checkpoint.reviewer_attempts.find((item) => item.draft_id === draftId)?.attempts ?? 0;
}

function incrementReviewerAttempts(checkpoint, draftId) {
  let record = checkpoint.reviewer_attempts.find((item) => item.draft_id === draftId);
  if (!record) {
    record = { draft_id: draftId, attempts: 0 };
    checkpoint.reviewer_attempts.push(record);
  }
  record.attempts++;
  return record.attempts;
}

function recoveryContext(record) {
  return {
    strategy: record.strategy,
    repeated_failure: record.repeated,
    failure_fingerprint: record.fingerprint,
    validation_issues: record.issues,
    previous_failed_decision: record.decision,
    instruction:
      record.strategy === 'rebuild_scope'
        ? '相同失败已经重复。重新调查并替换导致失败的源码选择或结构，禁止原样重交。'
        : '使用新的上下文修复本次具体失败，只复用已经确认的源码事实。',
  };
}

function reviewRecoveryContext(review, draft, repeated) {
  return {
    strategy: repeated ? 'rebuild_route' : 'targeted_revision',
    repeated_failure: repeated,
    review_id: review.id,
    review_fingerprint: reviewFingerprint(review, draft),
    issues: structuredClone(review.issues),
    instruction: repeated
      ? '独立审核连续指出相同问题。不要微调原解释；重新调查受影响模块并替换源码选择、顺序或路线范围。'
      : '保留审核未指出问题的部分，按每项 required_change 精确修订受影响模块或步骤。',
  };
}

function mostRecentPersistedDraft(store, requestId, knownIds) {
  return store
    .list('semantic_route_draft')
    .filter((item) => item.request_id === requestId && !knownIds.includes(item.id))
    .sort((left, right) => right.created_at - left.created_at)[0];
}

export async function runSemanticRouteGenerationService({
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
  runCreator,
  runReviewer,
  publishRoute = publishSemanticRouteDelivery,
  createRunners = createPiSemanticRouteRunners,
}) {
  if (!store?.put || !store?.list) throw new Error('语义路线生成服务需要 Store');
  if (!store?.db?.exec) throw new Error('语义路线生成服务需要支持事务的 Store');
  if (!workspace_id) throw new Error('语义路线生成服务缺少 workspace_id');
  if (snapshot?.id !== request?.snapshot_id) throw new Error('路线请求与源码快照不一致');
  if (!sourceGraph || sourceGraph.snapshot_id !== snapshot.id)
    throw new Error('语义路线生成服务需要当前 Snapshot 的代码图');
  if ((!runCreator || !runReviewer) && (!model || !dataDir))
    throw new Error('创建真实语义路线 Agent 时必须提供 model 和 dataDir');
  signal.throwIfAborted();

  const existingTask = findRecord(store, 'task', task_id);
  if (existingTask && existingTask.kind !== 'route-generation')
    throw new Error('task_id 已被其他任务占用');
  if (['investigating', 'reviewing', 'finalizing'].includes(existingTask?.status))
    throw new Error('路线生成任务正在运行');
  const binding = { workspace_id, route_id, snapshot, request };
  let checkpoint = loadCheckpoint(existingTask, binding),
    task = existingTask ?? {
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
    },
    phase = 'planning';
  const persist = (nextPhase = phase) => {
    phase = nextPhase;
    task = {
      ...task,
      model,
      phase,
      status: phase === 'publishing' ? 'finalizing' : 'investigating',
      checkpoint: structuredClone(checkpoint),
      error: undefined,
      finishedAt: undefined,
      updatedAt: Date.now(),
    };
    store.put('task', task);
    emit('checkpoint', {
      task_id,
      phase,
      drafts: checkpoint.draft_ids.length,
      reviews: checkpoint.review_ids.length,
      agent_invocations: checkpoint.agent_invocations,
      published: Boolean(checkpoint.publication),
    });
  };
  const setPhase = (nextPhase) => {
    signal.throwIfAborted();
    if (phase !== nextPhase) {
      persist(nextPhase);
      emit('phase', { task_id, phase: nextPhase, status: task.status });
    }
  };
  const sourceUnitService = new SourceUnitService({ store, snapshot, sourceGraph }),
    draftService = new SemanticRouteDraftService({ store, snapshot, sourceUnitService }),
    reviewService = new SemanticRouteReviewService({ store, snapshot, draftService });
  if (!runCreator || !runReviewer) {
    const runners = await createRunners({
      store,
      snapshot,
      sourceGraph,
      model,
      dataDir,
      modelRuntime,
      sourceUnitService,
      draftService,
      reviewService,
      signal,
      emit,
    });
    runCreator ??= runners.runCreator;
    runReviewer ??= runners.runReviewer;
  }

  let latestDraft = checkpoint.draft_ids.length
      ? draftService.get(checkpoint.draft_ids.at(-1))
      : undefined,
    latestReview = latestDraft
      ? (() => {
          try {
            return reviewService.get(latestDraft.id);
          } catch {
            return undefined;
          }
        })()
      : undefined,
    creatorRecovery,
    reviewerRecovery,
    terminalError;

  const recordFailure = (scope, details, error) => {
    const failure = recoveryFailure(error, { scope, details }),
      previous = [...checkpoint.recovery_attempts].reverse().find((item) => item.scope === scope),
      repeated = Boolean(
        previous &&
        previous.fingerprint === failure.fingerprint &&
        previous.decision_fingerprint === failure.decision_fingerprint,
      ),
      record = {
        scope,
        ...details,
        attempt: checkpoint.recovery_attempts.filter((item) => item.scope === scope).length + 1,
        strategy: repeated ? 'rebuild_scope' : 'fresh_context',
        repeated,
        ...failure,
        created_at: Date.now(),
      };
    checkpoint.recovery_attempts.push(record);
    terminalError = error;
    persist();
    emit('stage_retry', {
      task_id,
      scope,
      strategy: record.strategy,
      repeated,
      reason: safeError(error),
      issues: record.issues,
    });
    return recoveryContext(record);
  };

  try {
    persist('planning');
    while (checkpoint.agent_invocations < SEMANTIC_ROUTE_RECOVERY_LIMITS.total_agent_invocations) {
      signal.throwIfAborted();
      if (!latestDraft || latestReview?.status === 'revision_required') {
        if (checkpoint.creator_attempts >= SEMANTIC_ROUTE_RECOVERY_LIMITS.creator_attempts) break;
        setPhase('planning');
        checkpoint.creator_attempts++;
        checkpoint.agent_invocations++;
        persist();
        try {
          const previousReview = latestReview,
            candidate = await runCreator({
              request,
              previous_draft: latestDraft,
              previous_review: previousReview,
              recovery_context:
                previousReview?.status === 'revision_required'
                  ? reviewRecoveryContext(
                      previousReview,
                      latestDraft,
                      checkpoint.review_history.at(-1)?.repeated ?? false,
                    )
                  : creatorRecovery,
              services: { sourceUnitService, draftService },
            });
          latestDraft = draftService.get(candidate.id);
          latestReview = undefined;
          checkpoint.draft_ids.push(latestDraft.id);
          creatorRecovery = undefined;
          persist('reviewing');
          emit('module', {
            task_id,
            status: 'drafted',
            draft_id: latestDraft.id,
            modules: latestDraft.modules.length,
          });
        } catch (error) {
          const persisted = mostRecentPersistedDraft(
            store,
            request.request_id,
            checkpoint.draft_ids,
          );
          if (persisted) {
            latestDraft = draftService.get(persisted.id);
            latestReview = undefined;
            checkpoint.draft_ids.push(latestDraft.id);
            persist('reviewing');
            continue;
          }
          creatorRecovery = recordFailure(
            'semantic_creator',
            { request_id: request.request_id },
            error,
          );
          continue;
        }
      }

      if (latestReview?.status === 'accepted') break;
      if (
        reviewerAttempts(checkpoint, latestDraft.id) >=
        SEMANTIC_ROUTE_RECOVERY_LIMITS.reviewer_attempts_per_draft
      )
        break;
      setPhase('reviewing');
      incrementReviewerAttempts(checkpoint, latestDraft.id);
      checkpoint.agent_invocations++;
      persist();
      try {
        const candidate = await runReviewer({
          draft: latestDraft,
          recovery_context: reviewerRecovery,
          services: { reviewService },
        });
        latestReview = reviewService.get(candidate.draft_id);
        checkpoint.review_ids.push(latestReview.id);
        reviewerRecovery = undefined;
        if (latestReview.status === 'revision_required') {
          const fingerprint = reviewFingerprint(latestReview, latestDraft),
            previous = checkpoint.review_history.at(-1),
            repeated = previous?.fingerprint === fingerprint;
          checkpoint.review_history.push({
            draft_id: latestDraft.id,
            review_id: latestReview.id,
            fingerprint,
            repeated,
            issue_targets: latestReview.issues.map((issue) => ({
              target: issue.target,
              module_id: issue.module_id,
              step_id: issue.step_id,
              category: issue.category,
            })),
          });
          persist('planning');
          emit('review', {
            task_id,
            status: 'revision_required',
            review_id: latestReview.id,
            repeated,
            issues: latestReview.issues,
          });
          continue;
        }
        persist('publishing');
        emit('review', { task_id, status: 'accepted', review_id: latestReview.id });
        break;
      } catch (error) {
        try {
          latestReview = reviewService.get(latestDraft.id);
          if (!checkpoint.review_ids.includes(latestReview.id))
            checkpoint.review_ids.push(latestReview.id);
          persist(latestReview.status === 'accepted' ? 'publishing' : 'planning');
          continue;
        } catch {}
        reviewerRecovery = recordFailure('semantic_reviewer', { draft_id: latestDraft.id }, error);
      }
    }

    if (!latestDraft) throw terminalError ?? new Error('Agent 未能生成任何可保存的语义路线草稿');
    const accepted = latestReview?.status === 'accepted';
    setPhase('publishing');
    const publication = await publishRoute({
      store,
      workspace_id,
      snapshot,
      draft: latestDraft,
      review: latestReview,
      route_id,
      partial_reason: accepted
        ? undefined
        : latestReview?.summary || safeError(terminalError ?? '自动语义审核未能闭合'),
    });
    checkpoint.publication = {
      route_id: publication.route.id,
      revision_id: publication.route.revision_id,
      status: publication.route.status,
    };
    task = {
      ...task,
      phase: 'complete',
      status: accepted ? 'complete' : 'partial',
      checkpoint: structuredClone(checkpoint),
      routeId: publication.route.id,
      routeRevisionId: publication.route.revision_id,
      recoveryAttempts: checkpoint.recovery_attempts.length,
      error: accepted ? undefined : publication.route.quality?.summary,
      validationIssues:
        latestReview?.issues ??
        (terminalError ? validationFailureDetails(terminalError).issues : []),
      failureKind: accepted ? undefined : 'generation',
      finishedAt: Date.now(),
      updatedAt: Date.now(),
    };
    store.put('task', task);
    const event = accepted ? 'complete' : 'partial';
    emit(event, {
      task_id,
      route_id: publication.route.id,
      revision_id: publication.route.revision_id,
      published: publication.published,
      ...(accepted ? {} : { issues: publication.route.quality?.issues ?? [] }),
    });
    return {
      status: accepted ? 'complete' : 'partial',
      task,
      draft: latestDraft,
      review: latestReview,
      publication,
    };
  } catch (error) {
    const cancelled = signal.aborted,
      cause = signal.reason ?? error,
      failure = validationFailureDetails(cause);
    task = {
      ...task,
      phase,
      status: cancelled ? 'cancelled' : 'failed',
      checkpoint: structuredClone(checkpoint),
      error: safeError(cause),
      validationIssues: failure.issues,
      recoveryAttempts: checkpoint.recovery_attempts.length,
      failureKind: 'generation',
      finishedAt: Date.now(),
      updatedAt: Date.now(),
    };
    store.put('task', task);
    emit('failure', { task_id, status: task.status, phase, error: task.error });
    throw cause;
  }
}
