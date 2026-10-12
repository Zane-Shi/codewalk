import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

export const SUPPORTED_DEKKO_DOCUMENT_VERSION = 11;

export class DekkoInputError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DekkoInputError';
    this.code = code;
  }
}

function invalid(code, message) {
  throw new DekkoInputError(code, message);
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    invalid('INVALID_SHAPE', `${label} 必须是对象`);
  return value;
}

function array(value, label) {
  if (!Array.isArray(value)) invalid('INVALID_SHAPE', `${label} 必须是数组`);
  return value;
}

function text(value, label) {
  if (typeof value !== 'string' || !value) invalid('INVALID_SHAPE', `${label} 必须是非空字符串`);
  return value;
}

function relativePath(value, label) {
  const input = text(value, label).replaceAll('\\', '/');
  if (
    path.posix.isAbsolute(input) ||
    /^[A-Za-z]:/.test(input) ||
    input === '..' ||
    input.startsWith('../') ||
    input.includes('/../')
  ) {
    invalid('INVALID_PATH', `${label} 不是安全的项目相对路径：${value}`);
  }
  const normalized = path.posix.normalize(input);
  if (normalized === '.' || normalized !== input)
    invalid('INVALID_PATH', `${label} 未规范化：${value}`);
  return normalized;
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) invalid('INVALID_RANGE', `${label} 必须是正整数`);
  return value;
}

function lines(value, label) {
  if (value === undefined) return [];
  return [
    ...new Set(
      array(value, label).map((line, index) => positiveInteger(line, `${label}[${index}]`)),
    ),
  ].sort((a, b) => a - b);
}

function decodeId(reference, ids, label) {
  if (typeof reference === 'string' && reference) return reference;
  if (!Number.isInteger(reference) || reference < 0 || reference >= ids.length) {
    invalid('INVALID_ID_REFERENCE', `${label} 引用了不存在的 Dekko ID：${reference}`);
  }
  return text(ids[reference], `ids[${reference}]`);
}

function compareEdges(left, right) {
  return (
    left[0] - right[0] ||
    left[1] - right[1] ||
    JSON.stringify(left[2] ?? []).localeCompare(JSON.stringify(right[2] ?? []))
  );
}

function countCollection(value) {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') return Object.keys(value).length;
  return 0;
}

function moduleId(file) {
  return `${file}::<module>`;
}

function resolvedEdges(entries, relation, ids, entityByRawId, endpoint) {
  return array(entries, relation)
    .map((raw, index) => {
      const item = object(raw, `${relation}[${index}]`);
      const fromId = decodeId(item[endpoint.from], ids, `${relation}[${index}].${endpoint.from}`);
      const toId = decodeId(item[endpoint.to], ids, `${relation}[${index}].${endpoint.to}`);
      const from = entityByRawId.get(fromId),
        to = entityByRawId.get(toId);
      if (from === undefined || to === undefined) {
        invalid('DANGLING_RELATION', `${relation}[${index}] 的端点不存在：${fromId} -> ${toId}`);
      }
      const sites = lines(item.lines, `${relation}[${index}].lines`);
      return sites.length ? [from, to, sites] : [from, to];
    })
    .sort(compareEdges);
}

function moduleEdges(document, ids, entityByRawId) {
  const graph =
    document.module_graph === undefined ? {} : object(document.module_graph, 'module_graph');
  return array(graph.edges ?? [], 'module_graph.edges')
    .map((raw, index) => {
      const item = object(raw, `module_graph.edges[${index}]`);
      const importer = decodeId(item.importer, ids, `module_graph.edges[${index}].importer`);
      const imported = decodeId(item.imported, ids, `module_graph.edges[${index}].imported`);
      const from = entityByRawId.get(moduleId(importer)),
        to = entityByRawId.get(moduleId(imported));
      if (from === undefined || to === undefined) {
        invalid(
          'DANGLING_RELATION',
          `module_graph.edges[${index}] 的文件端点不存在：${importer} -> ${imported}`,
        );
      }
      return [from, to];
    })
    .sort(compareEdges);
}

function relationSet(relation, edges) {
  return { relation, edges };
}

function validateDocument(document) {
  const doc = object(document, 'map.json');
  if (doc.generator !== 'dekko') invalid('INVALID_GENERATOR', 'map.json 不是 Dekko 产物');
  if (!Number.isInteger(doc.version)) invalid('INVALID_VERSION', 'map.json.version 必须是整数');
  if (doc.version !== SUPPORTED_DEKKO_DOCUMENT_VERSION) {
    invalid(
      'UNSUPPORTED_VERSION',
      `不支持 Dekko map.json v${doc.version}，当前只支持 v${SUPPORTED_DEKKO_DOCUMENT_VERSION}`,
    );
  }
  array(doc.files, 'files');
  array(doc.symbols, 'symbols');
  array(doc.ids, 'ids');
  array(doc.edges, 'edges');
  return doc;
}

/**
 * Convert Dekko's storage-oriented v11 document into the compact facts needed
 * by deterministic route-candidate algorithms. The raw document is never kept
 * on the returned value.
 */
export function adaptDekkoMap(
  document,
  { snapshot, map_path = '.dekko/map.json', map_bytes, map_updated_at } = {},
) {
  const doc = validateDocument(document);
  if (!snapshot || typeof snapshot !== 'object') invalid('SNAPSHOT_REQUIRED', '必须提供源码快照');
  const snapshotFiles = new Set(
    array(snapshot.files, 'snapshot.files').map((file, index) =>
      relativePath(typeof file === 'string' ? file : file?.path, `snapshot.files[${index}]`),
    ),
  );

  const rawFiles = doc.files
    .map((raw, index) => {
      const item = object(raw, `files[${index}]`),
        filePath = relativePath(item.path, `files[${index}].path`);
      if (!snapshotFiles.has(filePath))
        invalid('SNAPSHOT_MISMATCH', `Dekko 文件不属于当前源码快照：${filePath}`);
      return {
        path: filePath,
        language: typeof item.language === 'string' ? item.language : undefined,
        parse_error: typeof item.error === 'string' && item.error ? item.error : undefined,
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  const files = [],
    fileByPath = new Map();
  for (const item of rawFiles) {
    if (fileByPath.has(item.path)) invalid('DUPLICATE_FILE', `Dekko 包含重复文件：${item.path}`);
    const compact = item.parse_error
      ? [item.path, item.language ?? '', item.parse_error]
      : item.language
        ? [item.path, item.language]
        : [item.path];
    const record = {
      index: files.length,
      path: item.path,
      language: item.language,
      parse_error: item.parse_error,
    };
    files.push(compact);
    fileByPath.set(item.path, record);
  }

  const entities = [],
    entityByRawId = new Map();
  for (const file of fileByPath.values()) {
    const id = moduleId(file.path),
      entityIndex = entities.length;
    entities.push(['module', id, file.index]);
    entityByRawId.set(id, entityIndex);
  }
  const rawSymbols = doc.symbols
    .map((raw, index) => {
      const item = object(raw, `symbols[${index}]`),
        filePath = relativePath(item.path, `symbols[${index}].path`),
        file = fileByPath.get(filePath);
      if (!file) invalid('INVALID_FILE_REFERENCE', `符号引用了不存在的文件：${filePath}`);
      const start = positiveInteger(item.start_line, `symbols[${index}].start_line`),
        end = positiveInteger(item.end_line, `symbols[${index}].end_line`);
      if (end < start) invalid('INVALID_RANGE', `符号 ${item.id} 的结束行早于开始行`);
      return {
        id: text(item.id, `symbols[${index}].id`),
        name: text(item.name, `symbols[${index}].name`),
        qualified_name:
          typeof item.qualname === 'string' && item.qualname ? item.qualname : undefined,
        kind: text(item.kind, `symbols[${index}].kind`),
        file_index: file.index,
        start_line: start,
        end_line: end,
        ...(item.exported === true ? { exported: true } : {}),
        ...(item.test === true ? { test: true } : {}),
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  for (const symbol of rawSymbols) {
    if (entityByRawId.has(symbol.id))
      invalid('DUPLICATE_SYMBOL', `Dekko 包含重复符号 ID：${symbol.id}`);
    const entityIndex = entities.length,
      flags = (symbol.exported ? 1 : 0) | (symbol.test ? 2 : 0);
    const entity = [
      'symbol',
      symbol.id,
      symbol.name,
      symbol.kind,
      symbol.file_index,
      symbol.start_line,
      symbol.end_line,
      flags,
    ];
    if (symbol.qualified_name && symbol.qualified_name !== symbol.name)
      entity.push(symbol.qualified_name);
    entities.push(entity);
    entityByRawId.set(symbol.id, entityIndex);
  }

  const ids = doc.ids;
  const calls = resolvedEdges(doc.edges, 'edges', ids, entityByRawId, {
    from: 'caller',
    to: 'callee',
  });
  const references = resolvedEdges(doc.referenced ?? [], 'referenced', ids, entityByRawId, {
    from: 'caller',
    to: 'callee',
  });
  const heritageByRelation = new Map();
  for (const raw of array(doc.heritage ?? [], 'heritage')) {
    const item = object(raw, 'heritage[]'),
      relation = typeof item.relation === 'string' && item.relation ? item.relation : 'inherits';
    const edge = resolvedEdges([item], 'heritage', ids, entityByRawId, {
      from: 'subtype',
      to: 'supertype',
    })[0];
    const group = heritageByRelation.get(relation) ?? [];
    group.push(edge);
    heritageByRelation.set(relation, group);
  }
  const imports = moduleEdges(doc, ids, entityByRawId);
  const relation_sets = [
    relationSet('calls', calls),
    relationSet('references', references),
    relationSet('imports', imports),
  ];
  for (const [relation, edges] of [...heritageByRelation].sort(([left], [right]) =>
    left.localeCompare(right),
  ))
    relation_sets.push(relationSet(relation, edges.sort(compareEdges)));

  const diagnostics = [...fileByPath.values()]
    .filter((file) => file.parse_error)
    .map((file) => ({
      level: 'warning',
      code: 'PARSE_ERROR',
      message: file.parse_error,
      file: file.path,
    }));
  const provenance =
    doc.provenance && typeof doc.provenance === 'object' && !Array.isArray(doc.provenance)
      ? doc.provenance
      : {};
  const failedFiles = diagnostics.length,
    ambiguousCalls = array(doc.ambiguous ?? [], 'ambiguous').length,
    externalCalls = array(doc.external ?? [], 'external').length;
  const graph = {
    schema_version: '1',
    snapshot_id: text(snapshot.id, 'snapshot.id'),
    files,
    entities,
    relation_sets,
    diagnostics,
    quality: {
      parsed_file_count: files.length - failedFiles,
      failed_file_count: failedFiles,
      resolved_call_count: calls.length,
      ambiguous_call_count: ambiguousCalls,
      external_call_count: externalCalls,
      unsupported_file_count: countCollection(provenance.unsupported),
      vendored_excluded_count: countCollection(provenance.vendored_excluded),
      too_large_file_count: countCollection(provenance.too_large),
    },
    stats: {
      file_count: files.length,
      symbol_count: rawSymbols.length,
      module_entity_count: files.length,
      relation_count: relation_sets.reduce((sum, set) => sum + set.edges.length, 0),
      relation_counts: Object.fromEntries(
        relation_sets.map((set) => [set.relation, set.edges.length]),
      ),
    },
  };
  return {
    schema_version: '1',
    snapshot: {
      id: snapshot.id,
      project_id: snapshot.project_id ?? snapshot.id,
      version: text(snapshot.version, 'snapshot.version'),
      root: text(snapshot.root, 'snapshot.root'),
      files: [...snapshotFiles].sort(),
    },
    code_map: {
      analyzer: 'dekko',
      analyzer_version:
        typeof provenance.tool_version === 'string' ? provenance.tool_version : 'unknown',
      document_version: doc.version,
      path: map_path,
      ...(Number.isInteger(map_bytes) ? { bytes: map_bytes } : {}),
      ...(Number.isFinite(map_updated_at) ? { updated_at: map_updated_at } : {}),
      ...(typeof doc.generated_at === 'string' ? { generated_at: doc.generated_at } : {}),
      snapshot_id: snapshot.id,
      snapshot_version: snapshot.version,
      status: 'ready',
    },
    graph,
  };
}

export async function loadDekkoPlanningInput({
  map_path,
  snapshot,
  read_file = readFile,
  stat_file = stat,
}) {
  if (typeof map_path !== 'string' || !map_path)
    invalid('MAP_PATH_REQUIRED', '必须提供 map.json 路径');
  let raw;
  try {
    raw = await read_file(map_path);
  } catch (error) {
    invalid('MAP_READ_FAILED', `无法读取 Dekko map.json：${error.message}`);
  }
  let document;
  try {
    document = JSON.parse(raw.toString('utf8'));
  } catch {
    invalid('INVALID_JSON', 'Dekko map.json 不是有效 JSON');
  }
  let info;
  try {
    info = await stat_file(map_path);
  } catch (error) {
    invalid('MAP_STAT_FAILED', `无法读取 Dekko map.json 状态：${error.message}`);
  }
  return adaptDekkoMap(document, {
    snapshot,
    map_path,
    map_bytes: info.size,
    map_updated_at: info.mtimeMs,
  });
}
