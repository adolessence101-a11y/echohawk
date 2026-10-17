// Callback ladder — docs/BUILD_SPEC.md Section 8.1 and 8.2, IMPLEMENTATION_PLAN.md A18.
// Rules:
//   scheduleCallback  → pushes a row to store.callbacks, emits callback_scheduled.
//   recordCallback    → sets attempted_at and result; on no_answer emits callback_no_answer and, if attempt_no < 3,
//                       schedules the next attempt. The incident is never closed or marked resolved.
//   openCallbacks     → returns incidents with any callback result "no_answer" or "pending", newest-first,
//                       each with zone_id, target, attempts, last_result, minutes_since_first_report.

export function scheduleCallback(store, incidentId, attemptNo = 1) {
  const id = store.nextId("cb");
  const row = {
    id,
    incident_id: incidentId,
    attempt_no: attemptNo,
    attempted_at: null,
    result: "pending",
    next_step: "call",
  };
  store.callbacks.push(row);
  store.appendEvent({
    event_type: "callback_scheduled",
    incident_id: incidentId,
    actor: "system",
    provenance: "firsthand",
    payload_json: { callback_id: id, attempt_no: attemptNo },
  });
  return row;
}

export function recordCallback(store, callbackId, result) {
  const cb = store.callbacks.find((c) => c.id === callbackId);
  if (!cb) return { ok: false, status: 404, error: "callback not found" };

  const VALID = ["answered", "no_answer", "busy"];
  if (!VALID.includes(result)) return { ok: false, status: 400, error: `result must be one of: ${VALID.join(", ")}` };

  cb.attempted_at = new Date().toISOString();
  cb.result = result;

  if (result === "no_answer") {
    store.appendEvent({
      event_type: "callback_no_answer",
      incident_id: cb.incident_id,
      actor: "system",
      provenance: "firsthand",
      payload_json: { callback_id: callbackId, attempt_no: cb.attempt_no },
    });
    // Schedule the next attempt if under the cap; incident remains open either way.
    if (cb.attempt_no < 3) {
      scheduleCallback(store, cb.incident_id, cb.attempt_no + 1);
    }
  }

  return { ok: true, callback: cb };
}

export function openCallbacks(store) {
  // Collect incident ids that have at least one callback with result "no_answer" or "pending".
  const openIncidentIds = new Set();
  for (const cb of store.callbacks) {
    if (cb.result === "no_answer" || cb.result === "pending") {
      openIncidentIds.add(cb.incident_id);
    }
  }

  const now = Date.now();
  const rows = [];
  for (const incId of openIncidentIds) {
    const inc = store.incidents.find((i) => i.id === incId);
    const cbs = store.callbacks.filter((c) => c.incident_id === incId);
    const answered = cbs.some((c) => c.result === "answered");
    if (answered) continue; // answered callbacks are resolved; skip
    const attempts = cbs.length;
    const lastCb = cbs[cbs.length - 1];
    rows.push({
      incident_id: incId,
      zone_id: inc?.zone_id ?? null,
      target: inc?.target ?? null,
      attempts,
      last_result: lastCb?.result ?? null,
      minutes_since_first_report: inc?.opened_at ? Math.round((now - new Date(inc.opened_at)) / 60000) : null,
      first_report_at: inc?.opened_at ?? null,
    });
  }

  // Newest first (by first_report_at descending, so most recently opened incidents top the list).
  rows.sort((a, b) => new Date(b.first_report_at) - new Date(a.first_report_at));
  return rows;
}
