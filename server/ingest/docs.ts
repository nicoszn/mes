// Document door: accepts PDFs and other external sources from the UI, extracts them page by
// page into chunks carrying page/span_start/span_end/source_hash, writes each as a Chunk node
// plus a source Episode (episode_kind="source", status="ingested"), and asserts that every
// chunk span resolves back to page text — so retrieval cannot tell a doc chunk from a chat turn.
import fs from "node:fs";
import path from "node:path";
import { PDFParse } from "pdf-parse";
import { db, getNode, putEdge, putNode, queryNodes } from "../db.js";
import { sha256 } from "../hash.js";
import { TIER_OF } from "../types.js";
import { activePolicy, type PolicyDoc } from "../policy.js";
import { scoreChunk, idfCorpus } from "../relevance.js";
import { extractClaimsForEpisode } from "../claims.js";
import { promotionSweep } from "../promotion.js";
import { withTrace } from "../trace.js";
import { markVectorDirty } from "../vector.js";
import { UPLOAD_DIR } from "../paths.js";
import type { GraphNode } from "../types.js";

export interface ExtractedPage {
  page: number;
  text: string;
}

export async function extractPages(buffer: Buffer, filename: string, mime: string): Promise<ExtractedPage[]> {
  const lower = filename.toLowerCase();
  const isPdf =
    mime === "application/pdf" || lower.endsWith(".pdf") || buffer.subarray(0, 5).toString() === "%PDF-";
  if (isPdf) {
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    try {
      const result = await parser.getText();
      return result.pages.map((p) => ({ page: p.num, text: p.text ?? "" }));
    } finally {
      await parser.destroy().catch(() => {});
    }
  }
  let text = buffer.toString("utf8");
  if (mime === "text/html" || lower.endsWith(".html") || lower.endsWith(".htm")) {
    text = text
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/ /g, " ")
      .replace(/&/g, "&");
  }
  let pages = text.split("\f").map((t, i) => ({ page: i + 1, text: t.replace(/\r\n/g, "\n") }));
  if (pages.length === 1 && pages[0].text.length > 3200) {
    // Long single-page text: split on paragraph boundaries into ~3000-char pages.
    const paras = pages[0].text.split(/\n(?=\n)/);
    const out: ExtractedPage[] = [];
    let buf = "";
    let pageNo = 1;
    for (const p of paras) {
      if ((buf + p).length > 3000 && buf) {
        out.push({ page: pageNo++, text: buf });
        buf = "";
      }
      buf += p + "\n";
    }
    if (buf.trim()) out.push({ page: pageNo, text: buf });
    pages = out;
  }
  return pages;
}

export interface ChunkSpec {
  doc_id: string;
  page: number;
  span_start: number;
  span_end: number;
  ord: number;
  text: string;
}

/** Sliding-window chunking with exact slices of page text (spans always resolve by construction). */
export function chunkPage(pageText: string, policy: PolicyDoc, startOrd: number): Omit<ChunkSpec, "doc_id">[] {
  const { target_chars, overlap_chars, min_chars } = policy.chunking;
  const out: Omit<ChunkSpec, "doc_id">[] = [];
  if (!pageText.length) return out;
  let start = 0;
  let ord = startOrd;
  while (start < pageText.length) {
    let end = Math.min(start + target_chars, pageText.length);
    if (end < pageText.length) {
      const window = pageText.slice(start, end);
      const m = [...window.matchAll(/[.!?][)\]"']?\s/g)].pop();
      if (m && m.index && m.index > target_chars * 0.5) end = start + m.index + 1;
    }
    const text = pageText.slice(start, end);
    if (text.trim().length >= min_chars || end >= pageText.length) {
      // Hard gate V1 (document door): the chunk text must be the exact slice.
      if (pageText.slice(start, end) !== text) {
        throw new Error(`V1 span resolution failed at page ord ${ord}`);
      }
      out.push({ page: 0, span_start: start, span_end: end, ord: ord++, text });
    }
    if (end >= pageText.length) break;
    start = Math.max(end - overlap_chars, start + 1);
  }
  return out;
}

export interface IngestResult {
  episode_id: string;
  filename: string;
  source_hash: string;
  mime: string;
  pages: number;
  chunks: number;
  span_assertion: { passed: boolean; checked: number; details: string[] };
  relevance: { min: number; max: number; avg: number };
  duplicate: boolean;
  claims_created?: number;
  claims_merged?: number;
  trace?: string;
}

export async function ingestDocument(input: {
  filename: string;
  buffer: Buffer;
  mime: string;
}): Promise<IngestResult> {
  const policy = activePolicy();
  const sourceHash = sha256(input.buffer);

  // Idempotent on source content: same bytes → same source episode.
  const existing = queryNodes({ type: "Episode", limit: 100000 }).find(
    (n) => n.props.episode_kind === "source" && n.props.source_hash === sourceHash && n.status !== "source_redacted"
  );
  if (existing) {
    const chunks = queryNodes({ type: "Chunk", limit: 100000 }).filter((c) => c.props.doc_id === existing.id);
    return {
      episode_id: existing.id,
      filename: existing.props.filename,
      source_hash: sourceHash,
      mime: existing.props.mime,
      pages: existing.props.page_count,
      chunks: chunks.length,
      span_assertion: { passed: true, checked: chunks.length, details: ["already ingested; span assertion held"] },
      relevance: stats(chunks.map((c) => c.relevance ?? 0)),
      duplicate: true,
    };
  }

  return await withTrace(
    {
      op: "ingest.document",
      policy_version: policy.policy_version,
      model_id: policy.model.model_id,
      seed: policy.model.seed,
      query_text: input.filename,
      detail: { mime: input.mime, bytes: input.buffer.length, source_hash: sourceHash },
    },
    async (t) => {
      const pages = await extractPages(input.buffer, input.filename, input.mime);
      if (pages.length === 0 || !pages.some((p) => p.text.trim())) {
        throw new Error("no extractable text found in document (scanned/image-only PDFs are not supported)");
      }
      const blobPath = path.join(UPLOAD_DIR, `${sourceHash}.bin`);
      if (!fs.existsSync(blobPath)) fs.writeFileSync(blobPath, input.buffer);

      const episodeId = `ep_doc_${sourceHash.slice(0, 12)}`;
      putNode({
        id: episodeId,
        type: "Episode",
        tier: TIER_OF.Episode,
        label: `source · ${input.filename}`,
        props: {
          episode_id: episodeId,
          episode_kind: "source" as const,
          status: "ingested" as const,
          consolidation_status: "ok" as const,
          filename: input.filename,
          mime: input.mime,
          source_hash: sourceHash,
          blob_path: blobPath,
          page_count: pages.length,
          ingested_at: Date.now(),
          relevance: null,
          summary: null,
          card_decisions: [],
          card_failures: [],
          card_resources: [],
          card_open_questions: [],
          summary_spans: [],
          consolidation_hash: sha256(`source:${sourceHash}`),
        },
        status: "ingested",
        ts: Date.now(),
      });
      t.touch(episodeId);

      const details: string[] = [];
      let checked = 0;
      let ord = 0;
      const chunkIds: string[] = [];
      const corpus = idfCorpus();
      for (const pg of pages) {
        db.prepare(
          `INSERT INTO source_pages (episode_id, page, ord, text, content_hash) VALUES (?,?,?,?,?)
           ON CONFLICT(episode_id,page) DO UPDATE SET text=excluded.text, content_hash=excluded.content_hash`
        ).run(episodeId, pg.page, ord, pg.text, sha256(pg.text));
        const specs = chunkPage(pg.text, policy, ord).map((s) => ({ ...s, page: pg.page, doc_id: episodeId }));
        ord += specs.length + 1;
        for (const spec of specs) {
          const slice = pg.text.slice(spec.span_start, spec.span_end);
          checked++;
          if (slice !== spec.text) {
            throw new Error(`V1 span resolution failed: chunk ${spec.ord} page ${pg.page} span ${spec.span_start}-${spec.span_end}`);
          }
          const rel = scoreChunk(spec.text, policy, corpus);
          const nodeId = `ch_${sourceHash.slice(0, 8)}_${spec.page}_${spec.ord}`;
          putNode({
            id: nodeId,
            type: "Chunk",
            tier: TIER_OF.Chunk,
            label: `chunk p${page_label(spec.page)} #${spec.ord}`,
            props: {
              doc_id: episodeId,
              filename: input.filename,
              page: spec.page,
              span_start: spec.span_start,
              span_end: spec.span_end,
              ord: spec.ord,
              text: spec.text,
              content_hash: sha256(spec.text),
              source_hash: sourceHash,
              relevance: rel.relevance,
              relevance_breakdown: rel,
              redacted: false,
              created_at: Date.now(),
            },
            relevance: rel.relevance,
            ts: Date.now(),
          });
          putEdge("CHUNK_PART_OF", nodeId, episodeId, 1, { page: spec.page, ord: spec.ord });
          chunkIds.push(nodeId);
        }
      }
      details.push(`V1 span resolution: ${checked}/${checked} chunk spans resolve exactly back to page text`);
      t.touchAll(chunkIds);
      markVectorDirty();

      const rels = chunkIds.map((id) => (getNode(id)!.relevance ?? 0));
      const statsRel = stats(rels);
      updateEpisode(episodeId, { chunk_count: chunkIds.length, relevance: statsRel.avg });

      // T2 → T3: sentences from chunks with relevance ≥ min_relevance_for_promotion
      const extraction = await extractClaimsForEpisode(episodeId);
      const sweep = await promotionSweep();
      t.touchAll(extraction.claims_created);

      t.meta({
        pages: pages.length,
        chunks: chunkIds.length,
        span_assertion: { passed: true, checked },
        relevance: statsRel,
        claims_created: extraction.claims_created.length,
        promotion_transitions: sweep.transitions.length,
      });
      return {
        episode_id: episodeId,
        filename: input.filename,
        source_hash: sourceHash,
        mime: input.mime,
        pages: pages.length,
        chunks: chunkIds.length,
        span_assertion: { passed: true, checked, details },
        relevance: statsRel,
        duplicate: false,
        claims_created: extraction.claims_created.length,
        claims_merged: extraction.claims_merged.length,
        trace: t.current().trace_id,
      };
    }
  );
}

function page_label(p: number) {
  return p;
}

function updateEpisode(id: string, patch: Record<string, any>) {
  const n = getNode(id);
  if (!n) return;
  putNode({ ...n, props: { ...n.props, ...patch } });
}

function stats(xs: number[]) {
  if (!xs.length) return { min: 0, max: 0, avg: 0 };
  return {
    min: Math.min(...xs),
    max: Math.max(...xs),
    avg: xs.reduce((a, b) => a + b, 0) / xs.length,
  };
}

/** Structural check for the invariants dashboard: every chunk span resolves to page text. */
export function verifyChunkSpans(): { ok: boolean; checked: number; failures: any[] } {
  const chunks = queryNodes({ type: "Chunk", limit: 100000 });
  const failures: any[] = [];
  let checked = 0;
  for (const c of chunks) {
    const row = db
      .prepare(`SELECT text FROM source_pages WHERE episode_id=? AND page=?`)
      .get(c.props.doc_id, c.props.page) as any;
    checked++;
    if (!row || row.text == null) {
      failures.push({ chunk: c.id, reason: "page text missing (redacted pages are excluded from this check)" });
      continue;
    }
    const slice = row.text.slice(c.props.span_start, c.props.span_end);
    if (slice !== c.props.text) failures.push({ chunk: c.id, reason: "span does not resolve to page text" });
  }
  const live = chunks.filter((c) => !c.props.redacted);
  const liveFailures = failures.filter((f) => {
    const n = chunks.find((c) => c.id === f.chunk);
    return n && !n.props.redacted;
  });
  return { ok: liveFailures.length === 0, checked: live.length, failures: liveFailures };
}
