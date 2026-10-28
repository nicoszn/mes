import React, { useState } from "react";
import { get, post, ROLES } from "../api";
import { Bar, Card, Empty, TierPill, useAsync } from "../components";

function Waterfall({ result }: { result: any }) {
  return (
    <div className="col" style={{ gap: 10 }}>
      {result.tiers.map((t: any) => (
        <div key={t.tier} style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "9px 11px" }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span className="row" style={{ gap: 8 }}>
              <TierPill tier={t.tier} />
              <strong className="small">{t.tier_label}</strong>
              {t.predicate && <span className="pill grey">predicate: {t.predicate}</span>}
            </span>
            <span className="row" style={{ gap: 6 }}>
              <span className="pill grey">vis {t.visibility.toFixed(1)}</span>
              <span className={`pill ${t.excluded_by_scope ? "red" : t.stopped_here ? "green" : "amber"}`}>
                {t.excluded_by_scope ? "EXCLUDED (hard filter)" : t.stopped_here ? "STOP — sufficiency reached" : "insufficient → descend"}
              </span>
            </span>
          </div>
          {t.excluded_by_scope ? (
            <div className="faint mt">{t.note}</div>
          ) : (
            <>
              <div className="row mt" style={{ gap: 12 }}>
                {(
                  [
                    ["coverage", t.coverage, ""],
                    ["provenance", t.provenance_strength, "purple"],
                    ["recency", t.recency, "green"],
                  ] as const
                ).map(([k, v, c]) => (
                  <div key={k} style={{ flex: 1 }}>
                    <div className="row" style={{ justifyContent: "space-between" }}>
                      <span className="faint">{k}</span>
                      <span className="mono small">{v.toFixed(3)}</span>
                    </div>
                    <Bar value={v} color={c} />
                  </div>
                ))}
                <div style={{ width: 108 }}>
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <span className="faint">suff</span>
                    <span className="mono small" style={{ fontWeight: 700 }}>
                      {t.suff.toFixed(3)}
                    </span>
                  </div>
                  <Bar value={t.suff} max={Math.max(1, t.tau)} color={t.stopped_here ? "green" : "amber"} />
                  <div className="faint">τ = {t.tau}</div>
                </div>
                <div style={{ width: 90 }}>
                  <div className="faint">candidates</div>
                  <div className="mono" style={{ fontWeight: 700, fontSize: 15 }}>
                    {t.candidate_count}
                  </div>
                </div>
              </div>
              <div className="faint mt">{t.note}</div>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

export default function RetrievalPanel({ refresh }: { refresh?: () => void }) {
  const [query, setQuery] = useState("retry ingestion writes lesson provenance");
  const [role, setRole] = useState("Planner");
  const [policyVersion, setPolicyVersion] = useState("");
  const [result, setResult] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { data: policies } = useAsync(() => get("/policies"), []);

  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      setResult(await post("/retrieve", { query, role, policy_version: policyVersion || undefined }));
      refresh?.();
    } catch (e: any) {
      setErr(String(e.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <Card title="Query" right={<span className="small muted">vector index ⇒ candidates only · graph scores ⇒ ranking</span>}>
        <div className="row">
          <div style={{ flex: 1 }}>
            <label className="field">query</label>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && run()}
              placeholder="try something with rare words to force descent to T1…"
            />
          </div>
          <div style={{ width: 160 }}>
            <label className="field">role (scope filter)</label>
            <select value={role} onChange={(e) => setRole(e.target.value)}>
              {ROLES.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </div>
          <div style={{ width: 170 }}>
            <label className="field">policy version</label>
            <select value={policyVersion} onChange={(e) => setPolicyVersion(e.target.value)}>
              <option value="">active ({policies?.active_version})</option>
              {(policies?.versions ?? []).map((v: any) => (
                <option key={v.version} value={v.version}>
                  {v.version}
                </option>
              ))}
            </select>
          </div>
          <div style={{ alignSelf: "flex-end" }}>
            <button className="btn" onClick={run} disabled={busy}>
              {busy ? "retrieving…" : "▶ Retrieve"}
            </button>
          </div>
        </div>
        {err && <div className="note err mt">{err}</div>}
      </Card>

      {result && (
        <>
          <div className="grid g4 mt mb">
            <Card>
              <div className="stat">
                <span className="v">{result.stop_reason === "sufficiency_reached" ? `T${result.stopped_at_tier}` : "T1"}</span>
                <span className="l">descent stopped at</span>
                <span className="s">{result.stop_reason}</span>
              </div>
            </Card>
            <Card>
              <div className="stat">
                <span className="v">{result.sufficiency.toFixed(3)}</span>
                <span className="l">final sufficiency</span>
                <span className="s">τ = {result.tau} (policy.retrieval)</span>
              </div>
            </Card>
            <Card>
              <div className="stat">
                <span className="v">{result.visited_tiers.map((t: number) => `T${t}`).join("→") || "none"}</span>
                <span className="l">tiers descended</span>
                <span className="s">hierarchy never exhausted when sufficiency is reached</span>
              </div>
            </Card>
            <Card>
              <div className="stat">
                <span className="v" style={{ color: "var(--red)" }}>
                  {result.excluded_tiers.map((t: number) => `T${t}`).join(", ") || "none"}
                </span>
                <span className="l">excluded by scope</span>
                <span className="s">physically absent from the candidate set</span>
              </div>
            </Card>
          </div>

          <div className="grid g2">
            <Card title="Sufficiency-gated descent">
              <Waterfall result={result} />
            </Card>

            <div className="col">
              <Card title={`Returned nodes (${result.nodes.length})`} right={<span className="small muted">rank = graph scores only</span>}>
                <table>
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>node</th>
                      <th>tier</th>
                      <th>rank</th>
                      <th>cov</th>
                      <th>evidence</th>
                      <th>rec</th>
                      <th>vector (candidates only)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.nodes.map((n: any, i: number) => (
                      <tr key={n.id}>
                        <td className="mono">{i + 1}</td>
                        <td>
                          <div className="row" style={{ gap: 6 }}>
                            <span className="pill grey">{n.type}</span>
                            {n.status && <span className={`pill ${n.status === "trusted" ? "green" : n.status === "retired" ? "red" : "amber"}`}>{n.status}</span>}
                          </div>
                          <div className="small trunc" style={{ maxWidth: 300 }} title={n.text}>
                            {n.text || n.label}
                          </div>
                          <div className="mono faint">{n.id}</div>
                        </td>
                        <td>
                          <TierPill tier={n.tier} small />
                        </td>
                        <td className="mono" style={{ fontWeight: 700 }}>
                          {n.rank_score.toFixed(3)}
                        </td>
                        <td className="mono">{n.node_coverage.toFixed(2)}</td>
                        <td className="mono">{n.evidence_score.toFixed(2)}</td>
                        <td className="mono">{n.recency.toFixed(2)}</td>
                        <td className="mono faint">{n.vector_score == null ? "–" : n.vector_score.toFixed(3)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!result.nodes.length && <Empty>No nodes returned.</Empty>}
                <div className="note mt">
                  Note the ordering: rank never includes the vector score — similarity only nominated candidates, the
                  graph decided the order.
                </div>
              </Card>

              <Card title="Provenance paths (why these memories are justified)">
                {result.provenance_paths.map((p: any, i: number) => (
                  <div key={i} className="mb">
                    <div className="mono small">{p.root}</div>
                    {p.paths.map((path: string[], j: number) => (
                      <div key={j} className="row wrap" style={{ gap: 4, marginTop: 3 }}>
                        {path.map((id, k) => (
                          <React.Fragment key={k}>
                            {k > 0 && <span className="faint">→</span>}
                            <span className="pill t2" style={{ fontSize: 10 }}>
                              {id}
                            </span>
                          </React.Fragment>
                        ))}
                      </div>
                    ))}
                    {!p.paths.length && <div className="faint">no provenance edges</div>}
                  </div>
                ))}
                {!result.provenance_paths.length && <Empty>nothing to trace</Empty>}
              </Card>

              <Card
                title={`Vector candidates (${result.vector_candidates.length})`}
                right={<span className="small muted">candidate generation — never final ranking</span>}
              >
                <div style={{ maxHeight: 200, overflowY: "auto" }}>
                  <table>
                    <thead>
                      <tr>
                        <th>id</th>
                        <th>tier</th>
                        <th>type</th>
                        <th>cosine</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.vector_candidates.slice(0, 30).map((c: any) => (
                        <tr key={c.id}>
                          <td className="mono">{c.id}</td>
                          <td>
                            <TierPill tier={c.tier} small />
                          </td>
                          <td>{c.type}</td>
                          <td className="mono">{c.vector_score.toFixed(4)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            </div>
          </div>

          <Card className="mt" title="Retrieval trace" right={<span className="small muted">instrumentation precedes features</span>}>
            <div className="row wrap">
              <span className="pill blue mono">trace {result.trace_id}</span>
              <span className="pill grey">op retrieval.query</span>
              <span className="pill grey">policy {result.policy_version}</span>
              <span className="pill grey">role {result.role}</span>
              <span className="pill grey">latency {result.latency_ms}ms</span>
              <span className="pill purple">τ {result.tau}</span>
            </div>
            <div className="faint mt">
              Open <strong>Traces & audit</strong> and paste this id to reconstruct exactly why this answer was returned.
            </div>
          </Card>
        </>
      )}

      {!result && <div className="note mt">Run a query to see the sufficiency waterfall, the scope filter and the ranked results.</div>}
    </div>
  );
}
