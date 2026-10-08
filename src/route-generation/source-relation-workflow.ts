import {
  createValidatedSourceCandidateBatchTools,
  createRelationReviewerTool,
  SourceRelationValidationService,
} from './source-relation-validation.ts';
import { SourceCandidateError, SourceCandidateService } from './source-candidates.ts';

function issue(code, message, details = {}) {
  return { code, message, ...details };
}

function fail(code, message, details = {}) {
  throw new SourceCandidateError(code, message, details);
}

function batchContaining(store, snapshotId, moduleId, candidateId) {
  return store
    .list('source_candidate_batch')
    .filter(
      (batch) =>
        batch.snapshot_id === snapshotId &&
        batch.module_id === moduleId &&
        batch.entries?.some((entry) => entry.candidate_id === candidateId),
    )
    .sort((left, right) => right.revision - left.revision)
    .find((batch) => {
      const review = store
        .list('source_candidate_batch_review')
        .find((item) => item.id === batch.id);
      return review?.status === 'confirmed';
    });
}

function confirmedBatchContaining(store, snapshotId, candidateId) {
  return store
    .list('source_candidate_batch')
    .filter(
      (batch) =>
        batch.snapshot_id === snapshotId &&
        batch.entries?.some((entry) => entry.candidate_id === candidateId),
    )
    .sort((left, right) => right.revision - left.revision)
    .find((batch) =>
      store
        .list('source_candidate_batch_review')
        .some((review) => review.id === batch.id && review.status === 'confirmed'),
    );
}

function candidateIdsInDecision(decision) {
  if (decision?.status !== 'ready') return [];
  return [
    ...(decision.execution?.links ?? []).map((link) => link?.candidate_id),
    decision.execution?.outgoing?.candidate_id,
  ].filter(Boolean);
}

function candidateIdsInFlows(flows) {
  const ids = [];
  for (const flow of flows ?? []) {
    ids.push(...(flow.execution?.links ?? []).map((link) => link?.candidate_id));
    ids.push(flow.execution?.outgoing?.candidate_id);
    ids.push(flow.execution?.handoff_from_previous?.candidate_id);
  }
  return [...new Set(ids.filter(Boolean))];
}

function relationSite(location) {
  return {
    location: {
      file: location.file,
      start: { line: location.start_line },
      end: { line: location.end_line },
    },
    quote: location.quote,
  };
}

function proposalSignature(value) {
  return JSON.stringify({
    source: value.source && {
      file: value.source.file,
      start_line: value.source.start_line,
      end_line: value.source.end_line,
    },
    target: value.target && {
      file: value.target.file,
      start_line: value.target.start_line,
      end_line: value.target.end_line,
    },
    relation: value.relation,
    reason: value.reason?.trim(),
  });
}

function overlaps(location, block) {
  return (
    location?.file === block?.file &&
    location.start_line <= block.end_line &&
    block.start_line <= location.end_line
  );
}

/**
 * Production integration for the location-only relation protocol. It is the
 * only component allowed to turn a confirmed source candidate into route data.
 */
export class SourceRelationWorkflow {
  constructor({ store, snapshot, sourceGraph, now }) {
    this.store = store;
    this.snapshot = snapshot;
    this.candidates = new SourceCandidateService({ store, snapshot, now });
    this.validation = new SourceRelationValidationService({
      store,
      snapshot,
      sourceGraph,
      candidateService: this.candidates,
      now,
    });
  }

  createModuleTools({ module_id, reviewer_id, onConfirmed = () => {} }) {
    const tools = createValidatedSourceCandidateBatchTools({
      candidateService: this.candidates,
      validationService: this.validation,
      reviewer_id,
    });
    return tools.map((tool) => ({
      ...tool,
      execute: async (id, value, ...rest) => {
        if (tool.name === 'propose_source_candidate_batch') {
          if (value?.module_id !== module_id)
            fail('CANDIDATE_MODULE_MISMATCH', `候选批次必须属于当前模块 ${module_id}`, {
              module_id: value?.module_id,
            });
          const rejected = this.store
            .list('source_candidate_validation')
            .filter((validation) => validation.status === 'rejected')
            .flatMap((validation) => {
              try {
                const state = this.candidates.get(validation.candidate_id);
                return batchContaining(
                  this.store,
                  this.snapshot.id,
                  module_id,
                  validation.candidate_id,
                )
                  ? [proposalSignature(state.candidate)]
                  : [];
              } catch {
                return [];
              }
            });
          const repeated = value?.candidates?.find((candidate) =>
            rejected.includes(proposalSignature(candidate)),
          );
          if (repeated)
            fail(
              'REPEATED_REJECTED_RELATION',
              '该位置和关系已经被确定性检查拒绝；必须修改位置、分类或理由，不能原样重试',
              { local_id: repeated.local_id },
            );
        }
        const result = await tool.execute(id, value, ...rest);
        if (tool.name === 'review_source_candidate_batch') {
          const state = this.candidates.getBatch(value.batch_id, value.revision);
          if (state.review.status === 'confirmed') onConfirmed(state);
        }
        return result;
      },
    }));
  }

  createReviewerTool({ reviewer_id }) {
    return createRelationReviewerTool({ validationService: this.validation, reviewer_id });
  }

  hydrateDecision(decision, { module_id, allowed_candidate_ids } = {}) {
    if (decision?.status !== 'ready') return structuredClone(decision);
    const ids = candidateIdsInDecision(decision),
      uniqueIds = new Set(ids),
      allowed = allowed_candidate_ids ? new Set(allowed_candidate_ids) : null;
    if (ids.length !== uniqueIds.size)
      fail('DUPLICATE_RELATION_CANDIDATE', '同一个候选不能表示两条不同的执行关系');
    if (allowed && (ids.length !== allowed.size || ids.some((id) => !allowed.has(id))))
      fail(
        'CANDIDATE_BATCH_REFERENCE_MISMATCH',
        '模块提交必须且只能引用本会话刚刚确认的完整候选批次',
        { expected_candidate_ids: [...allowed], submitted_candidate_ids: ids },
      );

    const hydrate = (relation) => {
      if (!relation?.candidate_id)
        fail('MISSING_RELATION_CANDIDATE', '每条执行关系都必须引用已确认的 candidate_id');
      const batch = batchContaining(this.store, this.snapshot.id, module_id, relation.candidate_id),
        state = this.candidates.get(relation.candidate_id);
      if (!batch)
        fail('UNCONFIRMED_RELATION_CANDIDATE', '关系候选不属于当前模块的已确认批次', {
          module_id,
          candidate_id: relation.candidate_id,
        });
      if (state.review.status !== 'confirmed')
        fail('CANDIDATE_NOT_SELF_REVIEWED', '关系候选尚未完成原 Agent 自审核', {
          candidate_id: relation.candidate_id,
          status: state.review.status,
        });
      const validation = this.validation.validate(relation.candidate_id);
      if (validation.status === 'rejected')
        fail(
          'RELATION_CANDIDATE_REJECTED',
          '确定性检查拒绝了该关系；请依据 issues 重新取证并创建新批次，不要原样重试',
          { candidate_id: relation.candidate_id, issues: validation.issues },
        );
      const targetName = validation.facts?.target_entity?.name;
      return {
        ...relation,
        relation: state.candidate.relation,
        description: state.candidate.reason,
        call_line: state.candidate.source.start_line,
        candidate_source: {
          file: state.candidate.source.file,
          start_line: state.candidate.source.start_line,
          end_line: state.candidate.source.end_line,
        },
        candidate_target: {
          file: state.candidate.target.file,
          start_line: state.candidate.target.start_line,
          end_line: state.candidate.target.end_line,
        },
        ...(targetName ? { callee: targetName } : {}),
      };
    };
    return {
      ...structuredClone(decision),
      execution: {
        ...decision.execution,
        links: (decision.execution?.links ?? []).map(hydrate),
        ...(decision.execution?.outgoing ? { outgoing: hydrate(decision.execution.outgoing) } : {}),
      },
    };
  }

  validateDecision(decision, { module_id } = {}) {
    if (decision?.status !== 'ready') return [];
    const issues = [],
      ids = candidateIdsInDecision(decision),
      seen = new Set();
    for (const id of ids) {
      if (seen.has(id)) {
        issues.push(
          issue('DUPLICATE_RELATION_CANDIDATE', '同一个候选不能表示两条不同的执行关系', {
            candidate_id: id,
          }),
        );
        continue;
      }
      seen.add(id);
      try {
        if (!batchContaining(this.store, this.snapshot.id, module_id, id))
          issues.push(
            issue(
              'UNCONFIRMED_RELATION_CANDIDATE',
              `关系候选 ${id} 不属于模块 ${module_id} 的已确认批次`,
              { candidate_id: id },
            ),
          );
        const state = this.candidates.get(id),
          validation = this.validation.validate(id);
        if (state.review.status !== 'confirmed')
          issues.push(
            issue('CANDIDATE_NOT_SELF_REVIEWED', `关系候选 ${id} 尚未完成原 Agent 自审核`, {
              candidate_id: id,
              status: state.review.status,
            }),
          );
        if (validation.status === 'rejected')
          issues.push(
            issue('RELATION_CANDIDATE_REJECTED', `关系候选 ${id} 没有通过确定性检查`, {
              candidate_id: id,
              validation_issues: validation.issues,
            }),
          );
      } catch (error) {
        issues.push(
          issue(
            error.code ?? 'RELATION_CANDIDATE_INVALID',
            error.message ?? String(error),
            error.details ?? {},
          ),
        );
      }
    }
    const submittedRelations =
      (decision.execution?.links?.length ?? 0) + (decision.execution?.outgoing ? 1 : 0);
    if (ids.length !== submittedRelations)
      issues.push(
        issue(
          'MISSING_RELATION_CANDIDATE',
          '每条模块内关系和模块出口都必须引用一个已确认的 candidate_id',
        ),
      );
    return issues;
  }

  validateResolvedFlow(flow, previous) {
    if (flow?.status !== 'ready') return [];
    const issues = [];
    for (const link of flow.execution?.links ?? []) {
      if (!link.candidate_id) continue;
      const from = flow.blocks?.[link.from_block_order - 1],
        to = flow.blocks?.[link.to_block_order - 1];
      if (link.relation !== 'handoff' && !overlaps(link.candidate_source, from))
        issues.push(
          issue('RELATION_SOURCE_BLOCK_MISMATCH', '候选 source 不在其声称的来源代码块中', {
            candidate_id: link.candidate_id,
            source: link.candidate_source,
            from_block_order: link.from_block_order,
          }),
        );
      if (!overlaps(link.candidate_target, to))
        issues.push(
          issue('RELATION_TARGET_BLOCK_MISMATCH', '候选 target 不在其声称的目标代码块中', {
            candidate_id: link.candidate_id,
            target: link.candidate_target,
            to_block_order: link.to_block_order,
          }),
        );
    }
    const outgoing = flow.execution?.outgoing;
    if (outgoing?.candidate_id && outgoing.relation !== 'handoff') {
      const from = flow.blocks?.[outgoing.from_block_order - 1];
      if (!overlaps(outgoing.candidate_source, from))
        issues.push(
          issue('RELATION_SOURCE_BLOCK_MISMATCH', '模块出口 source 不在其来源代码块中', {
            candidate_id: outgoing.candidate_id,
            source: outgoing.candidate_source,
            from_block_order: outgoing.from_block_order,
          }),
        );
    }
    const handoff = flow.execution?.handoff_from_previous;
    if (handoff?.candidate_id) {
      const from = previous?.blocks?.[handoff.from_block_order - 1],
        to = flow.blocks?.[handoff.to_block_order - 1];
      if (handoff.relation !== 'handoff' && !overlaps(handoff.candidate_source, from))
        issues.push(
          issue('RELATION_SOURCE_BLOCK_MISMATCH', '跨模块候选 source 不在前一模块来源块中', {
            candidate_id: handoff.candidate_id,
          }),
        );
      if (!overlaps(handoff.candidate_target, to))
        issues.push(
          issue('RELATION_TARGET_BLOCK_MISMATCH', '跨模块候选 target 不在当前模块目标块中', {
            candidate_id: handoff.candidate_id,
          }),
        );
    }
    return issues;
  }

  candidateIds(flows) {
    return candidateIdsInFlows(flows);
  }

  reviewInput(candidateIds) {
    return this.validation.reviewBatch(candidateIds);
  }

  acceptanceIssues(candidateIds) {
    const issues = [];
    for (const candidateId of candidateIds) {
      const validation = this.validation.validate(candidateId);
      if (validation.status === 'verified') continue;
      if (validation.status === 'rejected') {
        issues.push(
          issue('RELATION_CANDIDATE_REJECTED', '路线包含确定性检查已拒绝的关系', {
            candidate_id: candidateId,
            validation_issues: validation.issues,
          }),
        );
        continue;
      }
      const verdict = this.store
        .list('source_candidate_verdict')
        .find((item) => item.candidate_id === candidateId);
      if (verdict?.status !== 'agent_reviewed')
        issues.push(
          issue('RELATION_REVIEW_REQUIRED', '该关系必须先通过独立 Agent 的批量语义审核', {
            candidate_id: candidateId,
            verdict: verdict ?? null,
          }),
        );
    }
    return issues;
  }

  recoveryRequirements(candidateIds) {
    const requirements = [];
    for (const candidateId of candidateIds) {
      const verdict = this.store
        .list('source_candidate_verdict')
        .find((item) => item.candidate_id === candidateId);
      if (!verdict || verdict.status === 'agent_reviewed') continue;
      const batch = confirmedBatchContaining(this.store, this.snapshot.id, candidateId);
      requirements.push({
        candidate_id: candidateId,
        module_id: batch?.module_id,
        status: verdict.status,
        decision: verdict.decision,
        reason: verdict.reason,
        ...(verdict.final_relation ? { final_relation: verdict.final_relation } : {}),
        action: verdict.status === 'replan_required' || !batch?.module_id ? 'replan' : 'revise',
        instruction:
          verdict.status === 'revision_requested'
            ? `关系 ${candidateId} 需要按审核结论重新分类为 ${verdict.final_relation}：${verdict.reason}`
            : verdict.status === 'evidence_requested'
              ? `关系 ${candidateId} 的现有源码范围不足，请补查并提交更准确的位置：${verdict.reason}`
              : verdict.status === 'rejected'
                ? `关系 ${candidateId} 不支持原结论，请重新调查该模块并替换或移除它：${verdict.reason}`
                : `关系 ${candidateId} 无法通过局部修订闭合，需要重新规划模块：${verdict.reason}`,
      });
    }
    return requirements;
  }

  materialize(candidateId) {
    const state = this.candidates.get(candidateId),
      validation = this.validation.validate(candidateId),
      verdict = this.store
        .list('source_candidate_verdict')
        .find((item) => item.candidate_id === candidateId);
    if (
      validation.status !== 'verified' &&
      !(validation.status === 'needs_review' && verdict?.status === 'agent_reviewed')
    )
      fail('RELATION_NOT_ACCEPTED', '只有完成全部审核的关系才能锁入路线', {
        candidate_id: candidateId,
        validation_status: validation.status,
        verdict_status: verdict?.status,
      });
    const finalRelation = verdict?.final_relation ?? state.candidate.relation,
      stable = ['calls', 'returns', 'continues', 'handoff'].includes(finalRelation);
    return {
      candidate_id: candidateId,
      type: stable ? finalRelation : 'custom',
      ...(stable ? {} : { custom_relation: finalRelation }),
      source_site: relationSite(state.candidate.source),
      target_site: relationSite(state.candidate.target),
      planning_note: state.candidate.reason,
      verification: {
        status: validation.status === 'verified' ? 'deterministic' : 'agent_reviewed',
        method: validation.method,
        ...(verdict ? { reviewer_id: verdict.reviewer_id, reason: verdict.reason } : {}),
      },
    };
  }
}

export function relationCandidateIds(decision) {
  return candidateIdsInDecision(decision);
}
