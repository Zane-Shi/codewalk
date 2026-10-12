import { fileURLToPath } from 'node:url';
import { DefaultResourceLoader } from '@earendil-works/pi-coding-agent';

export const DEKKO_ROUTE_TOOL_NAMES = Object.freeze([
  'search_code',
  'outline',
  'query_symbol',
  'get_callers',
  'get_callees',
  'get_context_pack',
]);

export const ROUTE_SOURCE_TOOL_NAMES = Object.freeze(['read', 'ls', 'grep', 'find']);
export const ROUTE_INVESTIGATION_TOOL_NAMES = Object.freeze([
  ...DEKKO_ROUTE_TOOL_NAMES,
  ...ROUTE_SOURCE_TOOL_NAMES,
]);

const extensionPath = fileURLToPath(new URL('./extensions/dekko-mcp.ts', import.meta.url));

export async function createDekkoResourceLoader({ cwd, agentDir, settingsManager, prompt }) {
  // pi-mcp-adapter uses Pi's agent-dir environment variable for its metadata cache.
  // Keep that cache beside CodeWalk's own Pi configuration instead of ~/.pi/agent.
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    additionalExtensionPaths: [extensionPath],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => prompt,
  });
  await loader.reload();
  const errors = loader.getExtensions().errors;
  if (errors.length) {
    throw new Error(`Dekko MCP 扩展加载失败：${errors.map((item) => item.error).join('；')}`);
  }
  return loader;
}

export async function disposeRoutePlanningSession(session) {
  try {
    // Pi's SDK dispose() invalidates extensions but does not emit session_shutdown.
    // reload() emits it first, allowing the MCP adapter to close its child process.
    await session.reload();
  } catch {
    // Cleanup must not replace the route-planning result or its original error.
  } finally {
    session.dispose();
  }
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const abort = () =>
      done(signal.reason instanceof Error ? signal.reason : new Error('路线规划已取消'));
    function done(error) {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      error ? reject(error) : resolve();
    }
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

export async function activateRoutePlanningTools(
  session,
  workflowToolNames,
  { signal, timeoutMs = 30000, investigationToolNames = ROUTE_INVESTIGATION_TOOL_NAMES } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let missing = [...DEKKO_ROUTE_TOOL_NAMES];
  let registered = [];
  while (Date.now() < deadline) {
    registered = session.getAllTools().map((tool) => tool.name);
    const available = new Set(registered);
    missing = DEKKO_ROUTE_TOOL_NAMES.filter((name) => !available.has(name));
    if (!missing.length) {
      const active = [...investigationToolNames, ...workflowToolNames];
      session.setActiveToolsByName(active);
      return active;
    }
    await delay(25, signal);
  }
  throw new Error(
    `Dekko MCP 未在 ${timeoutMs}ms 内就绪，缺少工具：${missing.join(', ')}；当前已注册：${registered.join(', ') || '(none)'}。请确认 dekko 已安装且可通过 PATH 执行。`,
  );
}
