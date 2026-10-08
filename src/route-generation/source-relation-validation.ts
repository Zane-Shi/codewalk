import {
  buildGraphIndex,
  compactEntityFileIndex,
  compactEntityId,
  compactEntityIsSymbol,
} from './graph-index.ts';
import { createSourceCandidateBatchTools, SourceCandidateError } from './source-candidates.ts';

const RELATIONS = new Set(['calls', 'returns', 'continues', 'handoff']);
const REVIEW_DECISIONS = new Set([
  'accept',
  'reclassify',
  'reject',
  'request_evidence',
  'replan',
  'custom',
]);
const VERDICT_KEYS = new Set(['candidate_id', 'decision', 'reason', 'relation', 'custom_relation']);

const string = (maxLength = 1200) => ({ type: 'string', minLength: 1, maxLength });
const reviewerDecisionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['candidate_id', 'decision', 'reason'],
  properties: {
    candidate_id: string(100),
    decision: { type: 'string', enum: [...REVIEW_DECISIONS] },
    reason: string(),
    relation: { type: 'string', enum: [...RELATIONS] },
    custom_relation: string(100),
  },
};

export const relationReviewerSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['reviews'],
  properties: {
    reviews: {
      type: 'array',
      minItems: 1,
      maxItems: 64,
      items: reviewerDecisionSchema,
    },
  },
};

function issue(code, message, details = {}) {
  return { code, message, ...details };
}

function fail(code, message, details = {}) {
  throw new SourceCandidateError(code, message, details);
}

function record(store, kind, id) {
  return store.list(kind).find((item) => item.id === id);
}

function text(value, label, maxLength = 1200) {
  if (typeof value !== 'string' || !value.trim())
    fail('INVALID_REVIEW_VERDICT', `${label} 不能为空`);
  if (value.length > maxLength)
    fail('INVALID_REVIEW_VERDICT', `${label} 不能超过 ${maxLength} 个字符`);
  return value.trim();
}

function knownKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('INVALID_REVIEW_VERDICT', `${label} 必须是对象`);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length)
    fail('UNKNOWN_REVIEW_FIELD', `${label} 包含不允许的字段：${unknown.join(', ')}`, {
      fields: unknown,
    });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function entitySummary(index, entityIndex) {
  if (entityIndex === undefined) return null;
  const entity = index.graph.entities[entityIndex],
    file = index.graph.files[compactEntityFileIndex(entity)]?.[0];
  return {
    index: entityIndex,
    id: compactEntityId(entity),
    name: entity[2],
    file,
    start_line: entity[5],
    end_line: entity[6],
  };
}

function entityAt(index, location) {
  const fileIndex = index.graph.files.findIndex((file) => file[0] === location.file);
  if (fileIndex < 0) return undefined;
  return index.graph.entities
    .map((entity, entityIndex) => ({ entity, entityIndex }))
    .filter(
      ({ entity }) =>
        compactEntityIsSymbol(entity) &&
        compactEntityFileIndex(entity) === fileIndex &&
        entity[5] <= location.start_line &&
        entity[6] >= location.end_line,
    )
    .sort(
      (left, right) =>
        left.entity[6] - left.entity[5] - (right.entity[6] - right.entity[5]) ||
        left.entityIndex - right.entityIndex,
    )[0]?.entityIndex;
}

function directCallInQuote(quote, targetName) {
  if (!targetName) return false;
  const name = escapeRegExp(targetName.split('.').at(-1));
  return new RegExp(`(?:^|[^\\w$])(?:new\\s+)?(?:[A-Za-z_$][\\w$]*\\.)*${name}\\s*\\(`).test(quote);
}

function graphCall(index, from, to, source) {
  if (from === undefined || to === undefined) return { found: false, exact: false, lines: [] };
  const edge = index.callEdges.find((item) => item[0] === from && item[1] === to);
  if (!edge) return { found: false, exact: false, lines: [] };
  const lines = Array.isArray(edge[2]) ? [...edge[2]] : [];
  return {
    found: true,
    exact: lines.some((line) => line >= source.start_line && line <= source.end_line),
    lines,
  };
}

function graphReference(index, from, to) {
  return (
    from !== undefined &&
    to !== undefined &&
    index.referenceEdges.some((edge) => edge[0] === from && edge[1] === to)
  );
}

function factsFor(index, candidate) {
  const sourceEntity = entityAt(index, candidate.source),
    targetEntity = entityAt(index, candidate.target),
    source = entitySummary(index, sourceEntity),
    target = entitySummary(index, targetEntity),
    call = graphCall(index, sourceEntity, targetEntity, candidate.source),
    lexicalCall = directCallInQuote(candidate.source.quote, target?.name);
  return {
    sourceEntity,
    targetEntity,
    source,
    target,
    call,
    lexicalCall,
    directCallFound: call.exact || lexicalCall,
  };
}

function verified(candidate, method, facts) {
  return {
    status: 'verified',
    relation: candidate.relation,
    verification: 'deterministic',
    method,
    facts,
    issues: [],
  };
}

function unresolved(candidate, code, message, facts, details = {}) {
  return {
    status: 'needs_review',
    relation: candidate.relation,
    verification: 'pending_agent_review',
    method: null,
    facts,
    issues: [issue(code, message, details)],
  };
}

function rejected(candidate, code, message, facts, details = {}) {
  return {
    status: 'rejected',
    relation: candidate.relation,
    verification: 'deterministic',
    method: null,
    facts,
    issues: [issue(code, message, details)],
  };
}

function sameEntity(left, right) {
  return left !== undefined && right !== undefined && left === right;
}

export class SourceRelationValidationService {
  constructor({ store, snapshot, sourceGraph, candidateService, now = () => Date.now() }) {
    if (!store?.put || !store?.list)
      throw new Error('SourceRelationValidationService 需要可持久化记录的 Store');
    if (!snapshot?.id || !candidateService)
      throw new Error('SourceRelationValidationService 需要快照和候选服务');
    if (sourceGraph?.snapshot_id && sourceGraph.snapshot_id !== snapshot.id)
      throw new Error('关系校验图不属于当前源码快照');
    this.store = store;
    this.snapshot = snapshot;
    this.candidateService = candidateService;
    this.index = buildGraphIndex(sourceGraph);
    this.now = now;
  }

  confirmedCallBasis(sourceEntity, targetEntity, excludingCandidateId) {
    for (const validation of this.store.list('source_candidate_validation')) {
      if (validation.id === excludingCandidateId) continue;
      const verdict = record(this.store, 'source_candidate_verdict', validation.candidate_id),
        acceptedByAgent =
          verdict?.status === 'agent_reviewed' && verdict.final_relation === 'calls';
      if (validation.status !== 'verified' && !acceptedByAgent) continue;
      const state = this.candidateService.get(validation.candidate_id);
      if (state.candidate.relation !== 'calls' && !acceptedByAgent) continue;
      const facts = factsFor(this.index, state.candidate);
      if (facts.sourceEntity === targetEntity && facts.targetEntity === sourceEntity)
        return state.candidate;
    }
    return null;
  }

  determine(candidate, { batch_candidates = [] } = {}) {
    const context = factsFor(this.index, candidate),
      publicFacts = {
        source_entity: context.source,
        target_entity: context.target,
        graph_call_found: context.call.found,
        graph_call_lines: context.call.lines,
        graph_reference_found: graphReference(
          this.index,
          context.sourceEntity,
          context.targetEntity,
        ),
        direct_call_found: context.directCallFound,
      };
    if (candidate.relation === 'calls') {
      if (!context.target)
        return unresolved(
          candidate,
          'CALL_TARGET_UNRESOLVED',
          '目标位置无法唯一对应代码图中的函数或方法，需要审核目标位置',
          publicFacts,
          { target: candidate.target },
        );
      if (context.call.exact) return verified(candidate, 'code_graph_call_site', publicFacts);
      if (context.lexicalCall) return verified(candidate, 'source_direct_call', publicFacts);
      return rejected(
        candidate,
        'DIRECT_CALL_NOT_FOUND',
        `source quote 中没有对目标符号 ${context.target.name} 的直接调用`,
        publicFacts,
        {
          source: candidate.source,
          target: candidate.target,
          ...(context.call.lines.length ? { candidate_call_lines: context.call.lines } : {}),
        },
      );
    }

    if (candidate.relation === 'returns') {
      if (!context.source || !context.target)
        return unresolved(
          candidate,
          'RETURN_CONTEXT_UNRESOLVED',
          '返回关系的两端无法唯一对应函数，需要审核执行上下文',
          publicFacts,
        );
      const basis =
        this.confirmedCallBasis(context.sourceEntity, context.targetEntity, candidate.id) ??
        batch_candidates.find((item) => {
          if (item.id === candidate.id || item.relation !== 'calls') return false;
          const facts = factsFor(this.index, item);
          return (
            facts.directCallFound &&
            facts.sourceEntity === context.targetEntity &&
            facts.targetEntity === context.sourceEntity
          );
        });
      if (basis)
        return basis.source.file === candidate.target.file &&
          candidate.target.start_line < basis.source.start_line
          ? rejected(
              candidate,
              'RETURN_RESUME_ORDER_INVALID',
              'returns 的目标位置不能早于已验证调用点',
              { ...publicFacts, basis_candidate_id: basis.id },
              { call_site: basis.source, resume_site: candidate.target },
            )
          : verified(candidate, 'verified_caller_basis', {
              ...publicFacts,
              basis_candidate_id: basis.id,
            });
      const reverse = graphCall(
        this.index,
        context.targetEntity,
        context.sourceEntity,
        candidate.target,
      );
      return rejected(
        candidate,
        'RETURN_CALL_BASIS_MISSING',
        'returns 必须返回到先前已经确认的直接调用方',
        { ...publicFacts, reverse_graph_call_found: reverse.found },
        {
          required_relation: {
            relation: 'calls',
            from_entity: context.target.id,
            to_entity: context.source.id,
          },
        },
      );
    }

    if (candidate.relation === 'continues') {
      if (!context.source || !context.target)
        return unresolved(
          candidate,
          'CONTINUATION_CONTEXT_UNRESOLVED',
          '继续执行关系无法唯一对应同一函数，需要审核执行上下文',
          publicFacts,
        );
      if (!sameEntity(context.sourceEntity, context.targetEntity))
        return rejected(
          candidate,
          'CONTINUATION_CONTEXT_MISMATCH',
          'continues 的两个位置必须属于同一执行上下文；跨函数或框架转移应重新分类',
          publicFacts,
          { suggested_relation: 'handoff' },
        );
      if (candidate.source.end_line >= candidate.target.start_line)
        return rejected(
          candidate,
          'CONTINUATION_ORDER_INVALID',
          'continues 的目标位置必须位于来源位置之后且不能重叠',
          publicFacts,
          { source: candidate.source, target: candidate.target },
        );
      return verified(candidate, 'same_symbol_forward_order', publicFacts);
    }

    if (context.directCallFound)
      return rejected(
        candidate,
        'HANDOFF_IS_DIRECT_CALL',
        '所选位置存在对目标符号的直接调用，应使用 calls',
        publicFacts,
        { suggested_relation: 'calls' },
      );
    return unresolved(
      candidate,
      'HANDOFF_REQUIRES_SEMANTIC_REVIEW',
      'handoff 是间接运行时语义，确定性代码只排除硬冲突，由路线审核 Agent 批量判断',
      publicFacts,
      { review_scope: 'route_batch', review_reason: 'indirect_runtime_semantics' },
    );
  }

  validate(candidateId) {
    const existing = record(this.store, 'source_candidate_validation', candidateId);
    if (existing) return structuredClone(existing);
    const state = this.candidateService.get(candidateId);
    if (!['confirmed', 'needs_review'].includes(state.review.status))
      fail('CANDIDATE_NOT_SELF_REVIEWED', '候选必须先完成原 Agent 自审核才能验证', {
        candidate_id: candidateId,
        status: state.review.status,
      });
    let result = this.determine(state.candidate);
    if (state.review.status === 'needs_review' && result.status === 'verified')
      result = unresolved(
        state.candidate,
        'AGENT_REQUESTED_REVIEW',
        '原 Agent 明确请求独立审核，确定性事实将作为审核输入',
        result.facts,
        { deterministic_method: result.method },
      );
    const validation = {
      schema_version: '1',
      id: candidateId,
      candidate_id: candidateId,
      snapshot_id: this.snapshot.id,
      ...result,
      created_at: this.now(),
    };
    this.store.put('source_candidate_validation', validation);
    return structuredClone(validation);
  }

  preview(candidateId) {
    const state = this.candidateService.get(candidateId);
    if (!['pending', 'needs_review'].includes(state.review.status))
      fail('CANDIDATE_NOT_PENDING', '只有尚未完成批量确认的候选可以生成自审核预览', {
        candidate_id: candidateId,
        status: state.review.status,
      });
    let result = this.determine(state.candidate);
    if (state.review.status === 'needs_review' && result.status === 'verified')
      result = unresolved(
        state.candidate,
        'AGENT_REQUESTED_REVIEW',
        '原 Agent 明确请求独立审核，确定性事实将作为审核输入',
        result.facts,
        { deterministic_method: result.method },
      );
    return {
      schema_version: '1',
      candidate_id: candidateId,
      snapshot_id: this.snapshot.id,
      ...result,
    };
  }

  previewBatch(candidates) {
    return candidates.map((candidate) => {
      const state = this.candidateService.get(candidate.id);
      if (!['pending', 'needs_review'].includes(state.review.status))
        fail('CANDIDATE_NOT_PENDING', '只有尚未完成批量确认的候选可以生成自审核预览', {
          candidate_id: candidate.id,
          status: state.review.status,
        });
      let result = this.determine(state.candidate, { batch_candidates: candidates });
      if (state.review.status === 'needs_review' && result.status === 'verified')
        result = unresolved(
          state.candidate,
          'AGENT_REQUESTED_REVIEW',
          '原 Agent 明确请求独立审核，确定性事实将作为审核输入',
          result.facts,
          { deterministic_method: result.method },
        );
      return {
        schema_version: '1',
        candidate_id: candidate.id,
        snapshot_id: this.snapshot.id,
        ...result,
      };
    });
  }

  reviewBatch(candidateIds) {
    const requested = candidateIds ? new Set(candidateIds) : null,
      output = [];
    for (const validation of this.store.list('source_candidate_validation')) {
      if (
        validation.snapshot_id !== this.snapshot.id ||
        validation.status !== 'needs_review' ||
        requested?.has(validation.candidate_id) === false ||
        record(this.store, 'source_candidate_verdict', validation.candidate_id)
      )
        continue;
      const state = this.candidateService.get(validation.candidate_id);
      output.push({ candidate: state.candidate, validation });
    }
    return output.sort((left, right) => left.candidate.id.localeCompare(right.candidate.id));
  }

  prepareVerdict(input, { reviewer_id } = {}) {
    knownKeys(input, VERDICT_KEYS, '审核结论');
    const candidateId = text(input.candidate_id, 'candidate_id', 100),
      reviewerId = text(reviewer_id, 'reviewer_id', 200),
      reason = text(input.reason, 'reason'),
      state = this.candidateService.get(candidateId),
      validation = this.validate(candidateId);
    if (!REVIEW_DECISIONS.has(input.decision)) fail('INVALID_REVIEW_VERDICT', '独立审核决定无效');
    if (state.review.reviewer_id === reviewerId)
      fail('INDEPENDENT_REVIEW_REQUIRED', '独立审核不能由创建候选的同一个 Agent 完成');
    if (validation.status !== 'needs_review')
      fail('REVIEW_NOT_REQUIRED', `候选状态为 ${validation.status}，不需要独立审核`);
    if (record(this.store, 'source_candidate_verdict', candidateId))
      fail('REVIEW_ALREADY_SUBMITTED', '该候选已经有独立审核结论');

    let status, finalRelation;
    if (input.decision === 'accept') {
      if (input.relation || input.custom_relation)
        fail('UNEXPECTED_REVIEW_RELATION', '接受候选时不能修改关系');
      status = 'agent_reviewed';
      finalRelation = state.candidate.relation;
    } else if (input.decision === 'custom') {
      if (input.relation)
        fail('UNEXPECTED_REVIEW_RELATION', 'custom 决定使用 custom_relation 描述特殊关系');
      finalRelation = text(input.custom_relation, 'custom_relation', 100);
      status = 'agent_reviewed';
    } else if (input.decision === 'reclassify') {
      if (!RELATIONS.has(input.relation) || input.relation === state.candidate.relation)
        fail('INVALID_RECLASSIFICATION', '重新分类必须给出一个不同的稳定关系');
      if (input.custom_relation)
        fail('UNEXPECTED_REVIEW_RELATION', '重新分类不能同时提交 custom_relation');
      status = 'revision_requested';
      finalRelation = input.relation;
    } else {
      if (input.relation || input.custom_relation)
        fail('UNEXPECTED_REVIEW_RELATION', `${input.decision} 决定不能携带关系字段`);
      status =
        input.decision === 'reject'
          ? 'rejected'
          : input.decision === 'request_evidence'
            ? 'evidence_requested'
            : 'replan_required';
    }
    const verdict = {
      schema_version: '1',
      id: candidateId,
      candidate_id: candidateId,
      snapshot_id: this.snapshot.id,
      reviewer_id: reviewerId,
      decision: input.decision,
      reason,
      status,
      ...(finalRelation ? { final_relation: finalRelation } : {}),
      verification: status === 'agent_reviewed' ? 'agent_reviewed' : 'pending_revision',
      created_at: this.now(),
    };
    return verdict;
  }

  persistVerdict(verdict) {
    if (record(this.store, 'source_candidate_verdict', verdict.candidate_id))
      fail('REVIEW_ALREADY_SUBMITTED', '该候选已经有独立审核结论');
    this.store.put('source_candidate_verdict', verdict);
    return structuredClone(verdict);
  }

  submitVerdict(input, options) {
    return this.persistVerdict(this.prepareVerdict(input, options));
  }
}

function toolResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

export function createValidatedSourceCandidateBatchTools({
  candidateService,
  validationService,
  reviewer_id,
}) {
  return createSourceCandidateBatchTools({
    service: candidateService,
    reviewer_id,
    onMaterialized: (candidates) => validationService.previewBatch(candidates),
    onConfirmed: (candidates) => {
      const ordered = [...candidates].sort(
        (left, right) => Number(right.relation === 'calls') - Number(left.relation === 'calls'),
      );
      for (const candidate of ordered) validationService.validate(candidate.id);
      return candidates.map((candidate) => validationService.validate(candidate.id));
    },
  });
}

export function createRelationReviewerTool({ validationService, reviewer_id }) {
  const reviewerId = text(reviewer_id, 'reviewer_id', 200);
  return {
    name: 'submit_relation_reviews',
    label: 'submit_relation_reviews',
    description: '批量提交需要独立语义审核的关系结论。quote 已由系统固定，不要重新提交源码内容。',
    parameters: relationReviewerSchema,
    executionMode: 'sequential',
    async execute(_id, value) {
      knownKeys(value, new Set(['reviews']), '批量审核');
      if (!Array.isArray(value.reviews) || value.reviews.length < 1 || value.reviews.length > 64)
        fail('INVALID_REVIEW_BATCH', '批量审核必须包含 1–64 条结论');
      const ids = new Set();
      const prepared = [];
      for (const review of value.reviews) {
        if (ids.has(review?.candidate_id))
          fail('DUPLICATE_REVIEW', `候选 ${review.candidate_id} 在同一批次重复出现`);
        ids.add(review?.candidate_id);
        prepared.push(validationService.prepareVerdict(review, { reviewer_id: reviewerId }));
      }
      const results = prepared.map((verdict) => validationService.persistVerdict(verdict));
      return toolResult({ reviews: results });
    },
  };
}
