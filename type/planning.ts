/** Deterministic planning material produced before any Agent route decision. */

import type {
  CandidateId,
  CodeNodeId,
  ConstraintId,
  EvidenceId,
  JsonValue,
  RouteBlockId,
  RouteModuleId,
  SnapshotId,
  SourceRange,
} from './common';

export interface PlanningSeed {
  schema_version: '1';
  snapshot_id: SnapshotId;
  project: PlanningProjectSummary;
  graph_quality: PlanningGraphQuality;
  clusters: PlanningCluster[];
  candidates: PlanningCandidate[];
  entry_candidate_ids: CandidateId[];
  relations: PlanningCandidateRelation[];
  constraints: PlanningConstraint[];
  diagnostics: string[];
  budget: PlanningSeedBudget;
  truncation: PlanningSeedTruncation;
}

export interface PlanningProjectSummary {
  file_count: number;
  symbol_count: number;
  languages: string[];
}

export interface PlanningGraphQuality {
  parsed_file_count: number;
  failed_file_count: number;
  resolved_call_count: number;
  ambiguous_call_count: number;
  external_call_count: number;
  unsupported_file_count: number;
  vendored_excluded_count: number;
  too_large_file_count: number;
}

export interface PlanningCluster {
  id: string;
  label: string;
  file_count: number;
  symbol_count: number;
  /** Symbols eligible under the current seed options (for example, excluding tests). */
  eligible_symbol_count: number;
  candidate_ids: CandidateId[];
  merged_cluster_count?: number;
  metadata?: Record<string, JsonValue>;
}

export interface PlanningCandidate {
  id: CandidateId;
  entity_id: CodeNodeId;
  entity_index: number;
  name: string;
  kind: string;
  file: string;
  range: { start_line: number; end_line: number };
  cluster_id: string;
  rank_score: number;
  metrics: CandidateMetrics;
  signals: CandidateSignal[];
  warnings: string[];
  metadata?: Record<string, JsonValue>;
}

export interface CandidateMetrics {
  in_degree: number;
  out_degree: number;
  symbol_callers: number;
  module_callers: number;
  reference_in: number;
  reference_out: number;
  cross_cluster_in: number;
  cross_cluster_out: number;
  bfs_depth: number | null;
  reachable_count: number;
  cycle_size: number;
}

export interface CandidateSignal {
  /** Open deterministic signal name, not a closed semantic role. */
  name: string;
  value?: JsonValue;
  description: string;
  fact_refs: string[];
}

export interface PlanningCandidateRelation {
  id: string;
  relation: string;
  from_candidate_id: CandidateId;
  to_candidate_id: CandidateId;
  fact_refs: string[];
  lines?: number[];
  metadata?: Record<string, JsonValue>;
}

export interface PlanningConstraint {
  id: ConstraintId;
  /** Open policy/structural constraint label. */
  kind: string;
  strength: 'hard' | 'soft';
  description: string;
  fact_refs: string[];
  subject_id?: string;
  object_id?: string;
  metadata?: Record<string, JsonValue>;
}

export interface PlanningSeedBudget {
  max_bytes: number;
  max_candidates: number;
  max_clusters: number;
  max_relations: number;
  max_signals_per_candidate: number;
  max_entry_seeds: number;
}

export interface PlanningSeedTruncation {
  truncated: boolean;
  omitted_candidates: number;
  omitted_relations: number;
  merged_clusters: number;
  excluded_test_symbols: number;
}

/** Request accepted by the route-planning workflow. */
export interface RouteGenerationRequest {
  schema_version: '1';
  request_id: string;
  snapshot_id: SnapshotId;
  goal: RouteGoalRequest;
  limits: RoutePlanningLimits;
  constraints?: RouteRequestConstraints;
  origin?: RouteRequestOrigin;
  metadata?: Record<string, JsonValue>;
}

export interface RouteGoalRequest {
  /** The stable default-main intent or the user's exact request. */
  original: string;
  /** Open label such as default_main, user_request, or a future source. */
  source: string;
  metadata?: Record<string, JsonValue>;
}

export interface RoutePlanningLimits {
  min_modules: number;
  max_modules: number;
  max_blocks: number;
  max_blocks_per_module: number;
  max_submission_attempts: number;
  /** Maximum targeted re-planning cycles after the first module expansion. */
  max_revision_rounds: number;
  max_source_lines_per_read: number;
  max_locked_plan_bytes: number;
  main_agent: AgentInvestigationBudget;
  module_agent: AgentInvestigationBudget;
  global: AgentInvestigationBudget;
}

export interface AgentInvestigationBudget {
  max_tool_calls: number;
  max_source_reads: number;
  max_source_bytes: number;
}

export interface RouteRequestConstraints {
  start_candidate_ids?: CandidateId[];
  required_candidate_ids?: CandidateId[];
  excluded_candidate_ids?: CandidateId[];
  require_source_evidence?: boolean;
  allow_test_candidates?: boolean;
  metadata?: Record<string, JsonValue>;
}

export interface RouteRequestOrigin {
  kind: string;
  route_id?: string;
  step_id?: string;
  description?: string;
  metadata?: Record<string, JsonValue>;
}

/** Evidence is captured by the workflow; the Agent may only reference its ID. */
export interface PlanningEvidence {
  id: EvidenceId;
  snapshot_id: SnapshotId;
  kind: string;
  /** Candidates whose complete symbol ranges are covered by this read. */
  candidate_ids: CandidateId[];
  /** Candidates intersecting this read, including large symbols represented by a smaller block. */
  intersecting_candidate_ids?: CandidateId[];
  file?: string;
  range?: { start_line: number; end_line: number };
  content_digest?: string;
  /** Persisted outside the locked plan and omitted from delivery payloads. */
  content?: string;
  metadata?: Record<string, JsonValue>;
}

/** Module-level draft produced by the main planning Agent. It is locked only after review and assembly. */
export interface ModuleRouteDecision {
  schema_version: '1';
  snapshot_id: SnapshotId;
  goal: ResolvedRouteGoal;
  modules: RouteModulePlan[];
  excluded_candidates?: ExcludedRouteCandidate[];
  unresolved_questions?: string[];
  metadata?: Record<string, JsonValue>;
}

export interface RouteModulePlan {
  id: string;
  title: string;
  objective: string;
  reason: string;
  candidate_ids: CandidateId[];
  transition_from_previous?: string;
  metadata?: Record<string, JsonValue>;
}

export interface ResolvedRouteGoal {
  original: string;
  title: string;
  resolved: string;
  rationale: string;
  evidence_refs: EvidenceId[];
  metadata?: Record<string, JsonValue>;
}

/** Block-level result produced in an isolated Agent context for one semantic module. */
export interface ModuleBlockDecision {
  schema_version: '1';
  snapshot_id: SnapshotId;
  module_id: string;
  blocks: RouteBlockDecision[];
  omitted_symbols?: OmittedRouteSymbol[];
  unresolved_questions?: string[];
  metadata?: Record<string, JsonValue>;
}

export interface RouteBlockDecision {
  candidate_id: CandidateId;
  title: string;
  range: { start_line: number; end_line: number };
  /** Optional emphasis inside the complete block; these are not separate route nodes. */
  focus_ranges?: RouteFocusRange[];
  reason: string;
  evidence_refs: EvidenceId[];
  connection_from_previous?: RouteDecisionConnection;
  metadata?: Record<string, JsonValue>;
}

export interface RouteFocusRange {
  start_line: number;
  end_line: number;
  label?: string;
}

export interface OmittedRouteSymbol {
  symbol_id: CodeNodeId;
  reason: string;
  metadata?: Record<string, JsonValue>;
}

/** Facts-only global audit produced after all isolated module runs. */
export interface RouteExpansionAudit {
  valid: boolean;
  issues: RouteValidationIssue[];
  stats: {
    modules: number;
    blocks: number;
    errors: number;
    warnings: number;
  };
}

/** Main-Agent judgement over the complete set of isolated module results. */
export interface RouteReviewDecision {
  schema_version: '1';
  snapshot_id: SnapshotId;
  status: 'accept' | 'revise';
  rationale: string;
  revisions: ModuleRevisionRequest[];
  unresolved_questions?: string[];
  metadata?: Record<string, JsonValue>;
}

export interface ModuleRevisionRequest {
  module_id: string;
  reason: string;
  required_focus: string;
  /** Optional facts already known to the main Agent; not a closed candidate list. */
  candidate_hints?: CandidateId[];
  metadata?: Record<string, JsonValue>;
}

/** Context added only when an isolated module Agent is re-run after global review. */
export interface ModuleRevisionContext {
  revision_request: ModuleRevisionRequest;
  previous_result: ModuleBlockDecision;
  other_module_ownership: Array<{
    module_id: string;
    candidate_id: CandidateId;
    symbol_id?: CodeNodeId;
    name?: string;
    file?: string;
    range: { start_line: number; end_line: number };
  }>;
}

/** Compact final confirmation produced by the main Agent after isolated expansions finish. */
export interface RouteAssemblyDecision {
  schema_version: '1';
  snapshot_id: SnapshotId;
  /** The one concrete production scenario retained in the final route. */
  selected_scenario: string;
  /** Final goal wording after the main Agent reviews all module candidates. */
  goal: Pick<ResolvedRouteGoal, 'title' | 'resolved' | 'rationale'> & {
    metadata?: Record<string, JsonValue>;
  };
  modules: RouteAssemblyModule[];
  rationale: string;
  unresolved_questions?: string[];
  metadata?: Record<string, JsonValue>;
}

export interface RouteAssemblyModule {
  module_id: string;
  title: string;
  objective: string;
  reason: string;
  /** One-based indexes into the isolated module Agent's candidate blocks. */
  selected_block_orders: number[];
  connection_from_previous?: RouteDecisionConnection;
  metadata?: Record<string, JsonValue>;
}

export interface RouteDecisionConnection {
  relation: string;
  description: string;
  fact_refs: string[];
  evidence_refs: EvidenceId[];
  metadata?: Record<string, JsonValue>;
}

export interface ExcludedRouteCandidate {
  candidate_id: CandidateId;
  reason: string;
  metadata?: Record<string, JsonValue>;
}

export interface RouteValidationReport {
  valid: boolean;
  issues: RouteValidationIssue[];
  stats: {
    selected_modules: number;
    selected_blocks: number;
    distinct_candidates: number;
    referenced_evidence: number;
    supported_connections: number;
  };
}

export interface RouteValidationIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  module_index?: number;
  block_index?: number;
  candidate_id?: CandidateId;
  evidence_id?: EvidenceId;
  metadata?: Record<string, JsonValue>;
}

/** Immutable route skeleton. Teaching semantics are intentionally absent. */
export interface LockedRoutePlan {
  schema_version: '1';
  id: string;
  request_id: string;
  snapshot_id: SnapshotId;
  decision_digest: string;
  goal: ResolvedRouteGoal;
  modules: LockedRouteModule[];
  /** Validated execution facts used by explanation and delivery. */
  relations: LockedRouteRelation[];
  excluded_candidates: ExcludedRouteCandidate[];
  unresolved_questions: string[];
}

export interface LockedRouteModule {
  id: RouteModuleId;
  order: number;
  title: string;
  objective: string;
  reason: string;
  blocks: LockedRouteBlock[];
  omitted_symbols: OmittedRouteSymbol[];
  connection_from_previous?: RouteDecisionConnection;
}

export interface LockedRouteBlock {
  id: RouteBlockId;
  order: number;
  title: string;
  candidate_id: CandidateId;
  symbol_id: CodeNodeId;
  name: string;
  kind: string;
  file: string;
  range: { start_line: number; end_line: number };
  focus_ranges?: RouteFocusRange[];
  reason: string;
  evidence_refs: EvidenceId[];
  connection_from_previous?: RouteDecisionConnection;
}

/** Real control-flow meaning; a module boundary is metadata rather than a type. */
export type LockedRouteRelationType =
  'calls' | 'returns' | 'continues' | 'handoff' | 'custom' | 'callback';

/** Location-only relation proposal submitted by an Agent before source is materialized. */
export interface SourceCandidateProposal {
  source: SourceCandidateLocation;
  target: SourceCandidateLocation;
  relation: 'calls' | 'returns' | 'continues' | 'handoff';
  reason: string;
}

export interface SourceCandidateLocation {
  file: string;
  /** Inclusive, with at most 20 lines in one evidence range. */
  start_line: number;
  end_line: number;
}

/** Immutable candidate completed from a fixed snapshot by deterministic code. */
export interface MaterializedSourceCandidate extends SourceCandidateProposal {
  schema_version: '1';
  id: string;
  snapshot_id: SnapshotId;
  snapshot_version: string;
  source: SourceCandidateLocation & { quote: string };
  target: SourceCandidateLocation & { quote: string };
  created_at: number;
  revises_candidate_id?: string;
}

export interface SourceCandidateReview {
  schema_version: '1';
  id: string;
  candidate_id: string;
  snapshot_id: SnapshotId;
  reviewer_id: string;
  status: 'pending' | 'confirmed' | 'superseded' | 'abandoned' | 'needs_review';
  decision?: 'confirm' | 'revise' | 'reclassify' | 'abandon' | 'needs_review';
  replacement_candidate_id?: string;
  created_at: number;
  updated_at: number;
}

export interface MaterializedSourceCandidateBatch {
  schema_version: '1';
  id: string;
  batch_id: string;
  revision: number;
  snapshot_id: SnapshotId;
  module_id: string;
  entries: Array<{ local_id: string; candidate_id: string }>;
  revises_revision?: number;
  created_at: number;
}

export interface SourceCandidateBatchReview {
  schema_version: '1';
  id: string;
  batch_id: string;
  revision: number;
  snapshot_id: SnapshotId;
  reviewer_id: string;
  status: 'pending' | 'confirmed' | 'superseded';
  decision?: 'confirm_all' | 'revise';
  replacement_revision?: number;
  created_at: number;
  updated_at: number;
}

export interface SourceCandidateValidationIssue {
  code: string;
  message: string;
  suggested_relation?: SourceCandidateProposal['relation'];
  metadata?: Record<string, JsonValue>;
  [key: string]: JsonValue | undefined;
}

export interface SourceCandidateValidation {
  schema_version: '1';
  id: string;
  candidate_id: string;
  snapshot_id: SnapshotId;
  status: 'verified' | 'needs_review' | 'rejected';
  relation: SourceCandidateProposal['relation'];
  verification: 'deterministic' | 'pending_agent_review';
  method: string | null;
  facts: Record<string, JsonValue>;
  issues: SourceCandidateValidationIssue[];
  created_at: number;
}

export interface SourceCandidateVerdict {
  schema_version: '1';
  id: string;
  candidate_id: string;
  snapshot_id: SnapshotId;
  reviewer_id: string;
  decision: 'accept' | 'reclassify' | 'reject' | 'request_evidence' | 'replan' | 'custom';
  reason: string;
  status:
    'agent_reviewed' | 'revision_requested' | 'rejected' | 'evidence_requested' | 'replan_required';
  final_relation?: SourceCandidateProposal['relation'] | string;
  verification: 'agent_reviewed' | 'pending_revision';
  created_at: number;
}

/** Immutable source material selected by an Agent and completed by the application. */
export interface MaterializedSourceUnit {
  schema_version: '1';
  id: string;
  snapshot_id: SnapshotId;
  snapshot_version: string;
  file: string;
  kind: 'function' | 'source_range';
  start_line: number;
  end_line: number;
  quote: string;
  digest: string;
  requested:
    { anchor_line: number; symbol_hint?: string } | { start_line: number; end_line: number };
  symbol?: {
    name: string | null;
    kind: string;
    entry_line: number;
    entity_id?: CodeNodeId;
  };
  created_at: number;
  revises_unit_id?: string;
}

/** Agent-authored teaching order over confirmed, system-materialized source units. */
export interface SemanticRouteDraft {
  schema_version: '1';
  id: string;
  request_id: string;
  snapshot_id: SnapshotId;
  snapshot_version: string;
  goal: {
    title: string;
    scenario: string;
    learning_outcome: string;
  };
  summary: string;
  modules: SemanticRouteModule[];
  status: 'pending_semantic_review';
  decision_digest: string;
  creator_id: string;
  created_at: number;
}

export interface SemanticRouteModule {
  id: string;
  order: number;
  title: string;
  objective: string;
  source_unit_batch: { batch_id: string; revision: number };
  /** Open teaching prose, not a control-flow relation classification. */
  transition_from_previous?: string;
  steps: SemanticRouteStep[];
}

export interface SemanticRouteStep {
  id: string;
  order: number;
  unit_id: string;
  title: string;
  explanation: string;
  reading_guidance: string;
  /** Open teaching prose, not a control-flow relation classification. */
  transition_from_previous?: string;
  source_unit: MaterializedSourceUnit;
}

/** One independent Agent verdict over the complete semantic route draft. */
export interface SemanticRouteReview {
  schema_version: '1';
  id: string;
  draft_id: string;
  draft_digest: string;
  review_input_digest: string;
  snapshot_id: SnapshotId;
  reviewer_id: string;
  decision: 'accept' | 'revise';
  status: 'accepted' | 'revision_required';
  summary: string;
  issues: SemanticRouteReviewIssue[];
  reviewed_step_ids: string[];
  created_at: number;
}

export interface SemanticRouteReviewIssue {
  id: string;
  /** Structural target only; the semantic category remains open text. */
  target: 'route' | 'goal' | 'module' | 'step';
  module_id?: string;
  step_id?: string;
  category: string;
  problem: string;
  required_change: string;
}

/** A source location verified before the route is locked. */
export interface LockedRouteRelationSite {
  location: SourceRange;
  callee?: string;
  /** Exact source line retained for audit and compact explanation context. */
  source_line?: string;
  /** Exact immutable-snapshot excerpt for a location-only candidate. */
  quote?: string;
}

export interface LockedRouteRelationCondition {
  summary: string;
  evidence_sites: LockedRouteRelationSite[];
}

/**
 * One immutable execution edge between locked blocks. planning_note is internal
 * route semantics; the explanation stage rewrites it for the learner.
 */
export interface LockedRouteRelation {
  id: string;
  candidate_id?: string;
  type: LockedRouteRelationType;
  custom_relation?: string;
  from_block_id: RouteBlockId;
  to_block_id: RouteBlockId;
  crosses_module_boundary: boolean;
  call_site?: LockedRouteRelationSite;
  resume_site?: LockedRouteRelationSite;
  source_site?: LockedRouteRelationSite;
  target_site?: LockedRouteRelationSite;
  condition?: LockedRouteRelationCondition;
  planning_note: string;
  evidence_refs: EvidenceId[];
  verification?: {
    status: 'deterministic' | 'agent_reviewed';
    method: string | null;
    reviewer_id?: string;
    reason?: string;
  };
}
