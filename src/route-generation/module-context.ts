import { createCandidateExpansion } from './candidate-expansion.ts';

export function mentionedModuleSymbolNames(module) {
  const words =
    `${module.title} ${module.objective} ${module.reason}`.match(/[_$A-Za-z][_$A-Za-z0-9]*/g) ?? [];
  return new Set(
    words.filter(
      (word) => word.length >= 5 && (word.startsWith('_') || /[A-Z]/.test(word.slice(1))),
    ),
  );
}

export function promoteMentionedModuleSymbols(seed, graph, module, { max_symbols = 12 } = {}) {
  if (!graph) return [];
  const names = mentionedModuleSymbolNames(module);
  const existing = new Set(seed.candidates.map((candidate) => candidate.entity_index)),
    matches = [];
  for (
    let entityIndex = 0;
    entityIndex < graph.entities.length && matches.length < max_symbols;
    entityIndex++
  ) {
    const entity = graph.entities[entityIndex];
    if (entity[0] !== 'symbol' || existing.has(entityIndex) || !names.has(entity[2])) continue;
    matches.push({
      entityIndex,
      file: graph.files[entity[4]]?.[0],
      range: { start_line: entity[5], end_line: entity[6] },
    });
  }
  const expansion = createCandidateExpansion(graph, seed, { max_promoted_candidates: max_symbols });
  const promoted = [];
  for (const match of matches) {
    if (!match.file) continue;
    promoted.push(...expansion.promoteSourceRange(match.file, match.range).candidates);
  }
  return promoted;
}

export function buildModulePlanningSeed(seed, module, { max_candidates = 24 } = {}) {
  const candidateById = new Map(seed.candidates.map((candidate) => [candidate.id, candidate])),
    selected = new Set(module.candidate_ids.filter((id) => candidateById.has(id)));
  const neighbouring = [];
  for (const relation of seed.relations) {
    if (selected.has(relation.from_candidate_id) && candidateById.has(relation.to_candidate_id))
      neighbouring.push(relation.to_candidate_id);
    if (selected.has(relation.to_candidate_id) && candidateById.has(relation.from_candidate_id))
      neighbouring.push(relation.from_candidate_id);
  }
  for (const candidateId of neighbouring) {
    if (selected.size >= max_candidates) break;
    selected.add(candidateId);
  }
  const candidates = seed.candidates
      .filter((candidate) => selected.has(candidate.id))
      .slice(0, max_candidates),
    candidateIds = new Set(candidates.map((candidate) => candidate.id));
  const clusters = seed.clusters
    .map((cluster) => ({
      ...structuredClone(cluster),
      candidate_ids: cluster.candidate_ids.filter((id) => candidateIds.has(id)),
    }))
    .filter((cluster) => cluster.candidate_ids.length);
  return {
    ...structuredClone(seed),
    clusters,
    candidates,
    entry_candidate_ids: seed.entry_candidate_ids.filter((id) => candidateIds.has(id)),
    relations: seed.relations.filter(
      (relation) =>
        candidateIds.has(relation.from_candidate_id) && candidateIds.has(relation.to_candidate_id),
    ),
    diagnostics: [
      ...seed.diagnostics,
      `当前上下文仅暴露语义模块 ${module.id} 的 ${candidates.length} 个初始候选；read 可晋升其他真实图谱符号`,
    ],
  };
}

export function mergePlanningSeed(target, source) {
  const candidates = new Set(target.candidates.map((candidate) => candidate.id));
  for (const candidate of source.candidates)
    if (!candidates.has(candidate.id)) {
      target.candidates.push(structuredClone(candidate));
      candidates.add(candidate.id);
    }
  const relations = new Set(target.relations.map((relation) => relation.id));
  for (const relation of source.relations)
    if (!relations.has(relation.id)) {
      target.relations.push(structuredClone(relation));
      relations.add(relation.id);
    }
  for (const cluster of target.clusters)
    cluster.candidate_ids = target.candidates
      .filter((candidate) => candidate.cluster_id === cluster.id)
      .map((candidate) => candidate.id);
  return target;
}

export function compactModuleResults(modulePlan, moduleDecisions, seed, evidence) {
  const candidateById = new Map(seed.candidates.map((candidate) => [candidate.id, candidate])),
    evidenceById = new Map(evidence.map((item) => [item.id, item]));
  return modulePlan.modules.map((module, index) => {
    const decision = moduleDecisions[index],
      blocks = decision.blocks.map((block) => {
        const candidate = candidateById.get(block.candidate_id);
        return { ...block, symbol_id: candidate.entity_id, file: candidate.file };
      });
    const previous = index ? moduleDecisions[index - 1].blocks.at(-1) : undefined,
      current = blocks[0];
    const boundary_relations =
      previous && current
        ? seed.relations.filter(
            (relation) =>
              relation.from_candidate_id === previous.candidate_id &&
              relation.to_candidate_id === current.candidate_id,
          )
        : [];
    const refs = new Set(blocks.flatMap((block) => block.evidence_refs));
    if (previous) for (const ref of previous.evidence_refs) refs.add(ref);
    const evidence_catalog = [...refs]
      .map((id) => evidenceById.get(id))
      .filter(Boolean)
      .map((item) => ({
        id: item.id,
        candidate_ids: item.candidate_ids,
        intersecting_candidate_ids: item.intersecting_candidate_ids,
        file: item.file,
        range: item.range,
      }));
    return {
      module: {
        id: module.id,
        title: module.title,
        objective: module.objective,
        transition_from_previous: module.transition_from_previous,
      },
      blocks,
      omitted_symbols: decision.omitted_symbols ?? [],
      unresolved_questions: decision.unresolved_questions ?? [],
      boundary_relations,
      evidence_catalog,
    };
  });
}
