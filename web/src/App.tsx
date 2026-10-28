import React, { useEffect, useState } from "react";
import { get, TIER_META } from "./api";
import { TierPill } from "./components";
import Overview from "./panels/Overview";
import ChatPanel from "./panels/ChatPanel";
import GraphPanel from "./panels/GraphPanel";
import RetrievalPanel from "./panels/RetrievalPanel";
import ScopePanel from "./panels/ScopePanel";
import DocsPanel from "./panels/DocsPanel";
import ClaimsPanel from "./panels/ClaimsPanel";
import TracesPanel from "./panels/TracesPanel";
import PolicyPanel from "./panels/PolicyPanel";
import ReplayPanel from "./panels/ReplayPanel";
import InvariantsPanel from "./panels/InvariantsPanel";

type PanelId =
  | "overview"
  | "chat"
  | "graph"
  | "retrieval"
  | "scope"
  | "docs"
  | "claims"
  | "traces"
  | "policy"
  | "replay"
  | "invariants";

const NAV: { group: string; items: { id: PanelId; label: string }[] }[] = [
  {
    group: "Operate",
    items: [
      { id: "overview", label: "Overview" },
      { id: "chat", label: "Agent team chat" },
      { id: "docs", label: "Documents" },
      { id: "retrieval", label: "Retrieval" },
    ],
  },
  {
    group: "Inspect",
    items: [
      { id: "graph", label: "Property graph" },
      { id: "scope", label: "Role scope" },
      { id: "claims", label: "Claims & promotion" },
      { id: "traces", label: "Traces & audit" },
    ],
  },
  {
    group: "Control",
    items: [
      { id: "policy", label: "Policy (T4)" },
      { id: "replay", label: "Replay" },
      { id: "invariants", label: "Invariants" },
    ],
  },
];

const TITLES: Record<PanelId, [string, string]> = {
  overview: ["Overview", "Live state of the four tiers, hard gates and instrumentation"],
  chat: ["Agent team chat", "Planner · Executor · Critic · Orchestrator, with budget and episode lifecycle"],
  graph: ["Property graph", "Nodes are labeled by tier — promotion, retrieval and forgetting are queries, not moves"],
  retrieval: ["Sufficiency-gated retrieval", "Top-down descent from T3, hard scope filter, vector used only for candidates"],
  scope: ["Role scope", "visibility(role, tier) — 0.0 means the tier is physically absent from candidates"],
  docs: ["Documents", "Document door: page → chunk → span, relevance scoring, redaction"],
  claims: ["Claims & promotion", "Earned promotion, contradiction detection, decay"],
  traces: ["Traces & audit", "audit(trace_id) reconstructs why any answer was returned"],
  policy: ["Policy (T4)", "One versioned JSON document holds every threshold, weight, band and seed"],
  replay: ["Replay", "Re-run consolidation or retrieval against any policy version"],
  invariants: ["Invariants", "The design invariants, evaluated as pass/fail against live state"],
};

export default function App() {
  const [panel, setPanel] = useState<PanelId>("overview");
  const [boot, setBoot] = useState<any>(null);
  const [tick, setTick] = useState(0);
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () => get("/bootstrap").then((b) => alive && setBoot(b)).catch(() => {});
    load();
    const iv = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, []);

  const tiers = boot?.tiers ?? {};
  const [title, desc] = TITLES[panel];
  const Panel =
    panel === "overview" ? Overview :
    panel === "chat" ? ChatPanel :
    panel === "graph" ? GraphPanel :
    panel === "retrieval" ? RetrievalPanel :
    panel === "scope" ? ScopePanel :
    panel === "docs" ? DocsPanel :
    panel === "claims" ? ClaimsPanel :
    panel === "traces" ? TracesPanel :
    panel === "policy" ? PolicyPanel :
    panel === "replay" ? ReplayPanel :
    InvariantsPanel;

  return (
    <div className="app">
      {navOpen && <div className="nav-scrim" onClick={() => setNavOpen(false)} />}
      <aside className={`sidebar ${navOpen ? "open" : ""}`}>
        <div className="brand">
          <h1>HMM-MAS</h1>
          <div className="sub">hierarchical memory · agent teams</div>
        </div>
        <nav className="nav">
          {NAV.map((g) => (
            <div key={g.group}>
              <div className="nav-group">{g.group}</div>
              {g.items.map((it) => (
                <button
                  key={it.id}
                  className={panel === it.id ? "active" : ""}
                  onClick={() => {
                    setPanel(it.id);
                    setTick((t) => t + 1);
                    setNavOpen(false);
                  }}
                >
                  <span className="dot" />
                  {it.label}
                  {it.id === "claims" && tiers["3"] ? <span className="badge">{tiers["3"]}</span> : null}
                  {it.id === "graph" && tiers["1"] ? <span className="badge">{tiers["1"] + tiers["2"]}</span> : null}
                  {it.id === "traces" && tiers["0"] ? <span className="badge">{tiers["0"]}</span> : null}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="side-foot">
          <div className="row">
            {[1, 2, 3, 4].map((t) => (
              <TierPill key={t} tier={t} small />
            ))}
          </div>
          <div className="row mt">
            <span>active policy</span>
            <span className="mono">{boot?.active_version ?? "–"}</span>
          </div>
          <div className="row">
            <span>vector index</span>
            <span className="mono">{boot?.vector_index_size ?? 0}</span>
          </div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <button className="menu-btn" aria-label="Open navigation" onClick={() => setNavOpen(true)}>
            ☰
          </button>
          <div className="titles">
            <h2>{title}</h2>
            <div className="desc">{desc}</div>
          </div>
          <div className="spacer" />
          <div className="row wrap topbar-pills">
            <span className="pill grey">policy {boot?.active_version ?? "–"}</span>
            <span className="pill grey hide-sm">model {boot?.active_policy?.model?.model_id ?? "–"}</span>
            <span className="pill grey hide-sm">seed {boot?.active_policy?.model?.seed ?? "–"}</span>
            <button className="btn secondary sm" onClick={() => setTick((t) => t + 1)}>
              ↻ refresh
            </button>
          </div>
        </header>
        <div className="content" key={`${panel}-${tick}`}>
          <Panel boot={boot} refresh={() => setTick((t) => t + 1)} />
        </div>
      </main>
    </div>
  );
}
