// Shapes returned by the EchoHawk server (server/http.js, server/engine.js, server/replay.js).
export type Rung = "hand" | "ask" | "watch";
export type Unit = "ems" | "fire" | "police" | "utility" | "callback";

export interface Dispatched { unit: Unit; at: string; by: string; note?: string }

export interface Incident {
  id: string;
  zone_id: string;
  target: string;
  rung: Rung;
  score: number;
  trend?: string;
  independent_count: number;
  machine_count?: number;
  first_report_at: string;
  opened_at?: string;
  last_packet_at: string;
  last_reason: string;
  triggers?: string[];
  spread_linked_incident_id?: string | null;
  packet_ids: string[];
  dispatched?: Dispatched[];
}

export interface Packet {
  packet_id: string;
  source: string;
  target: string;
  severity: number;
  received_at: string;
  language?: string;
  provenance: string;
}

export interface ZoneWindow { zone_id: string; window_start: string; n: number; flagged: boolean; p_tail: number | null }

export interface Call {
  id: string;
  started_at: string;
  ended_at: string | null;
  language: string;
  status: "active" | "ended" | "transferred" | "failed";
  transfer_path?: string;
  target?: string;
  severity?: number;
  zone_id?: string;
  rung?: Rung | null;
  action?: string;
  incident_id?: string | null;
  independent_count?: number;
  incident_size?: number;
  triggers?: string[];
  dispatched?: Dispatched[];
  flags?: { flag: string; at: string; by: string }[];
  last_turns?: { role: string; text: string; tr?: string }[];
}

export interface Turn { role: "user" | "agent" | "dispatcher" | "system"; text_original: string; text_translated?: string | null; lang_original?: string }
export interface Kit { kit_id: string; title: string; mode: string; medical_review: string; display_steps?: string[]; summary?: string }
export interface OpenCallback { zone_id?: string; target?: string; attempts: number; last_result: string; minutes_since_first_report?: number | null }
export interface Health { ok: boolean; mode: string; calls_active: number; paid_concurrency: number }
export interface Meter { retell_cents_today: number; dispatcher_minutes_saved_est: number; stream: string }

export interface EventRow {
  event_type: string;
  ts_server: string;
  incident_id?: string;
  call_id?: string;
  actor?: string;
  payload_json?: Record<string, any>;
}

// ---- replay ----
export interface Frame {
  t: string; n: number; id: string; rd: string; area: string; type: string; target: string; machine: boolean;
  incident: string | null; rung: Rung; reason: string; passthrough?: boolean;
  flagged: { zone_id: string; n: number; p_tail: number; lambda: number; window_start: string } | null;
}
export interface ReplayIncident {
  id: string; rd: string; target: string; size: number; independent: number; machine: number; rung: Rung;
  opened: string; last: string; reason: string; area: string; ticket_numbers: number[]; call_types: string[];
  flag: { t: string; ticket: number; nth_in_line: number; window_n: number; p_tail: number; lambda: number } | null;
}
export interface ReplayData {
  error?: string; date: string; fromHour: number; toHour: number; source: string;
  totals: { calls: number; echohawk_lines: number; passthrough_crime: number; grouped_lines: number; calls_in_groups: number; machine_calls: number; scan_flags: number };
  frames: Frame[]; incidents: ReplayIncident[]; flags: { zone_id: string; time: string }[];
}
