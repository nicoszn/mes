// T4: the policy layer. One versioned JSON document per version, stored in the graph as
// Policy nodes (tier 4). Nothing downstream hardcodes a number: every threshold, weight,
// band, tau, half-life, model_id and seed is read from the active policy document, and every
// trace records the policy version it ran under.
import { putNode, getNode, queryNodes, getSetting, setSetting, db } from "./db.js";
import { stableStringify, sha256 } from "./hash.js";
import type { GraphNode } from "./types.js";

export interface PolicyDoc {
  policy_version: string;
  created_at: number;
  notes: string;
  model: {
    model_id: string;
    seed: number;
    summarizer_id: string;
    cost_per_1k_tokens: number;
  };
  consolidation: {
    cite_min: number; // V3 hard gate: citations required, clamped to len(events)
    short_episode_threshold: number; // len(events) below this auto-passes V3 with ≥1 citation
    max_summary_tokens: number; // V5 soft band
    v4_band: number; // margin required to pass V4 (soft, status non-contradiction)
    v5_band: number; // length-utilisation band required to pass V5 (soft)
    required_citation_fraction: number; // every decision/failure must cite (fixed 1.0 = hard intent)
  };
  relevance: {
    w_text_density: number;
    w_length: number;
    w_boilerplate: number;
    w_idf: number;
    idf_tau: number; // normalisation 1 - exp(-s/tau)
    length_ref_words: number; // word count at which length_factor saturates
    boilerplate_terms: string[];
    min_relevance_for_promotion: number;
  };
  claims: {
    min_sentence_tokens: number;
    max_sentence_tokens: number;
    min_verb_hits: number;
    min_relevance_for_promotion: number;
    independence: { same_episode: number; different_episode: number; document: number };
    min_independent_supports: number;
    weights: { w1: number; w2: number; w3: number; w4: number };
    half_life_days: number;
    contradiction_decay_boost: number;
    negation_weight: number;
    spo_mismatch_weight: number;
    jaccard_threshold: number;
    bands: { retired_max: number; provisional_max: number; trusted_min: number };
    document_trusted_cap: number;
    outcome_strength: Record<string, number>;
  };
  retrieval: {
    tau: number;
    w_coverage: number;
    w_provenance: number;
    w_recency: number;
    half_life_days: number;
    top_k: number;
    rank: { coverage: number; evidence: number; recency: number };
  };
  vector: { dim: number; candidate_k: number };
  scope: {
    matrix: Record<string, Record<string, number>>;
    predicates: Record<string, Record<string, string>>;
    canonical: Record<string, Record<string, number>>;
    visible_threshold: number;
  };
  roles: Record<string, { allowed_event_kinds: string[]; description: string }>;
  budget: {
    max_turns: number;
    turn_timeout_ms: number;
    episode_timeout_ms: number;
    max_tokens: number;
  };
  chunking: { target_chars: number; overlap_chars: number; min_chars: number };
}

export const DEFAULT_POLICY: PolicyDoc = {
  policy_version: "1.0.0",
  created_at: 0,
  notes: "Baseline calibration. Two hard gates (V1 span resolution, V2 100% provenance coverage) are fixed and not tunable; everything else is [0,1] scoring with bands.",
  model: {
    model_id: "hmm-local-extractive-1",
    seed: 42,
    summarizer_id: "extractive",
    cost_per_1k_tokens: 0.0008,
  },
  consolidation: {
    cite_min: 3,
    short_episode_threshold: 5,
    max_summary_tokens: 220,
    v4_band: 0.5,
    v5_band: 0.95,
    required_citation_fraction: 1.0,
  },
  relevance: {
    w_text_density: 0.35,
    w_length: 0.2,
    w_boilerplate: 0.2,
    w_idf: 0.25,
    idf_tau: 3,
    length_ref_words: 150,
    boilerplate_terms: [
      "copyright",
      "all rights reserved",
      "terms of use",
      "table of contents",
      "disclaimer",
      "confidential",
      "page of",
      "do not distribute",
    ],
    min_relevance_for_promotion: 0.42,
  },
  claims: {
    min_sentence_tokens: 6,
    max_sentence_tokens: 45,
    min_verb_hits: 1,
    min_relevance_for_promotion: 0.42,
    independence: { same_episode: 0.25, different_episode: 1.0, document: 0.75 },
    min_independent_supports: 2,
    weights: { w1: 1.0, w2: 0.35, w3: 0.4, w4: 0.9 },
    half_life_days: 45,
    contradiction_decay_boost: 1.5,
    negation_weight: 0.8,
    spo_mismatch_weight: 0.9,
    jaccard_threshold: 0.5,
    bands: { retired_max: 0.3, provisional_max: 0.6, trusted_min: 0.8 },
    document_trusted_cap: 0.7,
    outcome_strength: {
      success: 1.0,
      ingested: 0.7,
      failure: 0.45,
      aborted: 0.3,
      timeout: 0.3,
      budget_exhausted: 0.15,
      source_redacted: 0.4,
      running: 0.5,
    },
  },
  retrieval: {
    tau: 0.6,
    w_coverage: 0.5,
    w_provenance: 0.3,
    w_recency: 0.2,
    half_life_days: 45,
    top_k: 8,
    rank: { coverage: 0.5, evidence: 0.3, recency: 0.2 },
  },
  vector: { dim: 128, candidate_k: 40 },
  scope: {
    matrix: {
      Planner: { "1": 0.0, "2": 1.0, "3": 1.0, "4": 0.0 },
      Executor: { "1": 1.0, "2": 1.0, "3": 1.0, "4": 0.0 },
      Critic: { "1": 1.0, "2": 1.0, "3": 1.0, "4": 0.0 },
      Orchestrator: { "1": 0.0, "2": 1.0, "3": 1.0, "4": 1.0 },
    },
    predicates: {
      Executor: { "1": "episode_id == current_task_episode", "2": "episode_id == current_task_episode" },
      Critic: { "1": "role == executor" },
    },
    canonical: {
      Planner: { "1": 0.0, "2": 1.0, "3": 1.0, "4": 0.0 },
      Executor: { "1": 1.0, "2": 1.0, "3": 1.0, "4": 0.0 },
      Critic: { "1": 1.0, "2": 1.0, "3": 1.0, "4": 0.0 },
      Orchestrator: { "1": 0.0, "2": 1.0, "3": 1.0, "4": 1.0 },
    },
    visible_threshold: 0.5,
  },
  roles: {
    Planner: {
      description: "Reads T2/T3 (not T1). Writes plan decisions, messages and control events.",
      allowed_event_kinds: ["msg", "decision", "control", "observation"],
    },
    Executor: {
      description: "Reads T1 for its own task slice plus T2/T3. Writes tool calls, results, observations and errors.",
      allowed_event_kinds: ["msg", "tool_call", "tool_result", "observation", "decision", "error", "control"],
    },
    Critic: {
      description: "Reads Executor events plus T3 lessons. Writes review messages, observations, decisions and errors.",
      allowed_event_kinds: ["msg", "observation", "decision", "error", "control"],
    },
    Orchestrator: {
      description: "Reads T2/T3/T4 (not T1). Owns episode lifecycle: open/close, budget and timeout enforcement.",
      allowed_event_kinds: ["msg", "decision", "control", "observation", "error"],
    },
  },
  budget: { max_turns: 12, turn_timeout_ms: 20000, episode_timeout_ms: 180000, max_tokens: 8000 },
  chunking: { target_chars: 900, overlap_chars: 120, min_chars: 80 },
};

export function policyNodeId(version: string): string {
  return `pol_${version.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
}

export function getPolicyDoc(version?: string | null): PolicyDoc | null {
  const v = version ?? getSetting("active_policy_version");
  if (!v) return null;
  const node = getNode(policyNodeId(v));
  if (!node) return null;
  return node.props.doc as PolicyDoc;
}

export function activeVersion(): string {
  return getSetting("active_policy_version") || DEFAULT_POLICY.policy_version;
}

export function activePolicy(): PolicyDoc {
  const doc = getPolicyDoc(activeVersion());
  if (!doc) throw new Error("active policy missing");
  return doc;
}

export function savePolicy(doc: PolicyDoc, source: string): { node: GraphNode; created: boolean } {
  const clean: PolicyDoc = { ...doc, created_at: doc.created_at || Date.now() };
  const id = policyNodeId(clean.policy_version);
  const existing = getNode(id);
  if (existing) {
    // Immutable versions: refuse silent overwrite of a published version.
    const same = stableStringify(existing.props.doc) === stableStringify(clean);
    if (!same) throw new Error(`policy version ${clean.policy_version} already exists (immutable)`);
    return { node: existing, created: false };
  }
  const node = putNode({
    id,
    type: "Policy",
    tier: 4,
    label: `policy ${clean.policy_version}`,
    props: { doc: clean, notes: clean.notes, source, content_hash: sha256(stableStringify(clean)) },
  });
  return { node, created: true };
}

export function activatePolicy(version: string): void {
  if (!getNode(policyNodeId(version))) throw new Error(`unknown policy version: ${version}`);
  setSetting("active_policy_version", version);
}

export function listPolicies(): GraphNode[] {
  return queryNodes({ type: "Policy", order: "created_at" });
}

/** Deep structural diff between two policy versions, for the UI comparison view. */
export function diffPolicies(a: PolicyDoc, b: PolicyDoc): DiffEntry[] {
  const out: DiffEntry[] = [];
  const walk = (x: any, y: any, path: string) => {
    const bothObjects = x && y && typeof x === "object" && typeof y === "object";
    if (!bothObjects) {
      if (stableStringify(x) !== stableStringify(y)) out.push({ path, a: x ?? null, b: y ?? null, kind: "changed" });
      return;
    }
    const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
    for (const k of keys) {
      const p = path ? `${path}.${k}` : k;
      if (!(k in x)) out.push({ path: p, a: null, b: y[k], kind: "added" });
      else if (!(k in y)) out.push({ path: p, a: x[k], b: null, kind: "removed" });
      else walk(x[k], y[k], p);
    }
  };
  walk(a, b, "");
  return out;
}

export interface DiffEntry {
  path: string;
  a: any;
  b: any;
  kind: "added" | "removed" | "changed";
}

export function ensureActivePolicy(): void {
  if (!getSetting("active_policy_version") || !getPolicyDoc()) {
    savePolicy(DEFAULT_POLICY, "seed");
    activatePolicy(DEFAULT_POLICY.policy_version);
  }
}
