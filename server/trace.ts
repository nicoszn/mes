// Instrumentation precedes features: every operation runs inside a trace.
// Durable append-only JSONL is the source of truth; the Trace node + edges are derived from it
// (and rebuilt from the log at boot), so audit(trace_id) can reconstruct "why did this happen".
import { AsyncLocalStorage } from "node:async_hooks";
import { JsonlLog } from "./jsonl.js";
import { TRACE_LOG } from "./paths.js";
import { putNode, queryNodes, db, getNode, putEdge } from "./db.js";
import { TIER_OF } from "./types.js";
import { uid } from "./hash.js";

export const traceLog = new JsonlLog(TRACE_LOG);

export interface TraceRecord {
  trace_id: string;
  parent_id: string | null;
  op: string;
  policy_version: string;
  model_id: string;
  seed: number;
  started_at: number;
  ended_at: number;
  latency_ms: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  outcome: string;
  error: string | null;
  query_text: string | null;
  nodes_touched: string[];
  tiers_descended: number[];
  episode_id?: string | null;
  role?: string | null;
  detail?: Record<string, any>;
}

const store = new AsyncLocalStorage<{ trace: TraceRecord }>();

export class TraceContext {
  readonly record: TraceRecord;
  constructor(parent: TraceRecord | null) {
    this.record = {
      trace_id: uid("tr"),
      parent_id: parent?.trace_id ?? null,
      op: "op",
      policy_version: "unknown",
      model_id: "unknown",
      seed: 0,
      started_at: Date.now(),
      ended_at: 0,
      latency_ms: 0,
      tokens_in: 0,
      tokens_out: 0,
      cost_usd: 0,
      outcome: "ok",
      error: null,
      query_text: null,
      nodes_touched: [],
      tiers_descended: [],
      detail: {},
    };
  }
  set(patch: Partial<TraceRecord>) {
    Object.assign(this.record, patch);
  }
  meta(detail: Record<string, any>) {
    this.record.detail = { ...(this.record.detail ?? {}), ...detail };
  }
  touch(...ids: (string | null | undefined)[]) {
    for (const id of ids) if (id) this.record.nodes_touched.push(id);
  }
  touchAll(ids: (string | null | undefined)[]) {
    this.ids(ids);
  }
  private ids(ids: (string | null | undefined)[]) {
    for (const id of ids) if (id) this.record.nodes_touched.push(id);
  }
  tiers(t: number[]) {
    this.record.tiers_descended = Array.from(new Set([...this.record.tiers_descended, ...t]));
  }
  tokens(inTok: number, outTok: number) {
    this.record.tokens_in += inTok;
    this.record.tokens_out += outTok;
  }
  current(): TraceRecord {
    return this.record;
  }
}

export function currentTrace(): TraceRecord | null {
  return store.getStore()?.trace ?? null;
}

/** Wrap an operation in a trace. Nested calls inherit parent_id. */
export async function withTrace<T>(
  meta: {
    op: string;
    policy_version?: string;
    model_id?: string;
    seed?: number;
    query_text?: string | null;
    episode_id?: string | null;
    role?: string | null;
    detail?: Record<string, any>;
  },
  fn: (ctx: TraceContext) => Promise<T> | T
): Promise<T> {
  const parent = currentTrace();
  const ctx = new TraceContext(parent);
  ctx.set({
    op: meta.op,
    policy_version: meta.policy_version ?? "unknown",
    model_id: meta.model_id ?? "unknown",
    seed: meta.seed ?? 0,
    query_text: meta.query_text ?? null,
    episode_id: meta.episode_id ?? null,
    role: meta.role ?? null,
  });
  if (meta.detail) ctx.meta(meta.detail);
  let result: T;
  try {
    result = await store.run({ trace: ctx.record }, async () => fn(ctx));
    ctx.set({ outcome: (ctx.record.detail?.outcome as string) ?? "ok" });
  } catch (err: any) {
    ctx.set({ outcome: "error", error: String(err?.message ?? err) });
    commit(ctx.record);
    throw err;
  }
  ctx.set({ ended_at: Date.now() });
  ctx.record.latency_ms = ctx.record.ended_at - ctx.record.started_at;
  if (ctx.record.cost_usd === 0 && ctx.record.tokens_out > 0) {
    // cost is normally supplied by the caller via meta; fall back to policy price if given
    ctx.record.cost_usd = ctx.record.detail?.cost_usd ?? 0;
  }
  commit(ctx.record);
  return result;
}

function commit(rec: TraceRecord) {
  if (!rec.ended_at) {
    rec.ended_at = Date.now();
    rec.latency_ms = rec.ended_at - rec.started_at;
  }
  if (rec.outcome === undefined || rec.outcome === null) rec.outcome = "ok";
  traceLog.append(rec as unknown as Record<string, any>);
  writeTraceNode(rec);
}

export function writeTraceNode(rec: TraceRecord) {
  const id = `trc_${rec.trace_id.replace(/^tr_/, "")}`;
  putNode({
    id,
    type: "Trace",
    tier: 0,
    label: `${rec.op} · ${rec.outcome}`,
    props: { ...rec, trace_node_id: id },
    ts: rec.started_at,
  });
  // TRACE_TOUCHED_* for every node the operation touched
  for (const nid of Array.from(new Set(rec.nodes_touched))) {
    const n = getNode(nid);
    if (!n) continue;
    putEdge(`TRACE_TOUCHED_${n.type.toUpperCase()}`, id, nid, 1, { op: rec.op, at: rec.started_at });
  }
  if (rec.parent_id) {
    const pid = `trc_${rec.parent_id.replace(/^tr_/, "")}`;
    if (getNode(pid)) putEdge("TRACE_PARENT", pid, id, 1, { op: rec.op });
  }
  if (rec.policy_version && rec.policy_version !== "unknown") {
    const polId = `pol_${rec.policy_version.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    if (getNode(polId)) putEdge("TRACE_USED_POLICY", id, polId, 1, { op: rec.op });
  }
}

/** Rebuild Trace nodes from the JSONL source of truth (run at boot). */
export function rebuildTracesFromLog(): number {
  const rows = queryNodes({ type: "Trace", limit: 100000 });
  for (const n of rows) {
    db.prepare(`DELETE FROM edges WHERE src=? OR dst=?`).run(n.id, n.id);
  }
  db.prepare(`DELETE FROM nodes WHERE type='Trace'`).run();
  const records = traceLog.readAll();
  for (const rec of records) writeTraceNode(rec as TraceRecord);
  return records.length;
}

export function listTraces(opts: { op?: string; outcome?: string; limit?: number } = {}): TraceRecord[] {
  let rows = traceLog.readAll().reverse();
  if (opts.op) rows = rows.filter((r) => r.op === opts.op);
  if (opts.outcome) rows = rows.filter((r) => r.outcome === opts.outcome);
  return rows.slice(0, opts.limit ?? 200) as TraceRecord[];
}

export function findTrace(traceId: string): TraceRecord | null {
  const wanted = traceId.startsWith("trc_") ? `tr_${traceId.slice(4)}` : traceId;
  return (traceLog.readAll().find((r) => r.trace_id === wanted) as TraceRecord) ?? null;
}

export interface OpStats {
  op: string;
  count: number;
  errors: number;
  error_rate: number;
  avg_latency_ms: number;
  p95_latency_ms: number;
  total_tokens_in: number;
  total_tokens_out: number;
  total_cost_usd: number;
  avg_nodes_touched: number;
  tiers: number[];
}

export function traceStats(): { ops: OpStats[]; totals: any } {
  const records = traceLog.readAll() as TraceRecord[];
  const byOp = new Map<string, TraceRecord[]>();
  for (const r of records) {
    const arr = byOp.get(r.op) ?? [];
    arr.push(r);
    byOp.set(r.op, arr);
  }
  const ops: OpStats[] = [];
  let totals = { count: 0, errors: 0, tokens_in: 0, tokens_out: 0, cost_usd: 0, latency_ms: 0 };
  for (const [op, rs] of byOp) {
    const lats = rs.map((r) => r.latency_ms).sort((a, b) => a - b);
    const errors = rs.filter((r) => r.outcome === "error").length;
    const sum = (f: (r: TraceRecord) => number) => rs.reduce((a, r) => a + (f(r) || 0), 0);
    const p95 = lats[Math.min(lats.length - 1, Math.floor(lats.length * 0.95))] ?? 0;
    const tiers = Array.from(new Set(rs.flatMap((r) => r.tiers_descended ?? []))).sort();
    ops.push({
      op,
      count: rs.length,
      errors,
      error_rate: rs.length ? errors / rs.length : 0,
      avg_latency_ms: lats.length ? lats.reduce((a, b) => a + b, 0) / lats.length : 0,
      p95_latency_ms: p95,
      total_tokens_in: sum((r) => r.tokens_in),
      total_tokens_out: sum((r) => r.tokens_out),
      total_cost_usd: sum((r) => r.cost_usd),
      avg_nodes_touched: rs.length ? sum((r) => r.nodes_touched.length) / rs.length : 0,
      tiers,
    });
    totals.count += rs.length;
    totals.errors += errors;
    totals.tokens_in += sum((r) => r.tokens_in);
    totals.tokens_out += sum((r) => r.tokens_out);
    totals.cost_usd += sum((r) => r.cost_usd);
    totals.latency_ms += sum((r) => r.latency_ms);
  }
  ops.sort((a, b) => b.count - a.count);
  return { ops, totals };
}

/** audit(trace_id): reconstruct "why did this happen" from one ID. */
export interface AuditView {
  trace: TraceRecord;
  parent: TraceRecord | null;
  children: TraceRecord[];
  touched: { id: string; type: string; tier: number; label: string }[];
  policy: any;
  timeline: { at: number; what: string; detail?: any }[];
}

export function auditTrace(traceId: string): AuditView | null {
  const rec = findTrace(traceId);
  if (!rec) return null;
  const all = traceLog.readAll() as TraceRecord[];
  const parent = rec.parent_id ? (all.find((r) => r.trace_id === rec.parent_id) ?? null) : null;
  const children = all.filter((r) => r.parent_id === rec.trace_id);
  const touched = Array.from(new Set(rec.nodes_touched))
    .map((id) => {
      const n = getNode(id);
      return n ? { id: n.id, type: n.type, tier: n.tier, label: n.label } : null;
    })
    .filter(Boolean) as any[];
  const polId = `pol_${rec.policy_version.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
  const polNode = getNode(polId);
  const timeline: AuditView["timeline"] = [
    { at: rec.started_at, what: `op ${rec.op} started`, detail: { policy_version: rec.policy_version, model_id: rec.model_id, seed: rec.seed } },
    ...(rec.query_text ? [{ at: rec.started_at, what: `query: ${rec.query_text}` }] : []),
    ...(rec.tiers_descended?.length ? [{ at: rec.started_at, what: `tiers descended: ${rec.tiers_descended.join(" → ")}` }] : []),
    ...touched.map((t) => ({ at: rec.started_at, what: `touched ${t.type} ${t.id} (${t.label})` })),
    ...(children.length
      ? children.map((c) => ({ at: c.started_at, what: `nested op ${c.op} (${c.outcome})`, detail: { trace_id: c.trace_id } }))
      : []),
    {
      at: rec.ended_at,
      what: `finished: ${rec.outcome}${rec.error ? ` — ${rec.error}` : ""}`,
      detail: { latency_ms: rec.latency_ms, tokens_in: rec.tokens_in, tokens_out: rec.tokens_out, cost_usd: rec.cost_usd },
    },
  ].sort((a, b) => a.at - b.at);
  return { trace: rec, parent, children, touched, policy: polNode?.props?.doc ?? null, timeline };
}
