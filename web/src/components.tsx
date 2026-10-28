import React, { useCallback, useEffect, useRef, useState } from "react";
import { TIER_META } from "./api";

export function TierPill({ tier, small }: { tier: number; small?: boolean }) {
  const m = TIER_META[tier] ?? { short: `T${tier}`, label: `T${tier}`, color: "#888" };
  return (
    <span className={`pill t${tier}`} title={m.label} style={small ? { fontSize: 10.5, padding: "1px 7px" } : undefined}>
      {m.short}
    </span>
  );
}

export function Card({
  title,
  right,
  children,
  className = "",
}: {
  title?: React.ReactNode;
  right?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`card ${className}`}>
      {title && (
        <h3>
          {title} {right && <span className="right">{right}</span>}
        </h3>
      )}
      {children}
    </div>
  );
}

export function Bar({ value, color = "", max = 1 }: { value: number; color?: string; max?: number }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className={`bar ${color}`}>
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

export function PassFail({ pass, label }: { pass: boolean; label?: string }) {
  return (
    <span className={`passfail ${pass ? "pass" : "fail"}`}>
      <span className="mk">{pass ? "✓" : "!"}</span>
      {label ?? (pass ? "PASS" : "FAIL")}
    </span>
  );
}

export function Json({ data, max }: { data: any; max?: number }) {
  return <pre className="json">{JSON.stringify(data, null, 2).slice(0, max ?? 20000)}</pre>;
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function StatusPill({ status }: { status?: string | null }) {
  if (!status) return <span className="pill grey">–</span>;
  const map: Record<string, string> = {
    success: "green",
    trusted: "green",
    ok: "green",
    ingested: "green",
    provisional: "amber",
    pending: "amber",
    running: "blue",
    degraded: "red",
    failure: "red",
    retired: "red",
    timeout: "red",
    budget_exhausted: "amber",
    aborted: "red",
    source_redacted: "grey",
  };
  return <span className={`pill ${map[status] ?? "grey"}`}>{status}</span>;
}

export function Drawer({ open, onClose, children }: { open: boolean; onClose: () => void; children: React.ReactNode }) {
  if (!open) return null;
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="drawer">
        <button className="close" onClick={onClose} title="Close">
          ×
        </button>
        {children}
      </div>
    </>
  );
}

export function useAsync<T>(fn: () => Promise<T>, deps: any[]): {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fn()
      .then((d) => {
        if (!cancelled && alive.current) {
          setData(d);
          setError(null);
        }
      })
      .catch((e) => {
        if (!cancelled && alive.current) setError(String(e?.message ?? e));
      })
      .finally(() => {
        if (!cancelled && alive.current) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}

export function Section({ children }: { children: React.ReactNode }) {
  return <div className="mt">{children}</div>;
}
