import { readFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import {
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createReadToolDefinition,
  createGrepToolDefinition,
  createFindToolDefinition,
  createLsToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { relativeSourcePath, safePath } from './snapshot.ts';
import { createGetProjectOverviewTool } from './overview-model.ts';

const string = { type: 'string', minLength: 1, maxLength: 8000 };
const strings = { type: 'array', items: string, maxItems: 30 };
const handoffSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['evidenceIds', 'focus', 'findings', 'uncertainties'],
  properties: {
    evidenceIds: { ...strings, minItems: 1 },
    focus: strings,
    findings: strings,
    uncertainties: strings,
  },
};

export function resourceLoader(prompt) {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => prompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources() {},
    async reload() {},
  };
}

export function makeTools(
  snapshot,
  evidence,
  onProgress,
  onHandoff,
  signal,
  limits = {},
  context = {},
) {
  const maxCalls = limits.calls ?? 24,
    maxChars = limits.readChars ?? 100000;
  let calls = 0,
    totalChars = 0,
    submitted = false;
  // Reuse Pi's find schema/rendering/truncation with its supported operations adapter.
  // The immutable manifest avoids fd installation and re-scanning excluded files.
  const manifestFind = (cwd) =>
    createFindToolDefinition(cwd, {
      operations: {
        exists: async (p) => {
          try {
            await access(p);
            return true;
          } catch {
            return false;
          }
        },
        glob: async (pattern, searchRoot, { limit }) =>
          snapshot.files
            .map((file) => relativeSourcePath(searchRoot, path.join(snapshot.root, file)))
            .filter((file) => file !== '..' && !file.startsWith('../') && !path.isAbsolute(file))
            .filter((file) =>
              path.posix.matchesGlob(
                pattern.includes('/') ? file : path.posix.basename(file),
                pattern,
              ),
            )
            .slice(0, limit),
      },
    });
  const native = [
    createReadToolDefinition,
    createGrepToolDefinition,
    manifestFind,
    createLsToolDefinition,
  ];
  const tools = native.map((factory) => {
    const tool = factory(snapshot.root);
    return {
      ...tool,
      async execute(id, args, toolSignal, update, ctx) {
        signal.throwIfAborted();
        if (submitted) throw new Error('本轮上下文已提交，请结束调查');
        if (++calls > maxCalls)
          throw new Error(`已达到本轮 ${maxCalls} 次调查上限，请基于已有证据完成任务并注明缺口`);
        const target = await safePath(snapshot.root, args.path ?? '.');
        const relative = relativeSourcePath(snapshot.root, target);
        onProgress({ tool: tool.name, path: relative || '.' });
        const limit = args.limit ?? (tool.name === 'read' ? 160 : 60);
        if (!Number.isInteger(limit) || limit < 1 || limit > 400)
          throw new Error('limit 必须在 1–400 之间');
        if (
          tool.name === 'read' &&
          args.offset !== undefined &&
          (!Number.isInteger(args.offset) || args.offset < 1)
        )
          throw new Error('offset 必须是正整数');
        if (
          tool.name === 'grep' &&
          args.context !== undefined &&
          (!Number.isInteger(args.context) || args.context < 0 || args.context > 10)
        )
          throw new Error('context 必须在 0–10 之间');
        const cacheKey = JSON.stringify([tool.name, relative, { ...args, path: undefined, limit }]);
        const cached = evidence.find((item) => item.cacheKey === cacheKey);
        if (cached)
          return {
            content: [{ type: 'text', text: `复用证据 ${cached.id}\n${cached.text}` }],
            details: cached.details,
          };
        if (totalChars >= maxChars) throw new Error('本轮读取预算已用尽，请提交已有证据');
        const result = await tool.execute(
          id,
          { ...args, path: target, limit },
          toolSignal,
          update,
          ctx,
        );
        const text = result.content
          .filter((item) => item.type === 'text')
          .map((item) => item.text)
          .join('\n');
        if (!text) throw new Error('此工具仅用于文本源码');
        totalChars += text.length;
        const evidenceId = `e${evidence.length + 1}`;
        evidence.push({
          id: evidenceId,
          tool: tool.name,
          path: relative,
          args: { ...args, limit },
          text,
          details: result.details,
          snapshotId: snapshot.id,
          cacheKey,
        });
        return {
          ...result,
          content: [
            { type: 'text', text: `证据 ${evidenceId}；源码版本 ${snapshot.version}\n${text}` },
          ],
        };
      },
    };
  });
  if (context.loadOverview)
    tools.push(
      createGetProjectOverviewTool({
        snapshot,
        loadOverview: context.loadOverview,
        onRead(overview) {
          const existing = evidence.find((item) => item.tool === 'overview');
          if (existing) return existing.id;
          const item = {
            id: `e${evidence.length + 1}`,
            tool: 'overview',
            snapshotId: snapshot.id,
            text: JSON.stringify(overview),
          };
          evidence.push(item);
          return item.id;
        },
      }),
    );
  tools.push({
    name: 'prepare_explanation',
    label: '提交解释上下文',
    description: '选择已读取证据，提交解释重点、结论和不确定事项；提交成功后结束调查。',
    parameters: handoffSchema,
    executionMode: 'sequential',
    async execute(_id, args) {
      signal.throwIfAborted();
      if (submitted) throw new Error('本轮已提交，不要重复提交');
      const selected = [...new Set(args.evidenceIds)].map((id) => {
        const item = evidence.find((e) => e.id === id);
        if (!item) throw new Error(`证据 ${id} 不存在，请使用工具返回的 ID`);
        return item;
      });
      if (selected.reduce((sum, e) => sum + e.text.length, 0) > 65000)
        throw new Error('解释上下文过长，请选择更相关的证据');
      const handoff = { ...args, evidence: selected };
      onHandoff(handoff);
      submitted = true;
      return { content: [{ type: 'text', text: '解释上下文已保存，请结束调查。' }] };
    },
  });
  return tools;
}

let runtimePromise;
async function runtime() {
  return (runtimePromise ??= ModelRuntime.create());
}
export async function availableModels() {
  return (await (await runtime()).getAvailable()).map((m) => ({
    id: `${m.provider}/${m.id}`,
    name: m.name,
  }));
}
function assistantText(session) {
  const message = session.messages.findLast((m) => m.role === 'assistant');
  if (!message || ['error', 'aborted'].includes(message.stopReason))
    throw new Error('模型未正常完成回答，请检查模型连接后重试');
  return message.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}
function usageSince(stats, before) {
  return {
    tokens: Object.fromEntries(
      Object.entries(stats.tokens).map(([key, value]) => [key, value - (before?.tokens[key] ?? 0)]),
    ),
    toolCalls: stats.toolCalls - (before?.toolCalls ?? 0),
    estimatedCost: stats.cost - (before?.cost ?? 0),
  };
}

export async function runAnnotation({
  store,
  dataDir,
  annotation,
  snapshot,
  task,
  signal,
  emit,
  modelRuntime: injectedRuntime,
}) {
  const modelRuntime = injectedRuntime ?? (await runtime());
  const models = await modelRuntime.getAvailable();
  const model = models.find((m) => `${m.provider}/${m.id}` === annotation.model);
  if (!model) throw new Error('所选模型不可用，请检查本地 Pi 模型配置');
  const prompts = await Promise.all(
    ['investigator', 'explainer'].map((name) =>
      readFile(new URL(`./prompts/${name}.md`, import.meta.url), 'utf8'),
    ),
  );
  const evidence = annotation.evidence ?? [
    {
      id: 'selection',
      tool: 'selection',
      path: annotation.filePath,
      text: annotation.anchor.text,
      snapshotId: snapshot.id,
      startPosition: annotation.anchor.startPosition,
      endPosition: annotation.anchor.endPosition,
    },
  ];
  let handoff;
  const sessionsDir = path.join(dataDir, 'sessions', annotation.id);
  await mkdir(sessionsDir, { recursive: true });
  const tools = makeTools(
    snapshot,
    evidence,
    (progress) => emit('progress', progress),
    (value) => {
      handoff = value;
      store.put('task', { ...store.get('task', task.id), handoff: value });
    },
    signal,
    {},
    {
      loadOverview: (snapshotId) =>
        store.list('overview').find((item) => (item.snapshotId ?? item.id) === snapshotId),
    },
  );
  const manager = annotation.sessionFile
    ? SessionManager.open(annotation.sessionFile)
    : SessionManager.create(snapshot.root, sessionsDir);
  const common = {
    cwd: snapshot.root,
    agentDir: path.join(dataDir, 'pi-config'),
    model,
    modelRuntime,
    thinkingLevel: 'off',
    settingsManager: SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 1 } }),
  };
  const { session } = await createAgentSession({
    ...common,
    resourceLoader: resourceLoader(prompts[0]),
    sessionManager: manager,
    customTools: tools,
    tools: tools.map((t) => t.name),
  });
  const initialStats = session.getSessionStats();
  let explaining;
  let turns = 0;
  const offBudget = session.subscribe((event) => {
    if (event.type === 'turn_start' && ++turns > 30) void session.abort().catch(() => {});
  });
  const cancel = () => {
    void session.abort().catch(() => {});
    if (explaining) void explaining.abort().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    signal.throwIfAborted();
    const taskInput = {
      snapshotId: snapshot.id,
      filePath: annotation.filePath,
      selection: annotation.anchor,
      question: task.question,
      evidenceAvailable: evidence.map((e) => ({ id: e.id, path: e.path, tool: e.tool })),
    };
    await session.prompt(JSON.stringify(taskInput), { expandPromptTemplates: false });
    signal.throwIfAborted();
    store.put('annotation', {
      ...store.get('annotation', annotation.id),
      sessionFile: session.sessionFile,
      evidence,
    });
    if (!handoff) throw new Error('调查未提交解释上下文，请重新发送问题');
    emit('phase', { status: 'explaining' });
    store.put('task', { ...store.get('task', task.id), status: 'explaining' });
    const created = await createAgentSession({
      ...common,
      resourceLoader: resourceLoader(prompts[1]),
      tools: [],
      sessionManager: SessionManager.inMemory(snapshot.root),
    });
    explaining = created.session;
    const off = explaining.subscribe((event) => {
      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta')
        emit('delta', { text: event.assistantMessageEvent.delta });
    });
    let answer;
    try {
      signal.throwIfAborted();
      const history = store
        .history(annotation.id)
        .filter((m) => m.taskId !== task.id)
        .slice(-12)
        .map((m) => ({ role: m.role, text: m.text }));
      await explaining.prompt(JSON.stringify({ task: taskInput, history, handoff }), {
        expandPromptTemplates: false,
      });
      signal.throwIfAborted();
      answer = assistantText(explaining);
      if (!answer.trim()) throw new Error('解释为空，请重试');
    } finally {
      off();
    }
    store.message(annotation.id, 'assistant', answer, task.id);
    await session.sendCustomMessage(
      {
        customType: 'delivered_explanation',
        content: answer,
        display: false,
        details: { taskId: task.id },
      },
      { triggerTurn: false },
    );
    return {
      answer,
      investigation: usageSince(session.getSessionStats(), initialStats),
      explanation: usageSince(explaining.getSessionStats()),
    };
  } finally {
    signal.removeEventListener('abort', cancel);
    offBudget();
    store.put('annotation', {
      ...store.get('annotation', annotation.id),
      sessionFile: session.sessionFile,
      evidence,
    });
    explaining?.dispose();
    session.dispose();
  }
}
