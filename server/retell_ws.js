// Retell custom LLM websocket handler (docs/docs/BUILD_SPEC.md Section 6.1, docs/IMPLEMENTATION_PLAN.md Section 3.1).
// Retell -> us: ping_pong | call_details | update_only | response_required | reminder_required (interaction_type)
// us -> Retell: config | response | agent_interrupt | tool_call_invocation | tool_call_result | metadata (response_type)
import { WebSocketServer } from "ws";
import { config } from "./config.js";
import { scanTurn } from "./triggers.js";
import { extractFields, agentReply, translate, detectLanguage, nextFallbackLine } from "./llm.js";
import { LANG } from "./languages.js";

// Short system lines in the caller's language: English and Spanish are fixed text; the other 13 are translated by the
// model once and cached, with English as the fallback if translation is slow or unavailable.
const LINES = {
  connect: { en: "I'm connecting you to a dispatcher right now. Stay on the line.", es: "Le estoy conectando con un despachador ahora mismo. No cuelgue." },
  takeover: { en: "A dispatcher is on the line with you now. Keep talking, we can hear you.", es: "Un despachador está en la línea con usted ahora. Siga hablando, le escuchamos." },
};
const lineCache = new Map();
export const GREETING = "You've reached EchoHawk, the city's overflow line. I'm an automated assistant, and a person can join any time, just say person. Para español, hable en español. Where are you right now?";
async function lineIn(key, lang) {
  const l = LINES[key]; if (l[lang]) return l[lang];
  if (!LANG[lang]) return l.en;
  const ck = key + ":" + lang; if (lineCache.has(ck)) return lineCache.get(ck);
  const tr = await Promise.race([translate(l.en, lang, "en"), new Promise((r) => setTimeout(() => r(null), 2500))]).catch(() => null);
  if (tr && !tr.startsWith(`[${lang}]`)) { lineCache.set(ck, tr); return tr; }
  return l.en;
}
import { config as _cfg } from "./config.js";
import { makePacket } from "./schema.js";
import { showKitCard, kitForFields } from "./kits.js";

export class RetellHub {
  constructor({ store, engine }) {
    this.store = store; this.engine = engine;
    this.sessions = new Map(); // call_id -> session
  }

  attach(httpServer) {
    this.wss = new WebSocketServer({ noServer: true });
    httpServer.on("upgrade", (req, socket, head) => {
      const m = req.url.match(/^\/retell\/llm\/([^/?]+)/);
      if (!m) { socket.destroy(); return; }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, decodeURIComponent(m[1])));
    });
    return this;
  }

  onConnection(ws, callId) {
    const s = { callId, ws, transcript: [], fields: null, packetSent: false, dispatcherJoined: false, transferStarted: false, unintelligible: 0, interruptSeq: 0, callerLang: "en", startedAt: new Date().toISOString() };
    this.sessions.set(callId, s);
    if (!this.store.calls.find((c) => c.id === callId)) this.store.calls.push({ id: callId, started_at: s.startedAt, ended_at: null, language: "und", direction: "inbound", mode: "tuesday", status: "active", transfer_path: "none", dispatcher_id: null });
    this.store.appendEvent({ event_type: "call_started", call_id: callId, actor: "system", provenance: "firsthand", payload_json: {} });
    this.send(ws, { response_type: "config", config: { auto_reconnect: true, call_details: true, transcript_with_tool_calls: true } });
    // speak first and say what this is: an automated line, a person can join any time (the New Orleans lesson: callers
    // were not told they were talking to AI). Response id 0 is Retell's slot for the opening line.
    this.send(ws, { response_type: "response", response_id: 0, content: GREETING, content_complete: true });
    ws.on("message", (raw) => this.onMessage(s, raw).catch((e) => console.error("ws handler error", e)));
    ws.on("close", () => { this.sessions.delete(callId); const c = this.store.calls.find((x) => x.id === callId); if (c && !c.ended_at) { c.ended_at = new Date().toISOString(); c.status = c.status === "transferred" ? c.status : "ended"; } this.store.appendEvent({ event_type: "call_ended", call_id: callId, actor: "system", provenance: "firsthand", payload_json: {} }); this.store.save(); });
  }

  send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }

  async onMessage(s, raw) {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    switch (msg.interaction_type) {
      case "ping_pong": return this.send(s.ws, { response_type: "ping_pong", timestamp: msg.timestamp });
      case "call_details": { s.callerLang = msg.call?.metadata?.language || s.callerLang; const c = this.store.calls.find((x) => x.id === s.callId); if (c) c.language = s.callerLang; return; }
      case "update_only": this.absorbTranscript(s, msg.transcript); return;
      case "reminder_required": return this.respond(s, msg, { reminder: true });
      case "response_required": return this.respond(s, msg, {});
      default: return;
    }
  }

  absorbTranscript(s, transcript = []) {
    // Retell sends the FULL transcript every time, and the last turn keeps growing while the person is still talking.
    // So: update turns we already have when their text changed, append the ones we don't have yet.
    const list = transcript || [];
    const fresh = [];
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      const known = s.transcript[i];
      if (known) {
        if (known.content !== t.content) {
          known.content = t.content;
          const row = this.store.turns.find((x) => x.call_id === s.callId && x.idx === i);
          if (row) { row.text_original = t.content; row.ts_updated = new Date().toISOString(); }
          this.store.appendEvent({ event_type: "turn_updated", call_id: s.callId, actor: t.role === "agent" ? "ai" : "device", provenance: "firsthand", payload_json: { idx: i, role: t.role, text: t.content } });
        }
        continue;
      }
      s.transcript.push({ role: t.role, content: t.content });
      fresh.push(t);
      this.store.turns.push({ id: this.store.nextId("tn"), call_id: s.callId, idx: i, role: t.role, text_original: t.content, text_translated: null, lang_original: s.callerLang, ts: new Date().toISOString() });
      this.store.appendEvent({ event_type: "turn_added", call_id: s.callId, actor: t.role === "agent" ? "ai" : "device", provenance: "firsthand", payload_json: { role: t.role, text: t.content } });
    }
    // translate finished user turns for a joined dispatcher (on every response_required, the user turn is complete)
    if (s.dispatcherJoined) {
      const lastUserIdx = s.transcript.map((t) => t.role).lastIndexOf("user");
      const row = this.store.turns.find((x) => x.call_id === s.callId && x.idx === lastUserIdx);
      if (row && row.translated_from !== row.text_original) {
        const src = row.text_original; row.translated_from = src;
        translate(src, "en", s.callerLang).then((tr) => { row.text_translated = tr; this.store.appendEvent({ event_type: "turn_translated", call_id: s.callId, actor: "system", provenance: "firsthand", payload_json: { role: "user", text: tr } }); });
      }
    }
    return fresh;
  }

  async respond(s, msg, { reminder }) {
    this.absorbTranscript(s, msg.transcript);
    const lastUser = [...s.transcript].reverse().find((t) => t.role === "user")?.content || "";
    // language from the caller's own words; sticky once Spanish is heard
    const lang = detectLanguage(s.transcript.filter((t) => t.role === "user").map((t) => t.content).join(" "), s.callerLang);
    if (lang !== s.callerLang) { s.callerLang = lang; const c = this.store.calls.find((x) => x.id === s.callId); if (c) c.language = lang; this.store.appendEvent({ event_type: "language_detected", call_id: s.callId, actor: "system", provenance: "firsthand", payload_json: { language: lang } });
      // recognized but no matching voice (Cantonese today): put the call in front of a person with an interpreter
      if (LANG[lang] && !LANG[lang].speaks && c && !(c.flags || []).some((f) => f.flag === "needs_interpreter")) { c.flags = [...(c.flags || []), { flag: "needs_interpreter", at: new Date().toISOString(), by: "system" }]; this.store.appendEvent({ event_type: "call_flagged", call_id: s.callId, actor: "system", provenance: "firsthand", payload_json: { flag: "needs_interpreter", language: lang } }); }
    }
    const triggers = scanTurn(lastUser);

    // 1) hard trigger: transfer first, card in parallel, never one gating the other
    if (triggers.isHard && !s.transferStarted) {
      s.transferStarted = true;
      const kitId = kitForFields(s.fields, triggers);
      let kitScript = null;
      if (kitId) { const shown = showKitCard({ kit_id: kitId, zone_id: s.fields?.zone_id, call_id: s.callId, language: s.callerLang }, this.store, "ai"); if (shown.ok) { kitScript = shown.script_lines; this.send(s.ws, { response_type: "metadata", metadata: { show_kit_card: shown } }); } }
      this.store.appendEvent({ event_type: "trigger_fired", call_id: s.callId, actor: "system", provenance: "firsthand", payload_json: { triggers: triggers.hard, kit_id: kitId } });
      await this.ensurePacket(s, { triggers, force: true });
      const line = kitScript ? kitScript.join(" ") : await lineIn("connect", s.callerLang);
      this.send(s.ws, { response_type: "response", response_id: msg.response_id, content: line, content_complete: true, ...this.transferDirective(s) });
      return;
    }

    // 2) unintelligible handling (NENA two-attempt fail-safe)
    if (lastUser && lastUser.trim().length < 2) { s.unintelligible += 1; if (s.unintelligible >= config.retell.unintelligibleAttemptsBeforeTransfer && !s.transferStarted) { s.transferStarted = true; this.send(s.ws, { response_type: "response", response_id: msg.response_id, content: "Let me connect you to a person who can help.", content_complete: true, ...this.transferDirective(s) }); return; } }

    // 3) extraction and packet
    await this.ensurePacket(s, { triggers });

    // 4) dispatcher has joined: the AI stays quiet except for reminders
    if (s.dispatcherJoined) { if (reminder) this.send(s.ws, { response_type: "response", response_id: msg.response_id, content: "", content_complete: true }); return; }

    // 5) non-emergency escalation after N turns
    const userTurns = s.transcript.filter((t) => t.role === "user").length;
    if (userTurns >= config.retell.nonEmergencyEscalateAfterTurns && !s.transferStarted && (s.fields?.severity || 1) >= 4) { s.transferStarted = true; this.send(s.ws, { response_type: "response", response_id: msg.response_id, content: "I want a person to take this from here. Connecting you now.", content_complete: true, ...this.transferDirective(s) }); return; }

    // 6) kit on Tuesday (power out, low severity)
    let kitScript = null;
    const kitId = kitForFields(s.fields, triggers);
    if (kitId && !s.kitShown) { const shown = showKitCard({ kit_id: kitId, zone_id: s.fields?.zone_id, call_id: s.callId, language: s.callerLang }, this.store, "ai"); if (shown.ok) { s.kitShown = kitId; kitScript = shown.script_lines; this.send(s.ws, { response_type: "metadata", metadata: { show_kit_card: shown } }); } }

    if (kitScript || _cfg.llm.apiKey) {
      const content = await agentReply(s.transcript, { fields: s.fields, kitScript, mode: "tuesday", language: s.callerLang, reminder });
      this.send(s.ws, { response_type: "response", response_id: msg.response_id, content, content_complete: true });
      return;
    }
    // no model configured: stateful rule-based dialog (never repeats a question; ends politely; "yes, someone is hurt" transfers)
    if (reminder) { this.send(s.ws, { response_type: "response", response_id: msg.response_id, content: (await agentReply([], { language: s.callerLang, reminder: true })), content_complete: true }); return; }
    const step = nextFallbackLine(s.transcript, { fields: s.fields, language: s.callerLang });
    if (step.transfer && !s.transferStarted) { s.transferStarted = true; this.store.appendEvent({ event_type: "trigger_fired", call_id: s.callId, actor: "system", provenance: "firsthand", payload_json: { triggers: ["caller_reports_injury"] } }); }
    this.send(s.ws, { response_type: "response", response_id: msg.response_id, content: step.content, content_complete: true, ...(step.end_call ? { end_call: true } : {}), ...(step.transfer ? this.transferDirective(s) : {}) });
  }

  async ensurePacket(s, { triggers, force = false }) {
    const text = s.transcript.filter((t) => t.role === "user").map((t) => t.content).join("\n");
    s.fields = await extractFields(text);
    const intake = this.store.packets.find(p => p.call_id === s.callId && p.request_kind === 'emergency_call');
    if (intake) { this.engine.refine(intake, { ...s.fields, language: s.callerLang, content_status: s.fields.complete ? 'extracted' : 'partial' }, triggers); s.packetSent = true; return; }
    if (s.packetSent) return;
    if (s.fields.complete || force) {
      const { packet, errors } = makePacket({ source: "voice", zone_id: s.fields.zone_id || "unknown", target: s.fields.target, severity: s.fields.severity, action: s.fields.action, identifier: s.callId, call_id: s.callId, language: s.callerLang, content_status: s.fields.complete ? "extracted" : "partial", mode: this.mode() });
      if (errors.length) { console.warn("packet rejected", errors); return; }
      this.engine.ingest(packet, { triggers });
      s.packetSent = true;
    }
  }

  // Twist 1 funded-capacity governor: beyond paid concurrency, calls are tagged crisis (billing stream) and the board sees it
  mode() { return this.sessions.size > config.paidConcurrency ? "crisis" : "tuesday"; }

  transferDirective(s) {
    const call = this.store.calls.find((c) => c.id === s.callId);
    const dest = process.env.TRANSFER_NUMBER || "";
    if (call) { call.status = "transferred"; call.transfer_path = dest ? "cold_a" : "none"; }
    this.store.appendEvent({ event_type: "transfer_started", call_id: s.callId, actor: "system", provenance: "firsthand", payload_json: { path: dest ? "cold_a" : "console_only", fields: s.fields } });
    // Fallback A: cold transfer with the brief already pushed to the console via events. Primary warm path: TODO after the 10:30 Retell session.
    return dest ? { transfer_number: dest } : {};
  }

  // ----- Interpreter Mode (dispatcher console) -----
  join(callId, dispatcherId) {
    const s = this.sessions.get(callId); if (!s) return { ok: false, status: 404 };
    s.dispatcherJoined = true; const c = this.store.calls.find((x) => x.id === callId); if (c) c.dispatcher_id = dispatcherId;
    this.store.appendEvent({ event_type: "dispatcher_joined", call_id: callId, actor: "dispatcher", provenance: "firsthand", payload_json: { dispatcher_id: dispatcherId } });
    // catch the dispatcher up: translate everything said so far (caller and AI) into English
    if (s.callerLang && s.callerLang !== "en") {
      for (const row of this.store.turns.filter((t) => t.call_id === callId && (t.role === "user" || t.role === "agent") && !t.text_translated && t.translated_from !== t.text_original)) {
        const src = row.text_original; row.translated_from = src;
        translate(src, "en", s.callerLang).then((tr) => { row.text_translated = tr; this.store.appendEvent({ event_type: "turn_translated", call_id: callId, actor: "system", provenance: "firsthand", payload_json: { role: row.role, text: tr } }); }).catch(() => {});
      }
    }
    return { ok: true, caller_language: s.callerLang };
  }
  // Dispatcher takes the call from the AI: join (AI goes quiet) and tell the caller, in their language, a person is on.
  async takeover(callId, dispatcherId = "dispatcher") {
    const s = this.sessions.get(callId); if (!s) return { ok: false, status: 404 };
    this.join(callId, dispatcherId);
    const c = this.store.calls.find((x) => x.id === callId); if (c) { c.status = "transferred"; c.transfer_path = "console_takeover"; }
    const line = await lineIn("takeover", s.callerLang);
    s.interruptSeq += 1;
    this.send(s.ws, { response_type: "agent_interrupt", interrupt_id: s.interruptSeq, content: line, content_complete: true, no_interruption_allowed: false });
    this.store.appendEvent({ event_type: "transfer_started", call_id: callId, actor: "dispatcher", provenance: "firsthand", payload_json: { path: "console_takeover" } });
    return { ok: true, caller_language: s.callerLang };
  }
  async say(callId, text, fromLang = "en") {
    const s = this.sessions.get(callId); if (!s) return { ok: false, status: 404 };
    const toLang = s.callerLang === "und" ? "en" : s.callerLang;
    const sent = toLang === fromLang ? text : await translate(text, toLang, fromLang);
    s.interruptSeq += 1;
    this.send(s.ws, { response_type: "agent_interrupt", interrupt_id: s.interruptSeq, content: sent, content_complete: true, no_interruption_allowed: false });
    s.transcript.push({ role: "agent", content: sent });
    this.store.turns.push({ id: this.store.nextId("tn"), call_id: callId, idx: s.transcript.length - 1, role: "dispatcher", text_original: text, text_translated: sent, lang_original: fromLang, ts: new Date().toISOString() });
    this.store.appendEvent({ event_type: "dispatcher_said", call_id: callId, actor: "dispatcher", provenance: "firsthand", payload_json: { text, sent_text: sent, lang_to: toLang } });
    return { ok: true, sent_text: sent, lang_to: toLang };
  }
  setLanguage(callId, lang) { const s = this.sessions.get(callId); if (s) s.callerLang = lang; const c = this.store.calls.find((x) => x.id === callId); if (c) c.language = lang; }
}
