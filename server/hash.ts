import { createHash, createHmac } from "node:crypto";

export function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Deterministic text normalisation used by canonical_hash. */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function canonicalHash(text: string): string {
  return sha256(normalizeText(text));
}

export function stableStringify(value: any): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(value[k])).join(",") + "}";
}

export function hashJson(value: any): string {
  return sha256(stableStringify(value));
}

/** Deterministic seeded PRNG (mulberry32) — reproducibility is a policy requirement. */
export function seededRandom(seed: number) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function hmac(key: string, msg: string): string {
  return createHmac("sha256", key).update(msg).digest("hex");
}

export function tokenize(text: string): string[] {
  return normalizeText(text)
    .split(" ")
    .filter((t) => t.length > 0);
}

export function tokenSet(text: string): Set<string> {
  return new Set(tokenize(text));
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function nowMs(): number {
  return Date.now();
}

let counter = 0;
export function uid(prefix: string): string {
  counter = (counter + 1) % 1_000_000;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36).padStart(4, "0")}`;
}
