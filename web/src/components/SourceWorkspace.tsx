import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import type { editor as MonacoEditor, IDisposable, Range } from 'monaco-editor';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, consumeSse } from '../api';
import { PANEL_LIMITS, resolvePanelWidths } from '../panel-layout';
import { useWorkspace } from '../store';
import type {
  Annotation,
  AnnotationDetail,
  RouteBlock,
  RouteCatalogue,
  RouteDelivery,
  Snapshot,
  SourceAnchor,
  SourceLocation,
  SourceSelection,
  StreamEvent,
} from '../types';
import { Explorer } from './Explorer';
import { RoutePanel, blockLocation } from './RoutePanel';
import { TeachingPanel } from './TeachingPanel';

type ChatState = {
  annotationId?: string;
  busy: boolean;
  question?: string;
  stream: string;
  progress: string;
};
const colors = ['#568e78', '#8585af', '#b28d59', '#628faa', '#af7c87'];
const endLine = (anchor: SourceAnchor) =>
  anchor.endPosition.line -
  (anchor.endPosition.column === 1 && anchor.endPosition.line > anchor.startPosition.line ? 1 : 0);

function language(path?: string) {
  const extension = path?.split('.').at(-1)?.toLowerCase();
  return (
    (
      {
        js: 'javascript',
        mjs: 'javascript',
        cjs: 'javascript',
        jsx: 'javascript',
        ts: 'typescript',
        tsx: 'typescript',
        py: 'python',
        java: 'java',
        go: 'go',
        rs: 'rust',
        json: 'json',
        md: 'markdown',
        css: 'css',
        html: 'html',
        yaml: 'yaml',
        yml: 'yaml',
        sh: 'shell',
      } as Record<string, string>
    )[extension ?? ''] ?? 'plaintext'
  );
}

function Prose({ text }: { text: string }) {
  return (
    <>
      {text.split('```').map((piece, index) =>
        index % 2 ? (
          <pre key={index}>{piece.replace(/^[\w+-]*\n/, '')}</pre>
        ) : (
          piece
            .split('\n')
            .filter(Boolean)
            .map((line, lineIndex) => {
              const key = `${index}-${lineIndex}`,
                section = line.match(/^\s*(?:\d+[.\u3001]\s*)?\*\*(.+?)\*\*[\uff1a:]?\s*(.*)$/),
                heading = line.match(/^#{1,6}\s+(.+)$/),
                bullet = line.match(/^\s*[-*]\s+(.+)$/);
              if (section)
                return (
                  <p className="message-section" key={key}>
                    <strong>{section[1]}</strong>
                    {section[2] && <span>{section[2]}</span>}
                  </p>
                );
              if (heading)
                return (
                  <p className="message-section" key={key}>
                    <strong>{heading[1]}</strong>
                  </p>
                );
              return (
                <p className={bullet ? 'message-bullet' : undefined} key={key}>
                  {bullet ? bullet[1] : line}
                </p>
              );
            })
        ),
      )}
    </>
  );
}

function AnnotationPanel({
  snapshot,
  annotations,
  editor,
  editorHost,
  workspace,
  chat,
  runChat,
  onSelect,
  onOpenFile,
}: {
  snapshot: Snapshot;
  annotations: Annotation[];
  editor?: MonacoEditor.IStandaloneCodeEditor;
  editorHost: React.RefObject<HTMLDivElement | null>;
  workspace: React.RefObject<HTMLDivElement | null>;
  chat: ChatState;
  runChat: (id: string, question: string) => Promise<void>;
  onSelect: (selection: SourceAnchor) => void;
  onOpenFile: (path: string, line?: number) => Promise<void>;
}) {
  const client = useQueryClient(),
    { filePath, activeAnnotationId, minimized, annotationScope, set } = useWorkspace();
  const rail = useRef<HTMLDivElement>(null),
    cards = useRef(new Map<string, HTMLElement>()),
    [paths, setPaths] = useState<{ id: string; d: string; color: string; active: boolean }[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [conversationHeights, setConversationHeights] = useState<Record<string, number>>({});
  const relevant = useMemo(
    () =>
      annotations
        .filter((item) => annotationScope === 'all' || item.filePath === filePath)
        .sort((a, b) =>
          annotationScope === 'all'
            ? b.createdAt - a.createdAt
            : a.anchor.start - b.anchor.start || a.createdAt - b.createdAt,
        ),
    [annotations, filePath, annotationScope],
  );
  const detail = useQuery({
    queryKey: ['annotation', activeAnnotationId],
    queryFn: () => api<AnnotationDetail>(`/api/annotations/${activeAnnotationId}`),
    enabled: Boolean(activeAnnotationId),
    refetchOnWindowFocus: false,
  });
  const layout = useCallback(() => {
    if (
      !editor ||
      !workspace.current ||
      !editorHost.current ||
      !rail.current ||
      window.innerWidth <= 800
    )
      return setPaths([]);
    const base = workspace.current.getBoundingClientRect(),
      source = editorHost.current.getBoundingClientRect(),
      railBox = rail.current.getBoundingClientRect();
    setPaths(
      relevant.flatMap((item, index) => {
        if (item.filePath !== filePath) return [];
        const card = cards.current.get(item.id),
          visible = editor.getScrolledVisiblePosition({
            lineNumber: item.anchor.startPosition.line,
            column: item.anchor.startPosition.column,
          });
        if (!card || !visible) return [];
        const cardBox = card.getBoundingClientRect(),
          y1 = source.top - base.top + visible.top + visible.height / 2,
          y2 = cardBox.top - base.top + 26;
        if (cardBox.bottom < railBox.top || cardBox.top > railBox.bottom) return [];
        const x1 = source.right - base.left - 8,
          x2 = cardBox.left - base.left;
        return [
          {
            id: item.id,
            d: `M ${x1} ${y1} C ${x1 + 28} ${y1}, ${x2 - 28} ${y2}, ${x2} ${y2}`,
            color: colors[index % colors.length],
            active: item.id === activeAnnotationId,
          },
        ];
      }),
    );
  }, [editor, relevant, activeAnnotationId, editorHost, workspace, filePath]);
  useEffect(() => {
    const disposables: IDisposable[] = [];
    if (editor)
      disposables.push(editor.onDidScrollChange(layout), editor.onDidLayoutChange(layout));
    const observer = new ResizeObserver(layout);
    if (rail.current) observer.observe(rail.current);
    if (workspace.current) observer.observe(workspace.current);
    window.addEventListener('resize', layout);
    requestAnimationFrame(layout);
    return () => {
      disposables.forEach((item) => item.dispose());
      observer.disconnect();
      window.removeEventListener('resize', layout);
    };
  }, [editor, layout, workspace]);
  useEffect(() => {
    requestAnimationFrame(layout);
  }, [conversationHeights, layout]);

  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/annotations/${id}`, { method: 'DELETE' }),
    onSuccess: (_, id) => {
      if (activeAnnotationId === id) set({ activeAnnotationId: undefined, minimized: false });
      return client.invalidateQueries({ queryKey: ['annotations', snapshot.id] });
    },
  });
  const activeDetail = detail.data;
  const setConversationHeight = (id: string, height: number) =>
    setConversationHeights((current) => ({
      ...current,
      [id]: Math.min(900, Math.max(120, Math.round(height))),
    }));
  const beginConversationResize = (id: string, event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const conversation = event.currentTarget.previousElementSibling as HTMLElement | null;
    if (!conversation) return;
    const startY = event.clientY,
      startHeight = conversation.getBoundingClientRect().height;
    document.body.classList.add('resizing-conversation');
    const move = (pointer: PointerEvent) =>
      setConversationHeight(id, startHeight + pointer.clientY - startY);
    const finish = () => {
      document.body.classList.remove('resizing-conversation');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  };
  const resizeConversationWithKeyboard = (id: string, event: React.KeyboardEvent) => {
    if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    setConversationHeight(
      id,
      (conversationHeights[id] ?? 330) + (event.key === 'ArrowDown' ? 24 : -24),
    );
  };
  return (
    <>
      <svg className="connections" aria-hidden>
        {paths.map((path) => (
          <path
            key={path.id}
            d={path.d}
            stroke={path.color}
            className={path.active ? 'active' : ''}
          />
        ))}
      </svg>
      <section className="discussion">
        <div className="discussion-heading">
          <div>
            <h2>
              源码批注 <small>{relevant.length}</small>
            </h2>
            <p>可以离开路线，查看并提问任意代码</p>
          </div>
          <select
            aria-label="批注范围"
            value={annotationScope}
            onChange={(event) => set({ annotationScope: event.target.value as 'file' | 'all' })}
          >
            <option value="file">当前文件</option>
            <option value="all">全部批注</option>
          </select>
        </div>
        <div className="comments-viewport" ref={rail} onScroll={layout}>
          {relevant.map((item, index) => {
            const active = item.id === activeAnnotationId,
              expanded = active && !minimized;
            return (
              <article
                key={item.id}
                ref={(node) => {
                  if (node) cards.current.set(item.id, node);
                  else cards.current.delete(item.id);
                }}
                className={`comment-card ${expanded ? 'active' : ''}`}
                style={{ '--card-color': colors[index % colors.length] } as React.CSSProperties}
              >
                <div className="card-header">
                  <span className="card-avatar">{String(index + 1).padStart(2, '0')}</span>
                  <button
                    className="card-open"
                    aria-expanded={expanded}
                    onClick={() => {
                      if (item.filePath !== filePath)
                        void onOpenFile(item.filePath, item.anchor.startPosition.line);
                      active
                        ? set({ minimized: !minimized })
                        : set({ activeAnnotationId: item.id, minimized: false });
                    }}
                  >
                    <strong>
                      L{item.anchor.startPosition.line}
                      {endLine(item.anchor) !== item.anchor.startPosition.line &&
                        `–${endLine(item.anchor)}`}{' '}
                      · 代码对话
                    </strong>
                    <small>
                      {annotationScope === 'all' && `${item.filePath} · `}
                      {new Date(item.createdAt).toLocaleString('zh-CN', {
                        month: '2-digit',
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </small>
                  </button>
                  {expanded && (
                    <button
                      className="card-action"
                      aria-label="最小化对话"
                      title="最小化对话"
                      onClick={() => set({ minimized: true })}
                    >
                      −
                    </button>
                  )}
                  <button className="card-action" onClick={() => onSelect(item.anchor)}>
                    + 新建
                  </button>
                  <button
                    className="card-action danger"
                    disabled={chat.busy}
                    onClick={() => remove.mutate(item.id)}
                  >
                    删除
                  </button>
                </div>
                {!expanded && (
                  <div className="card-preview">{item.anchor.text.replace(/\n/g, ' ')}</div>
                )}
                {expanded && (
                  <div className="thread">
                    <div className="thread-head">
                      {item.filePath}:L{item.anchor.startPosition.line} · {item.model}
                    </div>
                    <details className="quoted-code">
                      <summary>查看引用源码</summary>
                      <pre>{item.anchor.text}</pre>
                    </details>
                    <div
                      className="conversation"
                      style={
                        conversationHeights[item.id]
                          ? {
                              height: `${conversationHeights[item.id]}px`,
                              maxHeight: `${conversationHeights[item.id]}px`,
                            }
                          : undefined
                      }
                    >
                      {activeDetail?.messages.map((message) => (
                        <div className={`message ${message.role}`} key={message.id}>
                          <Prose text={message.text} />
                        </div>
                      ))}
                      {chat.busy && chat.annotationId === item.id && (
                        <>
                          {activeDetail?.messages.at(-1)?.text !==
                            (chat.question || '解释这段代码') && (
                            <div className="message user">{chat.question || '解释这段代码'}</div>
                          )}
                          <pre className="stream">{chat.stream}</pre>
                        </>
                      )}
                    </div>
                    <div
                      className="conversation-resizer"
                      role="separator"
                      aria-label="调整批注内容高度"
                      aria-orientation="horizontal"
                      aria-valuemin={120}
                      aria-valuemax={900}
                      aria-valuenow={conversationHeights[item.id] ?? 330}
                      tabIndex={0}
                      title="向下拖动以展开批注内容"
                      onPointerDown={(event) => beginConversationResize(item.id, event)}
                      onKeyDown={(event) => resizeConversationWithKeyboard(item.id, event)}
                    >
                      <span>↕ 向下拖动展开</span>
                    </div>
                    <p className="progress">
                      {chat.annotationId === item.id && chat.busy
                        ? chat.progress
                        : activeDetail?.tasks[0]?.error ||
                          (activeDetail?.tasks[0]?.status === 'complete'
                            ? '已保存'
                            : '可以继续追问')}
                    </p>
                    <form
                      className="followup"
                      onSubmit={(event) => {
                        event.preventDefault();
                        const question = drafts[item.id] ?? '';
                        if (question.trim()) {
                          setDrafts((current) => ({ ...current, [item.id]: '' }));
                          void runChat(item.id, question);
                        }
                      }}
                    >
                      <textarea
                        name="question"
                        value={drafts[item.id] ?? ''}
                        onChange={(event) =>
                          setDrafts((current) => ({ ...current, [item.id]: event.target.value }))
                        }
                        placeholder="追问这段代码…"
                        maxLength={8000}
                        required
                      />
                      <div className="composer-actions">
                        <span>对话仅属于这条批注</span>
                        <button disabled={chat.busy}>发送追问 ↗</button>
                        {chat.busy && chat.annotationId === item.id && (
                          <button
                            type="button"
                            className="quiet"
                            onClick={() =>
                              api(`/api/annotations/${item.id}/cancel`, {
                                method: 'POST',
                                body: '{}',
                              })
                            }
                          >
                            停止
                          </button>
                        )}
                      </div>
                    </form>
                  </div>
                )}
              </article>
            );
          })}
          {relevant.length === 0 && (
            <p className="empty">
              框选一段源码，开始一场对话。
              <br />
              同一段代码可以保留多个问题。
            </p>
          )}
        </div>
      </section>
    </>
  );
}

export function SourceWorkspace({
  projectId,
  snapshot,
  model,
  onStatus,
}: {
  projectId: string;
  snapshot: Snapshot;
  model?: string;
  onStatus: (text: string) => void;
}) {
  const client = useQueryClient(),
    state = useWorkspace(),
    {
      filePath,
      selection,
      initialQuestionOpen,
      set,
      expandParents,
      navigation,
      navigateSource,
      backSource,
      forwardSource,
    } = state;
  const selectedFile = filePath && snapshot.files.includes(filePath) ? filePath : snapshot.files[0];
  const file = useQuery({
    queryKey: ['file', snapshot.id, selectedFile],
    queryFn: () =>
      api<{ content: string; lines: number }>(
        `/api/file?snapshotId=${snapshot.id}&path=${encodeURIComponent(selectedFile)}`,
      ),
    enabled: Boolean(selectedFile),
  });
  const annotationQuery = useQuery({
    queryKey: ['annotations', snapshot.id],
    queryFn: () => api<Annotation[]>(`/api/annotations?snapshotId=${snapshot.id}`),
  });
  const routesQuery = useQuery({
    queryKey: ['routes', projectId],
    queryFn: () => api<RouteCatalogue>(`/api/projects/${encodeURIComponent(projectId)}/routes`),
    refetchInterval: (query) =>
      (query.state.data as RouteCatalogue | undefined)?.tasks.some((task) =>
        ['investigating', 'explaining', 'finalizing'].includes(task.status),
      )
        ? 2000
        : false,
  });
  const selectedRouteId = routesQuery.data?.routes.some((route) => route.id === state.activeRouteId)
    ? state.activeRouteId
    : routesQuery.data?.routes[0]?.id;
  const routeQuery = useQuery({
    queryKey: ['route', selectedRouteId],
    queryFn: () => api<RouteDelivery>(`/api/routes/${encodeURIComponent(selectedRouteId!)}`),
    enabled: Boolean(selectedRouteId),
  });
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | undefined>(undefined),
    editorHost = useRef<HTMLDivElement>(null),
    workspace = useRef<HTMLDivElement>(null),
    decoration = useRef<MonacoEditor.IEditorDecorationsCollection | undefined>(undefined);
  const rightPanel = useRef<HTMLElement>(null);
  const [editor, setEditor] = useState<MonacoEditor.IStandaloneCodeEditor>(),
    [chat, setChat] = useState<ChatState>({ busy: false, stream: '', progress: '' });
  const [workspaceWidth, setWorkspaceWidth] = useState(() =>
    typeof window === 'undefined' ? 1200 : window.innerWidth,
  );
  const panelWidths = resolvePanelWidths(
    workspaceWidth,
    state.leftPanelWidth ?? 260,
    state.rightPanelWidth ?? 400,
    state.leftCollapsed,
    state.rightCollapsed,
  );
  useEffect(() => {
    if (!filePath || !snapshot.files.includes(filePath)) {
      set({ filePath: snapshot.files[0], activeAnnotationId: undefined, selection: undefined });
      expandParents(snapshot.id, snapshot.files[0]);
    }
  }, [snapshot.id, snapshot.files, filePath, set, expandParents]);
  useEffect(() => {
    if (selectedRouteId && selectedRouteId !== state.activeRouteId)
      set({ activeRouteId: selectedRouteId, activeModuleId: undefined, activeBlockId: undefined });
  }, [selectedRouteId, state.activeRouteId, set]);
  useEffect(() => {
    const route = routeQuery.data;
    if (!route) return;
    const current = route.modules
      .flatMap((module) => module.blocks)
      .find((block) => block.id === state.activeBlockId);
    if (!current) {
      const firstModule = route.modules[0],
        firstBlock = firstModule?.blocks[0];
      if (!firstModule || !firstBlock) return;
      const location = blockLocation(firstBlock);
      navigateSource(snapshot.id, location);
      set({
        activeModuleId: firstModule.id,
        activeBlockId: firstBlock.id,
        filePath: location.filePath,
        selection: undefined,
        initialQuestionOpen: false,
        activeAnnotationId: undefined,
        minimized: false,
      });
      expandParents(snapshot.id, location.filePath);
    }
  }, [routeQuery.data, state.activeBlockId, snapshot.id, set, navigateSource, expandParents]);
  const active = annotationQuery.data?.find((item) => item.id === state.activeAnnotationId);
  const currentLocation = navigation[snapshot.id]?.current;
  useEffect(() => {
    decoration.current?.clear();
    if (!editor) return;
    if (currentLocation?.filePath === selectedFile && currentLocation.startLine)
      decoration.current = editor.createDecorationsCollection([
        {
          range: {
            startLineNumber: currentLocation.startLine,
            startColumn: 1,
            endLineNumber: currentLocation.endLine ?? currentLocation.startLine,
            endColumn: 1,
          },
          options: { isWholeLine: true, className: 'route-code-line' },
        },
      ]);
    else if (active)
      decoration.current = editor.createDecorationsCollection([
        {
          range: {
            startLineNumber: active.anchor.startPosition.line,
            startColumn: 1,
            endLineNumber: endLine(active.anchor),
            endColumn: 1,
          },
          options: { isWholeLine: true, className: 'active-code-line' },
        },
      ]);
  }, [editor, active, currentLocation, selectedFile]);
  useEffect(() => {
    if (
      editor &&
      file.data &&
      currentLocation?.filePath === selectedFile &&
      currentLocation.startLine
    )
      editor.revealLineInCenter(currentLocation.startLine);
  }, [editor, file.data, currentLocation, selectedFile]);
  useEffect(() => {
    const node = workspace.current;
    if (!node) return;
    const update = () => setWorkspaceWidth(node.clientWidth);
    const observer = new ResizeObserver(update);
    observer.observe(node);
    update();
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    requestAnimationFrame(() => editor?.layout());
  }, [
    editor,
    state.leftCollapsed,
    state.rightCollapsed,
    state.rightTab,
    panelWidths.left,
    panelWidths.right,
  ]);
  useEffect(() => {
    const panel = rightPanel.current;
    if (!panel) return;
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey) return;
      const candidates: HTMLElement[] = [];
      let element = event.target instanceof HTMLElement ? event.target : null;
      while (element && element !== panel) {
        const overflow = getComputedStyle(element).overflowY;
        if (/(auto|scroll)/.test(overflow) && element.scrollHeight > element.clientHeight + 1)
          candidates.push(element);
        element = element.parentElement;
      }
      const main = panel.querySelector<HTMLElement>('.teaching-scroll, .comments-viewport');
      if (main && !candidates.includes(main)) candidates.push(main);
      const target = candidates.find((candidate) =>
        event.deltaY < 0
          ? candidate.scrollTop > 0
          : candidate.scrollTop + candidate.clientHeight < candidate.scrollHeight - 1,
      );
      event.preventDefault();
      if (target) {
        const scale =
          event.deltaMode === WheelEvent.DOM_DELTA_LINE
            ? 16
            : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
              ? target.clientHeight
              : 1;
        target.scrollTop += event.deltaY * scale;
      }
    };
    panel.addEventListener('wheel', wheel, { passive: false });
    return () => panel.removeEventListener('wheel', wheel);
  }, [state.rightCollapsed, state.rightTab]);
  const mount: OnMount = (instance) => {
    editorRef.current = instance;
    setEditor(instance);
  };
  const applyLocation = (location: SourceLocation) => {
    set({
      filePath: location.filePath,
      selection: undefined,
      initialQuestionOpen: false,
      activeAnnotationId: undefined,
      minimized: false,
    });
    expandParents(snapshot.id, location.filePath);
  };
  const openLocation = (location: SourceLocation) => {
    navigateSource(snapshot.id, location);
    applyLocation(location);
  };
  const openFile = async (path: string, line?: number) =>
    openLocation({
      filePath: path,
      startLine: line,
      endLine: line,
      origin: line ? 'citation' : 'file-tree',
      title: line ? `源码证据 · ${path}:L${line}` : path,
      reason: line ? '这段源码是 Agent 回答所依据的证据。' : '从项目文件树打开这个文件。',
    });
  const moveHistory = (direction: 'back' | 'forward') => {
    const location = direction === 'back' ? backSource(snapshot.id) : forwardSource(snapshot.id);
    if (location) applyLocation(location);
  };
  const select = (value: SourceAnchor) => {
    set({ selection: { ...value, selectedText: value.text }, initialQuestionOpen: true });
    editorRef.current?.setSelection({
      startLineNumber: value.startPosition.line,
      startColumn: value.startPosition.column,
      endLineNumber: value.endPosition.line,
      endColumn: value.endPosition.column,
    });
    editorRef.current?.revealLineInCenter(value.startPosition.line);
  };
  const runChat = async (id: string, question: string) => {
    set({ activeAnnotationId: id, minimized: false });
    setChat({ annotationId: id, busy: true, question, stream: '', progress: '正在调查源码…' });
    let failure = '';
    try {
      await consumeSse(
        `/api/annotations/${id}/chat`,
        { question },
        new AbortController().signal,
        (event) => {
          if (event.type === 'progress')
            setChat((current) => ({
              ...current,
              progress: `正在 ${String(event.data.tool)}：${String(event.data.path)}`,
            }));
          if (event.type === 'phase')
            setChat((current) => ({ ...current, progress: '正在整理讲解…' }));
          if (event.type === 'delta')
            setChat((current) => ({
              ...current,
              stream: current.stream + String(event.data.text),
            }));
          if (event.type === 'failure') failure = String(event.data.message);
        },
      );
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      setChat((current) => ({ ...current, busy: false, progress: failure || '已保存' }));
      await Promise.all([
        client.invalidateQueries({ queryKey: ['annotations', snapshot.id] }),
        client.invalidateQueries({ queryKey: ['annotation', id] }),
      ]);
      onStatus(failure || '解释已保存，可以继续追问');
    }
  };
  const create = async (question: string) => {
    if (!selection || !selectedFile || !model)
      return onStatus(!model ? '请选择可用模型' : '请先框选代码');
    const record = await api<Annotation>('/api/annotations', {
      method: 'POST',
      body: JSON.stringify({
        snapshotId: snapshot.id,
        filePath: selectedFile,
        start: selection.start,
        end: selection.end,
        selectedText: selection.selectedText,
        model,
      }),
    });
    set({
      activeAnnotationId: record.id,
      minimized: false,
      initialQuestionOpen: false,
      rightTab: 'annotations',
      rightCollapsed: false,
    });
    await client.invalidateQueries({ queryKey: ['annotations', snapshot.id] });
    await runChat(record.id, question);
  };
  const selectRoute = (routeId: string) =>
    set({ activeRouteId: routeId, activeModuleId: undefined, activeBlockId: undefined });
  const openBlock = (moduleId: string, block: RouteBlock) => {
    set({
      activeModuleId: moduleId,
      activeBlockId: block.id,
      rightTab: 'teaching',
      rightCollapsed: false,
    });
    openLocation(blockLocation(block));
  };
  const setPanelWidth = (side: 'left' | 'right', value: number) => {
    const limits = PANEL_LIMITS[side];
    set({
      [side === 'left' ? 'leftPanelWidth' : 'rightPanelWidth']: Math.min(
        limits.max,
        Math.max(limits.min, Math.round(value)),
      ),
    });
  };
  const beginPanelResize = (side: 'left' | 'right', event: React.PointerEvent) => {
    event.preventDefault();
    const startX = event.clientX,
      startWidth = panelWidths[side];
    document.body.classList.add('resizing-panels');
    const move = (pointer: PointerEvent) =>
      setPanelWidth(
        side,
        startWidth + (side === 'left' ? pointer.clientX - startX : startX - pointer.clientX),
      );
    const finish = () => {
      document.body.classList.remove('resizing-panels');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  };
  const resizeWithKeyboard = (side: 'left' | 'right', event: React.KeyboardEvent) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const increase =
      event.key === 'ArrowUp' ||
      (side === 'left' ? event.key === 'ArrowRight' : event.key === 'ArrowLeft');
    setPanelWidth(side, panelWidths[side] + (increase ? 10 : -10));
  };
  const updateSelection = useCallback(
    (value?: SourceSelection) => set({ selection: value, initialQuestionOpen: false }),
    [set],
  );
  return (
    <main
      className={`source-workspace ${state.leftCollapsed ? 'left-collapsed' : ''} ${state.rightCollapsed ? 'right-collapsed' : ''}`}
      ref={workspace}
      style={
        {
          '--left-panel-width': `${panelWidths.left}px`,
          '--right-panel-width': `${panelWidths.right}px`,
        } as React.CSSProperties
      }
    >
      {state.leftCollapsed ? (
        <aside className="panel-rail left-rail">
          <button
            title="展开左侧栏"
            aria-label="展开左侧栏"
            onClick={() => set({ leftCollapsed: false })}
          >
            ›
          </button>
          <span>{state.sidebarTab === 'routes' ? '路线' : '文件'}</span>
        </aside>
      ) : (
        <aside className="source-sidebar">
          <div className="sidebar-tabs">
            <button
              aria-current={state.sidebarTab === 'routes' ? 'page' : undefined}
              onClick={() => set({ sidebarTab: 'routes' })}
            >
              带读路线
            </button>
            <button
              aria-current={state.sidebarTab === 'files' ? 'page' : undefined}
              onClick={() => set({ sidebarTab: 'files' })}
            >
              文件
            </button>
            <button
              className="collapse-button"
              title="收起左侧栏"
              aria-label="收起左侧栏"
              onClick={() => set({ leftCollapsed: true })}
            >
              ‹
            </button>
          </div>
          {state.sidebarTab === 'routes' ? (
            <RoutePanel
              projectId={projectId}
              snapshot={snapshot}
              model={model}
              catalogue={routesQuery.data}
              route={routeQuery.data}
              activeBlockId={state.activeBlockId}
              onSelectRoute={selectRoute}
              onOpenBlock={openBlock}
              onStatus={onStatus}
            />
          ) : (
            <Explorer snapshot={snapshot} onOpen={openFile} />
          )}
        </aside>
      )}
      {!state.leftCollapsed && (
        <div
          className="panel-resizer left-panel-resizer"
          role="separator"
          aria-label="调整左侧栏宽度"
          aria-orientation="vertical"
          aria-valuemin={PANEL_LIMITS.left.min}
          aria-valuemax={PANEL_LIMITS.left.max}
          aria-valuenow={panelWidths.left}
          tabIndex={0}
          title={`拖动调整左侧栏（${PANEL_LIMITS.left.min}–${PANEL_LIMITS.left.max}px）`}
          onPointerDown={(event) => beginPanelResize('left', event)}
          onKeyDown={(event) => resizeWithKeyboard('left', event)}
        />
      )}
      <section className="source-pane">
        <div className="source-title">
          <div className="history-buttons">
            <button
              disabled={!navigation[snapshot.id]?.back.length}
              onClick={() => moveHistory('back')}
              title="返回上一处"
            >
              ←
            </button>
            <button
              disabled={!navigation[snapshot.id]?.forward.length}
              onClick={() => moveHistory('forward')}
              title="前进"
            >
              →
            </button>
          </div>
          <strong>{selectedFile || '选择一个文件开始'}</strong>
          <span>
            {selection
              ? `L${selection.startPosition.line}`
              : currentLocation?.startLine
                ? `L${currentLocation.startLine}`
                : ''}
          </span>
        </div>
        {currentLocation && (
          <div className="navigation-reason">
            <strong>{currentLocation.title}</strong>
            <span>{currentLocation.reason}</span>
          </div>
        )}
        <div className="editor-host" ref={editorHost}>
          {file.data && (
            <Editor
              height="100%"
              path={selectedFile}
              language={language(selectedFile)}
              value={file.data.content}
              onMount={mount}
              options={{
                readOnly: true,
                minimap: { enabled: false },
                fontSize: 13,
                lineHeight: 22,
                glyphMargin: false,
                folding: true,
                wordWrap: 'off',
                automaticLayout: true,
                scrollBeyondLastLine: false,
                renderLineHighlight: 'none',
                selectionHighlight: true,
              }}
              onChange={() => undefined}
              onValidate={() => undefined}
            />
          )}
        </div>
        {selection && (
          <div className="selection-bar">
            <span>
              第 {selection.startPosition.line} 行起，已选择 {selection.end - selection.start} 字符
            </span>
            <button disabled={chat.busy} onClick={() => void create('')}>
              解释这段
            </button>
            <button
              disabled={chat.busy}
              onClick={() =>
                set({ initialQuestionOpen: true, rightTab: 'annotations', rightCollapsed: false })
              }
            >
              针对这段提问
            </button>
          </div>
        )}
        {selection && initialQuestionOpen && (
          <form
            className="initial-question"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              void create(String(form.get('question') ?? ''));
            }}
          >
            <input
              name="question"
              placeholder="为这段代码新建一个问题…"
              maxLength={8000}
              autoFocus
            />
            <button disabled={chat.busy}>新建对话</button>
          </form>
        )}
      </section>
      {!state.rightCollapsed && (
        <div
          className="panel-resizer right-panel-resizer"
          role="separator"
          aria-label="调整右侧栏宽度"
          aria-orientation="vertical"
          aria-valuemin={PANEL_LIMITS.right.min}
          aria-valuemax={PANEL_LIMITS.right.max}
          aria-valuenow={panelWidths.right}
          tabIndex={0}
          title={`拖动调整右侧栏（${PANEL_LIMITS.right.min}–${PANEL_LIMITS.right.max}px）`}
          onPointerDown={(event) => beginPanelResize('right', event)}
          onKeyDown={(event) => resizeWithKeyboard('right', event)}
        />
      )}
      {state.rightCollapsed ? (
        <aside className="panel-rail right-rail">
          <button
            title="展开右侧栏"
            aria-label="展开右侧栏"
            onClick={() => set({ rightCollapsed: false })}
          >
            ‹
          </button>
          <span>{state.rightTab === 'teaching' ? '讲解' : '批注'}</span>
        </aside>
      ) : (
        <aside className="right-panel" ref={rightPanel}>
          <div className="right-tabs">
            <button
              aria-current={state.rightTab === 'teaching' ? 'page' : undefined}
              onClick={() => set({ rightTab: 'teaching' })}
            >
              带读讲解
            </button>
            <button
              aria-current={state.rightTab === 'annotations' ? 'page' : undefined}
              onClick={() => set({ rightTab: 'annotations' })}
            >
              问答批注
            </button>
            <button
              className="collapse-button"
              title="收起右侧栏"
              aria-label="收起右侧栏"
              onClick={() => set({ rightCollapsed: true })}
            >
              ›
            </button>
          </div>
          {state.rightTab === 'teaching' ? (
            <TeachingPanel
              route={routeQuery.data}
              activeModuleId={state.activeModuleId}
              activeBlockId={state.activeBlockId}
              onOpenBlock={openBlock}
              onNavigate={openLocation}
            />
          ) : (
            <AnnotationPanel
              snapshot={snapshot}
              annotations={annotationQuery.data ?? []}
              editor={editor}
              editorHost={editorHost}
              workspace={workspace}
              chat={chat}
              runChat={runChat}
              onSelect={select}
              onOpenFile={openFile}
            />
          )}
        </aside>
      )}
      <SelectionBridge
        editor={editor}
        value={file.data?.content ?? ''}
        onSelection={updateSelection}
      />
    </main>
  );
}

function SelectionBridge({
  editor,
  value,
  onSelection,
}: {
  editor?: MonacoEditor.IStandaloneCodeEditor;
  value: string;
  onSelection: (value?: SourceSelection) => void;
}) {
  useEffect(() => {
    if (!editor) return;
    const editorNode = editor.getDomNode();
    let mouseSelecting = false,
      hasPendingSelection = false;
    let pendingSelection: SourceSelection | undefined;
    const beginMouseSelection = (event: MouseEvent) => {
      if (event.button !== 0) return;
      mouseSelecting = true;
      hasPendingSelection = false;
      pendingSelection = undefined;
    };
    const finishMouseSelection = () => {
      if (!mouseSelecting) return;
      mouseSelecting = false;
      if (hasPendingSelection) onSelection(pendingSelection);
      hasPendingSelection = false;
      pendingSelection = undefined;
    };
    const disposable = editor.onDidChangeCursorSelection((event) => {
      const model = editor.getModel(),
        range = event.selection as Range;
      let next: SourceSelection | undefined;
      if (model && !range.isEmpty()) {
        const start = model.getOffsetAt(range.getStartPosition()),
          end = model.getOffsetAt(range.getEndPosition());
        next = {
          start,
          end,
          selectedText: value.slice(start, end),
          startPosition: { line: range.startLineNumber, column: range.startColumn },
          endPosition: { line: range.endLineNumber, column: range.endColumn },
        };
      }
      if (mouseSelecting) {
        pendingSelection = next;
        hasPendingSelection = true;
      } else onSelection(next);
    });
    editorNode?.addEventListener('mousedown', beginMouseSelection, true);
    window.addEventListener('mouseup', finishMouseSelection, true);
    return () => {
      disposable.dispose();
      editorNode?.removeEventListener('mousedown', beginMouseSelection, true);
      window.removeEventListener('mouseup', finishMouseSelection, true);
    };
  }, [editor, value, onSelection]);
  return null;
}
