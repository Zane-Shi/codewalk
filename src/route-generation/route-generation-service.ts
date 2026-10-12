import { ensureDekkoMap } from '../dekko-map.ts';
import { loadDekkoPlanningInput } from './input.ts';
import { runSemanticRouteGenerationService } from './semantic-route-generation-service.ts';

function assertSourceGraph(graph, snapshot) {
  if (!graph || !Array.isArray(graph.files) || !Array.isArray(graph.entities))
    throw new Error('CODE_GRAPH_INVALID: Dekko 代码图缺少文件或符号索引');
  if (graph.snapshot_id && graph.snapshot_id !== snapshot.id)
    throw new Error('CODE_GRAPH_SNAPSHOT_MISMATCH: Dekko 代码图不属于当前源码快照');
  return graph;
}

export async function prepareRouteSourceGraph({
  snapshot,
  signal,
  ensureMap = ensureDekkoMap,
  loadInput = loadDekkoPlanningInput,
}) {
  try {
    signal?.throwIfAborted();
    const codeMap = await ensureMap({ root: snapshot.root, signal });
    const input = await loadInput({ map_path: codeMap.path, snapshot });
    return {
      graph: assertSourceGraph(input.graph, snapshot),
      code_map: input.code_map,
    };
  } catch (error) {
    signal?.throwIfAborted();
    if (String(error?.message ?? error).startsWith('CODE_GRAPH_')) throw error;
    throw new Error(`CODE_GRAPH_UNAVAILABLE: 无法为当前源码快照准备 Dekko 代码图：${error.message}`, {
      cause: error,
    });
  }
}

/** The public route entry. All route requests use the semantic workflow. */
export async function runRouteGenerationService({
  sourceGraph,
  signal = new AbortController().signal,
  prepareSourceGraph = prepareRouteSourceGraph,
  semanticWorkflows = {},
  ...args
}) {
  if (!sourceGraph)
    ({ graph: sourceGraph } = await prepareSourceGraph({ snapshot: args.snapshot, signal }));
  else assertSourceGraph(sourceGraph, args.snapshot);

  return runSemanticRouteGenerationService({
    ...args,
    sourceGraph,
    signal,
    ...semanticWorkflows,
  });
}
