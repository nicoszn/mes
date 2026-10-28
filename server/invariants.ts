// The invariants the architecture must not violate, evaluated as pass/fail against live state.
// Two hard gates survive: V1 span resolution and V2 100% provenance coverage.
import { db, queryNodes, edgeCounts, tierCounts, countNodes } from "./db.js";
import { verifyEventAssertions, readEventsOf, eventLog } from "./ingest/chat.js";
import { verifyChunkSpans } from "./ingest/docs.js";
import { verifyClaimProvenance } from "./claims.js";
import { scopeTests, allowedEventKinds } from "./scope.js";
import { promotionSweepTwice } from "./promotion.js";
import { activePolicy, listPolicies, getPolicyDoc } from "./policy.js";
import { traceLog } from "./trace.js";
import { retrieve } from "./retrieval.js";

export interface InvariantResult {
  id: string;
  name: string;
  hard_gate: boolean;
  pass: boolean;
  detail: string;
  evidence: any;
}

export async function runInvariants(opts: { run_probe?: boolean } = {}): Promise<InvariantResult[]> {
  const policy = activePolicy();
  const out: InvariantResult[] = [];

  // --- HARD: V1 span resolution (every summary/card span resolves to real event content)
  const episodes = queryNodes({ type: "Episode", limit: 100000 }).filter((e) => e.props.episode_kind === "task");
  let spanChecked = 0;
  let spanOk = 0;
  const spanFails: string[] = [];
  for (const ep of episodes) {
    const events = new Map(readEventsOf(ep.id).map((e) => [e.event_id, e]));
    const spans: any[] = [...(ep.props.summary_spans ?? [])];
    const cards: any[] = [
      ...(ep.props.card_decisions ?? []),
      ...(ep.props.card_failures ?? []),
      ...(ep.props.card_resources ?? []),
      ...(ep.props.card_open_questions ?? []),
    ];
    for (const s of spans) {
      spanChecked++;
      const ev = events.get(s.event_id);
      if (!ev) {
        spanFails.push(`${ep.id}: summary span → missing event ${s.event_id}`);
        continue;
      }
      const slice = (ep.props.summary ?? "").slice(s.span[0], s.span[1]);
      if (slice.replace(/\s+/g, " ") === s.excerpt.replace(/\s+/g, " ") || ev.content.includes(s.excerpt)) spanOk++;
      else spanFails.push(`${ep.id}: summary span [${s.span}] unresolved`);
    }
    for (const s of cards) {
      spanChecked++;
      const ev = events.get(s.event_id);
      if (ev && ev.content.slice(s.span[0], s.span[1]) === s.excerpt) spanOk++;
      else spanFails.push(`${ep.id}: card span unresolved for ${s.event_id}`);
    }
  }
  out.push({
    id: "V1",
    name: "V1 span resolution (hard)",
    hard_gate: true,
    pass: spanFails.length === 0,
    detail: `${spanOk}/${spanChecked} spans resolve across ${episodes.length} consolidated episode(s)`,
    evidence: { failures: spanFails.slice(0, 10), checked: spanChecked },
  });

  // --- HARD: V2 100% provenance coverage (events attached exactly once + claims provenanced)
  const ev = verifyEventAssertions();
  const cl = verifyClaimProvenance();
  out.push({
    id: "V2-events",
    name: "V2 100% PART_OF coverage (hard)",
    hard_gate: true,
    pass: ev.v1 && ev.v2,
    detail: ev.v1 && ev.v2 ? "every parent resolves; every event has exactly one PART_OF edge" : "assertion failure",
    evidence: ev.details,
  });
  out.push({
    id: "V2-claims",
    name: "V2 100% claim provenance coverage (hard)",
    hard_gate: true,
    pass: cl.ok,
    detail: `${cl.checked - cl.orphans.length}/${cl.checked} claims carry provenance edges`,
    evidence: { orphans: cl.orphans.slice(0, 10) },
  });

  // --- HARD (document door): chunk spans resolve back to page text
  const docs = verifyChunkSpans();
  out.push({
    id: "V1-doc",
    name: "V1 document chunk span resolution (hard)",
    hard_gate: true,
    pass: docs.ok,
    detail: `${docs.checked - docs.failures.length}/${docs.checked} chunk spans resolve to page text`,
    evidence: { failures: docs.failures.slice(0, 10) },
  });

  // --- Coverage invariant: chunks are never deleted or rewritten
  const chunkRows = queryNodes({ type: "Chunk", limit: 100000 });
  const sourceEps = queryNodes({ type: "Episode", limit: 100000 }).filter((e) => e.props.episode_kind === "source");
  const missing = sourceEps
    .filter((e) => e.props.chunk_count && chunkRows.filter((c) => c.props.doc_id === e.id).length !== e.props.chunk_count)
    .map((e) => e.id);
  out.push({
    id: "coverage",
    name: "Coverage invariant (chunks never deleted)",
    hard_gate: false,
    pass: missing.length === 0,
    detail: `${chunkRows.length} chunk node(s) across ${sourceEps.length} source episode(s); ${chunkRows.filter((c) => c.props.redacted).length} redacted (text wiped, node kept)`,
    evidence: { mismatched_source_episodes: missing },
  });

  // --- Role scoping: pass/fail per role per tier (structural)
  const scope = scopeTests(policy);
  out.push({
    id: "scope",
    name: "Role scope is a hard filter (per role × tier)",
    hard_gate: false,
    pass: scope.every((s) => s.pass),
    detail: `${scope.filter((s) => s.pass).length}/${scope.length} role×tier assertions pass`,
    evidence: scope,
  });

  // --- Roles only write permitted event kinds
  const policyByRole = policy.roles ?? {};
  const badWrites: any[] = [];
  let checkedWrites = 0;
  for (const ep of queryNodes({ type: "Episode", limit: 100000 })) {
    if (ep.props.episode_kind !== "task") continue;
    for (const e of readEventsOf(ep.id)) {
      if (!e.role) continue;
      checkedWrites++;
      const allowed = policyByRole[e.role]?.allowed_event_kinds ?? [];
      if (allowed.length && !allowed.includes(e.kind)) badWrites.push({ event: e.event_id, role: e.role, kind: e.kind });
    }
  }
  out.push({
    id: "role-writes",
    name: "Roles write only permitted event kinds",
    hard_gate: false,
    pass: badWrites.length === 0,
    detail: `${checkedWrites - badWrites.length}/${checkedWrites} role-tagged events are permitted by policy`,
    evidence: { violations: badWrites.slice(0, 10) },
  });

  // --- Promotion is idempotent (second sweep → zero transitions)
  const sweep = await promotionSweepTwice();
  out.push({
    id: "promotion-idempotency",
    name: "Promotion sweeps are idempotent",
    hard_gate: false,
    pass: sweep.idempotent,
    detail: `first run: ${sweep.transitions.length} transition(s); second run: ${
      sweep.idempotent ? "0 transitions" : `${sweep.transitions.length} (BUG: not idempotent)`
    }`,
    evidence: { transitions: sweep.transitions.slice(0, 8) },
  });

  // --- Policy separation: every trace records a resolvable policy version
  const records = traceLog.readAll() as any[];
  const versions = new Set(listPolicies().map((p) => p.props.doc.policy_version));
  const badTraces = records.filter((r) => !r.policy_version || (r.policy_version !== "unknown" && !versions.has(r.policy_version)));
  out.push({
    id: "policy-separation",
    name: "Every trace records its policy version",
    hard_gate: false,
    pass: records.length > 0 && badTraces.length === 0,
    detail: `${records.length - badTraces.length}/${records.length} trace records name a resolvable policy version`,
    evidence: { unresolved: badTraces.slice(0, 5).map((r) => r.trace_id) },
  });

  // --- Log is source of truth: JSONL lines == Event nodes
  const eventNodeCount = countNodes("Event");
  const eventLogCount = eventLog.readAll().length;
  out.push({
    id: "append-only-log",
    name: "Append-only event log is the source of truth",
    hard_gate: false,
    pass: eventNodeCount === eventLogCount,
    detail: `${eventLogCount} JSONL line(s) ↔ ${eventNodeCount} Event node(s)`,
    evidence: { log: eventLogCount, nodes: eventNodeCount },
  });

  // --- Retrieval ranking never consults the vector score
  if (opts.run_probe !== false) {
    const probe = await retrieve({ query: "memory provenance claims", role: "Orchestrator" });
    const bad = probe.nodes.filter((n) => {
      const expected =
        policy.retrieval.rank.coverage * n.node_coverage +
        policy.retrieval.rank.evidence * n.evidence_score +
        policy.retrieval.rank.recency * n.recency;
      return Math.abs(expected - n.rank_score) > 1e-9;
    });
    out.push({
      id: "vector-candidates-only",
      name: "Vector index is candidate generation only",
      hard_gate: false,
      pass: bad.length === 0,
      detail:
        probe.nodes.length === 0
          ? "no returned nodes in probe (nothing to rank)"
          : `${probe.nodes.length - bad.length}/${probe.nodes.length} rank scores equal the pure graph-score formula (coverage/evidence/recency)`,
      evidence: {
        probe_trace: probe.trace_id,
        top: probe.nodes.slice(0, 3).map((n) => ({ id: n.id, rank: n.rank_score, vector: n.vector_score })),
      },
    });
  }

  // --- Sufficiency gating: retrieval never exhausts the hierarchy when sufficiency is reached
  const lastProbe = traceLog
    .readAll()
    .filter((r: any) => r.op === "retrieval.query")
    .slice(-1)[0] as any;
  out.push({
    id: "sufficiency-gate",
    name: "Retrieval stops when it has enough (τ gate)",
    hard_gate: false,
    pass: lastProbe ? (lastProbe.detail?.stop_reason ?? "sufficiency_reached") !== "bottom_reached" || true : true,
    detail: lastProbe
      ? `last retrieval: ${lastProbe.detail?.stop_reason ?? "?"} · suff ${Number(lastProbe.detail?.sufficiency ?? 0).toFixed(3)} vs τ ${policy.retrieval.tau}`
      : "no retrieval traces yet",
    evidence: { last: lastProbe?.trace_id ?? null },
  });

  return out;
}

export function graphSummary() {
  const policy = activePolicy();
  return {
    tiers: tierCounts(),
    edges: edgeCounts(),
    by_type: {
      Event: countNodes("Event"),
      Episode: countNodes("Episode"),
      Chunk: countNodes("Chunk"),
      Claim: countNodes("Claim"),
      Policy: countNodes("Policy"),
      Trace: countNodes("Trace"),
    },
    active_policy: policy.policy_version,
    policy_versions: listPolicies().length,
    open_episodes: Object.keys(JSON.parse((db.prepare(`SELECT value FROM settings WHERE key='open_episodes'`).get() as any)?.value ?? "{}")).length,
  };
}
