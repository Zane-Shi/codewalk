/**
 * Input layer for route generation.
 *
 * Dekko's raw map document is an external wire format and is validated as
 * unknown by the adapter. Downstream layers only consume this compact model.
 */

import type { JsonValue, ProjectId, SnapshotId, TimestampMs } from './common';

/** The adapter accepts untrusted external data; no other layer imports it. */
export type DekkoMapPayload = unknown;

export interface RouteGenerationSource {
  schema_version: '1';
  snapshot: SourceSnapshotInput;
  code_map: CodeMapReference;
  graph: CompactCodeGraph;
}

export interface SourceSnapshotInput {
  id: SnapshotId;
  project_id: ProjectId;
  version: string;
  /** Backend-only absolute root. It must never be delivered to the browser. */
  root: string;
  /** POSIX-style paths relative to root; source bodies remain on disk. */
  files: string[];
}

export interface CodeMapReference {
  analyzer: string;
  analyzer_version: string;
  document_version: number;
  path: string;
  bytes?: number;
  updated_at?: TimestampMs;
  generated_at?: string;
  snapshot_id: SnapshotId;
  snapshot_version: string;
  status: 'ready' | 'stale' | 'invalid';
  metadata?: Record<string, JsonValue>;
}

export interface CompactCodeGraph {
  schema_version: '1';
  snapshot_id: SnapshotId;
  files: CompactFile[];
  entities: CompactEntity[];
  relation_sets: CompactRelationSet[];
  diagnostics: GraphDiagnostic[];
  quality: GraphQuality;
  stats: CompactGraphStats;
}

/** [path, language?, parseError?] */
export type CompactFile = readonly [path: string, language?: string, parse_error?: string];

/** ["module", stableId, fileIndex] */
export type CompactModuleEntity = readonly [entity_kind: 'module', id: string, file_index: number];

/**
 * ["symbol", stableId, name, kind, fileIndex, startLine, endLine, flags,
 * qualifiedName?]
 *
 * flags bit 0 = exported; bit 1 = test. `kind` stays open and analyzer-owned.
 */
export type CompactSymbolEntity = readonly [
  entity_kind: 'symbol',
  id: string,
  name: string,
  kind: string,
  file_index: number,
  start_line: number,
  end_line: number,
  flags: number,
  qualified_name?: string,
];

export type CompactEntity = CompactModuleEntity | CompactSymbolEntity;

export interface CompactRelationSet {
  /** calls, references, imports, extends, implements, or a future analyzer label. */
  relation: string;
  edges: CompactRelationEdge[];
}

/** [fromEntityIndex, toEntityIndex, sourceLines?] */
export type CompactRelationEdge = readonly [from: number, to: number, lines?: readonly number[]];

export interface GraphDiagnostic {
  level: 'info' | 'warning' | 'error';
  code: string;
  message: string;
  file?: string;
  start_line?: number;
  end_line?: number;
  metadata?: Record<string, JsonValue>;
}

export interface GraphQuality {
  parsed_file_count: number;
  failed_file_count: number;
  resolved_call_count: number;
  ambiguous_call_count: number;
  external_call_count: number;
  unsupported_file_count: number;
  vendored_excluded_count: number;
  too_large_file_count: number;
}

export interface CompactGraphStats {
  file_count: number;
  symbol_count: number;
  module_entity_count: number;
  relation_count: number;
  relation_counts: Record<string, number>;
}
