# HMM-MAS

Hierarchical memory architecture for teams of AI agents — delivered as one working,
UI-driven application (light theme). The UI is the sole operator surface: every process,
response, gate, score, trace and policy value it exposes is inspectable and intervenable.

Run it:

```bash
npm install
npm run build     # web bundle + server bundle
npm start         # serves UI + API on :8788  (PORT=3000 npm start to change)
# or for development:
npm run dev       # API :8788 + Vite :5173 (proxy /api)
```

On first boot, press **Seed demo data** (Overview) or `POST /api/seed` to run two source
documents and three agent-team episodes through the real pipeline.

## The model in one page

Memory is a **labeled property graph**, not a store hierarchy. Tiers are *node labels*:

| tier | label | node types |
|------|-------|-----------|
| T0 | instrumentation | Trace |
| T1 | raw interaction events | Event (chat door), Chunk (document door) |
| T2 | episodic summaries | Episode (task + source) |
| T3 | semantic claims / lessons | Claim |
| T4 | policy / config | Policy (immutable, versioned) |

Because a tier is a label, **promotion, retrieval and forgetting are graph queries**, not
storage moves: nothing is copied between containers, only relabeled/linked/scored.

Node types: `Event` (kind ∈ msg · tool_call · tool_result · observation · decision · error ·
control; episode_id, parent_event_id, agent_id, role, ts, content, content_hash, token_count,
seq), `Episode` (episode_kind task|source; status success|failure|aborted|timeout|
budget_exhausted|ingested|source_redacted; consolidation_status pending|ok|degraded; the
deterministic card spine `card_decisions/card_failures/card_resources/card_open_questions`
with mandatory event_id spans, one generative `summary`, `summary_spans`,
`consolidation_hash`), `Chunk` (doc_id, page, span_start, span_end, ord, text, content_hash,
relevance ∈ [0,1]), `Claim` (text, subject/predicate/object, claim_kind lesson|fact|
coordination_pattern, canonical_hash, confidence, status provisional|trusted|retired,
support_count, contradiction_count, config_version), `Policy`, `Trace`.

Edges: `PARENT_OF`, `PART_OF`, `CHUNK_PART_OF`, `PROVENANCE_EP` (claim→episode with span),
`PROVENANCE_CHUNK` (claim→chunk), `EPISODE_SUPPORTS` / `CHUNK_SUPPORTS` (weight encodes
independence), `CONTRADICTS` (weight), `TRACE_TOUCHED_*`, `TRACE_PARENT`, `TRACE_USED_POLICY`.

## Two doors, one schema

* **Chat door** (`server/ingest/chat.ts`) appends events to `data/logs/events.jsonl` —
  lines are never mutated, each write is `fsync`'d, seq is monotonic per episode. On an
  **emitted** `episode_close` (never inferred) it writes the Episode node plus PART_OF and
  PARENT_OF edges under two hard assertions: **V1** every `parent_event_id` resolves to a
  real event, **V2** every event has exactly one PART_OF edge.
* **Document door** (`server/ingest/docs.ts`) accepts PDF/text/HTML from the UI, extracts
  page by page, chunks with exact `page/span_start/span_end/source_hash`, writes Chunk nodes
  and a source Episode (`episode_kind="source"`, `status="ingested"`), and asserts every
  chunk span resolves back to page text. Chunks and chat turns share a schema, so retrieval
  cannot tell them apart — and does not need to.

## The pipeline

* **Consolidation T1→T2** fires only on episode_close: builds the deterministic spine from
  decision/error/tool_result events, produces exactly one generative field (`summary`) behind
  the pluggable `Summarizer` interface (`extractive`, `structured`), and validates five gates:
  V1 span resolution *(hard)*, V2 PART_OF coverage *(hard)*, V3 citation coverage, V4 status
  non-contradiction, V5 length — the last three are [0,1] scores with bands in policy. On
  failure: `consolidation_status="degraded"`, `summary=null`. `consolidation_hash =
  SHA256(event hashes, card, summary, model_id, seed, config_version)`; re-running yields the
  same hash, and divergence is reported as a bug.
* **Relevance** (`server/relevance.ts`) is deterministic per chunk:
  `clamp(w_td·density + w_len·length − w_bp·boilerplate + w_idf·(1−exp(−s/τ)))`. It gates
  promotion only — it never deletes or rewrites chunks (coverage invariant).
* **Claim extraction T2→T3** turns card decisions/failures/outcome into
  coordination_pattern/lesson claims and sentences from chunks with relevance ≥
  `min_relevance_for_promotion` into fact claims (length + verb-ish filters). Every claim is
  MERGEd on `canonical_hash` and gets PROVENANCE_* and SUPPORTS edges weighted by policy
  independence (same_episode 0.25 · different_episode 1.0 · document 0.75).
* **Contradiction detection** compares same-kind claims by token-Jaccard ≥ threshold with
  opposite negation (negation_weight) or same SPO subject+object with a different predicate
  (spo_mismatch_weight), writing CONTRADICTS edges and refreshing `contradiction_count`.
* **Promotion** is the *sole* writer of `Claim.status`:
  `c = σ(w₁·min(1,(n_ep+n_doc)/min_independent_supports) + w₂·recency + w₃·outcome_strength
  − w₄·contradiction_mass)` with `recency = 0.5^(age / (half_life / (1 + contradiction_count·boost)))`.
  Bands map c → {retired, provisional, trusted} as thresholds; document-only claims are capped
  below trusted unless corroborated by an independent episode or usage in a successful
  episode. Sweeps are idempotent — the second run reports zero transitions.
* **Forgetting** is decay, not deletion: recency ages claims out; source redaction wipes chunk
  text, page text and the raw blob while **preserving PROVENANCE_CHUNK edges**, then
  re-evaluates affected claims against remaining evidence.
* **Role scope** is a hard filter: `visibility(role, tier) ∈ [0,1]`, 0.0 ⇒ the tier is
  physically absent from the candidate set. Asserted pass/fail per role × tier. Roles also
  write only their permitted event kinds (rejected otherwise).
* **Retrieval** descends T3 → T2 → T1, computing
  `suff = w_cov·coverage + w_prov·provenance + w_rec·recency`, stopping when `suff ≥ τ`; it
  returns matched nodes + provenance paths + a retrieval trace and never includes excluded
  tiers. A vector index over T2/T3/chunk text provides **candidates only** — final ranking is
  the graph-score formula.
* **Instrumentation** wraps every operation in a trace: a durable append-only JSONL record
  (source of truth, rebuilt into Trace nodes at boot) plus edges to every touched node, with
  op, policy_version, model_id, seed, times, latency, tokens, cost, outcome, error, query,
  nodes_touched, tiers_descended and parent_id so traces nest. `audit(trace_id)` reconstructs
  "why did this happen"; trace-stats aggregates per-op latency, tokens, cost, error rate and
  node count.
* **Policy (T4)** is one immutable versioned JSON document holding every threshold, weight,
  band, τ, half-life, model_id and seed. Nothing downstream hardcodes a number; every trace
  records the version it ran under; versions are editable, activatable and diffable in the UI.

## Layout

```
server/
  db.ts            graph substrate (nodes/edges tables, MERGE semantics)
  policy.ts        T4 policy documents + diff
  trace.ts         instrumentation, audit, trace-stats
  ingest/chat.ts   chat door: JSONL, seq, V1/V2 on close, boot replay
  ingest/docs.ts   document door: PDF/text → pages → chunks + span gate
  consolidate.ts   spine, pluggable summarizers, five gates, consolidation_hash
  relevance.ts     deterministic chunk relevance (IDF corpus)
  claims.ts        extraction, MERGE on canonical_hash, provenance/supports, contradictions
  promotion.ts     confidence formula, bands, document clause, idempotent sweeps
  forget.ts        redaction (preserves provenance) + decay report
  retrieval.ts     sufficiency-gated descent, scope hard filter, ranking, provenance paths
  scope.ts         visibility matrix, predicates, pass/fail assertions, write discipline
  agents.ts        Planner/Executor/Critic/Orchestrator + local tool runner
  orchestrator.ts  episode lifecycle, dispatch, budget/timeout, emits episode_close
  invariants.ts    live pass/fail evaluation of the design invariants
  replay.ts        consolidation/retrieval replay against any policy version
  api.ts, index.ts HTTP surface + server entry
web/src/panels/    Overview, Agent team chat, Documents, Retrieval, Property graph,
                   Role scope, Claims & promotion, Traces & audit, Policy, Replay,
                   Invariants
```

## Invariants (live-checked in the UI)

1. memory structure mirrors collaboration structure
2. promotion is earned through independent corroboration, not asserted
3. role scope filters rather than reranks
4. provenance is a first-class relation — lessons point at the episodes/chunks that justified them
5. retrieval stops when it has enough
6. instrumentation precedes features
7. only two hard gates survive: **V1 span resolution**, **V2 100% provenance coverage**
