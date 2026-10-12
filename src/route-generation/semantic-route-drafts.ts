import { createHash, randomUUID } from 'node:crypto';
import { SourceUnitError } from './source-units.ts';

const DRAFT_KEYS = new Set(['schema_version', 'request_id', 'goal', 'summary', 'modules']);
const GOAL_KEYS = new Set(['title', 'scenario', 'learning_outcome']);
const MODULE_KEYS = new Set([
  'id',
  'title',
  'objective',
  'source_unit_batch',
  'transition_from_previous',
  'steps',
]);
const BATCH_REF_KEYS = new Set(['batch_id', 'revision']);
const STEP_KEYS = new Set([
  'unit_id',
  'title',
  'explanation',
  'reading_guidance',
  'transition_from_previous',
]);

export const MAX_SEMANTIC_ROUTE_MODULES = 12;
export const MAX_SEMANTIC_ROUTE_STEPS = 32;

const string = (maxLength = 2400) => ({ type: 'string', minLength: 1, maxLength });
const transitionProperty = { transition_from_previous: string(1200) };

export const semanticRouteDraftSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['schema_version', 'request_id', 'goal', 'summary', 'modules'],
  properties: {
    schema_version: { type: 'string', const: '1' },
    request_id: string(200),
    goal: {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'scenario', 'learning_outcome'],
      properties: {
        title: string(300),
        scenario: string(),
        learning_outcome: string(),
      },
    },
    summary: string(),
    modules: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_SEMANTIC_ROUTE_MODULES,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'objective', 'source_unit_batch', 'steps'],
        properties: {
          id: string(100),
          title: string(300),
          objective: string(),
          source_unit_batch: {
            type: 'object',
            additionalProperties: false,
            required: ['batch_id', 'revision'],
            properties: {
              batch_id: string(100),
              revision: { type: 'integer', minimum: 1 },
            },
          },
          ...transitionProperty,
          steps: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_SEMANTIC_ROUTE_STEPS,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['unit_id', 'title', 'explanation', 'reading_guidance'],
              properties: {
                unit_id: string(100),
                title: string(300),
                explanation: string(),
                reading_guidance: string(),
                ...transitionProperty,
              },
            },
          },
        },
      },
    },
  },
};

export class SemanticRouteDraftError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SemanticRouteDraftError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new SemanticRouteDraftError(code, message, details);
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('INVALID_SEMANTIC_ROUTE_INPUT', `${label} 必须是对象`);
}

function assertKnownKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length)
    fail('UNKNOWN_SEMANTIC_ROUTE_FIELD', `${label} 包含不允许提交的字段：${unknown.join(', ')}`, {
      fields: unknown,
    });
}

function normalizeText(value, label, maxLength = 2400) {
  if (typeof value !== 'string' || !value.trim())
    fail('INVALID_SEMANTIC_ROUTE_INPUT', `${label} 不能为空`);
  if (value.length > maxLength)
    fail('INVALID_SEMANTIC_ROUTE_INPUT', `${label} 不能超过 ${maxLength} 个字符`);
  return value.trim();
}

function normalizeTransition(value, label, required) {
  if (value === undefined) {
    if (required) fail('MISSING_TEACHING_TRANSITION', `${label} 必须解释为什么接着阅读当前内容`);
    return undefined;
  }
  if (!required)
    fail('UNEXPECTED_TEACHING_TRANSITION', `${label} 是路线起点，不能声明“从上一项衔接”`);
  return normalizeText(value, label, 1200);
}

function normalizeBatchRef(value, label) {
  assertObject(value, label);
  assertKnownKeys(value, BATCH_REF_KEYS, label);
  const batchId = normalizeText(value.batch_id, `${label}.batch_id`, 100);
  if (!Number.isInteger(value.revision) || value.revision < 1)
    fail('INVALID_SOURCE_UNIT_BATCH_REVISION', `${label}.revision 必须是正整数`);
  return { batch_id: batchId, revision: value.revision };
}

function normalizeStep(value, label, index) {
  assertObject(value, label);
  assertKnownKeys(value, STEP_KEYS, label);
  const transition = normalizeTransition(
    value.transition_from_previous,
    `${label}.transition_from_previous`,
    index > 0,
  );
  return {
    unit_id: normalizeText(value.unit_id, `${label}.unit_id`, 100),
    title: normalizeText(value.title, `${label}.title`, 300),
    explanation: normalizeText(value.explanation, `${label}.explanation`),
    reading_guidance: normalizeText(value.reading_guidance, `${label}.reading_guidance`),
    ...(transition ? { transition_from_previous: transition } : {}),
  };
}

function normalizeModule(value, label, index) {
  assertObject(value, label);
  assertKnownKeys(value, MODULE_KEYS, label);
  if (!Array.isArray(value.steps) || !value.steps.length)
    fail('EMPTY_SEMANTIC_ROUTE_MODULE', `${label}.steps 至少需要一个源码单元`);
  if (value.steps.length > MAX_SEMANTIC_ROUTE_STEPS)
    fail('TOO_MANY_SEMANTIC_ROUTE_STEPS', `${label}.steps 不能超过 ${MAX_SEMANTIC_ROUTE_STEPS} 项`);
  const transition = normalizeTransition(
    value.transition_from_previous,
    `${label}.transition_from_previous`,
    index > 0,
  );
  return {
    id: normalizeText(value.id, `${label}.id`, 100),
    title: normalizeText(value.title, `${label}.title`, 300),
    objective: normalizeText(value.objective, `${label}.objective`),
    source_unit_batch: normalizeBatchRef(value.source_unit_batch, `${label}.source_unit_batch`),
    ...(transition ? { transition_from_previous: transition } : {}),
    steps: value.steps.map((step, stepIndex) =>
      normalizeStep(step, `${label}.steps[${stepIndex}]`, stepIndex),
    ),
  };
}

function normalizeDraft(value) {
  assertObject(value, '语义路线草稿');
  assertKnownKeys(value, DRAFT_KEYS, '语义路线草稿');
  if (value.schema_version !== '1')
    fail('UNSUPPORTED_SEMANTIC_ROUTE_SCHEMA', 'schema_version 必须是 1');
  assertObject(value.goal, 'goal');
  assertKnownKeys(value.goal, GOAL_KEYS, 'goal');
  if (
    !Array.isArray(value.modules) ||
    !value.modules.length ||
    value.modules.length > MAX_SEMANTIC_ROUTE_MODULES
  )
    fail(
      'INVALID_SEMANTIC_ROUTE_MODULES',
      `modules 必须包含 1–${MAX_SEMANTIC_ROUTE_MODULES} 个模块`,
    );
  const modules = value.modules.map((module, index) =>
      normalizeModule(module, `modules[${index}]`, index),
    ),
    moduleIds = new Set(),
    batchRefs = new Set();
  let stepCount = 0;
  for (const module of modules) {
    if (moduleIds.has(module.id))
      fail('DUPLICATE_SEMANTIC_MODULE_ID', `模块 ID 重复：${module.id}`);
    moduleIds.add(module.id);
    const batchKey = `${module.source_unit_batch.batch_id}:${module.source_unit_batch.revision}`;
    if (batchRefs.has(batchKey))
      fail('DUPLICATE_SOURCE_UNIT_BATCH', `同一源码单元批次不能用于两个模块：${batchKey}`);
    batchRefs.add(batchKey);
    stepCount += module.steps.length;
  }
  if (stepCount > MAX_SEMANTIC_ROUTE_STEPS)
    fail(
      'TOO_MANY_SEMANTIC_ROUTE_STEPS',
      `整条路线最多包含 ${MAX_SEMANTIC_ROUTE_STEPS} 个源码单元`,
    );
  return {
    schema_version: '1',
    request_id: normalizeText(value.request_id, 'request_id', 200),
    goal: {
      title: normalizeText(value.goal.title, 'goal.title', 300),
      scenario: normalizeText(value.goal.scenario, 'goal.scenario'),
      learning_outcome: normalizeText(value.goal.learning_outcome, 'goal.learning_outcome'),
    },
    summary: normalizeText(value.summary, 'summary'),
    modules,
  };
}

function findRecord(store, kind, id) {
  return store.list(kind).find((item) => item.id === id);
}

function decisionDigest(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function loadConfirmedBatch(sourceUnitService, reference) {
  let result;
  try {
    result = sourceUnitService.getBatch(reference.batch_id, reference.revision);
  } catch (error) {
    if (error instanceof SourceUnitError)
      fail('SOURCE_UNIT_BATCH_UNAVAILABLE', error.message, {
        batch_id: reference.batch_id,
        revision: reference.revision,
        cause_code: error.code,
      });
    throw error;
  }
  if (result.review.status !== 'confirmed')
    fail(
      'SOURCE_UNIT_BATCH_NOT_CONFIRMED',
      `源码单元批次 ${reference.batch_id} revision ${reference.revision} 尚未完成自审核`,
      { status: result.review.status },
    );
  for (const item of result.units)
    if (item.review.status !== 'confirmed')
      fail('SOURCE_UNIT_NOT_CONFIRMED', `源码单元尚未完成自审核：${item.unit.id}`, {
        status: item.review.status,
      });
  return result;
}

function hydrateModule(module, moduleIndex, sourceUnitService, draftId, usedUnitIds) {
  const batch = loadConfirmedBatch(sourceUnitService, module.source_unit_batch);
  if (batch.batch.module_id !== module.id)
    fail(
      'SOURCE_UNIT_BATCH_MODULE_MISMATCH',
      `模块 ${module.id} 不能引用属于 ${batch.batch.module_id} 的源码单元批次`,
    );
  const unitById = new Map(batch.units.map((item) => [item.unit.id, item.unit])),
    submittedIds = new Set();
  for (const step of module.steps) {
    if (!unitById.has(step.unit_id))
      fail(
        'SOURCE_UNIT_NOT_IN_BATCH',
        `源码单元不属于模块 ${module.id} 的已确认批次：${step.unit_id}`,
      );
    if (submittedIds.has(step.unit_id))
      fail('DUPLICATE_SOURCE_UNIT', `模块 ${module.id} 重复使用源码单元：${step.unit_id}`);
    if (usedUnitIds.has(step.unit_id))
      fail('DUPLICATE_SOURCE_UNIT', `路线重复使用源码单元：${step.unit_id}`);
    submittedIds.add(step.unit_id);
    usedUnitIds.add(step.unit_id);
  }
  const omitted = [...unitById.keys()].filter((unitId) => !submittedIds.has(unitId));
  if (omitted.length)
    fail(
      'OMITTED_CONFIRMED_SOURCE_UNITS',
      `模块 ${module.id} 没有为全部已确认源码单元安排阅读顺序`,
      {
        omitted_unit_ids: omitted,
      },
    );
  return {
    id: module.id,
    order: moduleIndex + 1,
    title: module.title,
    objective: module.objective,
    source_unit_batch: structuredClone(module.source_unit_batch),
    ...(module.transition_from_previous
      ? { transition_from_previous: module.transition_from_previous }
      : {}),
    steps: module.steps.map((step, stepIndex) => ({
      id: `${draftId}:step:${moduleIndex + 1}:${stepIndex + 1}`,
      order: stepIndex + 1,
      unit_id: step.unit_id,
      title: step.title,
      explanation: step.explanation,
      reading_guidance: step.reading_guidance,
      ...(step.transition_from_previous
        ? { transition_from_previous: step.transition_from_previous }
        : {}),
      source_unit: structuredClone(unitById.get(step.unit_id)),
    })),
  };
}

export class SemanticRouteDraftService {
  constructor({
    store,
    snapshot,
    sourceUnitService,
    now = () => Date.now(),
    id = () => `semantic-route-draft-${randomUUID()}`,
  }) {
    if (!store?.put || !store?.list)
      throw new Error('SemanticRouteDraftService 需要可持久化记录的 Store');
    if (!snapshot?.id) throw new Error('SemanticRouteDraftService 需要有效的源码快照');
    if (!sourceUnitService?.getBatch)
      throw new Error('SemanticRouteDraftService 需要 SourceUnitService');
    if (sourceUnitService.snapshot?.id !== snapshot.id)
      throw new Error('SemanticRouteDraftService 与 SourceUnitService 必须使用同一源码快照');
    if (sourceUnitService.store !== store)
      throw new Error('SemanticRouteDraftService 与 SourceUnitService 必须使用同一 Store');
    this.store = store;
    this.snapshot = snapshot;
    this.sourceUnitService = sourceUnitService;
    this.now = now;
    this.id = id;
  }

  get(draftId) {
    const draft = findRecord(this.store, 'semantic_route_draft', draftId);
    if (!draft) fail('SEMANTIC_ROUTE_DRAFT_NOT_FOUND', `语义路线草稿不存在：${draftId}`);
    if (draft.snapshot_id !== this.snapshot.id)
      fail('SEMANTIC_ROUTE_SNAPSHOT_MISMATCH', '语义路线草稿不属于当前快照');
    return structuredClone(draft);
  }

  create(input, { creator_id } = {}) {
    const normalized = normalizeDraft(input),
      creatorId = normalizeText(creator_id, 'creator_id', 200),
      draftId = this.id();
    if (findRecord(this.store, 'semantic_route_draft', draftId))
      fail('SEMANTIC_ROUTE_DRAFT_ID_CONFLICT', `语义路线草稿 ID 已存在：${draftId}`);
    const usedUnitIds = new Set(),
      modules = normalized.modules.map((module, index) =>
        hydrateModule(module, index, this.sourceUnitService, draftId, usedUnitIds),
      ),
      draft = {
        schema_version: '1',
        id: draftId,
        request_id: normalized.request_id,
        snapshot_id: this.snapshot.id,
        snapshot_version: this.snapshot.version ?? this.snapshot.id,
        goal: normalized.goal,
        summary: normalized.summary,
        modules,
        status: 'pending_semantic_review',
        decision_digest: decisionDigest(normalized),
        creator_id: creatorId,
        created_at: this.now(),
      };
    this.store.put('semantic_route_draft', draft);
    return structuredClone(draft);
  }
}

function toolResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

export function createSemanticRouteDraftTool({ service, creator_id, onCreated = () => {} }) {
  const creatorId = normalizeText(creator_id, 'creator_id', 200);
  return {
    name: 'submit_semantic_route_draft',
    label: 'submit_semantic_route_draft',
    description:
      '用已确认的源码单元组织一条面向用户的阅读路线。为每段源码填写语义解释、阅读重点和自然语言教学衔接；不要提交运行时关系类型、quote、行号或源码内容。',
    parameters: semanticRouteDraftSchema,
    executionMode: 'sequential',
    async execute(_id, input) {
      const draft = service.create(input, { creator_id: creatorId }),
        extra = await onCreated(draft);
      return toolResult(extra === undefined ? draft : { draft, preview: extra });
    },
  };
}
