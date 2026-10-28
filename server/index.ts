// HMM-MAS server entry: boot the substrate (log replay first — JSONL is the source of truth),
// then serve the API and the built UI.
import express from "express";
import path from "node:path";
import { ensureDirs, ROOT, LOG_DIR } from "./paths.js";
import { ensureActivePolicy, activeVersion } from "./policy.js";
import { replayEventsFromLog } from "./ingest/chat.js";
import { rebuildTracesFromLog, traceLog } from "./trace.js";
import { markVectorDirty } from "./vector.js";
import { api, apiErrorHandler } from "./api.js";

const PORT = Number(process.env.PORT || process.env.API_PORT || 8788);

export function bootstrap() {
  ensureDirs();
  ensureActivePolicy();
  const events = replayEventsFromLog();
  const traces = rebuildTracesFromLog();
  markVectorDirty();
  return { events, traces, policy: activeVersion() };
}

export function createApp() {
  const app = express();
  app.use(express.json({ limit: "8mb" }));
  app.use("/api", api);
  app.use(apiErrorHandler);

  const webDist = path.join(ROOT, "dist", "web");
  app.use(express.static(webDist));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api")) return next();
    res.sendFile(path.join(webDist, "index.html"), (err) => {
      if (err) res.status(404).send("UI not built — run `npm run build` or use `npm run dev`");
    });
  });
  return app;
}

const isMain =
  process.env.HMM_AUTOSTART === "1" ||
  (process.argv[1] !== undefined && /(?:^|[\\/])(server\.mjs|server\/index\.ts)$/.test(process.argv[1]));
if (isMain) {
  const info = bootstrap();
  const app = createApp();
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[hmm-mas] api+ui on http://0.0.0.0:${PORT}`);
    console.log(`[hmm-mas] policy=${info.policy} replayed ${info.events.events} events, ${info.traces} traces`);
    console.log(`[hmm-mas] logs in ${LOG_DIR} (${traceLog.size} trace lines)`);
  });
}
