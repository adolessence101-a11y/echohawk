# EchoHawk

AI intake and corroboration layer for overloaded 911 and non-emergency lines, with an off-grid household alert path.
It sits behind the 911 center (PSAP); it does not answer 911 and does not replace dispatchers or CAD.

One Retell voice agent takes the overflow in 15 languages, tells callers it is automated, and extracts zone, target, severity
and action from every call. A corroboration engine turns many quiet reports into one visible pattern for a supervisor,
counting independent callers separately from machine sources (alarms never count as people) and flagging a district when its
15-minute volume is unusual against its own LAPD baseline. Dispatchers can listen to any call, interpret through translation,
or take it over. Alerting agencies send public alerts back to residents through the app and through a signed audio chirp that
phones and eHawk household devices verify with no network.

Spec: `docs/BUILD_SPEC.md`. Build plan, acceptance tests and lanes: `docs/IMPLEMENTATION_PLAN.md`. Bob prompts: `docs/prompts.md`.

## Run it

```bash
npm install            # server dependency (ws); retell-sdk is optional and only needed for provisioning
cp .env.example .env   # RETELL_API_KEY for provisioning, ANTHROPIC_API_KEY for Claude; the demo runs with no keys
npm test               # 86 tests, about two seconds
npm start              # http://localhost:8787
npm run build:web      # only after changing web/src: rebuilds the React screens into web/dist (a built copy is committed)
```

| URL | Who | What |
|---|---|---|
| `/board?token=dev-supervisor` | supervisor | counts, ranked incidents with inline details and send buttons, LA district map or zone grid, pop-up alerts for bigger issues, live calls (listen, interpret, take over), units in the field with watchdog timers, close with a disposition, public alert button |
| `/console?token=dev-dispatcher` | dispatcher | live calls first, transcript with translation, Interpreter Mode, takeover, send EMS/Fire/Police/Utility/Callback, unit status, Flag AI, Action Kits |
| `/alerts` | alerting agency | sign in (agency, name, passcode `dev-agency`), draft evacuation order or warning, shelter in place, advisory, all clear; a second person approves before anything goes out; active alerts with resident replies and translation status |
| `/app/` | resident | installable PWA: alerts for your zone in your language with "I'm safe / I've left / I need help", updates on your own reports, call the support line, check in (queued offline), Action Kits offline, listen for a chirp, beacon |
| `/replay` | anyone | a real LA evening (LAPD calls for service) as a guided story and free play |
| `/chirp` | eHawk stand-in | simulate a NOAA SAME burst, sign a 16-byte directive, play it as sound |

The React screens live in `web/` (Vite + React + TypeScript). The previous single-file pages stay at `/legacy/board`,
`/legacy/console`, `/legacy/replay` and `/app/legacy`.

## Demo run of show

1. Board: **Run demo surge**. Water reports in three neighboring districts become one spreading line; five alarms in one
   district stay "alarms only"; two medical calls go straight to "needs a person". Alerts drop in top right.
2. Board or console: **Simulate a live call**. A Spanish caller ("no tenemos agua") stays on for three minutes. Open it:
   listen, **Join interpreter**, type in English and the caller hears Spanish, then **Take over**.
3. Board: expand a row, **Send Utility**, move the unit En route then On scene in "Units in the field". Leave one in Assigned
   for two minutes and it flags as overdue. Close it **as Unable to locate** and a callback lands in the silence panel.
4. Phone (`/app/`, zone 0812): check in about the water. When the unit goes En route the phone shows "A unit is on the way."
5. Board: **Public alert**, send an advisory ("we know, crews are on it, no need to call"). It appears on the phone in the
   phone's language and is read aloud. Ask for an evacuation warning: it lands in `/alerts` as a request.
6. `/alerts`: sign in as one person, draft it; sign in as a second person, **Approve and send**. The phone shows it with
   "I need help", which puts that resident on the board as "needs a person".
7. `/replay`: chapter 2, RD 0802 rang 8 times in 30 seconds on January 7, 2025, flagged at the third ring.

Terminal alternatives: `npm run seed` (the 20-call script), `npm run fake-call -- ws://localhost:8787 spanish_water --hold 180`.
Fake callers: `water | bleeding | breathing | spanish | spanish_water | hangup`.

## Languages

Recognized: English, Spanish, Mandarin, Cantonese, Korean, Tagalog, Armenian, Vietnamese, Farsi, Russian, Arabic, Japanese,
Hindi, Thai, Ukrainian. Chosen from LA County DMH threshold languages plus four LA County languages, limited to what Retell's
speech recognition supports (Khmer is a threshold language Retell does not list). Retell setup: select these languages on the
agent, transcription provider Soniox (the one that covers all 15), and a voice provider that covers Armenian (OpenAI or
ElevenLabs v3). Cantonese has recognition but no voice that pairs with the rest, so Cantonese calls are flagged "needs a
human interpreter". Alerts, system lines and the chirp phrasebook are machine translated by the model and labeled as such;
Action Kits stay in reviewed English and Spanish only.

## Retell (real phone line)

1. Expose the server: `cloudflared tunnel --url http://localhost:8787`. Put the https URL in `PUBLIC_BASE_URL`.
2. Put your key in `.env` as `RETELL_API_KEY` (never in code, never in a Bob prompt).
3. `npm install retell-sdk` then `npm run provision` (dry run) and `npm run provision -- --apply`.
4. Attach a phone number to the agent in the Retell dashboard, or start a web call with the agent id.

The agent uses a custom LLM over websocket (`wss://.../retell/llm/{call_id}`), so our server owns every turn, the kit cards,
the triggers and the transfer decision. With `ANTHROPIC_API_KEY` set, Claude does extraction, replies and translation; without
a key the rule-based fallback runs the demo in English and Spanish.

## Who may send which alert

Protective action decisions (evacuation orders and warnings, shelter in place) are made by law enforcement and fire and sent
by the county Office of Emergency Management. In January 2025 LA County OEM staff sent the Eaton and Palisades alerts in
coordination with the Sheriff and county Fire. So in EchoHawk:

- agency accounts (LA County OEM, Sheriff, Fire, LAPD, LAFD, City of LA EMD) draft and send; a protective action needs a second
  person from an agency to approve it
- the EchoHawk supervisor can send an advisory and can request a protective action, which lands in the agency queue
- this is not Wireless Emergency Alerts; WEA and IPAWS stay with the agency's existing system

## What is real and what is a stand-in

- Real: the Retell custom LLM handler, the engine, triggers, kit mechanism, signed frames and their verification, the LAPD
  baselines and replay, all five screens, the chirp (ggwave, audible, about one meter), the alert approval rules.
- Stand-in: unit status is tapped in on the board; in production it comes from the agency's CAD. The eHawk device is the
  `/chirp` page; NOAA SAME decode is simulated by `POST /alerts/same`. No SMS: updates reach app users, not phone-only callers.
- Heuristic, labeled on screen: the confidence score (1 - 0.5^n over independent callers), the watchdog times (2 min assigned,
  10 min en route, 20 min on scene), and the cost meter rates.

## Layout

```
server/   index.js · http.js (REST, SSE, static) · retell_ws.js (custom LLM, greeting, Interpreter Mode, takeover)
          engine.js (scan + corroboration + spread) · triggers.js · schema.js · kits.js · llm.js (Claude, fallbacks)
          languages.js (15 languages, detection) · broadcasts.js (public alerts, approvals, frames) · units.js (unit status,
          watchdog, dispositions, reporter updates) · callbacks.js · replay.js · seed.js · store.js · config.js · test/
web/      Vite + React + TypeScript: src/board, src/console, src/alerts, src/app, src/replay, src/shared; dist/ is the build
app/      sw.js (offline cache for /app/), manifest, icon; index.html is the legacy page
device/   frame.js (16-byte signed frame, replay window) · chirp_send.html
kits/     catalog.json (EN + ES, sources, review status)
data/     LAPD baselines and replay days
```

## Tests

`npm test` runs the engine, protocol (over a real websocket), Claude provider, security, HTTP, callbacks, SAME decoder, zone,
language detection (one sentence in each of the 15 languages), public alert rules (two-person approval, supervisor limits,
all clear, signed frames, "I need help" escalation) and post-dispatch tests (unit status order, watchdog, unable to locate
schedules a callback, reporter sees "a unit is on the way").
