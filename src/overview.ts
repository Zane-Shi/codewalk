import path from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { makeTools, resourceLoader } from './agent.ts';
import { ensureDekkoMap } from './dekko-map.ts';
import {
  activateRoutePlanningTools,
  createDekkoResourceLoader,
  DEKKO_ROUTE_TOOL_NAMES,
  disposeRoutePlanningSession,
  ROUTE_SOURCE_TOOL_NAMES,
} from './dekko-mcp.ts';
import { buildOverviewSeed, overviewRelationSupported } from './overview-seed.ts';
import { validationFailure, validationFailureDetails } from './validation-feedback.ts';

// Admission estimates are separate from actual usage; neither is a billing guarantee.
export const OVERVIEW_BUDGET = {
  totalTokens: 180000,
  readChars: 120000,
  calls: 48,
  requests: 12,
  outputTokens: 12000,
};
export const estimateTokens = (value) => {
  const text = JSON.stringify(value);
  const nonAscii = (text.match(/[^\x00-\x7f]/g) ?? []).length;
  return Math.ceil((text.length - nonAscii) / 3 + nonAscii * 1.5) + 512;
};

const OVERVIEW_SUPPORT_SEGMENTS = new Set([
  'test',
  'tests',
  '__tests__',
  'benchmark',
  'benchmarks',
  'fixtures',
  'examples',
  'docs',
  'scripts',
]);
const OVERVIEW_ENTRY_PRIORITY = new Map(
  ['main', 'cli', 'server', 'app', 'entry', 'bootstrap', 'index'].map((name, index) => [
    name,
    index,
  ]),
);

function isOverviewSupportPath(file) {
  return file
    .toLowerCase()
    .split('/')
    .some((segment) => OVERVIEW_SUPPORT_SEGMENTS.has(segment));
}

/** Rank a small reading queue without letting nested benchmark/example READMEs lead the overview. */
export function overviewRecommendedReads(snapshot, overviewSeed, limit = 30) {
  const files = new Set(snapshot.files);
  const rootReadmes = snapshot.files.filter(
    (file) => !file.includes('/') && /^readme(?:\.[^/]+)?$/i.test(file),
  );
  const packages = [...(overviewSeed?.packages ?? [])].sort(
    (left, right) => right.fileCount - left.fileCount || left.path.localeCompare(right.path),
  );
  const packageReadmes = packages.flatMap((pkg) =>
    snapshot.files.filter((file) => {
      if (!/(^|\/)readme(?:\.[^/]+)?$/i.test(file) || isOverviewSupportPath(file)) return false;
      return pkg.path === '.' ? !file.includes('/') : path.posix.dirname(file) === pkg.path;
    }),
  );
  const manifests = packages.map((pkg) => pkg.manifest).filter((file) => files.has(file));
  const candidates =
    overviewSeed?.areas.flatMap((area) => [
      ...area.candidateEntryFiles,
      ...area.candidateKeyFiles.slice(0, 2),
    ]) ?? [];
  return [
    ...new Set([
      ...rootReadmes,
      ...packageReadmes,
      ...(files.has('package.json') ? ['package.json'] : []),
      ...manifests,
      ...candidates,
      ...snapshot.files.filter((file) => !isOverviewSupportPath(file)),
      ...snapshot.files,
    ]),
  ].slice(0, limit);
}

function preferredEntry(files) {
  return [...files].sort((left, right) => {
    const leftBase = path.posix.basename(left, path.posix.extname(left)).toLowerCase();
    const rightBase = path.posix.basename(right, path.posix.extname(right)).toLowerCase();
    return (
      (OVERVIEW_ENTRY_PRIORITY.get(leftBase) ?? 99) -
        (OVERVIEW_ENTRY_PRIORITY.get(rightBase) ?? 99) ||
      left.split('/').length - right.split('/').length ||
      left.localeCompare(right)
    );
  })[0];
}

/** Select bounded graph probes from the deterministic seed; the model interprets their results later. */
export function overviewGraphQueries(overviewSeed) {
  if (!overviewSeed) return [];
  const packages = [...overviewSeed.packages].sort(
    (left, right) => right.fileCount - left.fileCount || left.path.localeCompare(right.path),
  );
  const packageAreas = packages
    .map(
      (pkg) =>
        overviewSeed.areas.find(
          (area) => area.path === (pkg.path === '.' ? 'src' : `${pkg.path}/src`),
        ) ?? overviewSeed.areas.find((area) => area.path === pkg.path),
    )
    .filter(Boolean);
  const fallbackAreas = [...overviewSeed.areas].sort(
    (left, right) => right.fileCount - left.fileCount || left.path.localeCompare(right.path),
  );
  const targets = [
    ...new Set(
      [...packageAreas, ...fallbackAreas]
        .map((area) =>
          preferredEntry(area.candidateEntryFiles.filter((file) => !isOverviewSupportPath(file))),
        )
        .filter(Boolean),
    ),
  ].slice(0, 3);
  const queries = targets.map((target) => ({
    tool: 'outline',
    target,
    args: { target, limit: 80, budget: 1000 },
  }));
  if (targets[0])
    queries.push({
      tool: 'get_context_pack',
      target: targets[0],
      args: {
        target: targets[0],
        hops: 1,
        budget: 1200,
        with_source: false,
        task: 'Identify this project entry point, its responsibility, and the major project areas it hands work to.',
      },
    });
  return queries;
}

export function overviewCoverage(snapshot, nodes) {
  const packages = snapshot.files
    .filter((f) => f.endsWith('/package.json') && f.split('/').length === 2)
    .map((f) => f.split('/')[0]);
  const expected = new Set(packages);
  for (const file of snapshot.files) {
    const bits = file.split('/');
    if (packages.includes(bits[0]) && bits[1] === 'src') {
      expected.add(bits.slice(0, 2).join('/'));
      if (bits.length > 3) expected.add(bits.slice(0, 3).join('/'));
    }
  }
  const confirmed = new Set(nodes.filter((n) => n.confidence === 'confirmed').map((n) => n.path));
  const missing = [...expected].filter((p) => !confirmed.has(p));
  return { expected: [...expected], missing, confirmed: expected.size - missing.length };
}
export function validateOverview(
  text,
  snapshot,
  { allowDirectoryOnly = false, overviewSeed, requireArchitecture = Boolean(overviewSeed) } = {},
) {
  const result = JSON.parse(
    text
      .trim()
      .replace(/^```(?:json)?\s*/, '')
      .replace(/\s*```$/, ''),
  );
  const checkText = (value, max) =>
    typeof value === 'string' && value.trim().length > 0 && value.length <= max;
  if (!checkText(result.purpose, 1600) || !checkText(result.scope, 800))
    throw new Error('总览缺少项目用途或分析范围');
  const dirs = new Set();
  for (const file of snapshot.files) {
    let dir = path.posix.dirname(file);
    while (dir !== '.') {
      dirs.add(dir);
      dir = path.posix.dirname(dir);
    }
  }
  if (!Array.isArray(result.nodes) || !result.nodes.length || result.nodes.length > 250)
    throw new Error('目录地图需要 1–250 个节点');
  const seen = new Set();
  const nodes = result.nodes.map((node) => {
    if (!checkText(node.path, 1000) || !checkText(node.description, 500)) {
      const error = new Error('目录节点缺少有效路径或说明');
      error.code = 'NODE_FORMAT';
      throw error;
    }
    if (seen.has(node.path)) {
      const error = new Error(`目录地图重复引用路径：${node.path}`);
      error.code = 'NODE_DUPLICATE';
      error.path = node.path;
      throw error;
    }
    if (
      !['directory', 'file'].includes(node.kind) ||
      !['confirmed', 'uncertain'].includes(node.confidence)
    ) {
      const error = new Error(`目录节点类型或置信度无效：${node.path}`);
      error.code = 'NODE_FORMAT';
      error.path = node.path;
      throw error;
    }
    const valid =
      node.kind === 'directory'
        ? dirs.has(node.path)
        : node.kind === 'file' && snapshot.files.includes(node.path);
    if (!valid) {
      const error = new Error(`目录地图引用了快照中不存在的路径：${node.path}`);
      error.code = 'INVALID_NODE_PATH';
      error.path = node.path;
      throw error;
    }
    seen.add(node.path);
    return {
      path: node.path,
      kind: node.kind,
      description: node.description,
      confidence: node.confidence,
    };
  });
  if (!allowDirectoryOnly && !nodes.some((n) => n.kind === 'file')) {
    const error = new Error(
      '目录地图缺少精选重要文件：只补充8–15个真实文件节点，不改写已有目录说明',
    );
    error.code = 'MISSING_FILES';
    throw error;
  }
  if (
    !Array.isArray(result.technologies) ||
    result.technologies.length > 5 ||
    !result.technologies.every((t) => checkText(t.name, 100) && checkText(t.role, 400))
  )
    throw new Error('技术背景格式无效');
  if (
    !Array.isArray(result.limitations) ||
    result.limitations.length > 20 ||
    !result.limitations.every((t) => checkText(t, 500))
  )
    throw new Error('覆盖说明格式无效');
  const capabilities = result.capabilities ?? [];
  if (
    !Array.isArray(capabilities) ||
    capabilities.length > 8 ||
    !capabilities.every((item) => checkText(item, 300))
  )
    throw new Error('项目能力列表格式无效');
  if (requireArchitecture && !capabilities.length)
    throw new Error('总览缺少面向用户的项目能力说明');

  const rawAreas = result.areas ?? [];
  if (!Array.isArray(rawAreas) || rawAreas.length > 20 || (requireArchitecture && !rawAreas.length))
    throw validationFailure('AREA_COUNT_INVALID', '语义区域需要 1–20 项', {
      location: { field: 'areas' },
      actual: Array.isArray(rawAreas) ? rawAreas.length : typeof rawAreas,
      expected: { minimum: requireArchitecture ? 1 : 0, maximum: 20 },
    });
  const areaIds = new Set();
  const areas = rawAreas.map((area, index) => {
    const field = (name) => ({ field: `areas[${index}].${name}`, areaId: area?.id });
    if (!checkText(area?.id, 100))
      throw validationFailure('AREA_ID_INVALID', '语义区域缺少有效且不超过 100 字的 id', {
        location: field('id'),
        actual: area?.id,
      });
    if (areaIds.has(area.id))
      throw validationFailure('AREA_ID_DUPLICATE', `语义区域 id 重复：${area.id}`, {
        location: field('id'),
        actual: area.id,
      });
    if (!checkText(area.title, 120))
      throw validationFailure('AREA_TITLE_INVALID', `语义区域 ${area.id} 的标题无效`, {
        location: field('title'),
        actual: area.title,
      });
    if (!checkText(area.summary, 600))
      throw validationFailure('AREA_SUMMARY_INVALID', `语义区域 ${area.id} 的摘要无效`, {
        location: field('summary'),
        actual: area.summary,
      });
    if (!checkText(area.whyItMatters, 500))
      throw validationFailure(
        'AREA_WHY_IT_MATTERS_INVALID',
        `语义区域 ${area.id} 缺少有效的阅读价值说明`,
        {
          location: field('whyItMatters'),
          actual: area.whyItMatters,
        },
      );
    if (!['core', 'important', 'supporting'].includes(area.importance))
      throw validationFailure(
        'AREA_IMPORTANCE_INVALID',
        `语义区域 ${area.id} 的 importance 必须使用规定枚举值`,
        {
          location: field('importance'),
          actual: area.importance,
          expected: ['core', 'important', 'supporting'],
          repair: {
            action: 'replace_enum_value',
            allowed_values: ['core', 'important', 'supporting'],
          },
        },
      );
    if (
      !Array.isArray(area.paths) ||
      !area.paths.length ||
      area.paths.length > 12 ||
      new Set(area.paths).size !== area.paths.length ||
      !area.paths.every(
        (item) => typeof item === 'string' && (dirs.has(item) || snapshot.files.includes(item)),
      )
    )
      throw validationFailure('AREA_PATH_INVALID', `语义区域 ${area.id} 引用了无效路径`, {
        location: field('paths'),
        actual: area.paths,
        expected: '当前快照内存在且不重复的 1–12 个文件或目录路径',
      });
    if (
      !Array.isArray(area.keyFiles) ||
      area.keyFiles.length > 8 ||
      !area.keyFiles.every(
        (item) => snapshot.files.includes(item.path) && checkText(item.reason, 300),
      )
    ) {
      throw validationFailure('AREA_KEY_FILE_INVALID', `语义区域 ${area.id} 的关键文件无效`, {
        location: field('keyFiles'),
        actual: area.keyFiles,
        expected: '当前快照内存在的文件及非空选择理由',
      });
    }
    areaIds.add(area.id);
    return {
      id: area.id,
      title: area.title,
      summary: area.summary,
      whyItMatters: area.whyItMatters,
      importance: area.importance,
      paths: [...area.paths],
      keyFiles: area.keyFiles.map((item) => ({ path: item.path, reason: item.reason })),
    };
  });
  const areaById = new Map(areas.map((area) => [area.id, area]));
  // A one-area project has no meaningful inter-area relation. Ignore a model's
  // decorative self-edge instead of spending another provider request on it.
  const rawRelations = areas.length < 2 ? [] : (result.relations ?? []);
  if (
    !Array.isArray(rawRelations) ||
    rawRelations.length > 40 ||
    (requireArchitecture && areas.length > 1 && !rawRelations.length)
  ) {
    const error = new Error('区域关系格式无效或缺失');
    error.code = 'RELATION_FORMAT';
    throw error;
  }
  const relationKeys = new Set();
  let downgradedRelations = 0;
  const relations = rawRelations.map((relation) => {
    const from = areaById.get(relation.fromAreaId),
      to = areaById.get(relation.toAreaId);
    const key = `${relation.fromAreaId}\0${relation.toAreaId}\0${relation.kind}`;
    if (
      !from ||
      !to ||
      from === to ||
      relationKeys.has(key) ||
      !['calls', 'imports', 'supports'].includes(relation.kind) ||
      !checkText(relation.summary, 400) ||
      !['confirmed', 'inferred'].includes(relation.confidence)
    ) {
      const error = new Error('区域关系引用或格式无效');
      error.code = 'RELATION_FORMAT';
      throw error;
    }
    const confidence =
      relation.confidence === 'confirmed' &&
      overviewSeed &&
      !overviewRelationSupported(overviewSeed, from.paths, to.paths, relation.kind)
        ? (downgradedRelations++, 'inferred')
        : relation.confidence;
    relationKeys.add(key);
    return {
      fromAreaId: relation.fromAreaId,
      toAreaId: relation.toAreaId,
      kind: relation.kind,
      summary: relation.summary,
      confidence,
    };
  });
  // Missing top-level areas remain visible instead of silently claiming complete coverage.
  const roots = new Set(
    snapshot.files.map((f) => (f.includes('/') ? f.split('/')[0] : null)).filter(Boolean),
  );
  const missing = [...roots].filter(
    (root) => !nodes.some((n) => n.path === root || n.path.startsWith(root + '/')),
  );
  const limitations = [...result.limitations];
  if (downgradedRelations)
    limitations.push(`${downgradedRelations} 条区域关系缺少同方向图谱依据，已标记为待核实。`);
  if (missing.length) limitations.push(`尚未说明的顶层目录：${missing.join('、')}`);
  if (nodes.some((n) => n.confidence === 'uncertain'))
    limitations.push('标记为“待核实”的节点仅提供初步说明。');
  const coverage = overviewCoverage(snapshot, nodes);
  if (coverage.missing.length)
    limitations.push(`主要包或源码目录仍需补充：${coverage.missing.join('、')}`);
  return {
    coverage,
    purpose: result.purpose,
    capabilities,
    scope: result.scope,
    areas,
    relations,
    nodes,
    technologies: result.technologies.map((t) => ({ name: t.name, role: t.role })),
    limitations,
    partial: limitations.length > 0,
  };
}

/** Canonicalize only node properties that the imported snapshot can prove mechanically. */
export function sanitizeOverviewNodes(text, snapshot, options = {}) {
  const result = JSON.parse(
    text
      .trim()
      .replace(/^```(?:json)?\s*/, '')
      .replace(/\s*```$/, ''),
  );
  if (!Array.isArray(result.nodes)) throw new Error('目录地图缺少 nodes 数组');
  const dirs = new Set();
  for (const file of snapshot.files) {
    let dir = path.posix.dirname(file);
    while (dir !== '.') {
      dirs.add(dir);
      dir = path.posix.dirname(dir);
    }
  }
  const rejectedPaths = [],
    adjustments = [],
    nodes = [],
    seen = new Set();
  for (const node of result.nodes) {
    if (
      !node ||
      typeof node.path !== 'string' ||
      !node.path.trim() ||
      typeof node.description !== 'string' ||
      !node.description.trim()
    ) {
      nodes.push(node);
      continue;
    }
    const actualKind = snapshot.files.includes(node.path)
      ? 'file'
      : dirs.has(node.path)
        ? 'directory'
        : undefined;
    if (!actualKind) {
      rejectedPaths.push(node.path);
      continue;
    }
    if (seen.has(node.path)) {
      adjustments.push({ path: node.path, action: 'deduplicated' });
      continue;
    }
    seen.add(node.path);
    const confidence = ['confirmed', 'uncertain'].includes(node.confidence)
      ? node.confidence
      : 'uncertain';
    const description = node.description.slice(0, 500);
    if (node.kind !== actualKind)
      adjustments.push({ path: node.path, action: `kind:${actualKind}` });
    if (node.confidence !== confidence)
      adjustments.push({ path: node.path, action: 'confidence:uncertain' });
    if (node.description !== description)
      adjustments.push({ path: node.path, action: 'description:truncated' });
    nodes.push({ ...node, kind: actualKind, confidence, description });
  }
  const areaIds = new Set(
    (Array.isArray(result.areas) ? result.areas : []).map((area) => area?.id).filter(Boolean),
  );
  const relationKeys = new Set(),
    relations = [];
  let rejectedRelations = 0;
  for (const relation of Array.isArray(result.relations) ? result.relations : []) {
    if (
      !relation ||
      !areaIds.has(relation.fromAreaId) ||
      !areaIds.has(relation.toAreaId) ||
      relation.fromAreaId === relation.toAreaId ||
      !['calls', 'imports', 'supports'].includes(relation.kind) ||
      typeof relation.summary !== 'string' ||
      !relation.summary.trim()
    ) {
      rejectedRelations++;
      continue;
    }
    const key = `${relation.fromAreaId}\0${relation.toAreaId}\0${relation.kind}`;
    if (relationKeys.has(key)) {
      rejectedRelations++;
      continue;
    }
    relationKeys.add(key);
    const normalized = {
      ...relation,
      summary: relation.summary.slice(0, 400),
      confidence: ['confirmed', 'inferred'].includes(relation.confidence)
        ? relation.confidence
        : 'inferred',
    };
    if (normalized.summary !== relation.summary || normalized.confidence !== relation.confidence)
      rejectedRelations++;
    relations.push(normalized);
  }
  if (!rejectedPaths.length && !adjustments.length && !rejectedRelations) {
    return {
      overview: validateOverview(text, snapshot, options),
      rejectedPaths,
      adjustments,
      rejectedRelations,
    };
  }
  const shown = rejectedPaths.slice(0, 8).join('、');
  const suffix = rejectedPaths.length > 8 ? `等 ${rejectedPaths.length} 项` : '';
  const limitation = `目录地图中不存在的路径已丢弃：${shown}${suffix}`.slice(0, 500);
  const limitations = Array.isArray(result.limitations) ? [...result.limitations] : [];
  if (rejectedPaths.length) limitations.push(limitation);
  if (rejectedRelations)
    limitations.push(`${rejectedRelations} 条重复或无效的区域关系已在保存前清理。`);
  return {
    overview: validateOverview(
      JSON.stringify({ ...result, nodes, relations, limitations: limitations.slice(-20) }),
      snapshot,
      options,
    ),
    rejectedPaths,
    adjustments,
    rejectedRelations,
  };
}

// Repair missing file coverage incrementally, preserving the validated purpose/tree.
export function mergeOverviewFiles(baseText, candidateText, snapshot, options = {}) {
  const base = validateOverview(baseText, snapshot, { ...options, allowDirectoryOnly: true });
  const candidate = JSON.parse(
    candidateText
      .trim()
      .replace(/^```(?:json)?\s*/, '')
      .replace(/\s*```$/, ''),
  );
  if (!Array.isArray(candidate.nodes)) throw new Error('文件补正缺少 nodes 数组');
  const rejected = [],
    groups = new Map(),
    seen = new Set(base.nodes.map((n) => n.path));
  for (const node of candidate.nodes.filter((n) => n.kind === 'file')) {
    if (!snapshot.files.includes(node.path)) {
      rejected.push(String(node.path));
      continue;
    }
    if (seen.has(node.path)) continue;
    seen.add(node.path);
    const group = node.path.includes('/') ? node.path.split('/')[0] : '.';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(node);
  }
  const selected = [];
  while (selected.length < 15 && [...groups.values()].some((g) => g.length)) {
    for (const group of groups.values())
      if (group.length && selected.length < 15) selected.push(group.shift());
  }
  const limitations = [...base.limitations];
  if (rejected.length) limitations.push(`文件补正中不存在的候选已丢弃：${rejected.join('、')}`);
  return validateOverview(
    JSON.stringify({
      ...base,
      nodes: [...base.nodes, ...selected],
      limitations: [...new Set(limitations)],
    }),
    snapshot,
    options,
  );
}

const defaultOverviewToolRuntime = Object.freeze({
  ensureMap: ensureDekkoMap,
  createResourceLoader: createDekkoResourceLoader,
  activateTools: activateRoutePlanningTools,
  disposeSession: disposeRoutePlanningSession,
  bindExtensions: true,
});

export async function runOverview({
  snapshot,
  model: modelId,
  signal,
  emit,
  modelRuntime,
  dataDir,
  budget = OVERVIEW_BUDGET,
  overviewToolRuntime = defaultOverviewToolRuntime,
  recovery_context,
}) {
  const runtime = modelRuntime ?? (await ModelRuntime.create());
  const model = (await runtime.getAvailable()).find((m) => `${m.provider}/${m.id}` === modelId);
  if (!model) throw new Error('请选择可用模型');
  const prompt = (
    await Promise.all(
      ['overview.md', 'overview-investigation.md'].map((name) =>
        readFile(new URL(`./prompts/${name}`, import.meta.url), 'utf8'),
      ),
    )
  ).join('\n\n');
  let phase = 'investigating',
    calls = 0,
    chars = 0,
    graphChars = 0,
    requests = 0,
    charged = 0,
    pending = 0,
    forced = false,
    fallbackRequests = 0,
    initial,
    repairError;
  let codeMap, overviewSeed, mapError;
  const evidence = [],
    graphEvidence = [],
    seededGraphQueries = [];
  if (overviewToolRuntime.bindExtensions !== false) {
    try {
      emit('progress', { tool: 'dekko-map', path: '.dekko/map.json' });
      codeMap = await overviewToolRuntime.ensureMap({ root: snapshot.root, signal });
      overviewSeed = buildOverviewSeed(JSON.parse(await readFile(codeMap.path, 'utf8')), snapshot);
    } catch (error) {
      mapError = error instanceof Error ? error.message : String(error);
      emit('phase', {
        status: phase,
        message: `代码图谱不可用，使用源码工具继续生成总览：${mapError}`,
      });
    }
  }
  const tools = makeTools(
    snapshot,
    evidence,
    (data) => emit('progress', data),
    () => {},
    signal,
    { calls: budget.calls, readChars: budget.readChars },
  )
    .filter((t) => t.name !== 'prepare_explanation')
    .map((tool) => ({
      ...tool,
      async execute(...args) {
        signal.throwIfAborted();
        if (phase !== 'investigating' || calls >= budget.calls || chars >= budget.readChars)
          return {
            content: [{ type: 'text', text: '调查预算已到，请用已有信息生成总览，不再调用工具。' }],
          };
        calls++;
        // Keep native per-call truncation and accurate continuation offsets intact.
        // A final admitted result may exceed the soft cumulative character boundary.
        const result = await tool.execute(...args);
        chars += result.content
          .filter((c) => c.type === 'text')
          .reduce((n, c) => n + c.text.length, 0);
        return result;
      },
    }));
  const useDekko = Boolean(overviewSeed && overviewToolRuntime.bindExtensions !== false);
  const settingsManager = SettingsManager.inMemory({
    retry: { enabled: false },
    compaction: { enabled: false },
  });
  const agentDir = path.join(
    dataDir ?? path.dirname(path.dirname(snapshot.root)),
    'pi-config-overview',
  );
  if (useDekko) await mkdir(agentDir, { recursive: true });
  const loader = useDekko
    ? await overviewToolRuntime.createResourceLoader({
        cwd: snapshot.root,
        agentDir,
        settingsManager,
        prompt,
      })
    : resourceLoader(prompt);
  const { session } = await createAgentSession({
    cwd: snapshot.root,
    model,
    modelRuntime: runtime,
    thinkingLevel: 'off',
    agentDir,
    settingsManager,
    resourceLoader: loader,
    tools: [...tools.map((t) => t.name), ...(useDekko ? DEKKO_ROUTE_TOOL_NAMES : [])],
    customTools: tools,
    sessionManager: SessionManager.inMemory(snapshot.root),
  });
  try {
    if (useDekko) {
      await session.bindExtensions({ mode: 'print' });
      await overviewToolRuntime.activateTools(
        session,
        tools.map((tool) => tool.name),
        { signal, investigationToolNames: [...DEKKO_ROUTE_TOOL_NAMES, ...ROUTE_SOURCE_TOOL_NAMES] },
      );
    }
  } catch (error) {
    if (useDekko && overviewToolRuntime.disposeSession)
      await overviewToolRuntime.disposeSession(session);
    else session.dispose();
    throw error;
  }
  const stream = session.agent.streamFunction;
  // Enforce admission before EVERY provider call, including automatic tool-loop calls.
  session.agent.streamFunction = (selectedModel, context, options) => {
    signal.throwIfAborted();
    const input = estimateTokens(context),
      output = Math.min(budget.outputTokens, model.maxTokens);
    const reserve = input + 10000 + output + 2500;
    if (
      phase === 'investigating' &&
      (requests >= budget.requests - 1 ||
        calls >= budget.calls ||
        chars >= budget.readChars ||
        charged + input + output + reserve >= budget.totalTokens ||
        input + 10000 + output + 2500 >= model.contextWindow)
    ) {
      phase = 'finalizing';
      forced = true;
      session.setActiveToolsByName([]);
      emit('phase', { status: phase, message: '调查已收尾，正在生成目录地图' });
    }
    // Do not carry tool-call protocol messages into a tool-free provider request.
    // Some providers otherwise emit raw tool markup instead of a final answer.
    const finalContext =
      phase === 'finalizing'
        ? {
            systemPrompt:
              prompt +
              '\n调查已经结束。以下 evidence 是已读取资料，不再调用工具，只输出最终 JSON。',
            tools: [],
            messages: [
              {
                role: 'user',
                content: JSON.stringify({
                  project: initial,
                  repairError,
                  evidence: [...evidence]
                    .sort(
                      (left, right) =>
                        (left.path ?? '').localeCompare(right.path ?? '') ||
                        (left.args?.offset ?? 1) - (right.args?.offset ?? 1) ||
                        left.id.localeCompare(right.id),
                    )
                    .map((e) => ({ id: e.id, path: e.path, text: e.text })),
                }),
                timestamp: Date.now(),
              },
            ],
          }
        : context;
    if (phase === 'finalizing') emit('checkpoint', { input: finalContext });
    const actualInput = estimateTokens(finalContext);
    const maxTokens = Math.floor(
      Math.min(
        output,
        budget.totalTokens - charged - actualInput,
        model.contextWindow - actualInput - 512,
      ),
    );
    if (maxTokens < 512 || requests >= budget.requests + 1)
      throw new Error('剩余预算不足以安全生成总览，请缩小项目范围');
    pending = actualInput + maxTokens;
    requests++;
    emit('budget', {
      requests,
      calls,
      readChars: chars,
      graphChars,
      chargedTokens: charged,
      totalTokens: budget.totalTokens,
      phase,
    });
    return stream(selectedModel, finalContext, { ...options, maxTokens, maxRetries: 0 });
  };
  const off = session.subscribe((event) => {
    if (event.type === 'tool_execution_start' && DEKKO_ROUTE_TOOL_NAMES.includes(event.toolName)) {
      calls++;
      emit('progress', { tool: event.toolName, path: 'Dekko 代码图谱' });
      if (calls >= budget.calls) {
        phase = 'finalizing';
        forced = true;
        session.setActiveToolsByName([]);
      }
      return;
    }
    if (event.type === 'tool_execution_end' && DEKKO_ROUTE_TOOL_NAMES.includes(event.toolName)) {
      const text = Array.isArray(event.result?.content)
        ? event.result.content
            .filter((item) => item.type === 'text')
            .map((item) => item.text)
            .join('\n')
        : '';
      if (text && graphChars < 60000) {
        const retained = text.slice(0, Math.min(12000, 60000 - graphChars));
        graphEvidence.push({ tool: event.toolName, text: retained });
        graphChars += retained.length;
      }
      return;
    }
    if (event.type === 'message_end' && event.message.role === 'assistant') {
      const u = event.message.usage;
      const actual = u
        ? (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0)
        : 0;
      if (actual > 0) charged += actual;
      else {
        charged += pending;
        fallbackRequests++;
      }
      pending = 0;
      emit('usage', { budgetChargedTokens: charged, requests, toolCalls: calls, fallbackRequests });
    }
  });
  const cancel = () => {
    void session.abort().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    signal.throwIfAborted();
    // Broad directory coverage at low cost; files are discovered on demand with find/ls.
    const dirs = new Set();
    for (const file of snapshot.files) {
      let dir = path.posix.dirname(file);
      while (dir !== '.') {
        dirs.add(dir);
        dir = path.posix.dirname(dir);
      }
    }
    const directoryList = [...dirs].sort();
    const recommendedReads = overviewRecommendedReads(snapshot, overviewSeed);
    const minimumEvidence = [];
    if (overviewSeed && recommendedReads.length) {
      emit('phase', { status: phase, message: '正在读取少量项目级资料，核实项目用途与主要包分工' });
      const readTool = tools.find((tool) => tool.name === 'read');
      for (const [index, target] of recommendedReads
        .slice(0, Math.min(3, overviewSeed.packages.length || 1))
        .entries()) {
        const readResult = await readTool.execute(
          `overview-minimum-read-${index + 1}`,
          { path: target, offset: 1, limit: 180 },
          signal,
          () => {},
          {},
        );
        minimumEvidence.push({
          path: target,
          text: readResult.content
            .filter((item) => item.type === 'text')
            .map((item) => item.text)
            .join('\n'),
        });
      }
    }
    if (useDekko) {
      emit('phase', { status: phase, message: '正在用 Dekko 核实主要入口及跨区域交接' });
      for (const [index, query] of overviewGraphQueries(overviewSeed).entries()) {
        signal.throwIfAborted();
        if (calls >= budget.calls || graphChars >= 60000) break;
        const tool = session.getToolDefinition(query.tool);
        if (!tool) {
          seededGraphQueries.push({
            tool: query.tool,
            target: query.target,
            ok: false,
            error: '工具未注册',
          });
          continue;
        }
        calls++;
        emit('progress', { tool: query.tool, path: query.target });
        try {
          const result = await tool.execute(
            `overview-graph-seed-${index + 1}`,
            { ...query.args, root: snapshot.root },
            signal,
            () => {},
            { cwd: snapshot.root },
          );
          const text = Array.isArray(result?.content)
            ? result.content
                .filter((item) => item.type === 'text')
                .map((item) => item.text)
                .join('\n')
            : '';
          const retained = text.slice(0, Math.min(12000, 60000 - graphChars));
          if (retained) {
            graphEvidence.push({ tool: query.tool, target: query.target, text: retained });
            graphChars += retained.length;
          }
          seededGraphQueries.push({
            tool: query.tool,
            target: query.target,
            ok: !result?.isError,
            chars: retained.length,
          });
        } catch (error) {
          seededGraphQueries.push({
            tool: query.tool,
            target: query.target,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    initial = {
      task: 'generate-project-overview',
      project: snapshot.name,
      snapshotVersion: snapshot.version,
      scope: '仅当前导入快照，不推断目录外项目',
      overviewSeed,
      graphAvailable: Boolean(overviewSeed),
      graphError: mapError,
      minimumEvidence,
      graphEvidence,
      recommendedReads,
      directories: overviewSeed ? undefined : directoryList.slice(0, 350),
      directoriesTruncated: overviewSeed ? undefined : directoryList.length > 350,
      coverageTargets: overviewCoverage(snapshot, []).expected,
      rootFiles: snapshot.files.filter((f) => !f.includes('/')).slice(0, 100),
      fileCount: snapshot.files.length,
      excludedCount: snapshot.skipped.length,
      ...(recovery_context ? { recovery_context } : {}),
    };
    if (overviewSeed && snapshot.files.length <= 3) {
      phase = 'finalizing';
      session.setActiveToolsByName([]);
      emit('phase', { status: phase, message: '项目规模很小，正在根据图谱和已读源码直接生成总览' });
    }
    await session.prompt(JSON.stringify(initial), { expandPromptTemplates: false });
    signal.throwIfAborted();
    const lastText = () => {
      const message = session.messages.findLast((m) => m.role === 'assistant');
      if (!message || message.stopReason === 'aborted') throw new Error('模型未正常完成总览生成');
      const text = message.content
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('\n');
      if (!text.trim()) throw new Error('模型未正常完成总览生成');
      return text;
    };
    let overview,
      draft,
      rejectedNodePaths = [],
      normalizedNodeIssues = [],
      rejectedRelations = 0;
    const validationAttempts = [];
    const recordValidationAttempt = (attempt, decision, error) => {
      const failure = validationFailureDetails(error);
      validationAttempts.push({
        attempt,
        ...failure,
        decision: String(decision ?? '').slice(0, 24000),
        createdAt: Date.now(),
      });
      emit('checkpoint', { validationAttempts: structuredClone(validationAttempts) });
      return failure;
    };
    if (
      !evidence.some((item) => item.tool === 'read') &&
      phase === 'investigating' &&
      calls < budget.calls &&
      chars < budget.readChars
    ) {
      emit('phase', { status: phase, message: '正在用真实源码核实项目用途和核心职责' });
      const target = recommendedReads[0],
        readTool = tools.find((tool) => tool.name === 'read');
      if (!target || !readTool) throw new Error('总览没有可读取的源码证据');
      const readResult = await readTool.execute(
        'overview-required-read',
        { path: target, offset: 1, limit: 240 },
        signal,
        () => {},
        {},
      );
      const readText = readResult.content
        .filter((item) => item.type === 'text')
        .map((item) => item.text)
        .join('\n');
      await session.prompt(
        `你尚未主动读取真实文件。工作流已读取最低必要证据 ${target}，请以它核实项目用途和核心职责，修正仅凭命名作出的猜测，并重新输出完整 JSON。\n\n${readText}`,
        { expandPromptTemplates: false },
      );
      signal.throwIfAborted();
    }
    if (!evidence.some((item) => item.tool === 'read'))
      throw new Error('总览缺少真实文档或源码读取证据，已拒绝保存');
    const validationOptions = { overviewSeed, requireArchitecture: Boolean(overviewSeed) };
    try {
      draft = lastText();
      overview = validateOverview(draft, snapshot, validationOptions);
    } catch (error) {
      // Keep repairs bounded and in the same isolated context.
      repairError = error.message;
      const firstFailure = recordValidationAttempt(1, draft, error);
      phase = 'finalizing';
      session.setActiveToolsByName([]);
      emit('phase', { status: phase, message: '正在校验并整理总览格式' });
      await session.prompt(
        `请修正最终 JSON。确定性校验结果：${JSON.stringify(firstFailure.issues)}。只修改这些字段，严格遵循系统中的结构，仅引用已知存在的路径，并重新输出完整 JSON。`,
        { expandPromptTemplates: false },
      );
      signal.throwIfAborted();
      if (error.code === 'MISSING_FILES')
        overview = mergeOverviewFiles(draft, lastText(), snapshot, validationOptions);
      else {
        const repaired = lastText();
        try {
          overview = validateOverview(repaired, snapshot, validationOptions);
        } catch (repairValidationError) {
          const secondFailure = recordValidationAttempt(2, repaired, repairValidationError);
          if (String(repairValidationError.code ?? '').startsWith('AREA_')) {
            await session.prompt(
              `上一次修订仍未通过。逐项应用以下确定性修复信息，不要重复原值：${JSON.stringify(secondFailure.issues)}。重新输出完整 JSON。`,
              { expandPromptTemplates: false },
            );
            signal.throwIfAborted();
            const finalRepair = lastText();
            try {
              overview = validateOverview(finalRepair, snapshot, validationOptions);
            } catch (finalValidationError) {
              recordValidationAttempt(3, finalRepair, finalValidationError);
              throw finalValidationError;
            }
          } else if (
            ['INVALID_NODE_PATH', 'NODE_DUPLICATE', 'NODE_FORMAT', 'RELATION_FORMAT'].includes(
              repairValidationError.code,
            )
          ) {
            const sanitized = sanitizeOverviewNodes(repaired, snapshot, validationOptions);
            overview = sanitized.overview;
            rejectedNodePaths = sanitized.rejectedPaths;
            normalizedNodeIssues = sanitized.adjustments;
            rejectedRelations = sanitized.rejectedRelations;
          } else {
            throw repairValidationError;
          }
        }
      }
    }
    // One targeted follow-up, only when coverage is incomplete and investigation has room.
    if (
      overview.coverage.missing.length &&
      phase === 'investigating' &&
      requests < budget.requests - 2 &&
      calls < budget.calls &&
      chars < budget.readChars
    ) {
      emit('phase', { status: 'investigating', message: '正在补齐主要包和源码目录的说明' });
      await session.prompt(
        `当前总览缺少这些主要区域的可靠说明：${overview.coverage.missing.join('、')}。优先利用已读文档，确有必要再补查。输出完整修订 JSON，不重复读取已足够的部分。`,
        { expandPromptTemplates: false },
      );
      signal.throwIfAborted();
      overview = validateOverview(lastText(), snapshot, validationOptions);
    }
    return {
      ...overview,
      stats: {
        ...session.getSessionStats().tokens,
        requests,
        toolCalls: calls,
        readChars: chars,
        graphChars,
        budgetChargedTokens: charged,
        fallbackRequests,
        forcedFinalization: forced,
        codeMap,
        overviewSeed: overviewSeed
          ? {
              areas: overviewSeed.areas.length,
              dependencies: overviewSeed.dependencies.length,
              mappedFiles: overviewSeed.project.mappedFileCount,
            }
          : undefined,
        minimumReads: minimumEvidence.map((item) => item.path),
        seededGraphQueries,
        rejectedNodePaths,
        normalizedNodeIssues,
        rejectedRelations,
        evidenceReads: evidence
          .filter((e) => e.tool === 'read')
          .map((e) => ({
            path: e.path,
            offset: e.args.offset ?? 1,
            limit: e.args.limit,
            chars: e.text.length,
          })),
        budget: { ...budget },
      },
    };
  } finally {
    signal.removeEventListener('abort', cancel);
    off();
    if (useDekko && overviewToolRuntime.disposeSession)
      await overviewToolRuntime.disposeSession(session);
    else session.dispose();
  }
}
