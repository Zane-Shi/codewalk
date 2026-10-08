import type { StreamEvent } from './types';

export async function api<T>(route: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(route, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(data.error || '请求失败');
  return data;
}

export async function consumeSse(
  route: string,
  body: unknown,
  signal: AbortSignal,
  onEvent: (event: StreamEvent) => void,
) {
  const response = await fetch(route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok)
    throw new Error(((await response.json()) as { error?: string }).error || '请求失败');
  if (!response.body) throw new Error('服务器没有返回数据流');
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffer = '',
    terminal = false;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary: number;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const line = frame.split('\n').find((item) => item.startsWith('data: '));
      if (!line) continue;
      const event = JSON.parse(line.slice(6)) as StreamEvent;
      onEvent(event);
      if (
        event.type === 'complete' ||
        event.type === 'partial' ||
        event.type === 'failure' ||
        event.type === 'route_issue'
      )
        terminal = true;
    }
  }
  if (!terminal) throw new Error('连接中断，请重新打开查看任务状态');
}
