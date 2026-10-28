import React, { useState } from "react";
import { get, post, ROLES } from "../api";
import { Bar, Card, Empty, PassFail, TierPill, useAsync } from "../components";

export default function ScopePanel() {
  const [role, setRole] = useState<string>("Planner");
  const [query, setQuery] = useState("retry ingestion writes provenance");
  const [result, setResult] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  const { data } = useAsync(() => get(`/scope?role=${encodeURIComponent(role)}`), [role]);
  const { data: roles } = useAsync(() => get("/bootstrap"), []);

  const runScoped = async () => {
    setBusy(true);
    try {
      setResult(await post("/retrieve", { query, role }));
    } catch (e: any) {
      setResult({ error: String(e.message ?? e) });
    } finally {
      setBusy(false);
    }
  };

  const matrix = data?.matrix ?? {};
  const canonical = data?.canonical ?? {};
  const tests = data?.tests ?? [];
  const testsByRole: Record<string, any[]> = {};
  for (const t of tests) (testsByRole[t.role] ??= []).push(t);

  return (
    <div>
      <Card title="visibility(role, tier) — policy.scope.matrix" right={<span className="small muted">0.0 ⇒ tier physically absent from candidate set</span>}>
        <div className="scroll-x">
          <table className="matrix">
            <thead>
              <tr>
                <th>role</th>
                <th>T1 raw events</th>
                <th>T2 episodes/sources</th>
                <th>T3 claims</th>
                <th>T4 policy</th>
                <th>slice predicates</th>
                <th>allowed event kinds</th>
              </tr>
            </thead>
            <tbody>
              {ROLES.map((r) => (
                <tr key={r}>
                  <td style={{ textAlign: "left" }}>
                    <strong>{r}</strong>
                    <div className="faint" style={{ maxWidth: 260 }}>
                      {roles?.roles?.find((x: any) => x.role === r)?.description}
                    </div>
                  </td>
                  {[1, 2, 3, 4].map((t) => {
                    const v = matrix[r]?.[String(t)] ?? 0;
                    return (
                      <td key={t}>
                        <span className={`chip-vis ${v > 0 ? "on" : "off"}`}>{v.toFixed(1)}</span>
                      </td>
                    );
                  })}
                  <td style={{ textAlign: "left" }}>
                    {Object.entries(data?.predicates?.[r] ?? {}).map(([t, rule]) => (
                      <div key={t} className="mono faint">
                        T{t}: {String(rule)}
                      </div>
                    ))}
                    {!Object.keys(data?.predicates?.[r] ?? {}).length && <span className="faint">–</span>}
                  </td>
                  <td style={{ textAlign: "left" }}>
                    {(roles?.roles?.find((x: any) => x.role === r)?.allowed_event_kinds ?? []).map((k: string) => (
                      <span key={k} className="pill grey" style={{ margin: 1 }}>
                        {k}
                      </span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="note mt">
          The matrix is enforced <strong>structurally</strong>: excluded tiers are removed from the candidate query
          before any scoring happens. A reranking penalty would not produce a passing test.
        </div>
      </Card>

      <Card className="mt" title="Structural assertion: pass/fail per role per tier" right={<span className="small muted">{tests.filter((t: any) => t.pass).length}/{tests.length} pass</span>}>
        <table>
          <thead>
            <tr>
              <th>role</th>
              <th>tier</th>
              <th>expected</th>
              <th>actual</th>
              <th>nodes in tier</th>
              <th>after filter</th>
              <th>result</th>
              <th>note</th>
            </tr>
          </thead>
          <tbody>
            {tests.map((t: any, i: number) => (
              <tr key={i}>
                <td>
                  <strong>{t.role}</strong>
                </td>
                <td>
                  <TierPill tier={t.tier} small />
                </td>
                <td className="mono">{t.expected ? "visible" : "absent"}</td>
                <td className="mono">{t.actual ? "visible" : "absent"}</td>
                <td className="mono">{t.nodes_in_tier}</td>
                <td className="mono">{t.present_after_filter}</td>
                <td>
                  <PassFail pass={t.pass} />
                </td>
                <td className="small faint">{t.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card className="mt" title="Scoped retrieval probe" right={<span className="small muted">what this role can actually see</span>}>
        <div className="row mb">
          <div style={{ width: 170 }}>
            <label className="field">role</label>
            <select value={role} onChange={(e) => setRole(e.target.value)}>
              {ROLES.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <label className="field">query</label>
            <input value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <div style={{ alignSelf: "flex-end" }}>
            <button className="btn" onClick={runScoped} disabled={busy}>
              {busy ? "retrieving…" : "Run scoped retrieval"}
            </button>
          </div>
        </div>

        {result && !result.error && (
          <>
            <div className="row wrap mb" style={{ gap: 8 }}>
              <span className="pill blue">excluded tiers: {result.excluded_tiers.map((t: number) => `T${t}`).join(", ") || "none"}</span>
              <span className="pill green">visited: {result.visited_tiers.map((t: number) => `T${t}`).join(" → ") || "none"}</span>
              <span className="pill purple">stop: {result.stop_reason}</span>
              <span className="pill grey">suff {result.sufficiency.toFixed(3)} / τ {result.tau}</span>
            </div>
            <div className="grid g2">
              <div>
                <div className="small muted mb">returned nodes ({result.nodes.length})</div>
                <div className="col" style={{ gap: 6 }}>
                  {result.nodes.map((n: any) => (
                    <div key={n.id} className="row" style={{ justifyContent: "space-between", border: "1px solid var(--border)", borderRadius: 6, padding: "6px 8px" }}>
                      <span className="row" style={{ gap: 6 }}>
                        <TierPill tier={n.tier} small />
                        <span className="pill grey">{n.type}</span>
                      </span>
                      <span className="trunc small" style={{ maxWidth: 300 }} title={n.text}>
                        {n.text || n.label}
                      </span>
                      <span className="mono small">{n.rank_score.toFixed(3)}</span>
                    </div>
                  ))}
                  {!result.nodes.length && <Empty>No nodes visible to {role} for this query.</Empty>}
                </div>
              </div>
              <div>
                <div className="small muted mb">per-tier sufficiency</div>
                {result.tiers.map((t: any) => (
                  <div key={t.tier} className="mb">
                    <div className="row" style={{ justifyContent: "space-between" }}>
                      <span className="row" style={{ gap: 6 }}>
                        <TierPill tier={t.tier} small />
                        <span className="small">{t.tier_label}</span>
                      </span>
                      <span className={`pill ${t.excluded_by_scope ? "red" : t.stopped_here ? "green" : "amber"}`}>
                        {t.excluded_by_scope ? "EXCLUDED" : t.stopped_here ? "STOP" : "descend"}
                      </span>
                    </div>
                    {t.excluded_by_scope ? (
                      <div className="faint">{t.note}</div>
                    ) : (
                      <>
                        <div className="row mt" style={{ gap: 8 }}>
                          {(
                            [
                              ["coverage", t.coverage],
                              ["provenance", t.provenance_strength],
                              ["recency", t.recency],
                            ] as const
                          ).map(([k, v]) => (
                            <div key={k} style={{ flex: 1 }}>
                              <div className="faint">{k}</div>
                              <Bar value={v} color={k === "coverage" ? "" : k === "provenance" ? "purple" : "green"} />
                              <div className="mono faint">{v.toFixed(2)}</div>
                            </div>
                          ))}
                          <div style={{ width: 82 }}>
                            <div className="faint">suff</div>
                            <div className="mono" style={{ fontWeight: 700 }}>
                              {t.suff.toFixed(3)}
                            </div>
                            <div className="faint">τ {t.tau}</div>
                          </div>
                        </div>
                        <div className="faint">{t.note}</div>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
        {result?.error && <div className="note err">{result.error}</div>}
      </Card>
    </div>
  );
}
