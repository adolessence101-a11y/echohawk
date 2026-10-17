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
  [/house .*fire|fire in|on fire|smoke in|flames|incendio|fuego|humo en/i, "structure_fire"],
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
export function extractRules(text) {
  const t = String(text || "").replace(NEGATED, " ");
  const target = TARGET_RULES.find(([re]) => re.test(t))?.[1] || "unknown";
  const severity = SEVERITY_RULES.find(([re]) => re.test(t))?.[1] || (target === "unknown" ? 1 : 2);
  const zoneMatch = t.match(/\b(zone|zona|rd|district|distrito)\s*([A-Z0-9-]{2,8})\b/i) || t.match(/\b(\d{4})\b/);
  const zone_id = zoneMatch ? (zoneMatch[2] || zoneMatch[1]).toUpperCase() : null;
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
  en: { where: "I'm here to help. Where are you right now? A cross street, landmark or zone number is fine.", what: "Thank you. Tell me what's happening.", logged: "Got it. I've logged that and it's on the dispatcher's board. Is anyone hurt or in danger right now?" },
  es: { where: "Estoy aquí para ayudar. ¿Dónde está ahora? Un cruce de calles, un punto de referencia o el número de zona es suficiente.", what: "Gracias. Cuénteme qué está pasando.", logged: "Entendido. Ya lo registré y está en el tablero del despachador. ¿Hay alguien herido o en peligro en este momento?" },
};
export async function agentReply(transcript, { fields, kitScript, mode, language = "en" }) {
  if (kitScript?.length) return kitScript.join(" "); // read the approved card verbatim, nothing else
  const out = await complete([
    { role: "system", content: `You are EchoHawk, an overflow and non-emergency intake line working behind a 911 center. You are not 911. Speak in the caller's language. Ask one question at a time. Collect: where (a zone, cross street or landmark; never ask for a full address unless needed for help to arrive), what is happening, how severe, what they need. Never give medical steps or any instruction that is not an approved card. If anything sounds life-threatening, say you are connecting them to a dispatcher now. Never hang up without a next step.` },
    ...transcript.map((t) => ({ role: t.role === "agent" ? "assistant" : "user", content: t.content })),
  ]).catch(() => null);
  if (out) return out;
  // rule-based fallback, in the caller's language when we have it
  const f = FALLBACK[language] || FALLBACK.en;
  if (!fields?.zone_id) return f.where;
  if (fields.target === "unknown") return f.what;
  return f.logged;
}
