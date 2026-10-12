import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export class Store {
  constructor(filename) {
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(kind,id));`);
    for (const task of this.list('task')) {
      if (['queued', 'investigating', 'explaining', 'finalizing'].includes(task.status)) {
        this.put('task', {
          ...task,
          status: 'failed',
          error: '服务重启导致任务中断，请重新发起生成',
          finishedAt: Date.now(),
        });
      }
    }
  }
  put(kind, value) {
    this.db
      .prepare(
        'INSERT INTO records VALUES (?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body',
      )
      .run(kind, value.id, JSON.stringify(value));
    return value;
  }
  get(kind, id) {
    const row = this.db.prepare('SELECT body FROM records WHERE kind=? AND id=?').get(kind, id);
    if (!row) throw new Error('记录不存在');
    return JSON.parse(row.body);
  }
  list(kind) {
    return this.db
      .prepare('SELECT body FROM records WHERE kind=? ORDER BY rowid DESC')
      .all(kind)
      .map((row) => JSON.parse(row.body));
  }
  remove(kind, id) {
    this.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind, id);
  }
  message(annotationId, role, text, taskId) {
    return this.put('message', {
      id: randomUUID(),
      annotationId,
      role,
      text,
      taskId,
      createdAt: Date.now(),
    });
  }
  history(id) {
    return this.list('message')
      .filter((m) => m.annotationId === id)
      .reverse();
  }
  close() {
    this.db.close();
  }
}
