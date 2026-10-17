// EchoHawk server entry point. `npm start` then open http://localhost:8787 (board), /console, /app, /chirp.
import "./env.js";
import { config } from "./config.js";
import { Store } from "./store.js";
import { Engine } from "./engine.js";
import { RetellHub } from "./retell_ws.js";
import { createHttpServer } from "./http.js";
import { loadAdjacency, loadBaselines } from "./seed.js";

const store = new Store("data/db.json");
const engine = new Engine(store, { adjacency: loadAdjacency() });
if (store.baselines.length === 0) loadBaselines(store);
const hub = new RetellHub({ store, engine });
const server = createHttpServer({ store, engine, hub });
hub.attach(server);
server.listen(config.port, () => {
  console.log(`EchoHawk on http://localhost:${config.port}  board=/  console=/console  app=/app  chirp=/chirp`);
  console.log(`Retell custom LLM websocket: ${config.publicBaseUrl.replace(/^http/, "ws")}/retell/llm/{call_id}`);
  console.log(`LLM: ${config.llm.apiKey ? `${config.llm.provider} ${config.llm.model}` : "rule-based script (set ANTHROPIC_API_KEY in .env to use Claude)"}`);
});
