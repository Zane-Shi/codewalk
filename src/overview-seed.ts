import path from 'node:path';

const IMPORTANT_BASENAMES = new Set([
  'main',
  'index',
  'cli',
  'server',
  'app',
  'entry',
  'bootstrap',
]);
const SUPPORT_SEGMENTS = new Set([
  'test',
  'tests',
  '__tests__',
  'benchmark',
  'benchmarks',
  'fixtures',
  'examples',
  'docs',
  'scripts',
]);

function countCollection(value) {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') return Object.keys(value).length;
  return 0;
}

function decode(reference, ids) {
  return Number.isInteger(reference) ? ids[reference] : reference;
}

const sourcePath = (value) => (typeof value === 'string' ? value.replaceAll('\\', '/') : value);

function directories(files) {
  const result = new Set();
  for (const file of files) {
    let current = path.posix.dirname(file);
    while (current !== '.') {
      result.add(current);
      current = path.posix.dirname(current);
    }
  }
  return result;
}

function packageRoots(files) {
  const candidates = files
    .filter((file) => file === 'package.json' || file.endsWith('/package.json'))
    .map((file) => (file === 'package.json' ? '.' : path.posix.dirname(file)));
  const all = new Set(candidates);
  return candidates
    .filter((packagePath) => {
      if (packagePath === '.') return true;
      const segments = packagePath.split('/');
      if (segments.some((segment) => SUPPORT_SEGMENTS.has(segment))) return false;
      if (segments.length === 1) return true;
      const parent = segments.slice(0, -1).join('/');
      return segments.length <= 2 && !all.has(parent);
    })
    .sort((left, right) => left.localeCompare(right));
}

function sourceAreas(files, dirs, packages) {
  const required = new Set(),
    detailed = new Set();
  if (packages.length) {
    for (const packagePath of packages) {
      if (packagePath !== '.') required.add(packagePath);
      const sourceRoot = packagePath === '.' ? 'src' : `${packagePath}/src`;
      if (!dirs.has(sourceRoot)) continue;
      required.add(sourceRoot);
      for (const file of files) {
        if (!file.startsWith(`${sourceRoot}/`)) continue;
        const rest = file.slice(sourceRoot.length + 1);
        if (rest.includes('/')) detailed.add(`${sourceRoot}/${rest.split('/')[0]}`);
      }
    }
  } else {
    for (const file of files) {
      if (file.includes('/')) required.add(file.split('/')[0]);
    }
    if (dirs.has('src')) {
      required.add('src');
      for (const file of files) {
        if (!file.startsWith('src/')) continue;
        const rest = file.slice(4);
        if (rest.includes('/')) detailed.add(`src/${rest.split('/')[0]}`);
      }
    }
  }
  return {
    required: [...required].filter((area) => dirs.has(area)),
    detailed: [...detailed].filter((area) => dirs.has(area)),
  };
}

function belongsTo(file, area) {
  return file === area || file.startsWith(`${area}/`);
}

function ownerOf(file, areas) {
  return areas
    .filter((area) => belongsTo(file, area))
    .sort((left, right) => right.length - left.length)[0];
}

function isSupportFile(file) {
  const segments = file.toLowerCase().split('/');
  const basename = path.posix.basename(file).toLowerCase();
  return (
    segments.some((segment) => SUPPORT_SEGMENTS.has(segment)) ||
    /(?:^|\.)(?:test|spec|bench)\.[^.]+$/.test(basename) ||
    /(?:^|\.)config\.[^.]+$/.test(basename)
  );
}

function candidateScore(file, metrics) {
  const basename = path.posix.basename(file, path.posix.extname(file)).toLowerCase();
  const entry = IMPORTANT_BASENAMES.has(basename) ? 24 : 0;
  const supportPenalty = isSupportFile(file) ? 80 : 0;
  return (
    entry +
    Math.min(metrics.exports * 3, 18) +
    Math.min(metrics.incomingImports * 2, 16) +
    Math.min(metrics.outgoingImports, 10) +
    Math.min(metrics.incomingCalls, 12) +
    Math.min(metrics.outgoingCalls, 10) -
    supportPenalty
  );
}

function topCandidates(files, fileMetrics, limit, entryOnly = false) {
  return files
    .map((file) => ({ file, score: candidateScore(file, fileMetrics.get(file)) }))
    .filter((item) => !isSupportFile(item.file))
    .filter(
      (item) =>
        !entryOnly ||
        IMPORTANT_BASENAMES.has(
          path.posix.basename(item.file, path.posix.extname(item.file)).toLowerCase(),
        ),
    )
    .sort((left, right) => right.score - left.score || left.file.localeCompare(right.file))
    .slice(0, limit)
    .map((item) => item.file);
}

/**
 * Project Dekko's storage-oriented document into a compact, deterministic
 * project skeleton. It contains graph facts and candidates, never semantic
 * claims about what an area does.
 */
export function buildOverviewSeed(document, snapshot) {
  if (!document || document.generator !== 'dekko' || document.version !== 11)
    throw new Error('总览仅支持 Dekko map.json v11');
  if (
    !Array.isArray(document.files) ||
    !Array.isArray(document.symbols) ||
    !Array.isArray(document.ids) ||
    !Array.isArray(document.edges)
  ) {
    throw new Error('Dekko map.json 缺少总览所需字段');
  }
  // Dekko paths are source references, independent of the host's disk separators.
  document = {
    ...document,
    files: document.files.map((item) => ({ ...item, path: sourcePath(item.path) })),
    symbols: document.symbols.map((item) => ({ ...item, path: sourcePath(item.path) })),
  };
  const snapshotFiles = [...snapshot.files].sort(),
    snapshotSet = new Set(snapshotFiles);
  const mapFiles = document.files.map((item) => item.path).filter((file) => snapshotSet.has(file));
  const mapFileSet = new Set(mapFiles),
    dirs = directories(snapshotFiles),
    packages = packageRoots(snapshotFiles);
  const languageCounts = new Map();
  for (const item of document.files) {
    if (!mapFileSet.has(item.path)) continue;
    const language = item.language || 'unknown';
    languageCounts.set(language, (languageCounts.get(language) ?? 0) + 1);
  }

  const structural = sourceAreas(snapshotFiles, dirs, packages);
  const detailedCounts = structural.detailed
    .map((area) => ({ area, files: mapFiles.filter((file) => belongsTo(file, area)).length }))
    .sort((left, right) => right.files - left.files || left.area.localeCompare(right.area));
  const areas = [
    ...new Set([
      ...structural.required,
      ...detailedCounts
        .slice(0, Math.max(0, 80 - structural.required.length))
        .map((item) => item.area),
    ]),
  ].sort((left, right) => left.localeCompare(right));

  const fileMetrics = new Map(
    mapFiles.map((file) => [
      file,
      { exports: 0, incomingImports: 0, outgoingImports: 0, incomingCalls: 0, outgoingCalls: 0 },
    ]),
  );
  const symbolById = new Map();
  const exportedByArea = new Map(areas.map((area) => [area, []]));
  for (const symbol of document.symbols) {
    if (!mapFileSet.has(symbol.path)) continue;
    symbolById.set(symbol.id, symbol);
    if (symbol.exported === true && symbol.test !== true) {
      fileMetrics.get(symbol.path).exports++;
      const owner = ownerOf(symbol.path, areas);
      if (owner) exportedByArea.get(owner).push(symbol.name);
    }
  }

  const dependencyCounts = new Map();
  const addDependency = (fromFile, toFile, kind) => {
    if (!mapFileSet.has(fromFile) || !mapFileSet.has(toFile) || fromFile === toFile) return;
    const from = ownerOf(fromFile, areas),
      to = ownerOf(toFile, areas);
    if (!from || !to || from === to) return;
    const key = `${from}\0${to}`,
      current = dependencyCounts.get(key) ?? { from, to, importCount: 0, callCount: 0 };
    current[kind]++;
    dependencyCounts.set(key, current);
  };

  for (const edge of document.module_graph?.edges ?? []) {
    const importer = sourcePath(decode(edge.importer, document.ids)),
      imported = sourcePath(decode(edge.imported, document.ids));
    if (!mapFileSet.has(importer) || !mapFileSet.has(imported)) continue;
    fileMetrics.get(importer).outgoingImports++;
    fileMetrics.get(imported).incomingImports++;
    addDependency(importer, imported, 'importCount');
  }
  for (const edge of document.edges) {
    const caller = symbolById.get(decode(edge.caller, document.ids)),
      callee = symbolById.get(decode(edge.callee, document.ids));
    if (!caller || !callee) continue;
    fileMetrics.get(caller.path).outgoingCalls++;
    fileMetrics.get(callee.path).incomingCalls++;
    addDependency(caller.path, callee.path, 'callCount');
  }

  const areaRecords = areas.map((area) => {
    const ownedFiles = mapFiles.filter((file) => ownerOf(file, areas) === area);
    const sourceRoot = area === '.' ? 'src' : `${area}/src`;
    const candidateFiles = areas.includes(sourceRoot)
      ? mapFiles.filter((file) => belongsTo(file, area))
      : ownedFiles;
    return {
      path: area,
      fileCount: mapFiles.filter((file) => belongsTo(file, area)).length,
      exportedSymbols: [...new Set(exportedByArea.get(area))].sort().slice(0, 12),
      candidateEntryFiles: topCandidates(candidateFiles, fileMetrics, 5, true),
      candidateKeyFiles: topCandidates(candidateFiles, fileMetrics, 8),
    };
  });
  const packageForArea = (area) =>
    packages
      .filter(
        (packagePath) =>
          packagePath === '.' || area === packagePath || area.startsWith(`${packagePath}/`),
      )
      .sort((left, right) => right.length - left.length)[0];
  const sortedDependencies = [...dependencyCounts.values()].sort(
    (left, right) =>
      right.importCount + right.callCount - (left.importCount + left.callCount) ||
      left.from.localeCompare(right.from) ||
      left.to.localeCompare(right.to),
  );
  const crossPackage = sortedDependencies.filter(
    (edge) => packageForArea(edge.from) !== packageForArea(edge.to),
  );
  const dependencies = [
    ...crossPackage.slice(0, 40),
    ...sortedDependencies.filter((edge) => !crossPackage.includes(edge)).slice(0, 60),
  ];
  const parseFailures = document.files
    .filter((item) => item.error && snapshotSet.has(item.path))
    .map((item) => item.path)
    .sort();

  return {
    schemaVersion: 1,
    project: {
      name: snapshot.name,
      fileCount: snapshotFiles.length,
      mappedFileCount: mapFiles.length,
      languages: [...languageCounts]
        .map(([name, files]) => ({ name, files }))
        .sort((left, right) => right.files - left.files || left.name.localeCompare(right.name)),
    },
    packages: packages.map((packagePath) => ({
      path: packagePath,
      manifest: packagePath === '.' ? 'package.json' : `${packagePath}/package.json`,
      sourceRoots: areaRecords
        .filter((item) => item.path === (packagePath === '.' ? 'src' : `${packagePath}/src`))
        .map((item) => item.path),
      fileCount: mapFiles.filter((file) => packagePath === '.' || belongsTo(file, packagePath))
        .length,
      exportedSymbolCount: document.symbols.filter(
        (symbol) =>
          symbol.exported === true &&
          symbol.test !== true &&
          (packagePath === '.' || belongsTo(symbol.path, packagePath)),
      ).length,
    })),
    areas: areaRecords,
    dependencies,
    graphQuality: {
      parsedFiles: mapFiles.length - parseFailures.length,
      failedFiles: parseFailures,
      resolvedCalls: document.edges.length,
      ambiguousCalls: countCollection(document.ambiguous),
      externalCalls: countCollection(document.external),
    },
  };
}

export function overviewRelationSupported(seed, fromPaths, toPaths, kind) {
  if (!seed) return false;
  const covers = (area, selected) =>
    selected.some((value) => area === value || area.startsWith(`${value}/`));
  return seed.dependencies.some(
    (edge) =>
      covers(edge.from, fromPaths) &&
      covers(edge.to, toPaths) &&
      (kind === 'calls'
        ? edge.callCount > 0
        : kind === 'imports'
          ? edge.importCount > 0
          : edge.callCount + edge.importCount > 0),
  );
}
