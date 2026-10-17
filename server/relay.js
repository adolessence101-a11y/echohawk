// Node relays (mentor feedback, Oct 17): one chirp can be heard by several pole-mounted nodes at once. It must count once,
// and which nodes heard it narrows where it came from. The nodes do not need to know where the sender is; the server does,
// because it knows where each node is mounted.
// Node positions here are SIMULATED demo nodes (labeled on screen). Range and the radius padding are team judgment.
import { createHash } from "node:crypto";
import { encodeFrame, decodeFrame, ReplayWindow, toBase64, fromBase64, TYPES } from "../device/frame.js";

export const DEMO_NODES = {
  "N-0812-A": { num: 1, lat: 34.0466, lon: -118.5262, zone_id: "Z06", label: "pole, Sunset & Swarthmore (simulated)" },
  "N-0812-B": { num: 2, lat: 34.0481, lon: -118.5233, zone_id: "Z06", label: "pole, Via de la Paz (simulated)" },
  "N-0812-C": { num: 3, lat: 34.0449, lon: -118.5228, zone_id: "Z06", label: "pole, Monument St (simulated)" },
  "N-0812-D": { num: 4, lat: 34.0428, lon: -118.5291, zone_id: "Z07", label: "pole, Temescal (simulated)" },
};
export const CHANNELS = ["sound", "ble", "radio", "wifi"]; // how the node heard it: chirp, Bluetooth, LoRa/ESP-NOW, Wi-Fi

// "Picked up" receipts travel back to the sender as a signed 16-byte ack frame (type 3), so a phone in airplane mode can
// trust it: sequence = the SOS sequence it answers, zone field = the node number, severity nibble = the stage.
export const ACK_STAGE = { picked_up: 1, delivered: 2, unit_assigned: 3 };
export function ackFrame({ stage, sequence, node, language = "en" }, key) {
  return encodeFrame({ type: "ack", zone: DEMO_NODES[node]?.num || 0, target: "unknown", severity: ACK_STAGE[stage] || 1, action: "unknown", language, sequence }, key);
}

// a signed report from a phone or eHawk: check the signature (replays are handled by dedupe, not a window, because
// every node legitimately hears the same frame) and turn it into packet fields
export function readFrame(b64, key) {
  const f = decodeFrame(fromBase64(b64), key, new ReplayWindow());
  if (!f.ok) return f;
  if (f.type !== "sos" && f.type !== "checkin") return { ok: false, error: `a ${f.type} frame is not a report` };
  const zone_id = f.zone >= 1 && f.zone <= 16 ? `Z${String(f.zone).padStart(2, "0")}` : String(f.zone).padStart(4, "0");
  return { ...f, fields: { zone_id, target: f.target, severity: f.severity || 3, action: f.action, language: f.language, content_status: f.target === "unknown" ? "partial" : "extracted", identifier: `frame:${f.type}:${zone_id}:${f.sequence}`, text: f.type === "sos" ? "sos beacon" : "" } };
}
export const RELAY_WINDOW_MS = 10 * 60 * 1000; // the same frame inside 10 minutes is the same message (team judgment)
const PAD_M = 120;                              // extra radius beyond the farthest hearing node (team judgment)

// the same message, whoever heard it and however many times the beacon repeated it: type, zone, content and sequence,
// not the minute stamp or the signature (a repeating beacon keeps one sequence for one emergency)
export function frameKey(body) {
  if (body.frame_id) return createHash("sha256").update(String(body.frame_id)).digest("hex").slice(0, 24);
  if (!body.frame_b64) return null;
  const b = fromBase64(body.frame_b64);
  if (b.length !== 16) return createHash("sha256").update(String(body.frame_b64)).digest("hex").slice(0, 24);
  return createHash("sha256").update(Buffer.concat([b.subarray(0, 5), b.subarray(9, 11)])).digest("hex").slice(0, 24);
}

function meters(a, b) {
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR, dLon = (b.lon - a.lon) * toR;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// the area covered by the nodes that heard it: their centroid, out to the farthest one plus padding
export function approxArea(nodeIds, nodes = DEMO_NODES) {
  const pts = nodeIds.map((id) => nodes[id]).filter(Boolean);
  if (!pts.length) return null;
  const c = { lat: pts.reduce((s, p) => s + p.lat, 0) / pts.length, lon: pts.reduce((s, p) => s + p.lon, 0) / pts.length };
  const radius = Math.round(Math.max(0, ...pts.map((p) => meters(c, p))) + PAD_M);
  return { lat: Number(c.lat.toFixed(5)), lon: Number(c.lon.toFixed(5)), radius_m: radius, nodes: nodeIds.length, simulated: true };
}

// returns { duplicate: true, packet } when another node already relayed this frame; otherwise records the first hearing
export function recordHearing(store, body, nowMs = Date.now()) {
  const key = frameKey(body);
  const node = String(body.node_id || "").slice(0, 40);
  const channel = CHANNELS.includes(body.channel) ? body.channel : "radio";
  if (!key || !node) return { key: null };
  store.relays ||= {};
  for (const [k, r] of Object.entries(store.relays)) if (nowMs - r.first_ms > RELAY_WINDOW_MS) delete store.relays[k];
  const seen = store.relays[key];
  if (seen) {
    if (!seen.heard_by.includes(node)) seen.heard_by.push(node);
    seen.hearings.push({ node, channel, at: new Date(nowMs).toISOString() });
    const packet = store.packets.find((p) => p.packet_id === seen.packet_id);
    if (packet) { packet.heard_by = seen.heard_by.slice(); packet.hearings = seen.hearings.slice(-20); packet.approx_area = approxArea(seen.heard_by); }
    store.appendEvent({ event_type: "relay_heard", packet_id: seen.packet_id, actor: "device", provenance: "forwarded", payload_json: { node_id: node, channel, heard_by: seen.heard_by.length } });
    store.save();
    return { key, duplicate: true, packet, heard_by: seen.heard_by, node, channel };
  }
  return { key, node, channel, duplicate: false };
}

export function rememberFirst(store, key, node, packet, nowMs = Date.now(), channel = "radio") {
  if (!key) return;
  store.relays ||= {};
  const at = new Date(nowMs).toISOString();
  store.relays[key] = { packet_id: packet.packet_id, heard_by: [node], hearings: [{ node, channel, at }], first_ms: nowMs };
  packet.heard_by = [node];
  packet.hearings = [{ node, channel, at }];
  packet.picked_up = { node, channel, at };
  packet.approx_area = approxArea([node]);
}

// a zone for a frame that arrived without one: the zone of the first node that heard it
export const zoneOfNode = (node) => DEMO_NODES[node]?.zone_id || null;
