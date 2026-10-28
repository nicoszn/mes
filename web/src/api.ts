const BASE = "/api";

export async function get<T = any>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`);
  return body as T;
}

export async function post<T = any>(path: string, data?: any): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data ?? {}),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`);
  return body as T;
}

export async function upload<T = any>(path: string, file: File): Promise<T> {
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch(`${BASE}${path}`, { method: "POST", body: fd });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`);
  return body as T;
}

export const ROLES = ["Planner", "Executor", "Critic", "Orchestrator"] as const;
export type RoleName = (typeof ROLES)[number];

export const TIER_META: Record<number, { label: string; short: string; color: string }> = {
  0: { label: "T0 · instrumentation", short: "T0", color: "#8b95a5" },
  1: { label: "T1 · raw interaction events", short: "T1", color: "#2563eb" },
  2: { label: "T2 · episodic summaries", short: "T2", color: "#0f9d58" },
  3: { label: "T3 · semantic claims", short: "T3", color: "#8b5cf6" },
  4: { label: "T4 · policy / config", short: "T4", color: "#d97706" },
};

export const TYPE_COLOR: Record<string, string> = {
  Event: "#2563eb",
  Chunk: "#0ea5e9",
  Episode: "#0f9d58",
  Claim: "#8b5cf6",
  Policy: "#d97706",
  Trace: "#8b95a5",
};

export function fmt(n: number | null | undefined, digits = 3): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "–";
  return typeof n === "number" ? n.toFixed(digits) : String(n);
}

export function timeAgo(ts: number | null | undefined): string {
  if (!ts) return "–";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function clock(ts: number | null | undefined): string {
  if (!ts) return "–";
  return new Date(ts).toLocaleTimeString();
}
