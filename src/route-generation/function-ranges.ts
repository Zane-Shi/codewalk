import { parse } from '@babel/parser';

const FUNCTION_KINDS = /function|method|constructor|procedure/i;
const JS_TS_EXTENSIONS = /\.[cm]?[jt]sx?$/i;
const CALLABLE_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'ObjectMethod',
  'ClassMethod',
  'ClassPrivateMethod',
]);
const parsedFiles = new WeakMap();

function parsedFunctions(file, lines) {
  if (!parsedFiles.has(lines)) parsedFiles.set(lines, sourceFunctions(file, lines.join('\n')));
  return parsedFiles.get(lines);
}

function nodeName(node) {
  if (node?.type === 'Identifier') return node.name;
  if (node?.type === 'StringLiteral') return node.value;
  if (node?.type === 'PrivateName') return nodeName(node.id);
  return undefined;
}

function declaredName(node, parent) {
  if (node.key) return nodeName(node.key);
  if (node.id) return nodeName(node.id);
  if (parent?.type === 'VariableDeclarator') return nodeName(parent.id);
  if (
    parent?.type === 'ObjectProperty' ||
    parent?.type === 'ClassProperty' ||
    parent?.type === 'ClassPrivateProperty'
  )
    return nodeName(parent.key);
  return undefined;
}

function directCallsAndLoops(body) {
  const calls = [];
  let hasLoop = false;
  const visit = (node, nested = false) => {
    if (!node || typeof node !== 'object' || !node.type) return;
    if (nested && CALLABLE_TYPES.has(node.type)) return;
    if (['WhileStatement', 'DoWhileStatement'].includes(node.type)) hasLoop = true;
    if (
      ['CallExpression', 'OptionalCallExpression'].includes(node.type) &&
      node.callee?.type === 'Identifier' &&
      node.loc
    )
      calls.push({ callee: node.callee.name, call_line: node.loc.start.line });
    for (const [key, value] of Object.entries(node)) {
      if (['loc', 'comments', 'tokens', 'errors'].includes(key)) continue;
      if (Array.isArray(value)) value.forEach((child) => visit(child, true));
      else if (value?.type) visit(value, true);
    }
  };
  visit(body);
  return { calls, hasLoop };
}

function sourceFunctions(file, content) {
  const typescript = /\.[cm]?tsx?$/i.test(file);
  const jsx = /\.[jt]sx$/i.test(file);
  let ast;
  try {
    ast = parse(content, {
      sourceType: 'unambiguous',
      plugins: [...(typescript ? ['typescript'] : []), ...(jsx ? ['jsx'] : []), 'decorators'],
    });
  } catch {
    return [];
  }
  const found = [];
  const visit = (node, parent) => {
    if (!node || typeof node !== 'object' || !node.type) return;
    if (CALLABLE_TYPES.has(node.type) && node.body && node.loc) {
      const { calls, hasLoop } = directCallsAndLoops(node.body);
      found.push({
        name: declaredName(node, parent),
        start_line: node.loc.start.line,
        end_line: node.loc.end.line,
        calls,
        hasLoop,
        split_boundary_lines:
          node.body.type === 'BlockStatement'
            ? node.body.body.slice(1).map((statement) => statement.loc.start.line)
            : [],
      });
    }
    for (const [key, value] of Object.entries(node)) {
      if (['loc', 'comments', 'tokens', 'errors'].includes(key)) continue;
      if (Array.isArray(value)) value.forEach((child) => visit(child, node));
      else if (value?.type) visit(value, node);
    }
  };
  visit(ast.program, null);
  return found;
}

function graphFunctions({ file, lines, sourceGraph }) {
  const fileIndex = sourceGraph?.files?.findIndex((item) => item[0] === file) ?? -1;
  if (fileIndex < 0 || !Array.isArray(sourceGraph?.entities)) return [];
  return sourceGraph.entities
    .filter(
      (item) =>
        item[0] === 'symbol' &&
        item[4] === fileIndex &&
        FUNCTION_KINDS.test(item[3] ?? '') &&
        Number.isInteger(item[5]) &&
        Number.isInteger(item[6]) &&
        item[5] >= 1 &&
        item[6] >= item[5] &&
        item[6] <= lines.length,
    )
    .map((item) => ({
      entity_id: item[1],
      name: item[2],
      kind: item[3],
      start_line: item[5],
      end_line: item[6],
    }));
}

function availableFunctions({ file, lines, sourceGraph }) {
  return JS_TS_EXTENSIONS.test(file)
    ? parsedFunctions(file, lines).map((item) => ({ ...item, kind: 'function' }))
    : graphFunctions({ file, lines, sourceGraph });
}

/** Surface direct calls into same-file functions that own a while loop. */
export function findLocalLoopCallees({ file, lines, entry_line, symbol }) {
  if (!JS_TS_EXTENSIONS.test(file)) return [];
  const functions = parsedFunctions(file, lines);
  const callers = functions.filter(
    (item) => item.start_line === entry_line && (!symbol || item.name === symbol.split('.').at(-1)),
  );
  if (callers.length !== 1) return [];
  const targets = functions.filter((item) => item.name && item.hasLoop);
  return callers[0].calls.flatMap((call) => {
    const matches = targets.filter((item) => item.name === call.callee);
    const target = matches.length === 1 ? matches[0] : null;
    return target && target.start_line !== callers[0].start_line
      ? [{ ...call, target_entry_line: target.start_line }]
      : [];
  });
}

/** Resolve a submitted declaration line to a complete function, without accepting guessed ranges. */
export function findFunctionRange({ file, lines, entry_line, symbol, sourceGraph }) {
  if (!Number.isInteger(entry_line) || entry_line < 1 || entry_line > lines.length) return null;
  const name = symbol?.split('.').at(-1);
  if (JS_TS_EXTENSIONS.test(file)) {
    const atEntry = parsedFunctions(file, lines).filter((item) => item.start_line === entry_line);
    if (atEntry.length === 1) return atEntry[0];
    const matches = atEntry.filter((item) => !name || item.name === name);
    return matches.length === 1 ? matches[0] : null;
  }
  const fileIndex = sourceGraph?.files?.findIndex((item) => item[0] === file) ?? -1;
  if (fileIndex < 0) return null;
  const atEntry = sourceGraph.entities.filter(
    (item) =>
      item[0] === 'symbol' &&
      item[4] === fileIndex &&
      FUNCTION_KINDS.test(item[3] ?? '') &&
      item[5] === entry_line &&
      item[6] <= lines.length,
  );
  if (atEntry.length === 1)
    return { name: atEntry[0][2], start_line: atEntry[0][5], end_line: atEntry[0][6] };
  const matches = atEntry.filter((item) => !name || item[2] === name);
  return matches.length === 1
    ? { name: matches[0][2], start_line: matches[0][5], end_line: matches[0][6] }
    : null;
}

/**
 * Resolve any line inside a function to the complete function owned by the
 * immutable source snapshot. A symbol hint selects an enclosing outer
 * function; otherwise the narrowest enclosing function wins for nested code.
 */
export function findContainingFunction({ file, lines, anchor_line, symbol, sourceGraph }) {
  if (!Number.isInteger(anchor_line) || anchor_line < 1 || anchor_line > lines.length) return null;
  const name = symbol?.split('.').at(-1);
  let containing = availableFunctions({ file, lines, sourceGraph }).filter(
    (item) => item.start_line <= anchor_line && anchor_line <= item.end_line,
  );
  if (name) containing = containing.filter((item) => item.name === name);
  if (!containing.length) return null;
  containing.sort(
    (left, right) =>
      left.end_line - left.start_line - (right.end_line - right.start_line) ||
      right.start_line - left.start_line ||
      String(left.name ?? '').localeCompare(String(right.name ?? '')),
  );
  const best = containing[0],
    sameRange = containing.filter(
      (item) => item.start_line === best.start_line && item.end_line === best.end_line,
    );
  return sameRange.length === 1 ? best : null;
}

export function nearbyFunctionEntries({ file, lines, entry_line, symbol, sourceGraph }) {
  if (!Number.isInteger(entry_line)) return [];
  const name = symbol?.split('.').at(-1);
  const functions = availableFunctions({ file, lines, sourceGraph });
  const named = functions.filter((item) => !name || item.name === name);
  const nearby = named.filter(
    (item) =>
      Math.abs(item.start_line - entry_line) <= 12 ||
      (item.start_line < entry_line && entry_line <= item.end_line),
  );
  const candidates = nearby.length ? nearby : name && named.length <= 4 ? named : [];
  return [...new Set(candidates.map((item) => item.start_line))].slice(0, 4);
}
