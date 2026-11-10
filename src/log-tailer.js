'use strict';
/**
 * log-tailer.js — read-only tailer for Claude Desktop's main.log with rotation handling.
 *
 * Only ever opens <dir>/main.log and <dir>/main1.log (read-only). Emits one 'entry' per
 * timestamped log line: { ts (epoch ms, local time), level, text, file, replay }.
 * Continuation lines (stack traces, pretty-printed objects) are ignored.
 *
 * Rotation (Desktop rolls main.log -> main1.log at ~10 MB; the mechanism is not verified, so
 * both shapes are handled):
 *   - rename + new file : file identity (inode) of main.log changes. If main1.log now has the
 *     old identity, the unread tail is drained from main1.log at the saved offset first.
 *   - copy + truncate   : same identity but size < saved offset -> restart at 0.
 * Partial last lines (no newline yet) and UTF-8 sequences split across reads are carried over.
 */
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const HEADER = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d) \[(\w+)\] (.*)$/;
const CHUNK = 1 << 20;

class LogTailer extends EventEmitter {
  /** @param {{dir:string, name?:string, rotatedName?:string, intervalMs?:number, fromStart?:boolean}} o */
  constructor(o) {
    super();
    this.dir = o.dir;
    this.name = o.name || 'main.log';
    this.rotatedName = o.rotatedName || 'main1.log';
    this.intervalMs = o.intervalMs || 500;
    this.fromStart = !!o.fromStart;
    this.ino = null;
    this.offset = 0n;
    this.carry = Buffer.alloc(0);
    this.catchingUp = false;
    this.timer = null;
  }

  get mainPath() { return path.join(this.dir, this.name); }
  get rotPath() { return path.join(this.dir, this.rotatedName); }

  start() {
    const st = this._stat(this.mainPath);
    if (this.fromStart) {
      this.catchingUp = true;
      const r = this._stat(this.rotPath);
      if (r) this._readRange(this.rotPath, this.rotatedName, 0n, r.size);
      this.carry = Buffer.alloc(0);
      if (st) { this.ino = st.ino; this.offset = 0n; }
      this._poll();
      this.catchingUp = false;
    } else if (st) {
      this.ino = st.ino;
      this.offset = st.size; // live tail: start at the end, never replay history
    }
    this.timer = setInterval(() => this._poll(), this.intervalMs);
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  _stat(p) { try { return fs.statSync(p, { bigint: true }); } catch { return null; } }

  _poll() {
    try {
      const st = this._stat(this.mainPath);
      if (!st) return; // missing during rotation; try again next tick
      if (this.ino === null) { this.ino = st.ino; this.offset = 0n; }
      if (st.ino !== this.ino && st.ino !== 0n) {
        const r = this._stat(this.rotPath);
        if (r && r.ino === this.ino) {
          this._readRange(this.rotPath, this.rotatedName, this.offset, r.size); // drain old tail
          this.emit('rotation', { kind: 'rename', drainedBytes: Number(r.size - this.offset) });
        } else {
          this.emit('rotation', { kind: 'new-file-old-not-found' });
        }
        this.ino = st.ino; this.offset = 0n; this.carry = Buffer.alloc(0);
      } else if (st.size < this.offset) {
        this.emit('rotation', { kind: 'truncate' });
        this.offset = 0n; this.carry = Buffer.alloc(0);
      }
      if (st.size > this.offset) {
        this._readRange(this.mainPath, this.name, this.offset, st.size);
        this.offset = st.size;
      }
    } catch (e) {
      this.emit('warn', `tail error: ${e.message}`);
    }
  }

  _readRange(file, label, from, to) {
    let fd;
    try { fd = fs.openSync(file, 'r'); } catch (e) { this.emit('warn', `cannot open ${label}: ${e.code}`); return; }
    try {
      let pos = from;
      while (pos < to) {
        const len = Number(to - pos < BigInt(CHUNK) ? to - pos : BigInt(CHUNK));
        const buf = Buffer.alloc(len);
        const n = fs.readSync(fd, buf, 0, len, Number(pos));
        if (n <= 0) break;
        pos += BigInt(n);
        this._consume(buf.subarray(0, n), label);
      }
    } finally { fs.closeSync(fd); }
  }

  _consume(chunk, label) {
    // split at byte level so a UTF-8 sequence cut by a read boundary is never decoded half-way
    this.carry = this.carry.length ? Buffer.concat([this.carry, chunk]) : chunk;
    let start = 0;
    for (let i = this.carry.indexOf(0x0a, start); i !== -1; i = this.carry.indexOf(0x0a, start)) {
      let line = this.carry.subarray(start, i).toString('utf8');
      if (line.endsWith('\r')) line = line.slice(0, -1);
      start = i + 1;
      const m = HEADER.exec(line);
      if (!m) continue;
      const ts = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
      this.emit('entry', { ts, level: m[7], text: m[8], file: label, replay: this.catchingUp });
    }
    this.carry = Buffer.from(this.carry.subarray(start)); // copy so we don't pin the big buffer
  }
}

module.exports = { LogTailer };
