import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, consumeSse } from '../api';
import type { Overview as OverviewData, OverviewNode, Snapshot, StreamEvent, Task } from '../types';

type DisplayNode = OverviewNode & { children: DisplayNode[] };

function savedStatus(data: OverviewData | null, task?: Task | null) {
  if (task?.status === 'failed') return `上次总览生成失败：${task.error ?? '未提供错误原因'}`;
  if (task?.status === 'cancelled') return '上次总览生成已取消。';
  if (data) return data.partial ? '已加载部分总览，请留意覆盖说明。' : '已加载保存的总览。';
  return '尚未生成总览。';
}

function OverviewTree({
  nodes,
  onOpen,
}: {
  nodes: OverviewNode[];
  onOpen: (path: string) => void;
}) {
  const map = new Map<string, DisplayNode>(
    nodes.map((node) => [node.path, { ...node, children: [] }]),
  );
  for (const node of [...map.values()]) {
    let parent = node.path.split('/').slice(0, -1).join('/');
    while (parent) {
      if (!map.has(parent))
        map.set(parent, {
          path: parent,
          kind: 'directory',
          description: '',
          confidence: 'uncertain',
          children: [],
        });
      parent = parent.split('/').slice(0, -1).join('/');
    }
  }
  const roots: DisplayNode[] = [];
  for (const node of map.values())
    (map.get(node.path.split('/').slice(0, -1).join('/'))?.children ?? roots).push(node);
  const branch = (items: DisplayNode[], depth = 0): React.ReactNode => (
    <ul className="overview-tree">
      {items
        .sort((a, b) => a.kind.localeCompare(b.kind) || a.path.localeCompare(b.path))
        .map((node) => (
          <li key={node.path}>
            {node.kind === 'directory' ? (
              <details open={depth < 2}>
                <summary className="overview-node">
                  <strong>{node.path.split('/').at(-1)}/</strong>
                  <span>{node.description}</span>
                  {node.description && node.confidence !== 'confirmed' && <small>待核实</small>}
                </summary>
                {node.children.length > 0 && branch(node.children, depth + 1)}
              </details>
            ) : (
              <div className="overview-node">
                <button onClick={() => onOpen(node.path)}>{node.path.split('/').at(-1)}</button>
                <span>{node.description}</span>
                {node.confidence !== 'confirmed' && <small>待核实</small>}
              </div>
            )}
          </li>
        ))}
    </ul>
  );
  return branch(roots);
}

export function Overview({
  snapshot,
  model,
  data,
  task,
  onOpen,
}: {
  snapshot: Snapshot;
  model?: string;
  data: OverviewData | null;
  task?: Task | null;
  onOpen: (path: string) => void;
}) {
  const client = useQueryClient(),
    [busy, setBusy] = useState(false),
    [status, setStatus] = useState(savedStatus(data, task));
  const [controller, setController] = useState<AbortController>();
  useEffect(() => {
    if (!busy) setStatus(savedStatus(data, task));
  }, [snapshot.id, data, task, busy]);
  const generate = async () => {
    if (!model) return setStatus('请选择可用模型');
    const abort = new AbortController();
    setController(abort);
    setBusy(true);
    setStatus('正在建立项目认知；成功前保留旧结果。');
    let failure = '';
    try {
      await consumeSse(
        `/api/snapshots/${snapshot.id}/overview`,
        { model },
        abort.signal,
        (event: StreamEvent) => {
          if (event.type === 'progress')
            setStatus(`正在 ${String(event.data.tool)}：${String(event.data.path)}`);
          if (event.type === 'phase') setStatus(String(event.data.message));
          if (event.type === 'stage_retry')
            setStatus(
              event.data.strategy === 'rebuild_scope'
                ? '检测到相同错误，正在重新调查并生成总览。'
                : '本次结果未通过校验，正在用新的 Agent 上下文重做总览。',
            );
          if (event.type === 'recovery_exhausted')
            setStatus('自动恢复已用尽，正在保存完整失败原因。');
          if (event.type === 'failure') failure = String(event.data.message);
        },
      );
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      setBusy(false);
      setController(undefined);
      await client.invalidateQueries({ queryKey: ['overview', snapshot.id] });
      setStatus(failure || '总览已保存。');
    }
  };
  const cancel = async () => {
    await api(`/api/snapshots/${snapshot.id}/overview/cancel`, { method: 'POST', body: '{}' });
    controller?.abort();
  };
  const capabilities = data?.project?.capabilities ?? data?.capabilities ?? [];
  const areas = data?.areas ?? [],
    areaNames = new Map(areas.map((area) => [area.id, area.title]));
  const relationLabels = { calls: '调用', imports: '依赖', supports: '支持' } as const;
  return (
    <main className="overview-page">
      <div className="overview-heading">
        <div>
          <small>认识项目 · 从整体开始</small>
          <h1>{snapshot.name} · 项目总览</h1>
        </div>
        <div>
          <button disabled={busy} onClick={generate}>
            {data ? '重新生成总览' : '生成项目总览'}
          </button>
          {busy && (
            <button className="quiet" onClick={cancel}>
              停止生成
            </button>
          )}
        </div>
      </div>
      <p className="overview-status" role="status">
        {status}
      </p>
      {task?.status === 'failed' && (
        <section className="overview-card limitations" aria-label="总览生成失败详情">
          <h2>上次生成未通过校验</h2>
          <p>{task.error ?? '未提供错误原因'}</p>
          {(task.recoveryAttempts ?? 0) > 0 && (
            <p>系统已自动恢复 {task.recoveryAttempts} 次，且保留了原有总览。</p>
          )}
          {task.validationIssues && task.validationIssues.length > 0 && (
            <ul>
              {task.validationIssues.map((item, index) => (
                <li key={`${item.code}-${index}`}>
                  <strong>{item.code}</strong>
                  {item.location?.field ? ` · ${item.location.field}` : ''}：{item.message}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {!data ? (
        <p className="overview-empty">用简短的用途说明和带解释的目录地图，认识这个项目。</p>
      ) : (
        <>
          <section className="overview-card">
            <h2>这个项目做什么</h2>
            <p>{data.purpose}</p>
            {capabilities.length > 0 && (
              <ul className="overview-capabilities">
                {capabilities.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            )}
            <p className="muted">{data.scope}</p>
          </section>
          {areas.length > 0 && (
            <section className="overview-card">
              <h2>先认识这些核心部分</h2>
              <p className="muted">这些部分按职责归纳，不要求与单个目录一一对应。</p>
              <div className="overview-areas">
                {areas.map((area, index) => (
                  <article className="overview-area" key={area.id}>
                    <div className="overview-area-heading">
                      <span>{index + 1}</span>
                      <div>
                        <h3>{area.title}</h3>
                        <small>
                          {area.importance === 'core'
                            ? '核心'
                            : area.importance === 'important'
                              ? '重要'
                              : '辅助'}
                        </small>
                      </div>
                    </div>
                    <p>{area.summary}</p>
                    <p className="overview-why">
                      <strong>为什么要认识它：</strong>
                      {area.whyItMatters}
                    </p>
                    {area.keyFiles.length > 0 && (
                      <div className="overview-key-files">
                        {area.keyFiles.map((file) => (
                          <button key={file.path} onClick={() => onOpen(file.path)}>
                            <strong>{file.path}</strong>
                            <span>{file.reason}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </article>
                ))}
              </div>
            </section>
          )}
          {(data.relations?.length ?? 0) > 0 && (
            <section className="overview-card">
              <h2>这些部分怎样配合</h2>
              <div className="overview-relations">
                {data.relations!.map((relation, index) => (
                  <div
                    className="overview-relation"
                    key={`${relation.fromAreaId}-${relation.toAreaId}-${relation.kind}-${index}`}
                  >
                    <div>
                      <strong>{areaNames.get(relation.fromAreaId) ?? relation.fromAreaId}</strong>
                      <span>{relationLabels[relation.kind]}</span>
                      <strong>{areaNames.get(relation.toAreaId) ?? relation.toAreaId}</strong>
                      {relation.confidence === 'inferred' && <small>待核实</small>}
                    </div>
                    <p>{relation.summary}</p>
                  </div>
                ))}
              </div>
            </section>
          )}
          <section className="overview-card">
            <h2>主要目录与文件</h2>
            <p className="muted">展开目录了解职责，点击文件查看原始代码。</p>
            {data.coverage && (
              <p className="muted">
                主要包与源码目录说明：{data.coverage.confirmed}/{data.coverage.expected.length}
                ；描述准确性仍需核对。
              </p>
            )}
            <OverviewTree nodes={data.nodes} onOpen={onOpen} />
          </section>
          {data.technologies.length > 0 && (
            <section className="overview-card">
              <h2>必要的技术背景</h2>
              {data.technologies.map((item) => (
                <p key={item.name}>
                  <strong>{item.name}：</strong>
                  {item.role}
                </p>
              ))}
            </section>
          )}
          {data.limitations.length > 0 && (
            <section className="overview-card limitations">
              <h2>覆盖说明</h2>
              {data.limitations.map((item, index) => (
                <p key={index}>{item}</p>
              ))}
            </section>
          )}
          <p className="muted">
            保存于 {new Date(data.createdAt).toLocaleString('zh-CN')} · {data.model} · 快照{' '}
            {data.version.slice(0, 7)}
          </p>
        </>
      )}
    </main>
  );
}
