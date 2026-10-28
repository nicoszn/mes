// T1 → T2 consolidation. Fires ONLY on an emitted episode_close event, never inferred.
// Builds the deterministic spine (cards with mandatory event_id spans) from decision/error/
// tool_result events, produces exactly one generative field (summary) behind a pluggable
// summarizer interface, and validates five gates before write:
//   V1 span resolution                  — HARD, absolute (audit safety)
//   V2 100% PART_OF provenance coverage — HARD, absolute (audit safety)
//   V3 citation coverage                — HARD, but PROPORTIONATE to available material:
//                                          cite_min_eff = min(cite_min, len(events)); the
//                                          decision/failure requirement is read from the
//                                          deterministic spine; short episodes auto-pass;
//                                          a spine-rendered fallback is shipped rather than
//                                          ever writing summary=null when V1/V2/V4/V5 pass.
//   V4 status non-contradiction         — soft score in [0,1] with a policy band
//   V5 summary length                   — soft score in [0,1] with a policy band
// Continuous scores belong only to promotion confidence and retrieval sufficiency; V3 is a
// binary pass/fail with a diagnostic problem list.
import { db, getNode, putNode } from "./db.js";
import { sha256, stableStringify, estimateTokens } from "./hash.js";
import { activePolicy, type PolicyDoc } from "./policy.js";
import { withTrace } from "./trace.js";
import { readEventsOf, type EventLine } from "./ingest/chat.js";
import type { ConsolidationStatus, EpisodeStatus } from "./types.js";

export interface SpanEntry {
  event_id: string;
  span: [number, number];
  excerpt: string;
  resolves: boolean;
}

export interface Card {
  decisions: SpanEntry[];
  failures: SpanEntry[];
  resources: (SpanEntry & { tool: string })[];
  open_questions: SpanEntry[];
}

export interface SummarySpan {
  event_id: string;
  span: [number, number];
  excerpt: string;
  field: "summary";
  resolves: boolean;
}

export interface GateReport {
  V1: GateResult;
  V2: GateResult;
  V3: GateResult;
  V4: GateResult;
  V5: GateResult;
  /** The two absolute audit-safety gates. V3 is also hard, but proportionate. */
  hard_gates: ["V1", "V2"];
}

export interface GateResult {
  name: string;
  /** failure blocks the write for this gate */
  hard: boolean;
  /** null when the gate is binary and not scored (V3) */
  score: number | null;
  pass: boolean;
  threshold: number;
  details: string[];
  /** why the gate failed, in plain language */
  problems: string[];
}

/** Audit metadata recorded on the episode for every consolidation. */
export interface ConsolidationMeta {
  cite_min_eff: number;
  cite_min_policy: number;
  event_count: number;
  cited_count: number;
  short_episode: boolean;
  exemptions: string[];
  fallback: "spine_rendered" | null;
  spine: { decisions: number; failures: number; resources: number; open_questions: number };
}

/* --------------------------------------------------------------- citations */

/** Clamp: a rule an episode cannot satisfy proportionally is never enforced literally. */
export function effectiveCiteMin(policy: PolicyDoc, eventCount: number): number {
  return Math.min(policy.consolidation.cite_min, eventCount);
}

/** Older immutable policy versions predate this key; the default keeps them working. */
export function shortEpisodeThreshold(policy: PolicyDoc): number {
  return policy.consolidation.short_episode_threshold ?? 5;
}

export interface CitePlan {
  /** event ids the summary must cite, in the order they must be added */
  cited: string[];
  anchors: string[];
  padded: string[];
  cite_min_eff: number;
  short_episode: boolean;
}

/**
 * Summarizer contract: anchor citations first (first msg, last msg, first decision or error),
 * then remaining events in seq order until len(cited) >= cite_min_eff. Padding is the
 * summarizer's responsibility — never post-hoc repair.
 */
export function planCitations(events: EventLine[], policy: PolicyDoc): CitePlan {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const cite_min_eff = effectiveCiteMin(policy, ordered.length);
  const short_episode = ordered.length < shortEpisodeThreshold(policy);

  const firstMsg = ordered.find((e) => e.kind === "msg");
  const lastMsg = [...ordered].reverse().find((e) => e.kind === "msg");
  const firstDecisionOrError = ordered.find((e) => e.kind === "decision" || e.kind === "error");

  const anchors: string[] = [];
  for (const e of [firstMsg, lastMsg, firstDecisionOrError]) {
    if (e && !anchors.includes(e.event_id)) anchors.push(e.event_id);
  }
  const cited = [...anchors];
  const padded: string[] = [];
  for (const e of ordered) {
    if (cited.length >= cite_min_eff) break;
    if (!cited.includes(e.event_id)) {
      cited.push(e.event_id);
      padded.push(e.event_id);
    }
  }
  return { cited, anchors, padded, cite_min_eff, short_episode };
}

function sentenceFor(ev: EventLine): string {
  const t = ev.content.replace(/\s+/g, " ").trim();
  const m = t.match(/^(.{1,160}?[.!?])(\s|$)/);
  return (m ? m[1] : t.slice(0, 180)).trim() || t.slice(0, 180);
}

/**
 * Fallback summary: "[role] text" of the first and last events in seq order, padded from the
 * remaining events until the citation floor is met. Used only when the generative summarizer
 * cited nothing and V1/V2/V4/V5 all pass — we ship a degraded-free T2 rather than null.
 */
export function spineRenderedSummary(events: EventLine[], plan: CitePlan, policy: PolicyDoc): SummarizerOutput {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const picked: EventLine[] = [];
  const push = (e?: EventLine) => {
    if (e && !picked.includes(e)) picked.push(e);
  };
  push(ordered[0]);
  push(ordered[ordered.length - 1]);
  for (const e of ordered) {
    if (picked.length >= plan.cite_min_eff) break;
    push(e);
  }
  picked.sort((a, b) => a.seq - b.seq);

  let text = "";
  const spans: Omit<SummarySpan, "resolves">[] = [];
  for (const ev of picked) {
    const body = `[${ev.role ?? "system"}] ${sentenceFor(ev)}`;
    const start = text ? text.length + 1 : 0;
    text = text ? `${text} ${body}` : body;
    spans.push({ event_id: ev.event_id, span: [start, start + body.length], excerpt: body, field: "summary" });
  }
  return { text, spans, model_id: policy.model.model_id, seed: policy.model.seed };
}

/* ------------------------------------------------------------- summarizer */

export interface SummarizerInput {
  episode_id: string;
  status: EpisodeStatus | string;
  task: string | null;
  events: EventLine[];
  card: Card;
  policy: PolicyDoc;
  cite: CitePlan;
}

export interface SummarizerOutput {
  text: string;
  spans: Omit<SummarySpan, "resolves">[];
  model_id: string;
  seed: number;
}

/** Pluggable summarizer interface — the only generative field in T2. */
export interface Summarizer {
  id: string;
  description: string;
  generate(input: SummarizerInput): SummarizerOutput;
}

function firstSentence(text: string, max = 200): { excerpt: string; span: [number, number] } | null {
  const t = text.trim();
  if (!t) return null;
  const m = t.match(/^(.{1,160}?[.!?])(\s|$)/);
  let excerpt = m ? m[1] : t.slice(0, Math.min(max, t.length));
  if (excerpt.length > max) excerpt = excerpt.slice(0, max - 1).trimEnd() + "…";
  const start = text.indexOf(excerpt);
  if (start < 0) return null;
  return { excerpt, span: [start, start + excerpt.length] };
}

function entryFor(e: EventLine, excerpt?: string): SpanEntry | null {
  if (excerpt) {
    const start = e.content.indexOf(excerpt);
    if (start >= 0) {
      return { event_id: e.event_id, span: [start, start + excerpt.length], excerpt, resolves: true };
    }
  }
  const s = firstSentence(e.content);
  if (!s) return null;
  return { event_id: e.event_id, span: s.span, excerpt: s.excerpt, resolves: e.content.slice(s.span[0], s.span[1]) === s.excerpt };
}

/** Deterministic spine: every entry carries an event_id and a span into that event's content. */
export function buildCard(events: EventLine[]): Card {
  const decisions: SpanEntry[] = [];
  const failures: SpanEntry[] = [];
  const resources: (SpanEntry & { tool: string })[] = [];
  const open_questions: SpanEntry[] = [];

  for (const e of events) {
    if (e.kind === "decision") {
      const en = entryFor(e);
      if (en) decisions.push(en);
    } else if (e.kind === "error") {
      const en = entryFor(e);
      if (en) failures.push(en);
    } else if (e.kind === "tool_call") {
      const tool = (e.meta as any)?.tool ?? e.content.split(" ")[0] ?? "tool";
      const en = entryFor(e, (e.meta as any)?.args_summary ? `${tool}: ${(e.meta as any).args_summary}` : undefined);
      if (en) resources.push({ ...en, tool });
    } else if (e.kind === "msg" || e.kind === "observation") {
      const re = /[^.!?\n]{8,180}\?/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(e.content))) {
        const excerpt = m[0].trim();
        const start = e.content.indexOf(excerpt);
        if (start >= 0) open_questions.push({ event_id: e.event_id, span: [start, start + excerpt.length], excerpt, resolves: true });
      }
    }
  }
  return { decisions, failures, resources, open_questions };
}

export function validateCard(card: Card, events: EventLine[]): { ok: boolean; checked: number; failures: string[] } {
  const byId = new Map(events.map((e) => [e.event_id, e]));
  const all = [...card.decisions, ...card.failures, ...card.resources, ...card.open_questions];
  const failures: string[] = [];
  for (const en of all) {
    const ev = byId.get(en.event_id);
    if (!ev) failures.push(`${en.event_id}: event not found`);
    else if (ev.content.slice(en.span[0], en.span[1]) !== en.excerpt)
      failures.push(`${en.event_id}: span [${en.span}] does not resolve to excerpt`);
  }
  return { ok: failures.length === 0, checked: all.length, failures };
}

/** Shared assembly: preamble + parts, then pad citations per the summarizer contract. */
function assemble(
  input: SummarizerInput,
  preamble: string,
  parts: { text: string; event_id: string }[]
): SummarizerOutput {
  const { events, policy, cite } = input;
  const byId = new Map(events.map((e) => [e.event_id, e]));
  let text = preamble;
  const spans: Omit<SummarySpan, "resolves">[] = [];

  for (const p of parts) {
    const body = p.text.replace(/\s+/g, " ").trim();
    if (!body) continue;
    const start = text.length + 1;
    text += ` ${body}`;
    spans.push({ event_id: p.event_id, span: [start, start + body.length], excerpt: body, field: "summary" });
  }

  // Padding loop — the summarizer's own responsibility: every planned citation must exist.
  for (const id of cite.cited) {
    if (spans.some((s) => s.event_id === id)) continue;
    const ev = byId.get(id);
    if (!ev) continue;
    const body = sentenceFor(ev);
    const start = text.length + 1;
    text += ` ${body}`;
    spans.push({ event_id: id, span: [start, start + body.length], excerpt: body, field: "summary" });
  }
  void policy;
  return { text, spans, model_id: policy.model.model_id, seed: policy.model.seed };
}

const extractive: Summarizer = {
  id: "extractive",
  description:
    "Deterministic extractive summary: verbatim excerpts of spine anchors (first/last msg, first decision or error), padded in seq order to the effective citation floor.",
  generate(input) {
    const { episode_id, status, task, events, card } = input;
    const parts: { text: string; event_id: string }[] = [];

    for (const d of card.decisions) parts.push({ text: d.excerpt, event_id: d.event_id });
    for (const f of card.failures) parts.push({ text: f.excerpt, event_id: f.event_id });
    if (card.resources.length) {
      const ev = events.find((e) => e.event_id === card.resources[0].event_id);
      if (ev) {
        const tools = Array.from(new Set(card.resources.map((r) => r.tool))).join(", ");
        parts.push({ text: `Resources used: ${tools}.`, event_id: ev.event_id });
      }
    }
    if (card.open_questions.length) {
      const q = card.open_questions[0];
      parts.push({ text: q.excerpt, event_id: q.event_id });
    }

    const preamble = `${task ? `Task "${task}"` : `Episode ${episode_id}`} closed with status ${status}.`;
    return assemble(input, preamble, parts);
  },
};

const structured: Summarizer = {
  id: "structured",
  description:
    "Deterministic structured summary: numbered decisions/failures then padded citations, fully span-cited.",
  generate(input) {
    const { episode_id, status, task, events, card } = input;
    const parts: { text: string; event_id: string }[] = [];
    for (const [i, d] of card.decisions.entries()) parts.push({ text: `Decision ${i + 1}: ${d.excerpt}`, event_id: d.event_id });
    for (const [i, f] of card.failures.entries()) parts.push({ text: `Failure ${i + 1}: ${f.excerpt}`, event_id: f.event_id });
    if (card.resources.length) {
      const ev = events.find((e) => e.event_id === card.resources[0].event_id);
      if (ev) {
        parts.push({
          text: `Tools: ${Array.from(new Set(card.resources.map((r) => r.tool))).join(", ")}.`,
          event_id: ev.event_id,
        });
      }
    }
    const preamble = `${task ? `Task "${task}"` : `Episode ${episode_id}`}: status ${status}.`;
    return assemble(input, preamble, parts);
  },
};

export const SUMMARIZERS: Record<string, Summarizer> = { extractive, structured };
export function getSummarizer(id: string): Summarizer {
  return SUMMARIZERS[id] ?? extractive;
}

/* ------------------------------------------------------------------ gates */

const POSITIVE = /\b(succeeded|successful|success|completed successfully|passed|worked)\b/i;
const NEGATIVE = /\b(failed|failure|errored|crashed|unsuccessful|did not complete|timed out|rejected)\b/i;

export function resolveSpans(generated: SummarizerOutput, events: EventLine[]): SummarySpan[] {
  return generated.spans.map((s) => {
    const ev = events.find((e) => e.event_id === s.event_id);
    const slice = generated.text.slice(s.span[0], s.span[1]);
    return {
      ...s,
      resolves: !!ev && (slice.replace(/\s+/g, " ") === s.excerpt.replace(/\s+/g, " ") || ev.content.includes(s.excerpt)),
    };
  });
}

export function evaluateGates(input: {
  summary: string | null;
  spans: SummarySpan[];
  card: Card;
  cardValidation: { ok: boolean; checked: number; failures: string[] };
  events: EventLine[];
  episodeId: string;
  status: string;
  policy: PolicyDoc;
}): GateReport {
  const p = input.policy.consolidation;
  const detailsV1: string[] = [];
  const problemsV1: string[] = [];

  // V1 — HARD (absolute): every span (card + summary) resolves back to real event content.
  const byId = new Map(input.events.map((e) => [e.event_id, e]));
  let spanChecked = 0;
  let spanOk = 0;
  for (const s of input.spans ?? []) {
    spanChecked++;
    const ev = byId.get(s.event_id);
    if (!ev) {
      detailsV1.push(`summary span → missing event ${s.event_id}`);
      problemsV1.push(`summary span references unknown event ${s.event_id}`);
    } else {
      const slice = input.summary!.slice(s.span[0], s.span[1]);
      const excerptNorm = s.excerpt.replace(/\s+/g, " ");
      const sliceNorm = slice.replace(/\s+/g, " ");
      if (sliceNorm !== excerptNorm && ev.content.indexOf(s.excerpt) < 0 && ev.content.slice(s.span[0], s.span[1]) !== s.excerpt) {
        detailsV1.push(`summary span [${s.span}] does not resolve for ${s.event_id}`);
        problemsV1.push(`span [${s.span}] does not slice to its excerpt for ${s.event_id}`);
      } else spanOk++;
    }
  }
  for (const en of [...input.card.decisions, ...input.card.failures, ...input.card.resources, ...input.card.open_questions]) {
    spanChecked++;
    const ev = byId.get(en.event_id);
    if (ev && ev.content.slice(en.span[0], en.span[1]) === en.excerpt) spanOk++;
    else {
      detailsV1.push(`card span does not resolve for ${en.event_id}`);
      problemsV1.push(`card span does not slice to its excerpt for ${en.event_id}`);
    }
  }
  const v1Score = spanChecked ? spanOk / spanChecked : 1;
  if (!input.cardValidation.ok) detailsV1.push(...input.cardValidation.failures.slice(0, 5));
  detailsV1.push(`${spanOk}/${spanChecked} spans resolve`);

  // V2 — HARD (absolute): 100% PART_OF provenance coverage for this episode's events.
  const rows = db
    .prepare(
      `SELECT e.event_id, (SELECT COUNT(*) FROM edges ed WHERE ed.type='PART_OF' AND ed.src=e.event_id) c
       FROM (SELECT id event_id FROM nodes WHERE type='Event' AND json_extract(props,'$.episode_id')=?) e`
    )
    .all(input.episodeId) as any[];
  const v2fails = rows.filter((r) => r.c !== 1);
  const v2Score = rows.length ? (rows.length - v2fails.length) / rows.length : 0;
  const v2Details = [
    `${rows.length - v2fails.length}/${rows.length} events attached by exactly one PART_OF edge`,
    ...v2fails.slice(0, 5).map((r) => `${r.event_id} has ${r.c} PART_OF edges`),
  ];
  const problemsV2 = v2fails.slice(0, 5).map((r) => `${r.event_id} has ${r.r ?? r.c} PART_OF edges (expected exactly 1)`);

  // V3 — HARD pass/fail, PROPORTIONATE: no continuous score, a problem list instead.
  const v3Details: string[] = [];
  const problemsV3: string[] = [];
  const cite_min_eff = Math.min(p.cite_min, input.events.length);
  const short_episode = input.events.length < shortEpisodeThreshold(input.policy);
  const shortThreshold = shortEpisodeThreshold(input.policy);
  const citedIds = new Set((input.spans ?? []).map((s) => s.event_id));
  const v3Problems: string[] = [];

  if (short_episode) {
    const ok = citedIds.size >= 1;
    v3Details.push(
      `short episode: ${input.events.length} events < threshold ${shortThreshold} → floor clamped to 1 citation (cited ${citedIds.size})`
    );
    if (!ok) v3Problems.push(`short episode requires ≥1 citation, has ${citedIds.size}`);
  } else if (citedIds.size < cite_min_eff) {
    v3Problems.push(`cited ${citedIds.size} < cite_min_eff ${cite_min_eff} (min(${p.cite_min}, ${input.events.length}))`);
  }
  v3Details.push(
    `${citedIds.size} distinct event citations; cite_min_eff = min(${p.cite_min}, ${input.events.length}) = ${cite_min_eff}`
  );

  // The "every decision and failure cited" requirement reads the DETERMINISTIC SPINE:
  // each card entry's event_id must resolve to a real episode event (not re-cited text).
  const spineEntries = [...input.card.decisions, ...input.card.failures];
  const unresolvedSpine = spineEntries.filter((en) => !byId.has(en.event_id));
  v3Details.push(
    `spine coverage: ${spineEntries.length - unresolvedSpine.length}/${spineEntries.length} decision+failure entries resolve via build_card`
  );
  for (const en of unresolvedSpine) v3Problems.push(`card ${input.card.decisions.includes(en) ? "decision" : "failure"} event ${en.event_id} not present in episode`);
  problemsV3.push(...v3Problems);

  const v3Pass = v3Problems.length === 0;

  // V4 — status non-contradiction (soft band): the outcome sentence must not contradict status.
  const outcomeSentence = input.summary ? input.summary.split(/\.(?:\s|$)/)[0] + "." : "";
  const positiveStatus = ["success", "ingested"].includes(input.status);
  const negativeStatus = ["failure", "aborted", "timeout", "budget_exhausted"].includes(input.status);
  const hasPos = POSITIVE.test(outcomeSentence);
  const hasNeg = NEGATIVE.test(outcomeSentence);
  const contradiction = (positiveStatus && hasNeg) || (negativeStatus && hasPos);
  const v4Score = contradiction ? 0 : 1;
  const v4Details = [
    `outcome sentence: "${outcomeSentence || "(none)"}"`,
    `status=${input.status} → ${contradiction ? "CONTRADICTS status" : "consistent with status"}`,
  ];
  const problemsV4 = contradiction ? [`summary outcome contradicts status ${input.status}`] : [];

  // V5 — length (soft band): summary ≤ K tokens.
  const tokens = input.summary ? estimateTokens(input.summary) : 0;
  const v5Score = input.summary ? Math.min(1, p.max_summary_tokens / Math.max(tokens, 1)) : 0;
  const v5Details = [`${tokens}/${p.max_summary_tokens} tokens (policy K)`];
  const problemsV5 = tokens > p.max_summary_tokens ? [`${tokens} tokens exceeds K=${p.max_summary_tokens}`] : [];

  return {
    V1: { name: "span resolution", hard: true, score: v1Score, pass: v1Score >= 1, threshold: 1, details: detailsV1, problems: problemsV1 },
    V2: { name: "PART_OF coverage", hard: true, score: v2Score, pass: v2Score >= 1, threshold: 1, details: v2Details, problems: problemsV2 },
    V3: { name: "citation coverage", hard: true, score: null, pass: v3Pass, threshold: 1, details: v3Details, problems: problemsV3 },
    V4: { name: "status non-contradiction", hard: false, score: v4Score, pass: v4Score >= p.v4_band, threshold: p.v4_band, details: v4Details, problems: problemsV4 },
    V5: { name: "summary length", hard: false, score: v5Score, pass: v5Score >= p.v5_band, threshold: p.v5_band, details: v5Details, problems: problemsV5 },
    hard_gates: ["V1", "V2"],
  };
}

/* ----------------------------------------------------------- consolidation */

export interface ConsolidationOutcome {
  episode_id: string;
  status: "ok" | "degraded";
  summary: string | null;
  summary_spans: SummarySpan[];
  consolidation_hash: string | null;
  previous_hash: string | null;
  idempotent: boolean;
  divergence: boolean;
  gates: GateReport;
  card: Card;
  meta: ConsolidationMeta;
  model_id: string;
  summarizer_id: string;
  seed: number;
  config_version: string;
}

export interface ConsolidationCore {
  card: Card;
  generated: SummarizerOutput;
  spans: SummarySpan[];
  gates: GateReport;
  meta: ConsolidationMeta;
  summarizer: Summarizer;
  shipSummary: boolean;
}

/**
 * The single write-shaped path: generate → resolve spans → gate → (fallback if V3 is the only
 * failure). Shared by the live writer and the replay dry-run so they cannot diverge.
 */
export function consolidationCore(
  episode: { id: string; props: any },
  policy: PolicyDoc
): ConsolidationCore | null {
  if (episode.props.episode_kind === "source") return null;

  const episodeId = episode.id;
  const events = readEventsOf(episodeId);
  const card = buildCard(events);
  const cardValidation = validateCard(card, events);
  const summarizer = getSummarizer(policy.model.summarizer_id);
  const cite = planCitations(events, policy);

  const baseInput: SummarizerInput = {
    episode_id: episodeId,
    status: episode.props.status,
    task: episode.props.task ?? null,
    events,
    card,
    policy,
    cite,
  };

  let generated = summarizer.generate(baseInput);
  let spans = resolveSpans(generated, events);
  let gates = evaluateGates({ summary: generated.text, spans, card, cardValidation, events, episodeId, status: episode.props.status, policy });

  const meta: ConsolidationMeta = {
    cite_min_eff: cite.cite_min_eff,
    cite_min_policy: policy.consolidation.cite_min,
    event_count: events.length,
    cited_count: new Set(spans.map((s) => s.event_id)).size,
    short_episode: cite.short_episode,
    exemptions: [],
    fallback: null,
    spine: {
      decisions: card.decisions.length,
      failures: card.failures.length,
      resources: card.resources.length,
      open_questions: card.open_questions.length,
    },
  };
  if (cite.short_episode) {
    meta.exemptions.push(
      `V3 short-episode exemption: len(events)=${events.length} < short_episode_threshold=${shortEpisodeThreshold(policy)} → floor 1 citation (cited ${meta.cited_count})`
    );
  }

  const othersPass = (g: GateReport) => g.V1.pass && g.V2.pass && g.V4.pass && g.V5.pass;

  // Rule: never ship summary=null when V1/V2/V4/V5 pass. If V3 is the only gate failing (or the
  // summarizer cited nothing), ship a spine-rendered summary with status ok.
  if ((spans.length === 0 || !gates.V3.pass) && othersPass(gates)) {
    const fallback = spineRenderedSummary(events, cite, policy);
    const fbSpans = resolveSpans(fallback, events);
    const fbGates = evaluateGates({
      summary: fallback.text,
      spans: fbSpans,
      card,
      cardValidation,
      events,
      episodeId,
      status: episode.props.status,
      policy,
    });
    generated = fallback;
    spans = fbSpans;
    gates = fbGates;
    meta.fallback = "spine_rendered";
    meta.cited_count = new Set(fbSpans.map((s) => s.event_id)).size;
    if (!fbGates.V3.pass) {
      for (const pr of fbGates.V3.problems) meta.exemptions.push(`V3 residual after spine fallback: ${pr}`);
    }
    if (othersPass(fbGates)) {
      meta.exemptions.push(
        `V3 fallback shipped: spine-rendered summary citing ${meta.cited_count} event(s) ≥ cite_min_eff ${cite.cite_min_eff}`
      );
    }
  }

  return { card, generated, spans, gates, meta, summarizer, shipSummary: othersPass(gates) };
}

export function consolidationHash(
  events: EventLine[],
  card: Card,
  summary: string | null,
  policy: PolicyDoc
): string {
  return sha256(
    stableStringify({
      event_hashes: events.map((e) => e.content_hash),
      card,
      summary,
      model_id: policy.model.model_id,
      seed: policy.model.seed,
      config_version: policy.policy_version,
    })
  );
}

export async function runConsolidation(
  episodeId: string,
  opts: { policy_version?: string; force?: boolean } = {}
): Promise<ConsolidationOutcome> {
  const policy = activePolicy();
  const episode = getNode(episodeId);
  if (!episode) throw new Error(`episode not found: ${episodeId}`);

  if (episode.props.episode_kind === "source") {
    const card: Card = { decisions: [], failures: [], resources: [], open_questions: [] };
    return {
      episode_id: episodeId,
      status: "ok",
      summary: null,
      summary_spans: [],
      consolidation_hash: episode.props.consolidation_hash ?? null,
      previous_hash: null,
      idempotent: true,
      divergence: false,
      gates: {} as GateReport,
      card,
      meta: {
        cite_min_eff: 0,
        cite_min_policy: policy.consolidation.cite_min,
        event_count: 0,
        cited_count: 0,
        short_episode: false,
        exemptions: ["source episode: no generative summary required"],
        fallback: null,
        spine: { decisions: 0, failures: 0, resources: 0, open_questions: 0 },
      },
      model_id: policy.model.model_id,
      summarizer_id: "n/a (source episode)",
      seed: policy.model.seed,
      config_version: policy.policy_version,
    };
  }

  return await withTrace(
    {
      op: "consolidate.episode",
      policy_version: policy.policy_version,
      model_id: policy.model.model_id,
      seed: policy.model.seed,
      episode_id: episodeId,
      query_text: episode.props.task ?? null,
    },
    async (t) => {
      const core = consolidationCore(episode, policy)!;
      const { card, generated, spans, gates, meta, summarizer, shipSummary } = core;
      const events = readEventsOf(episodeId);

      const status: ConsolidationStatus = shipSummary ? "ok" : "degraded";
      const consolidation_hash = consolidationHash(events, card, shipSummary ? generated.text : null, policy);
      const previous_hash: string | null = episode.props.consolidation_hash ?? null;
      const idempotent = previous_hash === consolidation_hash;
      const divergence = previous_hash !== null && !idempotent && !opts.force;

      putNode({
        ...episode,
        props: {
          ...episode.props,
          consolidation_status: status,
          summary: shipSummary ? generated.text : null,
          summary_spans: shipSummary ? spans : [],
          consolidation_hash,
          gates,
          consolidation_meta: meta,
          card_decisions: card.decisions,
          card_failures: card.failures,
          card_resources: card.resources,
          card_open_questions: card.open_questions,
          model_id: policy.model.model_id,
          summarizer_id: summarizer.id,
          seed: policy.model.seed,
          config_version: policy.policy_version,
          consolidated_at: Date.now(),
          previous_hash,
          divergence,
        },
        status: episode.props.status,
      });
      t.touch(episodeId);
      t.meta({
        gates: { V1: gates.V1.pass, V2: gates.V2.pass, V3: gates.V3.pass, V4: gates.V4.score, V5: gates.V5.score },
        cite_min_eff: meta.cite_min_eff,
        cited_count: meta.cited_count,
        short_episode: meta.short_episode,
        exemptions: meta.exemptions,
        fallback: meta.fallback,
        consolidation_status: status,
        consolidation_hash,
        idempotent,
        divergence,
        summarizer: summarizer.id,
        outcome: status,
      });
      if (divergence) t.set({ outcome: "divergence" });

      return {
        episode_id: episodeId,
        status,
        summary: shipSummary ? generated.text : null,
        summary_spans: shipSummary ? spans : [],
        consolidation_hash,
        previous_hash,
        idempotent,
        divergence,
        gates,
        card,
        meta,
        model_id: policy.model.model_id,
        summarizer_id: summarizer.id,
        seed: policy.model.seed,
        config_version: policy.policy_version,
      };
    }
  );
}
