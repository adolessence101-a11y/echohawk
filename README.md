# EchoHawk

AI intake and corroboration layer for overloaded 911 and non-emergency lines, with an off-grid household alert path.
One Retell voice agent takes the overflow, extracts zone, target, severity and action from every call, and a corroboration
engine turns many quiet reports into one visible pattern for a supervisor. Dispatchers can join any call in Interpreter Mode.
Residents get offline Action Kits, a check-in, and a beacon. An eHawk household device re-voices NOAA alerts and chirps a
signed directive into phones with no network.

Spec: `docs/BUILD_SPEC.md`. Build plan, acceptance tests and lanes: `docs/IMPLEMENTATION_PLAN.md`. Bob prompts: `docs/prompts.md`.

## Run it (two minutes)

```bash
npm install            # one dependency (ws); retell-sdk is optional and only needed for provisioning
cp .env.example .env   # fill RETELL_API_KEY only when you provision; the demo runs with no keys
npm test               # 19 acceptance tests (A1 to A18 subset), about one second
npm start              # http://localhost:8787
```

Then open:

| URL | Who | What |
|---|---|---|
| `/board` | supervisor | ranked "needs a person" list, zone map, what changed, silence panel, twist log, cost meter |
| `/console` | dispatcher | live calls, transcript (original + translated), Join, speak or type, kit controls |
| `/app` | resident | installable PWA: call, check-in, offline Action Kits, beacon, chirp listener |
| `/chirp` | eHawk stand-in | simulate a NOAA SAME burst, sign a 16-byte directive, play it as sound |

Tokens for the two staff pages are `?token=dev-supervisor` and `?token=dev-dispatcher` (defaults; set in `.env`).

## Demo run of show

```bash
# terminal 1
npm start
# terminal 2: fills the board with the 20-call script (3 water calls become one pattern, machine alarms stay machine, people go to the top)
npm run seed
# terminal 3: a live Spanish caller that stays on the line so you can Join from /console
npm run fake-call -- ws://localhost:8787 spanish --hold 180
```

In `/console`: click the call, **Join**, pick "I speak English", hold the mic (or type) and say "A crew is on the way to your block".
The caller side (terminal 3) prints `[caller hears, via dispatcher] ...` in Spanish. The AI is quiet while you are joined.

Chirp: open `/chirp` on the laptop, `/app` on a phone, tap **Listen**, then **Play chirp**. The phone verifies the signature,
rejects replays, and speaks the directive in the household language. Mic access needs a secure context: `localhost` works for
a same-laptop test; for a phone use the same https tunnel URL you give Retell.

Other fake callers: `water | bleeding | breathing | spanish | hangup`. `bleeding` fires the transfer and the approved card at
the same time; `breathing` fires the transfer with no card; `hangup` exercises the unintelligible path.

## Retell (real phone line)

1. Expose the server: `ngrok http 8787` or `cloudflared tunnel --url http://localhost:8787`. Put the https URL in `PUBLIC_BASE_URL`.
2. Put your key in `.env` as `RETELL_API_KEY` (never in code, never in a Bob prompt).
3. `npm install retell-sdk` then `npm run provision` (dry run, prints the agent plan) and `npm run provision -- --apply`.
4. Attach a phone number to the agent in the Retell dashboard, or start a web call with the agent id.

The agent uses a custom LLM over websocket (`wss://.../retell/llm/{call_id}`) so our server owns every turn, the kit cards,
the triggers and the transfer decision. Webhooks go to `/webhooks/retell`, signed `v=<ts>,d=<hmac>` with the API key
(format taken from retell-sdk 6.2.7 `webhook_auth`). Set `TRANSFER_NUMBER` to enable the cold transfer fallback; the warm
transfer path is confirmed at the Saturday Retell session.

With `LLM_BASE_URL`, `LLM_API_KEY` and `LLM_MODEL` set (any OpenAI-compatible endpoint), extraction, replies and Interpreter
Mode translation use the model; without them the rule-based fallback runs the whole demo in English and Spanish, and
translations are shown as `[es] ...` so the pipeline is visible.

## Layout

```
server/      index.js (boot) · http.js (REST + SSE + static) · retell_ws.js (custom LLM protocol, Interpreter Mode)
             engine.js (scan layer + content layer + spread) · triggers.js (hard/soft triggers) · schema.js (packet + independence key)
             kits.js (allowlisted catalog, verbatim) · llm.js (extraction, replies, translation, fallbacks) · seed.js (baselines, 20-call script)
             store.js (JSON store + append-only events) · config.js · provision_retell.js · fake_retell_client.js · test/
device/      frame.js (16-byte signed frame, replay window) · chirp_send.html (eHawk stand-in)
board/ console/ app/   the three interfaces (single files, no build step)
kits/        catalog.json (EN + ES, sources, review status)
data/        rd_baseline_by_hour.csv (LAPD calls for service, Dec 2024 to Jan 2025, hourly baseline per reporting district)
vendor/      ggwave.js (data over sound, MIT)
docs/        prompts.md (Bob prompt chain)
```

## What is real and what is a stand-in

- Real: the Retell custom LLM protocol handler, the engine, the triggers, the kit mechanism, the signed frame, the signature
  check, the LAPD baselines, the three interfaces, the chirp (ggwave, audible, about one meter).
- Stand-in: the eHawk device is the `/chirp` page on a laptop; NOAA SAME decode is simulated by `POST /alerts/same`
  (the hardware lane owns the Si4707 / samedec proof); the fake Retell client replaces the phone line when there are no credits.
- Heuristic, labeled as such on the board: the confidence score (1 - 0.5^n over independent sources) and the cost meter rates.

## Tests

`npm test` runs `server/test/engine.test.js` (A3 to A11, A17, A18, machine sources, address rejection) and
`server/test/protocol.test.js` (A1, A2, A8, A9/A11, A13, A14, A15 over the wire). Every protocol test boots a real server on a
free port and shuts it down in `finally`, so a failing assertion cannot hang the runner.
