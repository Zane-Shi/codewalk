import { useState } from 'react';
import type { ProjectListItem } from '../types';

export function ProjectsPage({
  projects,
  busy,
  error,
  onImport,
  onOpen,
}: {
  projects: ProjectListItem[];
  busy: boolean;
  error?: string;
  onImport: (path: string) => void;
  onOpen: (project: ProjectListItem) => void;
}) {
  const [path, setPath] = useState('');
  return (
    <main className="projects-page">
      <header className="projects-heading">
        <div>
          <small>本地源码学习空间</small>
          <h1>项目</h1>
          <p>每个项目独立保存总览、阅读路线、源码版本和批注。</p>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (path.trim()) onImport(path.trim());
          }}
        >
          <input
            aria-label="项目目录"
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder="输入本地项目绝对路径"
          />
          <button disabled={busy || !path.trim()}>{busy ? '正在导入' : '导入项目'}</button>
        </form>
      </header>
      {error && (
        <p className="project-error" role="alert">
          {error}
        </p>
      )}
      {!projects.length ? (
        <section className="projects-empty">
          <h2>还没有项目</h2>
          <p>导入一个源码目录后，可以先生成项目总览，再建立多条阅读路线。</p>
        </section>
      ) : (
        <section className="project-list" aria-label="项目列表">
          {projects.map((project) => (
            <article className="project-row" key={project.id}>
              <button className="project-open" onClick={() => onOpen(project)}>
                <span className="project-main">
                  <strong>{project.name}</strong>
                  <small>
                    {project.sourcePath ?? '从旧版数据迁移，重新导入同一目录即可恢复路径关联'}
                  </small>
                </span>
                <span className="project-stat">
                  <strong>{project.routeCount}</strong>
                  <small>阅读路线</small>
                </span>
                <span className="project-stat">
                  <strong>{project.annotationCount}</strong>
                  <small>批注</small>
                </span>
                <span className="project-version">
                  <code>{project.currentSnapshot.version.slice(0, 7)}</code>
                  <small>{project.snapshotCount} 个源码版本</small>
                </span>
                <span className="project-arrow" aria-hidden="true">
                  ›
                </span>
              </button>
            </article>
          ))}
        </section>
      )}
    </main>
  );
}
