// Seeds the system through the REAL pipeline (no fabricated rows): two documents through the
// document door, three tasks through the chat door with the agent team, producing consolidation,
// claims, contradictions and promotion transitions that the operator can inspect.
import { ingestDocument } from "./ingest/docs.js";
import { runTask } from "./orchestrator.js";
import { countNodes, queryNodes } from "./db.js";

const RUNBOOK = `Ingestion Runbook

The ingestion pipeline writes interaction events to an append-only log before any graph update. Operators must verify that every write is fsynced before acknowledging the request. Retries use exponential backoff with jitter so concurrent writers do not collide.
Never retry failed ingestion writes automatically.
Each episode records a monotonic sequence number for every event it contains. The close event is emitted explicitly and the system never infers an episode boundary from a timeout.

Chunk relevance determines which passages may promote to fact claims. The scorer combines text density, length factor, a boilerplate penalty and an IDF salience term. Promoted claims require independent corroboration before they become trusted.
Redaction wipes chunk text while provenance edges remain intact, so affected claims stay justified by whatever evidence still exists.

The critic role reviews executor events and raises an error when a step lacks provenance. The planner role reads episodic summaries and semantic claims but never reads raw interaction events.

Copyright 2026 Example Corp. All rights reserved. Confidential. Do not distribute. Terms of use apply.
\fSecond runbook page

Instrumentation must exist before any feature ships, so every operation is wrapped in a trace before it does any work. A trace records the policy version, the model identifier, the seed, latency, token counts, cost, outcome and the nodes it touched.

Promotion sweeps must be idempotent, which means a second run over unchanged evidence reports zero transitions. Divergence in a consolidation hash is treated as a reproducibility bug rather than a warning.
`;

const TEAM_NOTES = `Agent Team Notes

Planner agents read episodic summaries and semantic claims but they never read raw events. Executors read raw events for their own task slice only. Critics review executor events together with the lessons learned from previous tasks. Orchestrators own episode open and close and they enforce budgets and timeouts.

Always retry failed ingestion writes automatically.
Role scope filters candidates structurally, so an excluded tier never enters the candidate set at all. Sufficiency gated retrieval starts at claims and descends only while coverage provenance and recency stay below the threshold.

\fDesign constraints page

Provenance is a first class relation because every lesson must point at the episodes or chunks that justified it. Memory structure mirrors collaboration structure, so promotion is earned through independent corroboration rather than asserted by a single observation. Vector similarity only generates candidates and the graph decides the final ranking.

Contradiction detection compares claims of the same kind using token similarity and negation signals, then writes weighted contradiction edges. Decay retires claims whose support has aged instead of deleting them from the graph.
`;

export interface SeedResult {
  documents: { episode_id: string; filename: string; pages: number; chunks: number; claims_created?: number }[];
  runs: { episode_id: string; task: string; status: string; claims_created: number; contradictions: number; transitions: number }[];
  skipped: boolean;
  note: string;
}

export async function seedDemo(force = false): Promise<SeedResult> {
  const existing = countNodes("Episode");
  if (existing > 0 && !force) {
    return { documents: [], runs: [], skipped: true, note: `${existing} episode(s) already present — use force to seed more` };
  }

  const documents: SeedResult["documents"] = [];
  const d1 = await ingestDocument({
    filename: "ingestion-runbook.txt",
    buffer: Buffer.from(RUNBOOK, "utf8"),
    mime: "text/plain",
  });
  documents.push({ episode_id: d1.episode_id, filename: d1.filename, pages: d1.pages, chunks: d1.chunks, claims_created: d1.claims_created });
  const d2 = await ingestDocument({
    filename: "agent-team-notes.txt",
    buffer: Buffer.from(TEAM_NOTES, "utf8"),
    mime: "text/plain",
  });
  documents.push({ episode_id: d2.episode_id, filename: d2.filename, pages: d2.pages, chunks: d2.chunks, claims_created: d2.claims_created });

  const runs: SeedResult["runs"] = [];
  const plans: { task: string; budget?: Record<string, number> }[] = [
    { task: "Ingestion retries: always retry failed ingestion writes automatically" },
    { task: "Ingestion retries: never retry failed ingestion writes automatically" },
    { task: "Ingestion retries: always retry failed ingestion writes automatically", budget: { max_turns: 3, max_tokens: 400 } },
  ];

  for (const p of plans) {
    const res = await runTask({ task: p.task, budget: p.budget });
    const contradictions = queryNodes({ type: "Claim", limit: 100000 }).reduce(
      (a, c) => a + (c.props.contradiction_count ?? 0),
      0
    );
    runs.push({
      episode_id: res.episode_id,
      task: p.task,
      status: res.status,
      claims_created: res.claims.created.length,
      contradictions,
      transitions: res.promotion.transitions.length,
    });
  }

  return {
    documents,
    runs,
    skipped: false,
    note: "Seeded 2 source documents and 3 agent-team episodes through the real pipeline.",
  };
}
