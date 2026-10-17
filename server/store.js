// In-memory store with JSON snapshot persistence. Same shape as docs/IMPLEMENTATION_PLAN.md Section 2 so a swap to
// SQLite/Prisma is a storage change, not a model change. Append-only tables are never mutated except by append.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const TABLES = ["calls", "turns", "packets", "incidents", "events", "kitShows", "callbacks", "baselines", "zoneWindows", "twists", "costMeter"];

export class Store {
  constructor(path = null) {
    this.path = path;
    for (const t of TABLES) this[t] = [];
    this._seq = 0;
    if (path && existsSync(path)) {
      try {
        const snap = JSON.parse(readFileSync(path, "utf8"));
        for (const t of TABLES) this[t] = snap[t] || [];
        this._seq = snap._seq || 0;
      } catch { /* start clean */ }
    }
  }
  nextId(prefix) { this._seq += 1; return `${prefix}_${this._seq.toString(36)}`; }
  save() {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const snap = { _seq: this._seq };
    for (const t of TABLES) snap[t] = this[t];
    writeFileSync(this.path, JSON.stringify(snap));
  }
  appendEvent(ev) {
    const row = { id: this.nextId("ev"), ts_server: new Date().toISOString(), schema_version: 1, ...ev };
    this.events.push(row);
    this.listeners?.forEach((fn) => { try { fn(row); } catch {} });
    return row;
  }
  onEvent(fn) { (this.listeners ||= new Set()).add(fn); return () => this.listeners.delete(fn); }
}
