'use strict';
/**
 * paths.js — where things live, independent of HOW the notifier was launched.
 *
 * Background (the bug this fixes): Claude Desktop is an MSIX-packaged app. Windows gives processes it launches a
 * copy-on-write, per-package view of %APPDATA% / %LOCALAPPDATA%. A notifier started from inside Claude Desktop and one
 * started from Explorer therefore saw DIFFERENT files at the same AppData path. Two rules make that irrelevant:
 *
 *   1. The notifier's OWN data lives in %USERPROFILE%\.claude-notifier — outside AppData, so never virtualized and
 *      identical for every launch context.
 *   2. Claude Desktop's files are DISCOVERED, never assumed: every Claude* folder under %APPDATA%, %LOCALAPPDATA% (Claude 4.x keeps
 *      the usage history in Claude-Data\<family>) and the private store of every Packages\Claude_* package. No user or package
 *      name is hard-coded. Among files that validate, the most recently written one wins.
 *
 * Everything here is read-only except migrateLegacyData(), which copies (never overwrites, never deletes).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const USAGE_FILE = 'plan-usage-history.json';
const MIGRATE_FILES = ['ntfy.json', 'settings.json', 'usage-state.json', 'history.db'];

const home = (env) => env.USERPROFILE || os.homedir();
const localAppData = (env) => env.LOCALAPPDATA || path.join(home(env), 'AppData', 'Local');
const roamingAppData = (env) => env.APPDATA || path.join(home(env), 'AppData', 'Roaming');

/** the notifier's own data folder: stable, per-user, not under AppData */
function defaultDataDir(env = process.env) { return path.join(home(env), '.claude-notifier'); }

/** private stores of every installed Claude package (family name discovered, not assumed) */
function claudePackageCaches(env = process.env) {
  const root = path.join(localAppData(env), 'Packages');
  let names = [];
  try { names = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && /^Claude_/i.test(d.name)).map((d) => d.name); } catch { /* no Packages folder */ }
  return names.map((n) => ({ name: n, cache: path.join(root, n, 'LocalCache') }));
}

const mtimeOf = (p) => { try { const s = fs.statSync(p); return s.isFile() ? { mtimeMs: s.mtimeMs, size: s.size } : null; } catch { return null; } };

const MAX_USAGE_BYTES = 20 * 1024 * 1024;     // the real file is a few KB; anything this big is not a usage history
const subdirs = (dir) => { try { return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).slice(0, 64).map((d) => d.name); } catch { return []; } };

/**
 * Looks inside one file and says what it is, without ever writing: 'valid' (JSON with at least one usable sample),
 * 'empty' (JSON but no usable sample yet), 'malformed' (not JSON / wrong shape, e.g. mid-write) or 'unreadable'.
 * Cached by (mtime,size) so a poll every few seconds does not re-parse an unchanged file.
 */
const classCache = new Map();
function classifyUsageFile(p, st) {
  const key = `${p}|${st.mtimeMs}|${st.size}`; if (classCache.has(key)) return classCache.get(key);
  let state;
  if (st.size > MAX_USAGE_BYTES) state = 'malformed';
  else {
    let raw = null; try { raw = fs.readFileSync(p, 'utf8'); } catch { state = 'unreadable'; }
    if (raw !== null) {
      let j; try { j = JSON.parse(raw); } catch { j = undefined; }
      const samples = j && typeof j === 'object' && Array.isArray(j.samples) ? j.samples : null;
      if (!samples) state = 'malformed';
      else state = samples.some((x) => x && Number.isFinite(x.t) && x.u && typeof x.u === 'object' && (Number.isFinite(x.u.fh) || Number.isFinite(x.u.sd))) ? 'valid' : 'empty';
    }
  }
  if (classCache.size > 64) classCache.clear();
  classCache.set(key, state); return state;
}

/**
 * Every place Claude Desktop's usage history could physically be. Nothing is hard-coded to a user or package name:
 *   roots     %APPDATA%, %LOCALAPPDATA%, and LocalCache\Roaming + LocalCache\Local of every Packages\Claude_* store
 *   folders   every directory in a root whose name starts with "Claude" (Claude, Claude-Data, Claude-Account2, ...),
 *             except this app's own ClaudeNotifier; the file is looked for in it and one level below it
 *             (Claude 4.x keeps it in Claude-Data\<package-family>\; older versions in Roaming\Claude\).
 * Each candidate carries { label, path, mtimeMs, size, state }.
 */
function usageHistoryCandidates(env = process.env) {
  const roots = [{ label: 'roaming', dir: roamingAppData(env) }, { label: 'local', dir: localAppData(env) }];
  for (const p of claudePackageCaches(env)) roots.push({ label: 'package-store', dir: path.join(p.cache, 'Roaming') }, { label: 'package-store:local', dir: path.join(p.cache, 'Local') });
  const list = []; const seen = new Set();
  const add = (label, file) => { const k = path.resolve(file).toLowerCase(); if (!seen.has(k)) { seen.add(k); list.push({ label, path: file }); } };
  add('appdata', path.join(roamingAppData(env), 'Claude', USAGE_FILE));          // always listed, even if absent (the classic place)
  for (const r of roots) {
    for (const name of subdirs(r.dir)) {
      if (!/^Claude/i.test(name) || /^ClaudeNotifier/i.test(name)) continue;
      const base = path.join(r.dir, name);
      const baseLabel = r.label === 'roaming' && name.toLowerCase() === 'claude' ? 'appdata' : r.label === 'package-store' && name.toLowerCase() === 'claude' ? 'package-store' : `${r.label}:${name}`;
      add(baseLabel, path.join(base, USAGE_FILE));
      for (const sub of subdirs(base)) { const f = path.join(base, sub, USAGE_FILE); if (mtimeOf(f)) add(`${r.label}:${name}/${sub}`, f); }   // one level down, only where the file exists
    }
  }
  return list.map((c) => { const st = mtimeOf(c.path); return st ? { ...c, ...st, state: classifyUsageFile(c.path, st) } : { ...c, mtimeMs: null, size: null, state: 'missing' }; });
}

/**
 * The live usage history, read-only. Among candidates that VALIDATE, the most recently written one wins (so an old
 * Roaming\Claude leftover or another account's stale file loses to the live one). If none validates, the newest existing
 * file is still returned so the monitor can say "no samples yet" / "could not be read"; if nothing exists, path is null.
 * @returns {{path:string|null, label:string|null, state:string|null, candidates:object[]}}
 */
function discoverUsageHistory(env = process.env) {
  const candidates = usageHistoryCandidates(env);
  const byNewest = (a, b) => b.mtimeMs - a.mtimeMs;
  const existing = candidates.filter((c) => c.mtimeMs !== null);
  const valid = existing.filter((c) => c.state === 'valid').sort(byNewest);
  const pick = valid[0] || existing.filter((c) => c.state === 'empty').sort(byNewest)[0] || existing.sort(byNewest)[0] || null;
  return { path: pick ? pick.path : null, label: pick ? pick.label : null, state: pick ? pick.state : null, candidates };
}

/** older locations the notifier's data may be in (the plain AppData folder and every Claude package store) */
function legacyDataDirs(env = process.env) {
  const dirs = [{ label: 'appdata', dir: path.join(localAppData(env), 'ClaudeNotifier') }];
  for (const p of claudePackageCaches(env)) dirs.push({ label: 'package-store', dir: path.join(p.cache, 'Local', 'ClaudeNotifier') });
  return dirs;
}

/**
 * One-time, idempotent migration into `dataDir`. Copies a file only if the destination does NOT already have it
 * (COPYFILE_EXCL: an existing configuration is never overwritten). Config files come from the most recently written
 * legacy copy; the history database from the largest one. Nothing is deleted and no file CONTENT is ever logged.
 * @returns {{file:string, action:'copied'|'kept-existing'|'no-source', from?:string}[]}
 */
function migrateLegacyData({ env = process.env, dataDir, log = () => {} }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const legacy = legacyDataDirs(env).filter((l) => path.resolve(l.dir).toLowerCase() !== path.resolve(dataDir).toLowerCase());
  const out = [];
  for (const file of MIGRATE_FILES) {
    const dest = path.join(dataDir, file);
    if (fs.existsSync(dest)) { out.push({ file, action: 'kept-existing' }); continue; }
    const srcs = legacy.map((l) => ({ ...l, p: path.join(l.dir, file), ...(mtimeOf(path.join(l.dir, file)) || {}) })).filter((s) => s.mtimeMs !== undefined && s.size !== undefined);
    if (!srcs.length) { out.push({ file, action: 'no-source' }); continue; }
    srcs.sort((a, b) => (file === 'history.db' ? b.size - a.size : b.mtimeMs - a.mtimeMs));
    try {
      fs.copyFileSync(srcs[0].p, dest, fs.constants.COPYFILE_EXCL);
      try { fs.utimesSync(dest, new Date(), new Date(srcs[0].mtimeMs)); } catch { /* cosmetic */ }
      out.push({ file, action: 'copied', from: srcs[0].label }); log(`migrated ${file} from ${srcs[0].label} (existing files are never overwritten)`);
    } catch (e) { out.push({ file, action: e.code === 'EEXIST' ? 'kept-existing' : 'no-source' }); if (e.code !== 'EEXIST') log(`could not migrate ${file}: ${e.code || e.message}`); }
  }
  return out;
}

module.exports = { userHome: home, roamingAppData, localAppData, mtimeOf, subdirs, classifyUsageFile, defaultDataDir, claudePackageCaches, usageHistoryCandidates, discoverUsageHistory, legacyDataDirs, migrateLegacyData, USAGE_FILE };
