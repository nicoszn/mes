// Promotion is the SOLE writer of Claim.status, and it is earned through independent
// corroboration — never asserted. Confidence is a pure function of policy-tunable inputs, so
// sweeps are idempotent: a second run yields zero transitions.
import { putNode, queryNodes, edgesOut, edgesIn, getNode, db } from "./db.js";
import { activePolicy, getPolicyDoc, type PolicyDoc } from "./policy.js";
import { claimSupportStats, refreshContradictionCounts } from "./claims.js";
import { withTrace, listTraces } from "./trace.js";
import type { ClaimStatus, GraphNode } from "./types.js";

export function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

export interface ConfidenceBreakdown {
  c: number;
  raw: number;
  sigma: number;
  support_term: number;
  recency: number;
  outcome_strength: number;
  contradiction_mass: number;
  n_episodes: number;
  n_documents: number;
  age_days: number;
  half_life_days: number;
  effective_half_life_days: number;
  usage_corroboration: boolean;
  document_cap_applied: boolean;
  band: "retired" | "provisional" | "trusted";
  band_reasons: string[];
  weights: { w1: number; w2: number; w3: number; w4: number };
}

export function usageEvidenceFor(claim: GraphNode): { trace_id: string; episode_id: string; status: string }[] {
  const traces = listTraces({ limit: 100000 }) as any[];
  const out: { trace_id: string; episode_id: string; status: string }[] = [];
  for (const t of traces) {
    const returned: string[] = t.detail?.returned_claim_ids ?? [];
    if (!returned.includes(claim.id) || !t.episode_id) continue;
    const ep = getNode(t.episode_id);
    if (!ep) continue;
    out.push({ trace_id: t.trace_id, episode_id: t.episode_id, status: ep.props.status });
  }
  return out;
}

export function computeConfidence(claim: GraphNode, policy: PolicyDoc): ConfidenceBreakdown {
  const p = policy.claims;
  const stats = claimSupportStats(claim.id);
  const n = stats.n_episodes + stats.n_documents;

  const support_term = p.weights.w1 * Math.min(1, n / Math.max(0.001, p.min_independent_supports));

  const created_at = claim.props.created_at ?? Date.now();
  const age_days = Math.max(0, (Date.now() - created_at) / 86_400_000);
  const contradiction_count = claim.props.contradiction_count ?? 0;
  const effective_half_life_days = p.half_life_days / (1 + contradiction_count * p.contradiction_decay_boost);
  const recency = Math.pow(0.5, age_days / effective_half_life_days);
  const recency_term = p.weights.w2 * recency;

  const strengths = stats.episode_ids
    .map((id) => {
      const ep = getNode(id);
      const key = ep?.props?.status ?? "ingested";
      return p.outcome_strength[key] ?? 0;
    })
    .filter((x) => typeof x === "number");
  const outcome_strength = strengths.length ? strengths.reduce((a, b) => a + b, 0) / strengths.length : 0;
  const outcome_term = p.weights.w3 * outcome_strength;

  const contradictions = edgesIn(claim.id, "CONTRADICTS").concat(edgesOut(claim.id, "CONTRADICTS"));
  const contradiction_mass = contradictions.reduce((a, e) => a + (e.weight ?? 0), 0);
  const contradiction_term = p.weights.w4 * contradiction_mass;

  const usage = usageEvidenceFor(claim);
  const usage_corroboration = usage.some((u) => u.status === "success");

  const raw = support_term + recency_term + outcome_term - contradiction_term;
  let c = sigmoid(raw);

  // Document-corroboration clause: document-only claims stay below the trusted band unless
  // corroborated by an independent episode, or by usage evidence in a successful episode.
  const document_only = stats.n_episodes === 0 && stats.n_documents > 0;
  let document_cap_applied = false;
  if (document_only && !usage_corroboration) {
    if (c > p.document_trusted_cap) {
      c = p.document_trusted_cap;
      document_cap_applied = true;
    }
  }

  const band_reasons: string[] = [];
  let band: ClaimStatus;
  if (c <= p.bands.retired_max) {
    band = "retired";
    band_reasons.push(`c ${c.toFixed(3)} ≤ retired_max ${p.bands.retired_max}`);
  } else if (c >= p.bands.trusted_min) {
    band = "trusted";
    band_reasons.push(`c ${c.toFixed(3)} ≥ trusted_min ${p.bands.trusted_min}`);
  } else {
    band = "provisional";
    band_reasons.push(`retired_max ${p.bands.retired_max} < c ${c.toFixed(3)} < trusted_min ${p.bands.trusted_min}`);
  }
  if (document_cap_applied) {
    band = band === "trusted" ? "provisional" : band;
    band_reasons.push(`document-only claim capped at document_trusted_cap ${p.document_trusted_cap} (no independent episode or usage corroboration)`);
  }
  if (usage_corroboration && document_only) {
    band_reasons.push(`usage evidence in a successful episode lifts the document-only cap`);
  }
  if (contradiction_count > 0) {
    band_reasons.push(`${contradiction_count} contradiction(s), mass ${contradiction_mass.toFixed(2)} → half-life ${effective_half_life_days.toFixed(1)}d`);
  }

  return {
    c,
    raw,
    sigma: sigmoid(raw),
    support_term,
    recency,
    outcome_strength,
    contradiction_mass,
    n_episodes: stats.n_episodes,
    n_documents: stats.n_documents,
    age_days,
    half_life_days: p.half_life_days,
    effective_half_life_days,
    usage_corroboration,
    document_cap_applied,
    band,
    band_reasons,
    weights: p.weights,
  };
}

export interface Transition {
  claim_id: string;
  text: string;
  from: ClaimStatus;
  to: ClaimStatus;
  confidence: number;
  reasons: string[];
}

export interface SweepResult {
  policy_version: string;
  evaluated: number;
  transitions: Transition[];
  zero_transitions_on_second_run: boolean;
  idempotent: boolean;
  by_status: Record<string, number>;
  ran_at: number;
}

let lastSweep: SweepResult | null = null;

export async function promotionSweep(opts: { policy_version?: string } = {}): Promise<SweepResult> {
  const policy = opts.policy_version ? getPolicyDoc(opts.policy_version) : activePolicy();
  if (!policy) throw new Error("policy not found");

  return await withTrace(
    {
      op: "promotion.sweep",
      policy_version: policy.policy_version,
      model_id: policy.model.model_id,
      seed: policy.model.seed,
    },
    async (t) => {
      refreshContradictionCounts();
      const claims = queryNodes({ type: "Claim", limit: 100000 });
      const transitions: Transition[] = [];
      const by_status: Record<string, number> = { provisional: 0, trusted: 0, retired: 0 };

      for (const claim of claims) {
        const b = computeConfidence(claim, policy);
        const from = (claim.props.status ?? "provisional") as ClaimStatus;
        const to = b.band;
        by_status[to] = (by_status[to] ?? 0) + 1;
        const history = [...(claim.props.history ?? [])].slice(-19);
        if (from !== to) {
          transitions.push({
            claim_id: claim.id,
            text: claim.props.text,
            from,
            to,
            confidence: b.c,
            reasons: b.band_reasons,
          });
          history.push({ at: Date.now(), from, to, confidence: b.c, policy_version: policy.policy_version });
        }
        const stats = claimSupportStats(claim.id);
        putNode({
          ...claim,
          confidence: b.c,
          status: to,
          props: {
            ...claim.props,
            confidence: b.c,
            status: to,
            support_count: stats.n_episodes + stats.n_documents,
            contradiction_count: claim.props.contradiction_count ?? 0,
            config_version: policy.policy_version,
            confidence_breakdown: b,
            usage_evidence: usageEvidenceFor(claim),
            history,
            promoted_at: Date.now(),
          },
        });
        t.touch(claim.id);
      }

      const result: SweepResult = {
        policy_version: policy.policy_version,
        evaluated: claims.length,
        transitions,
        zero_transitions_on_second_run: false,
        idempotent: false,
        by_status,
        ran_at: Date.now(),
      };
      t.meta({ evaluated: claims.length, transitions: transitions.length, by_status });
      lastSweep = result;
      return result;
    }
  );
}

/**
 * A second run over unchanged evidence must produce zero transitions; if it does not,
 * promotion is not idempotent and that is a bug, reported as such.
 */
export async function promotionSweepTwice(opts: { policy_version?: string } = {}): Promise<SweepResult> {
  const first = await promotionSweep(opts);
  const second = await promotionSweep(opts);
  const out: SweepResult = {
    ...first,
    zero_transitions_on_second_run: second.transitions.length === 0,
    idempotent: second.transitions.length === 0,
  };
  lastSweep = out;
  return out;
}

export function lastSweepResult(): SweepResult | null {
  return lastSweep;
}

export function claimDashboard(policy?: PolicyDoc) {
  const claims = queryNodes({ type: "Claim", limit: 100000 });
  const byStatus: Record<string, number> = { provisional: 0, trusted: 0, retired: 0 };
  const byKind: Record<string, number> = { lesson: 0, fact: 0, coordination_pattern: 0 };
  const confidences: number[] = [];
  let docOnly = 0;
  let contradictions = 0;
  for (const c of claims) {
    byStatus[c.status ?? "provisional"] = (byStatus[c.status ?? "provisional"] ?? 0) + 1;
    byKind[c.props.claim_kind] = (byKind[c.props.claim_kind] ?? 0) + 1;
    confidences.push(c.confidence ?? 0);
    const stats = claimSupportStats(c.id);
    if (stats.n_episodes === 0 && stats.n_documents > 0) docOnly++;
    contradictions += c.props.contradiction_count ?? 0;
  }
  const bands = policy?.claims.bands ?? { retired_max: 0.3, provisional_max: 0.6, trusted_min: 0.75 };
  return {
    total: claims.length,
    by_status: byStatus,
    by_kind: byKind,
    avg_confidence: confidences.length ? confidences.reduce((a, b) => a + b, 0) / confidences.length : 0,
    document_only: docOnly,
    contradiction_edges: (db.prepare(`SELECT COUNT(*) c FROM edges WHERE type='CONTRADICTS'`).get() as any).c,
    bands,
    last_sweep: lastSweep,
    histogram: histogram(confidences),
  };
}

function histogram(xs: number[]): { bucket: string; count: number }[] {
  const buckets = ["0.0–0.2", "0.2–0.4", "0.4–0.6", "0.6–0.8", "0.8–1.0"].map((b) => ({ bucket: b, count: 0 }));
  for (const x of xs) {
    const i = Math.min(4, Math.max(0, Math.floor(x * 5)));
    buckets[i].count++;
  }
  return buckets;
}

export function contradictionPairs(): {
  a: string;
  b: string;
  weight: number;
  reason: string;
  a_text: string;
  b_text: string;
  a_status: string;
  b_status: string;
}[] {
  const rows = db.prepare(`SELECT * FROM edges WHERE type='CONTRADICTS'`).all() as any[];
  return rows.map((r) => {
    const props = r.props ? JSON.parse(r.props) : {};
    const a = getNode(r.src);
    const b = getNode(r.dst);
    return {
      a: r.src,
      b: r.dst,
      weight: r.weight,
      reason: props.reason ?? "",
      a_text: a?.props?.text ?? "(missing)",
      b_text: b?.props?.text ?? "(missing)",
      a_status: a?.status ?? "?",
      b_status: b?.status ?? "?",
    };
  });
}
