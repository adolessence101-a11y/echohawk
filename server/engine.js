// Corroboration engine (docs/docs/BUILD_SPEC.md Section 4). Two layers:
//   scan layer: counts per zone per window vs the zone's hour-of-day baseline (content-free; works on every packet)
//   content layer: independence-weighted corroboration per zone+target, spread across adjacent zones, triggers, rungs
// The score is a HEURISTIC (Sakaki-style 1 - p^n), labeled "confidence score" everywhere. Not calibrated.
import { config } from "./config.js";

const E = config.engine;

export class Engine {
  constructor(store, { adjacency = {} } = {}) {
    this.store = store;
    this.adjacency = adjacency; // zone_id -> [neighbor zone_ids]
  }

  ingest(packet, { triggers = { hard: [], soft: [] } } = {}) {
    const s = this.store;
    packet.packet_id ||= s.nextId("pk");
    packet.triggers = triggers;
    s.packets.push(packet);
    s.appendEvent({ event_type: "packet_created", packet_id: packet.packet_id, call_id: packet.call_id, provenance: packet.provenance, actor: packet.source === "voice" ? "ai" : "device", payload_json: { zone_id: packet.zone_id, target: packet.target, source: packet.source, intake_pending: packet.intake_pending, content_status: packet.content_status } });

    this._scanLayer(packet);

    if (packet.content_status === "none" || packet.target === "unknown") {
      return { incident: null, rung: "watch", reason: "no extractable content; scan layer only" };
    }
    const incident = this._attach(packet);
    this._rescore(incident, packet, triggers);
    this._spread(incident, packet);
    s.save();
    return { incident, rung: incident.rung, reason: incident.last_reason };
  }

  // Enrich one request rather than creating another packet for each voice turn.
  refine(packet, fields, triggers = { hard: [], soft: [] }) {
    const old = this.store.incidents.find(i => i.id === packet.incident_id);
    packet.reported_fields = fields;
    packet.triggers = {
      hard: [...new Set([...(packet.triggers?.hard || []), ...(triggers.hard || [])])],
      soft: [...new Map([...(packet.triggers?.soft || []), ...(triggers.soft || [])].map(t => [JSON.stringify(t), t])).values()],
    };
    const moving = old && (fields.zone_id && fields.zone_id !== 'unknown' && fields.zone_id !== old.zone_id || fields.target && fields.target !== 'unknown' && fields.target !== old.target);
    // Once a human has acted, retain the incident location and keep new details for review.
    const acted = old && ((old.dispatched || []).length || old.closed_at || this.store.events.some(e => e.incident_id === old.id && e.event_type === 'acknowledged_by_human'));
    if (!(moving && acted)) {
      if (moving) {
        old.packet_ids = old.packet_ids.filter(id => id !== packet.packet_id);
        delete packet.incident_id;
        if (!old.packet_ids.length) this.store.incidents = this.store.incidents.filter(i => i.id !== old.id);
        else this._rebuild(old);
      }
      const previousZone = packet.zone_id;
      for (const key of ['zone_id', 'target', 'severity', 'action', 'content_status', 'language']) if (fields[key] !== undefined && fields[key] !== 'unknown') packet[key] = fields[key];
      if (previousZone !== packet.zone_id) { this._scanLayer({ ...packet, zone_id: previousZone }, -1); this._scanLayer(packet); }
      if (fields.target && fields.target !== 'unknown') packet.intake_pending = false;
    }
    const inc = !moving || acted ? old : null;
    const current = inc || this._attach(packet);
    this._rebuild(current);
    this._spread(current, packet);
    this.store.appendEvent({ event_type: 'packet_updated', packet_id: packet.packet_id, call_id: packet.call_id, incident_id: current.id, actor: 'ai', provenance: packet.provenance, payload_json: { source: packet.source } });
    this.store.save(); return current;
  }

  _rebuild(inc) {
    const packets = this.store.packets.filter(p => inc.packet_ids.includes(p.packet_id));
    inc.keys = {};
    for (const p of packets) if (!E.machineSources.includes(p.source)) inc.keys[p.independence_key] = (inc.keys[p.independence_key] || 0) + 1;
    inc.independent_count = Object.keys(inc.keys).length;
    inc.repeat_count = Object.values(inc.keys).reduce((n, count) => n + count - 1, 0);
    inc.machine_count = packets.filter(p => E.machineSources.includes(p.source)).length;
    inc.max_severity = Math.max(0, ...packets.map(p => p.severity));
    inc.soft_weight = 0; inc.triggers = [];
    this._rescore(inc, packets.at(-1), { hard: packets.flatMap(p => p.triggers?.hard || []), soft: packets.flatMap(p => p.triggers?.soft || []) });
  }

  // ----- scan layer -----
  _scanLayer(packet, delta = 1) {
    const s = this.store;
    const t = new Date(packet.received_at).getTime();
    const windowStart = new Date(Math.floor(t / E.scanWindowMs) * E.scanWindowMs).toISOString();
    let w = s.zoneWindows.find((x) => x.zone_id === packet.zone_id && x.window_start === windowStart);
    if (!w) { w = { zone_id: packet.zone_id, window_start: windowStart, n: 0, p_tail: null, flagged: false }; s.zoneWindows.push(w); }
    w.n = Math.max(0, w.n + delta);
    const hour = new Date(windowStart).getUTCHours();
    const base = s.baselines.find((b) => b.zone_id === packet.zone_id && b.hour === hour);
    const lambda = Math.max(base?.mean_per_15min ?? 0.05, 1e-3);
    w.p_tail = poissonTail(w.n, lambda);
    const wasFlagged = w.flagged;
    w.flagged = w.n >= E.scanMinCount && w.p_tail < E.scanPoissonTail;
    if (w.flagged && !wasFlagged) s.appendEvent({ event_type: "scan_flagged", packet_id: packet.packet_id, actor: "system", provenance: packet.provenance, payload_json: { zone_id: w.zone_id, window_start: w.window_start, n: w.n, p_tail: w.p_tail, lambda } });
  }

  // ----- content layer -----
  _attach(packet) {
    const s = this.store;
    const now = new Date(packet.received_at).getTime();
    let inc = s.incidents.find((i) => i.zone_id === packet.zone_id && (packet.zone_id !== "unknown" || i.keys?.[packet.independence_key]) && i.target === packet.target && !i.closed_at && now - new Date(i.last_packet_at).getTime() <= E.keepAliveMs);
    if (!inc) {
      inc = { id: s.nextId("inc"), zone_id: packet.zone_id, target: packet.target, opened_at: packet.received_at, last_packet_at: packet.received_at, closed_at: null, rung: "watch", score: 0, independent_count: 0, packet_ids: [], keys: {}, max_severity: 0, spread_linked_incident_id: null, summary_text: null, summary_evidence_count: 0, last_reason: "opened", triggers: [], soft_weight: 0 };
      s.incidents.push(inc);
      s.appendEvent({ event_type: "incident_opened", incident_id: inc.id, packet_id: packet.packet_id, actor: "system", provenance: packet.provenance, payload_json: { zone_id: inc.zone_id, target: inc.target } });
    }
    inc.packet_ids.push(packet.packet_id);
    inc.last_packet_at = packet.received_at;
    packet.incident_id = inc.id;
    // independence weighting: distinct human keys count toward corroboration; a repeat key counts 0 (raises urgency only);
    // machine sources (alarm activations, telemetry) are a separate class and never count as independent callers.
    if (E.machineSources.includes(packet.source)) {
      inc.machine_count = (inc.machine_count || 0) + 1;
    } else {
      inc.keys[packet.independence_key] = (inc.keys[packet.independence_key] || 0) + 1;
      if (inc.keys[packet.independence_key] > 1) inc.repeat_count = (inc.repeat_count || 0) + 1;
    }
    inc.independent_count = Object.keys(inc.keys).length;
    inc.max_severity = Math.max(inc.max_severity, packet.severity);
    return inc;
  }

  _rescore(inc, packet, triggers) {
    const s = this.store;
    const n = inc.independent_count;
    let score = n > 0 ? 1 - Math.pow(E.pFalse, n) : 0;
    // single-caller cap: one key can lift the score at most to singleCallerCap * handScore
    if (n <= 1) score = Math.min(score, E.singleCallerCap * E.handScore);
    inc.soft_weight = (inc.soft_weight || 0) + (triggers.soft || []).reduce((a, t) => a + t.weight, 0) * 0.05;
    score = Math.min(1, score + inc.soft_weight);
    inc.score = Number(score.toFixed(3));
    inc.triggers = Array.from(new Set([...(inc.triggers || []), ...(triggers.hard || [])]));

    let rung = "watch", reason = `independent sources ${n}, confidence ${inc.score}`;
    if (E.highConsequenceTargets.includes(inc.target) && n >= 1) { rung = "ask"; reason = `high-consequence target ${inc.target} with ${n} source(s)`; }
    if (n >= E.askIndependentCount) { rung = "ask"; reason = `${n} independent sources within window`; }
    if (n >= E.handIndependentCount || inc.score >= E.handScore) { rung = "hand"; reason = `${n} independent sources, confidence ${inc.score}`; }
    if (inc.triggers.length) { rung = "hand"; reason = `hard trigger: ${inc.triggers.join(", ")}`; }
    if (rung !== inc.rung) {
      s.appendEvent({ event_type: "rung_changed", incident_id: inc.id, packet_id: packet.packet_id, actor: "system", provenance: packet.provenance, payload_json: { from: inc.rung, to: rung, reason } });
      inc.rung = rung;
    }
    inc.last_reason = reason;
    if (inc.triggers.length) s.appendEvent({ event_type: "trigger_fired", incident_id: inc.id, packet_id: packet.packet_id, actor: "system", provenance: packet.provenance, payload_json: { triggers: inc.triggers } });
  }

  _spread(inc, packet) {
    const s = this.store;
    const neighbors = this.adjacency[inc.zone_id] || [];
    const now = new Date(packet.received_at).getTime();
    const linked = s.incidents.find((o) => o.id !== inc.id && !o.closed_at && o.target === inc.target && neighbors.includes(o.zone_id) && now - new Date(o.last_packet_at).getTime() <= E.mergeWindowMs);
    if (linked && !inc.spread_linked_incident_id) {
      inc.spread_linked_incident_id = linked.id;
      linked.spread_linked_incident_id ||= inc.id;
      s.appendEvent({ event_type: "incident_spread", incident_id: inc.id, packet_id: packet.packet_id, actor: "system", provenance: packet.provenance, payload_json: { linked_incident_id: linked.id, zones: [inc.zone_id, linked.zone_id], target: inc.target } });
      if (inc.rung === "watch") { inc.rung = "ask"; inc.last_reason = `spread across adjacent zones ${inc.zone_id} and ${linked.zone_id}`; }
    }
  }

  ranked() {
    const order = { hand: 0, ask: 1, watch: 2 };
    return this.store.incidents.filter((i) => !i.closed_at).sort((a, b) => order[a.rung] - order[b.rung] || b.score - a.score || new Date(b.last_packet_at) - new Date(a.last_packet_at))
      .map((i) => ({ ...i, keys: undefined, trend: this._trend(i), first_report_at: i.opened_at, score_label: "confidence score (heuristic)", ...this._relay(i) }));
  }
  // node relays and self-report triage, summarized for the board
  _relay(inc) {
    const ps = this.store.packets.filter((p) => p.incident_id === inc.id);
    const withNodes = ps.filter((p) => (p.heard_by || []).length).sort((a, b) => b.heard_by.length - a.heard_by.length)[0];
    const held = ps.filter((p) => p.reported_severity);
    const source_counts = Object.fromEntries(['voice', 'app', 'ehawk', 'field_unit', 'telemetry'].map(source => [source, ps.filter(p => p.source === source).length]));
    return { source_counts, intake_pending: ps.length > 0 && ps.every(p => p.intake_pending), heard_by: withNodes?.heard_by || [], hearings: withNodes?.hearings || [], picked_up: withNodes?.picked_up || null, delivered_at: withNodes?.delivered_at || null, approx_area: withNodes?.approx_area || null, self_reported_held: held.length, triage_note: held[0]?.triage_note || null };
  }
  _trend(inc) {
    const ps = this.store.packets.filter((p) => p.incident_id === inc.id).map((p) => new Date(p.received_at).getTime()).sort();
    if (ps.length < 2) return "flat";
    const recent = ps.filter((t) => t > Date.now() - 10 * 60 * 1000).length;
    return recent >= 2 ? "rising" : "flat";
  }

  close(incidentId, actor, reason) {
    const inc = this.store.incidents.find((i) => i.id === incidentId);
    if (!inc) return { ok: false, status: 404 };
    if (inc.max_severity >= 4 && actor !== "supervisor") return { ok: false, status: 403, error: "high-severity incidents close only by a supervisor" };
    if (actor === "system" || actor === "ai") return { ok: false, status: 403, error: "automation never closes incidents" };
    inc.closed_at = new Date().toISOString();
    this.store.appendEvent({ event_type: "incident_closed", incident_id: inc.id, actor, provenance: "firsthand", payload_json: { reason } });
    this.store.save();
    return { ok: true };
  }
}

export function poissonTail(n, lambda) {
  // P(X >= n) for Poisson(lambda)
  let p = Math.exp(-lambda), cdf = 0;
  for (let k = 0; k < n; k++) { cdf += p; p *= lambda / (k + 1); }
  return Math.max(0, Math.min(1, 1 - cdf));
}
