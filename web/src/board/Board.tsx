import { useMemo, useRef, useState } from "react";
import { api, token } from "../shared/api";
import type { EventRow, Health, Incident, OpenCallback, Unit, ZoneWindow } from "../shared/types";
import { useEvents, useRefresher } from "../shared/sse";
import { ago, hms } from "../shared/time";
import { DeployBar, UnitChips } from "../shared/ui";
import { AppHeader, Icon, SUPERVISOR_TABS } from "../shared/Brand";
import { rdOf } from "../shared/laMap";
import { isMachineOnly, plainReason, suggest, tName, trig } from "../shared/labels";
import { ZoneGrid } from "./ZoneGrid";
import { MapView } from "./MapView";
import { describe, mergeAlert, PRIO, type Alert, type HistEntry } from "./alerts";
import { FEED_TYPES, feedLine } from "./feed";

const TOK = token("dev-supervisor");
const PRIO_LABEL = { hand: "HAND", ask: "ASK", watch: "WATCH" } as const;

// ---------- sound ----------
let audio: AudioContext | null = null;
let lastChime = 0;
function chime(level: "hand" | "ask") {
  if (!audio || Date.now() - lastChime < 1500) return;
  lastChime = Date.now();
  (level === "hand" ? [880, 660, 880] : [660, 880]).forEach((f, k) => {
    const o = audio!.createOscillator(), g = audio!.createGain(), t = audio!.currentTime + k * 0.16;
    o.type = "sine"; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
    o.connect(g).connect(audio!.destination); o.start(t); o.stop(t + 0.15);
  });
}

// The subtitle under each report: what the people (or machines) on this line are saying, in one plain sentence.
function reportLine(i: Incident): string {
  if (isMachineOnly(i)) return `${i.machine_count} alarm activation${(i.machine_count || 0) > 1 ? "s" : ""}, no people calling yet.`;
  if ((i.triggers || []).length) return `Caller said: ${(i.triggers || []).map(trig).join(", ")}.`;
  const n = i.independent_count;
  if (i.spread_linked_incident_id) return `${n > 1 ? "Multiple residents" : "A resident"} reporting it, also reported next door.`;
  return n > 1 ? `${n} separate callers reporting the same thing.` : "One report so far. Watching for more.";
}

type SortKey = "priority" | "district" | "report" | "sources";

export function Board() {
  const [inc, setInc] = useState<Incident[]>([]);
  const [win, setWin] = useState<ZoneWindow[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [cbs, setCbs] = useState<OpenCallback[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [hist, setHist] = useState<HistEntry[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [minimized, setMinimized] = useState(false);
  const [feed, setFeed] = useState<{ id: number; ts: string; where: string; text: string }[]>([]);
  const [view, setView] = useState<"map" | "zones">("map");
  const [mapNote, setMapNote] = useState("");
  const [pings, setPings] = useState<Record<string, number>>({});
  const [zoneSel, setZoneSel] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState<string | null>(null);
  const [sort, setSort] = useState<{ k: SortKey; dir: 1 | -1 }>({ k: "priority", dir: 1 });
  const [acked, setAcked] = useState<Set<string>>(new Set());
  const [closeErr, setCloseErr] = useState<Record<string, string>>({});
  const [soundOn, setSoundOn] = useState(false);
  const [surging, setSurging] = useState(false);
  const [edge, setEdge] = useState(0);
  const trigSeen = useRef(new Set<string>());
  const incRef = useRef<Record<string, Incident>>({});

  const byId = useMemo(() => Object.fromEntries(inc.map((i) => [i.id, i])), [inc]);
  incRef.current = byId;

  const refresh = async () => {
    const [a, b, c, e] = await Promise.allSettled([api.incidents(), api.windows(), api.health(), api.callbacks()]);
    if (a.status === "fulfilled" && Array.isArray(a.value)) { setInc(a.value); incRef.current = Object.fromEntries(a.value.map((i) => [i.id, i])); }
    if (b.status === "fulfilled" && Array.isArray(b.value)) setWin(b.value);
    if (c.status === "fulfilled") setHealth(c.value);
    if (e.status === "fulfilled" && Array.isArray(e.value)) setCbs(e.value);
  };
  const soon = useRefresher(refresh, 5000);

  const raise = (key: string, patch: Omit<Partial<Alert>, "key">) => {
    if (hist.find((h) => h.key === key && h.closed)) return; // already handled, do not nag
    setAlerts((list) => {
      const { list: next, isNew } = mergeAlert(list, key, patch);
      if (isNew) { setMinimized(false); setEdge((x) => x + 1); chime(patch.level || "hand"); }
      return next;
    });
    setHist((h) => (h.find((x) => x.key === key) ? h : [{ key, at: new Date().toISOString(), closed: false }, ...h]));
  };

  const stream = useEvents(async (ev: EventRow) => {
    const p = ev.payload_json || {};
    if (ev.event_type === "incident_closed" || ev.event_type === "acknowledged_by_human") return soon();
    if (ev.event_type === "packet_created" && p.zone_id) setPings((x) => ({ ...x, [p.zone_id]: Date.now() }));
    if (ev.incident_id && !incRef.current[ev.incident_id]) await refresh();
    if (FEED_TYPES.has(ev.event_type)) {
      const k = ev.incident_id + (p.triggers || []).join();
      const dupe = ev.event_type === "trigger_fired" && trigSeen.current.has(k);
      if (ev.event_type === "trigger_fired") trigSeen.current.add(k);
      if (!dupe) { const l = feedLine(ev, incRef.current); setFeed((f) => [{ id: Math.random(), ts: ev.ts_server, where: l.where && /^Z\d\d$/.test(l.where) ? `District ${rdOf(l.where)}` : l.where, text: l.text }, ...f].slice(0, 60)); }
    }
    const i = ev.incident_id ? incRef.current[ev.incident_id] : undefined;
    if (ev.event_type === "scan_flagged") raise("scan:" + p.zone_id, { kind: "scan", level: "ask", zones: [p.zone_id], incidentIds: Object.values(incRef.current).filter((x) => x.zone_id === p.zone_id).map((x) => x.id), scan: { n: p.n, p_tail: p.p_tail, lambda: p.lambda } });
    if (ev.event_type === "incident_spread") {
      const open = alerts.find((x) => x.kind === "spread" && x.target === p.target && (p.zones || []).some((z: string) => x.zones.includes(z)));
      raise(open ? open.key : `spread:${p.target}:${[...(p.zones || [])].sort()[0]}`, { kind: "spread", level: "hand", target: p.target, zones: p.zones, incidentIds: [ev.incident_id, p.linked_incident_id].filter(Boolean) as string[] });
    }
    if (ev.event_type === "trigger_fired" && i) raise("inc:" + i.id, { kind: "trigger", level: "hand", target: i.target, zones: [i.zone_id], incidentIds: [i.id], triggers: p.triggers || [] });
    if (ev.event_type === "rung_changed" && p.to === "hand" && i) raise("inc:" + i.id, { kind: "hand", level: "hand", target: i.target, zones: [i.zone_id], incidentIds: [i.id] });
    soon();
  });

  // ---------- derived ----------
  const now = Date.now();
  const flagged = useMemo(() => new Set(win.filter((w) => w.flagged && now - +new Date(w.window_start) < 2 * 3600e3).map((w) => w.zone_id)), [win, now]);
  const counts = useMemo(() => { const c: Record<string, number> = {}; for (const w of win) if (now - +new Date(w.window_start) < 3600e3) c[w.zone_id] = (c[w.zone_id] || 0) + w.n; return c; }, [win, now]);
  const sortedAlerts = [...alerts].sort((x, y) => PRIO[x.kind] - PRIO[y.kind] || (y.at < x.at ? -1 : 1));
  const topAlert = sortedAlerts.find((a) => a.key === expanded) || sortedAlerts[0];
  const restAlerts = sortedAlerts.filter((a) => a !== topAlert);
  const alertedZones = new Set(alerts.flatMap((a) => a.zones));
  const n = { hand: inc.filter((i) => i.rung === "hand").length, ask: inc.filter((i) => i.rung === "ask").length, watch: inc.filter((i) => i.rung === "watch").length };
  const order = { hand: 0, ask: 1, watch: 2 };
  const rows = [...inc].sort((a, b) => {
    const d = sort.k === "priority" ? order[a.rung] - order[b.rung] || b.independent_count - a.independent_count
      : sort.k === "district" ? rdOf(a.zone_id).localeCompare(rdOf(b.zone_id))
      : sort.k === "report" ? tName(a.target).localeCompare(tName(b.target))
      : b.independent_count + (b.machine_count || 0) - (a.independent_count + (a.machine_count || 0));
    return d * sort.dir;
  });
  const selInc = sel ? byId[sel] || null : null;

  // ---------- actions ----------
  const deploy = async (ids: string[], unit: Unit) => {
    const r = await Promise.all(ids.map((id) => api.dispatch(TOK, id, [unit], "from supervisor board")));
    await refresh();
    return r.every((x) => x.ok);
  };
  const ack = async (id: string) => { await api.ack(TOK, id); setAcked((s) => new Set(s).add(id)); };
  const closeInc = async (id: string) => { const r = await api.close(TOK, id, "supervisor closed from board"); if (!r.ok) setCloseErr((e) => ({ ...e, [id]: r.data.error || "Could not close" })); else setSel(null); refresh(); };
  const closeAlert = (key: string, how: "dismissed" | "acknowledged") => {
    const a = alerts.find((x) => x.key === key);
    setAlerts((l) => l.filter((x) => x.key !== key));
    setHist((h) => h.map((x) => (x.key === key ? { ...x, closed: how, snap: a } : x)));
    if (expanded === key) setExpanded(null);
  };
  const ackAlert = async (a: Alert) => { await Promise.allSettled(a.incidentIds.map(ack)); closeAlert(a.key, "acknowledged"); refresh(); };
  const reopen = (key: string) => { const h = hist.find((x) => x.key === key); if (!h?.snap) return; setHist((l) => l.map((x) => (x.key === key ? { ...x, closed: false } : x))); setAlerts((l) => [h.snap!, ...l]); setExpanded(key); setMinimized(false); };
  const showOnMap = (a: Alert) => {
    setMinimized(true);
    if (a.incidentIds[0]) setSel(a.incidentIds[0]);
    setZoneSel(new Set(a.zones)); setPings((p) => ({ ...p, ...Object.fromEntries(a.zones.map((z) => [z, Date.now()])) }));
    setTimeout(() => setZoneSel(new Set()), 2500);
    document.querySelector(".mappanel")?.scrollIntoView({ behavior: "smooth", block: "center" });
  };
  const surge = async () => { setSurging(true); await api.surge().catch(() => false); setTimeout(() => setSurging(false), 5000); };
  const armSound = () => { if (!audio) { try { audio = new (window.AudioContext || (window as any).webkitAudioContext)(); setSoundOn(true); } catch { /* no audio */ } } };
  const sortBy = (k: SortKey) => setSort((s) => ({ k, dir: s.k === k ? (s.dir === 1 ? -1 : 1) : 1 }));
  const Th = ({ k, children }: { k: SortKey; children: string }) => <th onClick={() => sortBy(k)} className="sortable">{children} <span className={`sorti ${sort.k === k ? "on" : ""}`}>{sort.k === k && sort.dir === -1 ? "▾" : "▴"}</span></th>;

  return (
    <div className="overview" onPointerDown={armSound}>
      <div key={edge} className={edge ? "edge go" : "edge"} />
      <AppHeader tabs={SUPERVISOR_TABS} current="overview" role="Supervisor" online={stream === "live"}
        right={<>
          <button className="bellbtn" title={soundOn ? "Alert sound on" : "Click anywhere to turn on alert sound"} onClick={() => setMinimized(false)}>{Icon.bell(alerts.length ? "#f2b43c" : "#8d9aae")}{alerts.length > 0 && <span className="n">{alerts.length}</span>}</button>
          <button className="btn-ghost surgebtn" disabled={surging} onClick={surge}>{surging ? "Demo running…" : "▶ Run demo surge"}</button>
        </>} />

      <div className="alerts">
        {minimized && alerts.length > 0 ? (
          <div className="more" onClick={() => setMinimized(false)}>{alerts.length} alert{alerts.length > 1 ? "s" : ""} open · show</div>
        ) : (
          <>
            {topAlert && (() => {
              const d = describe(topAlert, byId);
              const ids = d.incs.map((i) => i.id);
              const title = d.title.replace(/\bZ(\d\d)\b/g, (z) => `District ${rdOf(z)}`);
              return (
                <div className={`alert ${d.cls}`}>
                  <div className="ah"><span className="kind">{d.kind}</span><time>{hms(topAlert.at)}</time></div>
                  <div className="title">{title}</div>
                  <div className="ev">{d.ev.map((e, k) => <span key={k}>{e}</span>)}</div>
                  {d.hint && <div className="hint">{d.hint}</div>}
                  <div className="acts">
                    {d.incs.length > 0 && <DeployBar size="lg" withCallback={false} dispatched={d.incs.flatMap((i) => i.dispatched || [])} suggested={[...new Set(d.incs.flatMap((i) => suggest(undefined, i.target)))]} onSend={(u) => deploy(ids, u)} />}
                    <span className="right">
                      <button onClick={() => showOnMap(topAlert)}>Show on map</button>
                      <button onClick={() => setMinimized(true)}>Minimize</button>
                      {d.incs.length > 0 && <button onClick={() => ackAlert(topAlert)}>Acknowledge</button>}
                      <button onClick={() => closeAlert(topAlert.key, "dismissed")}>Dismiss</button>
                    </span>
                  </div>
                </div>
              );
            })()}
            {restAlerts.slice(0, 3).map((a) => { const d = describe(a, byId); return (
              <div key={a.key} className={`bar ${d.cls}`} onClick={() => setExpanded(a.key)}><span className="kind">{d.kind}</span><span className="bt">{d.title.replace(/\bZ(\d\d)\b/g, (z) => `District ${rdOf(z)}`)}</span><span className="go">open</span></div>
            ); })}
          </>
        )}
      </div>

      <div className="hero"><h1>A clearer picture. A faster decision.</h1></div>

      <div className="statrow">
        <div className="stat"><span className="si">{Icon.person("#e5484d")}</span><div><span>Needs a person</span><b>{String(n.hand).padStart(2, "0")}</b></div></div>
        <div className="stat"><span className="si">{Icon.clipboard("#f2b43c")}</span><div><span>Verify</span><b>{String(n.ask).padStart(2, "0")}</b></div></div>
        <div className="stat"><span className="si">{Icon.eye("#4c9cf0")}</span><div><span>Watching</span><b>{String(n.watch).padStart(2, "0")}</b></div></div>
        <div className="stat"><span className="si">{Icon.phone("#3cc7b4")}</span><div><span>Active calls</span><b>{String(health?.calls_active ?? 0).padStart(2, "0")}</b></div></div>
      </div>

      <div className="split">
        <section className="panel incpanel">
          <div className="ptitle">Current incidents<span className="spacer" />{inc.length > 0 && <span className="muted small">{inc.reduce((a, i) => a + i.packet_ids.length, 0)} calls → {inc.length} lines</span>}</div>
          <table className="inctable">
            <thead><tr><Th k="priority">Priority</Th><Th k="district">District</Th><Th k="report">Report</Th><Th k="sources">Sources</Th><th /></tr></thead>
            <tbody>
              {rows.map((i) => {
                const mo = isMachineOnly(i);
                return (
                  <tr key={i.id} className={sel === i.id ? "on" : ""} onClick={() => setSel(sel === i.id ? null : i.id)}>
                    <td><span className={`prio ${mo ? "machine" : i.rung}`}>{mo ? "ALARM" : PRIO_LABEL[i.rung]}</span></td>
                    <td className="dist">{rdOf(i.zone_id)}</td>
                    <td><div className="rt">{tName(i.target)}{i.spread_linked_incident_id && <span className="mini spread">spreading</span>}{flagged.has(i.zone_id) && <span className="mini flag">unusual volume</span>}{(i.dispatched || []).length > 0 && <span className="mini sent">units sent</span>}</div><div className="rs">{reportLine(i)}</div></td>
                    <td className="src">{i.independent_count}{i.machine_count ? <span className="muted small"> +{i.machine_count} alarm</span> : null}</td>
                    <td className="chev">{Icon.chevron("#8d9aae")}</td>
                  </tr>
                );
              })}
              {!inc.length && <tr><td colSpan={5}><div className="empty">All quiet. Press <b>Run demo surge</b> to play the 20-call stage script, or place a real call.</div></td></tr>}
            </tbody>
          </table>
          {selInc && (
            <div className="drawer">
              <div className="dtop"><span className={`prio ${isMachineOnly(selInc) ? "machine" : selInc.rung}`}>{isMachineOnly(selInc) ? "ALARM" : PRIO_LABEL[selInc.rung]}</span><b>District {rdOf(selInc.zone_id)} · {tName(selInc.target)}</b><span className="muted small">first report {ago(selInc.first_report_at)} ago{selInc.zone_id !== rdOf(selInc.zone_id) ? ` · demo zone ${selInc.zone_id}` : ""}</span><span className="spacer" /><button className="x" onClick={() => setSel(null)}>✕</button></div>
              <div className="dstats"><span><b>{selInc.packet_ids.length}</b> calls → <b>1</b> line</span><span><b>{selInc.independent_count}</b> independent</span>{!!selInc.machine_count && <span><b>{selInc.machine_count}</b> machine</span>}<span>confidence* <b>{Number(selInc.score).toFixed(2)}</b>{selInc.trend === "rising" ? " ↑" : ""}</span></div>
              <div className="why">{closeErr[selInc.id] || (isMachineOnly(selInc) ? "Only alarm activations so far. Likely one cause (power or wind), not separate emergencies. Confirm one address first." : plainReason(selInc.last_reason))}</div>
              <div className="chips">{(selInc.triggers || []).map((t) => <span key={t} className="chip trig">heard: {trig(t)}</span>)}<UnitChips dispatched={selInc.dispatched} />{acked.has(selInc.id) && <span className="chip">seen by supervisor</span>}</div>
              <div className="dacts">
                <DeployBar withCallback={false} dispatched={selInc.dispatched} suggested={suggest(undefined, selInc.target)} onSend={(u) => deploy([selInc.id], u)} />
                <span className="spacer" />
                <button onClick={() => ack(selInc.id)} disabled={acked.has(selInc.id)}>{acked.has(selInc.id) ? "Seen" : "Mark seen"}</button>
                <button onClick={() => closeInc(selInc.id)}>Close</button>
              </div>
            </div>
          )}
        </section>

        <section className="panel mappanel">
          <div className="maphead">
            <span className="maptitle">Los Angeles</span>
            <div className="tabs"><button className={view === "map" ? "on" : ""} onClick={() => setView("map")}>Map</button><button className={view === "zones" ? "on" : ""} onClick={() => setView("zones")}>Zones</button></div>
          </div>
          {view === "map" ? (
            <div className="mapwrap">
              <MapView incidents={inc} flagged={flagged} counts={counts} selected={selInc} onStatus={setMapNote} />
              <div className="maplegend"><span><i style={{ background: "var(--hand)" }} />Needs a person</span><span><i style={{ background: "var(--ask)" }} />Verify</span><span><i style={{ background: "var(--watch)" }} />Watching</span><span><i style={{ background: "var(--machine)" }} />Alarms only</span><span><i className="ring" />District boundary</span></div>
            </div>
          ) : (
            <div className="zonewrap"><ZoneGrid incidents={inc} byId={byId} flagged={flagged} counts={counts} pings={pings} alerted={alertedZones} selected={zoneSel} /></div>
          )}
          <div className="mapnote">{view === "map" ? `LAPD reporting districts, City of LA GIS. ${mapNote}` : "Demo zones Z01 to Z16 for the stage. They sit on West LA districts 0801 to 0834 on the map."}</div>
        </section>
      </div>

      <div className="activity">
        <span className="alabel">{Icon.clock("#c2cbd8")} Recent activity</span>
        <div className="aitems">
          {!feed.length && <span className="muted">Waiting for calls.</span>}
          {feed.slice(0, 4).map((f) => <span key={f.id} className="aitem"><time>{hms(f.ts || new Date().toISOString()).slice(0, 5)}</time>{f.where ? `${f.where} · ` : ""}{f.text}</span>)}
        </div>
        <span className="disclaim">Confidence scores are heuristics, not final determinations. Alarms never count as callers.</span>
        <span title="Confidence is 1 - p^n over independent callers, not a calibrated probability.">{Icon.info("#8d9aae")}</span>
      </div>

      <div className="lower">
        <section className="panel"><div className="ptitle">Alert history</div>
          <div className="feed">
            {!hist.length && <div className="muted">No alerts yet.</div>}
            {hist.map((h) => { const a = alerts.find((x) => x.key === h.key) || h.snap; if (!a) return null; const d = describe(a, byId); return (
              <div key={h.key}><time>{hms(h.at).slice(0, 5)}</time><span className="k" style={{ background: d.cls === "violet" ? "var(--machine)" : d.cls === "amber" ? "var(--ask)" : "var(--hand)" }} /><span>{d.title.replace(/\bZ(\d\d)\b/g, (z) => `District ${rdOf(z)}`)}</span><span className="st">{h.closed ? h.closed : <a href="#" onClick={(e) => { e.preventDefault(); reopen(h.key); }}>open</a>}</span></div>
            ); })}
          </div>
        </section>
        <section className="panel"><div className="ptitle">Silence panel · callbacks nobody answered</div>
          <div className="feed">
            {!cbs.length && <div className="muted">No open callbacks.</div>}
            {cbs.map((c, k) => <div key={k}><span className="k" style={{ background: "var(--ask)" }} /><span><b>District {rdOf(c.zone_id || "")}</b> · {tName(c.target)} · {c.attempts} attempt{c.attempts === 1 ? "" : "s"}, last: {c.last_result}{c.minutes_since_first_report != null ? ` · ${c.minutes_since_first_report} min since first report` : ""}</span></div>)}
          </div>
        </section>
      </div>
    </div>
  );
}
