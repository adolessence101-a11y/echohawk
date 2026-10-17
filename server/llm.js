// One function in front of any OpenAI-compatible chat API, with a rule-based fallback so the demo runs with no key.
// Also: four-field extraction and translation. Model name and base URL come from env (config.llm).
import { config } from "./config.js";
import { TARGETS, ACTIONS } from "./schema.js";

export async function complete(messages, { json = false } = {}) {
  const { baseUrl, apiKey, model } = config.llm;
  if (!baseUrl || !apiKey) return null; // caller falls back to rules
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, temperature: 0.2, ...(json ? { response_format: { type: "json_object" } } : {}) }),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? null;
}

// ---- extraction: four fields from the transcript so far ----
const TARGET_RULES = [
  [/wild ?fire|brush fire|hillside .*fire|embers|humo del cerro|incendio forestal/i, "wildfire"],
  [/house .*fire|fire in|on fire|smoke in|flames|\b(?:structure|building|apartment|garage|kitchen) fire\b|\bfire\b|incendio|fuego|humo en/i, "structure_fire"],
  [/bleeding|breathing|gasping|unconscious|collapsed|passed out|not waking|hurt|injured|chest pain|sick|sangr|respir|desmay|inconsciente|no despierta|herid|dolor/i, "person"], // people before infrastructure
  [/\bgas\b|\bpropane\b|rotten egg|huele a gas|olor a gas|fuga de gas/i, "gas"],
  [/line down|lines down|wire down|cable caído|cable caido|transformer|transformador/i, "power_line"],
  [/power|lights (are )?out|outage|electricity|luz|sin luz|apagón|apagon/i, "power"],
  [/water pressure|no water|water main|flooding street|presión|presion|sin agua|fuga de agua/i, "water"],
  [/flood|flooding|rising water|inundación|inundacion|el agua sube/i, "flood"],
  [/crash|accident|car hit|vehicle|choque|accidente/i, "vehicle"],
  [/road|tree down|blocked|árbol caído|arbol caido|calle bloqueada/i, "road"],
];
const SEVERITY_RULES = [[/dying|not breathing|unconscious|collapsed|gasping|passed out|not waking|trapped|spreading|everywhere|se muere|no respira|desmay|inconsciente|no despierta|atrapad/i, 5], [/bleeding|injured|fire|flames|\bgas\b|sangr|herid|fuego/i, 4], [/smell|smoke|sparks|pressure|huele|humo|chispa|presión/i, 3], [/out|outage|down|sin luz|caído/i, 2]];
const ACTION_FOR_TARGET = { person: "dispatch_ems", structure_fire: "dispatch_fire", wildfire: "dispatch_fire", gas: "dispatch_fire", power_line: "dispatch_fire", vehicle: "dispatch_police", flood: "welfare_check", power: "deflect_311", water: "deflect_311", road: "deflect_311", unknown: "unknown" };

// Negated injury phrases are removed before matching so "no one is hurt" does not become a person report.
const NEGATED = /\b(no one|nobody|no-one|none of us)('s| is| are| was| were| got)? (hurt|injured|bleeding)\b|\bnot (hurt|injured|bleeding)\b|\bno injuries\b|\bnadie (está |esta )?(herido|lastimado)\b|\bno hay heridos\b/gi;
// Zone ids arrive three ways: typed ("Z06", "RD 0802"), spoken digits ("zone 6", "zone 0 6") and spoken words
// ("zone six", "zona seis", "zone zero six"). Speech-to-text writes the last kind as words, so they are parsed here.
const NUM_WORDS = { zero: 0, oh: 0, o: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, cero: 0, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, dieciseis: 16, dieciséis: 16 };
export function extractZone(text) {
  const t = String(text || "");
  // 1) explicit code after the keyword: Z06, 0802, RD-1203
  const code = t.match(/\b(?:zone|zona|rd|district|distrito)\s*[:#]?\s*([A-Z]{1,2}-?\d{1,4}|\d{2,4})\b/i);
  if (code) { const c = code[1].toUpperCase().replace("-", ""); return /^\d+$/.test(c) && c.length <= 2 ? "Z" + c.padStart(2, "0") : c; }
  // 2) spoken digits or number words after the keyword: "zone six", "zone zero six", "zone three o six", "zona seis"
  const spoken = t.match(/\b(?:zone|zona|district|distrito)\s+((?:(?:\d{1,2}|[a-záéíó]+)[\s-]*){1,4})/i);
  if (spoken) {
    const parts = spoken[1].trim().toLowerCase().split(/[\s-]+/).filter(Boolean);
    const digits = [];
    for (const w of parts) { if (/^\d{1,2}$/.test(w)) digits.push(w); else if (w in NUM_WORDS) digits.push(String(NUM_WORDS[w])); else break; }
    if (digits.length) { const n = Number(digits.join("")); if (n >= 1 && n <= 99) return "Z" + String(n).padStart(2, "0"); if (n >= 100) return String(n).padStart(4, "0"); }
  }
  // 3) a bare four-digit reporting district
  const rd = t.match(/\b(\d{4})\b/);
  return rd ? rd[1] : null;
}

export function extractRules(text) {
  const t = String(text || "").replace(NEGATED, " ");
  const target = TARGET_RULES.find(([re]) => re.test(t))?.[1] || "unknown";
  const severity = SEVERITY_RULES.find(([re]) => re.test(t))?.[1] || (target === "unknown" ? 1 : 2);
  const zone_id = extractZone(t);
  return { zone_id, target, severity, action: ACTION_FOR_TARGET[target] || "unknown", complete: Boolean(zone_id && target !== "unknown") };
}

export async function extractFields(transcriptText) {
  const rules = extractRules(transcriptText);
  const llmOut = await complete([
    { role: "system", content: `Extract fields from an emergency/non-emergency call transcript. Return JSON {"zone_id": string|null (a zone/district code or null; NEVER a street address), "target": one of ${TARGETS.join("|")}, "severity": 1-5, "action": one of ${ACTIONS.join("|")}}. Use "unknown" when unsure.` },
    { role: "user", content: transcriptText.slice(-4000) },
  ], { json: true }).catch(() => null);
  if (!llmOut) return rules;
  try {
    const j = JSON.parse(llmOut);
    const target = TARGETS.includes(j.target) ? j.target : rules.target;
    const action = ACTIONS.includes(j.action) ? j.action : (ACTION_FOR_TARGET[target] || "unknown");
    const severity = Number.isInteger(j.severity) && j.severity >= 1 && j.severity <= 5 ? j.severity : rules.severity;
    const zone_id = j.zone_id || rules.zone_id;
    return { zone_id, target, severity, action, complete: Boolean(zone_id && target !== "unknown") };
  } catch { return rules; }
}

// ---- translation for Interpreter Mode ----
const LANG_NAMES = { es: "Spanish", en: "English", ko: "Korean", zh: "Chinese", tl: "Tagalog", hy: "Armenian", vi: "Vietnamese", fa: "Persian" };
export async function translate(text, toLang, fromLang = "auto") {
  const out = await complete([
    { role: "system", content: `Translate the user's text into ${LANG_NAMES[toLang] || toLang}. Keep it short and natural for a phone call. Return only the translation.` },
    { role: "user", content: text },
  ]).catch(() => null);
  return out || `[${toLang}] ${text}`; // fallback keeps the pipeline visible without a key
}

// ---- next agent utterance ----
const FALLBACK = {
  en: { where: "I'm here to help. Where are you right now? A cross street, landmark or zone number is fine.", what: (z) => `Got it, zone ${z}. Tell me what's happening.`, logged: (z) => `Got it. I've logged that for zone ${z} and it's on the dispatcher's board. Is anyone hurt or in danger right now?`, again: "Are you still there? Tell me what's happening and I'll log it." },
  es: { where: "Estoy aquí para ayudar. ¿Dónde está ahora? Un cruce de calles, un punto de referencia o el número de zona es suficiente.", what: (z) => `Entendido, zona ${z}. Cuénteme qué está pasando.`, logged: (z) => `Entendido. Ya lo registré para la zona ${z} y está en el tablero del despachador. ¿Hay alguien herido o en peligro en este momento?`, again: "¿Sigue ahí? Cuénteme qué está pasando y lo registro." },
};
export async function agentReply(transcript, { fields, kitScript, mode, language = "en", reminder = false }) {
  if (kitScript?.length) return kitScript.join(" "); // read the approved card verbatim, nothing else
  if (reminder) return (FALLBACK[language] || FALLBACK.en).again; // caller went quiet: one nudge, not a repeat of the last line
  const out = await complete([
    { role: "system", content: `You are EchoHawk, an overflow and non-emergency intake line working behind a 911 center. You are not 911. Speak in the caller's language. Ask one question at a time. Collect: where (a zone, cross street or landmark; never ask for a full address unless needed for help to arrive), what is happening, how severe, what they need. Never give medical steps or any instruction that is not an approved card. If anything sounds life-threatening, say you are connecting them to a dispatcher now. Never hang up without a next step.` },
    ...transcript.map((t) => ({ role: t.role === "agent" ? "assistant" : "user", content: t.content })),
  ]).catch(() => null);
  if (out) return out;
  // rule-based fallback, in the caller's language when we have it
  const f = FALLBACK[language] || FALLBACK.en;
  if (!fields?.zone_id) return f.where;
  const spokenZone = String(fields.zone_id).replace(/^Z0?/, "");
  if (fields.target === "unknown") return f.what(spokenZone);
  return f.logged(spokenZone);
}
