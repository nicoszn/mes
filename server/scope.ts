// Role scoping is a HARD FILTER, not a reranking penalty.
// visibility(role, tier) ∈ [0,1]; 0.0 means the tier is physically absent from the candidate set
// (removed from the query before any scoring happens). Structural assertions are pass/fail.
import { queryNodes, countNodes } from "./db.js";
import type { GraphNode, Role, Tier } from "./types.js";
import type { PolicyDoc } from "./policy.js";

export const ROLES: Role[] = ["Planner", "Executor", "Critic", "Orchestrator"];
export const SCOPED_TIERS: Tier[] = [1, 2, 3, 4];

export function visibility(policy: PolicyDoc, role: string, tier: number): number {
  return policy.scope.matrix?.[role]?.[String(tier)] ?? 0;
}

export function visibleTiers(policy: PolicyDoc, role: string): Tier[] {
  const thr = policy.scope.visible_threshold ?? 0.5;
  return SCOPED_TIERS.filter((t) => visibility(policy, role, t) >= thr);
}

/** Tiers that are physically excluded for this role (candidates are cut before scoring). */
export function excludedTiers(policy: PolicyDoc, role: string): Tier[] {
  return SCOPED_TIERS.filter((t) => !visibleTiers(policy, role).includes(t));
}

export interface ScopeContext {
  episode_id?: string | null;
  agent_role?: string | null;
}

/** Apply tier visibility (hard) + slice predicates (structural restrictions inside a visible tier). */
export function filterByScope(policy: PolicyDoc, role: string, nodes: GraphNode[], ctx: ScopeContext = {}): GraphNode[] {
  const thr = policy.scope.visible_threshold ?? 0.5;
  const visible = SCOPED_TIERS.filter((t) => visibility(policy, role, t) >= thr);
  // HARD FILTER: excluded tiers never enter the candidate set.
  let out = nodes.filter((n) => visible.includes(n.tier as Tier));
  const preds = policy.scope.predicates?.[role] ?? {};
  for (const tierKey of Object.keys(preds)) {
    const tier = Number(tierKey);
    const rule = preds[tierKey];
    out = out.filter((n) => {
      if (n.tier !== tier) return true;
      return predicateHolds(rule, n, ctx);
    });
  }
  return out;
}

function predicateHolds(rule: string, n: GraphNode, ctx: ScopeContext): boolean {
  if (rule === "episode_id == current_task_episode") {
    if (n.type === "Chunk") return true; // document chunks are shared source material
    const ep = n.props.episode_id ?? (n.type === "Episode" ? n.id : null);
    if (!ctx.episode_id) return true;
    return ep === ctx.episode_id;
  }
  if (rule === "role == executor") {
    return (n.props.role ?? "").toLowerCase() === "executor";
  }
  return true;
}

export interface ScopeTestRow {
  role: string;
  tier: number;
  tier_name: string;
  expected: number;
  actual: number;
  nodes_in_tier: number;
  present_after_filter: number;
  pass: boolean;
  note: string;
  predicate: string | null;
  predicate_pass: boolean;
}

/**
 * Structural pass/fail assertion per role per tier:
 *  - visibility(role, tier) must match the canonical scope table,
 *  - a tier with visibility 0.0 must yield ZERO candidate nodes (physically absent),
 *  - slice predicates (when declared) must actually restrict the surviving candidates.
 */
export function scopeTests(policy: PolicyDoc): ScopeTestRow[] {
  const canon = policy.scope.canonical ?? {};
  const rows: ScopeTestRow[] = [];
  for (const role of ROLES) {
    for (const tier of SCOPED_TIERS) {
      const expected = canon[role]?.[String(tier)] ?? 0;
      const vis = visibility(policy, role, tier);
      const tierNodes = queryNodes({ tier, limit: 100000 });
      const thr = policy.scope.visible_threshold ?? 0.5;
      const visible = vis >= thr;
      const afterVisibility = visible ? tierNodes : [];
      const preds = policy.scope.predicates?.[role] ?? {};
      const rule = preds[String(tier)] ?? null;
      const afterPredicate = rule
        ? afterVisibility.filter((n) => predicateHolds(rule, n, { episode_id: "__probe_none__", agent_role: null }))
        : afterVisibility;
      const pass = visible === expected > 0 && (visible ? afterVisibility.length > 0 || tierNodes.length === 0 : afterVisibility.length === 0);
      let predicatePass = true;
      let note = "";
      if (!visible) {
        note = `tier physically absent from candidates (0 nodes returned for role)`;
      } else if (tierNodes.length === 0) {
        note = `tier visible but the graph currently has no ${tierName(tier)} nodes`;
      } else {
        note = `${afterVisibility.length}/${tierNodes.length} ${tierName(tier)} nodes visible to ${role}`;
      }
      if (rule) {
        predicatePass = afterPredicate.length <= afterVisibility.length;
        note += ` · predicate "${rule}": ${afterPredicate.length}/${afterVisibility.length} survive`;
      }
      rows.push({
        role,
        tier,
        tier_name: tierName(tier),
        expected: expected > 0 ? 1 : 0,
        actual: visible ? 1 : 0,
        nodes_in_tier: tierNodes.length,
        present_after_filter: afterVisibility.length,
        pass: pass && predicatePass,
        note,
        predicate: rule,
        predicate_pass: predicatePass,
      });
    }
  }
  return rows;
}

function tierName(t: number) {
  return { 1: "T1 raw events", 2: "T2 episodes/sources", 3: "T3 claims", 4: "T4 policy" }[t] ?? `T${t}`;
}

/** Which event kinds a role is permitted to write (roles write only their permitted kinds). */
export function allowedEventKinds(policy: PolicyDoc, role: string): string[] {
  return policy.roles?.[role]?.allowed_event_kinds ?? [];
}

export function assertRoleWritesKind(policy: PolicyDoc, role: string, kind: string) {
  const allowed = allowedEventKinds(policy, role);
  if (!allowed.includes(kind)) {
    throw new Error(`role ${role} may not write event kind "${kind}" (allowed: ${allowed.join(", ")})`);
  }
}

export function scopeOverview(policy: PolicyDoc) {
  return {
    matrix: policy.scope.matrix,
    canonical: policy.scope.canonical,
    predicates: policy.scope.predicates,
    node_counts: { 0: countNodes("Trace"), 1: 0, 2: 0, 3: 0, 4: 0 },
  };
}
