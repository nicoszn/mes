import React from "react";
import { get, post, timeAgo, TIER_META, TYPE_COLOR } from "../api";
import { Bar, Card, PassFail, StatusPill, TierPill, useAsync } from "../components";

export default function Overview({ boot, refresh }: { boot: any; refresh: () => void }) {
  const { data: inv, reload: reloadInv } = useAsync(() => get("/invariants"), []);
  const { data: traces, reload: reloadTraces } = useAsync(() => get("/traces?limit=8"), []);
  const { data: eps, reload: reloadEps } = useAsync(() => get("/episodes"), []);
  const { data: claims, reload: reloadClaims } = useAsync(() => get("/claims?limit=1"), []);

  const tiers = boot?.tiers ?? {};
  const edges = boot?.edges ?? {};
  const edgeTotal = Object.values(edges).reduce((a: number, b: any) => a + b, 0);
  const quick = boot?.invariant_quick ?? {};
  const policy = boot?.active_policy ?? {};
  const dash = claims?.dashboard;

  const seed = async () => {
    await post("/seed", { force: false });
    refresh();
    reloadInv();
    reloadTraces();
    reloadEps();
    reloadClaims();
  };

  const gateChecks = [
    { id: "V1", name: "span resolution (hard)", ok: quick.V1, detail: "every summary & card span resolves to real event content" },
    { id: "V2", name: "PART_OF coverage (hard)", ok: quick.V2, detail: "every event attached by exactly one PART_OF edge" },
    { id: "V2b", name: "claim provenance (hard)", ok: quick.claim_provenance, detail: "every claim carries ≥1 provenance edge" },
    { id: "V1d", name: "chunk span resolution (hard)", ok: quick.chunk_spans, detail: "every chunk span resolves back to page text" },
  ];

  return (
    <div>
      <div className="grid g4 mb">
        {[1, 2, 3, 4].map((t) => (
          <Card key={t}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <TierPill tier={t} />
              <span className="faint">{TIER_META[t].label.split("·")[1]}</span>
            </div>
            <div className="stat mt">
              <span className="v">{tiers[t] ?? 0}</span>
              <span className="l">nodes labeled {TIER_META[t].short}</span>
              <span className="s">
                {t === 1 ? "Event + Chunk" : t === 2 ? "Episode" : t === 3 ? "Claim" : "Policy"}
              </span>
            </div>
          </Card>
        ))}
      </div>

      <div className="grid g3 mb">
        <Card title="Instrumentation (T0)">
          <div className="stat">
            <span className="v">{tiers["0"] ?? 0}</span>
            <span className="l">Trace nodes, rebuilt from append-only JSONL</span>
          </div>
          <dl className="kv mt">
            <dt>trace log</dt>
            <dd>data/logs/traces.jsonl</dd>
            <dt>event log</dt>
            <dd>data/logs/events.jsonl (fsync/write)</dd>
            <dt>vector index</dt>
            <dd>{boot?.vector_index_size ?? 0} entries (T3/T2/chunks)</dd>
          </dl>
        </Card>
        <Card title="Graph edges">
          <div className="col" style={{ gap: 6 }}>
            {Object.entries(edges).map(([k, v]) => (
              <div key={k} className="row" style={{ justifyContent: "space-between" }}>
                <span className="mono small">{k}</span>
                <span className="mono small">{String(v)}</span>
              </div>
            ))}
            {!Object.keys(edges).length && <div className="faint">no edges yet</div>}
          </div>
          <div className="faint mt">total {edgeTotal} edges · MERGE semantics (unique per type+src+dst)</div>
        </Card>
        <Card title="Active policy (T4)">
          <dl className="kv">
            <dt>version</dt>
            <dd>{policy.policy_version}</dd>
            <dt>model / seed</dt>
            <dd>
              {policy.model?.model_id} · {policy.model?.seed}
            </dd>
            <dt>summarizer</dt>
            <dd>{policy.model?.summarizer_id}</dd>
            <dt>retrieval τ</dt>
            <dd>{policy.retrieval?.tau}</dd>
            <dt>bands</dt>
            <dd>
              r≤{policy.claims?.bands?.retired_max} · p≤{policy.claims?.bands?.provisional_max} · t≥
              {policy.claims?.bands?.trusted_min}
            </dd>
            <dt>half-life</dt>
            <dd>{policy.claims?.half_life_days}d (boost {policy.claims?.contradiction_decay_boost})</dd>
          </dl>
        </Card>
      </div>

      <div className="grid g2">
        <Card
          title="Hard gates — audit safety cannot be soft"
          right={
            <span className="small muted">
              {gateChecks.filter((g) => g.ok).length}/{gateChecks.length} passing
            </span>
          }
        >
          <div className="col" style={{ gap: 9 }}>
            {gateChecks.map((g) => (
              <div key={g.id} className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
                <div>
                  <div className="row">
                    <span className="pill mono"> {g.id}</span>
                    <strong className="small">{g.name}</strong>
                  </div>
                  <div className="faint">{g.detail}</div>
                </div>
                <PassFail pass={!!g.ok} />
              </div>
            ))}
          </div>
          <div className="note mt">Everything else is [0,1] scoring with bands calibrated in policy.</div>
        </Card>

        <Card
          title="Memory state"
          right={
            <button className="btn sm" onClick={seed}>
              Seed demo data
            </button>
          }
        >
          <div className="row mb" style={{ gap: 18 }}>
            <div className="stat">
              <span className="v">{dash?.total ?? 0}</span>
              <span className="l">claims</span>
            </div>
            <div className="stat">
              <span className="v">{dash?.by_status?.trusted ?? 0}</span>
              <span className="l">trusted</span>
            </div>
            <div className="stat">
              <span className="v">{dash?.by_status?.provisional ?? 0}</span>
              <span className="l">provisional</span>
            </div>
            <div className="stat">
              <span className="v">{dash?.by_status?.retired ?? 0}</span>
              <span className="l">retired</span>
            </div>
            <div className="stat">
              <span className="v">{dash?.contradiction_edges ?? 0}</span>
              <span className="l">contradict</span>
            </div>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <div style={{ flex: 1 }}>
              <div className="small muted mb">confidence distribution</div>
              {(dash?.histogram ?? []).map((h: any) => (
                <div key={h.bucket} className="row" style={{ gap: 8, marginBottom: 4 }}>
                  <span className="mono faint" style={{ width: 66 }}>
                    {h.bucket}
                  </span>
                  <Bar value={h.count} max={Math.max(1, ...(dash?.histogram ?? []).map((x: any) => x.count))} color="purple" />
                  <span className="mono small" style={{ width: 24 }}>
                    {h.count}
                  </span>
                </div>
              ))}
            </div>
            <div style={{ width: 220 }}>
              <div className="small muted mb">episodes</div>
              {(eps?.episodes ?? []).slice(-5).reverse().map((e: any) => (
                <div key={e.id} className="row" style={{ justifyContent: "space-between", padding: "3px 0" }}>
                  <span className="trunc small" style={{ maxWidth: 130 }} title={e.task ?? e.filename}>
                    {e.task ?? e.filename ?? e.id}
                  </span>
                  <StatusPill status={e.status} />
                </div>
              ))}
              {!eps?.episodes?.length && <div className="faint">none yet</div>}
            </div>
          </div>
        </Card>
      </div>

      <Card className="mt" title="Latest traces" right={<span className="small muted">instrumentation precedes features</span>}>
        <table>
          <thead>
            <tr>
              <th>op</th>
              <th>outcome</th>
              <th>policy</th>
              <th>latency</th>
              <th>tokens in/out</th>
              <th>cost</th>
              <th>nodes</th>
              <th>tiers</th>
              <th>when</th>
            </tr>
          </thead>
          <tbody>
            {(traces?.traces ?? []).map((t: any) => (
              <tr key={t.trace_id}>
                <td className="mono">{t.op}</td>
                <td>
                  <StatusPill status={t.outcome === "ok" ? "success" : t.outcome === "error" ? "failure" : t.outcome} />
                </td>
                <td className="mono">{t.policy_version}</td>
                <td className="mono">{t.latency_ms}ms</td>
                <td className="mono">
                  {t.tokens_in}/{t.tokens_out}
                </td>
                <td className="mono">${(t.cost_usd ?? 0).toFixed(4)}</td>
                <td className="mono">{t.nodes_touched?.length ?? 0}</td>
                <td>{(t.tiers_descended ?? []).map((x: number) => <TierPill key={x} tier={x} small />)}</td>
                <td className="faint">{timeAgo(t.started_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!traces?.traces?.length && <Emptyish />}
      </Card>

      <Card className="mt" title="Tier label map">
        <div className="grid g4">
          {[1, 2, 3, 4].map((t) => (
            <div key={t} className="row" style={{ alignItems: "flex-start", gap: 8 }}>
              <TierPill tier={t} />
              <div>
                <div className="small" style={{ fontWeight: 600 }}>
                  {TIER_META[t].label.split("·")[1]?.trim()}
                </div>
                <div className="faint">
                  {t === 1
                    ? "Event nodes (chat door) + Chunk nodes (document door) — same schema, indistinguishable to retrieval"
                    : t === 2
                      ? "Episode nodes: card spine + one generative summary"
                      : t === 3
                        ? "Claim nodes: canonical_hash MERGE, provenance-first"
                        : "Policy nodes: immutable versioned JSON"}
                </div>
              </div>
            </div>
          ))}
        </div>
        <div className="note mt">
          Tiers are node <strong>labels</strong>, not containers: promotion, retrieval and forgetting are graph queries
          filtered by label.
        </div>
      </Card>
    </div>
  );
}

function Emptyish() {
  return <div className="empty">No traces yet — run a task or a retrieval to generate instrumentation.</div>;
}
