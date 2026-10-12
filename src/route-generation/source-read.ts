/** Add locations only to the exact source prefix returned by Pi, preserving truncation notices. */
export function numberSourceRead(result, source, offset, limit) {
  const text = result.content?.[0];
  if (text?.type !== 'text' || result.content.some((item) => item.type === 'image')) return result;
  const truncation = result.details?.truncation;
  if (truncation?.firstLineExceedsLimit) return result;
  const lines = source.split('\n').slice(offset - 1, offset - 1 + limit);
  if (truncation?.truncated) lines.length = Math.min(lines.length, truncation.outputLines);
  const prefix = lines.join('\n');
  if (!prefix || !text.text.startsWith(prefix)) return result;
  const numbered = lines.map((line, index) => `${offset + index}: ${line}`).join('\n');
  return {
    ...result,
    content: [
      { ...text, text: numbered + text.text.slice(prefix.length) },
      ...result.content.slice(1),
    ],
  };
}
