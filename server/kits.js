// Action Kits and the Source Registry (docs/docs/BUILD_SPEC.md Section 7). The AI picks the card; it never writes it.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
export const catalog = JSON.parse(readFileSync(join(here, "..", "kits", "catalog.json"), "utf8"));
const byId = new Map(catalog.kits.map((k) => [k.kit_id, k]));

export function getKit(kitId) { return byId.get(kitId) || null; }

// Returns the approved script lines or a 404-shaped result. Never invents.
export function showKitCard({ kit_id, zone_id, call_id, language }, store, by = "ai") {
  const kit = getKit(kit_id);
  if (!kit) return { ok: false, status: 404, error: `kit ${kit_id} is not in the catalog` };
  const call = store.calls.find(c => c.id === call_id);
  if (call?.resident_demo === false && kit.medical_review === "pending") return { ok: false, status: 409, error: "Medical kit pending review; use a demo call for preview" };
  // Language variant if the catalog has one (still verbatim from the catalog); English otherwise, and the response says which was served.
  const lang = language && language !== "en" && kit[`script_lines_${language}`] ? language : "en";
  const script_lines = lang === "en" ? kit.script_lines : kit[`script_lines_${lang}`];
  const display_steps = lang === "en" ? kit.display_steps : (kit[`display_steps_${lang}`] || kit.display_steps);
  const row = { id: store.nextId("ks"), call_id: call_id || null, kit_id, shown_at: new Date().toISOString(), by, replaced_by_kit_id: null, closed_at: null };
  if (call_id) for (const old of store.kitShows) if (old.call_id === call_id && !old.closed_at) { old.closed_at = row.shown_at; old.replaced_by_kit_id = kit_id; }
  store.kitShows.push(row);
  store.appendEvent({ event_type: "kit_shown", call_id: call_id || null, actor: by, provenance: "firsthand", payload_json: { kit_id, zone_id: zone_id || null, review_status: kit.medical_review, language_served: lang } });
  return { ok: true, kit_id, title: kit.title, script_lines, display_steps, language_served: lang, review_status: kit.medical_review, requires_human: kit.requires_human, source: { authority: kit.authority, reference_url: kit.reference_url, last_source_check: kit.last_source_check } };
}

export function kitForFields(fields, triggers) {
  if (triggers?.hard?.includes("severe_bleeding")) return "EH-BLEED-001";
  if (fields?.target === "power" && (fields.severity || 1) <= 2) return "EH-LIGHT-001";
  return null;
}
