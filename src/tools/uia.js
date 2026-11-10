'use strict';
/**
 * tools/uia.js — TEST SUPPORT (never shipped): Node wrapper around tools/uia-agent.ps1, a UI Automation driver.
 *   const ui = new Uia(); await ui.start(); await ui.attach(pid); await ui.invoke('btnNext'); ... await ui.stop();
 */
const { spawn } = require('child_process');
const path = require('path');
const winpaths = require('../winpaths');

class Uia {
  constructor() { this.child = null; this.buf = ''; this.waiting = []; }
  start() {
    this.child = spawn(winpaths.powershellExe(), ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'uia-agent.ps1')], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (d) => { this.buf += d; let i; while ((i = this.buf.indexOf('\n')) >= 0) { const l = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1); if (l && this.waiting.length) this.waiting.shift()(JSON.parse(l)); } });
    this.child.on('exit', () => { while (this.waiting.length) this.waiting.shift()({ ok: false, error: 'agent exited' }); });
    return this;
  }
  req(obj, ms = 30000) {
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve({ ok: false, error: 'timeout' }), ms);
      this.waiting.push((r) => { clearTimeout(t); resolve(r); });
      this.child.stdin.write(`${JSON.stringify(obj)}\n`);
    });
  }
  attach(pid, timeoutMs = 20000) { return this.req({ cmd: 'attach', pid, timeoutMs }, timeoutMs + 5000); }
  async list() { const r = await this.req({ cmd: 'list' }); return r.ok ? r.items : []; }
  async texts() { const r = await this.req({ cmd: 'texts' }); return r.ok ? r.texts : []; }
  async exists(id) { const r = await this.req({ cmd: 'exists', id }); return !!(r.ok && r.exists); }
  async enabled(id) { const r = await this.req({ cmd: 'enabled', id }); return !!(r.ok && r.enabled); }
  async text(id) { const r = await this.req({ cmd: 'text', id }); return r.ok ? r.text : null; }
  invoke(id) { return this.req({ cmd: 'invoke', id }); }
  shot(file, id = null, region = null) { return this.req({ cmd: 'shot', id, file, region }); }
  dialog(button, noClick = false) { return this.req({ cmd: 'dialog', button, noClick }, 15000); }
  /** screen rectangle {x,y,w,h} of the window or of a control (by visible text); dialog=true => the open confirmation dialog */
  async rect(id = null, dialog = false) { const r = await this.req({ cmd: 'rect', id, dialog }); return r.ok ? r : null; }
  /** "#RRGGBB" of each [x, y] screen point */
  async pixels(points) { const r = await this.req({ cmd: 'pixels', points }); return r.ok ? r.colors : []; }
  async syscolors() { const r = await this.req({ cmd: 'syscolors' }); return r.ok ? r.colors : {}; }
  mouse(action, x = 0, y = 0) { return this.req({ cmd: 'mouse', action, x, y }); }
  key(vk, dialog = false) { return this.req({ cmd: 'key', vk, dialog }); }
  async focused() { const r = await this.req({ cmd: 'focused' }); return r.ok ? r.name : ''; }
  async dpiScale() { const r = await this.req({ cmd: 'dpi' }); return r.ok ? r.scale : 1; }
  foreground() { return this.req({ cmd: 'foreground' }); }
  async darkTitle(dialog = false) { const r = await this.req({ cmd: 'darktitle', dialog }); return r.ok ? r : null; }
  close() { return this.req({ cmd: 'close' }); }
  /** polls until fn() is truthy */
  async until(fn, ms = 10000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 150)); } return !!(await fn()); }
  async stop() { try { if (this.child) { this.child.stdin.write('{"cmd":"exit"}\n'); this.child.stdin.end(); } } catch { /* gone */ } setTimeout(() => { try { this.child.kill(); } catch { /* gone */ } }, 500).unref?.(); }
}

module.exports = { Uia };
