// After "send": what happened to the units, and how the incident ended.
// Modeled on what CAD systems do (BJA/LEITSC CAD functional specification: "The system must be able to alert the dispatcher
// to the expiration of the timer associated with any status change"; watchdog timers per status as in DeKalb IL PD's CAD
// procedure). EchoHawk does not replace CAD: in production these statuses come from the agency's CAD, here they are tapped in.
import { scheduleCallback } from "./callbacks.js";
import { independenceKey } from "./schema.js";

export const STATUSES = ["assigned", "en_route", "on_scene", "cleared", "cancelled"];
const NEXT = { assigned: ["en_route", "cancelled"], en_route: ["on_scene", "cancelled"], on_scene: ["cleared"], cleared: [], cancelled: [] };
// watchdog: how long a unit may sit in a status before the board flags it (team judgment for the demo; agencies set these per call type)
export const WATCHDOG_S = { assigned: 120, en_route: 600, on_scene: 1200 };

export const DISPOSITIONS = {
  resolved: "Resolved on scene",
  report_taken: "Report taken",
  referred: "Referred to another agency or 311",
  unfounded: "Unfounded, nothing found",
  duplicate: "Duplicate of another incident",
  unable_to_locate: "Unable to locate (callback scheduled)",
};

const now = () => new Date().toISOString();

export function initUnit(d) { return { ...d, status: "assigned", status_at: d.at, history: [{ status: "assigned", at: d.at, by: d.by }] }; }

export function setUnitStatus(store, inc, n, status, by) {
  const u = (inc.dispatched || [])[n];
  if (!u) return { ok: false, status: 404, error: "no such unit on this incident" };
  if (!u.status) Object.assign(u, initUnit(u));
  if (!STATUSES.includes(status)) return { ok: false, status: 400, error: `status: ${STATUSES.join(" | ")}` };
  if (!NEXT[u.status].includes(status)) return { ok: false, status: 409, error: `${u.unit} is ${u.status.replace("_", " ")}; next can be ${NEXT[u.status].join(" or ") || "nothing"}` };
  u.status = status; u.status_at = now(); u.history.push({ status, at: u.status_at, by });
  store.appendEvent({ event_type: "unit_status", incident_id: inc.id, actor: by, provenance: "firsthand", payload_json: { unit: u.unit, n, status, zone_id: inc.zone_id, target: inc.target } });
  store.save();
  return { ok: true, unit: u };
}

// Which calls a unit type can also take on the way (mentor feedback, Oct 17: one unit can clear several nearby problems).
// Team judgment; agencies set their own. A "needs a person" (hand) incident always gets its own unit, never a shared stop.
export const CAN_COVER = {
  utility: ["water", "power", "gas", "power_line"],
  police: ["crime", "road", "vehicle", "person", "alarm"],
  fire: ["structure_fire", "wildfire", "gas", "power_line", "alarm", "flood"],
  ems: ["person"],
  callback: [],
};

// open incidents in the same or a neighboring district that this unit could also clear, closest first
export function nearbyFor(store, adjacency, inc, unit) {
  const types = CAN_COVER[unit] || [];
  const near = new Set(adjacency[inc.zone_id] || []);
  return store.incidents
    .filter((o) => o.id !== inc.id && !o.closed_at && o.rung !== "hand" && types.includes(o.target) && (o.zone_id === inc.zone_id || near.has(o.zone_id)))
    .filter((o) => !(o.dispatched || []).some((d) => d.unit === unit && d.status !== "cleared" && d.status !== "cancelled"))
    .map((o) => ({ incident_id: o.id, zone_id: o.zone_id, target: o.target, rung: o.rung, independent_count: o.independent_count, where: o.zone_id === inc.zone_id ? "same district" : "next district" }))
    .sort((a, b) => (a.where === b.where ? 0 : a.where === "same district" ? -1 : 1) || b.independent_count - a.independent_count)
    .slice(0, 3);
}

// send the same unit on to another incident as a stop; it gets its own status line there
export function addStop(store, inc, n, target, by) {
  const u = (inc.dispatched || [])[n];
  if (!u) return { ok: false, status: 404, error: "no such unit on this incident" };
  if (!target || target.closed_at) return { ok: false, status: 404, error: "that incident is not open" };
  if (target.rung === "hand") return { ok: false, status: 409, error: "a call that needs a person gets its own unit" };
  if (!(CAN_COVER[u.unit] || []).includes(target.target)) return { ok: false, status: 409, error: `${u.unit} does not cover ${target.target}` };
  const at = now();
  const stop = initUnit({ unit: u.unit, at, by, note: `stop added from ${inc.zone_id}`, shared_from: { incident_id: inc.id, n } });
  target.dispatched = [...(target.dispatched || []), stop];
  u.stops = [...(u.stops || []), { incident_id: target.id, n: target.dispatched.length - 1 }];
  store.appendEvent({ event_type: "unit_stop_added", incident_id: target.id, actor: by, provenance: "firsthand", payload_json: { unit: u.unit, from_incident_id: inc.id, zone_id: target.zone_id, target: target.target } });
  store.save();
  return { ok: true, unit: stop };
}

// every unit on an open incident, with how long it has been in its status and whether the watchdog has fired
export function unitBoard(store, at = Date.now(), adjacency = {}) {
  const out = [];
  for (const inc of store.incidents) {
    if (inc.closed_at) continue;
    (inc.dispatched || []).forEach((d, n) => {
      const u = d.status ? d : initUnit(d);
      if (u.status === "cleared" || u.status === "cancelled") return;
      const secs = Math.round((at - new Date(u.status_at).getTime()) / 1000);
      const limit = WATCHDOG_S[u.status];
      out.push({ incident_id: inc.id, zone_id: inc.zone_id, target: inc.target, rung: inc.rung, n, unit: u.unit, status: u.status, status_at: u.status_at, seconds: secs, limit_s: limit ?? null, overdue: limit != null && secs > limit, next: NEXT[u.status], shared_from: u.shared_from || null, stops: u.stops || [], nearby: nearbyFor(store, adjacency, inc, u.unit) });
    });
  }
  return out.sort((a, b) => Number(b.overdue) - Number(a.overdue) || b.seconds - a.seconds);
}

export function closeWithDisposition(store, engine, inc, disposition, actor, note = "") {
  if (!DISPOSITIONS[disposition]) return { ok: false, status: 400, error: `disposition: ${Object.keys(DISPOSITIONS).join(" | ")}` };
  const out = engine.close(inc.id, actor, `${DISPOSITIONS[disposition]}${note ? `: ${note}` : ""}`);
  if (!out.ok) return out;
  inc.disposition = { code: disposition, label: DISPOSITIONS[disposition], by: actor, at: now(), note: String(note).slice(0, 200) };
  for (const u of inc.dispatched || []) if (u.status && u.status !== "cleared" && u.status !== "cancelled") { u.status = "cleared"; u.status_at = now(); u.history.push({ status: "cleared", at: u.status_at, by: actor }); }
  // closing the loop with the caller when the crew could not find the scene
  if (disposition === "unable_to_locate") inc.callback_id = scheduleCallback(store, inc.id, 1).id;
  store.appendEvent({ event_type: "incident_disposition", incident_id: inc.id, actor, provenance: "firsthand", payload_json: { disposition, zone_id: inc.zone_id, target: inc.target } });
  store.save();
  return { ok: true, disposition: inc.disposition, callback_id: inc.callback_id || null };
}

// what someone who reported through the app sees about their own reports (PowerEngage-style "unit assigned / en route" updates)
const SAY = { assigned: "Help has been assigned to your report.", en_route: "A unit is on the way.", on_scene: "A unit has arrived.", cleared: "The unit has cleared the scene." };
// packets keep only a hash of device + zone, never the device id, so the app sends both and we rebuild the same key
export function updatesForDevice(store, device, zone) {
  if (!device || !zone) return [];
  const key = independenceKey(device, zone);
  const incIds = new Set(store.packets.filter((p) => p.independence_key === key && p.incident_id).map((p) => p.incident_id));
  return store.incidents.filter((i) => incIds.has(i.id)).map((i) => {
    const units = (i.dispatched || []).map((d) => (d.status ? d : initUnit(d)));
    const latest = units.slice().sort((a, b) => b.status_at.localeCompare(a.status_at))[0];
    const message = i.disposition ? `Closed: ${i.disposition.label}.` : latest ? SAY[latest.status] || "Your report is with dispatch." : "Your report is on the dispatcher's board.";
    return { incident_id: i.id, zone_id: i.zone_id, target: i.target, units: units.map((u) => ({ unit: u.unit, status: u.status, at: u.status_at })), disposition: i.disposition?.code || null, message, updated_at: i.disposition?.at || latest?.status_at || i.last_packet_at };
  }).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}
