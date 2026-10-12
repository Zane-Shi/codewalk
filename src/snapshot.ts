import { readdir, readFile, writeFile, mkdir, realpath, rm, lstat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

const excluded = new Set([
  '.git',
  '.dekko',
  'node_modules',
  '.codewalk',
  '.pi',
  '.codex',
  '.ssh',
  'dist',
  'build',
  '.venv',
  '__pycache__',
]);

// Persist source references with the same separators used by the browser and graph.
export function relativeSourcePath(root, target) {
  return path.relative(root, target).split(path.sep).join('/');
}

export async function safePath(root, input = '.') {
  if (typeof input !== 'string') throw new Error('路径必须是字符串');
  const base = await realpath(root);
  const target = await realpath(path.resolve(base, input));
  const relative = path.relative(base, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error('路径超出当前源码快照');
  return target;
}

export async function importSnapshot(source, dataDir) {
  const root = await realpath(source);
  const id = randomUUID();
  const destination = path.join(dataDir, 'snapshots', id);
  await mkdir(destination, { recursive: true });
  const files = [],
    skipped = [];
  let bytes = 0,
    visited = 0;
  const hash = createHash('sha256');
  async function walk(relative, depth = 0) {
    if (depth > 25) throw new Error('目录层级超过 25，请选择更小范围');
    const entries = await readdir(path.join(root, relative), { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (++visited > 10000) throw new Error('目录项过多，请选择项目子目录');
      const item = path.join(relative, entry.name);
      const absoluteItem = path.join(root, item);
      if (absoluteItem === path.resolve(dataDir)) {
        skipped.push(item);
        continue;
      }
      if (
        excluded.has(entry.name) ||
        entry.name.startsWith('.env') ||
        /\.(pem|key)$/i.test(entry.name) ||
        entry.isSymbolicLink()
      ) {
        skipped.push(item);
        continue;
      }
      if (entry.isDirectory()) {
        await walk(item, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const info = await lstat(absoluteItem);
      if (!info.isFile() || info.size > 512 * 1024) {
        skipped.push(item);
        continue;
      }
      const content = await readFile(path.join(root, item));
      if (content.length > 512 * 1024 || content.includes(0)) {
        skipped.push(item);
        continue;
      }
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(content);
      } catch {
        skipped.push(item);
        continue;
      }
      bytes += content.length;
      if (bytes > 32 * 1024 * 1024 || files.length >= 4000)
        throw new Error('源码超过 32MB 或 4000 个文件，请选择更小目录');
      await mkdir(path.dirname(path.join(destination, item)), { recursive: true });
      await writeFile(path.join(destination, item), content, { mode: 0o444 });
      hash.update(item).update('\0').update(content).update('\0');
      files.push(item.split(path.sep).join('/'));
    }
  }
  try {
    await walk('');
    if (!files.length) throw new Error('没有可读取的文本文件');
    return {
      id,
      name: path.basename(root),
      root: destination,
      files,
      skipped,
      bytes,
      version: hash.digest('hex'),
      createdAt: Date.now(),
    };
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}

export async function sourceFile(snapshot, file) {
  if (!snapshot.files.includes(file)) throw new Error('文件不在快照清单中');
  const content = (await readFile(await safePath(snapshot.root, file), 'utf8')).replace(
    /\r\n/g,
    '\n',
  );
  return { content, lines: content.split('\n').length };
}

// Browser textarea and JS strings both use UTF-16 offsets; end is exclusive.
export function anchorSelection(content, start, end, selectedText, maxLength = 16000) {
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end <= start ||
    end > content.length ||
    end - start > maxLength
  )
    throw new Error(`请选择 1–${maxLength} 个字符的有效源码`);
  const text = content.slice(start, end);
  if (text !== selectedText) throw new Error('选区与源码快照不一致，请重新选择');
  function position(offset) {
    const before = content.slice(0, offset);
    return { line: before.split('\n').length, column: offset - before.lastIndexOf('\n') };
  }
  return { start, end, startPosition: position(start), endPosition: position(end), text };
}
