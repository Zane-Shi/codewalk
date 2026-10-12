/** Shared primitives used across every layer. */

export type ProjectId = string;
export type UserId = string;
export type WorkspaceId = string;
export type SnapshotId = string;
export type CodeNodeId = string;
export type CodeEdgeId = string;
export type EvidenceId = string;
export type RouteId = string;
export type RouteRevisionId = string;
/** Stable ID of a semantic responsibility module in a delivered route. */
export type RouteModuleId = string;
/** Stable ID of one locked code block inside a route module. */
export type RouteBlockId = string;
export type RouteStepId = RouteBlockId;
export type CandidateId = string;
export type ConstraintId = string;
export type SessionId = string;
export type MessageId = string;
export type EventId = string;
export type KnowledgeItemId = string;

/** Unix timestamp in milliseconds. */
export type TimestampMs = number;
export type SchemaVersion = string;

export type Confidence = 'high' | 'medium' | 'low';

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface SourcePosition {
  line: number;
  column?: number;
}

export interface SourceRange {
  file: string;
  start: SourcePosition;
  end: SourcePosition;
}

/** A lightweight cross-layer reference to a normalized code symbol. */
export interface SymbolRef {
  symbol_id: CodeNodeId;
  name: string;
  qualified_name?: string;
  kind: string;
  location?: SourceRange;
}

/** References evidence owned by the input layer instead of copying it. */
export interface EvidenceRef {
  evidence_id: EvidenceId;
  description?: string;
}

export interface SupportedClaim {
  text: string;
  confidence: Confidence;
  evidence: EvidenceRef[];
}

/** Shared by planning requests and delivered routes. */
export interface ReadingGoal {
  title: string;
  description: string;
  /** Open semantic labels written by the user or Agent. */
  type?: string;
  desired_depth?: string;
  target_symbols?: CodeNodeId[];
  user_question?: string;
  metadata?: Record<string, JsonValue>;
}
