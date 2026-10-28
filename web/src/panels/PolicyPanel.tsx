import React, { useEffect, useState } from "react";
import { get, post, timeAgo } from "../api";
import { Card, Json, StatusPill, useAsync } from "../components";

export default function PolicyPanel({ refresh }: { refresh?: () => void }) {
  const { data, reload } = useAsync(() => get("/policies"), []);
  const [draft, setDraft] = useState("");
  const [version, setVersion] = useState("");
  const [notes, setNotes] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [diff, setDiff] = useState<any>(null);

  const versions = data?.versions ?? [];
  const active = data?.active_version;

  useEffect(() => {
    if (versions.length && !version) {
      const def = versions.find((v: any) => v.version === active) ?? versions[versions.length - 1];
      setVersion(def.version);
      setDraft(JSON.stringify(def.doc, null, 2));
    }
  }, [versions.length, version, active, versions]);

  const selectVersion = (v: string) => {
    setVersion(v);
    const doc = versions.find((x: any) => x.version === v)?.doc;
    setDraft(JSON.stringify(doc, null, 2));
    setMsg(null);
  };

  const parsed = (() => {
    try {
      return JSON.parse(draft);
    } catch (e: any) {
      return { error: e.message };
    }
  })();

  const save = async () => {
    if (parsed.error) {
      setMsg({ kind: "err", text: `invalid JSON: ${parsed.error}` });
      return;
    }
    try {
      const r = await post("/policies", { doc: parsed, notes, source: "ui" });
      setMsg({ kind: "ok", text: r.created ? `created immutable version ${parsed.policy_version}` : `version ${parsed.policy_version} already exists and is identical (immutable)` });
      reload();
      refresh?.();
    } catch (e: any) {
      setMsg({ kind: "err", text: e.message });
    }
  };

  const activate = async (v: string) => {
    await post(`/policies/${v}/activate`);
    reload();
    refresh?.();
    setMsg({ kind: "ok", text: `active policy → ${v}; all new traces will record this version` });
  };

  const compare = async () => {
    try {
      setDiff(await get(`/policies/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`));
    } catch (e: any) {
      setMsg({ kind: "err", text: e.message });
    }
  };

  return (
    <div>
      <Card title="Policy versions (T4, immutable)" right={<span className="small muted">stored as Policy nodes in the graph</span>}>
        <table>
          <thead>
            <tr>
              <th>version</th>
              <th>created</th>
              <th>notes</th>
              <th>content hash</th>
              <th>state</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {versions.map((v: any) => (
              <tr key={v.version} className="click" onClick={() => selectVersion(v.version)}>
                <td className="mono"><strong>{v.version}</strong></td>
                <td className="faint">{timeAgo(v.created_at)}</td>
                <td className="small" style={{ maxWidth: 340 }}>{v.notes}</td>
                <td className="mono faint">{String(v.content_hash).slice(0, 14)}</td>
                <td>{v.version === active ? <StatusPill status="success" /> : <span className="pill grey">inactive</span>}</td>
                <td onClick={(e) => e.stopPropagation()}>
                  {v.version !== active && (
                    <button className="btn sm" onClick={() => activate(v.version)}>activate</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="note mt">
          Every number downstream — thresholds, weights, bands, τ, half-life, model_id, seed — is read from this
          document. Nothing is hardcoded in the pipeline, and every trace records which version it ran under.
        </div>
      </Card>

      <div className="grid g2 mt">
        <Card
          title={`Edit: ${version || "–"}`}
          right={<span className={`pill ${parsed.error ? "red" : "green"}`}>{parsed.error ? "invalid JSON" : "valid JSON"}</span>}
        >
          <div className="row mb">
            <div style={{ width: 150 }}>
              <label className="field">new version id</label>
              <input value={version} onChange={(e) => setVersion(e.target.value)} placeholder="1.1.0" />
            </div>
            <div style={{ flex: 1 }}>
              <label className="field">notes</label>
              <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="what changed and why" />
            </div>
          </div>
          <textarea className="code" rows={22} value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} />
          <div className="row mt">
            <button className="btn" onClick={save}>💾 Save as new immutable version</button>
            <button className="btn secondary" onClick={() => setDraft(JSON.stringify(parsed.error ? versions.find((v: any) => v.version === version)?.doc : parsed, null, 2))}>reset</button>
          </div>
          {msg && <div className={`note mt ${msg.kind === "err" ? "err" : "ok"}`}>{msg.text}</div>}
        </Card>

        <div className="col">
          <Card title="Where each knob is used" right={<span className="small muted">hard gates are not editable</span>}>
            <table>
              <tbody>
                {[
                  ["consolidation.cite_min / bands", "gates V3–V5 (soft) — V1 & V2 are fixed at 1.0"],
                  ["relevance.w_* / idf_tau / min_relevance_for_promotion", "chunk relevance + promotion to T3"],
                  ["claims.bands.*", "c → {retired, provisional, trusted}"],
                  ["claims.weights.w1..w4, half_life_days, contradiction_decay_boost", "confidence formula"],
                  ["claims.independence.*", "SUPPORTS edge weights (0.25 / 1.0 / 0.75)"],
                  ["claims.jaccard_threshold, negation_weight, spo_mismatch_weight", "contradiction detection"],
                  ["retrieval.tau, w_coverage/w_provenance/w_recency", "sufficiency gate & descent"],
                  ["scope.matrix, scope.predicates", "hard tier filter per role"],
                  ["roles.*.allowed_event_kinds", "which event kinds each role may write"],
                  ["budget.*", "max_turns / token budget / episode timeout"],
                  ["model.model_id, seed, cost_per_1k_tokens", "summarizer identity, reproducibility, cost"],
                ].map(([k, v]) => (
                  <tr key={k}>
                    <td className="mono small" style={{ maxWidth: 300 }}>{k}</td>
                    <td className="small">{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="note warn mt">
              Hard gates (V1 span resolution, V2 100% provenance coverage) are structural and cannot be relaxed by any
              policy value.
            </div>
          </Card>

          <Card title="Compare versions">
            <div className="row mb">
              <select value={a} onChange={(e) => setA(e.target.value)} style={{ width: 140 }}>
                <option value="">version A</option>
                {versions.map((v: any) => <option key={v.version}>{v.version}</option>)}
              </select>
              <span className="faint">vs</span>
              <select value={b} onChange={(e) => setB(e.target.value)} style={{ width: 140 }}>
                <option value="">version B</option>
                {versions.map((v: any) => <option key={v.version}>{v.version}</option>)}
              </select>
              <button className="btn" onClick={compare} disabled={!a || !b}>diff</button>
            </div>
            {diff && (
              <>
                <div className="small muted mb">{diff.a} vs {diff.b} — {diff.diff.length} difference(s)</div>
                <table>
                  <thead>
                    <tr><th>path</th><th>{diff.a}</th><th>{diff.b}</th></tr>
                  </thead>
                  <tbody>
                    {diff.diff.map((d: any, i: number) => (
                      <tr key={i}>
                        <td className="mono small">{d.path}</td>
                        <td><span className="diff-a">{d.a === null ? "—" : JSON.stringify(d.a)}</span></td>
                        <td><span className="diff-b">{d.b === null ? "—" : JSON.stringify(d.b)}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!diff.diff.length && <div className="note ok">identical documents</div>}
              </>
            )}
            {!diff && <div className="faint">Select two versions to see exactly what changed — replays against both then compare fairly.</div>}
          </Card>
        </div>
      </div>
    </div>
  );
}
