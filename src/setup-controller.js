'use strict';
/**
 * setup-controller.js — runs the phone setup window (setup-window.ps1) and connects it to onboarding.js.
 *
 * The window is a separate, user-interface-only process: this controller owns it (single instance, closed when the notifier exits),
 * sends it the view model and the QR code rows, and turns its button clicks into calls on the Onboarding object, which is the single
 * writer of the settings. Nothing here touches the monitoring engine.
 *
 * Appearance: the controller sends the window its colours (palette.js tokens for Light / Dark, none for High Contrast) in a `theme`
 * command BEFORE the first model, whenever the resolved theme changes, and on demand (applyTheme()). The window only applies them.
 *
 * Privacy: the topic reaches the window only inside the model (a pipe to a child process of this program). Log lines carry action names
 * and states only. The window's own error text is never logged (it could echo the model).
 */
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const path = require('path');
const winpaths = require('./winpaths');
const qr = require('./qr');
const onboardingMod = require('./onboarding');
const theme = require('./theme');
const palette = require('./palette');

class SetupController extends EventEmitter {
  /**
   * @param {{onboarding:object, getFacts?:Function, log?:Function, script?:string, spawnWindow?:Function, refreshMs?:number}} o
   *   spawnWindow(script) must return a child-process-like object (stdin, stdout, kill, on('exit')); the default starts PowerShell.
   */
  constructor({ onboarding, getFacts = () => ({}), log = () => {}, script = path.join(__dirname, 'setup-window.ps1'), spawnWindow = null, refreshMs = 3000, clipboardClearMs = 60_000, getTheme = null }) {
    super();
    Object.assign(this, { o: onboarding, getFacts, log, script, refreshMs, clipboardClearMs, child: null, buf: '', queue: Promise.resolve(), timer: null, page: null, qrCache: new Map(), lastTheme: null });
    // the resolved theme ({appearance, mode, highContrast}); without a provider the window simply follows Windows (cached for 2 s)
    let cache = null;
    this.getTheme = getTheme || (() => { const n = Date.now(); if (!cache || n - cache.at > 2000) cache = { at: n, t: theme.resolveTheme('system', theme.detectSystem()) }; return cache.t; });
    this.spawnWindow = spawnWindow || ((file) => spawn(winpaths.powershellExe(), ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', file], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }));
  }

  isOpen() { return !!this.child; }

  /** opens the window, or brings the open one to the front (never a second window) */
  open({ page = null } = {}) {
    if (this.child) { this._send({ cmd: 'focus' }); return { already: true }; }
    this.startPage = page;
    const child = this.spawnWindow(this.script);
    this.child = child; this.buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => this._onData(d));
    if (child.stderr) child.stderr.on('data', () => { /* diagnostics from PowerShell are not logged: they could contain the model */ });
    child.stdin.on('error', () => { /* window gone */ });
    child.on('exit', (code) => this._onExit(child, code));
    this.lastTheme = null;
    this.timer = setInterval(() => { if (this.child) { this.applyTheme(); this._sendModel(); } }, this.refreshMs); if (this.timer.unref) this.timer.unref();
    this.log('phone setup: window starting');
    return { already: false };
  }

  close() { if (!this.child) return; this._send({ cmd: 'close' }); const c = this.child; setTimeout(() => { try { c.kill(); } catch { /* gone */ } }, 1500).unref?.(); }
  /** the notifier is shutting down */
  kill() { if (this.timer) clearInterval(this.timer); this.timer = null; if (this.child) { try { this.child.stdin.end(); } catch { /* gone */ } try { this.child.kill(); } catch { /* gone */ } } this.child = null; }

  /** send the window its colours if the resolved theme differs from what it has (or always with force); safe to call at any time */
  applyTheme(force = false) {
    if (!this.child) return false;
    let t; try { t = this.getTheme(); } catch { t = null; }
    t = t || theme.resolveTheme('system', null);
    if (!force && theme.sameTheme(t, this.lastTheme)) return false;
    this.lastTheme = t;
    const colors = t.mode === 'contrast' ? null : palette.paletteFor(t.mode);
    this._send({ cmd: 'theme', theme: { mode: t.mode, highContrast: !!t.highContrast, colors } });
    return true;
  }
  _send(obj) { if (this.child && this.child.stdin && this.child.stdin.writable) this.child.stdin.write(`${JSON.stringify(obj)}\n`); }
  _qr(text) { if (!this.qrCache.has(text)) this.qrCache.set(text, qr.toRows(qr.encode(text).modules)); return this.qrCache.get(text); }
  _sendModel(first = false) {
    const view = this.o.view({ withSecret: true, facts: this.getFacts() }); view.clipMs = this.clipboardClearMs;
    const q = { play: this._qr(onboardingMod.PLAY_URL) }; if (view.deepLink) q.deep = this._qr(view.deepLink);
    this._send({ cmd: 'model', model: view, qr: q, ...(first && this.startPage ? { page: this.startPage } : {}) });
  }

  _onData(d) {
    this.buf += d; let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1); if (!line) continue;
      let evt; try { evt = JSON.parse(line); } catch { continue; }
      this.queue = this.queue.then(() => this._handle(evt)).catch(() => { this.log('phone setup: an action failed'); });
    }
  }
  _onExit(child, code) {
    if (this.child !== child) return;
    this.child = null; if (this.timer) clearInterval(this.timer); this.timer = null;
    this.log(`phone setup: window closed (exit ${code})`);
    this.emit('closed', code);
  }

  async _handle(evt) {
    this.emit('event', evt);
    switch (evt.evt) {
      case 'ready': this.o.opened(); this.applyTheme(true); this._sendModel(true); this.emit('opened'); break;
      case 'page': this.page = evt.page; break;
      case 'themed': this.emit('themed', evt.mode); break;
      case 'error': this.log('phone setup: the window reported an error'); break;
      case 'closed': { this.o.dismiss(); this.emit('dismissed'); const c = this.child; if (c) setTimeout(() => { try { c.kill(); } catch { /* already gone */ } }, 2000).unref?.(); break; }   // safety net: the window process must not linger     // closing before confirming counts as "not now"; never interrupts again by itself
      case 'action': await this._action(evt.id); break;
      default: break;
    }
  }

  async _action(id) {
    this.log(`phone setup: action ${String(id).replace(/[^A-Za-z]/g, '').slice(0, 20)}`);
    switch (id) {
      case 'sendTest': {
        let result; try { result = await this.o.sendTest(); } catch { result = { ok: false, kind: 'unknown', title: 'The test could not be sent', text: 'Press Try again.' }; }
        this._send({ cmd: 'result', action: 'sendTest', result }); this._sendModel(); break;
      }
      case 'confirm': { const result = this.o.confirm(); this._send({ cmd: 'result', action: 'confirm', result }); this._sendModel(); this.emit('confirmed', result); break; }
      case 'reject': this.o.reject(); this._sendModel(); break;
      case 'rotate': { const r = this.o.rotateTopic(); if (r.ok) this._send({ cmd: 'notice', text: r.notice }); this._sendModel(); this.emit('rotated', r); break; }
      case 'recover': { const r = this.o.recoverConfig(); this._sendModel(); this.emit('recovered', r); break; }
      case 'enable': this.o.setPhoneEnabled(true); this._sendModel(); break;
      case 'disable': this.o.setPhoneEnabled(false); this._sendModel(); break;
      case 'dismiss': this.o.dismiss(); break;
      default: this.log('phone setup: unknown action ignored');
    }
  }
}

module.exports = { SetupController };
