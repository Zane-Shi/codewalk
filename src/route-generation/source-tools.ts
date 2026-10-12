import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { safePath } from '../snapshot.ts';
import { numberSourceRead } from './source-read.ts';

/** Builds read-only, snapshot-scoped source tools with deterministic usage limits. */
export function createBoundedSourceTools(snapshot, config, counters, signal, emit) {
  const root = snapshot.root;
  const originals = [
    createReadToolDefinition(root),
    createLsToolDefinition(root),
    createGrepToolDefinition(root),
    createFindToolDefinition(root),
  ];
  return originals.map((tool) => ({
    ...tool,
    executionMode: 'sequential',
    async execute(id, args, toolSignal, update, context) {
      signal?.throwIfAborted();
      if (++counters.calls > config.maxCalls)
        throw new Error(`本阶段调查工具超过 ${config.maxCalls} 次，请提交现有判断`);
      const target = await safePath(root, args.path ?? '.');
      const relative = path.relative(root, target).split(path.sep).join('/') || '.';
      const bounded = { ...args, path: target };
      if (tool.name === 'read') {
        if (++counters.reads > config.maxReads)
          throw new Error(`本阶段源码读取超过 ${config.maxReads} 次，请提交现有判断`);
        bounded.offset ??= 1;
        bounded.limit ??= 160;
        if (
          !Number.isInteger(bounded.offset) ||
          bounded.offset < 1 ||
          !Number.isInteger(bounded.limit) ||
          bounded.limit < 1 ||
          bounded.limit > 200
        )
          throw new Error('read.offset 或 read.limit 无效；每次最多 200 行');
      } else if (tool.name === 'grep') {
        bounded.limit ??= 60;
        bounded.context ??= 0;
        if (
          !Number.isInteger(bounded.limit) ||
          bounded.limit < 1 ||
          bounded.limit > 100 ||
          !Number.isInteger(bounded.context) ||
          bounded.context < 0 ||
          bounded.context > 3
        )
          throw new Error('grep 最多 100 条匹配和 3 行上下文');
      } else {
        bounded.limit ??= 100;
        if (!Number.isInteger(bounded.limit) || bounded.limit < 1 || bounded.limit > 200)
          throw new Error(`${tool.name} 最多返回 200 项`);
      }
      emit('tool', { tool: tool.name, path: relative, args: { ...bounded, path: relative } });
      const result = await tool.execute(id, bounded, toolSignal, update, context);
      return tool.name === 'read' && result.content.every((item) => item.type === 'text')
        ? numberSourceRead(result, await readFile(target, 'utf8'), bounded.offset, bounded.limit)
        : result;
    },
  }));
}
