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

// ---- caller language from what they said (Retell's "multi" STT transcribes Spanish but sends no language tag) ----
const ES_WORDS = /\b(zona|hola|ayuda|por favor|se fue|la luz|sin luz|agua|presi[oó]n|fuego|incendio|humo|herid[oa]|sangr\w*|respira|calle|casa|mi |est[aá]|hay|nadie|s[ií]|gracias|necesito|cuatro|cinco|seis|siete|ocho|nueve|tres|dos|uno|cero|aqu[ií]|ahora|se cay[oó]|no hay|olor a gas)\b/gi;
const EN_WORDS = /\b(the|my|is|are|our|there|water|power|zone|fire|help|someone|hurt|please|no one|street|house|out|have)\b/gi;
export function detectLanguage(text, current = "en") {
  const t = String(text || "");
  if (/[ñ¿¡]/.test(t)) return "es";
  const es = (t.match(ES_WORDS) || []).length, en = (t.match(EN_WORDS) || []).length;
  if (es >= 2 && es > en) return "es";
  if (en >= 2 && en > es) return "en";
  return current;
}

// ---- next agent utterance ----
export const FALLBACK = {
  en: { where: "I'm here to help. Where are you right now? A cross street, landmark or zone number is fine.", what: (z) => `Got it, zone ${z}. Tell me what's happening.`, logged: (z) => `Got it. I've logged that for zone ${z} and it's on the dispatcher's board. Is anyone hurt or in danger right now?`, again: "Are you still there? Tell me what's happening and I'll log it.",
        wrap: (z) => `Thank you. Your report for zone ${z} is on the board, and other reports from your area get grouped with it so the crew sees the whole picture. If anyone gets hurt or it gets worse, call back right away. Is there anything else?`,
        bye: "Thanks for calling. Stay safe.", connect: "I'm connecting you to a dispatcher right now. Stay on the line.", more: (z) => `Okay, I've added that to the zone ${z} report. Anything else?` },
  es: { where: "Estoy aquí para ayudar. ¿Dónde está ahora? Un cruce de calles, un punto de referencia o el número de zona es suficiente.", what: (z) => `Entendido, zona ${z}. Cuénteme qué está pasando.`, logged: (z) => `Entendido. Ya lo registré para la zona ${z} y está en el tablero del despachador. ¿Hay alguien herido o en peligro en este momento?`, again: "¿Sigue ahí? Cuénteme qué está pasando y lo registro.",
        wrap: (z) => `Gracias. Su reporte de la zona ${z} está en el tablero, y los reportes de su área se agrupan con él para que el equipo vea todo el panorama. Si alguien se lastima o empeora, vuelva a llamar de inmediato. ¿Algo más?`,
        bye: "Gracias por llamar. Cuídese.", connect: "Le estoy conectando con un despachador ahora mismo. No cuelgue.", more: (z) => `Bien, lo agregué al reporte de la zona ${z}. ¿Algo más?` },
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
  return nextFallbackLine(transcript, { fields, language }).content;
}

// Rule-based dialog with memory: it knows what it already asked, so it never asks the same question twice.
// Stages: where -> what -> logged + "anyone hurt?" -> wrap-up -> goodbye (ends the call). A "yes" to the hurt question transfers.
const YES = /^\s*(yes|yeah|yep|yup|s[ií]|claro|correcto|someone is|somebody is|he is|she is|they are)\b/i;
const NO = /^\s*(no|nope|nah|nadie|no one|nobody|negative|we're (fine|ok|okay)|all good|estamos bien|nothing|nada)\b/i;
export function nextFallbackLine(transcript, { fields, language = "en" }) {
  const f = FALLBACK[language] || FALLBACK.en;
  const said = (transcript || []).filter((t) => t.role === "agent").map((t) => t.content || "");
  const lastUser = [...(transcript || [])].reverse().find((t) => t.role === "user")?.content || "";
  const asked = (prefix) => said.some((x) => x.startsWith(prefix));
  if (!fields?.zone_id) return { content: asked(f.where.slice(0, 20)) ? f.again : f.where };
  const z = String(fields.zone_id).replace(/^Z0?/, "");
  if (fields.target === "unknown") return { content: asked(f.what(z).slice(0, 12)) ? f.again : f.what(z) };
  const loggedLine = f.logged(z), wrapLine = f.wrap(z);
  if (!asked(loggedLine.slice(0, 25))) return { content: loggedLine };
  if (!asked(wrapLine.slice(0, 20))) {
    if (YES.test(lastUser)) return { content: f.connect, transfer: true };
    return { content: wrapLine };
  }
  if (NO.test(lastUser) || /\b(that's it|that is all|eso es todo|bye|adi[oó]s)\b/i.test(lastUser)) return { content: f.bye, end_call: true };
  return { content: f.more(z) };
}
