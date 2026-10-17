// HTTP API, SSE stream, Retell webhook with signature verification, and static UIs. No framework: node:http.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHmac, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { config } from "./config.js";
import { makePacket } from "./schema.js";
import { scheduleCallback, recordCallback, openCallbacks } from "./callbacks.js";
import { catalog, getKit, showKitCard } from "./kits.js";
import { scanTurn } from "./triggers.js";
import { encodeFrame, toBase64, TARGET_CODES, ACTION_CODES, LANG_CODES } from "../device/frame.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".csv": "text/csv", ".png": "image/png", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };

// Retell webhook signature, matched to retell-sdk 6.2.7 lib/webhook_auth.js (verified against the published package):
// header x-retell-signature = "v=<unix ms timestamp>,d=<hex HMAC-SHA256 of (rawBody + timestamp)>", secret = the Retell API key,
// rejected when |now - timestamp| > 5 minutes. Constant-time compare.
export function verifyRetellSignature(rawBody, signatureHeader, secret, { now = Date.now(), timeoutMs = 5 * 60 * 1000 } = {}) {
  if (!secret || !signatureHeader) return false;
  const m = /^v=(\d+),d=([0-9a-f]{64})$/i.exec(String(signatureHeader).trim());
  if (!m) return false;
  const ts = Number(m[1]);
  if (!Number.isSafeInteger(ts) || Math.abs(now - ts) > timeoutMs) return false;
  const expected = createHmac("sha256", secret).update(Buffer.concat([Buffer.from(rawBody), Buffer.from(String(ts))])).digest();
  try { return timingSafeEqual(Buffer.from(m[2], "hex"), expected); } catch { return false; }
}
// Same format, for tests and for the fake webhook sender.
export function signRetellWebhook(rawBody, secret, ts = Date.now()) {
  return `v=${ts},d=${createHmac("sha256", secret).update(Buffer.concat([Buffer.from(rawBody), Buffer.from(String(ts))])).digest("hex")}`;
}

export function createHttpServer({ store, engine, hub }) {
  const sseClients = new Set();
  store.onEvent((ev) => { const data = `event: ${ev.event_type}\ndata: ${JSON.stringify(ev)}\n\n`; for (const res of sseClients) res.write(data); });

  const json = (res, status, body) => { res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" }); res.end(JSON.stringify(body)); };
  const readBody = (req) => new Promise((resolve) => { const chunks = []; req.on("data", (c) => chunks.push(c)); req.on("end", () => resolve(Buffer.concat(chunks))); });
  const role = (req) => { const tok = (req.headers.authorization || "").replace(/^Bearer\s+/i, "") || new URL(req.url, "http://x").searchParams.get("token"); if (tok === config.tokens.supervisor) return "supervisor"; if (tok === config.tokens.dispatcher) return "dispatcher"; return "anon"; };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const path = url.pathname; const method = req.method;
    if (method === "OPTIONS") { res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" }); return res.end(); }
    try {
      // ---- health ----
      if (path === "/health") return json(res, 200, { ok: true, calls_active: hub.sessions.size, paid_concurrency: config.paidConcurrency, mode: hub.mode() });

      // ---- Retell webhook ----
      if (path === "/webhooks/retell" && method === "POST") {
        const raw = await readBody(req);
        if (!verifyRetellSignature(raw, req.headers["x-retell-signature"], config.retellWebhookSecret)) { store.appendEvent({ event_type: "webhook_rejected", actor: "system", provenance: "firsthand", payload_json: { reason: "bad signature" } }); return json(res, 401, { error: "bad signature" }); }
        let body = {}; try { body = JSON.parse(raw.toString()); } catch {}
        const ev = body.event; const call = body.call || {};
        store.appendEvent({ event_type: `retell_${ev}`, call_id: call.call_id || null, actor: "system", provenance: "firsthand", payload_json: { status: call.call_status, analysis: ev === "call_analyzed" ? call.call_analysis : undefined } });
        if (ev === "call_analyzed" && call.call_analysis?.custom_analysis_data) {
          const pk = store.packets.find((p) => p.call_id === call.call_id);
          if (pk && !pk.human_edited) { const a = call.call_analysis.custom_analysis_data; pk.post_call = a; store.appendEvent({ event_type: "packet_reconciled", packet_id: pk.packet_id, call_id: call.call_id, actor: "system", provenance: "firsthand", payload_json: a }); }
        }
        return json(res, 200, { ok: true });
      }

      // ---- packets and incidents ----
      if (path === "/packets" && method === "POST") {
        const body = JSON.parse((await readBody(req)).toString() || "{}");
        const { packet, errors } = makePacket(body);
        if (errors.length) return json(res, 400, { errors });
        const triggers = body.text ? scanTurn(body.text) : { hard: [], soft: [] };
        const out = engine.ingest(packet, { triggers });
        return json(res, 201, { packet_id: packet.packet_id, incident_id: out.incident?.id || null, rung: out.rung, reason: out.reason });
      }
      if (path === "/device/packets" && method === "POST") {
        const body = JSON.parse((await readBody(req)).toString() || "{}");
        const { packet, errors } = makePacket({ ...body, source: body.source || "ehawk", provenance: body.provenance || "forwarded" });
        if (errors.length) return json(res, 400, { errors });
        const out = engine.ingest(packet, {});
        return json(res, 201, { packet_id: packet.packet_id, incident_id: out.incident?.id || null, rung: out.rung });
      }
      if (path === "/incidents" && method === "GET") { const rung = url.searchParams.get("rung"); let list = engine.ranked(); if (rung) list = list.filter((i) => i.rung === rung); return json(res, 200, list); }
      if (path.startsWith("/incidents/") && method === "GET") { const id = path.split("/")[2]; const inc = store.incidents.find((i) => i.id === id); if (!inc) return json(res, 404, { error: "not found" }); return json(res, 200, { ...inc, keys: undefined, packets: store.packets.filter((p) => p.incident_id === id), events: store.events.filter((e) => e.incident_id === id) }); }
      if (path.match(/^\/incidents\/[^/]+\/ack$/) && method === "POST") { const id = path.split("/")[2]; const r = role(req); if (r === "anon") return json(res, 401, { error: "token" }); store.appendEvent({ event_type: "acknowledged_by_human", incident_id: id, actor: r, provenance: "firsthand", payload_json: {} }); return json(res, 200, { ok: true }); }
      if (path.match(/^\/incidents\/[^/]+\/close$/) && method === "POST") { const id = path.split("/")[2]; const r = role(req); if (r === "anon") return json(res, 401, { error: "token" }); const body = JSON.parse((await readBody(req)).toString() || "{}"); const out = engine.close(id, r, body.reason || ""); return json(res, out.ok ? 200 : out.status, out); }
      if (path.match(/^\/incidents\/[^/]+\/callback$/) && method === "POST") { const id = path.split("/")[2]; const body = JSON.parse((await readBody(req)).toString() || "{}"); const row = scheduleCallback(store, id, Number(body.attempt_no) || 1); return json(res, 201, row); }
      if (path === "/zones/windows" && method === "GET") return json(res, 200, store.zoneWindows.slice(-2000));
      if (path.match(/^\/callbacks\/[^/]+\/result$/) && method === "POST") { const id = path.split("/")[2]; const body = JSON.parse((await readBody(req)).toString() || "{}"); const out = recordCallback(store, id, body.result); return json(res, out.ok ? 200 : out.status, out); }
      if (path === "/callbacks/open" && method === "GET") return json(res, 200, openCallbacks(store));

      // ---- calls, transcripts, interpreter mode ----
      if (path === "/calls" && method === "GET") { const active = url.searchParams.get("status") === "active"; const calls = store.calls.filter((c) => !active || c.status === "active" || c.status === "transferred").map((c) => { const pk = store.packets.find((p) => p.call_id === c.id); return { ...c, target: pk?.target, severity: pk?.severity, zone_id: pk?.zone_id, rung: pk?.incident_id ? store.incidents.find((i) => i.id === pk.incident_id)?.rung : null, elapsed_s: Math.round((Date.now() - new Date(c.started_at)) / 1000) }; }); return json(res, 200, calls); }
      if (path.match(/^\/calls\/[^/]+\/transcript$/) && method === "GET") { const id = path.split("/")[2]; return json(res, 200, store.turns.filter((t) => t.call_id === id)); }
      if (path.match(/^\/calls\/[^/]+\/join$/) && method === "POST") { const id = path.split("/")[2]; if (role(req) === "anon") return json(res, 401, { error: "token" }); const body = JSON.parse((await readBody(req)).toString() || "{}"); const out = hub.join(id, body.dispatcher_id || "dispatcher"); return json(res, out.ok ? 200 : out.status, out); }
      if (path.match(/^\/calls\/[^/]+\/say$/) && method === "POST") { const id = path.split("/")[2]; if (role(req) === "anon") return json(res, 401, { error: "token" }); const body = JSON.parse((await readBody(req)).toString() || "{}"); const out = await hub.say(id, body.text || "", body.lang_from || "en"); return json(res, out.ok ? 200 : out.status, out); }
      if (path.match(/^\/calls\/[^/]+\/language$/) && method === "POST") { const id = path.split("/")[2]; const body = JSON.parse((await readBody(req)).toString() || "{}"); hub.setLanguage(id, body.lang); return json(res, 200, { ok: true }); }
      if (path.match(/^\/calls\/[^/]+\/kit$/) && method === "POST") { const id = path.split("/")[2]; if (role(req) === "anon") return json(res, 401, { error: "token" }); const body = JSON.parse((await readBody(req)).toString() || "{}"); if (!body.kit_id) { store.appendEvent({ event_type: "kit_changed_by_human", call_id: id, actor: "dispatcher", provenance: "firsthand", payload_json: { kit_id: null, action: "closed" } }); return json(res, 200, { ok: true, closed: true }); } const out = showKitCard({ kit_id: body.kit_id, call_id: id }, store, "dispatcher"); if (out.ok) store.appendEvent({ event_type: "kit_changed_by_human", call_id: id, actor: "dispatcher", provenance: "firsthand", payload_json: { kit_id: body.kit_id } }); return json(res, out.ok ? 200 : out.status, out); }
      if (path === "/events/stream" && method === "GET") { res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "access-control-allow-origin": "*" }); res.write(`event: hello\ndata: {}\n\n`); sseClients.add(res); req.on("close", () => sseClients.delete(res)); return; }
      if (path === "/events" && method === "GET") return json(res, 200, store.events.slice(-500));

      // ---- kits ----
      if (path === "/kits" && method === "GET") return json(res, 200, catalog);
      if (path.startsWith("/kits/") && method === "GET") { const k = getKit(path.split("/")[2]); return k ? json(res, 200, k) : json(res, 404, { error: "not in catalog" }); }
      if (path === "/tools/show_kit_card" && method === "POST") { const body = JSON.parse((await readBody(req)).toString() || "{}"); const out = showKitCard(body, store, "ai"); return json(res, out.ok ? 200 : out.status, out); }

      // ---- alerts (SAME path) and frames ----
      if (path === "/alerts/same" && method === "POST") {
        const body = JSON.parse((await readBody(req)).toString() || "{}");
        const actionMap = { SPW: "shelter_in_place", EVI: "evacuate", CEM: "info_only", RWT: "info_only" };
        const action = actionMap[body.event_code] || "info_only";
        const seq = (store.alerts ||= []).length + 1;
        const frame = encodeFrame({ type: "directive", zone: Number(body.zone) || 0, target: body.target || "unknown", severity: body.event_code === "EVI" ? 5 : body.event_code === "SPW" ? 4 : 2, action, language: body.language || "en", sequence: seq }, config.frameKey);
        const alert = { id: store.nextId("al"), ...body, action, frame_b64: toBase64(frame), created_at: new Date().toISOString() };
        store.alerts.push(alert);
        store.appendEvent({ event_type: "alert_received", actor: "device", provenance: "firsthand", payload_json: { event_code: body.event_code, locations: body.locations } });
        store.appendEvent({ event_type: "alert_revoiced", actor: "device", provenance: "firsthand", payload_json: { language: body.language || "en", action } });
        return json(res, 201, alert);
      }
      if (path.match(/^\/alerts\/directive\/[^/]+\/frame$/) && method === "GET") { const id = path.split("/")[3]; const a = (store.alerts || []).find((x) => x.id === id); return a ? json(res, 200, { frame_b64: a.frame_b64 }) : json(res, 404, { error: "not found" }); }
      if (path === "/frames/codes" && method === "GET") return json(res, 200, { TARGET_CODES, ACTION_CODES, LANG_CODES });

      // ---- twists and cost ----
      if (path === "/twists" && method === "GET") return json(res, 200, store.twists);
      if (path === "/twists" && method === "POST") { const body = JSON.parse((await readBody(req)).toString() || "{}"); const row = { id: store.nextId("tw"), received_at: new Date().toISOString(), ...body }; store.twists.push(row); store.save(); return json(res, 201, row); }
      if (path === "/cost/meter" && method === "GET") { const minutes = store.calls.reduce((a, c) => a + ((new Date(c.ended_at || Date.now()) - new Date(c.started_at)) / 60000), 0); return json(res, 200, { ts: new Date().toISOString(), calls_active: hub.sessions.size, paid_concurrency: config.paidConcurrency, retell_cents_today: Math.round(minutes * 11), dispatcher_minutes_saved_est: Math.round(store.calls.filter((c) => c.status === "ended").length * 3), stream: hub.mode(), basis: "Retell ~ $0.11/min example rate; minutes saved assumes 3 per fully automated call (team judgment)" }); }

      // ---- static UIs ----
      const map = { "/": "/board/index.html", "/board": "/board/index.html", "/console": "/console/index.html", "/app": "/app/index.html", "/chirp": "/device/chirp_send.html" };
      let file = map[path] || path;
      const full = join(root, file);
      if (full.startsWith(root) && existsSync(full) && !full.includes("node_modules") && !full.endsWith(".env")) { const data = await readFile(full); res.writeHead(200, { "content-type": MIME[extname(full)] || "application/octet-stream" }); return res.end(data); }
      return json(res, 404, { error: "not found" });
    } catch (e) { console.error(e); return json(res, 500, { error: String(e.message || e) }); }
  });
  return server;
}
