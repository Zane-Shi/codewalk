import { randomUUID } from 'node:crypto';
import { sourceFile } from '../snapshot.ts';

const RELATIONS = new Set(['calls', 'returns', 'continues', 'handoff']);
const DECISIONS = new Set(['confirm', 'revise', 'reclassify', 'abandon', 'needs_review']);
const PROPOSAL_KEYS = new Set(['source', 'target', 'relation', 'reason']);
const LOCATION_KEYS = new Set(['file', 'start_line', 'end_line']);
const REVIEW_KEYS = new Set(['candidate_id', 'decision', 'changes']);
const CHANGE_KEYS = new Set(['source', 'target', 'relation', 'reason']);
const BATCH_PROPOSAL_KEYS = new Set(['module_id', 'candidates']);
const BATCH_CANDIDATE_KEYS = new Set(['local_id', ...PROPOSAL_KEYS]);
const BATCH_REVIEW_KEYS = new Set(['batch_id', 'revision', 'decision', 'changes']);
const BATCH_CHANGE_KEYS = new Set(['candidate_id', 'action', ...CHANGE_KEYS]);
const BATCH_DECISIONS = new Set(['confirm_all', 'revise']);
const BATCH_CHANGE_ACTIONS = new Set(['revise', 'abandon', 'needs_review']);

export const MAX_SOURCE_RANGE_LINES = 20;
export const MAX_SOURCE_CANDIDATES_PER_BATCH = 24;

const string = (maxLength = 1200) => ({ type: 'string', minLength: 1, maxLength });
const locationSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['file', 'start_line', 'end_line'],
  properties: {
    file: string(400),
    start_line: { type: 'integer', minimum: 1 },
    end_line: { type: 'integer', minimum: 1 },
  },
};

export const sourceCandidateProposalSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['source', 'target', 'relation', 'reason'],
  properties: {
    source: locationSchema,
    target: locationSchema,
    relation: { type: 'string', enum: [...RELATIONS] },
    reason: string(),
  },
};

const batchCandidateSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['local_id', 'source', 'target', 'relation', 'reason'],
  properties: {
    local_id: string(100),
    ...sourceCandidateProposalSchema.properties,
  },
};

export const sourceCandidateBatchProposalSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['module_id', 'candidates'],
  properties: {
    module_id: string(100),
    candidates: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_SOURCE_CANDIDATES_PER_BATCH,
      items: batchCandidateSchema,
    },
  },
};

export const sourceCandidateBatchReviewSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['batch_id', 'revision', 'decision'],
  properties: {
    batch_id: string(100),
    revision: { type: 'integer', minimum: 1 },
    decision: { type: 'string', enum: [...BATCH_DECISIONS] },
    changes: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_SOURCE_CANDIDATES_PER_BATCH,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['candidate_id'],
        properties: {
          candidate_id: string(100),
          action: { type: 'string', enum: [...BATCH_CHANGE_ACTIONS] },
          source: locationSchema,
          target: locationSchema,
          relation: { type: 'string', enum: [...RELATIONS] },
          reason: string(),
        },
      },
    },
  },
};

export class SourceCandidateError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SourceCandidateError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new SourceCandidateError(code, message, details);
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('INVALID_CANDIDATE_INPUT', `${label} 必须是对象`);
}

function assertKnownKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length)
    fail('UNKNOWN_CANDIDATE_FIELD', `${label} 包含不允许提交的字段：${unknown.join(', ')}`, {
      fields: unknown,
    });
}

function normalizeText(value, label, maxLength) {
  if (typeof value !== 'string' || !value.trim())
    fail('INVALID_CANDIDATE_INPUT', `${label} 不能为空`);
  if (value.length > maxLength)
    fail('INVALID_CANDIDATE_INPUT', `${label} 不能超过 ${maxLength} 个字符`);
  return value.trim();
}

function normalizeLocation(value, label) {
  assertObject(value, label);
  assertKnownKeys(value, LOCATION_KEYS, label);
  const file = normalizeText(value.file, `${label}.file`, 400);
  if (
    !Number.isInteger(value.start_line) ||
    !Number.isInteger(value.end_line) ||
    value.start_line < 1 ||
    value.end_line < value.start_line
  )
    fail('INVALID_SOURCE_RANGE', `${label} 的源码行范围无效`, {
      file,
      start_line: value.start_line,
      end_line: value.end_line,
    });
  if (value.end_line - value.start_line + 1 > MAX_SOURCE_RANGE_LINES)
    fail('SOURCE_RANGE_TOO_LARGE', `${label} 一次最多引用 ${MAX_SOURCE_RANGE_LINES} 行源码`, {
      file,
      start_line: value.start_line,
      end_line: value.end_line,
    });
  return { file, start_line: value.start_line, end_line: value.end_line };
}

function normalizeProposal(value) {
  assertObject(value, '候选提案');
  assertKnownKeys(value, PROPOSAL_KEYS, '候选提案');
  if (!RELATIONS.has(value.relation))
    fail('INVALID_RELATION', '关系必须是 calls、returns、continues 或 handoff');
  return {
    source: normalizeLocation(value.source, 'source'),
    target: normalizeLocation(value.target, 'target'),
    relation: value.relation,
    reason: normalizeText(value.reason, 'reason', 1200),
  };
}

function normalizeReviewerId(value) {
  return normalizeText(value, 'reviewer_id', 200);
}

async function materializeLocation(snapshot, location) {
  let source;
  try {
    source = await sourceFile(snapshot, location.file);
  } catch (error) {
    fail('SOURCE_FILE_UNAVAILABLE', `无法读取快照中的源码文件：${location.file}`, {
      file: location.file,
      cause: String(error?.message ?? error),
    });
  }
  const lines = source.content.split('\n');
  if (location.end_line > lines.length)
    fail(
      'SOURCE_RANGE_OUT_OF_BOUNDS',
      `${location.file} 只有 ${lines.length} 行，无法提取到第 ${location.end_line} 行`,
      { ...location, line_count: lines.length },
    );
  return {
    ...location,
    quote: lines.slice(location.start_line - 1, location.end_line).join('\n'),
  };
}

function findRecord(store, kind, id) {
  return store.list(kind).find((item) => item.id === id);
}

function batchRecordId(batchId, revision) {
  return `${batchId}:${revision}`;
}

function locationOf(value) {
  return {
    file: value.file,
    start_line: value.start_line,
    end_line: value.end_line,
  };
}

function normalizeBatchProposal(value) {
  assertObject(value, '候选批次');
  assertKnownKeys(value, BATCH_PROPOSAL_KEYS, '候选批次');
  const moduleId = normalizeText(value.module_id, 'module_id', 100);
  if (
    !Array.isArray(value.candidates) ||
    value.candidates.length < 1 ||
    value.candidates.length > MAX_SOURCE_CANDIDATES_PER_BATCH
  )
    fail(
      'INVALID_CANDIDATE_BATCH_SIZE',
      `候选批次必须包含 1–${MAX_SOURCE_CANDIDATES_PER_BATCH} 条关系`,
    );
  const localIds = new Set();
  const candidates = value.candidates.map((item, index) => {
    assertObject(item, `candidates[${index}]`);
    assertKnownKeys(item, BATCH_CANDIDATE_KEYS, `candidates[${index}]`);
    const localId = normalizeText(item.local_id, `candidates[${index}].local_id`, 100);
    if (localIds.has(localId)) fail('DUPLICATE_LOCAL_ID', `候选批次包含重复 local_id：${localId}`);
    localIds.add(localId);
    const { local_id: _ignored, ...proposal } = item;
    return { local_id: localId, proposal: normalizeProposal(proposal) };
  });
  return { module_id: moduleId, candidates };
}

function replacementProposal(candidate, changes) {
  return {
    source: changes.source ?? locationOf(candidate.source),
    target: changes.target ?? locationOf(candidate.target),
    relation: changes.relation ?? candidate.relation,
    reason: changes.reason ?? candidate.reason,
  };
}

/**
 * Materializes immutable source candidates from Agent-selected locations.
 * Candidate facts and mutable review state are persisted as separate records.
 */
export class SourceCandidateService {
  constructor({
    store,
    snapshot,
    now = () => Date.now(),
    id = () => `candidate-${randomUUID()}`,
    batch_id = () => `batch-${randomUUID()}`,
  }) {
    if (!store?.put || !store?.list)
      throw new Error('SourceCandidateService 需要可持久化记录的 Store');
    if (!snapshot?.id || !snapshot?.root || !Array.isArray(snapshot?.files))
      throw new Error('SourceCandidateService 需要有效的源码快照');
    this.store = store;
    this.snapshot = snapshot;
    this.now = now;
    this.id = id;
    this.batchId = batch_id;
  }

  get(candidateId) {
    const candidate = findRecord(this.store, 'source_candidate', candidateId);
    if (!candidate) fail('CANDIDATE_NOT_FOUND', `源码候选不存在：${candidateId}`);
    if (candidate.snapshot_id !== this.snapshot.id)
      fail('CANDIDATE_SNAPSHOT_MISMATCH', '源码候选不属于当前快照', {
        candidate_id: candidateId,
        candidate_snapshot_id: candidate.snapshot_id,
        snapshot_id: this.snapshot.id,
      });
    const review = findRecord(this.store, 'source_candidate_review', candidateId);
    if (!review) fail('CANDIDATE_REVIEW_NOT_FOUND', `源码候选缺少审核状态：${candidateId}`);
    return { candidate: structuredClone(candidate), review: structuredClone(review) };
  }

  list() {
    return this.store
      .list('source_candidate')
      .filter((candidate) => candidate.snapshot_id === this.snapshot.id)
      .map((candidate) => this.get(candidate.id));
  }

  async prepare(proposal, { reviewer_id, revises_candidate_id } = {}) {
    const normalized = normalizeProposal(proposal),
      reviewerId = normalizeReviewerId(reviewer_id),
      source = await materializeLocation(this.snapshot, normalized.source),
      target = await materializeLocation(this.snapshot, normalized.target),
      candidateId = this.id(),
      createdAt = this.now();
    if (findRecord(this.store, 'source_candidate', candidateId))
      fail('CANDIDATE_ID_CONFLICT', `源码候选 ID 已存在：${candidateId}`);
    const candidate = {
      schema_version: '1',
      id: candidateId,
      snapshot_id: this.snapshot.id,
      snapshot_version: this.snapshot.version ?? this.snapshot.id,
      source,
      target,
      relation: normalized.relation,
      reason: normalized.reason,
      created_at: createdAt,
      ...(revises_candidate_id ? { revises_candidate_id } : {}),
    };
    const review = {
      schema_version: '1',
      id: candidateId,
      candidate_id: candidateId,
      snapshot_id: this.snapshot.id,
      reviewer_id: reviewerId,
      status: 'pending',
      created_at: createdAt,
      updated_at: createdAt,
    };
    return { candidate, review };
  }

  persist(prepared) {
    if (findRecord(this.store, 'source_candidate', prepared.candidate.id))
      fail('CANDIDATE_ID_CONFLICT', `源码候选 ID 已存在：${prepared.candidate.id}`);
    this.store.put('source_candidate', prepared.candidate);
    this.store.put('source_candidate_review', prepared.review);
    return structuredClone(prepared);
  }

  async create(proposal, options = {}) {
    return this.persist(await this.prepare(proposal, options));
  }

  async review(input, { reviewer_id } = {}) {
    assertObject(input, '候选审核');
    assertKnownKeys(input, REVIEW_KEYS, '候选审核');
    const candidateId = normalizeText(input.candidate_id, 'candidate_id', 100),
      reviewerId = normalizeReviewerId(reviewer_id),
      decision = input.decision,
      current = this.get(candidateId);
    if (!DECISIONS.has(decision)) fail('INVALID_REVIEW_DECISION', '候选审核决定无效');
    if (current.review.reviewer_id !== reviewerId)
      fail('CANDIDATE_REVIEWER_MISMATCH', '只有创建该候选的 Agent 可以完成自审核', {
        candidate_id: candidateId,
      });
    if (current.review.status !== 'pending')
      fail('CANDIDATE_NOT_PENDING', `候选已处于 ${current.review.status} 状态，不能再次审核`, {
        candidate_id: candidateId,
        status: current.review.status,
      });

    if (decision === 'revise' || decision === 'reclassify') {
      assertObject(input.changes, 'changes');
      assertKnownKeys(input.changes, CHANGE_KEYS, 'changes');
      if (!Object.keys(input.changes).length)
        fail('EMPTY_CANDIDATE_REVISION', '修改候选时必须提供至少一个变更');
      if (
        decision === 'reclassify' &&
        Object.keys(input.changes).some((key) => !['relation', 'reason'].includes(key))
      )
        fail('INVALID_RECLASSIFICATION', '重新分类只能修改 relation 或 reason');
      const replacementProposal = {
        source: input.changes.source ?? {
          file: current.candidate.source.file,
          start_line: current.candidate.source.start_line,
          end_line: current.candidate.source.end_line,
        },
        target: input.changes.target ?? {
          file: current.candidate.target.file,
          start_line: current.candidate.target.start_line,
          end_line: current.candidate.target.end_line,
        },
        relation: input.changes.relation ?? current.candidate.relation,
        reason: input.changes.reason ?? current.candidate.reason,
      };
      const replacement = await this.create(replacementProposal, {
        reviewer_id: reviewerId,
        revises_candidate_id: candidateId,
      });
      const updatedAt = this.now();
      this.store.put('source_candidate_review', {
        ...current.review,
        status: 'superseded',
        decision,
        replacement_candidate_id: replacement.candidate.id,
        updated_at: updatedAt,
      });
      return {
        candidate: replacement.candidate,
        review: replacement.review,
        superseded_candidate_id: candidateId,
      };
    }

    if (input.changes !== undefined)
      fail('UNEXPECTED_CANDIDATE_CHANGES', `${decision} 决定不能携带 changes`);
    const status =
      decision === 'confirm'
        ? 'confirmed'
        : decision === 'needs_review'
          ? 'needs_review'
          : 'abandoned';
    const review = {
      ...current.review,
      status,
      decision,
      updated_at: this.now(),
    };
    this.store.put('source_candidate_review', review);
    return { candidate: current.candidate, review: structuredClone(review) };
  }

  getBatch(batchId, revision) {
    const id = batchRecordId(batchId, revision),
      batch = findRecord(this.store, 'source_candidate_batch', id),
      review = findRecord(this.store, 'source_candidate_batch_review', id);
    if (!batch || !review)
      fail('CANDIDATE_BATCH_NOT_FOUND', `源码候选批次不存在：${batchId} revision ${revision}`);
    if (batch.snapshot_id !== this.snapshot.id)
      fail('CANDIDATE_BATCH_SNAPSHOT_MISMATCH', '源码候选批次不属于当前快照');
    return {
      batch: structuredClone(batch),
      review: structuredClone(review),
      candidates: batch.entries.map((entry) => {
        const state = this.get(entry.candidate_id);
        return {
          local_id: entry.local_id,
          candidate: state.candidate,
          review: state.review,
        };
      }),
    };
  }

  async createBatch(input, { reviewer_id } = {}) {
    const normalized = normalizeBatchProposal(input),
      reviewerId = normalizeReviewerId(reviewer_id),
      prepared = [];
    for (const item of normalized.candidates)
      prepared.push({
        local_id: item.local_id,
        state: await this.prepare(item.proposal, { reviewer_id: reviewerId }),
      });
    const candidateIds = new Set();
    for (const item of prepared) {
      if (candidateIds.has(item.state.candidate.id))
        fail('CANDIDATE_ID_CONFLICT', `批次内候选 ID 重复：${item.state.candidate.id}`);
      candidateIds.add(item.state.candidate.id);
    }
    const batchId = this.batchId(),
      revision = 1,
      id = batchRecordId(batchId, revision),
      createdAt = this.now();
    if (findRecord(this.store, 'source_candidate_batch', id))
      fail('CANDIDATE_BATCH_ID_CONFLICT', `源码候选批次 ID 已存在：${batchId}`);
    for (const item of prepared) this.persist(item.state);
    this.store.put('source_candidate_batch', {
      schema_version: '1',
      id,
      batch_id: batchId,
      revision,
      snapshot_id: this.snapshot.id,
      module_id: normalized.module_id,
      entries: prepared.map((item) => ({
        local_id: item.local_id,
        candidate_id: item.state.candidate.id,
      })),
      created_at: createdAt,
    });
    this.store.put('source_candidate_batch_review', {
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
    assertObject(input, '批次审核');
    assertKnownKeys(input, BATCH_REVIEW_KEYS, '批次审核');
    const batchId = normalizeText(input.batch_id, 'batch_id', 100),
      reviewerId = normalizeReviewerId(reviewer_id),
      revision = input.revision;
    if (!Number.isInteger(revision) || revision < 1)
      fail('INVALID_BATCH_REVISION', 'revision 必须是正整数');
    const current = this.getBatch(batchId, revision);
    if (!BATCH_DECISIONS.has(input.decision)) fail('INVALID_BATCH_DECISION', '批次审核决定无效');
    if (current.review.reviewer_id !== reviewerId)
      fail('CANDIDATE_REVIEWER_MISMATCH', '只有创建该批次的 Agent 可以完成批量自审核');
    if (current.review.status !== 'pending')
      fail('CANDIDATE_BATCH_NOT_PENDING', `批次已处于 ${current.review.status} 状态，不能再次审核`);

    if (input.decision === 'confirm_all') {
      if (input.changes !== undefined)
        fail('UNEXPECTED_BATCH_CHANGES', 'confirm_all 不能携带 changes');
      for (const item of current.candidates) {
        if (item.review.reviewer_id !== reviewerId)
          fail('CANDIDATE_REVIEWER_MISMATCH', '批次包含不属于当前 Agent 的候选');
        if (!['pending', 'needs_review'].includes(item.review.status))
          fail('CANDIDATE_NOT_PENDING', `候选 ${item.candidate.id} 不能随批次确认`, {
            status: item.review.status,
          });
      }
      const updatedAt = this.now();
      for (const item of current.candidates)
        if (item.review.status === 'pending')
          this.store.put('source_candidate_review', {
            ...item.review,
            status: 'confirmed',
            decision: 'confirm',
            updated_at: updatedAt,
          });
      this.store.put('source_candidate_batch_review', {
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
      input.changes.length > MAX_SOURCE_CANDIDATES_PER_BATCH
    )
      fail('INVALID_BATCH_CHANGES', 'revise 必须包含至少一项候选修改');
    const entryByCandidate = new Map(
        current.batch.entries.map((entry) => [entry.candidate_id, entry]),
      ),
      changesByCandidate = new Map(),
      prepared = new Map();
    for (const [index, changes] of input.changes.entries()) {
      assertObject(changes, `changes[${index}]`);
      assertKnownKeys(changes, BATCH_CHANGE_KEYS, `changes[${index}]`);
      const candidateId = normalizeText(
        changes.candidate_id,
        `changes[${index}].candidate_id`,
        100,
      );
      if (!entryByCandidate.has(candidateId))
        fail('CANDIDATE_NOT_IN_BATCH', `候选不属于当前批次：${candidateId}`);
      if (changesByCandidate.has(candidateId))
        fail('DUPLICATE_BATCH_CHANGE', `同一候选不能在批次中修改两次：${candidateId}`);
      const action = changes.action ?? 'revise',
        fields = Object.keys(changes).filter((key) => !['candidate_id', 'action'].includes(key));
      if (!BATCH_CHANGE_ACTIONS.has(action)) fail('INVALID_BATCH_CHANGE', '候选修改动作无效');
      if (action !== 'revise' && fields.length)
        fail('UNEXPECTED_CANDIDATE_CHANGES', `${action} 不能同时修改候选字段`);
      if (action === 'revise' && !fields.length)
        fail('EMPTY_CANDIDATE_REVISION', '修改候选时必须提供新的位置、关系或理由');
      const state = this.get(candidateId);
      if (state.review.status !== 'pending' || state.review.reviewer_id !== reviewerId)
        fail('CANDIDATE_NOT_PENDING', `候选 ${candidateId} 不能修改`, {
          status: state.review.status,
        });
      changesByCandidate.set(candidateId, { ...changes, action, state });
      if (action === 'revise')
        prepared.set(
          candidateId,
          await this.prepare(replacementProposal(state.candidate, changes), {
            reviewer_id: reviewerId,
            revises_candidate_id: candidateId,
          }),
        );
    }
    const replacementIds = new Set();
    for (const state of prepared.values()) {
      if (replacementIds.has(state.candidate.id))
        fail('CANDIDATE_ID_CONFLICT', `批次内候选 ID 重复：${state.candidate.id}`);
      replacementIds.add(state.candidate.id);
    }
    const nextRevision = revision + 1,
      nextId = batchRecordId(batchId, nextRevision);
    if (findRecord(this.store, 'source_candidate_batch', nextId))
      fail('CANDIDATE_BATCH_REVISION_CONFLICT', `批次修订已经存在：${nextRevision}`);
    for (const state of prepared.values()) this.persist(state);
    const updatedAt = this.now(),
      nextEntries = [];
    for (const entry of current.batch.entries) {
      const change = changesByCandidate.get(entry.candidate_id);
      if (!change) {
        nextEntries.push(entry);
        continue;
      }
      if (change.action === 'abandon') {
        this.store.put('source_candidate_review', {
          ...change.state.review,
          status: 'abandoned',
          decision: 'abandon',
          updated_at: updatedAt,
        });
        continue;
      }
      if (change.action === 'needs_review') {
        this.store.put('source_candidate_review', {
          ...change.state.review,
          status: 'needs_review',
          decision: 'needs_review',
          updated_at: updatedAt,
        });
        nextEntries.push(entry);
        continue;
      }
      const replacement = prepared.get(entry.candidate_id);
      this.store.put('source_candidate_review', {
        ...change.state.review,
        status: 'superseded',
        decision: 'revise',
        replacement_candidate_id: replacement.candidate.id,
        updated_at: updatedAt,
      });
      nextEntries.push({ local_id: entry.local_id, candidate_id: replacement.candidate.id });
    }
    this.store.put('source_candidate_batch_review', {
      ...current.review,
      status: 'superseded',
      decision: 'revise',
      replacement_revision: nextRevision,
      updated_at: updatedAt,
    });
    this.store.put('source_candidate_batch', {
      ...current.batch,
      id: nextId,
      revision: nextRevision,
      entries: nextEntries,
      revises_revision: revision,
      created_at: updatedAt,
    });
    this.store.put('source_candidate_batch_review', {
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

/**
 * Agent-facing tools materialize and review one module-sized batch. A candidate
 * is never resubmitted on confirmation, and only revised entries are rebuilt.
 */
export function createSourceCandidateBatchTools({
  service,
  reviewer_id,
  onMaterialized = () => {},
  onConfirmed = () => {},
}) {
  const reviewerId = normalizeReviewerId(reviewer_id);
  return [
    {
      name: 'propose_source_candidate_batch',
      label: 'propose_source_candidate_batch',
      description:
        '一次提交当前模块的全部关系位置。系统批量读取固定快照并返回真实 quote；不要自行填写 quote。',
      parameters: sourceCandidateBatchProposalSchema,
      executionMode: 'sequential',
      async execute(_id, proposal) {
        const result = await service.createBatch(proposal, { reviewer_id: reviewerId }),
          preview = await onMaterialized(result.candidates.map((item) => item.candidate));
        return toolResult(preview === undefined ? result : { ...result, preview });
      },
    },
    {
      name: 'review_source_candidate_batch',
      label: 'review_source_candidate_batch',
      description:
        '批量审核系统生成的完整候选。全部正确时只按 batch_id 和 revision 确认；修改时只提交变化项。',
      parameters: sourceCandidateBatchReviewSchema,
      executionMode: 'sequential',
      async execute(_id, review) {
        const result = await service.reviewBatch(review, { reviewer_id: reviewerId }),
          candidates = result.candidates.map((item) => item.candidate);
        const extra =
          result.review.status === 'confirmed'
            ? await onConfirmed(candidates)
            : await onMaterialized(candidates);
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
