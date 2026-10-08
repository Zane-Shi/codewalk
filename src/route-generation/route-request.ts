export const DEFAULT_MAIN_ROUTE_INTENT =
  '帮助代码基础较弱的用户理解这个项目最具代表性的核心流程：它从哪里开始，经过哪些关键模块，最终产生什么结果。优先阅读生产代码和主干逻辑，暂时忽略旁支、测试及底层细节。';

export const DEFAULT_ROUTE_PLANNING_LIMITS = Object.freeze({
  min_modules: 3,
  max_modules: 8,
  max_blocks: 32,
  max_blocks_per_module: 8,
  max_submission_attempts: 6,
  max_revision_rounds: 2,
  max_source_lines_per_read: 240,
  max_locked_plan_bytes: 96 * 1024,
  main_agent: { max_tool_calls: 48, max_source_reads: 20, max_source_bytes: 128 * 1024 },
  module_agent: { max_tool_calls: 26, max_source_reads: 12, max_source_bytes: 80 * 1024 },
  global: { max_tool_calls: 224, max_source_reads: 112, max_source_bytes: 896 * 1024 },
});

function requiredText(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} 必须是非空字符串`);
  return value.trim();
}

function limits(overrides = {}) {
  const result = {
    ...DEFAULT_ROUTE_PLANNING_LIMITS,
    ...overrides,
    main_agent: { ...DEFAULT_ROUTE_PLANNING_LIMITS.main_agent, ...overrides.main_agent },
    module_agent: { ...DEFAULT_ROUTE_PLANNING_LIMITS.module_agent, ...overrides.module_agent },
    global: { ...DEFAULT_ROUTE_PLANNING_LIMITS.global, ...overrides.global },
  };
  for (const key of [
    'min_modules',
    'max_modules',
    'max_blocks',
    'max_blocks_per_module',
    'max_submission_attempts',
    'max_revision_rounds',
    'max_source_lines_per_read',
    'max_locked_plan_bytes',
  ]) {
    if (!Number.isInteger(result[key]) || result[key] < 1) throw new Error(`${key} 必须是正整数`);
  }
  for (const name of ['main_agent', 'module_agent', 'global'])
    for (const key of ['max_tool_calls', 'max_source_reads', 'max_source_bytes']) {
      if (!Number.isInteger(result[name][key]) || result[name][key] < 1)
        throw new Error(`${name}.${key} 必须是正整数`);
    }
  if (result.min_modules > result.max_modules) throw new Error('min_modules 不能大于 max_modules');
  if (result.max_blocks < result.max_modules) throw new Error('max_blocks 不能小于 max_modules');
  return result;
}

export function createRouteGenerationRequest({
  request_id,
  snapshot_id,
  goal,
  source,
  limits: limitOverrides,
  constraints,
  origin,
  metadata,
}) {
  return {
    schema_version: '1',
    request_id: requiredText(request_id, 'request_id'),
    snapshot_id: requiredText(snapshot_id, 'snapshot_id'),
    goal: { original: requiredText(goal, 'goal'), source: requiredText(source, 'source') },
    limits: limits(limitOverrides),
    ...(constraints ? { constraints: structuredClone(constraints) } : {}),
    ...(origin ? { origin: structuredClone(origin) } : {}),
    ...(metadata ? { metadata: structuredClone(metadata) } : {}),
  };
}

export function createDefaultMainRouteRequest({
  request_id,
  snapshot_id,
  planning_seed,
  limits: limitOverrides,
  origin,
  metadata,
}) {
  if (planning_seed?.snapshot_id !== snapshot_id)
    throw new Error('PlanningSeed 与默认主线路线请求不属于同一快照');
  return createRouteGenerationRequest({
    request_id,
    snapshot_id,
    goal: DEFAULT_MAIN_ROUTE_INTENT,
    source: 'default_main',
    limits: limitOverrides,
    origin,
    metadata,
    constraints: {
      start_candidate_ids: [...planning_seed.entry_candidate_ids],
      require_source_evidence: true,
      allow_test_candidates: false,
    },
  });
}

export function createUserRouteRequest({
  request_id,
  snapshot_id,
  question,
  limits: limitOverrides,
  constraints,
  origin,
  metadata,
}) {
  return createRouteGenerationRequest({
    request_id,
    snapshot_id,
    goal: question,
    source: 'user_request',
    limits: limitOverrides,
    constraints: { require_source_evidence: true, allow_test_candidates: false, ...constraints },
    origin,
    metadata,
  });
}
