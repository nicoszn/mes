// Regression tests for the V3 correction: short chat episodes must never degrade solely
// because of cite_min. Run with `npm test`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hmm-consolidation-test-"));
process.env.HMM_DATA_DIR = dir;

const { bootstrap } = await import("../server/index.js");
bootstrap();

const { appendEvent, closeEpisode, readEventsOf } = await import("../server/ingest/chat.js");
const { effectiveCiteMin } = await import("../server/consolidate.js");
const { activePolicy } = await import("../server/policy.js");

interface Outcome {
  status: string;
  summary: string | null;
  summary_spans: { event_id: string; span: [number, number] }[];
  gates: any;
  meta: any;
}

let failures = 0;
function check(label: string, cond: boolean, extra?: any) {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures++;
    console.error(`  FAIL  ${label}`, extra !== undefined ? JSON.stringify(extra) : "");
  }
}

async function runEpisode(id: string, build: (ep: string) => void): Promise<Outcome> {
  build(id);
  const res = await closeEpisode({ episode_id: id, status: "success", task: `regression ${id}` });
  return res.consolidation as Outcome;
}

console.log("\n[1] single-event chat episode (one msg)");
{
  const out = await runEpisode("ep_test_single", (ep) => {
    appendEvent({ episode_id: ep, kind: "msg", content: "hello team, please inspect the pipeline health", role: "Planner" });
  });
  const events = readEventsOf("ep_test_single");
  const cited = new Set(out.summary_spans.map((s) => s.event_id));
  const msgEvent = events.find((e) => e.kind === "msg")!;

  check("consolidation_status is ok", out.status === "ok", out.status);
  check("summary is not null", typeof out.summary === "string" && out.summary!.length > 0, out.summary);
  check("summary_spans is non-empty", out.summary_spans.length >= 1, out.summary_spans.length);
  check("summary_spans cite the msg event id", cited.has(msgEvent.event_id), [...cited]);
  check("every cited span resolves to a real episode event", [...cited].every((id) => events.some((e) => e.event_id === id)));
  check("V1 and V2 remain absolute hard gates", out.gates.V1.pass && out.gates.V2.pass);
  check("V3 is binary (score null), not a continuous score", out.gates.V3.score === null, out.gates.V3.score);
  check("V3 passes", out.gates.V3.pass, out.gates.V3.problems);
  check(
    `cite_min_eff clamped to len(events) = ${effectiveCiteMin(activePolicy(), events.length)}`,
    out.meta.cite_min_eff === effectiveCiteMin(activePolicy(), events.length),
    out.meta
  );
  check("short-episode exemption recorded in consolidation_meta.exemptions",
    out.meta.short_episode === true && Array.isArray(out.meta.exemptions) && out.meta.exemptions.length > 0, out.meta.exemptions);
}

console.log("\n[2] two-event chat episode (msg + decision)");
{
  const out = await runEpisode("ep_test_two", (ep) => {
    appendEvent({ episode_id: ep, kind: "msg", content: "we should cache the token response", role: "Planner" });
    appendEvent({ episode_id: ep, kind: "decision", content: "Cache the token response for 60 seconds.", role: "Planner" });
  });
  const events = readEventsOf("ep_test_two");
  const cited = new Set(out.summary_spans.map((s) => s.event_id));
  const msgEvent = events.find((e) => e.kind === "msg")!;
  const decisionEvent = events.find((e) => e.kind === "decision")!;

  check("consolidation_status is ok", out.status === "ok", out.status);
  check("summary is not null", typeof out.summary === "string" && out.summary!.length > 0, out.summary);
  check("summary_spans non-empty", out.summary_spans.length >= 1, out.summary_spans.length);
  check("summary_spans cite the msg event id", cited.has(msgEvent.event_id), [...cited]);
  check("summary_spans cite the decision event id", cited.has(decisionEvent.event_id), [...cited]);
  check("every cited span resolves to a real episode event", [...cited].every((id) => events.some((e) => e.event_id === id)));
  check("V1 and V2 remain absolute hard gates", out.gates.V1.pass && out.gates.V2.pass);
  check("V3 passes", out.gates.V3.pass, out.gates.V3.problems);
  check("spine decision entry is covered by the deterministic spine",
    out.gates.V3.details.some((d: string) => d.includes("spine coverage")), out.gates.V3.details);
}

console.log(failures === 0 ? "\nAll consolidation regression tests passed.\n" : `\n${failures} assertion(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
