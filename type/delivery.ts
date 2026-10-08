/**
 * Delivery layer.
 *
 * A delivered route preserves the planning hierarchy exactly:
 * semantic modules contain ordered code blocks. Presentation state and learner
 * progress belong to the runtime layer, not these immutable route revisions.
 */

import type {
  CodeNodeId,
  Confidence,
  EvidenceId,
  JsonValue,
  ProjectId,
  ReadingGoal,
  RouteBlockId,
  RouteId,
  RouteModuleId,
  RouteRevisionId,
  SchemaVersion,
  SnapshotId,
  SourceRange,
  TimestampMs,
  WorkspaceId,
} from './common';
import type {
  BlockTeachingExplanation,
  ExplanationRelationType,
  ExplanationSkipGuidance,
  ExplanationWalkthroughSection,
  ModuleTeachingExplanation,
} from './explanation';

/** Workspace overview used to render the project and its route catalogue. */
export interface ReadingWorkspaceDelivery {
  schema_version: SchemaVersion;
  workspace_id: WorkspaceId;
  project: ProjectMeta;
  routes: RouteSummary[];
  route_relations: RouteRelation[];
  suggestions: FollowUpSuggestion[];
  created_at: TimestampMs;
  updated_at: TimestampMs;
}

export interface ProjectMeta {
  project_id: ProjectId;
  name: string;
  summary: string;
  languages: string[];
  tech_stack: string[];
  metadata?: Record<string, JsonValue>;
}

/** Compact route card; module and block counts are derived display values. */
export interface RouteSummary {
  id: RouteId;
  /** The immutable revision currently opened from this catalogue entry. */
  revision_id: RouteRevisionId;
  revision: number;
  title: string;
  summary: string;
  goal: RouteGoalDelivery;
  kind?: string;
  status: RouteDeliveryStatus;
  module_count: number;
  block_count: number;
  estimated_minutes?: number;
  created_at: TimestampMs;
  updated_at: TimestampMs;
}

/** Only the delivery lifecycle is represented here; generation tasks fail separately. */
export type RouteDeliveryStatus = 'generating' | 'ready' | 'partial' | 'archived';

/** Complete immutable route revision consumed by the frontend. */
export interface RouteDelivery {
  schema_version: SchemaVersion;
  id: RouteId;
  workspace_id: WorkspaceId;
  snapshot_id: SnapshotId;
  revision_id: RouteRevisionId;
  revision: number;

  goal: RouteGoalDelivery;
  summary: string;
  kind?: string;
  status: RouteDeliveryStatus;
  origin?: RouteOrigin;

  /** Modules and blocks retain the exact hierarchy and order of the locked plan. */
  modules: RouteModuleDelivery[];
  /** Reading order lives in modules/blocks; this catalogue records real code flow. */
  relations: RouteBlockRelationDelivery[];

  /** Present for the semantic route pipeline; partial issues remain visible to the learner. */
  quality?: RouteDeliveryQuality;

  created_at: TimestampMs;
  updated_at: TimestampMs;
}

export interface RouteDeliveryQuality {
  level: 'accepted' | 'partial';
  review_id?: string;
  summary: string;
  issues: Array<{
    id?: string;
    target?: string;
    module_id?: string;
    step_id?: string;
    category?: string;
    problem: string;
    required_change?: string;
  }>;
}

/** The concrete scenario selected during planning, written for the learner. */
export interface RouteGoalDelivery {
  title: string;
  scenario: string;
  observable_result: string;
  reason: string;
}

/** Creation provenance; cross-route links are represented by RouteRelation. */
export interface RouteOrigin {
  description: string;
  source_route_id?: RouteId;
  source_block_id?: RouteBlockId;
  metadata?: Record<string, JsonValue>;
}

/** One broad semantic responsibility in the story of the selected scenario. */
export interface RouteModuleDelivery {
  id: RouteModuleId;
  order: number;
  title: string;
  narrative: RouteModuleNarrative;
  blocks: RouteBlockDelivery[];
  incoming_relation_ids: string[];
  outgoing_relation_ids: string[];
  metadata?: Record<string, JsonValue>;
}

/** The module explanation is copied into delivery without semantic rewriting. */
export type RouteModuleNarrative = ModuleTeachingExplanation;

/** One locked source range and its concise user-facing teaching semantics. */
export interface RouteBlockDelivery {
  id: RouteBlockId;
  module_id: RouteModuleId;
  /** Position inside the containing semantic module. */
  order: number;
  /** Position in the complete route after all modules are flattened. */
  route_order: number;
  title: string;
  source: RouteBlockSource;
  narrative: RouteBlockNarrative;
  incoming_relation_ids: string[];
  outgoing_relation_ids: string[];
  content_status: RouteBlockContentStatus;
  estimated_minutes?: number;
  metadata?: Record<string, JsonValue>;
}

/** A block always has exactly one source target; normal functions stay complete. */
export interface RouteBlockSource {
  symbol_id: CodeNodeId;
  name: string;
  kind: string;
  location: SourceRange;
  /** Digest lets the backend reject explanation content built from stale source. */
  content_digest: string;
  signature?: string;
  evidence?: DisplayEvidence[];
}

/** Compact block card deterministically projected from the complete explanation. */
export type RouteBlockNarrative = Pick<
  BlockTeachingExplanation,
  'summary' | 'why_read' | 'takeaways'
>;

export type RouteBlockContentStatus = 'pending' | 'ready' | 'stale' | 'failed';

/** Detailed teaching content fetched or rendered for one exact route block. */
export interface RouteBlockContentDelivery {
  schema_version: SchemaVersion;
  route_id: RouteId;
  revision_id: RouteRevisionId;
  snapshot_id: SnapshotId;
  block_id: RouteBlockId;
  /** Exact successful explanation payload for this block. */
  explanation: BlockTeachingExplanation;
  generated_at: TimestampMs;
}

/** Mutable route pointer; it is replaced only after a complete revision exists. */
export interface PublishedRouteRecord {
  schema_version: SchemaVersion;
  id: RouteId;
  workspace_id: WorkspaceId;
  snapshot_id: SnapshotId;
  current_revision_id: RouteRevisionId;
  revision: number;
  status: RouteDeliveryStatus;
  /** Restored after archiving so a partial route does not become falsely ready. */
  active_status?: Exclude<RouteDeliveryStatus, 'archived' | 'generating'>;
  summary: RouteSummary;
  created_at: TimestampMs;
  updated_at: TimestampMs;
}

/** Store envelope for one immutable route revision. */
export interface PublishedRouteRevisionRecord {
  schema_version: SchemaVersion;
  /** Storage key; the delivered route keeps its own stable route ID. */
  id: RouteRevisionId;
  route_id: RouteId;
  workspace_id: WorkspaceId;
  decision_digest: string;
  delivery: RouteDelivery;
  published_at: TimestampMs;
}

/** Store envelope that keeps block content isolated by route revision. */
export interface PublishedRouteBlockContentRecord {
  schema_version: SchemaVersion;
  /** Deterministic storage key composed from revision_id and block_id. */
  id: string;
  route_id: RouteId;
  revision_id: RouteRevisionId;
  block_id: RouteBlockId;
  content: RouteBlockContentDelivery;
}

/** Compact per-workspace catalogue updated in the same transaction as a route. */
export interface WorkspaceRouteCatalogRecord {
  schema_version: SchemaVersion;
  id: WorkspaceId;
  workspace_id: WorkspaceId;
  routes: RouteSummary[];
  updated_at: TimestampMs;
}

/** Re-exported aliases keep delivery consumers on the exact explanation shapes. */
export type BlockWalkthroughSection = ExplanationWalkthroughSection;
export type BlockSkipGuidance = ExplanationSkipGuidance;

/** Crossing a module boundary is relation metadata, not a separate flow type. */
export type RouteBlockRelationType = ExplanationRelationType;

/** Real execution relation; it is deliberately separate from reading order. */
export interface RouteBlockRelationDelivery {
  id: string;
  type: RouteBlockRelationType;
  from_block_id: RouteBlockId;
  to_block_id: RouteBlockId;
  crosses_module_boundary: boolean;
  /** User-facing wording generated after the relation facts are locked. */
  explanation: string;
  call_site?: RelationCallSite;
  resume_site?: RelationResumeSite;
  condition?: RelationCondition;
  evidence: DisplayEvidence[];
  confidence?: Confidence;
  metadata?: Record<string, JsonValue>;
}

/** A call may live in an omitted bridge function rather than either route block. */
export interface RelationCallSite {
  location: SourceRange;
  callee?: string;
}

/** Where an already-running caller resumes after an awaited/callback subflow. */
export interface RelationResumeSite {
  location: SourceRange;
}

/** Scenario condition that makes a branch part of this specific route. */
export interface RelationCondition {
  summary: string;
  evidence: DisplayEvidence[];
}

/** Evidence the frontend can render or navigate to without another model call. */
export interface DisplayEvidence {
  evidence_id?: EvidenceId;
  label?: string;
  description?: string;
  location?: SourceRange;
}

export interface RouteRelation {
  id: string;
  from_route_id: RouteId;
  to_route_id: RouteId;
  relation: string;
  anchor_block_id?: RouteBlockId;
  description?: string;
  created_at: TimestampMs;
  metadata?: Record<string, JsonValue>;
}

export interface FollowUpSuggestion {
  id: string;
  snapshot_id: SnapshotId;
  title: string;
  goal: ReadingGoal;
  reason: string;
  suggested_symbol_ids: CodeNodeId[];
  estimated_blocks?: number;
  overlap_with_existing?: number;
  metadata?: Record<string, JsonValue>;
}
