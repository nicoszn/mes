import React, { useState } from "react";
import { get, post } from "../api";
import { Bar, Card, Drawer, Empty, Json, StatusPill, TierPill, useAsync } from "../components";

export default function ClaimsPanel({ refresh }: { refresh?: () => void }) {
  const [tab, setTab] = useState<"dash" | "claims" | "contra" | "decay">("dash");
  const [status, setStatus] = useState("");
  const [kind, setKind] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [sweep, setSweep] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  const query = `/claims?${status ? `status=${status}&` : ""}${kind ? `kind=${kind}` : ""}`;
  const { data, reload } = useAsync(() => get(query), [query]);
  const { data: detail, reload: reloadDetail } = useAsync(
    () => (selected ? get(`/claims/${selected}`) : Promise.resolve(null)),
    [selected]
  );
  const { data: contra } = useAsync(() => get("/contradictions"), [tab === "contra"]);
  const { data: decay } = useAsync(() => get("/decay"), [tab === "decay"]);

  const runSweep = async () => {
    setBusy(true);
    try {
      const r = await post("/promote");
      setSweep(r);
      reload();
      refresh?.();
    } finally {
      setBusy(false);
    }
  };

  const dash = data?.dashboard;
  const bands = dash?.bands;
  const claims = data?.claims ?? [];

  return (
    <div>
      <div className="tabs">
        {(
          [
            ["dash", "Promotion dashboard"],
            ["claims", `Claims (${claims.length})`],
            ["contra", `Contradictions (${contra?.pairs?.length ?? 0})`],
            ["decay", "Forgetting / decay"],
          ] as const
        ).map(([id, label]) => (
          <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id as any)}>
            {label}
          </button>
        ))}
        <div className="spacer" />
        <button className="btn sm" onClick={runSweep} disabled={busy} style={{ marginTop: 4 }}>
          {busy ? "sweeping…" : "▶ Run promotion sweep ×2"}
        </button>
      </div>

      {tab === "dash" && dash && (
        <>
          <div className="grid g4 mb">
            <Card>
              <div className="stat">
                <span className="v">{dash.total}</span>
                <span className="l">claims (T3)</span>
                <span className="s">avg confidence {dash.avg_confidence.toFixed(3)}</span>
              </div>
            </Card>
            <Card>
              <div className="stat">
                <span className="v" style={{ color: "var(--green)" }}>{dash.by_status.trusted}</span>
                <span className="l">trusted</span>
                <span className="s">c ≥ {bands?.trusted_min}</span>
              </div>
              <div className="mt"><Bar value={dash.by_status.trusted} max={Math.max(1, dash.total)} color="green" /></div>
            </Card>
            <Card>
              <div className="stat">
                <span className="v" style={{ color: "var(--amber)" }}>{dash.by_status.provisional}</span>
                <span className="l">provisional</span>
                <span className="s">{bands?.retired_max} &lt; c &lt; {bands?.trusted_min}</span>
              </div>
              <div className="mt"><Bar value={dash.by_status.provisional} max={Math.max(1, dash.total)} color="amber" /></div>
            </Card>
            <Card>
              <div className="stat">
                <span className="v" style={{ color: "var(--red)" }}>{dash.by_status.retired}</span>
                <span className="l">retired</span>
                <span className="s">c ≤ {bands?.retired_max} · decay, not deletion</span>
              </div>
              <div className="mt"><Bar value={dash.by_status.retired} max={Math.max(1, dash.total)} color="red" /></div>
            </Card>
          </div>

          <div className="grid g2 mb">
            <Card title="Confidence histogram">
              {(dash.histogram ?? []).map((h: any) => (
                <div key={h.bucket} className="row" style={{ gap: 8, marginBottom: 6 }}>
                  <span className="mono small" style={{ width: 70 }}>{h.bucket}</span>
                  <Bar value={h.count} max={Math.max(1, ...dash.histogram.map((x: any) => x.count))} color="purple" />
                  <span className="mono small" style={{ width: 26 }}>{h.count}</span>
                </div>
              ))}
              <div className="note mt">
                Promotion is the sole writer of <span className="mono">Claim.status</span>; bands are thresholds, not
                caps.
              </div>
            </Card>
            <Card title="Evidence mix">
              <dl className="kv">
                <dt>by kind</dt>
                <dd>
                  lesson {dash.by_kind.lesson} · fact {dash.by_kind.fact} · coordination_pattern {dash.by_kind.coordination_pattern}
                </dd>
                <dt>document-only</dt>
                <dd>{dash.document_only} (capped below trusted unless corroborated)</dd>
                <dt>contradiction edges</dt>
                <dd>{dash.contradiction_edges}</dd>
                <dt>independence weights</dt>
                <dd>same_episode 0.25 · different_episode 1.0 · document 0.75</dd>
                <dt>formula</dt>
                <dd>c = σ(w₁·min(1,(n_ep+n_doc)/min_supports) + w₂·recency + w₃·outcome − w₄·contradiction_mass)</dd>
              </dl>
            </Card>
          </div>

          <Card
            title="Promotion sweep result"
            right={<span className="small muted">sweeps are idempotent — second run must yield 0 transitions</span>}
          >
            {sweep ? (
              <>
                <div className="row mb" style={{ gap: 8 }}>
                  <span className="pill blue">evaluated {sweep.evaluated}</span>
                  <span className="pill purple">run 1 transitions {sweep.transitions.length}</span>
                  <span className={`pill ${sweep.idempotent ? "green" : "red"}`}>
                    run 2 transitions {sweep.idempotent ? "0 ✓ idempotent" : "NOT ZERO — BUG"}
                  </span>
                </div>
                <table>
                  <thead>
                    <tr>
                      <th>claim</th>
                      <th>from → to</th>
                      <th>confidence</th>
                      <th>reasons</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sweep.transitions.map((t: any) => (
                      <tr key={t.claim_id}>
                        <td className="small" style={{ maxWidth: 300 }}>{t.text}</td>
                        <td>
                          <span className="pill grey">{t.from}</span> → <StatusPill status={t.to} />
                        </td>
                        <td className="mono">{t.confidence.toFixed(3)}</td>
                        <td className="faint small">{(t.reasons ?? []).join(" · ")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!sweep.transitions.length && <div className="note ok">No transitions — evidence unchanged, sweep idempotent.</div>}
              </>
            ) : (
              <div className="empty">Run the sweep to see transitions and idempotency.</div>
            )}
          </Card>
        </>
      )}

      {tab === "claims" && (
        <Card
          title="Claims"
          right={
            <span className="row" style={{ gap: 8 }}>
              <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 140 }}>
                <option value="">all statuses</option>
                <option value="trusted">trusted</option>
                <option value="provisional">provisional</option>
                <option value="retired">retired</option>
              </select>
              <select value={kind} onChange={(e) => setKind(e.target.value)} style={{ width: 180 }}>
                <option value="">all kinds</option>
                <option value="lesson">lesson</option>
                <option value="fact">fact</option>
                <option value="coordination_pattern">coordination_pattern</option>
              </select>
            </span>
          }
        >
          <table>
            <thead>
              <tr>
                <th>text</th>
                <th>kind</th>
                <th>SPO</th>
                <th>confidence</th>
                <th>status</th>
                <th>support</th>
                <th>contra</th>
                <th>config</th>
              </tr>
            </thead>
            <tbody>
              {claims.map((c: any) => (
                <tr key={c.id} className="click" onClick={() => setSelected(c.id)}>
                  <td className="small" style={{ maxWidth: 330 }}>
                    {c.text}
                    <div className="mono faint">{String(c.canonical_hash).slice(0, 16)}</div>
                  </td>
                  <td>
                    <span className={`pill ${c.claim_kind === "fact" ? "blue" : c.claim_kind === "lesson" ? "purple" : "green"}`}>
                      {c.claim_kind}
                    </span>
                  </td>
                  <td className="small">
                    <div><span className="faint">s</span> {c.subject || "–"}</div>
                    <div><span className="faint">p</span> {c.predicate || "–"}</div>
                    <div><span className="faint">o</span> {c.object || "–"}</div>
                  </td>
                  <td style={{ minWidth: 110 }}>
                    <div className="mono small">{c.confidence.toFixed(3)}</div>
                    <Bar value={c.confidence} color={c.status === "trusted" ? "green" : c.status === "retired" ? "red" : "amber"} />
                  </td>
                  <td><StatusPill status={c.status} /></td>
                  <td className="mono">{c.support_count}</td>
                  <td className="mono" style={{ color: c.contradiction_count ? "var(--red)" : undefined }}>{c.contradiction_count}</td>
                  <td className="mono faint">{c.config_version}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!claims.length && <Empty>No claims match this filter.</Empty>}
        </Card>
      )}

      {tab === "contra" && (
        <Card title="Contradiction explorer" right={<span className="small muted">same-kind claims only</span>}>
          <table>
            <thead>
              <tr>
                <th>claim A</th>
                <th>claim B</th>
                <th>weight</th>
                <th>reason</th>
                <th>status A / B</th>
              </tr>
            </thead>
            <tbody>
              {(contra?.pairs ?? []).map((p: any, i: number) => (
                <tr key={i} className="click" onClick={() => setSelected(p.a)}>
                  <td className="small" style={{ maxWidth: 260 }}>{p.a_text}</td>
                  <td className="small" style={{ maxWidth: 260 }}>{p.b_text}</td>
                  <td className="mono">{p.weight.toFixed(2)}</td>
                  <td className="faint small">{p.reason}</td>
                  <td>
                    <StatusPill status={p.a_status} /> <StatusPill status={p.b_status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!contra?.pairs?.length && <Empty>No contradictions detected.</Empty>}
          <div className="note mt">
            Detection: token-Jaccard ≥ threshold with opposite negation (weight = negation_weight), or same SPO subject
            and object with a different predicate (weight = spo_mismatch_weight). Each edge refreshes
            contradiction_count, which raises contradiction_mass and shortens the effective half-life.
          </div>
        </Card>
      )}

      {tab === "decay" && decay && (
        <div className="grid g2">
          <Card title="Recency decay (oldest support first)" right={<span className="small muted">avg recency {decay.avg_recency.toFixed(3)}</span>}>
            <table>
              <thead>
                <tr>
                  <th>claim</th>
                  <th>status</th>
                  <th>age</th>
                  <th>recency</th>
                  <th>half-life</th>
                  <th>contra</th>
                </tr>
              </thead>
              <tbody>
                {decay.oldest.map((r: any) => (
                  <tr key={r.id} className="click" onClick={() => setSelected(r.id)}>
                    <td className="small" style={{ maxWidth: 260 }}>{r.text}</td>
                    <td><StatusPill status={r.status} /></td>
                    <td className="mono">{r.age_days.toFixed(1)}d</td>
                    <td style={{ minWidth: 90 }}>
                      <div className="mono small">{r.recency.toFixed(3)}</div>
                      <Bar value={r.recency} color="amber" />
                    </td>
                    <td className="mono">{r.effective_half_life_days?.toFixed(1)}d</td>
                    <td className="mono" style={{ color: r.contradiction_count ? "var(--red)" : undefined }}>{r.contradiction_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          <Card title="Forgetting is decay, not deletion">
            <div className="row mb" style={{ gap: 18 }}>
              <div className="stat"><span className="v">{decay.retired_count}</span><span className="l">retired by decay</span></div>
              <div className="stat"><span className="v">{decay.total}</span><span className="l">total claims</span></div>
            </div>
            <ul className="small" style={{ paddingLeft: 18, lineHeight: 1.7 }}>
              <li>Recency decay over time naturally retires claims whose support has aged.</li>
              <li>
                Each contradiction shortens the effective half-life:{" "}
                <span className="mono">half_life / (1 + contradiction_count × boost)</span>.
              </li>
              <li>
                Source redaction (Documents panel) wipes chunk text and the raw blob while preserving PROVENANCE_CHUNK
                edges, then re-evaluates affected claims against remaining evidence.
              </li>
              <li>Nothing is deleted: retired claims keep their provenance and can be re-promoted by new support.</li>
            </ul>
          </Card>
        </div>
      )}

      <Drawer open={!!selected} onClose={() => setSelected(null)}>
        {detail && (
          <div className="col">
            <div className="row">
              <TierPill tier={3} />
              <span className="pill grey">{detail.claim.props.claim_kind}</span>
              <StatusPill status={detail.claim.status} />
            </div>
            <h3 className="title-lg">{detail.claim.props.text}</h3>
            <div className="mono faint">{detail.claim.id}</div>

            <Card title="Confidence breakdown">
              <div className="row mb">
                <span className="pill purple" style={{ fontSize: 14 }}>c = {detail.confidence.c.toFixed(4)}</span>
                <span className="pill grey">raw = {detail.confidence.raw.toFixed(4)}</span>
              </div>
              <dl className="kv">
                <dt>w₁·support</dt>
                <dd>{detail.confidence.support_term.toFixed(4)} (n_ep {detail.confidence.n_episodes} + n_doc {detail.confidence.n_documents})</dd>
                <dt>w₂·recency</dt>
                <dd>{(detail.confidence.weights.w2 * detail.confidence.recency).toFixed(4)} (age {detail.confidence.age_days.toFixed(2)}d, hl {detail.confidence.effective_half_life_days.toFixed(1)}d)</dd>
                <dt>w₃·outcome</dt>
                <dd>{(detail.confidence.weights.w3 * detail.confidence.outcome_strength).toFixed(4)} (avg status strength)</dd>
                <dt>w₄·contra</dt>
                <dd>−{(detail.confidence.weights.w4 * detail.confidence.contradiction_mass).toFixed(4)} (mass {detail.confidence.contradiction_mass.toFixed(2)})</dd>
                <dt>document cap</dt>
                <dd>{detail.confidence.document_cap_applied ? "APPLIED (doc-only, no corroboration)" : "not applied"}</dd>
                <dt>usage evidence</dt>
                <dd>{(detail.claim.props.usage_evidence ?? []).length} retrieval(s) in successful episodes</dd>
                <dt>config_version</dt>
                <dd>{detail.claim.props.config_version}</dd>
              </dl>
              <div className="small muted mt">band reasons</div>
              <ul className="small" style={{ paddingLeft: 18, margin: "4px 0" }}>
                {(detail.confidence.band_reasons ?? []).map((r: string, i: number) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </Card>

            <Card title="Provenance (first-class relation)">
              {detail.provenance.episodes.map((x: any, i: number) => (
                <div key={i} className="mb" style={{ borderLeft: "3px solid var(--t2)", paddingLeft: 8 }}>
                  <div className="small"><strong>episode</strong> {x.node?.label}</div>
                  <div className="mono faint">
                    span [{x.edge.props?.start},{x.edge.props?.end}] field={x.edge.props?.field} · {x.edge.dst}
                  </div>
                </div>
              ))}
              {detail.provenance.chunks.map((x: any, i: number) => (
                <div key={i} className="mb" style={{ borderLeft: "3px solid var(--t1)", paddingLeft: 8 }}>
                  <div className="small"><strong>chunk</strong> {x.node?.label}</div>
                  <div className="mono faint">
                    page {x.node?.props?.page} span [{x.edge.props?.start},{x.edge.props?.end}] · {x.edge.dst}
                  </div>
                </div>
              ))}
              {!detail.provenance.episodes.length && !detail.provenance.chunks.length && (
                <div className="note err">no provenance — V2 would fail for this claim</div>
              )}
            </Card>

            <Card title="Support (independence weights)">
              {[...detail.supports.episodes, ...detail.supports.chunks].map((x: any, i: number) => (
                <div key={i} className="row small" style={{ justifyContent: "space-between", padding: "3px 0", borderBottom: "1px solid #eef1f5" }}>
                  <span className={`pill ${x.edge.type === "EPISODE_SUPPORTS" ? "t2" : "t1"}`}>{x.edge.type}</span>
                  <span className="trunc" style={{ maxWidth: 220 }}>{x.node?.label}</span>
                  <span className="mono">w={x.edge.weight} <span className="faint">({x.edge.props?.independence})</span></span>
                </div>
              ))}
              <div className="faint mt">weights: {JSON.stringify(detail.independence_weights)}</div>
            </Card>

            <Card title="Contradictions">
              {detail.contradictions.map((x: any, i: number) => (
                <div key={i} className="mb small">
                  <span className="pill red">{x.direction === "out" ? "→ contradicts" : "← contradicted by"}</span>{" "}
                  <div>{x.node?.props?.text}</div>
                  <div className="faint">w={x.edge.weight} · {x.edge.props?.reason}</div>
                </div>
              ))}
              {!detail.contradictions.length && <div className="faint">none</div>}
            </Card>

            {detail.claim.props.history?.length > 0 && (
              <Card title="Status history (written only by promotion)">
                {detail.claim.props.history.map((h: any, i: number) => (
                  <div key={i} className="row small" style={{ justifyContent: "space-between" }}>
                    <span className="mono">{new Date(h.at).toLocaleString()}</span>
                    <span>{h.from} → {h.to}</span>
                    <span className="mono">{h.confidence.toFixed(3)}</span>
                    <span className="pill grey">{h.policy_version}</span>
                  </div>
                ))}
              </Card>
            )}

            <Card title="Raw props"><Json data={detail.claim.props} max={5000} /></Card>
          </div>
        )}
      </Drawer>
    </div>
  );
}
