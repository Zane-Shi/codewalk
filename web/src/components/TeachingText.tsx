import type { ReactNode } from 'react';

// Render the teaching Markdown subset as React text nodes; raw HTML is never executed.
function inline(text: string): ReactNode {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((part, index) => {
    if (part.startsWith('`') && part.endsWith('`'))
      return <code key={index}>{part.slice(1, -1)}</code>;
    if (part.startsWith('**') && part.endsWith('**'))
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    return part;
  });
}

export function TeachingText({ text }: { text: string }) {
  const lines = text.split(/\r?\n/),
    elements: ReactNode[] = [];
  let index = 0;
  while (index < lines.length) {
    if (!lines[index].trim()) {
      index++;
      continue;
    }
    if (/^\s*```/.test(lines[index])) {
      index++;
      const code: string[] = [];
      while (index < lines.length && !/^\s*```/.test(lines[index])) code.push(lines[index++]);
      index++;
      elements.push(
        <pre key={elements.length}>
          <code>{code.join('\n')}</code>
        </pre>,
      );
      continue;
    }
    const heading = lines[index].match(/^\s*#{1,6}\s+(.+)$/);
    if (heading) {
      elements.push(
        <p className="teaching-subheading" key={elements.length}>
          <strong>{inline(heading[1])}</strong>
        </p>,
      );
      index++;
      continue;
    }
    const listMatch = lines[index].match(/^\s*(?:([-*+])|\d+[.)])\s+(.+)$/);
    if (listMatch) {
      const ordered = !listMatch[1],
        items: ReactNode[] = [];
      while (index < lines.length) {
        const match = lines[index].match(/^\s*(?:([-*+])|\d+[.)])\s+(.+)$/);
        if (!match || Boolean(match[1]) === ordered) break;
        items.push(<li key={items.length}>{inline(match[2])}</li>);
        index++;
      }
      elements.push(
        ordered ? <ol key={elements.length}>{items}</ol> : <ul key={elements.length}>{items}</ul>,
      );
      continue;
    }
    const paragraph: string[] = [lines[index++]];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^\s*(?:```|#{1,6}\s|[-*+]\s|\d+[.)]\s)/.test(lines[index])
    )
      paragraph.push(lines[index++]);
    elements.push(<p key={elements.length}>{inline(paragraph.join('\n'))}</p>);
  }
  return <div className="teaching-text">{elements}</div>;
}
