import React, { useState } from "react";
import { get, timeAgo, clock } from "../api";
import { Bar, Card, Drawer, Empty, Json, StatusPill, TierPill, useAsync } from "../components";

export default function TracesPanel() {
  const [op, setOp] = useState("");
  const [outcome, setOutcome] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [logTab, setLogTab] = useState<"traces" | "events">("traces");

  const query = `/traces?${op ? `op=${op}&` : ""}${outcome ? `outcome=${outcome}&` : ""}limit=300`;
  const { data, reload } = useAsync(() => get(query), [query]);
  const { data: audit, reload: reloadAudit } = useAsync(
    () => (selected ? get(`/traces/${selected}`) : Promise.resolve(null)),
    [selected]
  );
  const { data: log, reload: reloadLog } = useAsync(() => get(`/log/${logTab}`), [logTab]);

  const stats = data?.stats ?? { ops: [], totals: {} };
  const traces = data?.traces ?? [];
  const ops = Array.from(new Set(traces.map((t: any) => t.op))) as string[];

  return (
    <div>
      <div className="grid g4 mb">
        <Card>
          <div className="stat">
            <span className="v">{stats.totals?.count ?? 0}</span>
            <span className="l">traces recorded</span>
            <span className="s">append-only JSONL = source of truth</span>
          </div>
        </Card>
        <Card>
          <div className="stat">
            <span className="v">{stats.totals?.errors ?? 0}</span>
            <span className="l">errored operations</span>
            <span className="s">{((stats.totals?.errors ?? 0) / Math.max(1, stats.totals?.count ?? 1) * 100).toFixed(1)}% error rate</span>
          </div>
        </Card>
        <Card>
          <div className="stat">
            <span className="v">{(stats.totals?.tokens_in ?? 0) + (stats.totals?.tokens_out ?? 0)}</span>
            <span className="l">tokens in/out</span>
            <span className="s">{stats.totals?.tokens_in ?? 0} in · {stats.totals?.tokens_out ?? 0} out</span>
          </div>
        </Card>
        <Card>
          <div className="stat">
            <span className="v">${(stats.totals?.cost_usd ?? 0).toFixed(4)}</span>
            <span className="l">total cost</span>
            <span className="s">priced by policy model.cost_per_1k_tokens</span>
          </div>
        </Card>
      </div>

      <Card title="Trace statistics per operation" right={<button className="btn secondary sm" onClick={reload}>↻</button>}>
        <table>
          <thead>
            <tr>
              <th>op</th>
              <th>count</th>
              <th>avg ms</th>
              <th>p95 ms</th>
              <th>tokens in/out</th>
              <th>cost</th>
              <th>error rate</th>
              <th>avg nodes touched</th>
              <th>tiers</th>
            </tr>
          </thead>
          <tbody>
            {stats.ops.map((s: any) => (
              <tr key={s.op}>
                <td className="mono">{s.op}</td>
                <td className="mono">{s.count}</td>
                <td style={{ minWidth: 110 }}>
                  <div className="mono small">{s.avg_latency_ms.toFixed(1)}</div>
                  <Bar value={s.avg_latency_ms} max={Math.max(1, ...stats.ops.map((x: any) => x.p95_latency_ms))} />
                </td>
                <td className="mono">{s.p95_latency_ms.toFixed(1)}</td>
                <td className="mono">{s.total_tokens_in}/{s.total_tokens_out}</td>
                <td className="mono">${s.total_cost_usd.toFixed(4)}</td>
                <td className="mono" style={{ color: s.error_rate > 0 ? "var(--red)" : undefined }}>{(s.error_rate * 100).toFixed(1)}%</td>
                <td className="mono">{s.avg_nodes_touched.toFixed(1)}</td>
                <td>{s.tiers.map((t: number) => <TierPill key={t} tier={t} small />)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!stats.ops.length && <Empty>No traces yet.</Empty>}
      </Card>

      <div className="grid g2 mt">
        <Card
          title="Trace log"
          right={
            <span className="row" style={{ gap: 8 }}>
              <select value={op} onChange={(e) => setOp(e.target.value)} style={{ width: 170 }}>
                <option value="">all ops</option>
                {ops.map((o) => (
                  <option key={o} value={o}>{o}</option>
                ))}
              </select>
              <select value={outcome} onChange={(e) => setOutcome(e.target.value)} style={{ width: 130 }}>
                <option value="">all outcomes</option>
                <option value="ok">ok</option>
                <option value="error">error</option>
                <option value="degraded">degraded</option>
                <option value="divergence">divergence</option>
              </select>
            </span>
          }
        >
          <div style={{ maxHeight: 560, overflowY: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>op</th>
                  <th>outcome</th>
                  <th>policy</th>
                  <th>ms</th>
                  <th>tokens</th>
                  <th>nodes</th>
                  <th>parent</th>
                  <th>when</th>
                </tr>
              </thead>
              <tbody>
                {traces.map((t: any) => (
                  <tr key={t.trace_id} className="click" onClick={() => setSelected(t.trace_id)}>
                    <td className="mono">{t.op}</td>
                    <td>
                      <StatusPill status={t.outcome === "ok" ? "success" : t.outcome === "error" ? "failure" : t.outcome} />
                    </td>
                    <td className="mono">{t.policy_version}</td>
                    <td className="mono">{t.latency_ms}</td>
                    <td className="mono">{t.tokens_in}/{t.tokens_out}</td>
                    <td className="mono">{t.nodes_touched?.length ?? 0}</td>
                    <td className="mono faint">{t.parent_id ? String(t.parent_id).slice(0, 12) : "–"}</td>
                    <td className="faint">{clock(t.started_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!traces.length && <Empty>No traces match.</Empty>}
          </div>
        </Card>

        <Card
          title="Raw logs"
          right={
            <span className="row" style={{ gap: 8 }}>
              <button className={`btn sm ${logTab === "traces" ? "" : "secondary"}`} onClick={() => setLogTab("traces")}>traces.jsonl</button>
              <button className={`btn sm ${logTab === "events" ? "" : "secondary"}`} onClick={() => setLogTab("events")}>events.jsonl</button>
              <button className="btn secondary sm" onClick={reloadLog}>↻</button>
            </span>
          }
        >
          <pre className="plain" style={{ maxHeight: 560 }}>
            {(log?.lines ?? []).slice(-60).reverse().map((l: any) => JSON.stringify(l)).join("\n") || "(empty)"}
          </pre>
          <div className="note mt">
            Lines are appended with <span className="mono">fsync</span> per write and never mutated. Trace nodes in the
            graph are rebuilt from this file at boot — the log, not the graph row, is authoritative.
          </div>
        </Card>
      </div>

      <Drawer open={!!selected} onClose={() => setSelected(null)}>
        {audit && (
          <div className="col">
            <div className="row">
              <span className="pill blue mono">{audit.trace.op}</span>
              <StatusPill status={audit.trace.outcome === "ok" ? "success" : audit.trace.outcome === "error" ? "failure" : audit.trace.outcome} />
              <TierPill tier={0} />
            </div>
            <h3 className="title-lg">audit: {audit.trace.trace_id}</h3>
            <div className="mono faint">trc_{audit.trace.trace_id.replace(/^tr_/, "")}</div>

            <Card title="Record">
              <dl className="kv">
                <dt>policy_version</dt><dd>{audit.trace.policy_version}</dd>
                <dt>model_id / seed</dt><dd>{audit.trace.model_id} / {audit.trace.seed}</dd>
                <dt>started → ended</dt><dd>{new Date(audit.trace.started_at).toISOString()} → {new Date(audit.trace.ended_at).toISOString()}</dd>
                <dt>latency</dt><dd>{audit.trace.latency_ms}ms</dd>
                <dt>tokens in/out</dt><dd>{audit.trace.tokens_in} / {audit.trace.tokens_out}</dd>
                <dt>cost</dt><dd>${audit.trace.cost_usd.toFixed(5)}</dd>
                <dt>outcome</dt><dd>{audit.trace.outcome}{audit.trace.error ? ` — ${audit.trace.error}` : ""}</dd>
                <dt>query</dt><dd>{audit.trace.query_text ?? "–"}</dd>
                <dt>tiers descended</dt><dd>{(audit.trace.tiers_descended ?? []).join(" → ") || "–"}</dd>
                <dt>parent</dt><dd>{audit.trace.parent_id ?? "–"}</dd>
                <dt>episode</dt><dd>{audit.trace.episode_id ?? "–"}</dd>
                <dt>role</dt><dd>{audit.trace.role ?? "–"}</dd>
                <dt>nodes touched</dt><dd>{audit.trace.nodes_touched.length}</dd>
              </dl>
            </Card>

            {audit.policy && (
              <Card title="Policy version this ran under (replayable)">
                <dl className="kv">
                  <dt>τ</dt><dd>{audit.policy.retrieval?.tau}</dd>
                  <dt>bands</dt><dd>{JSON.stringify(audit.policy.claims?.bands)}</dd>
                  <dt>half-life</dt><dd>{audit.policy.claims?.half_life_days}d</dd>
                  <dt>model</dt><dd>{audit.policy.model?.model_id} seed {audit.policy.model?.seed}</dd>
                </dl>
              </Card>
            )}

            <Card title="Why did this happen — reconstruction">
              <div className="timeline">
                {audit.timeline.map((e: any, i: number) => (
                  <div key={i} className="ev">
                    <div className="t">{new Date(e.at).toISOString()} · {timeAgo(e.at)}</div>
                    <div className="w">{e.what}</div>
                    {e.detail && <div className="mono faint">{JSON.stringify(e.detail).slice(0, 220)}</div>}
                  </div>
                ))}
              </div>
            </Card>

            <Card title={`Nested traces (${audit.children.length})`}>
              {audit.children.map((c: any) => (
                <div key={c.trace_id} className="row small" style={{ justifyContent: "space-between", padding: "3px 0", borderBottom: "1px solid #eef1f5" }}>
                  <span className="mono">{c.op}</span>
                  <StatusPill status={c.outcome === "ok" ? "success" : "failure"} />
                  <span className="mono">{c.latency_ms}ms</span>
                  <button className="btn secondary sm" onClick={() => setSelected(c.trace_id)}>open</button>
                </div>
              ))}
              {!audit.children.length && <div className="faint">leaf trace</div>}
              {audit.parent && (
                <div className="mt">
                  <button className="btn secondary sm" onClick={() => setSelected(audit.parent.trace_id)}>
                    ← parent {audit.parent.op}
                  </button>
                </div>
              )}
            </Card>

            <Card title={`Touched nodes (${audit.touched.length})`}>
              <div className="scroll-x" style={{ maxHeight: 260, overflowY: "auto" }}>
                <table>
                  <tbody>
                    {audit.touched.map((n: any) => (
                      <tr key={n.id}>
                        <td><TierPill tier={n.tier} small /></td>
                        <td className="mono">{n.type}</td>
                        <td className="mono">{n.id}</td>
                        <td className="small trunc" style={{ maxWidth: 160 }}>{n.label}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>

            <Card title="Raw record"><Json data={audit.trace} max={8000} /></Card>
          </div>
        )}
      </Drawer>
    </div>
  );
}
