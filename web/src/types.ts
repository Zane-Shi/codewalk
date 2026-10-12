export type Model = { id: string; name: string };
export type ModelSettingsResponse = {
  defaultModelId: string | null;
  configPath: string;
  providerId: string | null;
  providerName: string | null;
};
export type Snapshot = {
  id: string;
  projectId?: string;
  name: string;
  version: string;
  files: string[];
  skipped: string[];
  bytes: number;
  createdAt: number;
};
export type ProjectSummary = {
  id: string;
  name: string;
  sourcePath: string | null;
  activeSnapshotId: string;
  snapshotIds: string[];
  currentSnapshot: Snapshot;
  snapshotCount: number;
  routeCount: number;
  overviewReady: boolean;
  annotationCount: number;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number;
  migratedFromLegacy?: boolean;
};
export type ProjectListItem = Omit<ProjectSummary, 'currentSnapshot'> & {
  currentSnapshot: Omit<Snapshot, 'files' | 'skipped'>;
};
export type ProjectImportResult = { project: ProjectSummary; snapshot: Snapshot; reused: boolean };
export type Position = { line: number; column: number };
export type SourceSelection = {
  start: number;
  end: number;
  selectedText: string;
  startPosition: Position;
  endPosition: Position;
};
export type SourceAnchor = Omit<SourceSelection, 'selectedText'> & { text: string };
export type Annotation = {
  id: string;
  snapshotId: string;
  filePath: string;
  model: string;
  createdAt: number;
  anchor: SourceAnchor;
};
export type Message = { id: string; role: 'user' | 'assistant'; text: string; createdAt: number };
export type SourceEvidence = { id: string; path: string; offset: number; limit: number };
export type Task = {
  id: string;
  status: string;
  error?: string;
  validationIssues?: Array<{
    code: string;
    message: string;
    location?: {
      file?: string;
      line?: number;
      field?: string;
      moduleId?: string;
      blockId?: string;
    };
    actual?: unknown;
    expected?: unknown;
  }>;
  recoveryAttempts?: number;
  failureKind?: 'external' | 'generation';
  sources?: SourceEvidence[];
  createdAt: number;
  finishedAt?: number;
};
export type AnnotationDetail = { annotation: Annotation; messages: Message[]; tasks: Task[] };
export type OverviewNode = {
  id?: string;
  path: string;
  kind: 'directory' | 'file';
  summary?: string;
  description: string;
  importance?: 'core' | 'important' | 'supporting';
  parentId?: string | null;
  confidence: 'confirmed' | 'inferred' | 'uncertain';
  evidenceIds?: string[];
};
export type OverviewArea = {
  id: string;
  title: string;
  summary: string;
  whyItMatters: string;
  importance: 'core' | 'important' | 'supporting';
  paths: string[];
  keyFiles: { path: string; reason: string }[];
};
export type OverviewRelation = {
  fromAreaId: string;
  toAreaId: string;
  kind: 'calls' | 'imports' | 'supports';
  summary: string;
  confidence: 'confirmed' | 'inferred';
};
export type Overview = {
  schemaVersion?: 1;
  id: string;
  snapshotId?: string;
  snapshotVersion?: string;
  version: string;
  model: string;
  createdAt: number;
  project?: {
    name: string;
    purpose: string;
    capabilities: string[];
    technologies: { name: string; role: string }[];
  };
  purpose: string;
  capabilities?: string[];
  scope: string;
  areas?: OverviewArea[];
  relations?: OverviewRelation[];
  nodes: OverviewNode[];
  technologies: { name: string; role: string }[];
  ignoredAreas?: { path: string; reason: string }[];
  limitations: string[];
  partial: boolean;
  coverage?: { expected: string[]; missing: string[]; confirmed: number };
};
export type OverviewResponse = { overview: Overview | null; task: Task | null };
export type StreamEvent = { type: string; data: Record<string, unknown> };
export type SourcePoint = { line: number; column: number; offset: number };
export type SourceLocation = {
  filePath: string;
  startLine?: number;
  endLine?: number;
  origin: 'route' | 'annotation' | 'citation' | 'file-tree' | 'history';
  originId?: string;
  title: string;
  reason: string;
};
export type DeliverySourceRange = {
  file: string;
  start: { line: number; column?: number };
  end: { line: number; column?: number };
};
export type ModuleTeachingNarrative = {
  summary: string;
  why_read: string;
  expected_input: string;
  expected_outcome: string;
  takeaway: string;
};
export type BlockTeachingNarrative = { summary: string; why_read: string; takeaways: string[] };
export type RouteGoal = {
  title: string;
  scenario: string;
  observable_result: string;
  reason: string;
};
export type RouteBlock = {
  id: string;
  module_id: string;
  order: number;
  route_order: number;
  title: string;
  source: {
    symbol_id: string;
    name: string;
    kind: string;
    location: DeliverySourceRange;
    content_digest: string;
    signature?: string;
  };
  narrative: BlockTeachingNarrative;
  incoming_relation_ids: string[];
  outgoing_relation_ids: string[];
  content_status: 'pending' | 'ready' | 'stale' | 'failed';
  estimated_minutes?: number;
};
export type RouteModule = {
  id: string;
  order: number;
  title: string;
  narrative: ModuleTeachingNarrative;
  blocks: RouteBlock[];
  incoming_relation_ids: string[];
  outgoing_relation_ids: string[];
};
export type RouteRelation = {
  id: string;
  candidate_id?: string;
  type: 'calls' | 'returns' | 'continues' | 'handoff' | 'custom' | 'callback';
  custom_relation?: string;
  from_block_id: string;
  to_block_id: string;
  crosses_module_boundary: boolean;
  explanation: string;
  call_site?: { location: DeliverySourceRange; callee?: string };
  resume_site?: { location: DeliverySourceRange };
  source_site?: { location: DeliverySourceRange; quote?: string };
  target_site?: { location: DeliverySourceRange; quote?: string };
  condition?: { summary: string };
  verification?: {
    status: 'deterministic' | 'agent_reviewed';
    method: string | null;
    reviewer_id?: string;
    reason?: string;
  };
  confidence?: 'high' | 'medium' | 'low';
};
export type RouteDelivery = {
  schema_version: string;
  id: string;
  workspace_id: string;
  snapshot_id: string;
  revision_id: string;
  revision: number;
  goal: RouteGoal;
  summary: string;
  kind?: string;
  status: 'generating' | 'ready' | 'partial' | 'archived';
  quality?: {
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
  };
  modules: RouteModule[];
  relations: RouteRelation[];
  created_at: number;
  updated_at: number;
};
export type RouteSummary = {
  id: string;
  revision_id: string;
  revision: number;
  title: string;
  summary: string;
  goal: RouteGoal;
  kind?: string;
  status: 'generating' | 'ready' | 'partial' | 'archived';
  module_count: number;
  block_count: number;
  estimated_minutes?: number;
  created_at: number;
  updated_at: number;
};
export type RouteGenerationTask = {
  id: string;
  ownerId?: string;
  routeId?: string;
  routeRevisionId?: string;
  workspaceId: string;
  snapshotId?: string;
  status:
    | 'investigating'
    | 'explaining'
    | 'finalizing'
    | 'complete'
    | 'failed'
    | 'cancelled'
    | 'route_issue'
    | 'partial';
  phase?: 'planning' | 'researching' | 'reviewing' | 'explaining' | 'publishing' | 'complete';
  error?: string;
  validationIssues?: Task['validationIssues'];
  validationAttempts?: number;
  recoveryAttempts?: number;
  failureKind?: 'external' | 'generation';
  createdAt?: number;
  updatedAt?: number;
  finishedAt?: number;
};
export type RouteCatalogue = {
  workspace_id: string;
  routes: RouteSummary[];
  tasks: RouteGenerationTask[];
};
export type BlockTeachingContent = {
  schema_version: string;
  route_id: string;
  revision_id: string;
  snapshot_id: string;
  block_id: string;
  explanation: BlockTeachingNarrative & {
    block_id: string;
    walkthrough: { title: string; start_line: number; end_line: number; explanation: string }[];
    skip_guidance?: { start_line: number; end_line: number; reason: string }[];
    pseudocode?: string;
  };
  generated_at: number;
};
