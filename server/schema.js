// Packet schema and validation (docs/docs/BUILD_SPEC.md Section 3.1). One schema for every source.
import { createHash } from "node:crypto";
import { config } from "./config.js";

export const SOURCES = ["voice", "app", "ehawk", "telemetry", "field_unit"];
export const TARGETS = ["power", "water", "gas", "power_line", "structure_fire", "wildfire", "road", "flood", "person", "vehicle", "unknown"];
export const ACTIONS = ["dispatch_ems", "dispatch_fire", "dispatch_police", "welfare_check", "info_only", "deflect_311", "unknown"];
export const CONTENT_STATUS = ["extracted", "partial", "none"];
export const PROVENANCE = ["firsthand", "forwarded", "repeat_beacon", "simulated"];

export function independenceKey(identifier, zoneId) {
  // sha256(salt + hashed phone/device id + zone). Repeat transmissions of one SOS reuse the first packet's key.
  return createHash("sha256").update(`${config.salt}|${identifier}|${zoneId}`).digest("hex").slice(0, 32);
}

export function makePacket(input) {
  const errors = [];
  const p = {
    packet_id: input.packet_id || null,
    source: input.source,
    received_at: new Date().toISOString(),
    observed_at: input.observed_at || new Date().toISOString(),
    zone_id: input.zone_id ?? "unknown",
    target: input.target ?? "unknown",
    severity: Number.isInteger(input.severity) ? input.severity : (input.target && input.target !== "unknown" ? 3 : 1),
    action: input.action ?? "unknown",
    independence_key: input.independence_key || independenceKey(input.identifier || "anonymous", input.zone_id ?? "unknown"),
    content_status: input.content_status || (input.target && input.target !== "unknown" ? "extracted" : "none"),
    language: input.language || "und",
    call_id: input.call_id || null,
    provenance: input.provenance || "firsthand",
    mode: input.mode || "tuesday",            // tuesday | crisis (Twist 1 funding stream)
  };
  if (!SOURCES.includes(p.source)) errors.push(`source must be one of ${SOURCES.join(", ")}`);
  if (!TARGETS.includes(p.target)) errors.push(`target must be one of ${TARGETS.join(", ")}`);
  if (!ACTIONS.includes(p.action)) errors.push(`action must be one of ${ACTIONS.join(", ")}`);
  if (!(p.severity >= 1 && p.severity <= 5)) errors.push("severity must be 1..5");
  if (!CONTENT_STATUS.includes(p.content_status)) errors.push("bad content_status");
  if (!PROVENANCE.includes(p.provenance)) errors.push("bad provenance");
  if (/\d+\s+\w+\s+(st|street|ave|avenue|blvd|rd|road|dr|drive)\b/i.test(String(p.zone_id))) errors.push("zone_id looks like a street address; use a zone");
  return { packet: p, errors };
}
