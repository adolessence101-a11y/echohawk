// Node relays (mentor feedback, Oct 17): one chirp can be heard by several pole-mounted nodes at once. It must count once,
// and which nodes heard it narrows where it came from. The nodes do not need to know where the sender is; the server does,
// because it knows where each node is mounted.
// Node positions here are SIMULATED demo nodes (labeled on screen). Range and the radius padding are team judgment.
import { createHash } from "node:crypto";

export const DEMO_NODES = {
  "N-0812-A": { lat: 34.0466, lon: -118.5262, zone_id: "Z06", label: "pole, Sunset & Swarthmore (simulated)" },
  "N-0812-B": { lat: 34.0481, lon: -118.5233, zone_id: "Z06", label: "pole, Via de la Paz (simulated)" },
  "N-0812-C": { lat: 34.0449, lon: -118.5228, zone_id: "Z06", label: "pole, Monument St (simulated)" },
  "N-0812-D": { lat: 34.0428, lon: -118.5291, zone_id: "Z07", label: "pole, Temescal (simulated)" },
};
export const RELAY_WINDOW_MS = 10 * 60 * 1000; // the same frame inside 10 minutes is the same message (team judgment)
const PAD_M = 120;                              // extra radius beyond the farthest hearing node (team judgment)

export function frameKey(body) {
  const raw = body.frame_id || body.frame_b64;
  return raw ? createHash("sha256").update(String(raw)).digest("hex").slice(0, 24) : null;
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
  if (!key || !node) return { key: null };
  store.relays ||= {};
  for (const [k, r] of Object.entries(store.relays)) if (nowMs - r.first_ms > RELAY_WINDOW_MS) delete store.relays[k];
  const seen = store.relays[key];
  if (seen) {
    if (!seen.heard_by.includes(node)) seen.heard_by.push(node);
    const packet = store.packets.find((p) => p.packet_id === seen.packet_id);
    if (packet) { packet.heard_by = seen.heard_by.slice(); packet.approx_area = approxArea(seen.heard_by); }
    store.appendEvent({ event_type: "relay_heard", packet_id: seen.packet_id, actor: "device", provenance: "forwarded", payload_json: { node_id: node, heard_by: seen.heard_by.length } });
    store.save();
    return { key, duplicate: true, packet, heard_by: seen.heard_by };
  }
  return { key, node, duplicate: false };
}

export function rememberFirst(store, key, node, packet, nowMs = Date.now()) {
  if (!key) return;
  store.relays ||= {};
  store.relays[key] = { packet_id: packet.packet_id, heard_by: [node], first_ms: nowMs };
  packet.heard_by = [node];
  packet.approx_area = approxArea([node]);
}

// a zone for a frame that arrived without one: the zone of the first node that heard it
export const zoneOfNode = (node) => DEMO_NODES[node]?.zone_id || null;
