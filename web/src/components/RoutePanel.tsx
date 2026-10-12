import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, consumeSse } from '../api';
import type {
  RouteBlock,
  RouteCatalogue,
  RouteDelivery,
  RouteGenerationTask,
  Snapshot,
  SourceLocation,
} from '../types';

const phaseLabels: Record<string, string> = {
  planning: '正在选择具体阅读场景',
  researching: '正在追踪各模块的实现',
  reviewing: '正在核验主线是否闭合',
  explaining: '正在生成逐块带读讲解',
  publishing: '正在保存阅读路线',
  complete: '路线已经准备好',
};

function latestTask(tasks: RouteGenerationTask[], statuses: RouteGenerationTask['status'][]) {
  return [...tasks]
    .filter((task) => statuses.includes(task.status))
    .sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0))[0];
}

function ValidationIssues({ task }: { task: RouteGenerationTask }) {
  if (!task.validationIssues?.length) return null;
  return (
    <ul className="route-validation-issues" aria-label="路线校验失败详情">
      {task.validationIssues.map((item, index) => (
        <li key={`${item.code}-${index}`}>
          <strong>{item.code}</strong>
          {item.location?.field ? ` · ${item.location.field}` : ''}：{item.message}
        </li>
      ))}
    </ul>
  );
}

function InlineCode({ text }: { text: string }) {
  return (
    <>
      {text
        .split(/(`[^`]+`)/g)
        .filter(Boolean)
        .map((part, index) =>
          part.startsWith('`') ? <code key={index}>{part.slice(1, -1)}</code> : part,
        )}
    </>
  );
}

export function blockLocation(block: RouteBlock): SourceLocation {
  const location = block.source.location;
  return {
    filePath: location.file,
    startLine: location.start.line,
    endLine: location.end.line,
    origin: 'route',
    originId: block.id,
    title: block.title,
    reason: block.narrative.why_read,
  };
}

export function RoutePanel({
  projectId,
  snapshot,
  model,
  catalogue,
  route,
  activeBlockId,
  onSelectRoute,
  onOpenBlock,
  onStatus,
}: {
  projectId: string;
  snapshot: Snapshot;
  model?: string;
  catalogue?: RouteCatalogue;
  route?: RouteDelivery;
  activeBlockId?: string;
  onSelectRoute: (routeId: string) => void;
  onOpenBlock: (moduleId: string, block: RouteBlock) => void;
  onStatus: (value: string) => void;
}) {
  const client = useQueryClient();
  const [goal, setGoal] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [streamTaskId, setStreamTaskId] = useState<string>();
  const [openModules, setOpenModules] = useState<Set<string>>(new Set());
  const controller = useRef<AbortController | undefined>(undefined);
  const routes =
    catalogue?.routes.filter((item) => item.status !== 'archived' || item.id === route?.id) ?? [];
  const running = latestTask(catalogue?.tasks ?? [], ['investigating', 'explaining', 'finalizing']);
  const resumable = latestTask(catalogue?.tasks ?? [], ['failed', 'cancelled']);
  const issue = latestTask(catalogue?.tasks ?? [], ['route_issue']);
  const currentTaskId = streamTaskId ?? running?.id;

  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    if (!route) return;
    const activeModule = route.modules.find((module) =>
      module.blocks.some((block) => block.id === activeBlockId),
    );
    const initialModule = activeModule ?? route.modules[0];
    setOpenModules(new Set(initialModule ? [initialModule.id] : []));
  }, [route?.id, route?.revision_id]);
  useEffect(() => {
    const activeModule = route?.modules.find((module) =>
      module.blocks.some((block) => block.id === activeBlockId),
    );
    if (activeModule)
      setOpenModules((current) =>
        current.has(activeModule.id) ? current : new Set([...current, activeModule.id]),
      );
  }, [route, activeBlockId]);

  const generate = async (resumeTaskId?: string) => {
    if (!model) return onStatus('请选择可用模型');
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setProgress(resumeTaskId ? '正在从已保存的检查点继续' : '正在启动路线规划');
    let failure = '';
    let completedRouteId = '';
    let partial = false;
    try {
      await consumeSse(
        `/api/projects/${encodeURIComponent(projectId)}/routes`,
        {
          model,
          goal: goal.trim(),
          ...(resumeTaskId ? { resumeTaskId } : {}),
        },
        abort.signal,
        (event) => {
          if (event.type === 'task') setStreamTaskId(String(event.data.id));
          if (event.type === 'phase')
            setProgress(phaseLabels[String(event.data.phase)] ?? '正在整理阅读路线');
          if (event.type === 'module') setProgress('正在核实模块内的函数调用顺序');
          if (event.type === 'review') setProgress('正在检查入口、关键实现与结果是否连通');
          if (event.type === 'stage_reused') setProgress('已复用通过校验的阶段结果');
          if (event.type === 'stage_retry')
            setProgress(
              event.data.strategy === 'rebuild_scope'
                ? '检测到相同错误，正在重新调查当前范围'
                : '当前阶段未能完成，正在用新上下文局部修复',
            );
          if (event.type === 'recovery_escalated')
            setProgress('局部恢复未成功，正在重新规划整条路线');
          if (event.type === 'recovery_exhausted')
            setProgress('自动恢复已用尽，正在保存完整失败原因');
          if (event.type === 'route_issue') failure = '讲解阶段发现路线证据不足，需要重新规划';
          if (event.type === 'failure')
            failure = String(event.data.error ?? event.data.message ?? '路线生成失败');
          if (event.type === 'complete') completedRouteId = String(event.data.route_id ?? '');
          if (event.type === 'partial') {
            completedRouteId = String(event.data.route_id ?? '');
            partial = true;
          }
        },
      );
    } catch (error) {
      if (!abort.signal.aborted) failure = error instanceof Error ? error.message : String(error);
    } finally {
      controller.current = undefined;
      setBusy(false);
      setStreamTaskId(undefined);
      await client.invalidateQueries({ queryKey: ['routes', projectId] });
      if (completedRouteId) {
        onSelectRoute(completedRouteId);
        onStatus(
          partial ? '已保存可阅读的部分路线，请留意页面中的审核说明' : '阅读路线和逐块讲解已保存',
        );
      } else if (failure) onStatus(failure);
    }
  };

  const cancel = async () => {
    if (!currentTaskId) return;
    try {
      await api(`/api/route-tasks/${encodeURIComponent(currentTaskId)}/cancel`, {
        method: 'POST',
        body: '{}',
      });
      setProgress('正在停止，已完成的阶段会保留');
    } catch (error) {
      onStatus(error instanceof Error ? error.message : String(error));
    }
  };

  if (!routes.length && !route)
    return (
      <section className="route-panel route-empty">
        <div className="route-empty-copy">
          <small>两层阅读路线</small>
          <h2>从真实场景进入源码</h2>
          <p>留空时，Agent 会根据项目内容选择一条具体主线。也可以告诉它你最想理解的流程。</p>
        </div>
        <textarea
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
          placeholder="可选：例如，用户提交一个请求后，系统如何返回结果？"
          maxLength={2000}
        />
        <button disabled={busy || Boolean(running)} onClick={() => void generate()}>
          {busy || running ? '正在生成路线' : '生成主线'}
        </button>
        {(busy || running) && (
          <div className="route-task">
            <span className="task-pulse" />{' '}
            <span>{progress || phaseLabels[running?.phase ?? ''] || '正在恢复任务状态'}</span>
            <button className="text-button" onClick={() => void cancel()}>
              停止
            </button>
          </div>
        )}
        {resumable && !busy && !running && (
          <div className="route-recovery">
            <p>
              上次任务在“{phaseLabels[resumable.phase ?? ''] ?? '路线生成'}
              ”阶段中断，已完成部分仍在。
            </p>
            {resumable.error && <p className="route-error">{resumable.error}</p>}
            <ValidationIssues task={resumable} />
            <button className="quiet" onClick={() => void generate(resumable.id)}>
              从检查点继续
            </button>
          </div>
        )}
        {issue && <p className="route-error">{issue.error || '现有路线证据不足，尚未发布。'}</p>}
      </section>
    );

  return (
    <section className="route-panel">
      <div className="route-picker">
        <label htmlFor="route-select">阅读路线</label>
        <select
          id="route-select"
          value={route?.id ?? ''}
          onChange={(event) => onSelectRoute(event.target.value)}
        >
          {routes.map((item) => (
            <option key={item.id} value={item.id}>
              {item.title}
            </option>
          ))}
        </select>
      </div>
      {route && (
        <>
          <header className="route-heading">
            {route.status === 'partial' && route.quality && (
              <div className="route-error" role="status">
                <strong>这是一份可阅读的部分结果：</strong> {route.quality.summary}
                {route.quality.issues.length > 0 && (
                  <ul className="route-validation-issues">
                    {route.quality.issues.map((item, index) => (
                      <li key={item.id ?? `${item.category}-${index}`}>
                        {item.problem}
                        {item.required_change ? `；建议：${item.required_change}` : ''}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            <span>
              本次跟读 · {route.modules.length} 个阶段 ·{' '}
              {route.modules.reduce((sum, module) => sum + module.blocks.length, 0)} 处关键代码
            </span>
            <h2>{route.goal.title}</h2>
            <p className="route-scenario">
              <InlineCode text={route.goal.scenario} />
            </p>
            <div className="route-outcome">
              <strong>最后会看到</strong>
              <span>{route.goal.observable_result}</span>
            </div>
          </header>
          <ol className="route-modules">
            {route.modules.map((module) => (
              <li key={module.id} className="route-module">
                <details
                  open={openModules.has(module.id)}
                  onToggle={(event) => {
                    const isOpen = event.currentTarget.open;
                    setOpenModules((current) => {
                      if (current.has(module.id) === isOpen) return current;
                      const next = new Set(current);
                      if (isOpen) next.add(module.id);
                      else next.delete(module.id);
                      return next;
                    });
                  }}
                >
                  <summary>
                    <span className="module-order">{module.order}</span>
                    <span>
                      <strong>{module.title}</strong>
                    </span>
                    <span className="module-count">{module.blocks.length} 段</span>
                  </summary>
                  <ol className="route-blocks">
                    {module.blocks.map((block) => (
                      <li key={block.id}>
                        <button
                          className={block.id === activeBlockId ? 'active' : ''}
                          aria-current={block.id === activeBlockId ? 'step' : undefined}
                          onClick={() => onOpenBlock(module.id, block)}
                        >
                          <span className="block-order">{block.route_order}</span>
                          <span>
                            <strong>{block.title}</strong>
                            <small>
                              {block.source.name} · {block.source.location.file}:L
                              {block.source.location.start.line}
                            </small>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ol>
                </details>
              </li>
            ))}
          </ol>
        </>
      )}
      <div className="route-actions">
        {busy || running ? (
          <>
            <span>{progress || phaseLabels[running?.phase ?? '']}</span>
            <button className="quiet" onClick={() => void cancel()}>
              停止
            </button>
          </>
        ) : (
          <button className="text-button" onClick={() => void generate()}>
            重新生成一条路线
          </button>
        )}
        {resumable && !busy && !running && (
          <>
            <p className="route-error">
              {resumable.error || '上次路线生成没有完成，已完成阶段仍然保留。'}
            </p>
            <ValidationIssues task={resumable} />
            <button className="text-button" onClick={() => void generate(resumable.id)}>
              继续上次任务
            </button>
          </>
        )}
      </div>
    </section>
  );
}
