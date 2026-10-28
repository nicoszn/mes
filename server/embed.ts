// Deterministic local embedder (no external service): hashed bag-of-tokens + bigrams,
// sublinear TF, L2-normalised. Used strictly for candidate generation, never for final ranking.
import { fnv1a, normalizeText, tokenize } from "./hash.js";

export const EMBED_DIM = 128;

export function embed(text: string, dim = EMBED_DIM): Float32Array {
  const v = new Float32Array(dim);
  const tokens = tokenize(text);
  const counts = new Map<string, number>();
  const bump = (t: string) => counts.set(t, (counts.get(t) ?? 0) + 1);
  for (const t of tokens) bump(t);
  for (let i = 0; i + 1 < tokens.length; i++) bump(`${tokens[i]}_${tokens[i + 1]}`);
  if (tokens.length === 0) bump(normalizeText(text) || "empty");
  for (const [tok, tf] of counts) {
    const idx = fnv1a(tok) % dim;
    const sign = fnv1a(`s:${tok}`) % 2 === 0 ? 1 : -1;
    v[idx] += sign * (1 + Math.log(tf));
  }
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i++) v[i] /= norm;
  return v;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
