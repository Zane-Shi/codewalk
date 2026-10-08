function relationEdges(graph, relation) {
  return graph.relation_sets.filter((set) => set.relation === relation).flatMap((set) => set.edges);
}

export function compactEntityId(entity) {
  return entity[1];
}

export function compactEntityFileIndex(entity) {
  return entity[0] === 'module' ? entity[2] : entity[4];
}

export function compactEntityIsSymbol(entity) {
  return entity[0] === 'symbol';
}

export function compactSymbolIsExported(entity) {
  return entity[0] === 'symbol' && Boolean(entity[7] & 1);
}

export function compactSymbolIsTest(entity) {
  return entity[0] === 'symbol' && Boolean(entity[7] & 2);
}

function adjacency(size, edges) {
  const outgoing = Array.from({ length: size }, () => []),
    incoming = Array.from({ length: size }, () => []);
  for (const edge of edges) {
    const from = edge[0],
      to = edge[1];
    if (
      !Number.isInteger(from) ||
      !Number.isInteger(to) ||
      from < 0 ||
      to < 0 ||
      from >= size ||
      to >= size
    ) {
      throw new Error(`紧凑图包含悬空关系：${from} -> ${to}`);
    }
    outgoing[from].push(to);
    incoming[to].push(from);
  }
  for (const list of [...outgoing, ...incoming]) list.sort((left, right) => left - right);
  return { outgoing, incoming };
}

function stronglyConnectedComponents(outgoing, incoming) {
  const size = outgoing.length,
    visited = new Uint8Array(size),
    order = [];
  for (let start = 0; start < size; start++) {
    if (visited[start]) continue;
    visited[start] = 1;
    const stack = [[start, 0]];
    while (stack.length) {
      const frame = stack[stack.length - 1],
        neighbours = outgoing[frame[0]];
      if (frame[1] < neighbours.length) {
        const next = neighbours[frame[1]++];
        if (!visited[next]) {
          visited[next] = 1;
          stack.push([next, 0]);
        }
      } else {
        order.push(frame[0]);
        stack.pop();
      }
    }
  }
  const componentByEntity = new Int32Array(size);
  componentByEntity.fill(-1);
  const componentSizes = [];
  for (let position = order.length - 1; position >= 0; position--) {
    const start = order[position];
    if (componentByEntity[start] !== -1) continue;
    const component = componentSizes.length,
      stack = [start];
    componentByEntity[start] = component;
    let count = 0;
    while (stack.length) {
      const current = stack.pop();
      count++;
      for (const next of incoming[current]) {
        if (componentByEntity[next] === -1) {
          componentByEntity[next] = component;
          stack.push(next);
        }
      }
    }
    componentSizes.push(count);
  }
  const cyclic = new Uint8Array(size);
  for (let entity = 0; entity < size; entity++) {
    if (componentSizes[componentByEntity[entity]] > 1 || outgoing[entity].includes(entity))
      cyclic[entity] = 1;
  }
  return { componentByEntity, componentSizes, cyclic };
}

export function breadthFirstDepth(outgoing, seeds) {
  const depth = new Int32Array(outgoing.length);
  depth.fill(-1);
  const queue = [];
  for (const seed of [...new Set(seeds)].sort((left, right) => left - right)) {
    if (!Number.isInteger(seed) || seed < 0 || seed >= outgoing.length || depth[seed] !== -1)
      continue;
    depth[seed] = 0;
    queue.push(seed);
  }
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const current = queue[cursor];
    for (const next of outgoing[current]) {
      if (depth[next] !== -1) continue;
      depth[next] = depth[current] + 1;
      queue.push(next);
    }
  }
  return depth;
}

export function createReachabilityCounter(outgoing) {
  const marks = new Uint32Array(outgoing.length);
  let generation = 0;
  return (start) => {
    generation++;
    if (generation === 0xffffffff) {
      marks.fill(0);
      generation = 1;
    }
    const queue = [start];
    marks[start] = generation;
    let count = 0;
    for (let cursor = 0; cursor < queue.length; cursor++) {
      for (const next of outgoing[queue[cursor]]) {
        if (marks[next] === generation) continue;
        marks[next] = generation;
        queue.push(next);
        count++;
      }
    }
    return count;
  };
}

export function buildGraphIndex(graph) {
  if (
    !graph ||
    !Array.isArray(graph.entities) ||
    !Array.isArray(graph.files) ||
    !Array.isArray(graph.relation_sets)
  )
    throw new Error('无效的 CompactCodeGraph');
  const entityById = new Map();
  for (let index = 0; index < graph.entities.length; index++) {
    const id = compactEntityId(graph.entities[index]);
    if (entityById.has(id)) throw new Error(`紧凑图包含重复实体：${id}`);
    entityById.set(id, index);
  }
  const callEdges = relationEdges(graph, 'calls'),
    referenceEdges = relationEdges(graph, 'references');
  const calls = adjacency(graph.entities.length, callEdges),
    references = adjacency(graph.entities.length, referenceEdges);
  const components = stronglyConnectedComponents(calls.outgoing, calls.incoming);
  return {
    graph,
    entityById,
    callEdges,
    referenceEdges,
    outgoingCalls: calls.outgoing,
    incomingCalls: calls.incoming,
    outgoingReferences: references.outgoing,
    incomingReferences: references.incoming,
    ...components,
  };
}
