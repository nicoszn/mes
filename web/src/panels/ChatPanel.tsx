import React, { useState } from "react";
import { get, post, ROLES, clock, timeAgo } from "../api";
import { Bar, Card, Empty, Json, StatusPill, TierPill, useAsync } from "../components";

const KIND_CLASS: Record<string, string> = {
  msg: "",
  decision: "decision",
  error: "err",
  control: "control",
  tool_call: "tool_call",
  tool_result: "tool_result",
  observation: "observation",
};

export default function ChatPanel() {
  const [tab, setTab] = useState<"team" | "door">("team");
  const [task, setTask] = useState("Ingestion retries: always retry failed ingestion writes automatically");
  const [maxTurns, setMaxTurns] = useState(12);
  const [maxTokens, setMaxTokens] = useState(8000);
  const [timeout, setTimeoutMs] = useState(180000);
  const [run, setRun] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const { data: eps, reload: reloadEps } = useAsync(() => get("/episodes"), []);
  const [selected, setSelected] = useState<string | null>(null);
  const { data: epDetail, reload: reloadDetail } = useAsync(
    () => (selected ? get(`/episodes/${selected}`) : Promise.resolve(null)),
    [selected]
  );
  const { data: log, reload: reloadLog } = useAsync(() => get("/log/events"), []);

  const start = async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await post("/chat", { task, budget: { max_turns: maxTurns, max_tokens: maxTokens, episode_timeout_ms: timeout } });
      setRun(res);
      reloadEps();
      reloadLog();
      setSelected(res.episode_id);
    } catch (e: any) {
      setErr(String(e.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="tabs">
        <button className={tab === "team" ? "active" : ""} onClick={() => setTab("team")}>
          Agent team run
        </button>
        <button className={tab === "door" ? "active" : ""} onClick={() => setTab("door")}>
          Raw chat door (append-only log)
        </button>
      </div>

      {tab === "team" && (
        <>
          <Card title="Dispatch a task to the team" right={<span className="small muted">Orchestrator owns open/close, budget and timeout</span>}>
            <label className="field">task</label>
            <input value={task} onChange={(e) => setTask(e.target.value)} placeholder="Describe the objective…" />
            <div className="row mt">
              <div style={{ width: 150 }}>
                <label className="field">max turns</label>
                <input type="number" value={maxTurns} onChange={(e) => setMaxTurns(Number(e.target.value))} />
              </div>
              <div style={{ width: 160 }}>
                <label className="field">token budget</label>
                <input type="number" value={maxTokens} onChange={(e) => setMaxTokens(Number(e.target.value))} />
              </div>
              <div style={{ width: 170 }}>
                <label className="field">episode timeout (ms)</label>
                <input type="number" value={timeout} onChange={(e) => setTimeoutMs(Number(e.target.value))} />
              </div>
              <div className="spacer" />
              <button className="btn" onClick={start} disabled={busy} style={{ alignSelf: "flex-end" }}>
                {busy ? "running team…" : "▶ Run team"}
              </button>
            </div>
            <div className="faint mt">
              Lower the budget below 5 turns to see <span className="mono">budget_exhausted</span> become a first-class
              episode status. Set the timeout near zero to force <span className="mono">timeout</span>.
            </div>
            {err && <div className="note err mt">{err}</div>}
          </Card>

          {run && (
            <>
              <div className="grid g4 mt mb">
                <Card>
                  <div className="stat">
                    <span className="v" style={{ color: run.status === "success" ? "var(--green)" : run.status === "failure" ? "var(--red)" : "var(--amber)" }}>
                      {run.status}
                    </span>
                    <span className="l">episode status</span>
                    <span className="s mono">{run.episode_id}</span>
                  </div>
                </Card>
                <Card title="Budget & timeout">
                  <div className="meter">
                    {(
                      [
                        ["turns", run.budget.turns_used, run.budget.max_turns],
                        ["tokens", run.budget.tokens_used, run.budget.max_tokens],
                        ["elapsed ms", run.budget.elapsed_ms, run.budget.timeout_ms],
                      ] as const
                    ).map(([k, used, max]) => (
                      <div key={k}>
                        <div className="m">
                          <span>{k}</span>
                          <span className="mono">
                            {used} / {max}
                          </span>
                        </div>
                        <Bar value={used} max={max || 1} color={used / (max || 1) > 0.85 ? "red" : ""} />
                      </div>
                    ))}
                  </div>
                  <div className="faint mt">exhaustion: {run.budget.exhausted ?? "none"}</div>
                </Card>
                <Card title="Consolidation (T1 → T2)">
                  <div className="row mb" style={{ gap: 6 }}>
                    <StatusPill status={run.consolidation?.status === "ok" ? "success" : run.consolidation?.status === "degraded" ? "failure" : "pending"} />
                    <span className="pill grey">{run.consolidation?.summarizer_id}</span>
                    <span className="pill grey">{run.consolidation?.config_version}</span>
                  </div>
                  <dl className="kv">
                    <dt>gates</dt>
                    <dd>
                      {["V1", "V2", "V3", "V4", "V5"]
                        .map((g) => `${g}:${run.consolidation?.gates?.[g]?.pass ? "✓" : "✗"}${run.consolidation?.gates?.[g]?.hard ? "*" : ""}`)
                        .join("  ")}
                    </dd>
                    <dt>citations</dt>
                    <dd>
                      {run.consolidation?.meta?.cited_count ?? 0} cited · cite_min_eff {run.consolidation?.meta?.cite_min_eff ?? "–"}
                      {run.consolidation?.meta?.short_episode ? " (short episode)" : ""}
                    </dd>
                    <dt>fallback</dt>
                    <dd>{run.consolidation?.meta?.fallback ?? "none (generative summary)"}</dd>
                    <dt>hash</dt>
                    <dd>{String(run.consolidation?.consolidation_hash ?? "–").slice(0, 20)}…</dd>
                    <dt>idempotent</dt>
                    <dd>{run.consolidation?.idempotent ? "yes (same hash on re-run)" : "no"}</dd>
                  </dl>
                  {(run.consolidation?.meta?.exemptions ?? []).map((x: string, i: number) => (
                    <div key={i} className="note ok mt" style={{ fontSize: 11.5 }}>
                      {x}
                    </div>
                  ))}
                  {(run.consolidation?.gates?.V3?.problems ?? []).map((x: string, i: number) => (
                    <div key={i} className="note err mt" style={{ fontSize: 11.5 }}>
                      V3: {x}
                    </div>
                  ))}
                </Card>
                <Card title="Claims & promotion (T2 → T3)">
                  <div className="stat">
                    <span className="v">{run.claims.created.length}</span>
                    <span className="l">new claims · {run.claims.merged} merged (canonical_hash)</span>
                  </div>
                  <div className="mt">
                    <div className="small muted mb">promotion transitions (2nd sweep must be 0)</div>
                    <div className="row" style={{ gap: 8 }}>
                      <span className="pill blue">run 1: {run.promotion.transitions.length}</span>
                      <span className={`pill ${run.promotion.idempotent ? "green" : "red"}`}>
                        idempotent: {run.promotion.idempotent ? "yes" : "NO"}
                      </span>
                    </div>
                  </div>
                </Card>
              </div>

              <div className="grid g2">
                <Card title="Transcript" right={<span className="small muted">{run.transcript.length} events, seq-monotonic</span>}>
                  <div className="transcript">
                    {run.transcript.map((e: any) => (
                      <div key={e.event_id} className={`msg ${KIND_CLASS[e.kind] ?? ""}`}>
                        <div className="head">
                          <span className="pill blue">#{e.seq}</span>
                          <span className="who">{e.role ?? "system"}</span>
                          <span className={`pill ${e.kind === "error" ? "red" : e.kind === "decision" ? "purple" : e.kind === "control" ? "grey" : "amber"}`}>
                            {e.kind}
                          </span>
                          <span className="faint mono">{e.event_id}</span>
                          {e.parent_event_id && <span className="faint">↳ parent {e.parent_event_id.slice(0, 12)}</span>}
                        </div>
                        <div className="body">{e.content}</div>
                      </div>
                    ))}
                  </div>
                </Card>

                <div className="col">
                  <Card title="Per-turn scoped retrieval" right={<span className="small muted">every read goes through the scope filter</span>}>
                    <table>
                      <thead>
                        <tr>
                          <th>role</th>
                          <th>query</th>
                          <th>visited</th>
                          <th>excluded</th>
                          <th>suff/τ</th>
                          <th>stop</th>
                        </tr>
                      </thead>
                      <tbody>
                        {run.retrievals.map((r: any, i: number) => (
                          <tr key={i}>
                            <td>
                              <strong>{r.role}</strong>
                            </td>
                            <td className="small trunc" style={{ maxWidth: 190 }} title={r.query}>
                              {r.query}
                            </td>
                            <td>{r.visited_tiers.map((t: number) => `T${t}`).join("→") || "–"}</td>
                            <td className={r.excluded_tiers.length ? "mono" : "faint"}>
                              {r.excluded_tiers.map((t: number) => `T${t}`).join(",") || "none"}
                            </td>
                            <td className="mono">
                              {r.sufficiency.toFixed(2)}/{r.tau}
                            </td>
                            <td>
                              <span className={`pill ${r.stopped_at_tier ? "green" : "amber"}`}>
                                {r.stopped_at_tier ? `T${r.stopped_at_tier}` : "bottom"}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </Card>

                  <Card title="Episode summary (the one generative field)">
                    <pre className="plain">{run.consolidation?.summary ?? "(degraded — summary withheld by gates)"}</pre>
                    <div className="small muted mt">summary spans (V1)</div>
                    <div className="scroll-x" style={{ maxHeight: 200, overflowY: "auto" }}>
                      <table>
                        <thead>
                          <tr>
                            <th>event</th>
                            <th>span</th>
                            <th>excerpt</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(run.consolidation?.summary_spans ?? []).map((s: any, i: number) => (
                            <tr key={i}>
                              <td className="mono">{s.event_id.slice(0, 14)}</td>
                              <td className="mono">
                                [{s.span[0]},{s.span[1]}]
                              </td>
                              <td className="small">{s.excerpt}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </Card>

                  <Card title="Deterministic spine (cards)">
                    <div className="grid g2">
                      {(
                        [
                          ["decisions", run.close?.consolidation?.card?.decisions ?? []],
                          ["failures", run.close?.consolidation?.card?.failures ?? []],
                          ["resources", run.close?.consolidation?.card?.resources ?? []],
                          ["open questions", run.close?.consolidation?.card?.open_questions ?? []],
                        ] as const
                      ).map(([name, items]) => (
                        <div key={name}>
                          <div className="small muted mb">
                            {name} ({items.length})
                          </div>
                          {items.map((it: any, i: number) => (
                            <div key={i} className="small" style={{ borderBottom: "1px solid #eef1f5", padding: "3px 0" }}>
                              <span className="mono faint">
                                {it.event_id?.slice(0, 10)} [{it.span?.[0]},{it.span?.[1]}]
                              </span>{" "}
                              {it.excerpt}
                              {it.tool && <span className="pill amber" style={{ marginLeft: 4 }}>{it.tool}</span>}
                            </div>
                          ))}
                          {!items.length && <div className="faint">–</div>}
                        </div>
                      ))}
                    </div>
                  </Card>

                  <Card title="Hard assertions on close">
                    <div className="row mb">
                      <span className={`pill ${run.close.assertions.v1_parent_resolution ? "green" : "red"}`}>
                        V1 parent resolution: {run.close.assertions.v1_parent_resolution ? "pass" : "FAIL"}
                      </span>
                      <span className={`pill ${run.close.assertions.v2_part_of_coverage ? "green" : "red"}`}>
                        V2 PART_OF coverage: {run.close.assertions.v2_part_of_coverage ? "pass" : "FAIL"}
                      </span>
                    </div>
                    <ul className="small muted" style={{ margin: 0, paddingLeft: 18 }}>
                      {run.close.assertions.details.map((d: string, i: number) => (
                        <li key={i}>{d}</li>
                      ))}
                    </ul>
                  </Card>
                </div>
              </div>
            </>
          )}
        </>
      )}

      {tab === "door" && <RawDoor log={log} reloadLog={reloadLog} eps={eps} reloadEps={reloadEps} selected={selected} setSelected={setSelected} epDetail={epDetail} reloadDetail={reloadDetail} />}

      {!run && tab === "team" && !eps?.episodes?.length && (
        <div className="note mt">No episodes yet — run a task above, or seed demo data from the Overview.</div>
      )}

      {tab === "team" && eps?.episodes?.length > 0 && (
        <Card className="mt" title="Episodes">
          <table>
            <thead>
              <tr>
                <th>id</th>
                <th>kind</th>
                <th>task / file</th>
                <th>status</th>
                <th>consolidation</th>
                <th>events</th>
                <th>config</th>
                <th>when</th>
              </tr>
            </thead>
            <tbody>
              {eps.episodes
                .slice()
                .reverse()
                .map((e: any) => (
                  <tr key={e.id} className="click" onClick={() => setSelected(e.id)}>
                    <td className="mono">{e.id.slice(0, 16)}</td>
                    <td>
                      <span className={`pill ${e.kind === "source" ? "t2" : "blue"}`}>{e.kind}</span>
                    </td>
                    <td className="small trunc" style={{ maxWidth: 260 }}>
                      {e.task ?? e.filename ?? "–"}
                    </td>
                    <td>
                      <StatusPill status={e.status} />
                    </td>
                    <td>
                      <span className={`pill ${e.consolidation_status === "ok" ? "green" : e.consolidation_status === "degraded" ? "red" : "grey"}`}>
                        {e.consolidation_status ?? "–"}
                      </span>
                      {e.divergence && <span className="pill red" style={{ marginLeft: 4 }}>divergent</span>}
                    </td>
                    <td className="mono">{e.event_count}</td>
                    <td className="mono faint">{e.config_version ?? "–"}</td>
                    <td className="faint">{timeAgo(e.closed_at ?? e.created_at)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

function RawDoor({
  log,
  reloadLog,
  eps,
  reloadEps,
  selected,
  setSelected,
  epDetail,
  reloadDetail,
}: any) {
  const [openTask, setOpenTask] = useState("manual control experiment");
  const [newId, setNewId] = useState<string | null>(null);
  const [form, setForm] = useState({ episode_id: "", kind: "msg", role: "Executor", content: "", parent: "" });
  const [closeStatus, setCloseStatus] = useState("success");
  const [msg, setMsg] = useState<string | null>(null);

  const openEp = async () => {
    const r = await post("/episodes/open", { task: openTask });
    setNewId(r.episode_id);
    setForm((f) => ({ ...f, episode_id: r.episode_id }));
    reloadEps();
    reloadLog();
    setMsg(`opened ${r.episode_id} — episode_open written to events.jsonl`);
  };

  const append = async () => {
    try {
      const r = await post("/events", {
        episode_id: form.episode_id,
        kind: form.kind,
        content: form.content,
        role: form.role,
        parent_event_id: form.parent || null,
      });
      setMsg(`appended ${r.event.event_id} (seq ${r.event.seq}) — fsync'd, immutable`);
      setForm((f) => ({ ...f, content: "" }));
      reloadLog();
      if (selected) reloadDetail();
    } catch (e: any) {
      setMsg(`rejected: ${e.message}`);
    }
  };

  const closeEp = async () => {
    try {
      const r = await post(`/episodes/${form.episode_id}/close`, { status: closeStatus, task: openTask });
      setMsg(`episode_close emitted → ${r.assertions.details.join(" · ")}`);
      reloadEps();
      reloadLog();
      if (selected) reloadDetail();
    } catch (e: any) {
      setMsg(`rejected: ${e.message}`);
    }
  };

  const lines = (log?.lines ?? []).slice(-120).reverse();

  return (
    <div className="grid g2">
      <div className="col">
        <Card title="1 · open an episode (emits episode_open)">
          <div className="row">
            <input value={openTask} onChange={(e) => setOpenTask(e.target.value)} />
            <button className="btn" onClick={openEp}>
              open
            </button>
          </div>
        </Card>

        <Card title="2 · append an event (role-scoped, seq monotonic)">
          <div className="row mb">
            <div style={{ width: 200 }}>
              <label className="field">episode</label>
              <input value={form.episode_id} onChange={(e) => setForm({ ...form, episode_id: e.target.value })} placeholder="ep_…" />
            </div>
            <div style={{ width: 130 }}>
              <label className="field">kind</label>
              <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                {["msg", "tool_call", "tool_result", "observation", "decision", "error", "control"].map((k) => (
                  <option key={k}>{k}</option>
                ))}
              </select>
            </div>
            <div style={{ width: 140 }}>
              <label className="field">role</label>
              <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                {ROLES.map((r) => (
                  <option key={r}>{r}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="row mb">
            <div style={{ flex: 1 }}>
              <label className="field">content</label>
              <input
                value={form.content}
                onChange={(e) => setForm({ ...form, content: e.target.value })}
                onKeyDown={(e) => e.key === "Enter" && form.content && append()}
                placeholder="event content…"
              />
            </div>
            <div style={{ width: 190 }}>
              <label className="field">parent_event_id (optional)</label>
              <input value={form.parent} onChange={(e) => setForm({ ...form, parent: e.target.value })} placeholder="ev_…" />
            </div>
          </div>
          <div className="row">
            <button className="btn" onClick={append} disabled={!form.episode_id || !form.content}>
              append event
            </button>
            <span className="faint">
              a role writing a kind outside its allowed set is rejected (scope is enforced on writes too)
            </span>
          </div>
        </Card>

        <Card title="3 · emit episode_close (never inferred)">
          <div className="row">
            <div style={{ width: 190 }}>
              <label className="field">status</label>
              <select value={closeStatus} onChange={(e) => setCloseStatus(e.target.value)}>
                {["success", "failure", "aborted", "timeout", "budget_exhausted"].map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </div>
            <button className="btn" onClick={closeEp} disabled={!form.episode_id}>
              emit close
            </button>
          </div>
          <div className="faint mt">close runs V1 + V2 assertions, writes the Episode node and PART_OF edges, then consolidation → claims → promotion.</div>
        </Card>

        {msg && <div className="note">{msg}</div>}
      </div>

      <Card title="events.jsonl — append-only, fsync per write" right={<button className="btn secondary sm" onClick={reloadLog}>↻ reload</button>}>
        <div style={{ maxHeight: 640, overflowY: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>seq</th>
                <th>episode</th>
                <th>role</th>
                <th>kind</th>
                <th>content</th>
                <th>hash</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l: any, i: number) => (
                <tr key={i}>
                  <td className="mono">{l.seq}</td>
                  <td className="mono">{String(l.episode_id).slice(0, 12)}</td>
                  <td className="small">{l.role ?? "–"}</td>
                  <td>
                    <span className="pill grey">{l.kind}</span>
                  </td>
                  <td className="small trunc" style={{ maxWidth: 260 }} title={l.content}>
                    {l.content}
                  </td>
                  <td className="mono faint">{String(l.content_hash).slice(0, 10)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!lines.length && <Empty>log empty</Empty>}
        </div>
      </Card>
    </div>
  );
}
