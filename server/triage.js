// Backend triage for reports that arrive without a call-taker: app check-ins and eHawk chirps (mentor feedback, Oct 17:
// people will press the emergency button for a cat in a tree, so the app cannot set its own priority).
// A self-reported severity above SELF_CAP is kept as reported_severity but not trusted until danger words back it up.
// High-consequence targets (fire, gas, downed lines, flood) keep what the resident said: those are never a cat in a tree.
// Corroboration and rungs are unchanged: they already come from independent sources and hard triggers, never from severity.
import { config } from "./config.js";
export const SELF_REPORTED = ["app", "ehawk"];
export const SELF_CAP = 3; // team judgment

export function triageSelfReport(packet, triggers) {
  if (!SELF_REPORTED.includes(packet.source)) return packet;
  if (config.engine.highConsequenceTargets.includes(packet.target)) return packet;
  if (packet.severity > SELF_CAP && !(triggers?.hard || []).length) {
    packet.reported_severity = packet.severity;
    packet.severity = SELF_CAP;
    packet.triage_note = `self-reported ${packet.reported_severity}, held at ${SELF_CAP} until danger words or other callers back it up`;
  }
  return packet;
}
