import { createHash } from 'node:crypto';

const MODULE_RECORD_KIND = 'semantic_route_module_teaching';
const BLOCK_RECORD_KIND = 'semantic_route_block_teaching';
const REVISION_RECORD_KIND = 'semantic_route_teaching_revision';

const MODULE_KEYS = new Set(['schema_version', 'draft_id', 'module_id', 'explanation']);
const BLOCK_KEYS = new Set(['schema_version', 'draft_id', 'module_id', 'block_id', 'explanation']);
const MODULE_EXPLANATION_KEYS = new Set(['overview', 'block_flow', 'sections']);
const BLOCK_EXPLANATION_KEYS = new Set(['overview', 'walkthrough', 'sections', 'takeaways']);
const MODULE_SECTION_KEYS = new Set(['kind', 'title', 'content', 'related_block_ids']);
const BLOCK_SECTION_KEYS = new Set(['kind', 'title', 'content', 'source_ranges']);
const WALKTHROUGH_KEYS = new Set(['start_line', 'end_line', 'title', 'explanation']);
const SOURCE_RANGE_KEYS = new Set(['start_line', 'end_line']);
const REVISION_KEYS = new Set([
  'schema_version',
  'draft_id',
  'decision',
  'module_replacements',
  'block_replacements',
]);
const MODULE_REPLACEMENT_KEYS = new Set(['module_id', 'reason', 'explanation']);
const BLOCK_REPLACEMENT_KEYS = new Set(['module_id', 'block_id', 'reason', 'explanation']);

const textSchema = (maxLength = 8000) => ({ type: 'string', minLength: 1, maxLength });
const sourceRangeSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['start_line', 'end_line'],
  properties: {
    start_line: { type: 'integer', minimum: 1 },
    end_line: { type: 'integer', minimum: 1 },
  },
};
const moduleSectionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'title', 'content'],
  properties: {
    kind: textSchema(80),
    title: textSchema(240),
    content: textSchema(),
    related_block_ids: {
      type: 'array',
      minItems: 1,
      maxItems: 12,
      items: textSchema(160),
    },
  },
};
const blockSectionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'title', 'content'],
  properties: {
    kind: textSchema(80),
    title: textSchema(240),
    content: textSchema(),
    source_ranges: {
      type: 'array',
      minItems: 1,
      maxItems: 12,
      items: sourceRangeSchema,
    },
  },
};
const moduleExplanationSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['overview', 'block_flow'],
  properties: {
    overview: textSchema(),
    block_flow: textSchema(),
    sections: {
      type: 'array',
      minItems: 1,
      maxItems: 12,
      items: moduleSectionSchema,
    },
  },
};
const blockExplanationSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['overview', 'walkthrough'],
  properties: {
    overview: textSchema(),
    walkthrough: {
      type: 'array',
      minItems: 1,
      maxItems: 16,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['start_line', 'end_line', 'title', 'explanation'],
        properties: {
          start_line: { type: 'integer', minimum: 1 },
          end_line: { type: 'integer', minimum: 1 },
          title: textSchema(240),
          explanation: textSchema(),
        },
      },
    },
    sections: {
      type: 'array',
      minItems: 1,
      maxItems: 12,
      items: blockSectionSchema,
    },
    takeaways: {
      type: 'array',
      minItems: 1,
      maxItems: 8,
      items: textSchema(1200),
    },
  },
};

export const semanticModuleTeachingSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['schema_version', 'draft_id', 'module_id', 'explanation'],
  properties: {
    schema_version: { type: 'string', const: '1' },
    draft_id: textSchema(160),
    module_id: textSchema(160),
    explanation: moduleExplanationSchema,
  },
};

export const semanticBlockTeachingSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['schema_version', 'draft_id', 'module_id', 'block_id', 'explanation'],
  properties: {
    schema_version: { type: 'string', const: '1' },
    draft_id: textSchema(160),
    module_id: textSchema(160),
    block_id: textSchema(200),
    explanation: blockExplanationSchema,
  },
};

export const semanticTeachingRevisionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['schema_version', 'draft_id', 'decision'],
  properties: {
    schema_version: { type: 'string', const: '1' },
    draft_id: textSchema(160),
    decision: { type: 'string', enum: ['unchanged', 'revised'] },
    module_replacements: {
      type: 'array',
      minItems: 1,
      maxItems: 12,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['module_id', 'reason', 'explanation'],
        properties: {
          module_id: textSchema(160),
          reason: textSchema(1200),
          explanation: moduleExplanationSchema,
        },
      },
    },
    block_replacements: {
      type: 'array',
      minItems: 1,
      maxItems: 32,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['module_id', 'block_id', 'reason', 'explanation'],
        properties: {
          module_id: textSchema(160),
          block_id: textSchema(200),
          reason: textSchema(1200),
          explanation: blockExplanationSchema,
        },
      },
    },
  },
};

export class SemanticRouteTeachingError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SemanticRouteTeachingError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new SemanticRouteTeachingError(code, message, details);
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('INVALID_TEACHING_INPUT', `${label} 必须是对象`);
}

function assertKnownKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length)
    fail('UNKNOWN_TEACHING_FIELD', `${label} 包含不允许提交的字段：${unknown.join(', ')}`, {
      fields: unknown,
    });
}

function normalizeText(value, label, maxLength = 8000) {
  if (typeof value !== 'string' || !value.trim())
    fail('INVALID_TEACHING_INPUT', `${label} 不能为空`);
  if (value.length > maxLength)
    fail('INVALID_TEACHING_INPUT', `${label} 不能超过 ${maxLength} 个字符`);
  return value.trim();
}

function normalizeStringArray(value, label, { maxItems, maxLength }) {
  if (!Array.isArray(value) || !value.length || value.length > maxItems)
    fail('INVALID_TEACHING_INPUT', `${label} 必须包含 1–${maxItems} 项`);
  return value.map((item, index) => normalizeText(item, `${label}[${index}]`, maxLength));
}

function normalizeOptionalArray(value, label, maxItems, mapper) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.length || value.length > maxItems)
    fail('INVALID_TEACHING_INPUT', `${label} 必须包含 1–${maxItems} 项，或完全省略`);
  return value.map((item, index) => mapper(item, `${label}[${index}]`, index));
}

function findModule(draft, moduleId) {
  const module = draft.modules.find((item) => item.id === moduleId);
  if (!module) fail('UNKNOWN_TEACHING_MODULE', `模块不属于当前路线：${moduleId}`);
  return module;
}

function findStep(draft, moduleId, blockId) {
  const module = findModule(draft, moduleId),
    step = module.steps.find((item) => item.id === blockId);
  if (!step) fail('UNKNOWN_TEACHING_BLOCK', `代码块不属于模块 ${moduleId}：${blockId}`);
  return { module, step };
}

function normalizeSourceRange(value, label, unit) {
  assertObject(value, label);
  assertKnownKeys(value, SOURCE_RANGE_KEYS, label);
  const startLine = value.start_line,
    endLine = value.end_line;
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || endLine < startLine)
    fail('INVALID_TEACHING_RANGE', `${label} 必须是有效的正序整数行号范围`);
  if (startLine < unit.start_line || endLine > unit.end_line)
    fail(
      'TEACHING_RANGE_OUTSIDE_BLOCK',
      `${label} 的 L${startLine}–L${endLine} 超出代码块 L${unit.start_line}–L${unit.end_line}`,
      { start_line: startLine, end_line: endLine, block_id: unit.id },
    );
  return { start_line: startLine, end_line: endLine };
}

function normalizeModuleSection(value, label, module) {
  assertObject(value, label);
  assertKnownKeys(value, MODULE_SECTION_KEYS, label);
  const related = value.related_block_ids
    ? normalizeStringArray(value.related_block_ids, `${label}.related_block_ids`, {
        maxItems: 12,
        maxLength: 200,
      })
    : undefined;
  if (related) {
    const allowed = new Set(module.steps.map((step) => step.id));
    for (const blockId of related)
      if (!allowed.has(blockId))
        fail('UNKNOWN_TEACHING_BLOCK', `${label} 引用了模块外的代码块：${blockId}`);
  }
  return {
    kind: normalizeText(value.kind, `${label}.kind`, 80),
    title: normalizeText(value.title, `${label}.title`, 240),
    content: normalizeText(value.content, `${label}.content`),
    ...(related ? { related_block_ids: [...new Set(related)] } : {}),
  };
}

function normalizeBlockSection(value, label, unit) {
  assertObject(value, label);
  assertKnownKeys(value, BLOCK_SECTION_KEYS, label);
  const ranges = normalizeOptionalArray(
    value.source_ranges,
    `${label}.source_ranges`,
    12,
    (item, itemLabel) => normalizeSourceRange(item, itemLabel, unit),
  );
  return {
    kind: normalizeText(value.kind, `${label}.kind`, 80),
    title: normalizeText(value.title, `${label}.title`, 240),
    content: normalizeText(value.content, `${label}.content`),
    ...(ranges ? { source_ranges: ranges } : {}),
  };
}

function normalizeModuleExplanation(value, label, module) {
  assertObject(value, label);
  assertKnownKeys(value, MODULE_EXPLANATION_KEYS, label);
  const sections = normalizeOptionalArray(
    value.sections,
    `${label}.sections`,
    12,
    (item, itemLabel) => normalizeModuleSection(item, itemLabel, module),
  );
  return {
    overview: normalizeText(value.overview, `${label}.overview`),
    block_flow: normalizeText(value.block_flow, `${label}.block_flow`),
    ...(sections ? { sections } : {}),
  };
}

function normalizeBlockExplanation(value, label, step) {
  assertObject(value, label);
  assertKnownKeys(value, BLOCK_EXPLANATION_KEYS, label);
  if (
    !Array.isArray(value.walkthrough) ||
    !value.walkthrough.length ||
    value.walkthrough.length > 16
  )
    fail('INVALID_TEACHING_INPUT', `${label}.walkthrough 必须包含 1–16 个源码讲解区间`);
  let previousEnd = step.source_unit.start_line - 1;
  const walkthrough = value.walkthrough.map((item, index) => {
    const itemLabel = `${label}.walkthrough[${index}]`;
    assertObject(item, itemLabel);
    assertKnownKeys(item, WALKTHROUGH_KEYS, itemLabel);
    const range = normalizeSourceRange(
      { start_line: item.start_line, end_line: item.end_line },
      itemLabel,
      step.source_unit,
    );
    if (range.start_line <= previousEnd)
      fail('OVERLAPPING_TEACHING_RANGES', `${itemLabel} 必须按行号递增且不能与前一区间重叠`);
    previousEnd = range.end_line;
    return {
      ...range,
      title: normalizeText(item.title, `${itemLabel}.title`, 240),
      explanation: normalizeText(item.explanation, `${itemLabel}.explanation`),
    };
  });
  const sections = normalizeOptionalArray(
      value.sections,
      `${label}.sections`,
      12,
      (item, itemLabel) => normalizeBlockSection(item, itemLabel, step.source_unit),
    ),
    takeaways = value.takeaways
      ? normalizeStringArray(value.takeaways, `${label}.takeaways`, {
          maxItems: 8,
          maxLength: 1200,
        })
      : undefined;
  return {
    overview: normalizeText(value.overview, `${label}.overview`),
    walkthrough,
    ...(sections ? { sections } : {}),
    ...(takeaways ? { takeaways } : {}),
  };
}

function digest(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function findRecord(store, kind, id) {
  return store.list(kind).find((item) => item.id === id);
}

export function teachingSource(unit) {
  return {
    file: unit.file,
    start_line: unit.start_line,
    end_line: unit.end_line,
    digest: unit.digest,
    numbered_source: unit.quote
      .split(/\r?\n/)
      .map((line, index) => `${unit.start_line + index}: ${line}`)
      .join('\n'),
  };
}

const moduleRecordId = (draftId, moduleId) => `${draftId}:module-teaching:${moduleId}`;
const blockRecordId = (draftId, blockId) => `${draftId}:block-teaching:${blockId}`;
const revisionRecordId = (draftId) => `${draftId}:teaching-revision`;

export class SemanticRouteTeachingService {
  constructor({ store, draft, now = () => Date.now() }) {
    if (!store?.put || !store?.list) throw new Error('路线讲解服务需要 Store');
    if (!draft?.id || !Array.isArray(draft.modules)) throw new Error('路线讲解服务需要完整草稿');
    this.store = store;
    this.draft = draft;
    this.now = now;
  }

  getModule(moduleId) {
    findModule(this.draft, moduleId);
    return this.checkRecord(
      findRecord(this.store, MODULE_RECORD_KIND, moduleRecordId(this.draft.id, moduleId)),
    );
  }

  getBlock(blockId) {
    const step = this.draft.modules
      .flatMap((module) => module.steps)
      .find((item) => item.id === blockId);
    if (!step) fail('UNKNOWN_TEACHING_BLOCK', `代码块不属于当前路线：${blockId}`);
    return this.checkRecord(
      findRecord(this.store, BLOCK_RECORD_KIND, blockRecordId(this.draft.id, blockId)),
    );
  }

  getRevision() {
    return this.checkRecord(
      findRecord(this.store, REVISION_RECORD_KIND, revisionRecordId(this.draft.id)),
    );
  }

  checkRecord(record) {
    if (record && record.draft_digest !== this.draft.decision_digest)
      fail('TEACHING_DRAFT_MISMATCH', '已保存的讲解不属于当前路线版本');
    return record;
  }

  submitModule(input, { teacher_id, fallback = false }) {
    assertObject(input, '模块讲解');
    assertKnownKeys(input, MODULE_KEYS, '模块讲解');
    if (input.schema_version !== '1' || input.draft_id !== this.draft.id)
      fail('TEACHING_DRAFT_MISMATCH', '模块讲解不属于当前路线草稿');
    const module = findModule(this.draft, normalizeText(input.module_id, 'module_id', 160)),
      explanation = normalizeModuleExplanation(input.explanation, 'explanation', module),
      record = {
        schema_version: '1',
        id: moduleRecordId(this.draft.id, module.id),
        draft_id: this.draft.id,
        draft_digest: this.draft.decision_digest,
        module_id: module.id,
        explanation,
        teacher_id: normalizeText(teacher_id, 'teacher_id', 200),
        fallback: Boolean(fallback),
        content_digest: digest(explanation),
        created_at: this.now(),
      };
    this.store.put(MODULE_RECORD_KIND, record);
    return structuredClone(record);
  }

  submitBlock(input, { teacher_id, fallback = false }) {
    assertObject(input, '代码块讲解');
    assertKnownKeys(input, BLOCK_KEYS, '代码块讲解');
    if (input.schema_version !== '1' || input.draft_id !== this.draft.id)
      fail('TEACHING_DRAFT_MISMATCH', '代码块讲解不属于当前路线草稿');
    const moduleId = normalizeText(input.module_id, 'module_id', 160),
      blockId = normalizeText(input.block_id, 'block_id', 200),
      { step } = findStep(this.draft, moduleId, blockId),
      explanation = normalizeBlockExplanation(input.explanation, 'explanation', step),
      record = {
        schema_version: '1',
        id: blockRecordId(this.draft.id, blockId),
        draft_id: this.draft.id,
        draft_digest: this.draft.decision_digest,
        module_id: moduleId,
        block_id: blockId,
        explanation,
        teacher_id: normalizeText(teacher_id, 'teacher_id', 200),
        fallback: Boolean(fallback),
        content_digest: digest(explanation),
        created_at: this.now(),
      };
    this.store.put(BLOCK_RECORD_KIND, record);
    return structuredClone(record);
  }

  createModuleFallback(module, teacherId = 'route-planner-fallback') {
    return this.submitModule(
      {
        schema_version: '1',
        draft_id: this.draft.id,
        module_id: module.id,
        explanation: {
          overview: module.objective,
          block_flow: module.steps.map((step) => step.explanation).join(' '),
        },
      },
      { teacher_id: teacherId, fallback: true },
    );
  }

  createBlockFallback(module, step, teacherId = 'route-planner-fallback') {
    return this.submitBlock(
      {
        schema_version: '1',
        draft_id: this.draft.id,
        module_id: module.id,
        block_id: step.id,
        explanation: {
          overview: step.explanation,
          walkthrough: [
            {
              start_line: step.source_unit.start_line,
              end_line: step.source_unit.end_line,
              title: step.title,
              explanation: step.reading_guidance,
            },
          ],
          takeaways: [step.reading_guidance],
        },
      },
      { teacher_id: teacherId, fallback: true },
    );
  }

  initialTeaching() {
    const modules = this.draft.modules.map((module) => {
      const moduleRecord = this.getModule(module.id);
      if (!moduleRecord) fail('MISSING_MODULE_TEACHING', `模块尚未生成讲解：${module.id}`);
      return {
        module_id: module.id,
        explanation: structuredClone(moduleRecord.explanation),
        fallback: moduleRecord.fallback,
        blocks: module.steps.map((step) => {
          const blockRecord = this.getBlock(step.id);
          if (!blockRecord) fail('MISSING_BLOCK_TEACHING', `代码块尚未生成讲解：${step.id}`);
          return {
            block_id: step.id,
            explanation: structuredClone(blockRecord.explanation),
            fallback: blockRecord.fallback,
          };
        }),
      };
    });
    return { modules };
  }

  submitRevision(input, { editor_id }) {
    this.initialTeaching();
    assertObject(input, '最终教学修订');
    assertKnownKeys(input, REVISION_KEYS, '最终教学修订');
    if (input.schema_version !== '1' || input.draft_id !== this.draft.id)
      fail('TEACHING_DRAFT_MISMATCH', '最终教学修订不属于当前路线草稿');
    if (!['unchanged', 'revised'].includes(input.decision))
      fail('INVALID_TEACHING_REVISION', 'decision 必须是 unchanged 或 revised');
    const moduleReplacements = normalizeOptionalArray(
        input.module_replacements,
        'module_replacements',
        12,
        (item, label) => {
          assertObject(item, label);
          assertKnownKeys(item, MODULE_REPLACEMENT_KEYS, label);
          const module = findModule(
            this.draft,
            normalizeText(item.module_id, `${label}.module_id`, 160),
          );
          return {
            module_id: module.id,
            reason: normalizeText(item.reason, `${label}.reason`, 1200),
            explanation: normalizeModuleExplanation(
              item.explanation,
              `${label}.explanation`,
              module,
            ),
          };
        },
      ),
      blockReplacements = normalizeOptionalArray(
        input.block_replacements,
        'block_replacements',
        32,
        (item, label) => {
          assertObject(item, label);
          assertKnownKeys(item, BLOCK_REPLACEMENT_KEYS, label);
          const moduleId = normalizeText(item.module_id, `${label}.module_id`, 160),
            blockId = normalizeText(item.block_id, `${label}.block_id`, 200),
            { step } = findStep(this.draft, moduleId, blockId);
          return {
            module_id: moduleId,
            block_id: blockId,
            reason: normalizeText(item.reason, `${label}.reason`, 1200),
            explanation: normalizeBlockExplanation(item.explanation, `${label}.explanation`, step),
          };
        },
      );
    const replacements = [...(moduleReplacements ?? []), ...(blockReplacements ?? [])];
    if (input.decision === 'unchanged' && replacements.length)
      fail('INVALID_TEACHING_REVISION', 'unchanged 不能同时提交替换内容');
    if (input.decision === 'revised' && !replacements.length)
      fail('INVALID_TEACHING_REVISION', 'revised 至少需要提交一个模块或代码块替换');
    for (const [items, key] of [
      [moduleReplacements ?? [], 'module_id'],
      [blockReplacements ?? [], 'block_id'],
    ]) {
      const ids = items.map((item) => item[key]);
      if (new Set(ids).size !== ids.length)
        fail('DUPLICATE_TEACHING_REPLACEMENT', `最终修订重复提交了 ${key}`);
    }
    const normalized = {
        schema_version: '1',
        draft_id: this.draft.id,
        decision: input.decision,
        ...(moduleReplacements ? { module_replacements: moduleReplacements } : {}),
        ...(blockReplacements ? { block_replacements: blockReplacements } : {}),
      },
      record = {
        ...normalized,
        id: revisionRecordId(this.draft.id),
        draft_digest: this.draft.decision_digest,
        editor_id: normalizeText(editor_id, 'editor_id', 200),
        content_digest: digest(normalized),
        created_at: this.now(),
      };
    this.store.put(REVISION_RECORD_KIND, record);
    return structuredClone(record);
  }

  finalTeaching() {
    const initial = this.initialTeaching(),
      revision = this.getRevision(),
      moduleReplacements = new Map(
        (revision?.module_replacements ?? []).map((item) => [item.module_id, item]),
      ),
      blockReplacements = new Map(
        (revision?.block_replacements ?? []).map((item) => [item.block_id, item]),
      ),
      modules = initial.modules.map((module) => ({
        ...module,
        explanation: moduleReplacements.get(module.module_id)?.explanation ?? module.explanation,
        fallback: moduleReplacements.has(module.module_id) ? false : module.fallback,
        blocks: module.blocks.map((block) => ({
          ...block,
          explanation: blockReplacements.get(block.block_id)?.explanation ?? block.explanation,
          fallback: blockReplacements.has(block.block_id) ? false : block.fallback,
        })),
      })),
      payload = {
        schema_version: '1',
        draft_id: this.draft.id,
        draft_digest: this.draft.decision_digest,
        revision_id: revision?.id,
        modules,
      };
    return { ...payload, decision_digest: digest(payload) };
  }
}

function toolResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

export function createModuleTeachingTool({ service, teacher_id, module_id, onCreated = () => {} }) {
  return {
    name: 'submit_module_teaching',
    label: '提交模块讲解',
    description:
      '提交当前锁定模块的初学者讲解。只填写模块概述、代码块协作过程和真正有帮助的可选章节。',
    parameters: semanticModuleTeachingSchema,
    executionMode: 'sequential',
    async execute(_id, input) {
      if (input.module_id !== module_id)
        fail('TEACHING_TARGET_MISMATCH', `本轮只能提交模块 ${module_id}`);
      const created = service.submitModule(input, { teacher_id });
      onCreated(created);
      return toolResult({ status: 'saved', id: created.id });
    },
  };
}

export function createBlockTeachingTool({ service, teacher_id, block_id, onCreated = () => {} }) {
  return {
    name: 'submit_block_teaching',
    label: '提交代码块讲解',
    description:
      '提交当前锁定代码块的详细带读内容。行号必须来自给定源码；根据代码特点按需增加开放式章节。',
    parameters: semanticBlockTeachingSchema,
    executionMode: 'sequential',
    async execute(_id, input) {
      if (input.block_id !== block_id)
        fail('TEACHING_TARGET_MISMATCH', `本轮只能提交代码块 ${block_id}`);
      const created = service.submitBlock(input, { teacher_id });
      onCreated(created);
      return toolResult({ status: 'saved', id: created.id });
    },
  };
}

export function createInspectTeachingSourceTool({ service, maxCalls = 12, onLimit = () => {} }) {
  let calls = 0;
  return {
    name: 'inspect_teaching_source',
    label: '查看代码块真实源码',
    description:
      '按需核对锁定源码。优先用 block_ids 一次查看最多 8 块，避免逐块调用重复传输整条讲解上下文。也支持单个 block_id。最多 12 次调用，耗尽后必须提交修订。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        block_id: textSchema(200),
        block_ids: {
          type: 'array',
          minItems: 1,
          maxItems: 8,
          uniqueItems: true,
          items: textSchema(200),
        },
      },
    },
    executionMode: 'sequential',
    async execute(_id, input) {
      if (calls >= maxCalls) {
        onLimit();
        throw new Error(
          `源码查看预算 ${maxCalls} 次已耗尽，请调用 submit_teaching_revision 完成修订`,
        );
      }
      assertObject(input, '源码查看');
      assertKnownKeys(input, new Set(['block_id', 'block_ids']), '源码查看');
      if ((input.block_id !== undefined) === (input.block_ids !== undefined))
        fail('INVALID_TEACHING_INPUT', 'block_id 与 block_ids 必须且只能填写一个');
      const ids =
        input.block_ids !== undefined
          ? normalizeStringArray(input.block_ids, 'block_ids', { maxItems: 8, maxLength: 200 })
          : [normalizeText(input.block_id, 'block_id', 200)];
      const units = service.draft.modules.flatMap((module) =>
        module.steps.map((step) => ({ module, step })),
      );
      const sources = [...new Set(ids)].map((id) => {
        const found = units.find((item) => item.step.id === id);
        if (!found) fail('UNKNOWN_TEACHING_BLOCK', `代码块不属于当前路线：${id}`);
        return {
          module_id: found.module.id,
          block_id: id,
          ...teachingSource(found.step.source_unit),
        };
      });
      calls++;
      if (calls >= maxCalls) onLimit();
      return toolResult({
        ...(input.block_ids ? { sources } : sources[0]),
        remaining_calls: maxCalls - calls,
      });
    },
  };
}

export function createTeachingRevisionTool({ service, editor_id, onCreated = () => {} }) {
  return {
    name: 'submit_teaching_revision',
    label: '提交最终教学修订',
    description:
      '通读整条路线后直接提交最终修订。只替换确有问题的模块或代码块；没有问题时提交 unchanged。',
    parameters: semanticTeachingRevisionSchema,
    executionMode: 'sequential',
    async execute(_id, input) {
      const created = service.submitRevision(input, { editor_id });
      onCreated(created);
      return toolResult({ status: 'saved', id: created.id });
    },
  };
}
