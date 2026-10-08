import { useEffect, useRef, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import { useWorkspace } from './store';
import type {
  Model,
  ModelSettingsResponse,
  OverviewResponse,
  ProjectImportResult,
  ProjectListItem,
  ProjectSummary,
} from './types';
import { Overview } from './components/Overview';
import { ProjectRoutes } from './components/ProjectRoutes';
import { ProjectsPage } from './components/ProjectsPage';
import { SourceWorkspace } from './components/SourceWorkspace';

function ProjectWorkspace({
  model,
  onStatus,
}: {
  model?: string;
  onStatus: (value: string) => void;
}) {
  const { projectId } = useParams(),
    navigate = useNavigate(),
    location = useLocation(),
    workspace = useWorkspace();
  const projectQuery = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api<ProjectSummary>(`/api/projects/${projectId}`),
    enabled: Boolean(projectId),
  });
  const project = projectQuery.data;
  const snapshot = project?.currentSnapshot;
  const overview = useQuery({
    queryKey: ['overview', snapshot?.id],
    queryFn: () => api<OverviewResponse>(`/api/snapshots/${snapshot!.id}/overview`),
    enabled: Boolean(snapshot),
  });
  useEffect(() => {
    if (
      project &&
      snapshot &&
      (workspace.projectId !== project.id || workspace.snapshotId !== snapshot.id)
    ) {
      workspace.set({
        projectId: project.id,
        snapshotId: snapshot.id,
        filePath: snapshot.files[0],
      });
    }
  }, [project?.id, snapshot?.id]);
  if (projectQuery.isLoading) return <p className="project-loading">正在打开项目…</p>;
  if (!project || !snapshot) return <Navigate to="/projects" replace />;
  const openSource = (file: string) => {
    workspace.navigateSource(snapshot.id, {
      filePath: file,
      origin: 'file-tree',
      title: file,
      reason: '从项目总览打开这个关键文件。',
    });
    workspace.set({
      filePath: file,
      selection: undefined,
      activeAnnotationId: undefined,
      sidebarTab: 'files',
    });
    workspace.expandParents(snapshot.id, file);
    navigate(`/projects/${project.id}/source`);
  };
  const openRoute = (routeId: string) => {
    workspace.set({ activeRouteId: routeId, sidebarTab: 'routes', leftCollapsed: false });
    navigate(`/projects/${project.id}/source`);
  };
  const section = location.pathname.split('/').at(-1);
  if (section === 'overview')
    return (
      <Overview
        snapshot={snapshot}
        model={model}
        data={overview.data?.overview ?? null}
        task={overview.data?.task ?? null}
        onOpen={openSource}
      />
    );
  if (section === 'routes')
    return (
      <ProjectRoutes
        project={project}
        onOpenRoute={openRoute}
        onCreateRoute={() => {
          workspace.set({ sidebarTab: 'routes', activeRouteId: undefined, leftCollapsed: false });
          navigate(`/projects/${project.id}/source`);
        }}
      />
    );
  return (
    <SourceWorkspace projectId={project.id} snapshot={snapshot} model={model} onStatus={onStatus} />
  );
}

export function App() {
  const client = useQueryClient(),
    navigate = useNavigate(),
    location = useLocation(),
    workspace = useWorkspace();
  const [status, setStatus] = useState('');
  const initializedModel = useRef(false);
  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: () => api<ProjectListItem[]>('/api/projects'),
  });
  const models = useQuery({ queryKey: ['models'], queryFn: () => api<Model[]>('/api/models') });
  const modelSettings = useQuery({
    queryKey: ['model-settings'],
    queryFn: () => api<ModelSettingsResponse>('/api/model-settings'),
  });
  const imported = useMutation({
    mutationFn: (sourcePath: string) =>
      api<ProjectImportResult>('/api/projects', {
        method: 'POST',
        body: JSON.stringify({ path: sourcePath }),
      }),
    onSuccess: async (result) => {
      await client.invalidateQueries({ queryKey: ['projects'] });
      workspace.set({
        projectId: result.project.id,
        snapshotId: result.snapshot.id,
        filePath: result.snapshot.files[0],
        activeAnnotationId: undefined,
        selection: undefined,
        filter: '',
      });
      setStatus(result.reused ? '项目已打开，源码内容没有变化' : '项目源码已导入');
      navigate(`/projects/${result.project.id}/overview`);
    },
  });
  useEffect(() => {
    const available = models.data ?? [];
    if (!available.length || modelSettings.isLoading) return;
    const preferred = modelSettings.data?.defaultModelId;
    const next =
      !initializedModel.current && preferred && available.some((model) => model.id === preferred)
        ? preferred
        : available.some((model) => model.id === workspace.modelId)
          ? workspace.modelId
          : available[0].id;
    initializedModel.current = true;
    if (next !== workspace.modelId) workspace.set({ modelId: next });
  }, [models.data, modelSettings.data?.defaultModelId, modelSettings.isLoading, workspace.modelId]);
  useEffect(() => {
    if (!status) return;
    const timer = window.setTimeout(() => setStatus(''), 4500);
    return () => clearTimeout(timer);
  }, [status]);
  const projectId = location.pathname.match(/^\/projects\/([^/]+)/)?.[1];
  const current = projects.data?.find((project) => project.id === projectId);
  const section = location.pathname.split('/').at(-1),
    projectList = projects.data ?? [];
  return (
    <div className={`app-shell ${section === 'source' ? 'source-active' : ''}`}>
      <header className="app-toolbar">
        <button className="app-brand" onClick={() => navigate('/projects')}>
          CodeWalk <small>源码陪读</small>
        </button>
        {current && (
          <>
            <span className="project-crumb">{current.name}</span>
            <nav className="workspace-tabs" aria-label="项目视图">
              <button
                aria-current={section === 'overview' ? 'page' : undefined}
                onClick={() => navigate(`/projects/${current.id}/overview`)}
              >
                项目总览
              </button>
              <button
                aria-current={section === 'routes' ? 'page' : undefined}
                onClick={() => navigate(`/projects/${current.id}/routes`)}
              >
                阅读路线
              </button>
              <button
                aria-current={section === 'source' ? 'page' : undefined}
                onClick={() => navigate(`/projects/${current.id}/source`)}
              >
                源码与批注
              </button>
            </nav>
          </>
        )}
        <div className="toolbar-controls">
          {current && (
            <code title="当前源码版本">{current.currentSnapshot.version.slice(0, 7)}</code>
          )}
          <select
            aria-label="解释模型"
            disabled={!models.data?.length}
            title={modelSettings.data?.providerName ?? '使用本机模型配置'}
            value={workspace.modelId ?? ''}
            onChange={(event) => workspace.set({ modelId: event.target.value })}
          >
            {!models.data?.length && <option value="">尚无可用模型</option>}
            {models.data?.map((model) => (
              <option value={model.id} key={model.id}>
                {model.name}
              </option>
            ))}
          </select>
        </div>
      </header>
      {status && (
        <p className="global-status compact-status" role="status">
          {status}
        </p>
      )}
      {(models.error || modelSettings.error) && (
        <p className="global-status compact-status" role="alert">
          {models.error?.message ?? modelSettings.error?.message}
        </p>
      )}
      <Routes>
        <Route
          path="/projects"
          element={
            <ProjectsPage
              projects={projectList}
              busy={imported.isPending}
              error={imported.error?.message}
              onImport={(sourcePath) => imported.mutate(sourcePath)}
              onOpen={(project) => navigate(`/projects/${project.id}/overview`)}
            />
          }
        />
        <Route
          path="/projects/:projectId/*"
          element={<ProjectWorkspace model={workspace.modelId} onStatus={setStatus} />}
        />
        <Route
          path="*"
          element={
            <Navigate
              to={workspace.projectId ? `/projects/${workspace.projectId}/overview` : '/projects'}
              replace
            />
          }
        />
      </Routes>
    </div>
  );
}
