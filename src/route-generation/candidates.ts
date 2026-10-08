import { createHash } from 'node:crypto';
import {
  breadthFirstDepth,
  buildGraphIndex,
  compactEntityFileIndex,
  compactEntityId,
  compactEntityIsSymbol,
  compactSymbolIsExported,
  compactSymbolIsTest,
  createReachabilityCounter,
} from './graph-index.ts';

export const DEFAULT_PLANNING_SEED_BUDGET = Object.freeze({
  max_bytes: 48 * 1024,
  max_candidates: 120,
  max_clusters: 40,
  max_relations: 200,
  max_signals_per_candidate: 8,
  max_entry_seeds: 24,
});

const DEFAULT_ENTRY_NAMES = Object.freeze([
  'main',
  'run',
  'start',
  'serve',
  'bootstrap',
  'init',
  'initialize',
  'execute',
  'handler',
  'createapp',
  'createserver',
]);

function shortHash(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 10);
}

function bytes(value) {
  return Buffer.byteLength(JSON.stringify(value));
}

function positiveBudget(value, fallback, name) {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1) throw new Error(`${name} 必须是正整数`);
  return resolved;
}

function resolveBudget(override = {}) {
  return Object.fromEntries(
    Object.entries(DEFAULT_PLANNING_SEED_BUDGET).map(([key, value]) => [
      key,
      positiveBudget(override[key], value, key),
    ]),
  );
}

function rawCluster(path) {
  const slash = path.indexOf('/');
  return slash === -1 ? '(root)' : path.slice(0, slash);
}

function buildClusters(graph, maxClusters, includeTests) {
  const raw = new Map();
  for (const file of graph.files) {
    const key = rawCluster(file[0]),
      current = raw.get(key) ?? { key, file_count: 0, symbol_count: 0, eligible_symbol_count: 0 };
    current.file_count++;
    raw.set(key, current);
  }
  for (const entity of graph.entities) {
    if (!compactEntityIsSymbol(entity)) continue;
    const key = rawCluster(graph.files[compactEntityFileIndex(entity)][0]);
    raw.get(key).symbol_count++;
    if (includeTests || !compactSymbolIsTest(entity)) raw.get(key).eligible_symbol_count++;
  }
  const ordered = [...raw.values()].sort(
    (left, right) => right.file_count - left.file_count || left.key.localeCompare(right.key),
  );
  const kept =
    ordered.length <= maxClusters ? ordered : ordered.slice(0, Math.max(1, maxClusters - 1));
  const keptKeys = new Set(kept.map((item) => item.key)),
    merged = ordered.filter((item) => !keptKeys.has(item.key));
  if (merged.length)
    kept.push({
      key: '(other)',
      file_count: merged.reduce((sum, item) => sum + item.file_count, 0),
      symbol_count: merged.reduce((sum, item) => sum + item.symbol_count, 0),
      eligible_symbol_count: merged.reduce((sum, item) => sum + item.eligible_symbol_count, 0),
      merged_cluster_count: merged.length,
    });
  const clusters = kept.map((item) => ({
    id: `cl_${shortHash(item.key)}`,
    label: item.key,
    file_count: item.file_count,
    symbol_count: item.symbol_count,
    eligible_symbol_count: item.eligible_symbol_count,
    candidate_ids: [],
    ...(item.merged_cluster_count ? { merged_cluster_count: item.merged_cluster_count } : {}),
  }));
  const clusterByKey = new Map(clusters.map((cluster) => [cluster.label, cluster]));
  const outputKey = (key) => (keptKeys.has(key) || ordered.length <= maxClusters ? key : '(other)');
  return {
    clusters,
    clusterByRawKey: new Map(
      ordered.map((item) => [item.key, clusterByKey.get(outputKey(item.key))]),
    ),
    omittedClusters: merged.length,
  };
}

function percentile(values, ratio) {
  const positive = values.filter((value) => value > 0).sort((left, right) => left - right);
  return positive.length ? positive[Math.floor((positive.length - 1) * ratio)] : 0;
}

function symbolName(entity) {
  return entity[2];
}
function symbolKind(entity) {
  return entity[3];
}
function conventionalName(entity, names) {
  return names.has(symbolName(entity).toLowerCase());
}

function computeMetrics(index, clusterByEntity) {
  const count = index.graph.entities.length;
  const metrics = Array.from({ length: count }, () => ({
    in_degree: 0,
    out_degree: 0,
    symbol_callers: 0,
    module_callers: 0,
    reference_in: 0,
    reference_out: 0,
    cross_cluster_in: 0,
    cross_cluster_out: 0,
  }));
  for (const edge of index.callEdges) {
    const from = edge[0],
      to = edge[1],
      source = index.graph.entities[from];
    metrics[from].out_degree++;
    metrics[to].in_degree++;
    if (compactEntityIsSymbol(source)) metrics[to].symbol_callers++;
    else metrics[to].module_callers++;
    if (clusterByEntity[from] !== clusterByEntity[to]) {
      metrics[from].cross_cluster_out++;
      metrics[to].cross_cluster_in++;
    }
  }
  for (const edge of index.referenceEdges) {
    metrics[edge[0]].reference_out++;
    metrics[edge[1]].reference_in++;
  }
  return metrics;
}

function preliminaryRank(entity, metric, thresholds, entryNames) {
  const conventional = conventionalName(entity, entryNames),
    noSymbolCallers = metric.symbol_callers === 0 && metric.out_degree > 0;
  return (
    (conventional ? 70 : 0) +
    (metric.module_callers > 0 ? 35 : 0) +
    (noSymbolCallers ? 20 : 0) +
    (compactSymbolIsExported(entity) ? 8 : 0) +
    Math.min(metric.in_degree, 20) * 3 +
    Math.min(metric.out_degree, 20) * 2 +
    Math.min(metric.reference_in, 10) * 2 +
    Math.min(metric.cross_cluster_in + metric.cross_cluster_out, 10) * 4 +
    (metric.in_degree >= thresholds.in_degree && thresholds.in_degree > 1 ? 12 : 0) +
    (metric.out_degree >= thresholds.out_degree && thresholds.out_degree > 1 ? 12 : 0) -
    (compactSymbolIsTest(entity) ? 45 : 0)
  );
}

function entryRank(entity, metric, entryNames, includeTests) {
  if ((!includeTests && compactSymbolIsTest(entity)) || metric.out_degree === 0) return -1;
  const conventional = conventionalName(entity, entryNames),
    structural = metric.module_callers > 0 || metric.symbol_callers === 0;
  if (!conventional && !structural) return -1;
  return (
    (conventional ? 100 : 0) +
    (metric.module_callers > 0 ? 50 : 0) +
    (metric.symbol_callers === 0 ? 25 : 0) +
    Math.min(metric.out_degree, 20)
  );
}

function candidateSignals(entity, metric, context) {
  const signals = [],
    fact = `entity:${context.entityIndex}`;
  const add = (name, value, description, extra = []) => {
    if (signals.length < context.maxSignals)
      signals.push({ name, value, description, fact_refs: [fact, ...extra] });
  };
  if (context.entrySeeds.has(context.entityIndex))
    add('entry_seed', true, '结构入口种子', ['metric:bfs_depth']);
  if (conventionalName(entity, context.entryNames))
    add('conventional_entry_name', symbolName(entity), '名称符合常见入口信号');
  if (metric.module_callers > 0) add('module_invoked', metric.module_callers, '被模块级代码调用');
  if (metric.symbol_callers === 0 && metric.out_degree > 0)
    add('no_symbol_callers', true, '没有已解析的符号调用者');
  if (metric.in_degree >= context.thresholds.in_degree && context.thresholds.in_degree > 1)
    add('high_fan_in', metric.in_degree, '项目内入度较高', ['metric:in_degree']);
  if (metric.out_degree >= context.thresholds.out_degree && context.thresholds.out_degree > 1)
    add('high_fan_out', metric.out_degree, '项目内出度较高', ['metric:out_degree']);
  if (metric.cross_cluster_in + metric.cross_cluster_out > 0)
    add('cross_cluster', metric.cross_cluster_in + metric.cross_cluster_out, '连接不同目录簇');
  if (metric.reference_in > 0)
    add('referenced_as_value', metric.reference_in, '作为值被引用，可能参与回调或注册');
  if (context.index.cyclic[context.entityIndex])
    add(
      'cycle_member',
      context.index.componentSizes[context.index.componentByEntity[context.entityIndex]],
      '位于调用环中',
    );
  if (!signals.length) add('cluster_representative', true, '该目录簇中的结构代表');
  return signals;
}

function candidateFrom(entityIndex, context) {
  const entity = context.index.graph.entities[entityIndex],
    fileIndex = compactEntityFileIndex(entity),
    metric = context.metrics[entityIndex];
  const candidate = {
    id: `c${entityIndex.toString(36)}`,
    entity_id: compactEntityId(entity),
    entity_index: entityIndex,
    name: symbolName(entity),
    kind: symbolKind(entity),
    file: context.index.graph.files[fileIndex][0],
    range: { start_line: entity[5], end_line: entity[6] },
    cluster_id: context.clusterByEntity[entityIndex].id,
    rank_score: context.ranks[entityIndex],
    metrics: {
      ...metric,
      bfs_depth: context.depth[entityIndex] === -1 ? null : context.depth[entityIndex],
      reachable_count: context.reachability(entityIndex),
      cycle_size: context.index.cyclic[entityIndex]
        ? context.index.componentSizes[context.index.componentByEntity[entityIndex]]
        : 0,
    },
    signals: candidateSignals(entity, metric, { ...context, entityIndex }),
    warnings: [
      compactSymbolIsTest(entity) ? 'test_code' : null,
      context.index.cyclic[entityIndex] ? 'call_cycle' : null,
    ].filter(Boolean),
  };
  return candidate;
}

function candidateRelations(index, candidateByEntity, maxRelations) {
  const relations = [];
  for (const edge of index.callEdges) {
    const from = candidateByEntity.get(edge[0]),
      to = candidateByEntity.get(edge[1]);
    if (!from || !to) continue;
    relations.push({
      id: `pr_${edge[0].toString(36)}_${edge[1].toString(36)}`,
      relation: 'calls',
      from_candidate_id: from.id,
      to_candidate_id: to.id,
      fact_refs: [`relation:calls:${edge[0]}:${edge[1]}`],
      ...(edge[2]?.length ? { lines: edge[2] } : {}),
      _rank: from.rank_score + to.rank_score,
    });
  }
  relations.sort((left, right) => right._rank - left._rank || left.id.localeCompare(right.id));
  return relations.slice(0, maxRelations).map(({ _rank, ...relation }) => relation);
}

function projectSummary(graph) {
  const languages = new Set();
  for (const file of graph.files) if (file[1]) languages.add(file[1]);
  return {
    file_count: graph.stats.file_count,
    symbol_count: graph.stats.symbol_count,
    languages: [...languages].sort(),
  };
}

function refreshDerived(
  seed,
  eligibleCount,
  fullRelationCount,
  omittedClusters,
  excludedTestSymbols,
) {
  const available = new Set(seed.candidates.map((candidate) => candidate.id));
  for (const cluster of seed.clusters)
    cluster.candidate_ids = seed.candidates
      .filter((candidate) => candidate.cluster_id === cluster.id)
      .map((candidate) => candidate.id);
  seed.entry_candidate_ids = seed.entry_candidate_ids.filter((id) => available.has(id));
  seed.relations = seed.relations.filter(
    (relation) =>
      available.has(relation.from_candidate_id) && available.has(relation.to_candidate_id),
  );
  seed.truncation = {
    truncated:
      seed.candidates.length < eligibleCount ||
      seed.relations.length < fullRelationCount ||
      omittedClusters > 0,
    omitted_candidates: eligibleCount - seed.candidates.length,
    omitted_relations: fullRelationCount - seed.relations.length,
    merged_clusters: omittedClusters,
    excluded_test_symbols: excludedTestSymbols,
  };
}

function removeLowestUnprotectedCandidate(seed) {
  const clusterCounts = new Map();
  for (const candidate of seed.candidates)
    clusterCounts.set(candidate.cluster_id, (clusterCounts.get(candidate.cluster_id) ?? 0) + 1);
  const entryIds = new Set(seed.entry_candidate_ids);
  for (let index = seed.candidates.length - 1; index >= 0; index--) {
    const candidate = seed.candidates[index];
    if (!entryIds.has(candidate.id) && clusterCounts.get(candidate.cluster_id) > 1) {
      seed.candidates.splice(index, 1);
      return true;
    }
  }
  return false;
}

export function buildPlanningSeed(graph, options = {}) {
  const budget = resolveBudget(options.budget),
    entryNames = new Set(
      (options.entry_names ?? DEFAULT_ENTRY_NAMES).map((name) => String(name).toLowerCase()),
    ),
    includeTests = options.include_tests === true;
  const index = buildGraphIndex(graph),
    clusterState = buildClusters(graph, budget.max_clusters, includeTests);
  const clusterByEntity = graph.entities.map((entity) =>
    clusterState.clusterByRawKey.get(rawCluster(graph.files[compactEntityFileIndex(entity)][0])),
  );
  const metrics = computeMetrics(index, clusterByEntity);
  const allSymbolIndices = graph.entities
    .map((entity, entityIndex) => (compactEntityIsSymbol(entity) ? entityIndex : -1))
    .filter((index) => index !== -1);
  const symbolIndices = includeTests
    ? allSymbolIndices
    : allSymbolIndices.filter((entityIndex) => !compactSymbolIsTest(graph.entities[entityIndex]));
  const excludedTestSymbols = allSymbolIndices.length - symbolIndices.length;
  const thresholds = {
    in_degree: percentile(
      symbolIndices.map((entity) => metrics[entity].in_degree),
      0.95,
    ),
    out_degree: percentile(
      symbolIndices.map((entity) => metrics[entity].out_degree),
      0.95,
    ),
  };
  const ranks = new Float64Array(graph.entities.length);
  for (const entityIndex of symbolIndices)
    ranks[entityIndex] = preliminaryRank(
      graph.entities[entityIndex],
      metrics[entityIndex],
      thresholds,
      entryNames,
    );
  const orderedSymbols = [...symbolIndices].sort(
    (left, right) =>
      ranks[right] - ranks[left] ||
      compactEntityId(graph.entities[left]).localeCompare(compactEntityId(graph.entities[right])),
  );

  const entryPool = symbolIndices
    .map((entityIndex) => ({
      entityIndex,
      rank: entryRank(graph.entities[entityIndex], metrics[entityIndex], entryNames, includeTests),
    }))
    .filter((item) => item.rank >= 0)
    .sort(
      (left, right) =>
        right.rank - left.rank ||
        compactEntityId(graph.entities[left.entityIndex]).localeCompare(
          compactEntityId(graph.entities[right.entityIndex]),
        ),
    );
  const entrySeeds = new Set();
  for (const cluster of clusterState.clusters) {
    const candidate = entryPool.find((item) => clusterByEntity[item.entityIndex] === cluster);
    if (candidate && entrySeeds.size < budget.max_entry_seeds)
      entrySeeds.add(candidate.entityIndex);
  }
  for (const candidate of entryPool) {
    if (entrySeeds.size >= budget.max_entry_seeds) break;
    entrySeeds.add(candidate.entityIndex);
  }
  if (!entrySeeds.size && orderedSymbols.length) entrySeeds.add(orderedSymbols[0]);
  const depth = breadthFirstDepth(index.outgoingCalls, entrySeeds),
    reachability = createReachabilityCounter(index.outgoingCalls);

  const selected = new Set(entrySeeds);
  for (const cluster of clusterState.clusters) {
    const representative = orderedSymbols.find(
      (entityIndex) => clusterByEntity[entityIndex] === cluster,
    );
    if (representative !== undefined) selected.add(representative);
  }
  for (const entityIndex of orderedSymbols) {
    if (selected.size >= budget.max_candidates) break;
    selected.add(entityIndex);
  }
  const context = {
    index,
    metrics,
    thresholds,
    entryNames,
    entrySeeds,
    depth,
    reachability,
    ranks,
    clusterByEntity,
    maxSignals: budget.max_signals_per_candidate,
  };
  let candidates = [...selected]
    .map((entityIndex) => candidateFrom(entityIndex, context))
    .sort(
      (left, right) =>
        right.rank_score - left.rank_score || left.entity_id.localeCompare(right.entity_id),
    );
  if (candidates.length > budget.max_candidates)
    candidates = candidates.slice(0, budget.max_candidates);
  const candidateByEntity = new Map(
    candidates.map((candidate) => [candidate.entity_index, candidate]),
  );
  const allRelations = candidateRelations(index, candidateByEntity, Number.MAX_SAFE_INTEGER);
  const seed = {
    schema_version: '1',
    snapshot_id: graph.snapshot_id,
    project: projectSummary(graph),
    graph_quality: graph.quality,
    clusters: clusterState.clusters,
    candidates,
    entry_candidate_ids: [...entrySeeds]
      .map((entity) => candidateByEntity.get(entity)?.id)
      .filter(Boolean),
    relations: allRelations.slice(0, budget.max_relations),
    constraints: [
      {
        id: 'pc_resolved',
        kind: 'resolved_relations_only',
        strength: 'hard',
        description: '候选关系只包含静态分析已解析的项目内关系',
        fact_refs: ['graph:quality'],
      },
      {
        id: 'pc_verify',
        kind: 'source_verification_required',
        strength: 'hard',
        description: '最终路线节点和行为结论必须由当前快照源码核实',
        fact_refs: ['graph:quality'],
      },
      {
        id: 'pc_tests',
        kind: 'prefer_production',
        strength: 'soft',
        description: includeTests ? '本次候选池包含测试代码' : '本次候选池默认排除测试代码',
        fact_refs: ['graph:quality'],
      },
    ],
    diagnostics: [
      ...(graph.quality.ambiguous_call_count
        ? [`存在 ${graph.quality.ambiguous_call_count} 条歧义调用，确定调用图不完整`]
        : []),
      ...(graph.quality.failed_file_count
        ? [`有 ${graph.quality.failed_file_count} 个文件解析失败`]
        : []),
      ...(excludedTestSymbols ? [`默认候选池排除了 ${excludedTestSymbols} 个测试符号`] : []),
    ],
    budget,
    truncation: {},
  };
  refreshDerived(
    seed,
    orderedSymbols.length,
    allRelations.length,
    clusterState.omittedClusters,
    excludedTestSymbols,
  );
  const relationReserve = Math.min(
    seed.relations.length,
    Math.max(8, Math.floor(budget.max_relations * 0.15)),
  );
  while (bytes(seed) > budget.max_bytes && seed.relations.length > relationReserve) {
    seed.relations.pop();
    refreshDerived(
      seed,
      orderedSymbols.length,
      allRelations.length,
      clusterState.omittedClusters,
      excludedTestSymbols,
    );
  }
  while (bytes(seed) > budget.max_bytes && removeLowestUnprotectedCandidate(seed))
    refreshDerived(
      seed,
      orderedSymbols.length,
      allRelations.length,
      clusterState.omittedClusters,
      excludedTestSymbols,
    );
  while (bytes(seed) > budget.max_bytes && seed.relations.length) {
    seed.relations.pop();
    refreshDerived(
      seed,
      orderedSymbols.length,
      allRelations.length,
      clusterState.omittedClusters,
      excludedTestSymbols,
    );
  }
  if (bytes(seed) > budget.max_bytes)
    throw new Error(`PlanningSeed 最小结果仍超过 ${budget.max_bytes} bytes`);
  return seed;
}
