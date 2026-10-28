import React, { useState } from "react";
import { get, post, ROLES } from "../api";
import { Bar, Card, Empty, StatusPill, TierPill, useAsync } from "../components";

function GateTable({ gates }: { gates: any }) {
  if (!gates) return null;
  return (
    <table>
      <thead>
        <tr>
          <th>gate</th>
          <th>kind</th>
          <th>score</th>
          <th>threshold</th>
          <th>result</th>
          <th>details</th>
        </tr>
      </thead>
      <tbody>
        {["V1", "V2", "V3", "V4", "V5"].map((k) => {
          const g = gates[k];
          if (!g) return null;
          return (
            <tr key={k}>
              <td className="mono"><strong>{k}</strong> {g.name}</td>
              <td>{g.hard ? <span className="pill red">HARD</span> : <span className="pill grey">soft</span>}</td>
              <td style={{ minWidth: 110 }}>
                {g.score === null || g.score === undefined ? (
                  <span className="pill grey">pass / fail</span>
                ) : (
                  <>
                    <div className="mono small">{Number(g.score).toFixed(3)}</div>
                    <Bar value={Number(g.score)} color={g.pass ? "green" : "red"} />
                  </>
                )}
              </td>
              <td className="mono">{g.threshold}</td>
              <td>{g.pass ? <span className="passfail pass"><span className="mk">✓</span>PASS</span> : <span className="passfail fail"><span className="mk">!</span>FAIL</span>}</td>
              <td className="small faint">
                {(g.details ?? []).join(" · ")}
                {g.problems?.length ? (
                  <div style={{ color: "var(--red)", marginTop: 3 }}>
                    {g.problems.map((p: string, i: number) => (
                      <div key={i}>⚠ {p}</div>
                    ))}
                  </div>
                ) : null}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export default function ReplayPanel() {
  const { data: meta } = useAsync(() => get("/replay/episodes"), []);
  const [ep, setEp] = useState("");
  const [polA, setPolA] = useState("");
  const [polB, setPolB] = useState("");
  const [consA, setConsA] = useState<any>(null);
  const [consB, setConsB] = useState<any>(null);

  const [query, setQuery] = useState("retry ingestion writes lesson");
  const [role, setRole] = useState("Critic");
  const [retA, setRetA] = useState<any>(null);
  const [retB, setRetB] = useState<any>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const episodes = meta?.episodes ?? [];
  const versions = meta?.versions ?? [];

  const replayCons = async (which: "a" | "b") => {
    if (!ep) return;
    try {
      const r = await post("/replay/consolidation", {
        episode_id: ep,
        policy_version: which === "a" ? polA || undefined : polB || undefined,
      });
      which === "a" ? setConsA(r) : setConsB(r);
    } catch (e: any) {
      setMsg(String(e.message ?? e));
    }
  };

  const replayRet = async (which: "a" | "b") => {
    try {
      const r = await post("/replay/retrieval", {
        query,
        role,
        policy_version: which === "a" ? polA || undefined : polB || undefined,
      });
      which === "a" ? setRetA(r) : setRetB(r);
    } catch (e: any) {
      setMsg(String(e.message ?? e));
    }
  };

  const RetMini = ({ r, label }: { r: any; label: string }) =>
    r ? (
      <Card title={`Retrieval replay · ${label}`} right={<span className="pill grey">policy {r.policy_version}</span>}>
        <div className="row mb wrap" style={{ gap: 8 }}>
          <span className={`pill ${r.stop_reason === "sufficiency_reached" ? "green" : "amber"}`}>{r.stop_reason}</span>
          <span className="pill blue">visited {r.visited_tiers.map((t: number) => `T${t}`).join("→") || "none"}</span>
          <span className="pill red">excluded {r.excluded_tiers.map((t: number) => `T${t}`).join(",") || "none"}</span>
          <span className="pill purple">suff {r.sufficiency.toFixed(3)} / τ {r.tau}</span>
          <span className="pill grey">{r.nodes.length} nodes</span>
        </div>
        {r.tiers.map((t: any) => (
          <div key={t.tier} className="row" style={{ gap: 8, marginBottom: 5, alignItems: "center" }}>
            <TierPill tier={t.tier} small />
            {t.excluded_by_scope ? (
              <span className="small" style={{ color: "var(--red)" }}>excluded — {t.note}</span>
            ) : (
              <>
                <div style={{ flex: 1 }}>
                  <Bar value={t.suff} max={Math.max(1, t.tau)} color={t.stopped_here ? "green" : "amber"} />
                </div>
                <span className="mono small">{t.suff.toFixed(3)}</span>
                <span className={`pill ${t.stopped_here ? "green" : "grey"}`}>{t.stopped_here ? "STOP" : "descend"}</span>
              </>
            )}
          </div>
        ))}
        <div className="small muted mt">top results</div>
        {r.nodes.slice(0, 5).map((n: any) => (
          <div key={n.id} className="row small" style={{ justifyContent: "space-between", padding: "2px 0" }}>
            <span className="trunc" style={{ maxWidth: 330 }}>{n.text || n.label}</span>
            <span className="mono">{n.rank_score.toFixed(3)}</span>
          </div>
        ))}
        <div className="faint mt">trace {r.trace_id}</div>
      </Card>
    ) : null;

  const ConsResult = ({ r, label }: { r: any; label: string }) =>
    r ? (
      <Card title={`Consolidation replay · ${label}`} right={<span className="pill grey">policy {r.policy_version}</span>}>
        <div className="row mb wrap" style={{ gap: 8 }}>
          <span className={`pill ${r.would_write.consolidation_status === "ok" ? "green" : "red"}`}>
            would write: {r.would_write.consolidation_status}
          </span>
          <span className={`pill ${r.divergence ? "red" : "green"}`}>
            {r.divergence ? "DIVERGENCE (bug)" : r.idempotent ? "idempotent ✓" : "no stored hash"}
          </span>
          <span className="pill grey">summarizer {r.summarizer_id}</span>
          <span className="pill grey">model {r.model_id} · seed {r.seed}</span>
          <span className="pill grey">{r.summary_tokens} tokens</span>
        </div>
        <GateTable gates={r.gates} />
        <div className="row wrap mt" style={{ gap: 8 }}>
          <span className="pill grey">cite_min_eff {r.meta?.cite_min_eff}</span>
          <span className="pill grey">cited {r.meta?.cited_count}</span>
          {r.meta?.short_episode ? <span className="pill blue">short-episode exemption</span> : null}
          {r.meta?.fallback ? <span className="pill amber">fallback: {r.meta.fallback}</span> : null}
        </div>
        {(r.meta?.exemptions ?? []).map((x: string, i: number) => (
          <div key={i} className="note ok mt" style={{ fontSize: 11.5 }}>{x}</div>
        ))}
        <div className="small muted mt">summary that would be written</div>
        <pre className="plain">{r.would_write.summary ?? "(degraded → summary null)"}</pre>
        <div className="small muted mt">hash</div>
        <div className="mono small">stored {String(r.stored_hash).slice(0, 32) || "–"}</div>
        <div className="mono small">replay {String(r.replay_hash).slice(0, 32)}</div>
        <div className={`note mt ${r.divergence ? "err" : "ok"}`}>{r.note}</div>
        <div className="faint mt">
          card: {(r.card.decisions.length)} decisions · {(r.card.failures.length)} failures · {(r.card.resources.length)}{" "}
          resources · {(r.card.open_questions.length)} open questions
        </div>
      </Card>
    ) : null;

  return (
    <div>
      <div className="tabs">
        <div className="row" style={{ gap: 10, width: "100%" }}>
          <span className="small muted">Re-run any mechanism against any policy version — replays are dry unless you commit.</span>
          <div className="spacer" />
          <div style={{ width: 150 }}>
            <select value={polA} onChange={(e) => setPolA(e.target.value)}>
              <option value="">policy A (active)</option>
              {versions.map((v: string) => <option key={v}>{v}</option>)}
            </select>
          </div>
          <div style={{ width: 150 }}>
            <select value={polB} onChange={(e) => setPolB(e.target.value)}>
              <option value="">policy B (active)</option>
              {versions.map((v: string) => <option key={v}>{v}</option>)}
            </select>
          </div>
        </div>
      </div>

      {msg && <div className="note err mb">{msg}</div>}

      <Card title="Consolidation replay (T1 → T2)" right={<span className="small muted">same events + card + summary + model_id + seed + config_version → same hash</span>}>
        <div className="row">
          <div style={{ flex: 1 }}>
            <label className="field">episode</label>
            <select value={ep} onChange={(e) => setEp(e.target.value)}>
              <option value="">select an episode…</option>
              {episodes.map((e: any) => (
                <option key={e.id} value={e.id}>
                  {e.kind} · {e.task ?? e.filename ?? e.id} · {e.status} {e.consolidation_status ? `(${e.consolidation_status})` : ""}
                </option>
              ))}
            </select>
          </div>
          <div style={{ alignSelf: "flex-end" }} className="row">
            <button className="btn" onClick={() => replayCons("a")} disabled={!ep}>▶ Replay A</button>
            <button className="btn secondary" onClick={() => replayCons("b")} disabled={!ep}>▶ Replay B</button>
          </div>
        </div>
        <div className="faint mt">
          A divergence between the stored consolidation_hash and a replay under unchanged inputs is a reproducibility
          bug, not a warning.
        </div>
      </Card>

      <div className="grid g2 mt">
        <ConsResult r={consA} label={polA || "active"} />
        <ConsResult r={consB} label={polB || "active"} />
      </div>
      {!consA && !consB && <Empty>Run a consolidation replay to compare gate scores and hashes across policies.</Empty>}

      <Card className="mt" title="Retrieval replay" right={<span className="small muted">compare descent behaviour under two policies</span>}>
        <div className="row">
          <div style={{ flex: 1 }}>
            <label className="field">query</label>
            <input value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <div style={{ width: 160 }}>
            <label className="field">role</label>
            <select value={role} onChange={(e) => setRole(e.target.value)}>
              {ROLES.map((r) => <option key={r}>{r}</option>)}
            </select>
          </div>
          <div style={{ alignSelf: "flex-end" }} className="row">
            <button className="btn" onClick={() => replayRet("a")}>▶ Replay A</button>
            <button className="btn secondary" onClick={() => replayRet("b")}>▶ Replay B</button>
          </div>
        </div>
      </Card>

      <div className="grid g2 mt">
        <RetMini r={retA} label={polA || "active"} />
        <RetMini r={retB} label={polB || "active"} />
      </div>
    </div>
  );
}
