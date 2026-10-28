import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..");
export const DATA_DIR = process.env.HMM_DATA_DIR
  ? path.resolve(process.env.HMM_DATA_DIR)
  : path.join(ROOT, "data");
export const LOG_DIR = path.join(DATA_DIR, "logs");
export const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
export const EVENT_LOG = path.join(LOG_DIR, "events.jsonl");
export const TRACE_LOG = path.join(LOG_DIR, "traces.jsonl");
export const DB_PATH = path.join(DATA_DIR, "hmm.db");

export function ensureDirs() {
  for (const d of [DATA_DIR, LOG_DIR, UPLOAD_DIR]) mkdirSync(d, { recursive: true });
}
