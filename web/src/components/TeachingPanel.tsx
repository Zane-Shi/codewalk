import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import type { BlockTeachingContent, RouteBlock, RouteDelivery, SourceLocation } from '../types';

const relationLabels = {
  calls: '调用进入',
  returns: '返回',
  continues: '继续执行',
  handoff: '运行时交接',
  custom: '特殊交接',
  callback: '回调进入',
} as const;

export function TeachingPanel({
  route,
  activeModuleId,
  activeBlockId,
  onOpenBlock,
  onNavigate,
}: {
  route?: RouteDelivery;
  activeModuleId?: string;
  activeBlockId?: string;
  onOpenBlock: (moduleId: string, block: RouteBlock) => void;
  onNavigate: (location: SourceLocation) => void;
}) {
  const blocks = useMemo(
    () =>
      route?.modules.flatMap((module) => module.blocks.map((block) => ({ module, block }))) ?? [],
    [route],
  );
  const currentIndex = blocks.findIndex((item) => item.block.id === activeBlockId);
  const current =
    currentIndex >= 0
      ? blocks[currentIndex]
      : (blocks.find((item) => item.module.id === activeModuleId) ?? blocks[0]);
  const module = current?.module;
  const block = current?.block;
  const content = useQuery({
    queryKey: ['route-block', route?.id, block?.id],
    queryFn: () =>
      api<BlockTeachingContent>(
        `/api/routes/${encodeURIComponent(route!.id)}/blocks/${encodeURIComponent(block!.id)}`,
      ),
    enabled: Boolean(route && block && block.content_status === 'ready'),
  });
  const relations =
    route?.relations.filter(
      (relation) => relation.from_block_id === block?.id || relation.to_block_id === block?.id,
    ) ?? [];
  const navigateRange = (startLine: number, endLine: number, title: string, reason: string) => {
    if (!block) return;
    onNavigate({
      filePath: block.source.location.file,
      startLine,
      endLine,
      origin: 'route',
      originId: block.id,
      title,
      reason,
    });
  };

  if (!route || !module || !block)
    return (
      <section className="teaching-panel teaching-empty">
        <strong>带读讲解</strong>
        <p>
          从左侧选择一条路线和一个代码块，这里会说明为什么此刻要读它，以及关键代码如何推动当前场景。
        </p>
      </section>
    );

  const explanation = content.data?.explanation;
  return (
    <section className="teaching-panel">
      <div className="teaching-scroll">
        <header className="module-brief">
          <small>
            模块 {module.order} / {route.modules.length}
          </small>
          <h2>{module.title}</h2>
          <p>{module.narrative.summary}</p>
          <dl>
            <div>
              <dt>进入时</dt>
              <dd>{module.narrative.expected_input}</dd>
            </div>
            <div>
              <dt>离开时</dt>
              <dd>{module.narrative.expected_outcome}</dd>
            </div>
          </dl>
        </header>
        <article className="block-lesson">
          <div className="lesson-kicker">
            代码块 {block.route_order} / {blocks.length}
          </div>
          <h3>{block.title}</h3>
          <button
            className="source-jump"
            onClick={() =>
              navigateRange(
                block.source.location.start.line,
                block.source.location.end.line,
                block.title,
                block.narrative.why_read,
              )
            }
          >
            {block.source.location.file}:L{block.source.location.start.line}–
            {block.source.location.end.line}
          </button>
          <p className="lesson-summary">{explanation?.summary ?? block.narrative.summary}</p>
          <section className="why-read">
            <strong>为什么现在读</strong>
            <p>{explanation?.why_read ?? block.narrative.why_read}</p>
          </section>

          {content.isLoading && <p className="teaching-status">正在读取已保存的讲解…</p>}
          {content.error && <p className="route-error">{content.error.message}</p>}
          {explanation?.walkthrough?.length ? (
            <section className="walkthrough">
              <h4>沿代码往下读</h4>
              <ol>
                {explanation.walkthrough.map((section, index) => (
                  <li key={`${section.start_line}-${section.end_line}-${index}`}>
                    <button
                      onClick={() =>
                        navigateRange(
                          section.start_line,
                          section.end_line,
                          section.title,
                          section.explanation,
                        )
                      }
                    >
                      <span>
                        L{section.start_line}
                        {section.end_line !== section.start_line && `–${section.end_line}`}
                      </span>
                      <strong>{section.title}</strong>
                    </button>
                    <p>{section.explanation}</p>
                  </li>
                ))}
              </ol>
            </section>
          ) : null}

          {relations.length > 0 && (
            <section className="handoffs">
              <h4>控制权如何交接</h4>
              {relations.map((relation) => {
                const outgoing = relation.from_block_id === block.id;
                const peer = blocks.find(
                  (item) =>
                    item.block.id === (outgoing ? relation.to_block_id : relation.from_block_id),
                );
                const evidence = [
                  { label: '来源证据', site: relation.source_site },
                  { label: '目标证据', site: relation.target_site },
                ].filter((item) => item.site);
                return (
                  <div className="handoff-card" key={relation.id}>
                    <button onClick={() => peer && onOpenBlock(peer.module.id, peer.block)}>
                      <span>
                        {outgoing
                          ? relationLabels[relation.type]
                          : `来自上一处的${relationLabels[relation.type]}`}
                        {relation.custom_relation ? ` · ${relation.custom_relation}` : ''}
                      </span>
                      <strong>{peer?.block.title ?? '相关实现'}</strong>
                      <small>{relation.explanation}</small>
                    </button>
                    {evidence.length > 0 && (
                      <div className="handoff-evidence">
                        {evidence.map(({ label, site }) => (
                          <button
                            key={label}
                            onClick={() =>
                              onNavigate({
                                filePath: site!.location.file,
                                startLine: site!.location.start.line,
                                endLine: site!.location.end.line,
                                origin: 'route',
                                originId: relation.id,
                                title: `${label}：${relationLabels[relation.type]}`,
                                reason: relation.explanation,
                              })
                            }
                          >
                            {label} · {site!.location.file}:L{site!.location.start.line}
                            {site!.location.end.line !== site!.location.start.line &&
                              `–${site!.location.end.line}`}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </section>
          )}

          {explanation?.skip_guidance?.length ? (
            <details className="skip-guidance">
              <summary>这次可以先跳过</summary>
              {explanation.skip_guidance.map((item) => (
                <p key={`${item.start_line}-${item.end_line}`}>
                  L{item.start_line}–{item.end_line}：{item.reason}
                </p>
              ))}
            </details>
          ) : null}
          {explanation?.pseudocode && (
            <details className="pseudocode">
              <summary>查看流程伪代码</summary>
              <pre>{explanation.pseudocode}</pre>
            </details>
          )}
          <section className="takeaways">
            <h4>读完记住</h4>
            <ul>
              {(explanation?.takeaways ?? block.narrative.takeaways).map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </section>
        </article>
      </div>
      <footer className="lesson-navigation">
        <button
          disabled={currentIndex <= 0}
          onClick={() => {
            const previous = blocks[currentIndex - 1];
            if (previous) onOpenBlock(previous.module.id, previous.block);
          }}
        >
          上一块
        </button>
        <span>
          {currentIndex + 1} / {blocks.length}
        </span>
        <button
          disabled={currentIndex < 0 || currentIndex >= blocks.length - 1}
          onClick={() => {
            const next = blocks[currentIndex + 1];
            if (next) onOpenBlock(next.module.id, next.block);
          }}
        >
          下一块
        </button>
      </footer>
    </section>
  );
}
