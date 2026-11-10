'use strict';
/**
 * store.js — local persistence (settings + notification/event history).
 *
 * History uses Node's built-in SQLite (node:sqlite, no npm dependency). If that module is not
 * available the store falls back to an append-only JSONL file with the same API.
 * Only event METADATA is stored (time, session title, project folder name, type, short details,
 * source, whether a notification was shown). No transcript or conversation content, no tokens.
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_SETTINGS = { notificationsEnabled: true, soundsEnabled: true, phoneEnabled: false, appearance: 'system' };
const KEEP_ROWS = 5000;

class Store {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.settingsPath = path.join(dir, 'settings.json');
    this.settings = { ...DEFAULT_SETTINGS };
    try { Object.assign(this.settings, JSON.parse(fs.readFileSync(this.settingsPath, 'utf8'))); } catch { /* first run */ }
    this.backend = 'sqlite';
    try {
      const { DatabaseSync } = require('node:sqlite');
      this.db = new DatabaseSync(path.join(dir, 'history.db'));
      this.db.exec(`CREATE TABLE IF NOT EXISTS events(
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, session TEXT, project TEXT, session_id TEXT, pid INTEGER,
        type TEXT NOT NULL, details TEXT, source TEXT, notified INTEGER NOT NULL DEFAULT 0, reason TEXT);
        CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
        CREATE TABLE IF NOT EXISTS pushes(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, type TEXT, project TEXT, priority INTEGER, ok INTEGER NOT NULL, status INTEGER, error TEXT);`);
      this.insertPush = this.db.prepare('INSERT INTO pushes(ts,type,project,priority,ok,status,error) VALUES (?,?,?,?,?,?,?)');
      this.insert = this.db.prepare('INSERT INTO events(ts,session,project,session_id,pid,type,details,source,notified,reason) VALUES (?,?,?,?,?,?,?,?,?,?)');
      this.db.prepare('DELETE FROM events WHERE id <= (SELECT MAX(id) FROM events) - ?').run(KEEP_ROWS);
    } catch (e) {
      this.backend = 'jsonl'; this.db = null; this.jsonlPath = path.join(dir, 'history.jsonl'); this.rows = [];
      try { this.rows = fs.readFileSync(this.jsonlPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).slice(-KEEP_ROWS); } catch { /* none yet */ }
    }
  }

  /** pick up changes made by another process (e.g. `notifier.js --ntfy-enable` while the tray app runs) */
  reloadSettings() {
    try {
      const m = fs.statSync(this.settingsPath).mtimeMs;
      if (m !== this._settingsMtime) { this._settingsMtime = m; Object.assign(this.settings, JSON.parse(fs.readFileSync(this.settingsPath, 'utf8'))); }
    } catch { /* no file yet */ }
  }

  saveSettings() { fs.writeFileSync(this.settingsPath, JSON.stringify(this.settings, null, 2)); try { this._settingsMtime = fs.statSync(this.settingsPath).mtimeMs; } catch { /* ignore */ } }
  setSetting(k, v) { this.settings[k] = v; this.saveSettings(); }

  addEvent(ev, { notified, reason }) {
    const row = { ts: ev.epoch || Date.now(), session: ev.session || null, project: ev.project || null, session_id: ev.sessionId || null,
      pid: ev.pid || null, type: ev.type, details: (ev.details || '').slice(0, 300), source: ev.source || null, notified: notified ? 1 : 0, reason: reason || null };
    if (this.db) {
      this.insert.run(row.ts, row.session, row.project, row.session_id, row.pid, row.type, row.details, row.source, row.notified, row.reason);
    } else {
      this.rows.push(row); if (this.rows.length > KEEP_ROWS) this.rows.shift();
      fs.appendFileSync(this.jsonlPath, JSON.stringify(row) + '\n');
    }
  }

  /** phone push delivery log (metadata only: no message body is stored) */
  addPush({ type, project, priority, ok, status, error }) {
    const row = { ts: Date.now(), type: type || null, project: project || null, priority: priority || null, ok: ok ? 1 : 0, status: status || null, error: error || null };
    if (this.db) this.insertPush.run(row.ts, row.type, row.project, row.priority, row.ok, row.status, row.error);
    else fs.appendFileSync(path.join(this.dir, 'pushes.jsonl'), JSON.stringify(row) + '\n');
  }

  /** most recent first; excludes noisy state-only events unless includeAll */
  recent(limit = 12, includeAll = false) {
    const noisy = ['WORKING', 'IDLE', 'INITIAL_STATE', 'USAGE_CLEARED', 'HEALTH_CLEARED'];
    if (this.db) {
      const where = includeAll ? '' : `WHERE type NOT IN (${noisy.map(() => '?').join(',')})`;
      return this.db.prepare(`SELECT * FROM events ${where} ORDER BY id DESC LIMIT ?`).all(...(includeAll ? [] : noisy), limit);
    }
    return this.rows.filter((r) => includeAll || !noisy.includes(r.type)).slice(-limit).reverse();
  }

  count() { return this.db ? this.db.prepare('SELECT COUNT(*) c FROM events').get().c : this.rows.length; }
  close() { try { if (this.db) this.db.close(); } catch { /* ignore */ } }
}

module.exports = { Store, DEFAULT_SETTINGS };
