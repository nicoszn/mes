// Chat door: appends events to an append-only JSONL log (lines never mutated, fsync per write,
// seq monotonic per episode). On an EMITTED episode_close event (never inferred) it writes the
// Episode node plus PART_OF/PARENT_OF edges under two hard assertions:
//   V1 every parent_event_id resolves to a real event
//   V2 every event is attached by exactly one PART_OF edge
import { JsonlLog } from "../jsonl.js";
import { EVENT_LOG } from "../paths.js";
import { db, getNode, putEdge, putNode, updateNodeProps, getSetting, setSetting } from "../db.js";
import { estimateTokens, sha256 } from "../hash.js";
import { TIER_OF } from "../types.js";
import type { ConsolidationStatus, EpisodeKind, EpisodeStatus, EventKind, Role } from "../types.js";
import { activePolicy } from "../policy.js";
import { assertRoleWritesKind } from "../scope.js";
import { withTrace } from "../trace.js";

export const eventLog = new JsonlLog(EVENT_LOG);

const seqMem = new Map<string, number>();

export interface EventLine {
  type: "event";
  event_id: string;
  episode_id: string;
  seq: number;
  kind: EventKind;
  parent_event_id: string | null;
  agent_id: string | null;
  role: string | null;
  ts: number;
  content: string;
  content_hash: string;
  token_count: number;
  meta?: Record<string, any>;
}

function nextSeq(episodeId: string): number {
  const n = (seqMem.get(episodeId) ?? -1) + 1;
  seqMem.set(episodeId, n);
  return n;
}

/** Rebuild per-episode sequence counters from the log (source of truth). */
export function loadSeqFromLog(): void {
  seqMem.clear();
  for (const line of eventLog.readAll() as EventLine[]) {
    const cur = seqMem.get(line.episode_id) ?? -1;
    if (line.seq > cur) seqMem.set(line.episode_id, line.seq);
  }
}

export interface OpenEpisodeMeta {
  episode_kind?: EpisodeKind;
  task?: string;
  agent?: string;
  budget?: Record<string, any>;
  source?: Record<string, any>;
}

export function readEventsOf(episodeId: string): EventLine[] {
  return (eventLog.readAll() as EventLine[]).filter((e) => e.episode_id === episodeId).sort((a, b) => a.seq - b.seq);
}

export function openEpisodes(): Record<string, any> {
  return JSON.parse(getSetting("open_episodes") ?? "{}");
}

function setOpenEpisodes(map: Record<string, any>) {
  setSetting("open_episodes", JSON.stringify(map));
}

export function openEpisode(episodeId: string, meta: OpenEpisodeMeta = {}): void {
  const map = openEpisodes();
  map[episodeId] = { episode_id: episodeId, opened_at: Date.now(), ...meta, status: "running" };
  setOpenEpisodes(map);
  appendEvent({
    episode_id: episodeId,
    kind: "control",
    content: `episode_open ${JSON.stringify({ episode_kind: meta.episode_kind ?? "task", task: meta.task ?? null })}`,
    role: "Orchestrator",
    agent_id: "orchestrator",
    meta: { control: "episode_open" },
  });
}

export interface AppendEventInput {
  episode_id: string;
  kind: EventKind;
  content: string;
  parent_event_id?: string | null;
  agent_id?: string | null;
  role?: Role | string | null;
  meta?: Record<string, any>;
  enforceRole?: boolean;
}

export function appendEvent(input: AppendEventInput): { line: EventLine; node_id: string } {
  const policy = activePolicy();
  if (input.enforceRole !== false && input.role) {
    assertRoleWritesKind(policy, String(input.role), input.kind);
  }
  const line: EventLine = {
    type: "event",
    event_id: `ev_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`,
    episode_id: input.episode_id,
    seq: nextSeq(input.episode_id),
    kind: input.kind,
    parent_event_id: input.parent_event_id ?? null,
    agent_id: input.agent_id ?? null,
    role: input.role ?? null,
    ts: Date.now(),
    content: input.content,
    content_hash: sha256(input.content),
    token_count: estimateTokens(input.content),
    meta: input.meta ?? {},
  };
  // Hard gate V1: a parent must resolve to a real event.
  if (line.parent_event_id) {
    const parent = eventLog.readAll().find((e) => (e as EventLine).event_id === line.parent_event_id) as EventLine | undefined;
    if (!parent) throw new Error(`V1 span/parent resolution failed: parent_event_id ${line.parent_event_id} does not resolve`);
  }
  // JSONL first: the log is the source of truth.
  eventLog.append(line as unknown as Record<string, any>);
  putNode({
    id: line.event_id,
    type: "Event",
    tier: TIER_OF.Event,
    label: `${line.kind} · ${line.role ?? "-"}`,
    props: { ...line },
    ts: line.ts,
  });
  if (line.parent_event_id) putEdge("PARENT_OF", line.parent_event_id, line.event_id, 1, { seq: line.seq });
  return { line, node_id: line.event_id };
}

export interface CloseEpisodeInput {
  episode_id: string;
  status: EpisodeStatus;
  task?: string;
  outcome_note?: string;
  budget?: Record<string, any>;
}

export interface CloseResult {
  episode_id: string;
  assertions: { v1_parent_resolution: boolean; v2_part_of_coverage: boolean; details: string[] };
  consolidation: any;
  nodes: { events: number; episode: string };
}

/**
 * The close is EMITTED (this writes the episode_close control event), never inferred.
 * Runs the two hard assertions, writes the Episode node + PART_OF edges, then consolidation.
 */
export async function closeEpisode(input: CloseEpisodeInput): Promise<CloseResult> {
  const details: string[] = [];
  const events = readEventsOf(input.episode_id);
  if (events.length === 0) throw new Error(`episode ${input.episode_id} has no events`);

  // Emit the close event first: the Episode node is derived from an explicit signal.
  const closeLine = appendEvent({
    episode_id: input.episode_id,
    kind: "control",
    content: `episode_close ${JSON.stringify({ status: input.status })}`,
    role: "Orchestrator",
    agent_id: "orchestrator",
    meta: { control: "episode_close", status: input.status },
  });
  const all = readEventsOf(input.episode_id);

  // ---- Hard assertion V1: every parent_event_id resolves to a real event.
  let v1 = true;
  const byId = new Map(all.map((e) => [e.event_id, e]));
  for (const e of all) {
    if (e.parent_event_id && !byId.has(e.parent_event_id)) {
      v1 = false;
      details.push(`V1 FAIL: ${e.event_id} parent ${e.parent_event_id} unresolved`);
    }
  }
  if (v1) details.push(`V1 pass: ${all.filter((e) => e.parent_event_id).length}/${all.filter((e) => e.parent_event_id).length} parent links resolve`);

  const episodeId = input.episode_id;
  putNode({
    id: episodeId,
    type: "Episode",
    tier: TIER_OF.Episode,
    label: `episode ${episodeId}`,
    props: {
      episode_id: episodeId,
      episode_kind: "task" as EpisodeKind,
      status: input.status,
      consolidation_status: "pending" as ConsolidationStatus,
      task: input.task ?? openEpisodes()[episodeId]?.task ?? null,
      started_at: openEpisodes()[episodeId]?.opened_at ?? all[0]?.ts ?? Date.now(),
      closed_at: Date.now(),
      budget: input.budget ?? openEpisodes()[episodeId]?.budget ?? null,
      outcome_note: input.outcome_note ?? null,
      event_count: all.length,
      token_count: all.reduce((a, e) => a + e.token_count, 0),
    },
    status: input.status,
    ts: all[0]?.ts ?? Date.now(),
  });

  // ---- Hard assertion V2: every event is attached by exactly one PART_OF edge.
  let v2 = true;
  for (const e of all) {
    putEdge("PART_OF", e.event_id, episodeId, 1, { seq: e.seq });
    const n = db
      .prepare(`SELECT COUNT(*) c FROM edges WHERE type='PART_OF' AND src=?`)
      .get(e.event_id) as any;
    if (n.c !== 1) {
      v2 = false;
      details.push(`V2 FAIL: ${e.event_id} has ${n.c} PART_OF edges (expected 1)`);
    }
  }
  if (v2) details.push(`V2 pass: ${all.length}/${all.length} events attached by exactly one PART_OF edge`);

  // Remove from the open registry only after the close event is durable.
  const map = openEpisodes();
  delete map[episodeId];
  setOpenEpisodes(map);

  const consolidation = await runConsolidation(episodeId);

  return {
    episode_id: episodeId,
    assertions: { v1_parent_resolution: v1, v2_part_of_coverage: v2, details },
    consolidation,
    nodes: { events: all.length, episode: episodeId },
  };
}

// Imported lazily to avoid a cycle (consolidation reads events from this module).
import { runConsolidation } from "../consolidate.js";

/** Boot-time replay: rebuild Event nodes + PARENT_OF/PART_OF from the JSONL source of truth. */
export function replayEventsFromLog(): { events: number; parentEdges: number; partOfEdges: number } {
  loadSeqFromLog();
  db.prepare(`DELETE FROM edges WHERE type IN ('PARENT_OF','PART_OF')`).run();
  db.prepare(`DELETE FROM nodes WHERE type='Event'`).run();
  const lines = eventLog.readAll() as EventLine[];
  let parentEdges = 0;
  let partOfEdges = 0;
  for (const line of lines) {
    putNode({
      id: line.event_id,
      type: "Event",
      tier: TIER_OF.Event,
      label: `${line.kind} · ${line.role ?? "-"}`,
      props: { ...line },
      ts: line.ts,
      created_at: line.ts,
    });
    if (line.parent_event_id) {
      putEdge("PARENT_OF", line.parent_event_id, line.event_id, 1, { seq: line.seq });
      parentEdges++;
    }
  }
  for (const line of lines) {
    const epExists = !!getNode(line.episode_id);
    if (epExists) {
      const existing = db
        .prepare(`SELECT id FROM edges WHERE type='PART_OF' AND src=?`)
        .get(line.event_id);
      if (!existing) {
        putEdge("PART_OF", line.event_id, line.episode_id, 1, { seq: line.seq });
        partOfEdges++;
      }
    }
  }
  return { events: lines.length, parentEdges, partOfEdges };
}

/** Structural check used by the invariants dashboard (V1 + V2 over the whole graph). */
export function verifyEventAssertions(): { v1: boolean; v2: boolean; details: any[] } {
  const lines = eventLog.readAll() as EventLine[];
  const byId = new Set(lines.map((l) => l.event_id));
  const details: any[] = [];
  let v1 = true;
  for (const l of lines) {
    if (l.parent_event_id && !byId.has(l.parent_event_id)) {
      v1 = false;
      details.push({ check: "V1", ok: false, msg: `${l.event_id} → unresolved parent ${l.parent_event_id}` });
    }
  }
  const rows = db.prepare(`SELECT src, COUNT(*) c FROM edges WHERE type='PART_OF' GROUP BY src`).all() as any[];
  const counts = new Map(rows.map((r) => [r.src, r.c]));
  const episodesWithEvents = new Set(lines.filter((l) => getNode(l.episode_id)).map((l) => l.event_id));
  let v2 = true;
  for (const id of episodesWithEvents) {
    const c = counts.get(id) ?? 0;
    if (c !== 1) {
      v2 = false;
      details.push({ check: "V2", ok: false, msg: `${id} has ${c} PART_OF edges (expected exactly 1)` });
    }
  }
  if (v1) details.push({ check: "V1", ok: true, msg: `all ${lines.length} parent_event_id references resolve` });
  if (v2)
    details.push({
      check: "V2",
      ok: true,
      msg: `${episodesWithEvents.size}/${episodesWithEvents.size} events attached by exactly one PART_OF edge`,
    });
  return { v1, v2, details };
}
