import { randomUUID } from 'node:crypto';
import {
  listPublishedRouteSummaries,
  loadPublishedRoute,
  setPublishedRouteArchived,
} from './delivery-publisher.ts';
import { runRouteGenerationService } from './route-generation-service.ts';
import { createRouteGenerationRequest, DEFAULT_MAIN_ROUTE_INTENT } from './route-request.ts';
import { dedupeRouteSummaries } from '../projects.ts';

const publicEvents = new Set([
  'task',
  'phase',
  'checkpoint',
  'stage_reused',
  'stage_retry',
  'recovery_escalated',
  'recovery_exhausted',
  'module',
  'review',
  'route_issue',
  'partial',
  'complete',
  'failure',
]);
const safeError = (error) =>
  String(error?.message ?? error)
    .replace(/(?:sk-|Bearer\s+)[A-Za-z0-9_.-]+/g, '[redacted]')
    .slice(0, 800);

async function requestBody(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 100000) throw new Error('请求过大');
  }
  return JSON.parse(text || '{}');
}

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

function findRecord(store, kind, id) {
  return store.list(kind).find((record) => record.id === id);
}

function publicTask(task) {
  if (!task) return null;
  const { checkpoint, request, ...visible } = task;
  return visible;
}

function modelAvailable(available, id) {
  return available.some((model) => model.id === id || `${model.provider}/${model.id}` === id);
}

function decode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error('接口 ID 编码无效');
  }
}

/** HTTP adapter for route generation in either a project or a legacy snapshot workspace. */
export function createRouteApi({
  store,
  dataDir,
  active = new Map(),
  models = async () => [],
  routeRunner = runRouteGenerationService,
  maxActive = 3,
  timeoutMs = 30 * 60 * 1000,
  resolveWorkspace,
  resolveRecordStore,
  modelRuntime,
}) {
  async function streamGeneration(req, res, workspaceId) {
    const context = resolveWorkspace
      ? resolveWorkspace(workspaceId)
      : { store, snapshot: findRecord(store, 'snapshot', workspaceId) };
    const routeStore = context.store,
      effectiveWorkspaceId = context.project?.id ?? workspaceId;
    const snapshot = context.snapshot;
    if (!snapshot) throw new Error('工作区对应的源码快照不存在');
    const input = await requestBody(req);
    const requestedGoal = input.goal ?? '';
    if (typeof requestedGoal !== 'string' || requestedGoal.length > 2000)
      throw new Error('阅读目标不能超过 2000 字符');
    if (typeof input.model !== 'string' || !modelAvailable(await models(), input.model))
      throw new Error('请选择可用模型');

    const resumeTask = input.resumeTaskId
      ? findRecord(routeStore, 'task', input.resumeTaskId)
      : undefined;
    if (
      input.resumeTaskId &&
      (!resumeTask ||
        resumeTask.kind !== 'route-generation' ||
        resumeTask.workspaceId !== effectiveWorkspaceId ||
        !['failed', 'cancelled'].includes(resumeTask.status) ||
        !['autonomous-route-generation', 'semantic-route-generation'].includes(
          resumeTask.checkpoint?.kind,
        ) ||
        !resumeTask.request)
    ) {
      throw new Error('只能恢复当前工作区中失败或取消且带 checkpoint 的路线任务');
    }
    const taskId = resumeTask?.id ?? randomUUID();
    const routeId = resumeTask?.ownerId ?? randomUUID();
    const request =
      resumeTask?.request ??
      createRouteGenerationRequest({
        request_id: taskId,
        snapshot_id: snapshot.id,
        goal: requestedGoal.trim() || DEFAULT_MAIN_ROUTE_INTENT,
        source: requestedGoal.trim() ? 'user_request' : 'default_main',
      });
    const activeKey = `route:${taskId}`;
    if (active.has(activeKey)) return json(res, 409, { error: '当前路线任务正在运行' });
    if (active.size >= maxActive)
      return json(res, 429, { error: '同时运行的任务过多，请稍后重试' });

    const controller = new AbortController();
    active.set(activeKey, controller);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    const send = (type, data) => {
      if (publicEvents.has(type) && !res.destroyed)
        res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
    };
    send('task', {
      id: taskId,
      route_id: routeId,
      workspace_id: effectiveWorkspaceId,
      resumed: Boolean(resumeTask),
    });
    const heartbeat = setInterval(() => {
      if (!res.destroyed) res.write(': heartbeat\n\n');
    }, 15000);
    const timer = setTimeout(
      () => controller.abort(new Error('路线生成超过三十分钟，请缩小项目范围')),
      timeoutMs,
    );
    const close = () => {
      if (!res.writableEnded) controller.abort(new Error('客户端已断开'));
    };
    res.on('close', close);
    let terminalSent = false;
    try {
      await routeRunner({
        store: routeStore,
        workspace_id: effectiveWorkspaceId,
        snapshot,
        request,
        model: input.model,
        dataDir: context.dataDir ?? dataDir,
        ...(modelRuntime ? { modelRuntime: await modelRuntime() } : {}),
        task_id: taskId,
        route_id: routeId,
        signal: controller.signal,
        emit(type, data) {
          if (['complete', 'partial', 'failure', 'route_issue'].includes(type)) terminalSent = true;
          send(type, data);
        },
      });
      if (!terminalSent) {
        send('failure', {
          task_id: taskId,
          status: 'failed',
          message: '路线任务没有返回最终结果，请从任务检查点继续',
        });
      }
    } catch (error) {
      if (!terminalSent)
        send('failure', {
          task_id: taskId,
          status: controller.signal.aborted ? 'cancelled' : 'failed',
          message: safeError(controller.signal.reason ?? error),
        });
    } finally {
      clearTimeout(timer);
      clearInterval(heartbeat);
      res.off('close', close);
      active.delete(activeKey);
      res.end();
    }
  }

  return {
    active,
    async handle(req, res, url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)) {
      const workspaceRoutes = url.pathname.match(
        /^\/api\/(?:workspaces|projects)\/([^/]+)\/routes$/,
      );
      if (workspaceRoutes) {
        const workspaceId = decode(workspaceRoutes[1]);
        const context = resolveWorkspace
          ? resolveWorkspace(workspaceId)
          : { store, snapshot: findRecord(store, 'snapshot', workspaceId) };
        const routeStore = context.store;
        if (req.method === 'GET') {
          if (!context.snapshot) throw new Error('工作区对应的源码快照不存在');
          const effectiveWorkspaceId = context.project?.id ?? workspaceId;
          const routes = context.aggregateProjectRoutes
            ? dedupeRouteSummaries(routeStore.list('route').map((route) => route.summary))
            : listPublishedRouteSummaries(routeStore, workspaceId);
          const tasks = routeStore
            .list('task')
            .filter(
              (task) =>
                task.kind === 'route-generation' && task.workspaceId === effectiveWorkspaceId,
            )
            .map(publicTask);
          json(res, 200, { workspace_id: effectiveWorkspaceId, routes, tasks });
          return true;
        }
        if (req.method === 'POST') {
          await streamGeneration(req, res, workspaceId);
          return true;
        }
        return false;
      }

      const routeBlock = url.pathname.match(/^\/api\/routes\/([^/]+)\/blocks\/([^/]+)$/);
      if (routeBlock && req.method === 'GET') {
        const routeId = decode(routeBlock[1]),
          blockId = decode(routeBlock[2]);
        const routeStore = resolveRecordStore?.('route', routeId) ?? store;
        const delivery = loadPublishedRoute(routeStore, routeId);
        const content = delivery.block_contents.find((item) => item.block_id === blockId);
        if (!content) throw new Error('路线中不存在这个代码块');
        json(res, 200, content);
        return true;
      }

      const routeAction = url.pathname.match(/^\/api\/routes\/([^/]+)\/(archive|restore)$/);
      if (routeAction && req.method === 'POST') {
        const routeId = decode(routeAction[1]),
          routeStore = resolveRecordStore?.('route', routeId) ?? store;
        const summary = setPublishedRouteArchived({
          store: routeStore,
          route_id: routeId,
          archived: routeAction[2] === 'archive',
        });
        json(res, 200, { route: summary });
        return true;
      }

      const route = url.pathname.match(/^\/api\/routes\/([^/]+)$/);
      if (route && req.method === 'GET') {
        const routeId = decode(route[1]),
          routeStore = resolveRecordStore?.('route', routeId) ?? store;
        json(res, 200, loadPublishedRoute(routeStore, routeId).route);
        return true;
      }

      const task = url.pathname.match(/^\/api\/route-tasks\/([^/]+)(?:\/(cancel))?$/);
      if (task) {
        const taskId = decode(task[1]),
          action = task[2];
        if (req.method === 'GET' && !action) {
          const taskStore = resolveRecordStore?.('task', taskId) ?? store;
          const stored = findRecord(taskStore, 'task', taskId);
          if (!stored || stored.kind !== 'route-generation') throw new Error('路线任务不存在');
          json(res, 200, publicTask(stored));
          return true;
        }
        if (req.method === 'POST' && action === 'cancel') {
          const controller = active.get(`route:${taskId}`);
          controller?.abort(new Error('用户取消路线生成'));
          json(res, 200, { cancelled: Boolean(controller) });
          return true;
        }
        return false;
      }
      return false;
    },
  };
}
