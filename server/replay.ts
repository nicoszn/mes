// Replay: re-run consolidation or retrieval against ANY policy version.
// Consolidation replay is a dry run sharing the exact write path (consolidationCore), so it
// reports what WOULD be written — including whether consolidation_hash is idempotent or
// diverges (divergence is a bug) — without touching stored state unless explicitly committed.
import { getNode, putNode, queryNodes } from "./db.js";
import { getPolicyDoc, activePolicy, type PolicyDoc } from "./policy.js";
import {
  consolidationCore,
  consolidationHash,
  type ConsolidationMeta,
  type GateReport,
  type SummarySpan,
} from "./consolidate.js";
import { readEventsOf } from "./ingest/chat.js";
import { retrieve, type RetrievalResult } from "./retrieval.js";

export interface ConsolidationReplay {
  episode_id: string;
  policy_version: string;
  stored_policy_version: string | null;
  stored_status: string | null;
  stored_hash: string | null;
  replay_hash: string | null;
  idempotent: boolean | null;
  divergence: boolean;
  would_write: { consolidation_status: string; summary: string | null; summary_spans: SummarySpan[] };
  gates: GateReport;
  meta: ConsolidationMeta;
  card: any;
  summarizer_id: string;
  model_id: string;
  seed: number;
  summary_tokens: number;
  note: string;
  committed: boolean;
}

export function replayConsolidation(
  episodeId: string,
  policyVersion?: string | null,
  opts: { commit?: boolean } = {}
): ConsolidationReplay {
  const policy: PolicyDoc | null = policyVersion ? getPolicyDoc(policyVersion) : activePolicy();
  if (!policy) throw new Error(`policy version not found: ${policyVersion}`);
  const episode = getNode(episodeId);
  if (!episode) throw new Error(`episode not found: ${episodeId}`);

  const core = consolidationCore(episode, policy);
  if (!core) throw new Error("source episodes have no generative consolidation to replay");

  const { card, generated, spans, gates, meta, summarizer, shipSummary } = core;
  const events = readEventsOf(episodeId);
  const replay_hash = consolidationHash(events, card, shipSummary ? generated.text : null, policy);
  const stored_hash: string | null = episode.props.consolidation_hash ?? null;
  const idempotent = stored_hash ? stored_hash === replay_hash : null;
  const divergence = stored_hash !== null && stored_hash !== replay_hash;

  if (opts.commit) {
    putNode({
      ...episode,
      props: {
        ...episode.props,
        consolidation_status: shipSummary ? "ok" : "degraded",
        summary: shipSummary ? generated.text : null,
        summary_spans: shipSummary ? spans : [],
        consolidation_hash: replay_hash,
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
        replayed_at: Date.now(),
      },
    });
  }

  return {
    episode_id: episodeId,
    policy_version: policy.policy_version,
    stored_policy_version: episode.props.config_version ?? null,
    stored_status: episode.props.consolidation_status ?? null,
    stored_hash,
    replay_hash,
    idempotent,
    divergence,
    would_write: {
      consolidation_status: shipSummary ? "ok" : "degraded",
      summary: shipSummary ? generated.text : null,
      summary_spans: shipSummary ? spans : [],
    },
    gates,
    meta,
    card,
    summarizer_id: summarizer.id,
    model_id: policy.model.model_id,
    seed: policy.model.seed,
    summary_tokens: generated.text ? generated.text.split(/\s+/).filter(Boolean).length : 0,
    note: divergence
      ? "DIVERGENCE: re-running produced a different consolidation_hash under this policy — reproducibility bug or policy/model change"
      : idempotent === false
        ? "hash differs from stored (policy/model changed since the original write)"
        : idempotent === true
          ? "idempotent: same events + card + summary + model_id + seed + config_version → same hash"
          : "no stored hash yet",
    committed: !!opts.commit,
  };
}

export async function replayRetrieval(input: {
  query: string;
  role: string;
  policy_version?: string | null;
}): Promise<RetrievalResult> {
  return await retrieve({
    query: input.query,
    role: input.role,
    policy_version: input.policy_version ?? undefined,
  });
}

export function replayableEpisodes() {
  return queryNodes({ type: "Episode", limit: 500 }).map((e) => ({
    id: e.id,
    label: e.label,
    kind: e.props.episode_kind,
    status: e.status,
    consolidation_status: e.props.consolidation_status ?? null,
    config_version: e.props.config_version ?? null,
    summary: e.props.summary ?? null,
    consolidation_hash: e.props.consolidation_hash ?? null,
    closed_at: e.props.closed_at ?? e.props.ingested_at ?? null,
  }));
}
