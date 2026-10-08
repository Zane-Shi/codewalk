import path from 'node:path';
import { access, cp, mkdir, realpath, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Store } from './store.ts';
import { importSnapshot } from './snapshot.ts';
import { selectOverviewForSnapshot } from './overview-model.ts';

const MIGRATION_ID = 'legacy-project-storage-v1';

const withoutRoot = (snapshot) => {
  const { root, ...publicSnapshot } = snapshot;
  return publicSnapshot;
};

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function legacyRecords(filename) {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    return db
      .prepare('SELECT kind,id,body FROM records ORDER BY rowid')
      .all()
      .map((row) => ({ kind: row.kind, id: row.id, value: JSON.parse(row.body) }));
  } finally {
    db.close();
  }
}

function referencesAny(value, ids) {
  const text = JSON.stringify(value);
  return [...ids].some((id) => text.includes(id));
}

export function dedupeRouteSummaries(routes) {
  const unique = new Map();
  for (const route of routes.filter(Boolean)) {
    const key = [
      route.title,
      route.summary,
      route.goal?.scenario,
      route.goal?.observable_result,
      route.module_count,
      route.block_count,
    ].join('\0');
    const previous = unique.get(key);
    if (!previous || route.updated_at > previous.updated_at) unique.set(key, route);
  }
  return [...unique.values()].sort(
    (left, right) => left.created_at - right.created_at || left.id.localeCompare(right.id),
  );
}

/**
 * Owns the small global project catalogue and one physically isolated Store per
 * project. Source copies, graph files, routes and learning history never cross
 * project directories.
 */
export class ProjectRepository {
  static async open(dataDir) {
    const repository = new ProjectRepository(path.resolve(dataDir));
    await repository.initialize();
    return repository;
  }

  constructor(dataDir) {
    this.dataDir = dataDir;
    this.catalog = null;
    this.stores = new Map();
    this.composite = {
      list: (kind) => this.listRecords(kind),
      get: (kind, id) => this.getRecord(kind, id),
      put: (kind, value) => this.putRecord(kind, value),
      remove: (kind, id) => this.removeRecord(kind, id),
      message: (annotationId, role, text, taskId) => {
        const store = this.storeForRecord('annotation', annotationId);
        if (!store) throw new Error('批注所属项目不存在');
        return store.message(annotationId, role, text, taskId);
      },
      history: (id) =>
        this.listRecords('message')
          .filter((message) => message.annotationId === id)
          .reverse(),
    };
  }

  async initialize() {
    await mkdir(path.join(this.dataDir, 'projects'), { recursive: true });
    this.catalog = new Store(path.join(this.dataDir, 'catalog.sqlite'));
    if (!this.catalog.list('meta').some((item) => item.id === MIGRATION_ID))
      await this.migrateLegacy();
    for (const project of this.catalog.list('project')) this.openProjectStore(project.id);
  }

  projectDir(projectId) {
    return path.join(this.dataDir, 'projects', projectId);
  }

  openProjectStore(projectId) {
    if (!this.stores.has(projectId)) {
      const directory = this.projectDir(projectId);
      this.stores.set(projectId, new Store(path.join(directory, 'project.sqlite')));
    }
    return this.stores.get(projectId);
  }

  async migrateLegacy() {
    const legacyFile = path.join(this.dataDir, 'codewalk.sqlite');
    if (!(await exists(legacyFile))) {
      this.catalog.put('meta', { id: MIGRATION_ID, migratedAt: Date.now(), projects: 0 });
      return;
    }
    const records = legacyRecords(legacyFile);
    const snapshots = records
      .filter((record) => record.kind === 'snapshot')
      .map((record) => record.value);
    const groups = new Map();
    for (const snapshot of snapshots) {
      const key = `${snapshot.name}\0${snapshot.version}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(snapshot);
    }
    for (const groupedSnapshots of groups.values()) {
      const ordered = [...groupedSnapshots].sort((left, right) => right.createdAt - left.createdAt);
      const projectId = randomUUID(),
        now = Date.now(),
        directory = this.projectDir(projectId);
      await mkdir(path.join(directory, 'snapshots'), { recursive: true });
      const store = this.openProjectStore(projectId);
      const snapshotIds = new Set(ordered.map((snapshot) => snapshot.id));
      const ownedIds = new Set(snapshotIds);
      const selected = new Set();
      for (let pass = 0; pass < 5; pass++) {
        for (const record of records) {
          const key = `${record.kind}\0${record.id}`;
          if (selected.has(key) || record.kind === 'snapshot') continue;
          if (referencesAny(record.value, ownedIds)) {
            selected.add(key);
            ownedIds.add(record.id);
            if (record.value.route_id) ownedIds.add(record.value.route_id);
            if (record.value.routeId) ownedIds.add(record.value.routeId);
            if (record.value.ownerId) ownedIds.add(record.value.ownerId);
          }
        }
      }
      for (const snapshot of ordered) {
        const destination = path.join(directory, 'snapshots', snapshot.id);
        if ((await exists(snapshot.root)) && !(await exists(destination)))
          await cp(snapshot.root, destination, { recursive: true, errorOnExist: false });
        store.put('snapshot', { ...snapshot, projectId, root: destination });
      }
      for (const record of records)
        if (selected.has(`${record.kind}\0${record.id}`)) store.put(record.kind, record.value);
      this.catalog.put('project', {
        id: projectId,
        name: ordered[0].name,
        sourcePath: null,
        activeSnapshotId: ordered[0].id,
        snapshotIds: ordered.map((snapshot) => snapshot.id),
        createdAt: Math.min(...ordered.map((snapshot) => snapshot.createdAt)),
        updatedAt: now,
        lastOpenedAt: now,
        migratedFromLegacy: true,
      });
    }
    this.catalog.put('meta', { id: MIGRATION_ID, migratedAt: Date.now(), projects: groups.size });
  }

  storeForProject(projectId) {
    if (!this.catalog.list('project').some((project) => project.id === projectId))
      throw new Error('项目不存在');
    return this.openProjectStore(projectId);
  }

  projectForSnapshot(snapshotId) {
    return this.catalog.list('project').find((project) => project.snapshotIds.includes(snapshotId));
  }

  projectForRecord(kind, id) {
    if (kind === 'project')
      return this.catalog.list('project').find((project) => project.id === id);
    for (const project of this.catalog.list('project')) {
      try {
        this.openProjectStore(project.id).get(kind, id);
        return project;
      } catch {}
    }
    return undefined;
  }

  storeForRecord(kind, id) {
    const project = this.projectForRecord(kind, id);
    return project ? this.openProjectStore(project.id) : undefined;
  }

  getRecord(kind, id) {
    if (kind === 'project') return this.catalog.get(kind, id);
    const store = this.storeForRecord(kind, id);
    if (!store) throw new Error('记录不存在');
    return store.get(kind, id);
  }

  listRecords(kind) {
    if (kind === 'project') return this.catalog.list(kind);
    return this.catalog
      .list('project')
      .flatMap((project) => this.openProjectStore(project.id).list(kind));
  }

  inferProject(value) {
    const explicit = value?.projectId ?? value?.project_id;
    if (explicit) return this.catalog.list('project').find((project) => project.id === explicit);
    const snapshotId = value?.snapshotId ?? value?.snapshot_id ?? value?.overviewSnapshotId;
    if (snapshotId) return this.projectForSnapshot(snapshotId);
    const workspaceId = value?.workspaceId ?? value?.workspace_id;
    if (workspaceId)
      return (
        this.catalog.list('project').find((project) => project.id === workspaceId) ??
        this.projectForSnapshot(workspaceId)
      );
    for (const [kind, field] of [
      ['annotation', 'annotationId'],
      ['route', 'routeId'],
      ['route', 'route_id'],
    ]) {
      if (value?.[field]) return this.projectForRecord(kind, value[field]);
    }
    if (value?.ownerId) {
      for (const kind of ['route', 'annotation']) {
        const project = this.projectForRecord(kind, value.ownerId);
        if (project) return project;
      }
    }
    const projects = this.catalog.list('project');
    return projects.length === 1 ? projects[0] : undefined;
  }

  putRecord(kind, value) {
    if (kind === 'project') return this.catalog.put(kind, value);
    const existing = this.storeForRecord(kind, value.id);
    const project = existing ? undefined : this.inferProject(value);
    const store = existing ?? (project && this.openProjectStore(project.id));
    if (!store) throw new Error(`无法确定 ${kind} 记录所属项目`);
    return store.put(kind, value);
  }

  removeRecord(kind, id) {
    const store = this.storeForRecord(kind, id);
    if (store) store.remove(kind, id);
  }

  async importProject(source) {
    const sourcePath = await realpath(source);
    const name = path.basename(sourcePath);
    let project = this.catalog.list('project').find((item) => item.sourcePath === sourcePath);
    if (!project) {
      const unlinked = this.catalog
        .list('project')
        .filter((item) => !item.sourcePath && item.name === name);
      if (unlinked.length === 1) project = unlinked[0];
    }
    if (!project) {
      const now = Date.now();
      project = {
        id: randomUUID(),
        name,
        sourcePath,
        activeSnapshotId: null,
        snapshotIds: [],
        createdAt: now,
        updatedAt: now,
        lastOpenedAt: now,
      };
      await mkdir(this.projectDir(project.id), { recursive: true });
      this.openProjectStore(project.id);
    }
    const store = this.openProjectStore(project.id);
    const imported = {
      ...(await importSnapshot(sourcePath, this.projectDir(project.id))),
      projectId: project.id,
    };
    const activeSnapshot = project.activeSnapshotId
      ? store.list('snapshot').find((snapshot) => snapshot.id === project.activeSnapshotId)
      : undefined;
    const existing =
      activeSnapshot?.version === imported.version
        ? activeSnapshot
        : store.list('snapshot').find((snapshot) => snapshot.version === imported.version);
    const snapshot = existing ?? imported;
    if (existing) await rm(imported.root, { recursive: true, force: true });
    else store.put('snapshot', imported);
    const updated = {
      ...project,
      name,
      sourcePath,
      activeSnapshotId: snapshot.id,
      snapshotIds: [...new Set([...project.snapshotIds, snapshot.id])],
      updatedAt: Date.now(),
      lastOpenedAt: Date.now(),
    };
    this.catalog.put('project', updated);
    return {
      project: this.projectSummary(updated),
      snapshot: withoutRoot(snapshot),
      reused: Boolean(existing),
    };
  }

  projectSummary(project, { includeFiles = true } = {}) {
    const store = this.openProjectStore(project.id);
    const snapshot = store.get('snapshot', project.activeSnapshotId);
    const routes = dedupeRouteSummaries(store.list('route').map((route) => route.summary)).filter(
      (route) => route.status !== 'archived',
    );
    const overviews = store.list('overview');
    const publicSnapshot = withoutRoot(snapshot);
    if (!includeFiles) {
      delete publicSnapshot.files;
      delete publicSnapshot.skipped;
    }
    return {
      ...project,
      currentSnapshot: publicSnapshot,
      snapshotCount: project.snapshotIds.length,
      routeCount: routes.length,
      overviewReady: Boolean(selectOverviewForSnapshot(overviews, snapshot)),
      annotationCount: store.list('annotation').length,
    };
  }

  listProjects() {
    return this.catalog
      .list('project')
      .map((project) => this.projectSummary(project, { includeFiles: false }))
      .sort(
        (left, right) =>
          right.lastOpenedAt - left.lastOpenedAt || left.name.localeCompare(right.name),
      );
  }

  getProject(projectId) {
    return this.projectSummary(this.catalog.get('project', projectId));
  }

  resolveWorkspace(workspaceId) {
    const project =
      this.catalog.list('project').find((item) => item.id === workspaceId) ??
      this.projectForSnapshot(workspaceId);
    if (!project) throw new Error('项目不存在');
    const store = this.openProjectStore(project.id);
    return {
      project,
      store,
      snapshot: store.get('snapshot', project.activeSnapshotId),
      dataDir: this.projectDir(project.id),
      aggregateProjectRoutes: true,
    };
  }

  close() {
    for (const store of this.stores.values()) store.close();
    this.stores.clear();
    this.catalog?.close();
  }
}
