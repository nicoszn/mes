// T2 → T3 claim extraction.
//  - card decisions/failures/outcome  → coordination_pattern / lesson claims
//  - sentences from chunks with relevance ≥ min_relevance_for_promotion → fact claims
// Every claim is MERGEd on canonical_hash (idempotent, no duplicates), carries PROVENANCE_EP /
// PROVENANCE_CHUNK edges, and SUPPORTS edges weighted by policy independence weights.
import { getNode, putEdge, putNode, queryNodes, edgesIn, edgesOut, db } from "./db.js";
import { canonicalHash, normalizeText, jaccard, tokenize } from "./hash.js";
import { activePolicy, type PolicyDoc } from "./policy.js";
import { withTrace } from "./trace.js";
import { markVectorDirty } from "./vector.js";
import type { ClaimKind, ClaimStatus, GraphNode } from "./types.js";

export interface EvidenceSpan {
  field: "summary" | "card_decisions" | "card_failures" | "chunk" | "task";
  start: number;
  end: number;
  text: string;
}

const VERBS = new Set([
  "is","are","was","were","be","been","have","has","had","do","does","did","can","could","should","will","would",
  "use","uses","using","run","runs","return","returns","fail","fails","failed","succeed","succeeds","check","checks",
  "verify","ensures","ensure","must","needs","need","needto","retry","retries","retried","avoid","prefer","prefers",
  "write","writes","read","reads","send","sends","build","builds","create","creates","delete","deletes","update",
  "updates","start","starts","stop","stops","call","calls","execute","executes","log","logs","cache","cacheable",
  "validate","validates","prevent","prevents","cause","causes","improve","improves","reduce","reduces","increase",
  "increase","keep","keeps","choose","chooses","apply","applies","require","requires","support","supports","contain",
  "contains","allow","allows","limit","limits","fall","falls","break","breaks","broke","broken","recover","recovers",
  "recovering","escalate","escalates","route","routes","queue","queues","index","indexes","query","queries","store",
  "stores","load","loads","spawn","spawns","kill","kills","abort","aborts","timeout","times","exceed","exceeds",
]);

export function verbish(token: string): boolean {
  const t = token.replace(/[^\p{L}]/gu, "").toLowerCase();
  if (!t) return false;
  if (VERBS.has(t)) return true;
  if (t.length > 4 && /(ed|ing|es)$/.test(t)) return true;
  if (t.length > 4 && /(ate|ize|ise|ify)$/.test(t)) return true;
  return false;
}

export function splitSentences(text: string): { text: string; start: number; end: number }[] {
  const out: { text: string; start: number; end: number }[] = [];
  const re = /[^.!?\n]+[.!?]+["')\]]?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const s = m[0].trim();
    if (!s) continue;
    const start = text.indexOf(m[0].trim(), m.index);
    out.push({ text: s, start: start < 0 ? m.index : start, end: (start < 0 ? m.index : start) + s.length });
  }
  return out.length ? out : text.trim() ? [{ text: text.trim(), start: 0, end: text.trim().length }] : [];
}

/** Lightweight SPO split: tokens before the first verb-ish token are the subject. */
export function parseSPO(sentence: string): { subject: string; predicate: string; object: string } {
  const tokens = tokenize(sentence).filter((t) => t.length > 1);
  let vi = tokens.findIndex((t) => verbish(t));
  if (vi < 0) vi = Math.min(2, tokens.length - 1);
  const subject = tokens.slice(0, Math.max(1, vi)).join(" ") || tokens[0] || "";
  const predicate = tokens[vi] ?? "";
  const object = tokens.slice(vi + 1).join(" ") || "";
  return { subject, predicate, object };
}

export function claimId(canonical: string): string {
  return `cl_${canonical.slice(0, 20)}`;
}

export function hasNegation(text: string): boolean {
  return /\b(not|no|never|cannot|can't|don't|doesn't|won't|avoid|nevermore|disallow|forbid|forbidden|mustn't|shouldn't)\b/i.test(
    text
  );
}

export interface UpsertClaimInput {
  text: string;
  claim_kind: ClaimKind;
  provenance: { type: "episode" | "chunk"; id: string; span: EvidenceSpan }[];
  confidence_seed?: number;
}

/** MERGE on canonical_hash: idempotent, no duplicates. */
export function upsertClaim(input: UpsertClaimInput, policy: PolicyDoc): { node: GraphNode; created: boolean } {
  const text = input.text.replace(/\s+/g, " ").trim();
  const canonical = canonicalHash(text);
  const id = claimId(canonical);
  const existing = getNode(id);
  const spo = parseSPO(text);
  const props = existing?.props ?? {
    text,
    subject: spo.subject,
    predicate: spo.predicate,
    object: spo.object,
    claim_kind: input.claim_kind,
    canonical_hash: canonical,
    confidence: 0,
    status: "provisional" as ClaimStatus,
    support_count: 0,
    contradiction_count: 0,
    config_version: policy.policy_version,
    created_at: Date.now(),
    updated_at: Date.now(),
    usage_evidence: [],
    confidence_breakdown: null,
    history: [],
  };
  props.text = text;
  props.claim_kind = input.claim_kind;
  props.subject = spo.subject;
  props.predicate = spo.predicate;
  props.object = spo.object;
  props.updated_at = Date.now();

  const node = putNode({
    id,
    type: "Claim",
    tier: 3,
    label: text.length > 70 ? text.slice(0, 70) + "…" : text,
    props,
    confidence: props.confidence ?? 0,
    status: props.status ?? "provisional",
    created_at: existing?.created_at ?? Date.now(),
  });

  for (const p of input.provenance) {
    if (p.type === "episode") putEdge("PROVENANCE_EP", id, p.id, 1, p.span as any);
    else putEdge("PROVENANCE_CHUNK", id, p.id, 1, p.span as any);
  }
  markVectorDirty();
  return { node, created: !existing };
}

/**
 * SUPPORTS weights (policy.independence):
 *  - CHUNK_SUPPORTS                → document (0.75)
 *  - EPISODE_SUPPORTS from the claim's own provenance episode → same_episode (0.25)
 *  - EPISODE_SUPPORTS from any other episode                    → different_episode (1.0)
 */
export function addSupports(claimIdStr: string, policy: PolicyDoc): void {
  const provEpisodes = edgesOut(claimIdStr, "PROVENANCE_EP").map((e) => e.dst);
  const provChunks = edgesOut(claimIdStr, "PROVENANCE_CHUNK").map((e) => e.dst);
  const origin = new Set(provEpisodes);
  const ind = policy.claims.independence;
  for (const epId of provEpisodes) putEdge("EPISODE_SUPPORTS", epId, claimIdStr, ind.same_episode, { independence: "same_episode" });
  for (const chId of provChunks) putEdge("CHUNK_SUPPORTS", chId, claimIdStr, ind.document, { independence: "document" });
  // Corroborating episodes (support discovered later, e.g. repeated lesson in another episode)
  const seen = new Set([...edgesIn(claimIdStr, "EPISODE_SUPPORTS").map((e) => e.src)]);
  for (const epId of seen) {
    if (!origin.has(epId)) putEdge("EPISODE_SUPPORTS", epId, claimIdStr, ind.different_episode, { independence: "different_episode" });
  }
}

/* ---------------------------------------------------------- contradiction */

export interface ContradictionHit {
  other_id: string;
  weight: number;
  reason: string;
}

export function detectContradictionsFor(claim: GraphNode, policy: PolicyDoc): ContradictionHit[] {
  const hits: ContradictionHit[] = [];
  const p = policy.claims;
  const peers = queryNodes({ type: "Claim", limit: 100000 }).filter(
    (c) => c.id !== claim.id && c.props.claim_kind === claim.props.claim_kind
  );
  const selfTokens = new Set(tokenize(claim.props.text));
  const selfNeg = hasNegation(claim.props.text);
  for (const other of peers) {
    const otherTokens = new Set(tokenize(other.props.text));
    const jac = jaccard(selfTokens, otherTokens);
    const otherNeg = hasNegation(other.props.text);
    if (jac >= p.jaccard_threshold && selfNeg !== otherNeg) {
      hits.push({ other_id: other.id, weight: p.negation_weight, reason: `jaccard ${jac.toFixed(2)} ≥ ${p.jaccard_threshold} with opposite negation` });
      continue;
    }
    const sameSubject = normalizeText(claim.props.subject) === normalizeText(other.props.subject) && claim.props.subject;
    const sameObject = normalizeText(claim.props.object) === normalizeText(other.props.object) && claim.props.object;
    const diffPredicate = normalizeText(claim.props.predicate) !== normalizeText(other.props.predicate);
    if (sameSubject && sameObject && diffPredicate) {
      hits.push({ other_id: other.id, weight: p.spo_mismatch_weight, reason: `same subject "${claim.props.subject}" and object, different predicate (${claim.props.predicate} vs ${other.props.predicate})` });
    }
  }
  return hits;
}

export function applyContradictions(claim: GraphNode, policy: PolicyDoc): { count: number; edges: number } {
  const hits = detectContradictionsFor(claim, policy);
  const seen = new Set<string>();
  let edges = 0;
  for (const h of hits) {
    const key = [claim.id, h.other_id].sort().join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    putEdge("CONTRADICTS", claim.id, h.other_id, h.weight, { reason: h.reason });
    edges++;
  }
  refreshContradictionCounts();
  return { count: hits.length, edges };
}

export function refreshContradictionCounts(): void {
  const claims = queryNodes({ type: "Claim", limit: 100000 });
  for (const c of claims) {
    const n = db.prepare(`SELECT COUNT(*) c FROM edges WHERE type='CONTRADICTS' AND (src=? OR dst=?)`).get(c.id, c.id) as any;
    if ((c.props.contradiction_count ?? 0) !== n.c) {
      putNode({ ...c, props: { ...c.props, contradiction_count: n.c } });
    }
  }
}

export function claimSupportStats(claimIdStr: string): {
  n_episodes: number;
  n_documents: number;
  episode_ids: string[];
  chunk_ids: string[];
  weighted_mass: number;
} {
  // SUPPORTS edges run evidence → claim (episode/chunk sources the claim).
  const eps = edgesIn(claimIdStr, "EPISODE_SUPPORTS");
  const chs = edgesIn(claimIdStr, "CHUNK_SUPPORTS");
  return {
    n_episodes: eps.length,
    n_documents: chs.length,
    episode_ids: eps.map((e) => e.src),
    chunk_ids: chs.map((e) => e.src),
    weighted_mass: [...eps, ...chs].reduce((a, e) => a + e.weight, 0),
  };
}

/* -------------------------------------------------------- extraction run */

function makeSentenceClaimsFromChunk(chunk: GraphNode, policy: PolicyDoc): { text: string; span: EvidenceSpan }[] {
  const out: { text: string; span: EvidenceSpan }[] = [];
  if (!chunk.props.text || chunk.props.redacted) return out;
  const minRel = policy.claims.min_relevance_for_promotion ?? policy.relevance.min_relevance_for_promotion;
  if ((chunk.relevance ?? 0) < minRel) return out;
  for (const s of splitSentences(chunk.props.text)) {
    const tokens = tokenize(s.text);
    if (tokens.length < policy.claims.min_sentence_tokens || tokens.length > policy.claims.max_sentence_tokens) continue;
    const verbs = tokens.filter(verbish).length;
    if (verbs < policy.claims.min_verb_hits) continue;
    out.push({
      text: s.text,
      span: { field: "chunk", start: s.start, end: s.end, text: s.text },
    });
  }
  return out;
}

export interface ExtractionResult {
  episode_id: string;
  claims_created: string[];
  claims_merged: string[];
  provenance_edges: number;
  support_edges: number;
  contradictions_written: number;
  skipped: string[];
}

/** Run claim extraction for one episode (task episodes → cards; source episodes → chunks). */
export async function extractClaimsForEpisode(
  episodeId: string,
  opts: { policy_version?: string } = {}
): Promise<ExtractionResult> {
  const policy = activePolicy();
  const episode = getNode(episodeId);
  if (!episode) throw new Error(`episode not found: ${episodeId}`);

  return await withTrace(
    {
      op: "claims.extract",
      policy_version: policy.policy_version,
      model_id: policy.model.model_id,
      seed: policy.model.seed,
      episode_id: episodeId,
      query_text: episode.props.task ?? episode.props.filename ?? null,
    },
    async (t) => {
      const result: ExtractionResult = {
        episode_id: episodeId,
        claims_created: [],
        claims_merged: [],
        provenance_edges: 0,
        support_edges: 0,
        contradictions_written: 0,
        skipped: [],
      };

      if (episode.props.episode_kind === "source") {
        const chunks = queryNodes({ type: "Chunk", limit: 100000 }).filter((c) => c.props.doc_id === episodeId);
        for (const chunk of chunks) {
          for (const s of makeSentenceClaimsFromChunk(chunk, policy)) {
            const { node, created } = upsertClaim(
              {
                text: s.text,
                claim_kind: "fact",
                provenance: [{ type: "chunk", id: chunk.id, span: s.span }],
              },
              policy
            );
            addSupports(node.id, policy);
            result.provenance_edges += 1;
            result.support_edges += 1;
            (created ? result.claims_created : result.claims_merged).push(node.id);
            applyContradictions(node, policy);
            t.touch(node.id, chunk.id);
          }
        }
        t.meta({ source: "chunks", created: result.claims_created.length, merged: result.claims_merged.length });
        markVectorDirty();
        return result;
      }

      // --- task episodes: decisions → coordination_pattern, failures → lesson, outcome → lesson
      const summary: string = episode.props.summary ?? "";
      const decisions: any[] = episode.props.card_decisions ?? [];
      const failures: any[] = episode.props.card_failures ?? [];

      for (const d of decisions) {
        const text = decisionClaimText(d.excerpt);
        if (!text) continue;
        const span = locateSpan(summary, text, "summary", "card_decisions");
        const { node, created } = upsertClaim(
          { text, claim_kind: "coordination_pattern", provenance: [{ type: "episode", id: episodeId, span }] },
          policy
        );
        addSupports(node.id, policy);
        result.provenance_edges += 1;
        result.support_edges += 1;
        (created ? result.claims_created : result.claims_merged).push(node.id);
        applyContradictions(node, policy);
        t.touch(node.id, episodeId);
      }

      for (const f of failures) {
        const text = polish(f.excerpt);
        if (!text) continue;
        const span = locateSpan(summary, text, "summary", "card_failures");
        const { node, created } = upsertClaim(
          { text, claim_kind: "lesson", provenance: [{ type: "episode", id: episodeId, span }] },
          policy
        );
        addSupports(node.id, policy);
        result.provenance_edges += 1;
        result.support_edges += 1;
        (created ? result.claims_created : result.claims_merged).push(node.id);
        applyContradictions(node, policy);
        t.touch(node.id, episodeId);
      }

      if (episode.props.status && episode.props.task) {
        const text = polish(`Task "${episode.props.task}" closed with status ${episode.props.status}`);
        const span = locateSpan(summary, text, "summary", "task");
        const { node, created } = upsertClaim(
          { text, claim_kind: "lesson", provenance: [{ type: "episode", id: episodeId, span }] },
          policy
        );
        addSupports(node.id, policy);
        result.provenance_edges += 1;
        result.support_edges += 1;
        (created ? result.claims_created : result.claims_merged).push(node.id);
        applyContradictions(node, policy);
        t.touch(node.id, episodeId);
      }

      t.meta({ created: result.claims_created.length, merged: result.claims_merged.length });
      markVectorDirty();
      return result;
    }
  );
}

function polish(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (!t) return "";
  return /[.!?]$/.test(t) ? t : t + ".";
}

/** Strip plan scaffolding so the claim carries the assertion, not the routing prefix. */
function decisionClaimText(content: string): string {
  let s = content.replace(/^Step\s+\d+\s*[\u2014\u2013-]\s*[^:]+:\s*/, "");
  s = s.replace(/^Define success for:\s*/, "");
  return polish(s);
}

/** Locate the evidence span: inside the summary when present, else inside the card field JSON. */
function locateSpan(summary: string, text: string, field: EvidenceSpan["field"], cardField: string): EvidenceSpan {
  const norm = (s: string) => s.replace(/\s+/g, " ");
  if (summary) {
    const idx = norm(summary).indexOf(norm(text).slice(0, 60));
    if (idx >= 0) return { field: "summary", start: idx, end: idx + norm(text).slice(0, 60).length, text };
  }
  return { field: (cardField as any) ?? field, start: 0, end: 0, text };
}

/** Structural check: every claim carries ≥1 provenance edge (V2 = 100% provenance coverage). */
export function verifyClaimProvenance(): { ok: boolean; checked: number; orphans: string[] } {
  const claims = queryNodes({ type: "Claim", limit: 100000 });
  const orphans = claims
    .filter((c) => edgesOut(c.id, "PROVENANCE_EP").length + edgesOut(c.id, "PROVENANCE_CHUNK").length === 0)
    .map((c) => c.id);
  return { ok: orphans.length === 0, checked: claims.length, orphans };
}
