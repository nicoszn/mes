// Deterministic, per-chunk relevance in [0,1]:
//   relevance = clamp( w_td·density + w_len·length_factor − w_bp·boilerplate + w_idf·(1−exp(−s/τ)) )
// Relevance governs promotion only — it never deletes or rewrites chunks (coverage invariant).
import { db } from "./db.js";
import { normalizeText } from "./hash.js";
import type { PolicyDoc } from "./policy.js";

const DEFAULT_BOILERPLATE = [
  "copyright",
  "all rights reserved",
  "terms of use",
  "table of contents",
  "disclaimer",
  "confidential",
  "page of",
  "do not distribute",
  "registration number",
];

export function idfCorpus(): { df: Map<string, number>; n: number } {
  const rows = db.prepare(`SELECT props FROM nodes WHERE type='Chunk'`).all() as any[];
  const df = new Map<string, number>();
  let n = 0;
  for (const r of rows) {
    const props = JSON.parse(r.props);
    if (!props.text) continue;
    n++;
    for (const t of new Set(normalizeText(props.text).split(" "))) {
      if (!t) continue;
      df.set(t, (df.get(t) ?? 0) + 1);
    }
  }
  return { df, n };
}

/** IDF-based salience: mean idf-weighted sublinear tf over unique tokens. */
export function salience(text: string, corpus: { df: Map<string, number>; n: number }): number {
  const tokens = normalizeText(text).split(" ").filter(Boolean);
  if (tokens.length === 0) return 0;
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  let s = 0;
  for (const [t, c] of tf) {
    const df = corpus.df.get(t) ?? 0;
    const idf = Math.log(1 + (corpus.n + 1) / (df + 1));
    s += idf * (1 + Math.log(c));
  }
  return s / tokens.length;
}

export interface RelevanceBreakdown {
  density: number;
  length_factor: number;
  boilerplate: number;
  idf_term: number;
  salience: number;
  relevance: number;
}

export function scoreChunk(
  text: string,
  policy: PolicyDoc,
  corpus?: { df: Map<string, number>; n: number }
): RelevanceBreakdown {
  const p = policy.relevance;
  const clean = text.replace(/\s+/g, " ").trim();
  const letters = (clean.match(/[\p{L}\p{N}]/gu) ?? []).length;
  const density = clean.length ? letters / clean.length : 0;

  const words = clean.split(" ").filter(Boolean);
  const ref = (p as any).length_ref_words ?? 400;
  const lengthFactor = Math.min(1, words.length / ref);

  const lower = ` ${clean.toLowerCase()} `;
  const bpTerms: string[] = (p as any).boilerplate_terms ?? DEFAULT_BOILERPLATE;
  let bpHits = 0;
  for (const term of bpTerms) if (lower.includes(term)) bpHits++;
  const boilerplate = bpTerms.length ? Math.min(1, bpHits / 2) : 0;

  const c = corpus ?? idfCorpus();
  const s = salience(text, c);
  const idfTerm = 1 - Math.exp(-s / p.idf_tau);

  const raw =
    p.w_text_density * density +
    p.w_length * lengthFactor -
    p.w_boilerplate * boilerplate +
    p.w_idf * idfTerm;

  const relevance = Math.max(0, Math.min(1, raw));
  return { density, length_factor: lengthFactor, boilerplate, idf_term: idfTerm, salience: s, relevance };
}

export function boilerplateTerms(policy: PolicyDoc): string[] {
  return (policy.relevance as any).boilerplate_terms ?? DEFAULT_BOILERPLATE;
}
