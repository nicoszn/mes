// Agent role implementations. Each role reads ONLY through scoped retrieval (hard filter) and
// writes ONLY its permitted event kinds (asserted on every write). Roles never bypass the
// retrieval path: there is no other read API available to them.
import { appendEvent, readEventsOf, type EventLine } from "./ingest/chat.js";
import { retrieve, type RetrievalResult } from "./retrieval.js";
import { activePolicy, type PolicyDoc } from "./policy.js";
import { allowedEventKinds, assertRoleWritesKind } from "./scope.js";
import type { EventKind, Role } from "./types.js";
import { queryNodes, getNode, edgeCounts, tierCounts } from "./db.js";

export interface AgentContext {
  episode_id: string;
  policy: PolicyDoc;
}

export interface AgentTurn {
  role: Role;
  events: { id: string; kind: EventKind; content: string }[];
  retrieval?: RetrievalResult;
  notes: string[];
}

export class Agent {
  readonly events: { id: string; kind: EventKind; content: string }[] = [];

  constructor(readonly role: Role, private ctx: AgentContext) {}

  get allowed_kinds(): string[] {
    return allowedEventKinds(this.ctx.policy, this.role);
  }

  /** Every write goes through this gate — role scope is enforced, not trusted. */
  emit(kind: EventKind, content: string, opts: { parent?: string | null; meta?: Record<string, any>; enforceRole?: boolean } = {}): string {
    assertRoleWritesKind(this.ctx.policy, this.role, kind);
    const { line } = appendEvent({
      episode_id: this.ctx.episode_id,
      kind,
      content,
      role: this.role,
      agent_id: this.role.toLowerCase(),
      parent_event_id: opts.parent ?? null,
      meta: opts.meta ?? {},
      enforceRole: opts.enforceRole,
    });
    this.events.push({ id: line.event_id, kind, content });
    return line.event_id;
  }

  /** Every read goes through scoped retrieval — excluded tiers are physically absent. */
  async read(query: string): Promise<RetrievalResult> {
    return await retrieve({
      query,
      role: this.role,
      episode_id: this.ctx.episode_id,
      policy_version: this.ctx.policy.policy_version,
    });
  }
}

export function executorEventsOf(episodeId: string): EventLine[] {
  return readEventsOf(episodeId).filter((e) => (e.role ?? "").toLowerCase() === "executor");
}

/** Local deterministic tool runner (no external services; honest about what it is). */
export const TOOLS: Record<string, { description: string; run: (args: string, ctx: AgentContext, role: Role) => Promise<{ output: string; nodes: number }> }> = {
  "memory.search": {
    description: "Scope-filtered retrieval over the graph (candidate generation via vector index, ranking via graph scores).",
    run: async (args, ctx, role) => {
      const res = await retrieve({ query: args, role, episode_id: ctx.episode_id, policy_version: ctx.policy.policy_version });
      return {
        output: `${res.nodes.length} node(s) after sufficiency gate (stopped at ${
          res.stopped_at_tier ? `T${res.stopped_at_tier}` : "bottom"
        }, suff ${res.sufficiency.toFixed(3)}/${res.tau}): ${res.nodes
          .slice(0, 3)
          .map((n) => `[${n.type}] ${n.text.slice(0, 90)}`)
          .join(" | ")}`,
        nodes: res.nodes.length,
      };
    },
  },
  "graph.stats": {
    description: "Counts nodes/edges per tier (T0–T4) and per edge type.",
    run: async () => {
      const t = tierCounts();
      const e = edgeCounts();
      return {
        output: `tiers T1=${t[1]} T2=${t[2]} T3=${t[3]} T4=${t[4]} · edges ${JSON.stringify(e).slice(0, 200)}`,
        nodes: Object.values(t).reduce((a, b) => a + b, 0),
      };
    },
  },
  "doc.lookup": {
    description: "Looks up document chunks containing a token (reads only T1 chunks visible to the role).",
    run: async (args, ctx, role) => {
      const res = await retrieve({ query: args, role, episode_id: ctx.episode_id, policy_version: ctx.policy.policy_version });
      const chunks = res.nodes.filter((n) => n.type === "Chunk");
      return {
        output: chunks.length
          ? `${chunks.length} chunk(s): ${chunks.map((c) => `${c.props.filename ?? ""} p${c.props.page} …${(c.text ?? "").slice(0, 70)}…`).join(" | ")}`
          : "no chunks visible to this role for that query",
        nodes: chunks.length,
      };
    },
  },
  "claims.top": {
    description: "Highest-confidence T3 claims (scoped: only tiers the role may see).",
    run: async (args, ctx, role) => {
      const res = await retrieve({ query: args || "lessons claims", role, episode_id: ctx.episode_id, policy_version: ctx.policy.policy_version });
      const claims = res.nodes.filter((n) => n.type === "Claim");
      return {
        output: claims.length
          ? claims.map((c) => `${(c.confidence ?? 0).toFixed(2)} ${c.status} · ${c.text.slice(0, 90)}`).join(" | ")
          : "no claims visible to this role",
        nodes: claims.length,
      };
    },
  },
};

export function toolNames(): string[] {
  return Object.keys(TOOLS);
}

/** What a role is allowed to read — surfaced in the UI scope panel. */
export function roleReads(policy: PolicyDoc, role: Role) {
  return {
    allowed_event_kinds: allowedEventKinds(policy, role),
    tool_names: Object.keys(TOOLS),
    prior_turns: readEventsOf("__none__").length,
    scoped_retrieval_only: true,
  };
}
