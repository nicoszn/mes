// HTTP API: the UI is the sole operator surface, so every mechanism is reachable here.
import express, { Router, Request, Response, NextFunction } from "express";
import multer from "multer";
import {
  countNodes,
  db,
  edgeCounts,
  getNode,
  edgesIn,
  edgesOut,
  queryNodes,
  tierCounts,
  getSetting,
} from "./db.js";
import {
  activatePolicy,
  activePolicy,
  activeVersion,
  diffPolicies,
  ensureActivePolicy,
  getPolicyDoc,
  listPolicies,
  savePolicy,
  DEFAULT_POLICY,
  type PolicyDoc,
} from "./policy.js";
import { scopeTests, ROLES, visibility, visibleTiers, excludedTiers, allowedEventKinds } from "./scope.js";
import { runInvariants, graphSummary } from "./invariants.js";
import { retrieve } from "./retrieval.js";
import { auditTrace, listTraces, traceStats, findTrace, traceLog } from "./trace.js";
import { claimDashboard, contradictionPairs, promotionSweepTwice, computeConfidence, lastSweepResult } from "./promotion.js";
import { decayReport, redactSourceEpisode } from "./forget.js";
import { ingestDocument, verifyChunkSpans } from "./ingest/docs.js";
import { appendEvent, closeEpisode, openEpisode, readEventsOf, openEpisodes, eventLog, verifyEventAssertions, replayEventsFromLog } from "./ingest/chat.js";
import { extractClaimsForEpisode, verifyClaimProvenance } from "./claims.js";
import { runConsolidation, SUMMARIZERS } from "./consolidate.js";
import { runTask, type BudgetOverride } from "./orchestrator.js";
import { replayConsolidation, replayRetrieval, replayableEpisodes } from "./replay.js";
import { seedDemo } from "./demo.js";
import { vectorSize, markVectorDirty } from "./vector.js";
import { TOOLS } from "./agents.js";
import type { EventKind } from "./types.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

export const api = Router();

function wrap(fn: (req: Request, res: Response) => any) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      await fn(req, res);
    } catch (err: any) {
      next(err);
    }
  };
}

/* ------------------------------------------------------------- bootstrap */

api.get(
  "/bootstrap",
  wrap((_, res) => {
    const policy = activePolicy();
    res.json({
      summary: graphSummary(),
      active_policy: policy,
      active_version: activeVersion(),
      policy_versions: listPolicies().map((p) => ({
        version: p.props.doc.policy_version,
        created_at: p.props.doc.created_at,
        notes: p.props.doc.notes,
        active: p.props.doc.policy_version === activeVersion(),
        content_hash: p.props.content_hash,
      })),
      roles: Object.keys(policy.roles).map((r) => ({
        role: r,
        description: policy.roles[r].description,
        allowed_event_kinds: allowedEventKinds(policy, r),
        visibility: policy.scope.matrix[r],
        excluded_tiers: excludedTiers(policy, r),
        visible_tiers: visibleTiers(policy, r),
      })),
      tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description })),
      summarizers: Object.entries(SUMMARIZERS).map(([id, s]) => ({ id, description: s.description })),
      open_episodes: openEpisodes(),
      tiers: tierCounts(),
      edges: edgeCounts(),
      vector_index_size: vectorSize(),
      invariant_quick: {
        V1: verifyEventAssertions().v1,
        V2: verifyEventAssertions().v2,
        claim_provenance: verifyClaimProvenance().ok,
        chunk_spans: verifyChunkSpans().ok,
      },
    });
  })
);

api.get(
  "/summary",
  wrap((_, res) => res.json(graphSummary()))
);

api.get(
  "/invariants",
  wrap(async (_, res) => res.json(await runInvariants()))
);

/* ------------------------------------------------------------------ graph */

api.get(
  "/graph",
  wrap((req, res) => {
    const type = req.query.type ? String(req.query.type).split(",") : undefined;
    const tier = req.query.tier ? String(req.query.tier).split(",").map(Number) : undefined;
    const search = req.query.search ? String(req.query.search) : undefined;
    const limit = Math.min(2000, Number(req.query.limit ?? 600));
    const nodes = queryNodes({ type: type as any, tier, search, limit });
    const ids = new Set(nodes.map((n) => n.id));
    const edges = queryNodes({ limit: 0 }) && collectEdges(ids, limit);
    res.json({ nodes, edges, total: nodes.length, truncated: nodes.length === limit });
  })
);

function collectEdges(ids: Set<string>, limit: number) {
  const out: any[] = [];
  for (const id of ids) {
    for (const e of [...edgesOut(id), ...edgesIn(id)]) {
      if (ids.has(e.src) && ids.has(e.dst)) out.push(e);
    }
  }
  const seen = new Set<string>();
  return out.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true))).slice(0, limit * 3);
}

api.get(
  "/nodes/:id",
  wrap((req, res) => {
    const node = getNode(req.params.id);
    if (!node) {
      res.status(404).json({ error: `node ${req.params.id} not found` });
      return;
    }
    const out = edgesOut(node.id);
    const inc = edgesIn(node.id);
    const neighborIds = Array.from(new Set([...out.map((e) => e.dst), ...inc.map((e) => e.src)]));
    res.json({
      node,
      edges_out: out,
      edges_in: inc,
      neighbors: neighborIds.map((id) => getNode(id)).filter(Boolean),
      confidence: node.type === "Claim" ? computeConfidence(node, activePolicy()) : null,
    });
  })
);

/* -------------------------------------------------------------- episodes */

api.get(
  "/episodes",
  wrap((_, res) => {
    const eps = queryNodes({ type: "Episode", limit: 500, order: "created_at" });
    res.json({
      episodes: eps.map((e) => ({
        id: e.id,
        label: e.label,
        kind: e.props.episode_kind,
        status: e.status,
        consolidation_status: e.props.consolidation_status ?? null,
        task: e.props.task ?? null,
        filename: e.props.filename ?? null,
        event_count: e.props.event_count ?? readEventsOf(e.id).length,
        chunk_count: e.props.chunk_count ?? null,
        summary: e.props.summary ?? null,
        gates: e.props.gates ?? null,
        consolidation_hash: e.props.consolidation_hash ?? null,
        config_version: e.props.config_version ?? null,
        created_at: e.created_at,
        closed_at: e.props.closed_at ?? e.props.ingested_at ?? null,
        divergence: e.props.divergence ?? false,
      })),
      open: openEpisodes(),
    });
  })
);

api.get(
  "/episodes/:id",
  wrap((req, res) => {
    const ep = getNode(req.params.id);
    if (!ep) {
      res.status(404).json({ error: "episode not found" });
      return;
    }
    const events = readEventsOf(ep.id);
    const claims = queryNodes({ type: "Claim", limit: 5000 }).filter((c) =>
      edgesOut(c.id, "PROVENANCE_EP").some((e) => e.dst === ep.id)
    );
    res.json({ episode: ep, events, claims, open: openEpisodes()[ep.id] ?? null });
  })
);

api.post(
  "/episodes/open",
  wrap((req, res) => {
    const { task, budget } = req.body ?? {};
    const id = `ep_man_${Date.now().toString(36)}`;
    openEpisode(id, { episode_kind: "task", task: task ?? "manual episode", budget: budget ?? null });
    res.json({ episode_id: id });
  })
);

api.post(
  "/events",
  wrap((req, res) => {
    const { episode_id, kind, content, role, parent_event_id, meta } = req.body ?? {};
    if (!episode_id || !kind || !content) {
      res.status(400).json({ error: "episode_id, kind and content are required" });
      return;
    }
    const { line } = appendEvent({
      episode_id,
      kind: kind as EventKind,
      content,
      role: role ?? null,
      parent_event_id: parent_event_id ?? null,
      meta: meta ?? {},
    });
    res.json({ event: line });
  })
);

api.post(
  "/episodes/:id/close",
  wrap(async (req, res) => {
    const status = req.body?.status ?? "success";
    const result = await closeEpisode({ episode_id: req.params.id, status, task: req.body?.task });
    await extractClaimsForEpisode(req.params.id);
    await promotionSweepTwice();
    res.json(result);
  })
);

api.post(
  "/episodes/:id/consolidate",
  wrap(async (req, res) => {
    const result = await runConsolidation(req.params.id, { force: !!req.body?.force });
    res.json(result);
  })
);

/* ------------------------------------------------------------------ chat */

api.post(
  "/chat",
  wrap(async (req, res) => {
    const { task, budget } = req.body ?? {};
    if (!task || typeof task !== "string") {
      res.status(400).json({ error: "task is required" });
      return;
    }
    const result = await runTask({ task, budget: budget as BudgetOverride | undefined });
    res.json(result);
  })
);

/* -------------------------------------------------------------- documents */

api.post(
  "/docs",
  upload.single("file"),
  wrap(async (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: "file is required (multipart field: file)" });
      return;
    }
    const result = await ingestDocument({
      filename: req.file.originalname || "upload.bin",
      buffer: req.file.buffer,
      mime: req.file.mimetype || "application/octet-stream",
    });
    res.json(result);
  })
);

api.get(
  "/docs",
  wrap((_, res) => {
    const eps = queryNodes({ type: "Episode", limit: 500 })
      .filter((e) => e.props.episode_kind === "source")
      .map((e) => {
        const chunks = queryNodes({ type: "Chunk", limit: 100000 }).filter((c) => c.props.doc_id === e.id);
        const redacted = chunks.filter((c) => c.props.redacted).length;
        const rels = chunks.map((c) => c.relevance ?? 0);
        return {
          id: e.id,
          filename: e.props.filename,
          mime: e.props.mime,
          source_hash: e.props.source_hash,
          pages: e.props.page_count,
          chunks: chunks.length,
          redacted,
          status: e.status,
          avg_relevance: rels.length ? rels.reduce((a, b) => a + b, 0) / rels.length : 0,
          max_relevance: rels.length ? Math.max(...rels) : 0,
          ingested_at: e.props.ingested_at,
          claims: queryNodes({ type: "Claim", limit: 100000 }).filter((c) =>
            edgesOut(c.id, "PROVENANCE_CHUNK").some((e2) => chunks.some((c2) => c2.id === e2.dst))
          ).length,
        };
      });
    res.json({ documents: eps });
  })
);

api.get(
  "/docs/:id",
  wrap((req, res) => {
    const ep = getNode(req.params.id);
    if (!ep) {
      res.status(404).json({ error: "document episode not found" });
      return;
    }
    const chunks = queryNodes({ type: "Chunk", limit: 100000 }).filter((c) => c.props.doc_id === ep.id);
    const pages = listPages(ep.id);
    const claims = queryNodes({ type: "Claim", limit: 100000 }).filter((c) =>
      edgesOut(c.id, "PROVENANCE_CHUNK").some((e) => chunks.some((c2) => c2.id === e.dst))
    );
    res.json({ episode: ep, chunks, pages, claims, span_check: verifyChunkSpansOn(chunks) });
  })
);

api.post(
  "/docs/:id/redact",
  wrap(async (req, res) => res.json(await redactSourceEpisode(req.params.id)))
);

function listPages(episodeId: string) {
  const rows = db.prepare(`SELECT page, ord, text, content_hash FROM source_pages WHERE episode_id=? ORDER BY page`).all(episodeId) as any[];
  return rows.map((r) => ({
    page: r.page,
    ord: r.ord,
    content_hash: r.content_hash,
    text: r.text,
    redacted: r.text == null,
    length: r.text ? r.text.length : 0,
  }));
}

function verifyChunkSpansOn(chunks: any[]) {
  let checked = 0;
  let ok = 0;
  for (const c of chunks) {
    if (c.props.redacted) continue;
    const row = db.prepare(`SELECT text FROM source_pages WHERE episode_id=? AND page=?`).get(c.props.doc_id, c.props.page) as any;
    checked++;
    if (row?.text && row.text.slice(c.props.span_start, c.props.span_end) === c.props.text) ok++;
  }
  return { checked, resolved: ok, passed: checked === ok };
}

/* ----------------------------------------------------------------- claims */

api.get(
  "/claims",
  wrap((req, res) => {
    const status = req.query.status ? String(req.query.status) : undefined;
    const kind = req.query.kind ? String(req.query.kind) : undefined;
    let claims = queryNodes({ type: "Claim", limit: 5000, order: "created_at" });
    if (status) claims = claims.filter((c) => c.status === status);
    if (kind) claims = claims.filter((c) => c.props.claim_kind === kind);
    res.json({
      claims: claims.map((c) => ({
        id: c.id,
        text: c.props.text,
        subject: c.props.subject,
        predicate: c.props.predicate,
        object: c.props.object,
        claim_kind: c.props.claim_kind,
        canonical_hash: c.props.canonical_hash,
        confidence: c.confidence ?? 0,
        status: c.status,
        support_count: c.props.support_count ?? 0,
        contradiction_count: c.props.contradiction_count ?? 0,
        config_version: c.props.config_version,
        created_at: c.props.created_at,
        breakdown: c.props.confidence_breakdown ?? null,
        usage_evidence: c.props.usage_evidence ?? [],
      })),
      dashboard: claimDashboard(activePolicy()),
    });
  })
);

api.get(
  "/claims/:id",
  wrap((req, res) => {
    const claim = getNode(req.params.id);
    if (!claim) {
      res.status(404).json({ error: "claim not found" });
      return;
    }
    const provEp = edgesOut(claim.id, "PROVENANCE_EP").map((e) => ({ edge: e, node: getNode(e.dst) }));
    const provCh = edgesOut(claim.id, "PROVENANCE_CHUNK").map((e) => ({ edge: e, node: getNode(e.dst) }));
    const supEp = edgesIn(claim.id, "EPISODE_SUPPORTS").map((e) => ({ edge: e, node: getNode(e.src) }));
    const supCh = edgesIn(claim.id, "CHUNK_SUPPORTS").map((e) => ({ edge: e, node: getNode(e.src) }));
    const contra = [
      ...edgesOut(claim.id, "CONTRADICTS").map((e) => ({ direction: "out", edge: e, node: getNode(e.dst) })),
      ...edgesIn(claim.id, "CONTRADICTS").map((e) => ({ direction: "in", edge: e, node: getNode(e.src) })),
    ];
    res.json({
      claim,
      provenance: { episodes: provEp, chunks: provCh },
      supports: { episodes: supEp, chunks: supCh },
      contradictions: contra,
      confidence: computeConfidence(claim, activePolicy()),
      independence_weights: activePolicy().claims.independence,
      bands: activePolicy().claims.bands,
    });
  })
);

api.post(
  "/promote",
  wrap(async (_, res) => {
    const result = await promotionSweepTwice();
    res.json({ ...result, dashboard: claimDashboard(activePolicy()) });
  })
);

api.get(
  "/contradictions",
  wrap((_, res) => res.json({ pairs: contradictionPairs(), dashboard: claimDashboard(activePolicy()) }))
);

api.get("/decay", wrap((_, res) => res.json(decayReport())));

api.get("/promotion/last", wrap((_, res) => res.json({ last: lastSweepResult() })));

/* --------------------------------------------------------------- retrieval */

api.post(
  "/retrieve",
  wrap(async (req, res) => {
    const { query, role, policy_version } = req.body ?? {};
    if (!query || !role) {
      res.status(400).json({ error: "query and role are required" });
      return;
    }
    res.json(await retrieve({ query, role, policy_version: policy_version || undefined }));
  })
);

api.get(
  "/scope",
  wrap((req, res) => {
    const policy = activePolicy();
    const role = req.query.role ? String(req.query.role) : ROLES[0];
    res.json({
      role,
      matrix: policy.scope.matrix,
      canonical: policy.scope.canonical,
      predicates: policy.scope.predicates,
      tests: scopeTests(policy),
      roles: ROLES.map((r) => ({
        role: r,
        visibility: policy.scope.matrix[r],
        visible_tiers: visibleTiers(policy, r),
        excluded_tiers: excludedTiers(policy, r),
        allowed_event_kinds: allowedEventKinds(policy, r),
      })),
      per_role: {
        role,
        tiers: [1, 2, 3, 4].map((t) => ({
          tier: t,
          visibility: visibility(policy, role, t),
          nodes: queryNodes({ tier: t, limit: 100000 }).length,
        })),
      },
    });
  })
);

/* ------------------------------------------------------------------ traces */

api.get(
  "/traces",
  wrap((req, res) => {
    res.json({
      traces: listTraces({
        op: req.query.op ? String(req.query.op) : undefined,
        outcome: req.query.outcome ? String(req.query.outcome) : undefined,
        limit: Math.min(1000, Number(req.query.limit ?? 200)),
      }),
      stats: traceStats(),
    });
  })
);

api.get(
  "/traces/:id",
  wrap((req, res) => {
    const audit = auditTrace(req.params.id);
    if (!audit) {
      res.status(404).json({ error: "trace not found" });
      return;
    }
    res.json(audit);
  })
);

api.get("/trace-stats", wrap((_, res) => res.json(traceStats())));

api.get(
  "/log/:kind",
  wrap((req, res) => {
    const kind = req.params.kind;
    if (kind === "events") res.json({ file: "events.jsonl", lines: eventLog.readAll() });
    else if (kind === "traces") res.json({ file: "traces.jsonl", lines: traceLog.readAll() });
    else res.status(404).json({ error: "unknown log" });
  })
);

/* ----------------------------------------------------------------- policy */

api.get(
  "/policies",
  wrap((_, res) => {
    res.json({
      active_version: activeVersion(),
      versions: listPolicies().map((p) => ({
        version: p.props.doc.policy_version,
        doc: p.props.doc,
        created_at: p.props.doc.created_at,
        notes: p.props.doc.notes,
        content_hash: p.props.content_hash,
        source: p.props.source,
      })),
      default: DEFAULT_POLICY,
      editable_fields: [
        "consolidation.cite_min", "consolidation.max_summary_tokens", "consolidation.v3_band", "consolidation.v4_band",
        "consolidation.v5_band", "relevance.min_relevance_for_promotion", "relevance.w_*", "claims.bands.*",
        "claims.weights.*", "claims.half_life_days", "claims.jaccard_threshold", "claims.independence.*",
        "retrieval.tau", "retrieval.w_*", "retrieval.top_k", "scope.matrix.*", "budget.*", "model.*",
      ],
      hard_gates: ["V1 span resolution", "V2 100% provenance coverage"],
    });
  })
);

api.get(
  "/policies/compare",
  wrap((req, res) => {
    const a = getPolicyDoc(String(req.query.a ?? ""));
    const b = getPolicyDoc(String(req.query.b ?? ""));
    if (!a || !b) {
      res.status(404).json({ error: "both policy versions must exist" });
      return;
    }
    res.json({ a: a.policy_version, b: b.policy_version, diff: diffPolicies(a, b) });
  })
);

api.post(
  "/policies",
  wrap((req, res) => {
    const doc = req.body?.doc as PolicyDoc;
    if (!doc?.policy_version) {
      res.status(400).json({ error: "doc.policy_version is required" });
      return;
    }
    const { node, created } = savePolicy(doc, req.body?.source ?? "ui");
    res.json({ node, created, active_version: activeVersion() });
  })
);

api.post(
  "/policies/:version/activate",
  wrap((req, res) => {
    activatePolicy(req.params.version);
    res.json({ active_version: activeVersion() });
  })
);

/* ----------------------------------------------------------------- replay */

api.get(
  "/replay/episodes",
  wrap((_, res) => res.json({ episodes: replayableEpisodes(), versions: listPolicies().map((p) => p.props.doc.policy_version) }))
);

api.post(
  "/replay/consolidation",
  wrap((req, res) => {
    const { episode_id, policy_version, commit } = req.body ?? {};
    if (!episode_id) {
      res.status(400).json({ error: "episode_id is required" });
      return;
    }
    res.json(replayConsolidation(episode_id, policy_version ?? null, { commit: !!commit }));
  })
);

api.post(
  "/replay/retrieval",
  wrap(async (req, res) => {
    const { query, role, policy_version } = req.body ?? {};
    res.json(await replayRetrieval({ query: query ?? "", role: role ?? "Orchestrator", policy_version: policy_version ?? null }));
  })
);

/* ------------------------------------------------------------------- misc */

api.post(
  "/seed",
  wrap(async (req, res) => res.json(await seedDemo(!!req.body?.force)))
);

api.get(
  "/roles/:role/events",
  wrap((req, res) => {
    const policy = activePolicy();
    const role = req.params.role;
    const eps = queryNodes({ type: "Episode", limit: 500 });
    const events = eps.flatMap((e) =>
      readEventsOf(e.id)
        .filter((ev) => (ev.role ?? "").toLowerCase() === role.toLowerCase())
        .map((ev) => ({ ...ev, episode_id: e.id }))
    );
    res.json({
      role,
      allowed_event_kinds: allowedEventKinds(policy, role),
      visibility: policy.scope.matrix[role],
      events: events.slice(-300),
    });
  })
);

api.get(
  "/health",
  wrap((_, res) =>
    res.json({
      ok: true,
      active_policy: activeVersion(),
      nodes: countNodes(),
      traces: traceLog.readAll().length,
      events: eventLog.readAll().length,
    })
  )
);

export function apiErrorHandler(err: any, _req: Request, res: Response, _next: NextFunction) {
  const status = err?.status ?? (String(err?.message ?? "").includes("not found") ? 404 : 500);
  console.error("[api]", err?.stack ?? err);
  res.status(status).json({ error: String(err?.message ?? err) });
}

void ensureActivePolicy;
void markVectorDirty;
void replayEventsFromLog;
void express;
