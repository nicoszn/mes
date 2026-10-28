// Graph substrate: a labeled property graph on SQLite. Nodes carry a `tier` label, so
// promotion, retrieval and forgetting are queries over labels rather than storage moves.
import Database from "better-sqlite3";
import { ensureDirs, DB_PATH } from "./paths.js";
import type { GraphEdge, GraphNode, NodeType, Tier } from "./types.js";
import { TIER_OF } from "./types.js";
import { uid } from "./hash.js";

ensureDirs();

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS nodes (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  tier        INTEGER NOT NULL,
  label       TEXT NOT NULL,
  props       TEXT NOT NULL,
  status      TEXT,
  confidence  REAL,
  relevance   REAL,
  ts          INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type);
CREATE INDEX IF NOT EXISTS idx_nodes_tier ON nodes(tier);

CREATE TABLE IF NOT EXISTS edges (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  src         TEXT NOT NULL,
  dst         TEXT NOT NULL,
  weight      REAL NOT NULL DEFAULT 1,
  props       TEXT,
  created_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_edge_unique ON edges(type, src, dst);
CREATE INDEX IF NOT EXISTS idx_edge_src ON edges(src);
CREATE INDEX IF NOT EXISTS idx_edge_dst ON edges(dst);

-- Page text backing chunk spans (the document door's V1 span-resolution gate reads this).
CREATE TABLE IF NOT EXISTS source_pages (
  episode_id  TEXT NOT NULL,
  page        INTEGER NOT NULL,
  ord         INTEGER NOT NULL,
  text        TEXT,
  content_hash TEXT NOT NULL,
  PRIMARY KEY (episode_id, page)
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

/* ------------------------------------------------------------------ nodes */

export function putNode(n: Partial<GraphNode> & { type: NodeType; label: string; props: any }): GraphNode {
  const node: GraphNode = {
    id: n.id ?? uid(n.type[0].toLowerCase()),
    type: n.type,
    tier: n.tier ?? TIER_OF[n.type],
    label: n.label,
    props: n.props ?? {},
    status: n.status ?? n.props?.status ?? null,
    confidence: n.confidence ?? n.props?.confidence ?? null,
    relevance: n.relevance ?? n.props?.relevance ?? null,
    ts: n.ts ?? n.props?.ts ?? null,
    created_at: n.created_at ?? Date.now(),
  };
  db.prepare(
    `INSERT INTO nodes (id,type,tier,label,props,status,confidence,relevance,ts,created_at)
     VALUES (@id,@type,@tier,@label,@props,@status,@confidence,@relevance,@ts,@created_at)
     ON CONFLICT(id) DO UPDATE SET
       label=excluded.label, props=excluded.props, status=excluded.status,
       confidence=excluded.confidence, relevance=excluded.relevance, ts=excluded.ts`
  ).run({ ...node, props: JSON.stringify(node.props) });
  return node;
}

export function updateNodeProps(id: string, patch: Record<string, any>, extra: Partial<GraphNode> = {}) {
  const n = getNode(id);
  if (!n) throw new Error(`node not found: ${id}`);
  const props = { ...n.props, ...patch };
  putNode({ ...n, ...extra, props });
}

export function getNode(id: string): GraphNode | null {
  const row = db.prepare(`SELECT * FROM nodes WHERE id = ?`).get(id) as any;
  return row ? hydrate(row) : null;
}

export function hydrate(row: any): GraphNode {
  return { ...row, props: JSON.parse(row.props) };
}

export function countNodes(type?: NodeType): number {
  return type
    ? (db.prepare(`SELECT COUNT(*) c FROM nodes WHERE type = ?`).get(type) as any).c
    : (db.prepare(`SELECT COUNT(*) c FROM nodes`).get() as any).c;
}

export function tierCounts(): Record<string, number> {
  const rows = db.prepare(`SELECT tier, COUNT(*) c FROM nodes GROUP BY tier`).all() as any[];
  const out: Record<string, number> = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const r of rows) out[String(r.tier)] = r.c;
  return out;
}

export interface NodeQuery {
  type?: NodeType | NodeType[];
  tier?: number | number[];
  status?: string;
  search?: string;
  ids?: string[];
  limit?: number;
  offset?: number;
  order?: "created_at" | "ts" | "confidence" | "relevance";
}

export function queryNodes(q: NodeQuery = {}): GraphNode[] {
  const where: string[] = [];
  const args: any[] = [];
  if (q.type) {
    const types = Array.isArray(q.type) ? q.type : [q.type];
    where.push(`type IN (${types.map(() => "?").join(",")})`);
    args.push(...types);
  }
  if (q.tier !== undefined) {
    const tiers = Array.isArray(q.tier) ? q.tier : [q.tier];
    where.push(`tier IN (${tiers.map(() => "?").join(",")})`);
    args.push(...tiers);
  }
  if (q.status) {
    where.push(`status = ?`);
    args.push(q.status);
  }
  if (q.ids) {
    if (q.ids.length === 0) return [];
    where.push(`id IN (${q.ids.map(() => "?").join(",")})`);
    args.push(...q.ids);
  }
  if (q.search) {
    where.push(`(label LIKE ? OR props LIKE ?)`);
    args.push(`%${q.search}%`, `%${q.search}%`);
  }
  const order = q.order === "created_at" ? "created_at DESC" : `${q.order ?? "created_at"} DESC`;
  const sql = `SELECT * FROM nodes ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY ${order} LIMIT ? OFFSET ?`;
  args.push(q.limit ?? 500, q.offset ?? 0);
  return (db.prepare(sql).all(...args) as any[]).map(hydrate);
}

/* ------------------------------------------------------------------ edges */

/** MERGE semantics: one edge of a given type between a given pair. */
export function putEdge(
  type: string,
  src: string,
  dst: string,
  weight = 1,
  props: Record<string, any> | null = null
): GraphEdge {
  const existing = db.prepare(`SELECT * FROM edges WHERE type=? AND src=? AND dst=?`).get(type, src, dst) as any;
  if (existing) {
    const merged = { ...(existing.props ? JSON.parse(existing.props) : {}), ...(props ?? {}) };
    db.prepare(`UPDATE edges SET weight=?, props=? WHERE id=?`).run(weight, JSON.stringify(merged), existing.id);
    return { ...existing, weight, props: merged };
  }
  const edge: GraphEdge = {
    id: uid("e"),
    type,
    src,
    dst,
    weight,
    props,
    created_at: Date.now(),
  };
  db.prepare(
    `INSERT INTO edges (id,type,src,dst,weight,props,created_at) VALUES (@id,@type,@src,@dst,@weight,@props,@created_at)`
  ).run({ ...edge, props: props ? JSON.stringify(props) : null });
  return edge;
}

export function getEdge(id: string): GraphEdge | null {
  const row = db.prepare(`SELECT * FROM edges WHERE id=?`).get(id) as any;
  return row ? hydrateEdge(row) : null;
}

function hydrateEdge(row: any): GraphEdge {
  return { ...row, props: row.props ? JSON.parse(row.props) : null };
}

export function edgesOut(id: string, type?: string): GraphEdge[] {
  const rows = type
    ? db.prepare(`SELECT * FROM edges WHERE src=? AND type=? ORDER BY created_at`).all(id, type)
    : db.prepare(`SELECT * FROM edges WHERE src=? ORDER BY created_at`).all(id);
  return (rows as any[]).map(hydrateEdge);
}

export function edgesIn(id: string, type?: string): GraphEdge[] {
  const rows = type
    ? db.prepare(`SELECT * FROM edges WHERE dst=? AND type=? ORDER BY created_at`).all(id, type)
    : db.prepare(`SELECT * FROM edges WHERE dst=? ORDER BY created_at`).all(id);
  return (rows as any[]).map(hydrateEdge);
}

export function edgesOfTypes(types: string[]): GraphEdge[] {
  const rows = db
    .prepare(`SELECT * FROM edges WHERE type IN (${types.map(() => "?").join(",")})`)
    .all(...types);
  return (rows as any[]).map(hydrateEdge);
}

export function edgeCounts(): Record<string, number> {
  const rows = db.prepare(`SELECT type, COUNT(*) c FROM edges GROUP BY type`).all() as any[];
  const out: Record<string, number> = {};
  for (const r of rows) out[r.type] = r.c;
  return out;
}

export function deleteNodesByType(type: NodeType): number {
  const info = db.prepare(`DELETE FROM nodes WHERE type=?`).run(type);
  return info.changes;
}

export function deleteEdgesOfNode(nodeId: string): number {
  const info = db.prepare(`DELETE FROM edges WHERE src=? OR dst=?`).run(nodeId, nodeId);
  return info.changes;
}

/* --------------------------------------------------------------- settings */

export function getSetting(key: string): string | null {
  const row = db.prepare(`SELECT value FROM settings WHERE key=?`).get(key) as any;
  return row ? row.value : null;
}

export function setSetting(key: string, value: string) {
  db.prepare(
    `INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`
  ).run(key, value);
}

/* ------------------------------------------------------------- traversals */

export function neighbors(id: string, dir: "out" | "in" | "both", types?: string[]): GraphEdge[] {
  const out = dir === "in" ? [] : edgesOut(id);
  const inn = dir === "out" ? [] : edgesIn(id);
  const all = [...out, ...inn];
  return types ? all.filter((e) => types.includes(e.type)) : all;
}
