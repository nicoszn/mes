// Forgetting is decay, not deletion.
//  - recency decay naturally retires claims whose support has aged (promotion formula),
//  - source redaction wipes chunk text and the raw blob while PRESERVING PROVENANCE_CHUNK
//    edges, so affected claims stay justified and are re-evaluated against remaining evidence.
import fs from "node:fs";
import { db, edgesOut, getNode, putNode, queryNodes } from "./db.js";
import { activePolicy } from "./policy.js";
import { withTrace } from "./trace.js";
import { markVectorDirty } from "./vector.js";
import { promotionSweep, computeConfidence } from "./promotion.js";

export interface RedactResult {
  episode_id: string;
  chunks_wiped: number;
  pages_wiped: number;
  blob_deleted: boolean;
  provenance_edges_preserved: number;
  episode_status: string;
  affected_claims: {
    id: string;
    text: string;
    status_before: string;
    status_after: string;
    confidence_before: number;
    confidence_after: number;
    provenance_intact: boolean;
  }[];
}

export async function redactSourceEpisode(episodeId: string): Promise<RedactResult> {
  const policy = activePolicy();
  const episode = getNode(episodeId);
  if (!episode) throw new Error(`episode not found: ${episodeId}`);
  if (episode.props.episode_kind !== "source") throw new Error("only source episodes can be redacted");

  return await withTrace(
    {
      op: "forget.redact",
      policy_version: policy.policy_version,
      model_id: policy.model.model_id,
      seed: policy.model.seed,
      episode_id: episodeId,
      query_text: episode.props.filename ?? null,
    },
    async (t) => {
      const chunks = queryNodes({ type: "Chunk", limit: 100000 }).filter((c) => c.props.doc_id === episodeId);
      // Capture provenance BEFORE the wipe — these edges must survive untouched.
      const chunkSet = new Set(chunks.map((c) => c.id));
      const preservedBefore = db
        .prepare(`SELECT * FROM edges WHERE type='PROVENANCE_CHUNK'`)
        .all()
        .filter((e: any) => chunkSet.has(e.dst)).length;

      const statusBeforeById = new Map<string, { status: string; conf: number }>();
      const affectedIds = new Set<string>();
      const claims = queryNodes({ type: "Claim", limit: 100000 }).filter((cl) =>
        edgesOut(cl.id, "PROVENANCE_CHUNK").some((e) => chunkSet.has(e.dst))
      );
      for (const cl of claims) {
        affectedIds.add(cl.id);
        statusBeforeById.set(cl.id, { status: cl.status ?? "provisional", conf: cl.confidence ?? 0 });
      }

      // ---- wipe chunk text (node survives: coverage invariant — chunks are never deleted)
      for (const c of chunks) {
        putNode({
          ...c,
          relevance: null,
          props: { ...c.props, text: null, redacted: true, redacted_at: Date.now(), relevance: null, relevance_breakdown: null },
        });
      }
      // ---- wipe page text (hashes preserved so provenance stays verifiable)
      const info = db.prepare(`UPDATE source_pages SET text = NULL WHERE episode_id = ?`).run(episodeId);
      // ---- wipe the raw blob
      let blobDeleted = false;
      const blobPath: string | null = episode.props.blob_path ?? null;
      if (blobPath && fs.existsSync(blobPath)) {
        fs.unlinkSync(blobPath);
        blobDeleted = true;
      }

      putNode({
        ...episode,
        status: "source_redacted",
        props: {
          ...episode.props,
          status: "source_redacted",
          redacted_at: Date.now(),
          text_wiped: true,
          blob_wiped: blobDeleted,
          summary: null,
        },
      });

      // ---- provenance edges preserved?
      const preservedAfter = db
        .prepare(`SELECT * FROM edges WHERE type='PROVENANCE_CHUNK'`)
        .all()
        .filter((e: any) => chunkSet.has(e.dst)).length;
      if (preservedAfter !== preservedBefore) {
        throw new Error(`redaction violated provenance preservation: ${preservedBefore} → ${preservedAfter}`);
      }

      markVectorDirty();

      // ---- re-evaluate affected claims against remaining evidence (promotion is the sole writer)
      const after: RedactResult["affected_claims"] = [];
      for (const id of affectedIds) {
        const n = getNode(id);
        if (!n) continue;
        const b = computeConfidence(n, policy);
        const before = statusBeforeById.get(id)!;
        after.push({
          id,
          text: n.props.text,
          status_before: before.status,
          status_after: b.band,
          confidence_before: before.conf,
          confidence_after: b.c,
          provenance_intact: edgesOut(id, "PROVENANCE_CHUNK").some((e) => chunkSet.has(e.dst)),
        });
      }
      await promotionSweep();

      t.touch(episodeId);
      t.touchAll([...affectedIds]);
      t.meta({
        chunks_wiped: chunks.length,
        pages_wiped: info.changes,
        blob_deleted: blobDeleted,
        provenance_edges_preserved: preservedAfter,
        affected_claims: after.length,
      });

      return {
        episode_id: episodeId,
        chunks_wiped: chunks.length,
        pages_wiped: info.changes,
        blob_deleted: blobDeleted,
        provenance_edges_preserved: preservedAfter,
        episode_status: "source_redacted",
        affected_claims: after,
      };
    }
  );
}

/** Recency decay report: how much support mass has aged under the current policy. */
export function decayReport() {
  const claims = queryNodes({ type: "Claim", limit: 100000 });
  const rows = claims.map((c) => {
    const b = c.props.confidence_breakdown;
    return {
      id: c.id,
      text: c.props.text,
      status: c.status,
      confidence: c.confidence ?? 0,
      age_days: b?.age_days ?? 0,
      recency: b?.recency ?? 1,
      half_life_days: b?.half_life_days ?? null,
      effective_half_life_days: b?.effective_half_life_days ?? null,
      contradiction_count: c.props.contradiction_count ?? 0,
    };
  });
  rows.sort((a, b) => a.recency - b.recency);
  const retired = rows.filter((r) => r.status === "retired");
  return {
    total: rows.length,
    oldest: rows.slice(0, 10),
    most_recent: rows.slice(-5).reverse(),
    retired_count: retired.length,
    avg_recency: rows.length ? rows.reduce((a, r) => a + r.recency, 0) / rows.length : 0,
  };
}
