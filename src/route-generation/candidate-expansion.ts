import {
  buildGraphIndex,
  compactEntityFileIndex,
  compactEntityId,
  compactEntityIsSymbol,
  compactSymbolIsExported,
  compactSymbolIsTest,
} from './graph-index.ts';

function candidateId(entityIndex) {
  return `c${entityIndex.toString(36)}`;
}

function rawCluster(file) {
  const slash = file.indexOf('/');
  return slash === -1 ? '(root)' : file.slice(0, slash);
}

function clusterFor(seed, file) {
  const label = rawCluster(file);
  return (
    seed.clusters.find((cluster) => cluster.label === label) ??
    seed.clusters.find((cluster) => cluster.label === '(other)')
  );
}

function metricsFor(index, entityIndex) {
  const incoming = index.incomingCalls[entityIndex],
    outgoing = index.outgoingCalls[entityIndex],
    incomingReferences = index.incomingReferences[entityIndex],
    outgoingReferences = index.outgoingReferences[entityIndex];
  return {
    in_degree: incoming.length,
    out_degree: outgoing.length,
    symbol_callers: incoming.filter((from) => compactEntityIsSymbol(index.graph.entities[from]))
      .length,
    module_callers: incoming.filter((from) => !compactEntityIsSymbol(index.graph.entities[from]))
      .length,
    reference_in: incomingReferences.length,
    reference_out: outgoingReferences.length,
    cross_cluster_in: 0,
    cross_cluster_out: 0,
    bfs_depth: null,
    reachable_count: 0,
    cycle_size: index.cyclic[entityIndex]
      ? index.componentSizes[index.componentByEntity[entityIndex]]
      : 0,
  };
}

function relationFromEdge(relation, edge, candidatesByEntity) {
  const from = candidatesByEntity.get(edge[0]),
    to = candidatesByEntity.get(edge[1]);
  if (!from || !to) return undefined;
  const prefix = relation === 'calls' ? 'pr' : `pr_${relation.replaceAll(/[^a-z0-9]+/gi, '_')}`;
  return {
    id: `${prefix}_${edge[0].toString(36)}_${edge[1].toString(36)}`,
    relation,
    from_candidate_id: from.id,
    to_candidate_id: to.id,
    fact_refs: [`relation:${relation}:${edge[0]}:${edge[1]}`],
    ...(edge[2]?.length ? { lines: [...edge[2]] } : {}),
  };
}

function boundedPaths(adjacency, start, maxHops) {
  const previous = new Int32Array(adjacency.length),
    depth = new Int16Array(adjacency.length);
  previous.fill(-2);
  depth.fill(-1);
  previous[start] = -1;
  depth[start] = 0;
  const queue = [start];
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const current = queue[cursor];
    if (depth[current] >= maxHops) continue;
    for (const next of adjacency[current]) {
      if (depth[next] !== -1) continue;
      previous[next] = current;
      depth[next] = depth[current] + 1;
      queue.push(next);
    }
  }
  return { previous, depth };
}

function forwardPath(previous, target) {
  const path = [];
  for (let current = target; current !== -1; current = previous[current]) path.push(current);
  return path.reverse();
}

function reversePath(previous, source) {
  const path = [];
  for (let current = source; current !== -1; current = previous[current]) path.push(current);
  return path;
}

function pathRelation(path, graph, candidatesByEntity) {
  const from = candidatesByEntity.get(path[0]),
    to = candidatesByEntity.get(path.at(-1));
  if (!from || !to || path.length < 3) return undefined;
  return {
    id: `pp_${path[0].toString(36)}_${path.at(-1).toString(36)}`,
    relation: 'call_path',
    from_candidate_id: from.id,
    to_candidate_id: to.id,
    fact_refs: path.slice(1).map((entity, index) => `relation:calls:${path[index]}:${entity}`),
    metadata: {
      hops: path.length - 1,
      intermediary_entity_ids: path
        .slice(1, -1)
        .map((entity) => compactEntityId(graph.entities[entity])),
    },
  };
}

export function createCandidateExpansion(
  graph,
  seed,
  { max_promoted_candidates = 36, max_path_hops = 6, max_promoted_relations = 200 } = {},
) {
  if (!graph)
    return { promoteSourceRange: () => ({ candidates: [], relations: [], truncated: false }) };
  if (graph.snapshot_id !== seed.snapshot_id)
    throw new Error('候选扩展图谱与 PlanningSeed 不属于同一快照');
  const index = buildGraphIndex(graph),
    fileIndexByPath = new Map(graph.files.map((file, fileIndex) => [file[0], fileIndex])),
    entitiesByFile = new Map();
  for (let entityIndex = 0; entityIndex < graph.entities.length; entityIndex++) {
    const entity = graph.entities[entityIndex];
    if (!compactEntityIsSymbol(entity)) continue;
    const fileIndex = compactEntityFileIndex(entity),
      values = entitiesByFile.get(fileIndex) ?? [];
    values.push(entityIndex);
    entitiesByFile.set(fileIndex, values);
  }
  let promotedCount = 0,
    promotedRelationCount = 0;
  return {
    promoteSourceRange(file, range) {
      const fileIndex = fileIndexByPath.get(file);
      if (fileIndex === undefined) return { candidates: [], relations: [], truncated: false };
      const existingByEntity = new Map(
        seed.candidates.map((candidate) => [candidate.entity_index, candidate]),
      );
      const eligible = (entitiesByFile.get(fileIndex) ?? [])
        .filter((entityIndex) => {
          const entity = graph.entities[entityIndex];
          return (
            entity[5] <= range.end_line &&
            entity[6] >= range.start_line &&
            !existingByEntity.has(entityIndex)
          );
        })
        .sort((left, right) => {
          const a = graph.entities[left],
            b = graph.entities[right];
          const aCovered = a[5] >= range.start_line && a[6] <= range.end_line,
            bCovered = b[5] >= range.start_line && b[6] <= range.end_line;
          return (
            Number(bCovered) - Number(aCovered) ||
            a[5] - b[5] ||
            a[6] - a[5] - (b[6] - b[5]) ||
            compactEntityId(a).localeCompare(compactEntityId(b))
          );
        });
      const remaining = Math.max(0, max_promoted_candidates - promotedCount),
        selected = eligible.slice(0, remaining),
        promoted = [];
      for (const entityIndex of selected) {
        const entity = graph.entities[entityIndex],
          cluster = clusterFor(seed, file);
        if (!cluster) continue;
        const candidate = {
          id: candidateId(entityIndex),
          entity_id: compactEntityId(entity),
          entity_index: entityIndex,
          name: entity[2],
          kind: entity[3],
          file,
          range: { start_line: entity[5], end_line: entity[6] },
          cluster_id: cluster.id,
          rank_score: 0,
          metrics: metricsFor(index, entityIndex),
          signals: [
            {
              name: 'source_discovered',
              value: true,
              description: 'Agent 调查源码时由完整图谱确定性晋升',
              fact_refs: [`entity:${entityIndex}`],
            },
          ],
          warnings: [
            compactSymbolIsTest(entity) ? 'test_code' : null,
            index.cyclic[entityIndex] ? 'call_cycle' : null,
            compactSymbolIsExported(entity) ? null : 'not_exported',
          ].filter(Boolean),
        };
        seed.candidates.push(candidate);
        cluster.candidate_ids.push(candidate.id);
        promoted.push(candidate);
        promotedCount++;
      }
      const candidatesByEntity = new Map(
          seed.candidates.map((candidate) => [candidate.entity_index, candidate]),
        ),
        knownRelations = new Set(seed.relations.map((relation) => relation.id)),
        knownCallPairs = new Set(
          seed.relations
            .filter(
              (relation) => relation.relation === 'calls' || relation.relation === 'call_path',
            )
            .map((relation) => `${relation.from_candidate_id}>${relation.to_candidate_id}`),
        ),
        addedRelations = [];
      for (const relationSet of graph.relation_sets.filter(
        (set) => set.relation === 'calls' || set.relation === 'references',
      ))
        for (const edge of relationSet.edges) {
          const relation = relationFromEdge(relationSet.relation, edge, candidatesByEntity);
          if (
            relation &&
            !knownRelations.has(relation.id) &&
            promoted.some(
              (candidate) =>
                candidate.entity_index === edge[0] || candidate.entity_index === edge[1],
            ) &&
            promotedRelationCount < max_promoted_relations
          ) {
            seed.relations.push(relation);
            knownRelations.add(relation.id);
            if (relation.relation === 'calls')
              knownCallPairs.add(`${relation.from_candidate_id}>${relation.to_candidate_id}`);
            addedRelations.push(relation);
            promotedRelationCount++;
          }
        }
      for (const candidate of promoted) {
        const forward = boundedPaths(index.outgoingCalls, candidate.entity_index, max_path_hops),
          backward = boundedPaths(index.incomingCalls, candidate.entity_index, max_path_hops);
        for (const other of seed.candidates) {
          if (promotedRelationCount >= max_promoted_relations) break;
          const paths = [
            forward.depth[other.entity_index] >= 2
              ? forwardPath(forward.previous, other.entity_index)
              : undefined,
            backward.depth[other.entity_index] >= 2
              ? reversePath(backward.previous, other.entity_index)
              : undefined,
          ];
          for (const path of paths) {
            if (!path) continue;
            const relation = pathRelation(path, graph, candidatesByEntity),
              pair = relation && `${relation.from_candidate_id}>${relation.to_candidate_id}`;
            if (!relation || knownCallPairs.has(pair)) continue;
            seed.relations.push(relation);
            knownRelations.add(relation.id);
            knownCallPairs.add(pair);
            addedRelations.push(relation);
            promotedRelationCount++;
            if (promotedRelationCount >= max_promoted_relations) break;
          }
        }
      }
      return {
        candidates: promoted,
        relations: addedRelations,
        truncated: eligible.length > selected.length,
      };
    },
  };
}
