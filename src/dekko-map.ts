import spawn from 'cross-spawn';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { lstat, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';

export const DEKKO_MAP_RELATIVE_PATH = '.dekko/map.json';

const activeMapJobs = new Map();

async function ensureScanBoundary(root) {
  const gitPath = path.join(root, '.git');
  try {
    await lstat(gitPath);
    return;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  // Parent repositories commonly ignore `.codewalk/`. Without a local Git
  // boundary Dekko inherits that rule and treats every snapshot file as ignored.
  await mkdir(path.join(gitPath, 'refs', 'heads'), { recursive: true });
  await mkdir(path.join(gitPath, 'objects'), { recursive: true });
  await writeFile(path.join(gitPath, 'HEAD'), 'ref: refs/heads/main\n');
  await writeFile(
    path.join(gitPath, 'config'),
    '[core]\nrepositoryformatversion = 0\nbare = false\n',
  );
  await writeFile(
    path.join(gitPath, 'codewalk-dekko-boundary'),
    'Synthetic boundary for an immutable CodeWalk snapshot.\n',
  );
}

function abortReason(signal) {
  return signal?.reason instanceof Error ? signal.reason : new Error('代码图谱生成已取消');
}

function collectOutput(stream, limit = 64 * 1024) {
  let value = '';
  stream?.setEncoding('utf8');
  stream?.on('data', (chunk) => {
    if (value.length < limit) value += chunk.slice(0, limit - value.length);
  });
  return () => value.trim();
}

function runDekkoMap({ root, command, signal, timeoutMs }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortReason(signal));
    const child = spawn(command, ['map', root, '--if-stale', '--quiet'], {
      cwd: root,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout = collectOutput(child.stdout),
      stderr = collectOutput(child.stderr);
    let terminalError,
      forceKill,
      settled = false;
    const cleanup = () => {
      clearTimeout(timeout);
      clearTimeout(forceKill);
      signal?.removeEventListener('abort', abort);
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      error ? reject(error) : resolve();
    };
    const terminate = (error) => {
      terminalError ??= error;
      if (child.exitCode === null && process.platform === 'win32' && child.pid) {
        // .cmd launchers own a child process; terminate the tree so pipes close too.
        const killed = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
          timeout: 5000,
        });
        if (killed.error || killed.status !== 0) child.kill('SIGTERM');
      } else if (child.exitCode === null) child.kill('SIGTERM');
      forceKill ??= setTimeout(() => {
        child.kill('SIGKILL');
        // A broken launcher may leave a descendant holding the inherited pipes open.
        // Do not let that prevent the bounded operation from returning its real error.
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(terminalError);
      }, 2000);
      forceKill.unref?.();
    };
    const timeout = setTimeout(() => {
      terminate(new Error(`Dekko 生成代码图谱超过 ${timeoutMs}ms`));
    }, timeoutMs);
    timeout.unref?.();
    const abort = () => terminate(abortReason(signal));
    signal?.addEventListener('abort', abort, { once: true });
    child.once('error', (error) => {
      terminalError =
        error.code === 'ENOENT'
          ? new Error(`找不到 Dekko 可执行文件：${command}`)
          : new Error(`无法启动 Dekko：${error.message}`);
      finish(terminalError);
    });
    child.once('close', (code) => {
      if (terminalError) return finish(terminalError);
      if (code !== 0) {
        const detail = stderr() || stdout();
        return finish(
          new Error(`Dekko 生成代码图谱失败（退出码 ${code}）${detail ? `：${detail}` : ''}`),
        );
      }
      finish();
    });
  });
}

async function mapStamp(file) {
  try {
    const info = await stat(file);
    return { mtimeMs: info.mtimeMs, size: info.size };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function generateAndValidate({ root, command, signal, timeoutMs }) {
  const mapPath = path.join(root, DEKKO_MAP_RELATIVE_PATH);
  const before = await mapStamp(mapPath);
  await runDekkoMap({ root, command, signal, timeoutMs });
  const raw = await readFile(mapPath, 'utf8').catch((error) => {
    if (error.code === 'ENOENT')
      throw new Error(`Dekko 执行成功但没有生成 ${DEKKO_MAP_RELATIVE_PATH}`);
    throw error;
  });
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Dekko 生成的 ${DEKKO_MAP_RELATIVE_PATH} 不是有效 JSON`);
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    parsed.generator !== 'dekko' ||
    !Number.isInteger(parsed.version) ||
    !Array.isArray(parsed.files) ||
    !Array.isArray(parsed.symbols) ||
    !Array.isArray(parsed.edges)
  ) {
    throw new Error(`Dekko 生成的 ${DEKKO_MAP_RELATIVE_PATH} 结构无效`);
  }
  const after = await mapStamp(mapPath);
  const reused = Boolean(before && before.mtimeMs === after.mtimeMs && before.size === after.size);
  return {
    schemaVersion: 1,
    status: 'ready',
    root,
    path: mapPath,
    relativePath: DEKKO_MAP_RELATIVE_PATH,
    bytes: after.size,
    updatedAt: after.mtimeMs,
    reused,
  };
}

export async function ensureDekkoMap({
  root,
  signal,
  timeoutMs = 180000,
  command = process.env.CODEWALK_DEKKO_COMMAND?.trim() || 'dekko',
}) {
  const resolvedRoot = await realpath(root);
  const rootInfo = await stat(resolvedRoot);
  if (!rootInfo.isDirectory()) throw new Error('Dekko 代码图谱目标必须是目录');
  await ensureScanBoundary(resolvedRoot);
  const existing = activeMapJobs.get(resolvedRoot);
  if (existing) return existing;
  const job = generateAndValidate({ root: resolvedRoot, command, signal, timeoutMs });
  activeMapJobs.set(resolvedRoot, job);
  try {
    return await job;
  } finally {
    if (activeMapJobs.get(resolvedRoot) === job) activeMapJobs.delete(resolvedRoot);
  }
}
