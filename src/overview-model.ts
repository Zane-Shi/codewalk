import { createHash } from 'node:crypto';

/**
 * @typedef {Object} OverviewNode
 * @property {string} id
 * @property {string} path
 * @property {'directory'|'file'} kind
 * @property {string} summary
 * @property {'core'|'important'|'supporting'} importance
 * @property {string|null} parentId
 * @property {'confirmed'|'inferred'} confidence
 * @property {string[]} evidenceIds
 */

/**
 * @typedef {Object} ProjectOverview
 * @property {1} schemaVersion
 * @property {string} id
 * @property {string} snapshotId
 * @property {string} snapshotVersion
 * @property {string} model
 * @property {{name:string, purpose:string, capabilities:string[], technologies:Array<{name:string, role:string}>}} project
 * @property {Array<{id:string,title:string,summary:string,whyItMatters:string,importance:'core'|'important'|'supporting',paths:string[],keyFiles:Array<{path:string,reason:string}>}>} areas
 * @property {Array<{fromAreaId:string,toAreaId:string,kind:'calls'|'imports'|'supports',summary:string,confidence:'confirmed'|'inferred'}>} relations
 * @property {OverviewNode[]} nodes
 * @property {Array<{path:string, reason:string}>} ignoredAreas
 * @property {string[]} limitations
 * @property {boolean} partial
 * @property {{expected:string[], missing:string[], confirmed:number}} coverage
 * @property {string|undefined} [createdByTaskId]
 * @property {number} createdAt
 */

const EMPTY_OBJECT_SCHEMA = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

const importance = (value) =>
  ['core', 'important', 'supporting'].includes(value) ? value : 'important';
const confidence = (value) =>
  value === 'inferred' || value === 'uncertain' ? 'inferred' : 'confirmed';
const nodeId = (path) =>
  `overview-node-${createHash('sha256').update(path).digest('hex').slice(0, 12)}`;

function overviewQuality(value, snapshot) {
  const architecture = Array.isArray(value.areas) && value.areas.length > 0;
  const graphBacked =
    Boolean(value.stats?.overviewSeed) ||
    value.stats?.seededGraphQueries?.some((query) => query.ok);
  const exactSnapshot = (value.snapshotId ?? value.id) === snapshot.id;
  return (architecture ? 4 : 0) + (graphBacked ? 2 : 0) + (exactSnapshot ? 1 : 0);
}

/** Prefer a graph-backed semantic overview and reuse it across identical source snapshots. */
export function selectOverviewForSnapshot(overviews, snapshot) {
  return overviews
    .filter((value) => (value.snapshotVersion ?? value.version) === snapshot.version)
    .sort(
      (left, right) =>
        overviewQuality(right, snapshot) - overviewQuality(left, snapshot) ||
        (right.createdAt ?? 0) - (left.createdAt ?? 0),
    )[0];
}

function parentPath(filePath, knownPaths) {
  let parent = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : '';
  while (parent) {
    if (knownPaths.has(parent)) return parent;
    parent = parent.includes('/') ? parent.slice(0, parent.lastIndexOf('/')) : '';
  }
  return null;
}

/**
 * Convert both persisted legacy overviews and canonical overviews into the
 * current structure. Compatibility aliases are retained for the existing API
 * and browser while later workflows consume project/nodes directly.
 */
export function normalizeOverview(value, snapshot) {
  if (!value || typeof value !== 'object') throw new Error('项目总览格式无效');
  const snapshotId = value.snapshotId ?? value.id ?? snapshot?.id;
  const snapshotVersion = value.snapshotVersion ?? value.version ?? snapshot?.version;
  if (!snapshotId || !snapshotVersion) throw new Error('项目总览缺少源码快照信息');

  const legacyNodes = Array.isArray(value.nodes) ? value.nodes : [];
  const knownPaths = new Set(legacyNodes.map((node) => node.path));
  const ids = new Map(legacyNodes.map((node) => [node.path, node.id ?? nodeId(node.path)]));
  const nodes = legacyNodes.map((node) => {
    const parent = node.parentId === undefined ? parentPath(node.path, knownPaths) : null;
    const summary = node.summary ?? node.description;
    return {
      id: node.id ?? ids.get(node.path),
      path: node.path,
      kind: node.kind,
      summary,
      importance: importance(node.importance),
      parentId: node.parentId ?? (parent ? ids.get(parent) : null),
      confidence: confidence(node.confidence),
      evidenceIds: Array.isArray(node.evidenceIds) ? [...node.evidenceIds] : [],
      // Temporary browser/API compatibility aliases.
      description: node.description ?? summary,
    };
  });
  const technologies = value.project?.technologies ?? value.technologies ?? [];
  const purpose = value.project?.purpose ?? value.purpose ?? '';
  const scope = value.scope ?? '仅当前导入源码快照';
  const project = {
    name: value.project?.name ?? snapshot?.name ?? value.name ?? '未命名项目',
    purpose,
    capabilities: Array.isArray(value.project?.capabilities)
      ? [...value.project.capabilities]
      : Array.isArray(value.capabilities)
        ? [...value.capabilities]
        : [],
    technologies: technologies.map((item) => ({ name: item.name, role: item.role })),
  };

  return {
    ...value,
    schemaVersion: 1,
    id: value.id ?? snapshotId,
    snapshotId,
    snapshotVersion,
    model: value.model ?? '',
    project,
    areas: Array.isArray(value.areas)
      ? value.areas.map((area) => ({
          id: area.id,
          title: area.title,
          summary: area.summary,
          whyItMatters: area.whyItMatters,
          importance: importance(area.importance),
          paths: Array.isArray(area.paths) ? [...area.paths] : [],
          keyFiles: Array.isArray(area.keyFiles)
            ? area.keyFiles.map((file) => ({ path: file.path, reason: file.reason }))
            : [],
        }))
      : [],
    relations: Array.isArray(value.relations)
      ? value.relations.map((relation) => ({ ...relation }))
      : [],
    nodes,
    ignoredAreas: Array.isArray(value.ignoredAreas) ? [...value.ignoredAreas] : [],
    limitations: Array.isArray(value.limitations) ? [...value.limitations] : [],
    partial: Boolean(value.partial),
    coverage: value.coverage ?? { expected: [], missing: [], confirmed: 0 },
    createdByTaskId: value.createdByTaskId,
    createdAt: value.createdAt ?? 0,
    // Temporary top-level aliases used by the current Overview page.
    version: snapshotVersion,
    purpose,
    scope,
    technologies: project.technologies,
  };
}

/** Return only the canonical, compact representation exposed to an Agent. */
export function overviewForAgent(overview) {
  return {
    schemaVersion: overview.schemaVersion,
    id: overview.id,
    snapshotId: overview.snapshotId,
    snapshotVersion: overview.snapshotVersion,
    model: overview.model,
    project: overview.project,
    areas: overview.areas,
    relations: overview.relations,
    nodes: overview.nodes.map(({ description: _description, ...node }) => node),
    ignoredAreas: overview.ignoredAreas,
    limitations: overview.limitations,
    partial: overview.partial,
    coverage: overview.coverage,
    createdAt: overview.createdAt,
  };
}

/**
 * Create the no-argument Pi tool bound to a trusted snapshot and overview
 * loader. The model cannot select another snapshot or request a partial view.
 */
export function createGetProjectOverviewTool({ snapshot, loadOverview, onRead = () => {} }) {
  let cached;
  return {
    name: 'get_project_overview',
    label: '读取完整项目总览',
    description:
      '一次性读取当前源码快照已经生成并持久化的完整项目总览。用于了解项目用途、主要目录、关键文件及技术背景；具体调用关系和数据流仍需使用源码工具验证。同一任务不要重复调用。',
    parameters: EMPTY_OBJECT_SCHEMA,
    executionMode: 'sequential',
    async execute(_id, args = {}) {
      if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length)
        throw new Error('get_project_overview 不接受参数');
      if (cached) return { content: [{ type: 'text', text: cached }] };
      const stored = await loadOverview(snapshot.id);
      if (!stored) {
        cached = JSON.stringify({
          status: 'missing',
          snapshotId: snapshot.id,
          message: '当前源码快照尚未生成项目总览。请直接使用源码工具继续调查。',
        });
        return { content: [{ type: 'text', text: cached }] };
      }
      const overview = normalizeOverview(stored, snapshot);
      if (overview.snapshotVersion !== snapshot.version) {
        cached = JSON.stringify({
          status: 'version-mismatch',
          snapshotId: snapshot.id,
          expectedVersion: snapshot.version,
          actualVersion: overview.snapshotVersion,
          message: '项目总览与当前源码快照版本不一致，不能作为本次任务的上下文。',
        });
        return { content: [{ type: 'text', text: cached }] };
      }
      const result = { status: 'available', overview: overviewForAgent(overview) };
      const evidenceId = onRead(result.overview);
      if (evidenceId) result.evidenceId = evidenceId;
      cached = JSON.stringify(result);
      return { content: [{ type: 'text', text: cached }] };
    },
  };
}
