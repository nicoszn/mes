// Sufficiency-gated top-down retrieval: start at T3, descend to T2 then T1 ONLY while
// sufficiency is insufficient. The vector index is used strictly for candidate generation;
// final ranking comes from graph structure and scores. Excluded tiers are removed from the
// candidate set structurally (hard filter), never down-ranked.
import { edgesIn, edgesOut, getNode, queryNodes } from "./db.js";
import { normalizeText, tokenize } from "./hash.js";
import { activePolicy, getPolicyDoc, type PolicyDoc } from "./policy.js";
import { excludedTiers, filterByScope, visibleTiers, visibility } from "./scope.js";
import { withTrace } from "./trace.js";
import { vectorSearch, indexedText } from "./vector.js";
import type { GraphNode, Tier } from "./types.js";

export interface TierReport {
  tier: number;
  tier_label: string;
  visibility: number;
  included: boolean;
  excluded_by_scope: boolean;
  predicate: string | null;
  candidate_count: number;
  coverage: number;
  provenance_strength: number;
  recency: number;
  suff: number;
  tau: number;
  stopped_here: boolean;
  note: string;
}

export interface RankedNode {
  id: string;
  type: string;
  tier: number;
  label: string;
  text: string;
  rank_score: number;
  node_coverage: number;
  recency: number;
  evidence_score: number;
  vector_score: number | null;
  status?: string | null;
  confidence?: number | null;
  relevance?: number | null;
  props: Record<string, any>;
}

export interface RetrievalResult {
  query: string;
  role: string;
  policy_version: string;
  tau: number;
  tiers: TierReport[];
  visited_tiers: number[];
  excluded_tiers: number[];
  stopped_at_tier: number | null;
  stop_reason: "sufficiency_reached" | "bottom_reached" | "no_candidates";
  sufficiency: number;
  nodes: RankedNode[];
  provenance_paths: { root: string; kind: string; paths: string[][] }[];
  vector_candidates: { id: string; tier: number; type: string; vector_score: number }[];
  scope: { visible_tiers: number[]; excluded: number[]; predicates: Record<string, string> };
  trace_id: string;
  latency_ms: number;
}

function textOf(n: GraphNode): string {
  if (n.type === "Claim") return n.props.text ?? "";
  if (n.type === "Episode") return [n.props.summary, n.props.task, n.props.filename].filter(Boolean).join(" ");
  if (n.type === "Chunk") return n.props.text ?? "";
  if (n.type === "Event") return n.props.content ?? "";
  if (n.type === "Policy") return n.label;
  return n.label;
}

function provenanceStrength(n: GraphNode): number {
  if (n.type === "Claim") {
    const prov = edgesOut(n.id, "PROVENANCE_EP").length + edgesOut(n.id, "PROVENANCE_CHUNK").length;
    const sup = edgesIn(n.id, "EPISODE_SUPPORTS").length + edgesIn(n.id, "CHUNK_SUPPORTS").length;
    return Math.min(1, (prov > 0 ? 0.7 : 0) + (sup > 0 ? 0.3 : 0));
  }
  if (n.type === "Episode") return edgesIn(n.id, "PART_OF").length > 0 || n.props.episode_kind === "source" ? 1 : 0.5;
  if (n.type === "Chunk") return edgesOut(n.id, "CHUNK_PART_OF").length > 0 ? (n.props.redacted ? 0.5 : 1) : 0.5;
  if (n.type === "Event") return edgesOut(n.id, "PARENT_OF").length > 0 || edgesIn(n.id, "PART_OF").length > 0 ? 1 : 0.6;
  return 1;
}

function recencyOf(n: GraphNode, halfLifeDays: number): number {
  const ts = n.ts ?? n.props.updated_at ?? n.props.created_at ?? n.created_at ?? Date.now();
  const ageDays = Math.max(0, (Date.now() - ts) / 86_400_000);
  return Math.pow(0.5, ageDays / Math.max(0.001, halfLifeDays));
}

function nodeCoverage(texts: string[], queryTokens: Set<string>): number {
  if (queryTokens.size === 0) return 0;
  const union = new Set<string>();
  for (const t of texts) for (const tok of tokenize(t)) union.add(tok);
  let hit = 0;
  for (const q of queryTokens) if (union.has(q)) hit++;
  return hit / queryTokens.size;
}

function evidenceScore(n: GraphNode): number {
  if (n.type === "Claim") return n.confidence ?? 0;
  if (n.type === "Episode") return n.props.relevance ?? (n.status === "success" ? 1 : 0.5);
  if (n.type === "Chunk") return n.relevance ?? 0;
  return 0.5;
}

export interface RetrievalOptions {
  query: string;
  role: string;
  policy_version?: string;
  episode_id?: string | null;
  top_k?: number;
}

export async function retrieve(opts: RetrievalOptions): Promise<RetrievalResult> {
  const started = Date.now();
  const policy = opts.policy_version ? getPolicyDoc(opts.policy_version) : activePolicy();
  if (!policy) throw new Error("policy not found");
  const r = policy.retrieval;
  const role = opts.role;
  const queryTokens = new Set(tokenize(opts.query));
  const vis = visibleTiers(policy, role);
  const excl = excludedTiers(policy, role);
  const thr = policy.scope.visible_threshold ?? 0.5;

  return await withTrace(
    {
      op: "retrieval.query",
      policy_version: policy.policy_version,
      model_id: policy.model.model_id,
      seed: policy.model.seed,
      query_text: opts.query,
      role,
      episode_id: opts.episode_id ?? null,
    },
    async (t) => {
      // ---- candidate generation (vector index) — never final ranking.
      const hits = vectorSearch(opts.query, { tiers: vis as Tier[], k: policy.vector.candidate_k });
      const hitById = new Map(hits.map((h) => [h.id, h.vector_score]));

      const tiers: TierReport[] = [];
      const collected: GraphNode[] = [];
      const visited: number[] = [];
      let stopTier: number | null = null;
      let stopReason: RetrievalResult["stop_reason"] = "bottom_reached";
      let suff = 0;

      for (const tier of [3, 2, 1] as Tier[]) {
        const tierVis = visibility(policy, role, tier);
        const excluded = !vis.includes(tier);
        const predicate = policy.scope.predicates?.[role]?.[String(tier)] ?? null;

        if (excluded) {
          // HARD FILTER: the tier never enters the candidate set.
          tiers.push({
            tier,
            tier_label: tierLabel(tier),
            visibility: tierVis,
            included: false,
            excluded_by_scope: true,
            predicate,
            candidate_count: 0,
            coverage: 0,
            provenance_strength: 0,
            recency: 0,
            suff: 0,
            tau: r.tau,
            stopped_here: false,
            note: `excluded: visibility(${role}, T${tier}) = ${tierVis} → 0 nodes admitted`,
          });
          continue;
        }

        visited.push(tier);
        const pool = queryNodes({ tier, limit: 100000 });
        // structural scope filter (tier visibility + slice predicates)
        const scoped = filterByScope(policy, role, pool, { episode_id: opts.episode_id ?? null });
        const candidates = scoped.filter((n) => hitById.has(n.id));
        const texts = candidates.map(textOf);
        const coverage = nodeCoverage(texts, queryTokens);
        const prov = candidates.length
          ? candidates.reduce((a, n) => a + provenanceStrength(n), 0) / candidates.length
          : 0;
        const recency = candidates.length
          ? candidates.reduce((a, n) => a + recencyOf(n, r.half_life_days), 0) / candidates.length
          : 0;
        const tierSuff = r.w_coverage * coverage + r.w_provenance * prov + r.w_recency * recency;
        const stops = tierSuff >= r.tau;
        tiers.push({
          tier,
          tier_label: tierLabel(tier),
          visibility: tierVis,
          included: true,
          excluded_by_scope: false,
          predicate,
          candidate_count: candidates.length,
          coverage,
          provenance_strength: prov,
          recency,
          suff: tierSuff,
          tau: r.tau,
          stopped_here: stops,
          note: stops
            ? `sufficiency ${tierSuff.toFixed(3)} ≥ τ ${r.tau} → stop, do not descend further`
            : `sufficiency ${tierSuff.toFixed(3)} < τ ${r.tau} → descend to T${tier - 1}`,
        });
        collected.push(...candidates);
        suff = tierSuff;
        if (stops) {
          stopTier = tier;
          stopReason = "sufficiency_reached";
          break;
        }
      }

      if (!visited.length) stopReason = "no_candidates";
      t.tiers(visited);
      t.set({ tiers_descended: visited });

      // ---- final ranking: graph + scores only (vector score never participates).
      const seen = new Set<string>();
      const ranked: RankedNode[] = [];
      for (const n of collected) {
        if (seen.has(n.id)) continue;
        seen.add(n.id);
        const nc = nodeCoverage([textOf(n)], queryTokens);
        const rec = recencyOf(n, r.half_life_days);
        const ev = evidenceScore(n);
        const rank = r.rank.coverage * nc + r.rank.evidence * ev + r.rank.recency * rec;
        ranked.push({
          id: n.id,
          type: n.type,
          tier: n.tier,
          label: n.label,
          text: textOf(n),
          rank_score: rank,
          node_coverage: nc,
          recency: rec,
          evidence_score: ev,
          vector_score: hitById.get(n.id) ?? null,
          status: n.status ?? null,
          confidence: n.confidence ?? null,
          relevance: n.relevance ?? null,
          props: n.props,
        });
      }
      ranked.sort((a, b) => b.rank_score - a.rank_score);
      const top = ranked.slice(0, opts.top_k ?? r.top_k);

      // ---- provenance paths for returned nodes
      const provenance_paths = top.map((n) => ({
        root: n.id,
        kind: n.type,
        paths: provenancePathFor(n.id),
      }));

      const trace = t.current();
      t.touchAll(top.map((n) => n.id));
      t.meta({
        returned_claim_ids: top.filter((n) => n.type === "Claim").map((n) => n.id),
        returned_ids: top.map((n) => n.id),
        stop_reason: stopReason,
        stopped_at_tier: stopTier,
        sufficiency: suff,
        excluded_tiers: excl,
        visible_tiers: vis,
        candidates: hits.length,
        outcome: stopReason === "sufficiency_reached" ? "ok" : stopReason,
      });

      return {
        query: opts.query,
        role,
        policy_version: policy.policy_version,
        tau: r.tau,
        tiers,
        visited_tiers: visited,
        excluded_tiers: excl,
        stopped_at_tier: stopTier,
        stop_reason: stopReason,
        sufficiency: suff,
        nodes: top,
        provenance_paths,
        vector_candidates: hits,
        scope: {
          visible_tiers: vis,
          excluded: excl,
          predicates: policy.scope.predicates?.[role] ?? {},
        },
        trace_id: trace.trace_id,
        latency_ms: Date.now() - started,
      };
    }
  );
}

/** claim → evidence → raw material, i.e. why the memory is justified. */
function provenancePathFor(id: string): string[][] {
  const node = getNode(id);
  if (!node) return [];
  const paths: string[][] = [];
  if (node.type === "Claim") {
    for (const e of edgesOut(id, "PROVENANCE_EP")) {
      const ep = getNode(e.dst);
      if (!ep) continue;
      const events = edgesIn(ep.id, "PART_OF").slice(0, 3).map((x) => x.src);
      paths.push(events.length ? [id, ep.id, ...events] : [id, ep.id]);
    }
    for (const e of edgesOut(id, "PROVENANCE_CHUNK")) {
      paths.push([id, e.dst]);
    }
    for (const e of edgesIn(id, "EPISODE_SUPPORTS")) if (!paths.some((p) => p[1] === e.src)) paths.push([id, e.src]);
    for (const e of edgesIn(id, "CHUNK_SUPPORTS")) if (!paths.some((p) => p[1] === e.src)) paths.push([id, e.src]);
    return paths;
  }
  if (node.type === "Episode") {
    const events = edgesIn(id, "PART_OF").slice(0, 5).map((e) => e.src);
    return events.length ? [events.map((e) => [id, e]).join("|").split("|")] : [[id]];
  }
  if (node.type === "Chunk") {
    const ep = edgesOut(id, "CHUNK_PART_OF")[0];
    return ep ? [[id, ep.dst]] : [[id]];
  }
  if (node.type === "Event") {
    const parent = edgesOut(id, "PARENT_OF")[0];
    const ep = edgesIn(id, "PART_OF")[0];
    const chain: string[] = [id];
    if (parent) chain.unshift(parent.src);
    if (ep) chain.push(ep.dst);
    return [chain];
  }
  return [[id]];
}

function tierLabel(t: number): string {
  return { 1: "T1 raw events", 2: "T2 episodes/sources", 3: "T3 claims", 4: "T4 policy" }[t] ?? `T${t}`;
}
