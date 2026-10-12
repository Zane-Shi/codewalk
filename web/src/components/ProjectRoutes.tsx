import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import type { ProjectSummary, RouteCatalogue, RouteSummary } from '../types';

export function ProjectRoutes({
  project,
  onOpenRoute,
  onCreateRoute,
}: {
  project: ProjectSummary;
  onOpenRoute: (routeId: string) => void;
  onCreateRoute: () => void;
}) {
  const client = useQueryClient();
  const routes = useQuery({
    queryKey: ['routes', project.id],
    queryFn: () => api<RouteCatalogue>(`/api/projects/${encodeURIComponent(project.id)}/routes`),
  });
  const archive = useMutation({
    mutationFn: ({ routeId, archived }: { routeId: string; archived: boolean }) =>
      api(`/api/routes/${encodeURIComponent(routeId)}/${archived ? 'archive' : 'restore'}`, {
        method: 'POST',
        body: '{}',
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['routes', project.id] }),
  });
  const activeRoutes = routes.data?.routes.filter((route) => route.status !== 'archived') ?? [];
  const archivedRoutes = routes.data?.routes.filter((route) => route.status === 'archived') ?? [];
  const row = (route: RouteSummary, archived: boolean) => (
    <article className="route-library-row" key={route.id}>
      <button className="route-library-open" onClick={() => onOpenRoute(route.id)}>
        <span className="route-library-title">
          <small>
            {route.kind === 'main' ? '主线' : '路线'} · 版本 {route.revision}
            {route.status === 'partial' ? ' · 部分结果' : ''}
          </small>
          <strong>{route.title}</strong>
          <span>{route.summary}</span>
        </span>
        <span className="route-library-stat">
          <strong>{route.module_count}</strong>
          <small>模块</small>
        </span>
        <span className="route-library-stat">
          <strong>{route.block_count}</strong>
          <small>代码块</small>
        </span>
        <span className="route-library-date">
          {new Date(route.updated_at).toLocaleDateString('zh-CN')}
        </span>
        <span className="project-arrow" aria-hidden="true">
          ›
        </span>
      </button>
      <button
        className="route-library-action"
        disabled={archive.isPending}
        onClick={() => archive.mutate({ routeId: route.id, archived: !archived })}
      >
        {archived ? '恢复' : '归档'}
      </button>
    </article>
  );
  return (
    <main className="project-routes-page">
      <header className="project-section-heading">
        <div>
          <small>项目内全部路线</small>
          <h1>阅读路线</h1>
          <p>每条路线围绕一个具体场景组织语义模块和关键代码块。</p>
        </div>
        <button onClick={onCreateRoute}>新建路线</button>
      </header>
      {routes.isLoading && <p className="project-loading">正在读取路线…</p>}
      {routes.error && <p className="project-error">{routes.error.message}</p>}
      {routes.data && !activeRoutes.length && (
        <section className="projects-empty">
          <h2>还没有正在阅读的路线</h2>
          <p>进入源码工作台，描述目标或让 Agent 自动选择一条主线。</p>
          <button onClick={onCreateRoute}>建立一条主线</button>
        </section>
      )}
      {archive.error && <p className="project-error">{archive.error.message}</p>}
      <section className="route-library">{activeRoutes.map((route) => row(route, false))}</section>
      {archivedRoutes.length > 0 && (
        <details className="archived-routes">
          <summary>已归档路线（{archivedRoutes.length}）</summary>
          <section className="route-library">
            {archivedRoutes.map((route) => row(route, true))}
          </section>
        </details>
      )}
    </main>
  );
}
