/** Contracts used by the semantic route generation workflow. */

import type { CodeNodeId, JsonValue, SnapshotId } from './common';

export interface RouteGenerationRequest {
  schema_version: '1';
  request_id: string;
  snapshot_id: SnapshotId;
  goal: {
    original: string;
    source: string;
    metadata?: Record<string, JsonValue>;
  };
  origin?: {
    kind: string;
    route_id?: string;
    step_id?: string;
    description?: string;
    metadata?: Record<string, JsonValue>;
  };
  metadata?: Record<string, JsonValue>;
}

/** Immutable source material selected by an Agent and completed by deterministic code. */
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
    | { anchor_line: number; symbol_hint?: string }
    | { start_line: number; end_line: number };
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
  target: 'route' | 'goal' | 'module' | 'step';
  module_id?: string;
  step_id?: string;
  category: string;
  problem: string;
  required_change: string;
}
