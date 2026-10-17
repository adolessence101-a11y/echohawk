// Creates the Retell LLM (custom websocket) and agent from this repo's config. Idempotent by agent name.
// Usage: RETELL_API_KEY=... PUBLIC_BASE_URL=https://... node server/provision_retell.js [--apply]
// Without --apply it prints the plan and exits (dry run). Requires the optional dependency `retell-sdk`.
// Field names below were checked against retell-sdk 6.2.7 type definitions (resources/agent.d.ts). Still confirm the
// voice id and the transfer path at the 10:30 AM session before --apply.
import "./env.js";

const apply = process.argv.includes("--apply");
const apiKey = process.env.RETELL_API_KEY;
const base = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
if (!apiKey) { console.error("RETELL_API_KEY is not set. Put it in .env (never in code)."); process.exit(1); }
if (!base.startsWith("https://")) { console.error("PUBLIC_BASE_URL must be an https URL Retell can reach (ngrok or cloudflared)."); process.exit(1); }

const AGENT_NAME = "EchoHawk Overflow Line";
const plan = {
  agent: {
    agent_name: AGENT_NAME,
    // Custom LLM over websocket: Retell connects to this URL and appends the call_id. No hosted Retell LLM is created.
    response_engine: { type: "custom-llm", llm_websocket_url: `${base.replace(/^https/, "wss")}/retell/llm` },
    voice_id: process.env.RETELL_VOICE_ID || "11labs-Adrian",
    language: "multi",                                   // valid per retell-sdk 6.2.7 agent types (multi-language auto detection)
    webhook_url: `${base}/webhooks/retell`,
    webhook_events: ["call_started", "call_ended", "call_analyzed", "transcript_updated", "transfer_started", "transfer_bridged", "transfer_cancelled", "transfer_ended"],
    opt_out_sensitive_data_storage: true,
    post_call_analysis_data: [
      { type: "enum", name: "target", description: "Infrastructure or person target of the report", choices: ["power", "water", "gas", "power_line", "structure_fire", "wildfire", "road", "flood", "person", "vehicle", "unknown"] },
      { type: "number", name: "severity", description: "Severity 1 to 5" },
      { type: "enum", name: "action", description: "Action the report calls for", choices: ["dispatch_ems", "dispatch_fire", "dispatch_police", "welfare_check", "info_only", "deflect_311", "unknown"] },
      { type: "string", name: "zone_id", description: "Zone, district or cross street. Never a full street address." },
    ],
    // webhook_events and response_engine field names checked against retell-sdk 6.2.7 resources/agent.d.ts
  },
};

console.log("Provisioning plan:\n" + JSON.stringify(plan, null, 2));
if (!apply) { console.log("\nDry run. Re-run with --apply to create or update."); process.exit(0); }

const { default: Retell } = await import("retell-sdk").catch(() => { console.error("retell-sdk not installed: npm i retell-sdk"); process.exit(1); });
const client = new Retell({ apiKey });
const listed = await client.agent.list();
const existing = (Array.isArray(listed) ? listed : listed.items || []).find((a) => a.agent_name === AGENT_NAME); // list() returns { has_more, items } in sdk 6.x
const agent = existing ? await client.agent.update(existing.agent_id, plan.agent) : await client.agent.create(plan.agent);
console.log(existing ? "updated agent" : "created agent", agent.agent_id);
console.log("Next: attach a phone number to this agent in the dashboard, or create a web call from the app with this agent_id.");
