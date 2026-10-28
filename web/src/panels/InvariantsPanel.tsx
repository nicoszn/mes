import React, { useState } from "react";
import { get } from "../api";
import { Card, Json, PassFail, useAsync } from "../components";

export default function InvariantsPanel() {
  const { data, error, loading, reload } = useAsync(() => get("/invariants"), []);
  const [open, setOpen] = useState<string | null>(null);
  const rows = data ?? [];
  const hard = rows.filter((r: any) => r.hard_gate);
  const soft = rows.filter((r: any) => !r.hard_gate);
  const failing = rows.filter((r: any) => !r.pass);

  return (
    <div>
      <div className="grid g3 mb">
        <Card>
          <div className="stat">
            <span className="v">
              {rows.filter((r: any) => r.pass).length}/{rows.length}
            </span>
            <span className="l">invariants passing</span>
            <span className="s">evaluated against live graph state</span>
          </div>
        </Card>
        <Card>
          <div className="stat">
            <span className="v">
              {hard.filter((r: any) => r.pass).length}/{hard.length}
            </span>
            <span className="l">hard gates passing</span>
            <span className="s">V1 span resolution · V2 100% provenance coverage</span>
          </div>
        </Card>
        <Card>
          <div className="stat">
            <span className="v" style={{ color: failing.length ? "var(--red)" : "var(--green)" }}>
              {failing.length}
            </span>
            <span className="l">failing</span>
            <span className="s">{failing.length ? failing.map((f: any) => f.id).join(", ") : "none — system consistent"}</span>
          </div>
        </Card>
      </div>

      <Card
        title="Hard gates (cannot be waived by policy)"
        right={
          <button className="btn secondary sm" onClick={reload} disabled={loading}>
            {loading ? "evaluating…" : "re-evaluate"}
          </button>
        }
      >
        <table>
          <thead>
            <tr>
              <th>gate</th>
              <th>id</th>
              <th>result</th>
              <th>detail</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {hard.map((r: any) => (
              <tr key={r.id} className="click" onClick={() => setOpen(open === r.id ? null : r.id)}>
                <td>
                  <strong>{r.name}</strong>
                </td>
                <td className="mono">{r.id}</td>
                <td>
                  <PassFail pass={r.pass} />
                </td>
                <td className="small">{r.detail}</td>
                <td className="faint">{open === r.id ? "hide" : "evidence"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {hard
          .filter((r: any) => open === r.id)
          .map((r: any) => (
            <div key={r.id} className="mt">
              <Json data={r.evidence} />
            </div>
          ))}
        <div className="note mt">
          Only two hard gates survive because audit safety cannot be soft; everything else is [0,1] scoring with bands
          calibrated in policy.
        </div>
      </Card>

      <Card className="mt" title="Soft invariants (scoring, structure & calibration)">
        <table>
          <thead>
            <tr>
              <th>check</th>
              <th>id</th>
              <th>result</th>
              <th>detail</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {soft.map((r: any) => (
              <tr key={r.id} className="click" onClick={() => setOpen(open === r.id ? null : r.id)}>
                <td>{r.name}</td>
                <td className="mono">{r.id}</td>
                <td>
                  <PassFail pass={r.pass} />
                </td>
                <td className="small">{r.detail}</td>
                <td className="faint">{open === r.id ? "hide" : "evidence"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {soft
          .filter((r: any) => open === r.id)
          .map((r: any) => (
            <div key={r.id} className="mt">
              <Json data={r.evidence} />
            </div>
          ))}
      </Card>

      {error && <div className="note err mt">{error}</div>}
    </div>
  );
}
