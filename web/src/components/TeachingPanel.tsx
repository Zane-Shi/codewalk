import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import type { BlockTeachingContent, RouteBlock, RouteDelivery, SourceLocation } from '../types';
import { TeachingText } from './TeachingText';

const relationLabels = {
  calls: '调用进入',
  returns: '返回',
  continues: '继续执行',
  handoff: '运行时交接',
  custom: '特殊交接',
  callback: '回调进入',
} as const;

function LessonIntro({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const canExpand = text.length > 160 || text.split('\n\n').length > 1;
  return (
    <div className="lesson-intro">
      <div id={id} className={canExpand && !expanded ? 'lesson-intro-preview' : undefined}>
        <TeachingText text={text} />
      </div>
      {canExpand && (
        <button
          className="teaching-text-toggle"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? '收起完整概述' : '展开完整概述'}
        </button>
      )}
    </div>
  );
}

function LessonWalkthrough({
  sections,
  onSelect,
}: {
  sections: BlockTeachingContent['explanation']['walkthrough'];
  onSelect: (startLine: number, endLine: number, title: string, reason: string) => void;
}) {
  const [active, setActive] = useState(0);
  const [allExpanded, setAllExpanded] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const id = useId();
  const headers = useRef<(HTMLButtonElement | null)[]>([]);
  const select = (index: number) => {
    const section = sections[index];
    if (!section) return;
    setActive(index);
    setCollapsed(false);
    onSelect(section.start_line, section.end_line, section.title, section.explanation);
    headers.current[index]?.scrollIntoView({ block: 'nearest' });
  };
  return (
    <section className="walkthrough">
      <div className="walkthrough-heading">
        <h4>沿代码往下读</h4>
        {sections.length > 1 && (
          <button
            className="teaching-text-toggle"
            aria-pressed={allExpanded}
            onClick={() => setAllExpanded(!allExpanded)}
          >
            {allExpanded ? '逐步阅读' : '展开全部'}
          </button>
        )}
      </div>
      <p className="reading-hint">一次看一步，点击步骤会同步定位源码。</p>
      {sections.length > 1 && (
        <nav className="reading-step-navigation" aria-label="讲解步骤">
          <button disabled={active === 0} onClick={() => select(active - 1)}>
            上一步
          </button>
          <span>
            步骤 {active + 1} / {sections.length}
          </span>
          <button disabled={active === sections.length - 1} onClick={() => select(active + 1)}>
            下一步
          </button>
        </nav>
      )}
      <ol>
        {sections.map((section, index) => {
          const expanded = allExpanded || (!collapsed && active === index);
          return (
            <li
              key={`${section.start_line}-${section.end_line}-${index}`}
              className={`reading-step${active === index ? ' is-current' : ''}`}
            >
              <button
                className="reading-step-heading"
                ref={(node) => {
                  headers.current[index] = node;
                }}
                aria-expanded={expanded}
                aria-controls={`${id}-${index}`}
                aria-current={active === index ? 'step' : undefined}
                onClick={() => {
                  if (!allExpanded && active === index && !collapsed) {
                    setCollapsed(true);
                  } else {
                    setAllExpanded(false);
                    select(index);
                  }
                }}
              >
                <span className="reading-step-number">{String(index + 1).padStart(2, '0')}</span>
                <span className="reading-step-title">
                  <strong>{section.title}</strong>
                  <small>
                    L{section.start_line}
                    {section.end_line !== section.start_line && `–${section.end_line}`}
                  </small>
                </span>
                <span className="reading-step-chevron" aria-hidden="true">
                  {expanded ? '−' : '+'}
                </span>
              </button>
              <div id={`${id}-${index}`} className="reading-step-body" hidden={!expanded}>
                <TeachingText text={section.explanation} />
                <button className="teaching-text-toggle" onClick={() => select(index)}>
                  在源码中定位
                </button>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

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
  const requestedIndex = blocks.findIndex((item) => item.block.id === activeBlockId);
  const current =
    requestedIndex >= 0
      ? blocks[requestedIndex]
      : (blocks.find((item) => item.module.id === activeModuleId) ?? blocks[0]);
  const currentIndex = current ? blocks.indexOf(current) : -1;
  const module = current?.module;
  const block = current?.block;
  const scroll = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scroll.current?.scrollTo({ top: 0 });
  }, [block?.id, route?.revision_id]);
  const content = useQuery({
    queryKey: ['route-block', route?.id, block?.id, route?.revision_id],
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
      <div className="teaching-scroll" ref={scroll}>
        <header className="module-brief">
          <small>
            模块 {module.order} / {route.modules.length}
          </small>
          <details className="module-background" key={`${module.id}:${route.revision_id}`}>
            <summary>
              <span>{module.title}</span>
              <small>了解这个模块</small>
            </summary>
            {module.teaching ? (
              <>
                <TeachingText text={module.teaching.overview} />
                <details className="teaching-extra">
                  <summary>这些代码如何一起工作</summary>
                  <TeachingText text={module.teaching.block_flow} />
                </details>
                {module.teaching.sections?.map((section, index) => (
                  <details className="teaching-extra" key={index}>
                    <summary>{section.title}</summary>
                    <TeachingText text={section.content} />
                    {section.related_block_ids?.map((id) => {
                      const target = module.blocks.find((item) => item.id === id);
                      return target ? (
                        <button key={id} onClick={() => onOpenBlock(module.id, target)}>
                          {target.title}
                        </button>
                      ) : null;
                    })}
                  </details>
                ))}
              </>
            ) : (
              <>
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
              </>
            )}
          </details>
        </header>
        <article className="block-lesson" key={`${block.id}:${route.revision_id}`}>
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
          <LessonIntro
            text={explanation?.overview ?? explanation?.summary ?? block.narrative.summary}
          />
          <details className="why-read">
            <summary>为什么现在读这段代码？</summary>
            <TeachingText text={explanation?.why_read ?? block.narrative.why_read} />
          </details>

          {content.isLoading && <p className="teaching-status">正在读取已保存的讲解…</p>}
          {content.error && <p className="route-error">{content.error.message}</p>}
          {explanation?.walkthrough?.length ? (
            <LessonWalkthrough sections={explanation.walkthrough} onSelect={navigateRange} />
          ) : null}

          {explanation?.sections?.length ? (
            <h4 className="lesson-extras-heading">想了解更多</h4>
          ) : null}
          {explanation?.sections?.map((section, index) => (
            <details className="teaching-extra" key={`${section.kind}-${index}`}>
              <summary>{section.title}</summary>
              <TeachingText text={section.content} />
              {section.source_ranges?.map((range, rangeIndex) => (
                <button
                  key={rangeIndex}
                  className="source-jump"
                  onClick={() =>
                    navigateRange(range.start_line, range.end_line, section.title, section.content)
                  }
                >
                  L{range.start_line}–{range.end_line}
                </button>
              ))}
            </details>
          ))}

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
          {(
            explanation?.overview
              ? explanation.takeaways?.length
              : (explanation?.takeaways ?? block.narrative.takeaways).length
          ) ? (
            <details className="takeaways">
              <summary>读完记住</summary>
              <ul>
                {(explanation?.takeaways ?? block.narrative.takeaways).map((item) => (
                  <li key={item}>
                    <TeachingText text={item} />
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
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
