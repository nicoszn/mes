// Vector index over T3 (claims), T2 (episodes) and document/chunk text (T1).
// Strictly for candidate generation: final ranking is decided by graph structure and scores.
import { queryNodes } from "./db.js";
import { cosine, embed, EMBED_DIM } from "./embed.js";
import type { Tier } from "./types.js";

interface Entry {
  id: string;
  tier: Tier;
  type: string;
  text: string;
  vec: Float32Array;
}

let index: Entry[] = [];
let dirty = true;

export function markVectorDirty() {
  dirty = true;
}

export function vectorSize(): number {
  ensureIndex();
  return index.length;
}

function textOf(n: { type: string; label: string; props: any }): string | null {
  if (n.type === "Claim") return n.props.text ?? null;
  if (n.type === "Episode") return [n.props.summary, n.props.task, n.label].filter(Boolean).join(" \n ") || null;
  if (n.type === "Chunk") return n.props.text ?? null;
  return null;
}

function ensureIndex() {
  if (!dirty) return;
  const nodes = queryNodes({ type: ["Claim", "Episode", "Chunk"], limit: 100000 });
  index = [];
  for (const n of nodes) {
    const text = textOf(n);
    if (!text || !text.trim()) continue;
    index.push({ id: n.id, tier: n.tier, type: n.type, text, vec: embed(text, EMBED_DIM) });
  }
  dirty = false;
}

export interface VectorHit {
  id: string;
  tier: Tier;
  type: string;
  vector_score: number;
}

/** Candidate generation only — returns ids with cosine scores; ranking happens elsewhere. */
export function vectorSearch(
  query: string,
  opts: { tiers?: Tier[]; types?: string[]; k?: number } = {}
): VectorHit[] {
  ensureIndex();
  const q = embed(query, EMBED_DIM);
  const hits: VectorHit[] = [];
  for (const e of index) {
    if (opts.tiers && !opts.tiers.includes(e.tier)) continue;
    if (opts.types && !opts.types.includes(e.type)) continue;
    hits.push({ id: e.id, tier: e.tier, type: e.type, vector_score: cosine(q, e.vec) });
  }
  hits.sort((a, b) => b.vector_score - a.vector_score);
  return hits.slice(0, opts.k ?? 40);
}

export function indexedText(id: string): string | null {
  ensureIndex();
  return index.find((e) => e.id === id)?.text ?? null;
}
