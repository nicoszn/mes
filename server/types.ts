// HMM-MAS shared types.
// Four tiers are NODE LABELS, not containers: T1 raw interaction events (+ document chunks
// written by the document door), T2 episodic summaries, T3 semantic claims, T4 policy/config.
// Tier 0 is instrumentation (Trace), which is operator-facing and never part of memory scoping.

export type NodeType = "Event" | "Episode" | "Chunk" | "Claim" | "Policy" | "Trace";
export type Tier = 0 | 1 | 2 | 3 | 4;

export type EventKind =
  | "msg"
  | "tool_call"
  | "tool_result"
  | "observation"
  | "decision"
  | "error"
  | "control";

export type EpisodeKind = "task" | "source";
export type EpisodeStatus =
  | "running"
  | "success"
  | "failure"
  | "aborted"
  | "timeout"
  | "budget_exhausted"
  | "ingested"
  | "source_redacted";

export type ConsolidationStatus = "pending" | "ok" | "degraded";
export type ClaimKind = "lesson" | "fact" | "coordination_pattern";
export type ClaimStatus = "provisional" | "trusted" | "retired";
export type Role = "Planner" | "Executor" | "Critic" | "Orchestrator";

export interface GraphNode {
  id: string;
  type: NodeType;
  tier: Tier;
  label: string;
  props: Record<string, any>;
  status?: string | null;
  confidence?: number | null;
  relevance?: number | null;
  ts?: number | null;
  created_at: number;
}

export interface GraphEdge {
  id: string;
  type: string;
  src: string;
  dst: string;
  weight: number;
  props: Record<string, any> | null;
  created_at: number;
}

export type EdgeType =
  | "PARENT_OF"
  | "PART_OF"
  | "CHUNK_PART_OF"
  | "PROVENANCE_EP"
  | "PROVENANCE_CHUNK"
  | "EPISODE_SUPPORTS"
  | "CHUNK_SUPPORTS"
  | "CONTRADICTS"
  | "TRACE_TOUCHED_EVENT"
  | "TRACE_TOUCHED_EPISODE"
  | "TRACE_TOUCHED_CHUNK"
  | "TRACE_TOUCHED_CLAIM"
  | "TRACE_TOUCHED_POLICY"
  | "TRACE_TOUCHED_TRACE"
  | "TRACE_PARENT"
  | "TRACE_USED_POLICY";

export const TIER_OF: Record<NodeType, Tier> = {
  Event: 1,
  Chunk: 1,
  Episode: 2,
  Claim: 3,
  Policy: 4,
  Trace: 0,
};

export const TIER_NAME: Record<number, string> = {
  0: "T0 instrumentation",
  1: "T1 raw interaction events",
  2: "T2 episodic summaries",
  3: "T3 semantic claims",
  4: "T4 policy/config",
};

export const EVENT_KINDS: EventKind[] = [
  "msg",
  "tool_call",
  "tool_result",
  "observation",
  "decision",
  "error",
  "control",
];
