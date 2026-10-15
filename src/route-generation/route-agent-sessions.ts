import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';

const KIND = 'route_agent_session';
const MAX_RESUMPTIONS = 2;
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const cleanError = (error) =>
  String(error?.message ?? error)
    .replace(/(?:sk-|Bearer\s+)[A-Za-z0-9_.-]+/g, '[redacted]')
    .slice(0, 800);

export class RouteSessionInterruptedError extends Error {
  constructor(cause) {
    super(`Agent 会话已保存，可继续当前阶段：${cleanError(cause)}`, { cause });
    this.code = 'ROUTE_SESSION_INTERRUPTED';
  }
}

export class RouteSessionRestartRequired extends Error {
  constructor(reason) {
    super(`无法安全继续旧会话，将回退到业务 Checkpoint：${reason}`);
    this.code = 'ROUTE_SESSION_RESTART_REQUIRED';
  }
}

export function isTransientSessionError(error) {
  if (error?.code === 'SEMANTIC_AGENT_NO_SUBMISSION' || error?.name === 'ValidationFailure')
    return false;
  return /ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|fetch failed|network|socket|connection|timeout|timed out|\b429\b|\b50[234]\b|rate.?limit|overloaded|temporarily unavailable|operation was aborted/i.test(
    String(error?.message ?? error),
  );
}

// Never execute old tool calls on reopening. A process can die after a tool's
// database write but before its result is logged. Business records take priority.
export function repairInterruptedToolResults(manager) {
  const messages = manager.buildSessionContext().messages;
  const results = new Set(messages.filter((m) => m.role === 'toolResult').map((m) => m.toolCallId));
  const missing = messages
    .filter((m) => m.role === 'assistant')
    .flatMap((m) => m.content ?? [])
    .filter((item) => item.type === 'toolCall' && !results.has(item.id));
  for (const call of missing)
    manager.appendMessage({
      role: 'toolResult',
      toolCallId: call.id,
      toolName: call.name,
      isError: true,
      timestamp: Date.now(),
      content: [
        {
          type: 'text',
          text: '上次执行被外部中断，结果未完整落盘；工具可能已经执行，不能假定写入失败。请先核对已保存业务产物，不要盲目重放提交。只读调查可以按需重新进行。',
        },
      ],
    });
  return missing.length;
}

let implementation;
async function implementationDigest() {
  // Changing executable tool implementations, Pi, or stage prompts invalidates
  // an old execution context; saved business artifacts remain usable.
  implementation ??= Promise.all(
    [
      './semantic-route-agent.ts',
      './source-tools.ts',
      './source-units.ts',
      './semantic-route-drafts.ts',
      './semantic-route-review.ts',
      './source-read.ts',
      '../snapshot.ts',
      '../overview-model.ts',
      '../dekko-mcp.ts',
      '../../node_modules/@earendil-works/pi-coding-agent/package.json',
      './route-agent-sessions.ts',
    ].map((file) => readFile(new URL(file, import.meta.url), 'utf8')),
  ).then(hash);
  return implementation;
}

export async function prepareRouteAgentSession({
  store,
  snapshot,
  dataDir,
  model,
  modelSettings,
  attempt,
  binding,
  stageName,
  prompt,
  tools,
  enabledTools,
  counters,
}) {
  if (!attempt?.id) throw new Error('持久化 Agent 会话缺少阶段 attempt ID');
  const directory = path.resolve(dataDir, 'sessions', 'route-generation', hash(attempt.id));
  await mkdir(directory, { recursive: true });
  const identity = hash({
    protocol: 1,
    attempt: attempt.id,
    binding,
    model,
    modelSettings,
    snapshot: { id: snapshot.id, version: snapshot.version, root: path.resolve(snapshot.root) },
    prompt,
    implementation: await implementationDigest(),
    enabledTools,
    tools: tools.map((tool) => ({ name: tool.name, parameters: tool.parameters })),
  });
  let record = store.list(KIND).find((item) => item.id === attempt.id);
  let manager,
    resumed = false;
  const save = (changes) => {
    record = { ...record, ...changes, counters: { ...counters }, updated_at: Date.now() };
    store.put(KIND, record);
  };
  if (record) {
    try {
      if (record.identity !== identity)
        throw new Error('源码版本、阶段输入、模型、提示词或工具版本已变化');
      if (!['running', 'interrupted'].includes(record.status))
        throw new Error('旧会话已完成或存在语义失败');
      if (!Number.isSafeInteger(record.resumptions) || record.resumptions < 0)
        throw new Error('会话继续次数记录无效');
      if (record.resumptions >= MAX_RESUMPTIONS) throw new Error('当前会话的继续次数已达上限');
      const root = await realpath(directory),
        file = await realpath(record.session_file);
      const relative = path.relative(root, file);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
        throw new Error('会话文件超出阶段目录');
      manager = SessionManager.open(file, directory, snapshot.root);
      if (
        manager.getSessionId() !== record.session_id ||
        !manager.buildSessionContext().messages.length
      )
        throw new Error('会话文件不完整或身份不匹配');
      for (const field of ['calls', 'reads']) {
        const value = record.counters?.[field];
        if (!Number.isSafeInteger(value) || value < 0) throw new Error('调查预算记录无效');
        counters[field] = value;
      }
      repairInterruptedToolResults(manager);
      resumed = true;
      save({ status: 'running', resumptions: record.resumptions + 1 });
    } catch (error) {
      save({ status: 'unusable', error: cleanError(error) });
      throw new RouteSessionRestartRequired(cleanError(error));
    }
  } else {
    manager = SessionManager.create(snapshot.root, directory);
    record = {
      schema_version: '1',
      id: attempt.id,
      stage: attempt.kind,
      stage_name: stageName,
      task_id: attempt.task_id,
      target: attempt.target,
      identity,
      snapshot_id: snapshot.id,
      model,
      session_id: manager.getSessionId(),
      session_file: manager.getSessionFile(),
      resumptions: 0,
      created_at: Date.now(),
    };
    // Persist the reference before the first model request, not in finally only.
    save({ status: 'running' });
  }
  let detach = () => {};
  return {
    manager,
    resumed,
    track(session) {
      detach = session.subscribe((event) => {
        if (['tool_execution_start', 'tool_execution_end', 'turn_end'].includes(event.type))
          save({});
      });
    },
    progress() {
      save({});
    },
    finish({ completed, error, signal }) {
      detach();
      const interrupted = !completed && (signal?.aborted || isTransientSessionError(error));
      save({
        status: completed ? 'completed' : interrupted ? 'interrupted' : 'failed',
        ...(error ? { error: cleanError(error) } : {}),
      });
      return interrupted && !signal?.aborted ? new RouteSessionInterruptedError(error) : error;
    },
  };
}
