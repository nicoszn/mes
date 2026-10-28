// The orchestrator owns episode open/close lifecycle, agent turn dispatch, and budget &
// timeout enforcement. It is the only component that emits episode_close (never inferred).
import { uid, estimateTokens } from "./hash.js";
import { openEpisode, readEventsOf, closeEpisode, type CloseResult } from "./ingest/chat.js";
import { extractClaimsForEpisode } from "./claims.js";
import { promotionSweepTwice, type SweepResult } from "./promotion.js";
import { Agent, TOOLS, executorEventsOf, type AgentContext } from "./agents.js";
import { activePolicy, type PolicyDoc } from "./policy.js";
import { withTrace } from "./trace.js";
import { retrieve } from "./retrieval.js";
import type { EpisodeStatus, Role } from "./types.js";

export interface BudgetOverride {
  max_turns?: number;
  max_tokens?: number;
  episode_timeout_ms?: number;
}

export interface TranscriptEntry {
  seq: number;
  event_id: string;
  role: string | null;
  kind: string;
  content: string;
  ts: number;
  meta?: Record<string, any>;
}

export interface RunResult {
  episode_id: string;
  task: string;
  status: EpisodeStatus;
  transcript: TranscriptEntry[];
  steps: { title: string; executed: boolean; errors: number }[];
  budget: { max_turns: number; turns_used: number; max_tokens: number; tokens_used: number; timeout_ms: number; elapsed_ms: number; exhausted: string | null };
  close: CloseResult;
  consolidation: any;
  claims: { created: string[]; merged: string[] };
  promotion: SweepResult;
  retrievals: { role: Role; query: string; sufficiency: number; tau: number; stopped_at_tier: number | null; nodes: number; excluded_tiers: number[] }[];
  trace_id: string;
}

interface PlanStep {
  title: string;
  detail: string;
}

function buildPlan(task: string, topClaims: { text: string; confidence: number }[]): PlanStep[] {
  const steps: PlanStep[] = [{ title: "Frame objective", detail: `Define success for: ${task}` }];
  for (const c of topClaims.slice(0, 2)) {
    steps.push({ title: "Apply remembered lesson", detail: c.text });
  }
  // Gather/verify details are deliberately task-independent: identical scaffolding across
  // episodes MERGEs into one claim and is corroborated by every episode instead of creating
  // near-duplicate noise.
  steps.push({ title: "Gather evidence", detail: `Look up everything relevant to this objective` });
  steps.push({ title: "Verify and record", detail: `Confirm the outcome of this episode and record a decision` });
  return steps;
}

export async function runTask(req: { task: string; budget?: BudgetOverride }): Promise<RunResult> {
  const base = activePolicy();
  const budget = {
    max_turns: req.budget?.max_turns ?? base.budget.max_turns,
    max_tokens: req.budget?.max_tokens ?? base.budget.max_tokens,
    episode_timeout_ms: req.budget?.episode_timeout_ms ?? base.budget.episode_timeout_ms,
    turn_timeout_ms: base.budget.turn_timeout_ms,
  };
  const episode_id = `ep_${uid("").slice(3)}`;
  const started = Date.now();

  return await withTrace(
    {
      op: "orchestrator.run",
      policy_version: base.policy_version,
      model_id: base.model.model_id,
      seed: base.model.seed,
      query_text: req.task,
      episode_id,
      role: "Orchestrator",
      detail: { budget },
    },
    async (t) => {
      openEpisode(episode_id, {
        episode_kind: "task",
        task: req.task,
        budget,
        agent: "team",
      });

      const ctx: AgentContext = { episode_id, policy: base };
      const planner = new Agent("Planner" as Role, ctx);
      const executor = new Agent("Executor" as Role, ctx);
      const critic = new Agent("Critic" as Role, ctx);
      const orchestrator = new Agent("Orchestrator" as Role, ctx);

      const retrievals: RunResult["retrievals"] = [];
      const record = (r: { role: Role; query: string; sufficiency: number; tau: number; stopped_at_tier: number | null; nodes: number; excluded_tiers: number[] }) =>
        retrievals.push(r);

      // ---------------- Planner: reads T2/T3 only (T1 physically absent)
      const planMem = await planner.read(req.task);
      record({
        role: "Planner",
        query: req.task,
        sufficiency: planMem.sufficiency,
        tau: planMem.tau,
        stopped_at_tier: planMem.stopped_at_tier,
        nodes: planMem.nodes.length,
        excluded_tiers: planMem.excluded_tiers,
      });
      const topClaims = planMem.nodes.filter((n) => n.type === "Claim");
      const planMsg = planner.emit(
        "msg",
        `Plan for "${req.task}": ${planMem.nodes.length} scoped memory node(s) visible (T1 excluded: ${planMem.excluded_tiers.includes(1)}).`
      );
      const steps = buildPlan(req.task, topClaims.map((c) => ({ text: c.text, confidence: c.confidence ?? 0 })));
      for (const [i, s] of steps.entries()) {
        planner.emit("decision", `Step ${i + 1} — ${s.title}: ${s.detail}`, { parent: planMsg });
      }
      planner.emit("control", `plan_ready steps=${steps.length}`, { parent: planMsg });

      // ---------------- Execute each step, with the critic reviewing in between
      let turns = 1;
      let tokens = readEventsOf(episode_id).reduce((a, e) => a + e.token_count, 0);
      let exhausted: string | null = null;
      let criticErrors = 0;
      const stepStatus = steps.map(() => ({ title: "", executed: false, errors: 0 }));

      for (let i = 0; i < steps.length; i++) {
        const elapsed = Date.now() - started;
        if (elapsed > budget.episode_timeout_ms) {
          exhausted = "timeout";
          break;
        }
        if (turns >= budget.max_turns) {
          exhausted = "max_turns";
          break;
        }
        if (tokens >= budget.max_tokens) {
          exhausted = "max_tokens";
          break;
        }
        const step = steps[i];
        stepStatus[i].title = step.title;

        // --- Executor turn (writes only its permitted kinds)
        const turnStart = Date.now();
        const callId = executor.emit("tool_call", `memory.search ${JSON.stringify(step.detail)}`, {
          meta: { tool: "memory.search", args_summary: step.detail.slice(0, 120) },
        });
        const res = await executor.read(step.detail);
        record({
          role: "Executor",
          query: step.detail,
          sufficiency: res.sufficiency,
          tau: res.tau,
          stopped_at_tier: res.stopped_at_tier,
          nodes: res.nodes.length,
          excluded_tiers: res.excluded_tiers,
        });
        const out = await TOOLS["memory.search"].run(step.detail, ctx, "Executor");
        executor.emit("tool_result", out.output, { parent: callId, meta: { tool: "memory.search", nodes: out.nodes } });
        executor.emit(
          "observation",
          `Step ${i + 1} sufficiency ${res.sufficiency.toFixed(3)} (τ ${res.tau}) → ${
            res.stopped_at_tier ? `stopped at T${res.stopped_at_tier}` : "bottom of hierarchy"
          }; visited ${res.visited_tiers.join("→") || "none"}; excluded tiers ${res.excluded_tiers.join(",") || "none"}.`
        );
        if (res.nodes.length === 0) {
          executor.emit("error", `Step ${i + 1} has no visible memory for "${step.detail.slice(0, 80)}" — proceeding without remembered context.`);
          stepStatus[i].errors++;
        }
        executor.emit("decision", `Execute step ${i + 1} (${step.title}) using local deterministic runner.`);
        stepStatus[i].executed = true;
        turns++;
        tokens = readEventsOf(episode_id).reduce((a, e) => a + e.token_count, 0);

        if (Date.now() - turnStart > budget.turn_timeout_ms) {
          exhausted = "turn_timeout";
          break;
        }

        // --- Critic turn (reads Executor events plus T3 lessons)
        if (turns >= budget.max_turns) break;
        const exEvents = executorEventsOf(episode_id);
        const lessons = await critic.read(`lessons errors risks ${step.title}`);
        record({
          role: "Critic",
          query: `lessons errors risks ${step.title}`,
          sufficiency: lessons.sufficiency,
          tau: lessons.tau,
          stopped_at_tier: lessons.stopped_at_tier,
          nodes: lessons.nodes.length,
          excluded_tiers: lessons.excluded_tiers,
        });
        const lessonClaims = lessons.nodes.filter((n) => n.type === "Claim");
        critic.emit(
          "observation",
          `Reviewed ${exEvents.length} executor event(s); ${lessonClaims.length} T3 lesson(s) in scope for step ${i + 1}.`
        );
        if (stepStatus[i].errors > 0) {
          const err = critic.emit("error", `Step ${i + 1} recorded a memory gap; requires explicit provenance before acceptance.`);
          criticErrors++;
          void err;
        } else {
          critic.emit("decision", `Step ${i + 1} accepted: executor events present and provenance intact.`);
        }
        turns++;
        tokens = readEventsOf(episode_id).reduce((a, e) => a + e.token_count, 0);
      }

      // ---------------- Status resolution (budget/timeout are first-class outcomes)
      let status: EpisodeStatus = "success";
      if (exhausted === "timeout" || exhausted === "turn_timeout") status = "timeout";
      else if (exhausted === "max_turns" || exhausted === "max_tokens") status = "budget_exhausted";
      else if (criticErrors >= 2) status = "failure";

      const elapsedMs = Date.now() - started;
      orchestrator.emit(
        "control",
        `budget turns=${turns}/${budget.max_turns} tokens=${tokens}/${budget.max_tokens} elapsed=${elapsedMs}ms/${budget.episode_timeout_ms}ms exhausted=${exhausted ?? "none"}`,
        { meta: { control: "budget_report", status } }
      );
      orchestrator.emit("decision", `Close episode with status ${status} after ${turns} agent turn(s).`);

      // ---------------- close: emits episode_close, runs assertions, consolidation, claims, promotion
      const close = await closeEpisode({ episode_id, status, task: req.task, budget });
      const claims = await extractClaimsForEpisode(episode_id);
      const promotion = await promotionSweepTwice();

      const transcript: TranscriptEntry[] = readEventsOf(episode_id).map((e) => ({
        seq: e.seq,
        event_id: e.event_id,
        role: e.role,
        kind: e.kind,
        content: e.content,
        ts: e.ts,
        meta: e.meta,
      }));

      t.touch(episode_id);
      t.touchAll(transcript.map((x) => x.event_id));
      t.tokens(tokens, 0);
      t.set({ outcome: status === "success" ? "ok" : status });
      t.meta({
        status,
        turns,
        steps: steps.length,
        claims_created: claims.claims_created.length,
        promotion_transitions: promotion.transitions.length,
        consolidation_status: close.consolidation?.status,
      });

      return {
        episode_id,
        task: req.task,
        status,
        transcript,
        steps: stepStatus.map((s) => ({ title: s.title || "not executed", executed: s.executed, errors: s.errors })),
        budget: {
          max_turns: budget.max_turns,
          turns_used: turns,
          max_tokens: budget.max_tokens,
          tokens_used: tokens,
          timeout_ms: budget.episode_timeout_ms,
          elapsed_ms: elapsedMs,
          exhausted,
        },
        close,
        consolidation: close.consolidation,
        claims: { created: claims.claims_created, merged: claims.claims_merged },
        promotion,
        retrievals,
        trace_id: t.current().trace_id,
      };
    }
  );
}
