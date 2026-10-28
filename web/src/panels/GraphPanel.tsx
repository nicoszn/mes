import React, { useEffect, useMemo, useRef, useState } from "react";
import { get, TYPE_COLOR, TIER_META } from "../api";
import { Card, Drawer, Empty, Json, StatusPill, TierPill, useAsync } from "../components";

interface SimNode {
  id: string;
  type: string;
  tier: number;
  label: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  fixed?: boolean;
}
interface SimEdge {
  id: string;
  type: string;
  src: string;
  dst: string;
  weight: number;
}

const TYPES = ["Event", "Episode", "Chunk", "Claim", "Policy", "Trace"];
const EDGE_TYPES = [
  "PARENT_OF",
  "PART_OF",
  "CHUNK_PART_OF",
  "PROVENANCE_EP",
  "PROVENANCE_CHUNK",
  "EPISODE_SUPPORTS",
  "CHUNK_SUPPORTS",
  "CONTRADICTS",
];

export default function GraphPanel() {
  const [typeFilter, setTypeFilter] = useState<string[]>(["Episode", "Claim", "Chunk", "Policy"]);
  const [tierFilter, setTierFilter] = useState<number[]>([1, 2, 3, 4]);
  const [edgeFilter, setEdgeFilter] = useState<string[]>(["PART_OF", "PROVENANCE_EP", "PROVENANCE_CHUNK", "CONTRADICTS", "EPISODE_SUPPORTS", "CHUNK_SUPPORTS", "CHUNK_PART_OF"]);
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(300);
  const [selected, setSelected] = useState<string | null>(null);

  const query = `/graph?type=${typeFilter.join(",")}&tier=${tierFilter.join(",")}&search=${encodeURIComponent(search)}&limit=${limit}`;
  const { data, loading, reload } = useAsync(() => get(query), [query]);

  const nodes: SimNode[] = useMemo(() => {
    const raw = data?.nodes ?? [];
    return raw.map((n: any, i: number) => ({
      id: n.id,
      type: n.type,
      tier: n.tier,
      label: n.label,
      x: 80 + ((i * 97) % 900),
      y: 60 + ((i * 61) % 460),
      vx: 0,
      vy: 0,
    }));
  }, [data]);

  const edges: SimEdge[] = useMemo(() => {
    const ids = new Set(nodes.map((n) => n.id));
    return (data?.edges ?? []).filter(
      (e: SimEdge) => ids.has(e.src) && ids.has(e.dst) && (!edgeFilter.length || edgeFilter.includes(e.type))
    );
  }, [data, edgeFilter, nodes]);

  const { data: nodeDetail, reload: reloadDetail } = useAsync(
    () => (selected ? get(`/nodes/${selected}`) : Promise.resolve(null)),
    [selected]
  );

  // simple force simulation
  const svgRef = useRef<SVGSVGElement>(null);
  const [, force] = useState(0);
  useEffect(() => {
    if (!nodes.length) return;
    const W = 1000;
    const H = 540;
    let raf = 0;
    let ticks = 0;
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const links = edges
      .map((e) => ({ s: byId.get(e.src), t: byId.get(e.dst) }))
      .filter((l) => l.s && l.t) as { s: SimNode; t: SimNode }[];

    const step = () => {
      ticks++;
      for (const n of nodes) {
        n.vx += (W / 2 - n.x) * 0.0012;
        n.vy += (H / 2 - n.y) * 0.0012;
      }
      for (let i = 0; i < links.length; i++) {
        const { s, t } = links[i];
        const dx = t.x - s.x;
        const dy = t.y - s.y;
        const d = Math.max(1, Math.hypot(dx, dy));
        const f = (d - 105) * 0.0022;
        s.vx += (dx / d) * f;
        s.vy += (dy / d) * f;
        t.vx -= (dx / d) * f;
        t.vy -= (dy / d) * f;
      }
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i];
          const b = nodes[j];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const d2 = dx * dx + dy * dy || 1;
          if (d2 > 140000) continue;
          const d = Math.sqrt(d2);
          const f = 340 / d2;
          a.vx -= (dx / d) * f * 12;
          a.vy -= (dy / d) * f * 12;
          b.vx += (dx / d) * f * 12;
          b.vy += (dy / d) * f * 12;
        }
      }
      for (const n of nodes) {
        n.vx *= 0.82;
        n.vy *= 0.82;
        n.x = Math.max(16, Math.min(W - 16, n.x + n.vx));
        n.y = Math.max(16, Math.min(H - 16, n.y + n.vy));
      }
      force((f) => f + 1);
      if (ticks < 400) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes.length, edges.length]);

  const toggle = (list: string[], set: (v: string[]) => void, v: string) =>
    set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  const pos = new Map(nodes.map((n) => [n.id, n]));
  const counts = (data?.nodes ?? []).reduce((acc: any, n: any) => {
    acc[n.type] = (acc[n.type] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div>
      <Card
        title="Filters"
        right={
          <span className="small muted">
            {nodes.length} nodes · {edges.length} edges {loading && <span className="spin" style={{ marginLeft: 6 }} />}
          </span>
        }
      >
        <div className="row wrap" style={{ gap: 16 }}>
          <div>
            <div className="small muted mb">node type</div>
            <div className="row wrap" style={{ gap: 6 }}>
              {TYPES.map((t) => (
                <button
                  key={t}
                  className={`pill ${typeFilter.includes(t) ? "blue" : "grey"}`}
                  style={{ cursor: "pointer", border: "1px solid" }}
                  onClick={() => toggle(typeFilter, setTypeFilter, t)}
                >
                  {t} {counts[t] ? `· ${counts[t]}` : ""}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="small muted mb">tier label</div>
            <div className="row" style={{ gap: 6 }}>
              {[1, 2, 3, 4].map((t) => (
                <button
                  key={t}
                  className={`pill t${tierFilter.includes(t) ? t : ""}`}
                  style={{ cursor: "pointer", opacity: tierFilter.includes(t) ? 1 : 0.4, border: "1px solid" }}
                  onClick={() =>
                    setTierFilter(tierFilter.includes(t) ? tierFilter.filter((x) => x !== t) : [...tierFilter, t])
                  }
                >
                  {TIER_META[t].label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="small muted mb">edge type</div>
            <div className="row wrap" style={{ gap: 6 }}>
              {EDGE_TYPES.map((t) => (
                <button
                  key={t}
                  className="pill"
                  style={{
                    cursor: "pointer",
                    border: "1px solid var(--border-strong)",
                    background: edgeFilter.includes(t) ? "#eaf1ff" : "#fff",
                    color: edgeFilter.includes(t) ? "var(--accent)" : "var(--muted)",
                  }}
                  onClick={() => toggle(edgeFilter, setEdgeFilter, t)}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
          <div style={{ width: 220 }}>
            <div className="small muted mb">search label/props</div>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="e.g. retry, degraded, ev_" />
          </div>
          <div style={{ width: 120 }}>
            <div className="small muted mb">max nodes</div>
            <input type="number" value={limit} onChange={(e) => setLimit(Number(e.target.value))} />
          </div>
        </div>
      </Card>

      <div className="graphwrap mt">
        <div className="legend">
          {[0, 1, 2, 3, 4].map((t) => (
            <div className="li" key={t}>
              <span className="sw" style={{ background: TIER_META[t].color }} />
              {TIER_META[t].label}
            </div>
          ))}
        </div>
        <svg ref={svgRef} viewBox="0 0 1000 540" preserveAspectRatio="xMidYMid meet">
          <defs>
            {EDGE_TYPES.map((t) => (
              <marker key={t} id={`ar-${t}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
                <path d="M0,0 L8,4 L0,8 z" fill="#98a4b5" />
              </marker>
            ))}
          </defs>
          {edges.map((e) => {
            const a = pos.get(e.src);
            const b = pos.get(e.dst);
            if (!a || !b) return null;
            const isContra = e.type === "CONTRADICTS";
            return (
              <line
                key={e.id}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke={isContra ? "#d92d20" : e.type.startsWith("TRACE") ? "#c3cbd7" : "#98a4b5"}
                strokeWidth={isContra ? 1.7 : Math.min(2.4, 0.7 + e.weight)}
                strokeDasharray={isContra ? "4 3" : e.type.includes("PROVENANCE") || e.type.includes("SUPPORTS") ? "" : "3 3"}
                opacity={0.75}
                markerEnd={`url(#ar-${EDGE_TYPES.includes(e.type) ? e.type : "PART_OF"})`}
              />
            );
          })}
          {nodes.map((n) => (
            <g
              key={n.id}
              transform={`translate(${n.x},${n.y})`}
              onClick={() => setSelected(n.id)}
              style={{ cursor: "pointer" }}
            >
              <circle
                r={n.type === "Claim" ? 7 : n.type === "Episode" ? 9 : n.type === "Policy" ? 10 : 5.5}
                fill={TYPE_COLOR[n.type] ?? "#888"}
                stroke={selected === n.id ? "#17202e" : "#fff"}
                strokeWidth={selected === n.id ? 2.4 : 1.4}
              />
              {n.type === "Episode" || n.type === "Policy" || selected === n.id ? (
                <text className="node-label" y={-11} textAnchor="middle">
                  {n.label.slice(0, 34)}
                </text>
              ) : null}
            </g>
          ))}
          {!nodes.length && (
            <text x="500" y="270" textAnchor="middle" fill="#94a2b8" fontSize="14">
              no nodes match the current filters
            </text>
          )}
        </svg>
      </div>

      <Card className="mt" title="Edge list" right={<span className="small muted">{edges.length} shown</span>}>
        <div style={{ maxHeight: 300, overflowY: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>type</th>
                <th>from</th>
                <th>to</th>
                <th>weight</th>
              </tr>
            </thead>
            <tbody>
              {edges.slice(0, 400).map((e) => (
                <tr key={e.id}>
                  <td>
                    <span className={`pill ${e.type === "CONTRADICTS" ? "red" : e.type.includes("PROVENANCE") ? "purple" : e.type.includes("SUPPORTS") ? "green" : "grey"}`}>
                      {e.type}
                    </span>
                  </td>
                  <td className="mono">{e.src}</td>
                  <td className="mono">{e.dst}</td>
                  <td className="mono">{e.weight}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!edges.length && <Empty>no edges with current filters</Empty>}
        </div>
      </Card>

      <Drawer open={!!selected} onClose={() => setSelected(null)}>
        {nodeDetail && (
          <div className="col">
            <div className="row">
              <TierPill tier={nodeDetail.node.tier} />
              <span className="pill grey">{nodeDetail.node.type}</span>
              <StatusPill status={nodeDetail.node.status} />
            </div>
            <h3 className="title-lg">{nodeDetail.node.label}</h3>
            <div className="mono faint">{nodeDetail.node.id}</div>

            {nodeDetail.node.type === "Claim" && nodeDetail.confidence && (
              <Card title="Confidence (policy-computed)">
                <div className="row mb">
                  <span className="pill purple">c = {nodeDetail.confidence.c.toFixed(4)}</span>
                  <span className={`pill ${nodeDetail.node.status === "trusted" ? "green" : nodeDetail.node.status === "retired" ? "red" : "amber"}`}>
                    {nodeDetail.node.status}
                  </span>
                </div>
                <dl className="kv">
                  <dt>w1·support</dt>
                  <dd>{nodeDetail.confidence.support_term.toFixed(4)}</dd>
                  <dt>w2·recency</dt>
                  <dd>{(nodeDetail.confidence.weights.w2 * nodeDetail.confidence.recency).toFixed(4)}</dd>
                  <dt>w3·outcome</dt>
                  <dd>{(nodeDetail.confidence.weights.w3 * nodeDetail.confidence.outcome_strength).toFixed(4)}</dd>
                  <dt>w4·contradiction</dt>
                  <dd>−{(nodeDetail.confidence.weights.w4 * nodeDetail.confidence.contradiction_mass).toFixed(4)}</dd>
                  <dt>episodes / docs</dt>
                  <dd>
                    {nodeDetail.confidence.n_episodes} / {nodeDetail.confidence.n_documents}
                  </dd>
                  <dt>half-life</dt>
                  <dd>
                    {nodeDetail.confidence.effective_half_life_days.toFixed(1)}d (age {nodeDetail.confidence.age_days.toFixed(2)}d)
                  </dd>
                  {nodeDetail.confidence.document_cap_applied && (
                    <>
                      <dt>document cap</dt>
                      <dd>applied — doc-only claims stay below trusted</dd>
                    </>
                  )}
                </dl>
              </Card>
            )}

            <Card title="Properties">
              <Json data={nodeDetail.node.props} max={6000} />
            </Card>

            <Card title={`Outgoing edges (${nodeDetail.edges_out.length})`}>
              {nodeDetail.edges_out.map((e: any) => (
                <div key={e.id} className="row small" style={{ justifyContent: "space-between", padding: "3px 0", borderBottom: "1px solid #eef1f5" }}>
                  <span className="pill grey">{e.type}</span>
                  <span className="mono trunc" style={{ maxWidth: 230 }} onClick={() => setSelected(e.dst)}>
                    {e.dst}
                  </span>
                  <span className="mono faint">w={e.weight}</span>
                </div>
              ))}
              {!nodeDetail.edges_out.length && <div className="faint">none</div>}
            </Card>

            <Card title={`Incoming edges (${nodeDetail.edges_in.length})`}>
              {nodeDetail.edges_in.map((e: any) => (
                <div key={e.id} className="row small" style={{ justifyContent: "space-between", padding: "3px 0", borderBottom: "1px solid #eef1f5" }}>
                  <span className="pill grey">{e.type}</span>
                  <span className="mono trunc" style={{ maxWidth: 230 }} onClick={() => setSelected(e.src)}>
                    {e.src}
                  </span>
                  <span className="mono faint">w={e.weight}</span>
                </div>
              ))}
              {!nodeDetail.edges_in.length && <div className="faint">none</div>}
            </Card>
          </div>
        )}
      </Drawer>
    </div>
  );
}
