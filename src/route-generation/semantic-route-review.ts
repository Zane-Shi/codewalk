import { createHash, randomUUID } from 'node:crypto';

const REVIEW_KEYS = new Set(['draft_id', 'decision', 'summary', 'issues']);
const ISSUE_KEYS = new Set([
  'target',
  'module_id',
  'step_id',
  'category',
  'problem',
  'required_change',
]);
const DECISIONS = new Set(['accept', 'revise']);
const TARGETS = new Set(['route', 'goal', 'module', 'step']);

export const MAX_SEMANTIC_REVIEW_ISSUES = 64;

const string = (maxLength = 2400) => ({ type: 'string', minLength: 1, maxLength });

export const semanticRouteReviewSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['draft_id', 'decision', 'summary'],
  properties: {
    draft_id: string(200),
    decision: { type: 'string', enum: [...DECISIONS] },
    summary: string(),
    issues: {
      type: 'array',
      maxItems: MAX_SEMANTIC_REVIEW_ISSUES,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['target', 'category', 'problem', 'required_change'],
        properties: {
          target: { type: 'string', enum: [...TARGETS] },
          module_id: string(100),
          step_id: string(300),
          category: string(100),
          problem: string(),
          required_change: string(),
        },
      },
    },
  },
};

export class SemanticRouteReviewError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SemanticRouteReviewError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new SemanticRouteReviewError(code, message, details);
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('INVALID_SEMANTIC_REVIEW_INPUT', `${label} 必须是对象`);
}

function assertKnownKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length)
    fail('UNKNOWN_SEMANTIC_REVIEW_FIELD', `${label} 包含不允许提交的字段：${unknown.join(', ')}`, {
      fields: unknown,
    });
}

function normalizeText(value, label, maxLength = 2400) {
  if (typeof value !== 'string' || !value.trim())
    fail('INVALID_SEMANTIC_REVIEW_INPUT', `${label} 不能为空`);
  if (value.length > maxLength)
    fail('INVALID_SEMANTIC_REVIEW_INPUT', `${label} 不能超过 ${maxLength} 个字符`);
  return value.trim();
}

function record(store, kind, predicate) {
  return store.list(kind).find(predicate);
}

function digest(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function normalizeIssue(value, label, draft) {
  assertObject(value, label);
  assertKnownKeys(value, ISSUE_KEYS, label);
  if (!TARGETS.has(value.target))
    fail(
      'INVALID_SEMANTIC_REVIEW_TARGET',
      `${label}.target 必须定位到 route、goal、module 或 step`,
    );
  const moduleId =
      value.module_id === undefined
        ? undefined
        : normalizeText(value.module_id, `${label}.module_id`, 100),
    stepId =
      value.step_id === undefined
        ? undefined
        : normalizeText(value.step_id, `${label}.step_id`, 300);
  if (['route', 'goal'].includes(value.target) && (moduleId || stepId))
    fail('UNEXPECTED_SEMANTIC_REVIEW_LOCATION', `${value.target} 问题不能携带模块或步骤 ID`);
  if (value.target === 'module' && (!moduleId || stepId))
    fail('INVALID_SEMANTIC_REVIEW_LOCATION', 'module 问题必须且只能引用 module_id');
  if (value.target === 'step' && (!moduleId || !stepId))
    fail('INVALID_SEMANTIC_REVIEW_LOCATION', 'step 问题必须同时引用 module_id 和 step_id');
  const module = moduleId ? draft.modules.find((item) => item.id === moduleId) : undefined;
  if (moduleId && !module)
    fail('SEMANTIC_REVIEW_MODULE_NOT_FOUND', `审核问题引用了不存在的模块：${moduleId}`);
  if (stepId && !module.steps.some((item) => item.id === stepId))
    fail(
      'SEMANTIC_REVIEW_STEP_NOT_FOUND',
      `审核问题引用了不属于模块 ${moduleId} 的步骤：${stepId}`,
    );
  return {
    target: value.target,
    ...(moduleId ? { module_id: moduleId } : {}),
    ...(stepId ? { step_id: stepId } : {}),
    category: normalizeText(value.category, `${label}.category`, 100),
    problem: normalizeText(value.problem, `${label}.problem`),
    required_change: normalizeText(value.required_change, `${label}.required_change`),
  };
}

function normalizeReview(value, draft) {
  assertObject(value, '语义路线审核');
  assertKnownKeys(value, REVIEW_KEYS, '语义路线审核');
  const draftId = normalizeText(value.draft_id, 'draft_id', 200);
  if (draftId !== draft.id)
    fail('SEMANTIC_REVIEW_DRAFT_MISMATCH', `审核工具只接受当前草稿：${draft.id}`);
  if (!DECISIONS.has(value.decision)) fail('INVALID_SEMANTIC_REVIEW_DECISION', '审核决定无效');
  if (value.issues !== undefined && !Array.isArray(value.issues))
    fail('INVALID_SEMANTIC_REVIEW_ISSUES', 'issues 必须是数组');
  const rawIssues = value.issues ?? [];
  if (rawIssues.length > MAX_SEMANTIC_REVIEW_ISSUES)
    fail('TOO_MANY_SEMANTIC_REVIEW_ISSUES', `审核问题不能超过 ${MAX_SEMANTIC_REVIEW_ISSUES} 项`);
  if (value.decision === 'accept' && rawIssues.length)
    fail('ACCEPTED_REVIEW_HAS_ISSUES', 'accept 结论不能同时提交问题');
  if (value.decision === 'revise' && !rawIssues.length)
    fail('REVISION_REQUIRES_ISSUES', 'revise 结论必须给出至少一个精确问题');
  const issues = rawIssues.map((issue, index) => normalizeIssue(issue, `issues[${index}]`, draft));
  return {
    draft_id: draftId,
    decision: value.decision,
    summary: normalizeText(value.summary, 'summary'),
    issues,
  };
}

function reviewCriteria() {
  return [
    {
      name: 'source_support',
      description: '逐项核对 explanation 与 reading_guidance 是否由系统附带的真实源码支持。',
    },
    {
      name: 'source_selection',
      description:
        '判断所选函数或源码范围是否是理解用户目标所需的关键实现，而非无关包装或细枝末节。',
    },
    {
      name: 'reading_order',
      description: '判断模块与步骤顺序是否让用户以较短路径建立正确理解。',
    },
    {
      name: 'teaching_transition',
      description: '核对自然语言衔接是否能解释阅读跳转；不要求存在显式运行时调用。',
    },
    {
      name: 'goal_coverage',
      description: '判断整条路线是否覆盖目标所需的关键数据变化、实现位置和用户可见结果。',
    },
  ];
}

export class SemanticRouteReviewService {
  constructor({
    store,
    snapshot,
    draftService,
    now = () => Date.now(),
    id = () => `semantic-route-review-${randomUUID()}`,
  }) {
    if (!store?.put || !store?.list)
      throw new Error('SemanticRouteReviewService 需要可持久化记录的 Store');
    if (!snapshot?.id) throw new Error('SemanticRouteReviewService 需要有效的源码快照');
    if (!draftService?.get)
      throw new Error('SemanticRouteReviewService 需要 SemanticRouteDraftService');
    if (draftService.snapshot?.id !== snapshot.id)
      throw new Error('SemanticRouteReviewService 与草稿服务必须使用同一源码快照');
    if (draftService.store !== store)
      throw new Error('SemanticRouteReviewService 与草稿服务必须使用同一 Store');
    this.store = store;
    this.snapshot = snapshot;
    this.draftService = draftService;
    this.now = now;
    this.id = id;
  }

  reviewInput(draftId) {
    const draft = this.draftService.get(draftId),
      input = {
        schema_version: '1',
        draft_id: draft.id,
        draft_digest: draft.decision_digest,
        snapshot_id: draft.snapshot_id,
        goal: structuredClone(draft.goal),
        summary: draft.summary,
        criteria: reviewCriteria(),
        modules: structuredClone(draft.modules),
      };
    return { ...input, review_input_digest: digest(input) };
  }

  get(draftId) {
    const review = record(this.store, 'semantic_route_review', (item) => item.draft_id === draftId);
    if (!review) fail('SEMANTIC_ROUTE_REVIEW_NOT_FOUND', `语义路线尚未审核：${draftId}`);
    if (review.snapshot_id !== this.snapshot.id)
      fail('SEMANTIC_ROUTE_REVIEW_SNAPSHOT_MISMATCH', '语义路线审核不属于当前快照');
    return structuredClone(review);
  }

  prepare(input, { reviewer_id } = {}) {
    const reviewerId = normalizeText(reviewer_id, 'reviewer_id', 200),
      requestedDraftId = normalizeText(input?.draft_id, 'draft_id', 200),
      draft = this.draftService.get(requestedDraftId);
    if (draft.creator_id === reviewerId)
      fail('INDEPENDENT_SEMANTIC_REVIEW_REQUIRED', '语义路线必须由创建者之外的独立 Agent 审核');
    if (record(this.store, 'semantic_route_review', (item) => item.draft_id === draft.id))
      fail('SEMANTIC_ROUTE_ALREADY_REVIEWED', '该语义路线草稿已经完成审核');
    const normalized = normalizeReview(input, draft),
      reviewId = this.id(),
      packet = this.reviewInput(draft.id),
      createdAt = this.now();
    if (record(this.store, 'semantic_route_review', (item) => item.id === reviewId))
      fail('SEMANTIC_ROUTE_REVIEW_ID_CONFLICT', `语义路线审核 ID 已存在：${reviewId}`);
    return {
      schema_version: '1',
      id: reviewId,
      draft_id: draft.id,
      draft_digest: draft.decision_digest,
      review_input_digest: packet.review_input_digest,
      snapshot_id: this.snapshot.id,
      reviewer_id: reviewerId,
      decision: normalized.decision,
      status: normalized.decision === 'accept' ? 'accepted' : 'revision_required',
      summary: normalized.summary,
      issues: normalized.issues.map((issue, index) => ({
        id: `${reviewId}:issue:${index + 1}`,
        ...issue,
      })),
      reviewed_step_ids: draft.modules.flatMap((module) => module.steps.map((step) => step.id)),
      created_at: createdAt,
    };
  }

  persist(review) {
    if (
      record(
        this.store,
        'semantic_route_review',
        (item) => item.draft_id === review.draft_id || item.id === review.id,
      )
    )
      fail('SEMANTIC_ROUTE_ALREADY_REVIEWED', '该语义路线草稿已经完成审核');
    this.store.put('semantic_route_review', review);
    return structuredClone(review);
  }

  submit(input, options) {
    return this.persist(this.prepare(input, options));
  }
}

function toolResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

export function createSemanticRouteReviewTool({
  service,
  reviewer_id,
  draft_id,
  onReviewed = () => {},
}) {
  const reviewerId = normalizeText(reviewer_id, 'reviewer_id', 200),
    draftId = normalizeText(draft_id, 'draft_id', 200);
  return {
    name: 'submit_semantic_route_review',
    label: 'submit_semantic_route_review',
    description:
      '一次提交整条语义路线的独立审核结论。接受时不提交 issues；要求修改时按真实模块或步骤 ID 定位问题。category 是开放描述，不要重写源码、quote、行号或关系类型。',
    parameters: semanticRouteReviewSchema,
    executionMode: 'sequential',
    async execute(_id, input) {
      if (input?.draft_id !== draftId)
        fail('SEMANTIC_REVIEW_DRAFT_MISMATCH', `审核工具只接受当前草稿：${draftId}`);
      const review = service.submit(input, { reviewer_id: reviewerId }),
        extra = await onReviewed(review);
      return toolResult(extra === undefined ? review : { review, next: extra });
    },
  };
}
