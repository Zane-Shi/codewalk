import { createHash, randomUUID } from 'node:crypto';
import { sourceFile } from '../snapshot.ts';
import { findContainingFunction, nearbyFunctionEntries } from './function-ranges.ts';

const PROPOSAL_KEYS = new Set(['file', 'anchor_line', 'symbol_hint', 'start_line', 'end_line']);
const BATCH_KEYS = new Set(['module_id', 'units']);
const BATCH_UNIT_KEYS = new Set(['local_id', ...PROPOSAL_KEYS]);
const REVIEW_KEYS = new Set(['batch_id', 'revision', 'decision', 'changes']);
const CHANGE_KEYS = new Set(['unit_id', 'action', 'replacement']);
const REVIEW_DECISIONS = new Set(['confirm_all', 'revise']);
const CHANGE_ACTIONS = new Set(['revise', 'abandon']);

export const MAX_SOURCE_UNITS_PER_BATCH = 32;
export const MAX_FALLBACK_SOURCE_RANGE_LINES = 80;

const string = (maxLength = 400) => ({ type: 'string', minLength: 1, maxLength });
const proposalProperties = {
  file: string(),
  anchor_line: { type: 'integer', minimum: 1 },
  symbol_hint: string(300),
  start_line: { type: 'integer', minimum: 1 },
  end_line: { type: 'integer', minimum: 1 },
};

export const sourceUnitProposalSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['file'],
  properties: proposalProperties,
  oneOf: [
    {
      required: ['anchor_line'],
      not: { anyOf: [{ required: ['start_line'] }, { required: ['end_line'] }] },
    },
    {
      required: ['start_line', 'end_line'],
      not: { anyOf: [{ required: ['anchor_line'] }, { required: ['symbol_hint'] }] },
    },
  ],
};

export const sourceUnitBatchProposalSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['module_id', 'units'],
  properties: {
    module_id: string(100),
    units: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_SOURCE_UNITS_PER_BATCH,
      items: {
        ...sourceUnitProposalSchema,
        required: ['local_id', 'file'],
        properties: { local_id: string(100), ...proposalProperties },
      },
    },
  },
};

export const sourceUnitBatchReviewSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['batch_id', 'revision', 'decision'],
  properties: {
    batch_id: string(100),
    revision: { type: 'integer', minimum: 1 },
    decision: { type: 'string', enum: [...REVIEW_DECISIONS] },
    changes: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_SOURCE_UNITS_PER_BATCH,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['unit_id', 'action'],
        properties: {
          unit_id: string(100),
          action: { type: 'string', enum: [...CHANGE_ACTIONS] },
          replacement: sourceUnitProposalSchema,
        },
      },
    },
  },
};

export class SourceUnitError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SourceUnitError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new SourceUnitError(code, message, details);
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('INVALID_SOURCE_UNIT_INPUT', `${label} 必须是对象`);
}

function assertKnownKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length)
    fail('UNKNOWN_SOURCE_UNIT_FIELD', `${label} 包含不允许提交的字段：${unknown.join(', ')}`, {
      fields: unknown,
    });
}

function normalizeText(value, label, maxLength) {
  if (typeof value !== 'string' || !value.trim())
    fail('INVALID_SOURCE_UNIT_INPUT', `${label} 不能为空`);
  if (value.length > maxLength)
    fail('INVALID_SOURCE_UNIT_INPUT', `${label} 不能超过 ${maxLength} 个字符`);
  return value.trim();
}

function normalizeFile(value) {
  return normalizeText(value, 'file', 400).replaceAll('\\', '/');
}

function normalizeProposal(value, label = '源码单元提案') {
  assertObject(value, label);
  assertKnownKeys(value, PROPOSAL_KEYS, label);
  const file = normalizeFile(value.file),
    hasAnchor = value.anchor_line !== undefined,
    hasStart = value.start_line !== undefined,
    hasEnd = value.end_line !== undefined;
  if (hasAnchor) {
    if (!Number.isInteger(value.anchor_line) || value.anchor_line < 1)
      fail('INVALID_SOURCE_ANCHOR', `${label}.anchor_line 必须是正整数`, {
        file,
        anchor_line: value.anchor_line,
      });
    if (hasStart || hasEnd)
      fail('AMBIGUOUS_SOURCE_UNIT_SELECTION', `${label} 不能同时提交函数锚点和源码范围`);
    return {
      file,
      anchor_line: value.anchor_line,
      ...(value.symbol_hint === undefined
        ? {}
        : { symbol_hint: normalizeText(value.symbol_hint, `${label}.symbol_hint`, 300) }),
    };
  }
  if (value.symbol_hint !== undefined)
    fail('SYMBOL_HINT_REQUIRES_ANCHOR', `${label}.symbol_hint 只能与 anchor_line 一起使用`);
  if (
    !hasStart ||
    !hasEnd ||
    !Number.isInteger(value.start_line) ||
    !Number.isInteger(value.end_line) ||
    value.start_line < 1 ||
    value.end_line < value.start_line
  )
    fail('INVALID_SOURCE_RANGE', `${label} 必须提交 anchor_line 或有效的 start_line/end_line`, {
      file,
      start_line: value.start_line,
      end_line: value.end_line,
    });
  if (value.end_line - value.start_line + 1 > MAX_FALLBACK_SOURCE_RANGE_LINES)
    fail('SOURCE_RANGE_TOO_LARGE', `非函数源码范围最多包含 ${MAX_FALLBACK_SOURCE_RANGE_LINES} 行`, {
      file,
      start_line: value.start_line,
      end_line: value.end_line,
    });
  return { file, start_line: value.start_line, end_line: value.end_line };
}

function normalizeReviewerId(value) {
  return normalizeText(value, 'reviewer_id', 200);
}

function normalizeBatch(value) {
  assertObject(value, '源码单元批次');
  assertKnownKeys(value, BATCH_KEYS, '源码单元批次');
  const moduleId = normalizeText(value.module_id, 'module_id', 100);
  if (
    !Array.isArray(value.units) ||
    value.units.length < 1 ||
    value.units.length > MAX_SOURCE_UNITS_PER_BATCH
  )
    fail(
      'INVALID_SOURCE_UNIT_BATCH_SIZE',
      `源码单元批次必须包含 1–${MAX_SOURCE_UNITS_PER_BATCH} 项`,
    );
  const localIds = new Set();
  const units = value.units.map((item, index) => {
    const label = `units[${index}]`;
    assertObject(item, label);
    assertKnownKeys(item, BATCH_UNIT_KEYS, label);
    const localId = normalizeText(item.local_id, `${label}.local_id`, 100);
    if (localIds.has(localId))
      fail('DUPLICATE_LOCAL_ID', `源码单元批次包含重复 local_id：${localId}`);
    localIds.add(localId);
    const { local_id: _ignored, ...proposal } = item;
    return { local_id: localId, proposal: normalizeProposal(proposal, label) };
  });
  return { module_id: moduleId, units };
}

function findRecord(store, kind, id) {
  return store.list(kind).find((item) => item.id === id);
}

function batchRecordId(batchId, revision) {
  return `${batchId}:${revision}`;
}

function digestQuote(quote) {
  return `sha256:${createHash('sha256').update(quote).digest('hex')}`;
}

async function readSnapshotSource(snapshot, file) {
  try {
    return await sourceFile(snapshot, file);
  } catch (error) {
    fail('SOURCE_FILE_UNAVAILABLE', `无法读取快照中的源码文件：${file}`, {
      file,
      cause: String(error?.message ?? error),
    });
  }
}

async function materializeSourceUnit(snapshot, sourceGraph, proposal) {
  const source = await readSnapshotSource(snapshot, proposal.file),
    lines = source.content.split('\n');
  if ('anchor_line' in proposal) {
    if (proposal.anchor_line > lines.length)
      fail(
        'SOURCE_ANCHOR_OUT_OF_BOUNDS',
        `${proposal.file} 只有 ${lines.length} 行，无法定位第 ${proposal.anchor_line} 行`,
        { file: proposal.file, anchor_line: proposal.anchor_line, line_count: lines.length },
      );
    const resolved = findContainingFunction({
      file: proposal.file,
      lines,
      anchor_line: proposal.anchor_line,
      symbol: proposal.symbol_hint,
      sourceGraph,
    });
    if (!resolved)
      fail(
        'SOURCE_FUNCTION_NOT_FOUND',
        `第 ${proposal.anchor_line} 行无法唯一定位到完整函数；请修正锚点、symbol_hint，或对非函数文件提交有限源码范围`,
        {
          file: proposal.file,
          anchor_line: proposal.anchor_line,
          symbol_hint: proposal.symbol_hint,
          candidate_entry_lines: nearbyFunctionEntries({
            file: proposal.file,
            lines,
            entry_line: proposal.anchor_line,
            symbol: proposal.symbol_hint,
            sourceGraph,
          }),
        },
      );
    const quote = lines.slice(resolved.start_line - 1, resolved.end_line).join('\n');
    return {
      file: proposal.file,
      kind: 'function',
      start_line: resolved.start_line,
      end_line: resolved.end_line,
      quote,
      digest: digestQuote(quote),
      requested: {
        anchor_line: proposal.anchor_line,
        ...(proposal.symbol_hint ? { symbol_hint: proposal.symbol_hint } : {}),
      },
      symbol: {
        name: resolved.name ?? null,
        kind: resolved.kind ?? 'function',
        entry_line: resolved.start_line,
        ...(resolved.entity_id ? { entity_id: resolved.entity_id } : {}),
      },
    };
  }
  if (proposal.end_line > lines.length)
    fail(
      'SOURCE_RANGE_OUT_OF_BOUNDS',
      `${proposal.file} 只有 ${lines.length} 行，无法提取到第 ${proposal.end_line} 行`,
      { ...proposal, line_count: lines.length },
    );
  for (let line = proposal.start_line; line <= proposal.end_line; line++) {
    const containingFunction = findContainingFunction({
      file: proposal.file,
      lines,
      anchor_line: line,
      sourceGraph,
    });
    if (containingFunction)
      fail(
        'SOURCE_RANGE_INTERSECTS_FUNCTION',
        `提交的源码范围与函数 ${containingFunction.name ?? '<anonymous>'} 重叠；普通代码请改用函数内 anchor_line，由系统提取完整函数`,
        {
          file: proposal.file,
          start_line: proposal.start_line,
          end_line: proposal.end_line,
          function_entry_line: containingFunction.start_line,
          function_end_line: containingFunction.end_line,
          function_name: containingFunction.name ?? null,
        },
      );
  }
  const quote = lines.slice(proposal.start_line - 1, proposal.end_line).join('\n');
  return {
    file: proposal.file,
    kind: 'source_range',
    start_line: proposal.start_line,
    end_line: proposal.end_line,
    quote,
    digest: digestQuote(quote),
    requested: { start_line: proposal.start_line, end_line: proposal.end_line },
  };
}

export class SourceUnitService {
  constructor({
    store,
    snapshot,
    sourceGraph,
    now = () => Date.now(),
    id = () => `source-unit-${randomUUID()}`,
    batch_id = () => `source-unit-batch-${randomUUID()}`,
  }) {
    if (!store?.put || !store?.list) throw new Error('SourceUnitService 需要可持久化记录的 Store');
    if (!snapshot?.id || !snapshot?.root || !Array.isArray(snapshot?.files))
      throw new Error('SourceUnitService 需要有效的源码快照');
    if (sourceGraph?.snapshot_id && sourceGraph.snapshot_id !== snapshot.id)
      throw new Error('SourceUnitService 的代码图不属于当前源码快照');
    this.store = store;
    this.snapshot = snapshot;
    this.sourceGraph = sourceGraph;
    this.now = now;
    this.id = id;
    this.batchId = batch_id;
  }

  get(unitId) {
    const unit = findRecord(this.store, 'source_unit', unitId),
      review = findRecord(this.store, 'source_unit_review', unitId);
    if (!unit || !review) fail('SOURCE_UNIT_NOT_FOUND', `源码单元不存在：${unitId}`);
    if (unit.snapshot_id !== this.snapshot.id)
      fail('SOURCE_UNIT_SNAPSHOT_MISMATCH', '源码单元不属于当前快照', {
        unit_id: unitId,
        unit_snapshot_id: unit.snapshot_id,
        snapshot_id: this.snapshot.id,
      });
    return { unit: structuredClone(unit), review: structuredClone(review) };
  }

  async prepare(proposal, { reviewer_id, revises_unit_id } = {}) {
    const normalized = normalizeProposal(proposal),
      reviewerId = normalizeReviewerId(reviewer_id),
      materialized = await materializeSourceUnit(this.snapshot, this.sourceGraph, normalized),
      unitId = this.id(),
      createdAt = this.now();
    if (findRecord(this.store, 'source_unit', unitId))
      fail('SOURCE_UNIT_ID_CONFLICT', `源码单元 ID 已存在：${unitId}`);
    return {
      unit: {
        schema_version: '1',
        id: unitId,
        snapshot_id: this.snapshot.id,
        snapshot_version: this.snapshot.version ?? this.snapshot.id,
        ...materialized,
        created_at: createdAt,
        ...(revises_unit_id ? { revises_unit_id } : {}),
      },
      review: {
        schema_version: '1',
        id: unitId,
        unit_id: unitId,
        snapshot_id: this.snapshot.id,
        reviewer_id: reviewerId,
        status: 'pending',
        created_at: createdAt,
        updated_at: createdAt,
      },
    };
  }

  persist(prepared) {
    if (findRecord(this.store, 'source_unit', prepared.unit.id))
      fail('SOURCE_UNIT_ID_CONFLICT', `源码单元 ID 已存在：${prepared.unit.id}`);
    this.store.put('source_unit', prepared.unit);
    this.store.put('source_unit_review', prepared.review);
    return structuredClone(prepared);
  }

  getBatch(batchId, revision) {
    const id = batchRecordId(batchId, revision),
      batch = findRecord(this.store, 'source_unit_batch', id),
      review = findRecord(this.store, 'source_unit_batch_review', id);
    if (!batch || !review)
      fail('SOURCE_UNIT_BATCH_NOT_FOUND', `源码单元批次不存在：${batchId} revision ${revision}`);
    if (batch.snapshot_id !== this.snapshot.id)
      fail('SOURCE_UNIT_BATCH_SNAPSHOT_MISMATCH', '源码单元批次不属于当前快照');
    return {
      batch: structuredClone(batch),
      review: structuredClone(review),
      units: batch.entries.map((entry) => ({
        local_id: entry.local_id,
        ...this.get(entry.unit_id),
      })),
    };
  }

  async createBatch(input, { reviewer_id } = {}) {
    const normalized = normalizeBatch(input),
      reviewerId = normalizeReviewerId(reviewer_id),
      prepared = [];
    for (const item of normalized.units)
      prepared.push({
        local_id: item.local_id,
        state: await this.prepare(item.proposal, { reviewer_id: reviewerId }),
      });
    const unitIds = new Set(prepared.map((item) => item.state.unit.id));
    if (unitIds.size !== prepared.length) fail('SOURCE_UNIT_ID_CONFLICT', '批次内源码单元 ID 重复');
    const batchId = this.batchId(),
      revision = 1,
      id = batchRecordId(batchId, revision),
      createdAt = this.now();
    if (findRecord(this.store, 'source_unit_batch', id))
      fail('SOURCE_UNIT_BATCH_ID_CONFLICT', `源码单元批次 ID 已存在：${batchId}`);
    for (const item of prepared) this.persist(item.state);
    this.store.put('source_unit_batch', {
      schema_version: '1',
      id,
      batch_id: batchId,
      revision,
      snapshot_id: this.snapshot.id,
      module_id: normalized.module_id,
      entries: prepared.map((item) => ({ local_id: item.local_id, unit_id: item.state.unit.id })),
      created_at: createdAt,
    });
    this.store.put('source_unit_batch_review', {
      schema_version: '1',
      id,
      batch_id: batchId,
      revision,
      snapshot_id: this.snapshot.id,
      reviewer_id: reviewerId,
      status: 'pending',
      created_at: createdAt,
      updated_at: createdAt,
    });
    return this.getBatch(batchId, revision);
  }

  async reviewBatch(input, { reviewer_id } = {}) {
    assertObject(input, '源码单元批次审核');
    assertKnownKeys(input, REVIEW_KEYS, '源码单元批次审核');
    const batchId = normalizeText(input.batch_id, 'batch_id', 100),
      reviewerId = normalizeReviewerId(reviewer_id),
      revision = input.revision;
    if (!Number.isInteger(revision) || revision < 1)
      fail('INVALID_BATCH_REVISION', 'revision 必须是正整数');
    const current = this.getBatch(batchId, revision);
    if (!REVIEW_DECISIONS.has(input.decision)) fail('INVALID_BATCH_DECISION', '批次审核决定无效');
    if (current.review.reviewer_id !== reviewerId)
      fail('SOURCE_UNIT_REVIEWER_MISMATCH', '只有创建该批次的 Agent 可以完成批量自审核');
    if (current.review.status !== 'pending')
      fail(
        'SOURCE_UNIT_BATCH_NOT_PENDING',
        `批次已处于 ${current.review.status} 状态，不能再次审核`,
      );

    if (input.decision === 'confirm_all') {
      if (input.changes !== undefined)
        fail('UNEXPECTED_BATCH_CHANGES', 'confirm_all 不能携带 changes');
      const updatedAt = this.now();
      for (const item of current.units) {
        if (item.review.reviewer_id !== reviewerId || item.review.status !== 'pending')
          fail('SOURCE_UNIT_NOT_PENDING', `源码单元 ${item.unit.id} 不能随批次确认`, {
            status: item.review.status,
          });
      }
      for (const item of current.units)
        this.store.put('source_unit_review', {
          ...item.review,
          status: 'confirmed',
          decision: 'confirm',
          updated_at: updatedAt,
        });
      this.store.put('source_unit_batch_review', {
        ...current.review,
        status: 'confirmed',
        decision: 'confirm_all',
        updated_at: updatedAt,
      });
      return this.getBatch(batchId, revision);
    }

    if (
      !Array.isArray(input.changes) ||
      input.changes.length < 1 ||
      input.changes.length > MAX_SOURCE_UNITS_PER_BATCH
    )
      fail('INVALID_BATCH_CHANGES', 'revise 必须包含至少一项源码单元修改');
    const entryByUnit = new Map(current.batch.entries.map((entry) => [entry.unit_id, entry])),
      changesByUnit = new Map(),
      prepared = new Map();
    for (const [index, change] of input.changes.entries()) {
      const label = `changes[${index}]`;
      assertObject(change, label);
      assertKnownKeys(change, CHANGE_KEYS, label);
      const unitId = normalizeText(change.unit_id, `${label}.unit_id`, 100),
        action = change.action;
      if (!entryByUnit.has(unitId))
        fail('SOURCE_UNIT_NOT_IN_BATCH', `源码单元不属于当前批次：${unitId}`);
      if (changesByUnit.has(unitId))
        fail('DUPLICATE_BATCH_CHANGE', `同一源码单元不能在批次中修改两次：${unitId}`);
      if (!CHANGE_ACTIONS.has(action)) fail('INVALID_BATCH_CHANGE', '源码单元修改动作无效');
      if (action === 'revise' && change.replacement === undefined)
        fail('MISSING_SOURCE_UNIT_REPLACEMENT', 'revise 必须提供 replacement');
      if (action === 'abandon' && change.replacement !== undefined)
        fail('UNEXPECTED_SOURCE_UNIT_REPLACEMENT', 'abandon 不能携带 replacement');
      const state = this.get(unitId);
      if (state.review.reviewer_id !== reviewerId || state.review.status !== 'pending')
        fail('SOURCE_UNIT_NOT_PENDING', `源码单元 ${unitId} 不能修改`, {
          status: state.review.status,
        });
      changesByUnit.set(unitId, { action, state });
      if (action === 'revise')
        prepared.set(
          unitId,
          await this.prepare(normalizeProposal(change.replacement, `${label}.replacement`), {
            reviewer_id: reviewerId,
            revises_unit_id: unitId,
          }),
        );
    }
    const nextEntries = current.batch.entries.flatMap((entry) => {
      const change = changesByUnit.get(entry.unit_id);
      if (!change) return [entry];
      if (change.action === 'abandon') return [];
      return [{ local_id: entry.local_id, unit_id: prepared.get(entry.unit_id).unit.id }];
    });
    if (!nextEntries.length)
      fail('EMPTY_SOURCE_UNIT_BATCH', '不能放弃批次中的全部源码单元；请重新规划当前模块');
    const replacementIds = new Set([...prepared.values()].map((item) => item.unit.id));
    if (replacementIds.size !== prepared.size)
      fail('SOURCE_UNIT_ID_CONFLICT', '批次修订中的源码单元 ID 重复');
    const nextRevision = revision + 1,
      nextId = batchRecordId(batchId, nextRevision);
    if (findRecord(this.store, 'source_unit_batch', nextId))
      fail('SOURCE_UNIT_BATCH_REVISION_CONFLICT', `批次修订已经存在：${nextRevision}`);
    for (const state of prepared.values()) this.persist(state);
    const updatedAt = this.now();
    for (const [unitId, change] of changesByUnit) {
      const replacement = prepared.get(unitId);
      this.store.put('source_unit_review', {
        ...change.state.review,
        status: change.action === 'abandon' ? 'abandoned' : 'superseded',
        decision: change.action,
        ...(replacement ? { replacement_unit_id: replacement.unit.id } : {}),
        updated_at: updatedAt,
      });
    }
    this.store.put('source_unit_batch_review', {
      ...current.review,
      status: 'superseded',
      decision: 'revise',
      replacement_revision: nextRevision,
      updated_at: updatedAt,
    });
    this.store.put('source_unit_batch', {
      ...current.batch,
      id: nextId,
      revision: nextRevision,
      entries: nextEntries,
      revises_revision: revision,
      created_at: updatedAt,
    });
    this.store.put('source_unit_batch_review', {
      schema_version: '1',
      id: nextId,
      batch_id: batchId,
      revision: nextRevision,
      snapshot_id: this.snapshot.id,
      reviewer_id: reviewerId,
      status: 'pending',
      created_at: updatedAt,
      updated_at: updatedAt,
    });
    return this.getBatch(batchId, nextRevision);
  }
}

function toolResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

export function createSourceUnitBatchTools({
  service,
  reviewer_id,
  onMaterialized = () => {},
  onConfirmed = () => {},
}) {
  const reviewerId = normalizeReviewerId(reviewer_id);
  return [
    {
      name: 'propose_source_unit_batch',
      label: 'propose_source_unit_batch',
      description:
        '批量提交要带读的源码位置。普通代码只提交函数内 anchor_line，系统扩展为完整函数；非函数文件提交有限 start_line/end_line。不要提交 quote、digest 或最终范围。',
      parameters: sourceUnitBatchProposalSchema,
      executionMode: 'sequential',
      async execute(_id, proposal) {
        const result = await service.createBatch(proposal, { reviewer_id: reviewerId }),
          preview = await onMaterialized(result.units.map((item) => item.unit));
        return toolResult(preview === undefined ? result : { ...result, preview });
      },
    },
    {
      name: 'review_source_unit_batch',
      label: 'review_source_unit_batch',
      description:
        '对系统提取的完整源码单元做一次批量自审核。全部准确时只确认批次；位置错误时只替换对应单元，不能重写 quote。',
      parameters: sourceUnitBatchReviewSchema,
      executionMode: 'sequential',
      async execute(_id, review) {
        const result = await service.reviewBatch(review, { reviewer_id: reviewerId }),
          units = result.units.map((item) => item.unit),
          extra =
            result.review.status === 'confirmed'
              ? await onConfirmed(units)
              : await onMaterialized(units);
        return toolResult(
          extra === undefined
            ? result
            : {
                ...result,
                [result.review.status === 'confirmed' ? 'validation' : 'preview']: extra,
              },
        );
      },
    },
  ];
}
