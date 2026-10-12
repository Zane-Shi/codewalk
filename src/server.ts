import http from 'node:http';
import path from 'node:path';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ProjectRepository } from './projects.ts';
import { sourceFile, anchorSelection } from './snapshot.ts';
import { runAnnotation } from './agent.ts';
import { runOverview } from './overview.ts';
import { normalizeOverview, selectOverviewForSnapshot } from './overview-model.ts';
import { createRouteApi } from './route-generation/route-api.ts';
import { ModelSettingsService } from './model-settings.ts';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { validationFailureDetails } from './validation-feedback.ts';
import { RECOVERY_LIMITS, runWithRecovery } from './recovery-controller.ts';

const webRoot = path.resolve(fileURLToPath(new URL('../web/dist/', import.meta.url)));
const webTypes = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};
const safeError = (error) =>
  String(error.message ?? error)
    .replace(/(?:sk-|Bearer\s+)[A-Za-z0-9_.-]+/g, '[redacted]')
    .slice(0, 800);
async function body(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 100000) throw new Error('请求过大');
  }
  return JSON.parse(text || '{}');
}
export async function createApp({
  dataDir,
  runner = runAnnotation,
  overviewRunner = runOverview,
  routeRunner,
  models,
  modelSettings,
} = {}) {
  dataDir = path.resolve(dataDir ?? '.codewalk');
  await mkdir(dataDir, { recursive: true });
  const projects = await ProjectRepository.open(dataDir);
  const settings =
    modelSettings ??
    new ModelSettingsService({
      createRuntime: () =>
        ModelRuntime.create({
          modelsStorePath: path.join(dataDir, 'models-store.json'),
          allowModelNetwork: true,
          modelRefreshTimeoutMs: 5000,
        }),
    });
  const availableModels = models ?? (() => settings.availableModels());
  const store = projects.composite;
  const active = new Map();
  const routeApi = createRouteApi({
    store,
    dataDir,
    active,
    models: availableModels,
    resolveWorkspace: (id) => projects.resolveWorkspace(id),
    resolveRecordStore: (kind, id) => projects.storeForRecord(kind, id),
    ...(!routeRunner ? { modelRuntime: () => settings.runtime() } : {}),
    ...(routeRunner ? { routeRunner } : {}),
  });
  const server = http.createServer(async (req, res) => {
    const host = req.headers.host ?? '';
    const origin = `http://${host}`;
    const json = (status, value) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(value));
    };
    try {
      if (
        !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) ||
        (req.headers.origin && req.headers.origin !== origin)
      )
        return json(403, { error: '仅允许本地同源访问' });
      const url = new URL(req.url, origin);
      if (await routeApi.handle(req, res, url)) return;
      if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
        const requested = decodeURIComponent(url.pathname).replace(/^\/+/, '');
        const candidate = path.resolve(webRoot, requested || 'index.html');
        if (candidate !== webRoot && !candidate.startsWith(`${webRoot}${path.sep}`))
          return json(404, { error: '页面不存在' });
        let file = candidate,
          content;
        try {
          content = await readFile(file);
        } catch {
          if (requested && path.extname(requested)) return json(404, { error: '静态资源不存在' });
          file = path.join(webRoot, 'index.html');
          content = await readFile(file);
        }
        const extension = path.extname(file);
        res.writeHead(200, {
          'Content-Type': `${webTypes[extension] ?? 'application/octet-stream'}${['.html', '.js', '.css', '.json'].includes(extension) ? '; charset=utf-8' : ''}`,
          'Content-Security-Policy':
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; worker-src 'self' blob:; img-src 'self' data:; font-src 'self' data:; frame-ancestors 'none'",
          'X-Content-Type-Options': 'nosniff',
        });
        return res.end(content);
      }
      if (req.method === 'GET' && url.pathname === '/api/models')
        return json(200, await availableModels());
      if (req.method === 'GET' && url.pathname === '/api/model-settings') {
        return json(200, await settings.describe());
      }
      if (req.method === 'GET' && url.pathname === '/api/projects')
        return json(200, projects.listProjects());
      if (req.method === 'POST' && url.pathname === '/api/projects') {
        const input = await body(req);
        if (typeof input.path !== 'string' || !path.isAbsolute(input.path))
          throw new Error('请输入本地项目的绝对路径');
        return json(201, await projects.importProject(input.path));
      }
      const projectMatch = url.pathname.match(/^\/api\/projects\/([a-f0-9-]+)$/);
      if (projectMatch && req.method === 'GET')
        return json(200, projects.getProject(projectMatch[1]));
      if (req.method === 'GET' && url.pathname === '/api/snapshots')
        return json(
          200,
          store.list('snapshot').map(({ root, ...s }) => s),
        );
      if (req.method === 'POST' && url.pathname === '/api/snapshots') {
        const input = await body(req);
        if (typeof input.path !== 'string' || !path.isAbsolute(input.path))
          throw new Error('请输入本地项目的绝对路径');
        const imported = await projects.importProject(input.path);
        return json(201, imported.snapshot);
      }
      if (req.method === 'GET' && url.pathname === '/api/file')
        return json(
          200,
          await sourceFile(
            store.get('snapshot', url.searchParams.get('snapshotId')),
            url.searchParams.get('path'),
          ),
        );
      if (req.method === 'GET' && url.pathname === '/api/annotations') {
        return json(
          200,
          store
            .list('annotation')
            .filter((a) => a.snapshotId === url.searchParams.get('snapshotId'))
            .map(({ evidence, sessionFile, ...a }) => a),
        );
      }
      if (req.method === 'POST' && url.pathname === '/api/annotations') {
        const input = await body(req);
        const snapshot = store.get('snapshot', input.snapshotId);
        const file = await sourceFile(snapshot, input.filePath);
        const anchor = anchorSelection(
          file.content,
          input.start,
          input.end,
          input.selectedText,
          16000,
        );
        if (!(await availableModels()).some((m) => m.id === input.model))
          throw new Error('请选择可用模型');
        const annotation = {
          id: randomUUID(),
          snapshotId: snapshot.id,
          filePath: input.filePath,
          anchor,
          model: input.model,
          createdAt: Date.now(),
        };
        store.put('annotation', annotation);
        return json(201, annotation);
      }
      const overviewMatch = url.pathname.match(
        /^\/api\/snapshots\/([a-f0-9-]+)\/overview(?:\/(cancel))?$/,
      );
      if (overviewMatch) {
        const snapshot = store.get('snapshot', overviewMatch[1]),
          key = `overview:${snapshot.id}`;
        const project = projects.projectForSnapshot(snapshot.id),
          projectStore = projects.storeForProject(project.id);
        if (req.method === 'GET' && !overviewMatch[2])
          return json(200, {
            overview: (() => {
              const stored = selectOverviewForSnapshot(projectStore.list('overview'), snapshot);
              return stored
                ? normalizeOverview(
                    {
                      ...stored,
                      id: snapshot.id,
                      snapshotId: snapshot.id,
                      snapshotVersion: snapshot.version,
                      version: snapshot.version,
                    },
                    snapshot,
                  )
                : null;
            })(),
            task: (() => {
              const t = store.list('task').find((t) => t.overviewSnapshotId === snapshot.id);
              if (!t) return null;
              const { checkpoint, ...publicTask } = t;
              return publicTask;
            })(),
          });
        if (req.method === 'POST' && overviewMatch[2] === 'cancel') {
          active.get(key)?.abort();
          return json(200, { cancelled: active.has(key) });
        }
        if (req.method === 'POST' && !overviewMatch[2]) {
          const input = await body(req);
          if (!(await availableModels()).some((m) => m.id === input.model))
            throw new Error('请选择可用模型');
          if (active.has(key)) return json(409, { error: '当前项目正在生成总览' });
          if (active.size >= 3) return json(429, { error: '同时最多运行三个任务' });
          const controller = new AbortController();
          active.set(key, controller);
          const task = {
            id: randomUUID(),
            overviewSnapshotId: snapshot.id,
            model: input.model,
            status: 'investigating',
            createdAt: Date.now(),
          };
          store.put('task', task);
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'X-Accel-Buffering': 'no',
          });
          res.flushHeaders();
          const emit = (type, data) => {
            if (type === 'usage') {
              store.put('task', { ...store.get('task', task.id), usageProgress: data });
              return;
            }
            if (type === 'checkpoint') {
              const current = store.get('task', task.id);
              store.put('task', {
                ...current,
                checkpoint: { ...(current.checkpoint ?? {}), ...data },
              });
              return;
            }
            if (type === 'phase')
              store.put('task', { ...store.get('task', task.id), status: data.status });
            if (!res.destroyed) res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
          };
          emit('task', { id: task.id });
          const heartbeat = setInterval(() => {
            if (!res.destroyed) res.write(': heartbeat\n\n');
          }, 15000);
          const timer = setTimeout(
            () => controller.abort(new Error('总览超过五分钟，请缩小项目范围')),
            300000,
          );
          const close = () => {
            if (!res.writableEnded) controller.abort();
          };
          res.on('close', close);
          try {
            const recoveryAttempts = [];
            const result = await runWithRecovery({
              scope: 'overview_generation',
              details: { snapshot_id: snapshot.id },
              maxAttempts: RECOVERY_LIMITS.overview_generation,
              shouldRetry: () => !controller.signal.aborted,
              action: async (recovery_context) =>
                overviewRunner({
                  snapshot,
                  model: input.model,
                  signal: controller.signal,
                  emit,
                  dataDir: projects.projectDir(project.id),
                  recovery_context,
                  ...(overviewRunner === runOverview
                    ? { modelRuntime: await settings.runtime() }
                    : {}),
                }),
              onFailure: (record, failureError) => {
                if (controller.signal.aborted) return;
                recoveryAttempts.push(record);
                store.put('task', {
                  ...store.get('task', task.id),
                  recoveryAttempts: recoveryAttempts.length,
                  recoveryHistory: structuredClone(recoveryAttempts),
                });
                emit(
                  record.attempt < RECOVERY_LIMITS.overview_generation && !controller.signal.aborted
                    ? 'stage_retry'
                    : 'recovery_exhausted',
                  {
                    scope: record.scope,
                    attempt:
                      record.attempt < RECOVERY_LIMITS.overview_generation
                        ? record.attempt + 1
                        : record.attempt,
                    strategy: record.strategy,
                    repeated: record.repeated,
                    failure_fingerprint: record.fingerprint,
                    reason: safeError(failureError),
                    issues: record.issues,
                  },
                );
              },
            });
            controller.signal.throwIfAborted();
            const overview = normalizeOverview(
              {
                ...result,
                id: snapshot.id,
                snapshotId: snapshot.id,
                snapshotVersion: snapshot.version,
                version: snapshot.version,
                model: input.model,
                createdByTaskId: task.id,
                createdAt: Date.now(),
              },
              snapshot,
            );
            projectStore.db.exec('BEGIN');
            try {
              store.put('overview', overview);
              store.put('task', {
                ...store.get('task', task.id),
                status: 'complete',
                finishedAt: Date.now(),
                stats: result.stats,
                recoveryAttempts: recoveryAttempts.length,
              });
              projectStore.db.exec('COMMIT');
            } catch (error) {
              projectStore.db.exec('ROLLBACK');
              throw error;
            }
            emit('complete', { overview });
          } catch (error) {
            const taskStatus = controller.signal.aborted ? 'cancelled' : 'failed',
              cause = controller.signal.reason ?? error,
              message = safeError(cause),
              failure = validationFailureDetails(cause);
            const recovery = cause?.recovery;
            store.put('task', {
              ...store.get('task', task.id),
              status: taskStatus,
              error: message,
              validationIssues: failure.issues,
              ...(failure.decision !== undefined ? { lastRejectedDecision: failure.decision } : {}),
              recoveryAttempts: store.get('task', task.id).recoveryAttempts ?? 0,
              failureKind: recovery?.external ? 'external' : 'generation',
              finishedAt: Date.now(),
            });
            emit('failure', { status: taskStatus, message, issues: failure.issues });
          } finally {
            clearTimeout(timer);
            clearInterval(heartbeat);
            res.off('close', close);
            active.delete(key);
            res.end();
          }
          return;
        }
      }
      const match = url.pathname.match(/^\/api\/annotations\/([a-f0-9-]+)(?:\/(chat|cancel))?$/);
      if (match) {
        const id = match[1],
          action = match[2];
        const annotation = store.get('annotation', id);
        if (req.method === 'GET' && !action) {
          const { evidence, sessionFile, ...publicAnnotation } = annotation;
          return json(200, {
            annotation: publicAnnotation,
            messages: store.history(id),
            tasks: store
              .list('task')
              .filter((t) => t.annotationId === id)
              .map(({ handoff, ...t }) => ({
                ...t,
                sources: (handoff?.evidence ?? [])
                  .filter((e) => ['read', 'selection'].includes(e.tool))
                  .map((e) => ({
                    id: e.id,
                    path: e.path,
                    offset: e.startPosition?.line ?? e.args?.offset ?? 1,
                    limit: e.args?.limit ?? 1,
                  })),
              })),
          });
        }
        if (req.method === 'DELETE' && !action) {
          if (active.has(id)) return json(409, { error: '请先停止当前回答，再删除批注' });
          const annotationStore = projects.storeForRecord('annotation', id);
          if (!annotationStore) throw new Error('批注所属项目不存在');
          annotationStore.db.exec('BEGIN');
          try {
            for (const kind of ['message', 'task'])
              for (const record of store.list(kind))
                if (record.annotationId === id) store.remove(kind, record.id);
            store.remove('annotation', id);
            annotationStore.db.exec('COMMIT');
          } catch (error) {
            annotationStore.db.exec('ROLLBACK');
            throw error;
          }
          const project = projects.projectForSnapshot(annotation.snapshotId);
          await rm(path.join(projects.projectDir(project.id), 'sessions', id), {
            recursive: true,
            force: true,
          });
          return json(200, { deleted: true });
        }
        if (req.method === 'POST' && action === 'cancel') {
          active.get(id)?.abort();
          return json(200, { cancelled: active.has(id) });
        }
        if (req.method === 'POST' && action === 'chat') {
          const input = await body(req);
          const question = input.question ?? '';
          if (typeof question !== 'string' || question.length > 8000)
            throw new Error('问题不能超过 8000 字符');
          if (active.has(id)) return json(409, { error: '当前批注正在回答' });
          if (active.size >= 3) return json(429, { error: '同时最多运行三个批注，请稍后重试' });
          const controller = new AbortController();
          active.set(id, controller);
          const task = {
            id: randomUUID(),
            annotationId: id,
            question,
            status: 'investigating',
            createdAt: Date.now(),
          };
          store.put('task', task);
          store.message(id, 'user', question || '解释这段代码', task.id);
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'X-Accel-Buffering': 'no',
          });
          res.flushHeaders();
          const emit = (type, data) => {
            if (!res.destroyed) res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
          };
          emit('task', { id: task.id });
          const heartbeat = setInterval(() => {
            if (!res.destroyed) res.write(': heartbeat\n\n');
          }, 15000);
          const timer = setTimeout(
            () => controller.abort(new Error('任务超过五分钟，请缩小问题范围后重试')),
            300000,
          );
          const close = () => {
            if (!res.writableEnded) controller.abort();
          };
          res.on('close', close);
          try {
            const project = projects.projectForSnapshot(annotation.snapshotId);
            const result = await runner({
              store,
              dataDir: projects.projectDir(project.id),
              annotation,
              snapshot: store.get('snapshot', annotation.snapshotId),
              task,
              signal: controller.signal,
              emit,
              ...(runner === runAnnotation ? { modelRuntime: await settings.runtime() } : {}),
            });
            controller.signal.throwIfAborted();
            store.put('task', {
              ...store.get('task', task.id),
              status: 'complete',
              finishedAt: Date.now(),
              stats: { investigation: result.investigation, explanation: result.explanation },
            });
            emit('complete', { answer: result.answer });
          } catch (error) {
            const status = controller.signal.aborted ? 'cancelled' : 'failed';
            const message = safeError(controller.signal.reason ?? error);
            store.put('task', {
              ...store.get('task', task.id),
              status,
              error: message,
              finishedAt: Date.now(),
            });
            emit('failure', { status, message });
          } finally {
            clearTimeout(timer);
            clearInterval(heartbeat);
            res.off('close', close);
            active.delete(id);
            res.end();
          }
          return;
        }
      }
      json(404, { error: '接口不存在' });
    } catch (error) {
      if (!res.headersSent) json(400, { error: safeError(error) });
      else res.end();
    }
  });
  return {
    server,
    store,
    projects,
    async close() {
      for (const controller of active.values()) controller.abort();
      await new Promise((resolve) => server.close(resolve));
      projects.close();
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await createApp({ dataDir: process.env.CODEWALK_DATA_DIR });
  const port = Number(process.env.PORT || 3000);
  app.server.on('error', (error) => {
    console.error(`CodeWalk 启动失败：${safeError(error)}`);
    app.projects.close();
    process.exitCode = 1;
  });
  app.server.listen(port, '127.0.0.1', () => console.log(`CodeWalk: http://127.0.0.1:${port}`));
  for (const name of ['SIGINT', 'SIGTERM'])
    process.once(name, () => {
      void app.close().then(() => process.exit(0));
    });
}
