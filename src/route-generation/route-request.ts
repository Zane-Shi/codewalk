export const DEFAULT_MAIN_ROUTE_INTENT =
  '帮助代码基础较弱的用户理解这个项目最具代表性的核心流程：它从哪里开始，经过哪些关键模块，最终产生什么结果。优先阅读生产代码和主干逻辑，暂时忽略旁支、测试及底层细节。';

function requiredText(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} 必须是非空字符串`);
  return value.trim();
}

export function createRouteGenerationRequest({
  request_id,
  snapshot_id,
  goal,
  source,
  origin,
  metadata,
}) {
  return {
    schema_version: '1',
    request_id: requiredText(request_id, 'request_id'),
    snapshot_id: requiredText(snapshot_id, 'snapshot_id'),
    goal: { original: requiredText(goal, 'goal'), source: requiredText(source, 'source') },
    ...(origin ? { origin: structuredClone(origin) } : {}),
    ...(metadata ? { metadata: structuredClone(metadata) } : {}),
  };
}
