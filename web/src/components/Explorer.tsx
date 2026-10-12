import { useMemo, type KeyboardEvent } from 'react';
import { useWorkspace } from '../store';
import type { Snapshot } from '../types';

type TreeNode = { name: string; path: string; directory: boolean; children: Map<string, TreeNode> };

export function buildTree(files: string[]) {
  const root: TreeNode = { name: '', path: '', directory: true, children: new Map() };
  for (const file of files) {
    let parent = root;
    file.split('/').forEach((name, index, parts) => {
      const path = parts.slice(0, index + 1).join('/');
      if (!parent.children.has(name))
        parent.children.set(name, {
          name,
          path,
          directory: index < parts.length - 1,
          children: new Map(),
        });
      parent = parent.children.get(name)!;
    });
  }
  return root;
}

export function Explorer({
  snapshot,
  onOpen,
}: {
  snapshot: Snapshot;
  onOpen: (path: string) => void;
}) {
  const { filePath, filter, expanded, set, toggleFolder, collapseFolders } = useWorkspace();
  const matches = useMemo(
    () => snapshot.files.filter((file) => file.toLowerCase().includes(filter.trim().toLowerCase())),
    [snapshot.files, filter],
  );
  const tree = useMemo(() => buildTree(matches), [matches]);
  const opened = new Set(expanded[snapshot.id] ?? []);

  const focus = (path: string) =>
    document
      .querySelector<HTMLButtonElement>(`#file-tree button[data-path="${CSS.escape(path)}"]`)
      ?.focus();
  const keyDown = (event: KeyboardEvent<HTMLButtonElement>, node: TreeNode, open: boolean) => {
    const rows = [...document.querySelectorAll<HTMLButtonElement>('#file-tree button[data-path]')],
      index = rows.indexOf(event.currentTarget);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      rows[index + (event.key === 'ArrowDown' ? 1 : -1)]?.focus();
    }
    if (event.key === 'ArrowRight' && node.directory) {
      event.preventDefault();
      if (!open) toggleFolder(snapshot.id, node.path);
      else rows[index + 1]?.focus();
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      if (node.directory && open && !filter) toggleFolder(snapshot.id, node.path);
      else focus(node.path.split('/').slice(0, -1).join('/'));
    }
  };
  const branch = (parent: TreeNode, depth = 0): React.ReactNode => (
    <ul className="file-branch">
      {[...parent.children.values()]
        .sort(
          (a, b) =>
            Number(b.directory) - Number(a.directory) ||
            a.name.localeCompare(b.name, 'zh-CN', { numeric: true }),
        )
        .map((node) => {
          const open = node.directory && (Boolean(filter) || opened.has(node.path));
          return (
            <li key={node.path}>
              <button
                className={`file-row ${node.directory ? 'folder-row' : 'document-row'} ${filePath === node.path ? 'active' : ''}`}
                data-path={node.path}
                aria-expanded={node.directory ? open : undefined}
                aria-current={filePath === node.path ? 'page' : undefined}
                title={node.path}
                style={{ paddingLeft: 8 + depth * 14 }}
                onKeyDown={(event) => keyDown(event, node, open)}
                onClick={() =>
                  node.directory
                    ? !filter && toggleFolder(snapshot.id, node.path)
                    : onOpen(node.path)
                }
              >
                <span className="file-chevron" aria-hidden>
                  {node.directory ? (open ? '⌄' : '›') : ''}
                </span>
                <span className={node.directory ? 'folder-icon' : 'document-icon'} aria-hidden />
                <span className="file-name">{node.name}</span>
              </button>
              {open && branch(node, depth + 1)}
            </li>
          );
        })}
    </ul>
  );

  return (
    <aside className="explorer">
      <div className="explorer-heading">
        <h2>资源管理器</h2>
        <button
          className="icon-button"
          title="折叠所有目录"
          aria-label="折叠所有目录"
          onClick={() => collapseFolders(snapshot.id)}
        >
          ⊟
        </button>
      </div>
      <input
        value={filter}
        onChange={(event) => set({ filter: event.target.value })}
        placeholder="筛选文件或路径"
        aria-label="筛选文件或路径"
      />
      <div className="project-root" title={snapshot.name}>
        {snapshot.name}
      </div>
      <nav id="file-tree" aria-label="项目目录与文件">
        {branch(tree)}
        {matches.length === 0 && <p className="files-empty">没有匹配的文件</p>}
      </nav>
    </aside>
  );
}
