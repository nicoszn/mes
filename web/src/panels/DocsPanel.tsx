import React, { useRef, useState } from "react";
import { get, post, upload, timeAgo } from "../api";
import { Bar, Card, Empty, Json, StatusPill, useAsync } from "../components";

export default function DocsPanel({ refresh }: { refresh?: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const { data: docs, reload: reloadDocs } = useAsync(() => get("/docs"), []);
  const { data: detail, reload: reloadDetail } = useAsync(
    () => (selected ? get(`/docs/${selected}`) : Promise.resolve(null)),
    [selected]
  );
  const [span, setSpan] = useState<any>(null);

  const doUpload = async () => {
    if (!file) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await upload("/docs", file);
      setResult(r);
      reloadDocs();
      setSelected(r.episode_id);
      refresh?.();
    } catch (e: any) {
      setErr(String(e.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const redact = async (id: string) => {
    try {
      const r = await post(`/docs/${id}/redact`);
      setResult({ redaction: r });
      reloadDocs();
      reloadDetail();
      refresh?.();
    } catch (e: any) {
      setErr(String(e.message ?? e));
    }
  };

  const chunks = detail?.chunks ?? [];
  const pages = detail?.pages ?? [];

  return (
    <div>
      <Card title="Document door — PDF / text / HTML" right={<span className="small muted">page → chunk with exact spans, asserted before write</span>}>
        <div className="row">
          <input
            ref={inputRef}
            type="file"
            accept=".pdf,.txt,.md,.html,.htm,.csv,.json"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            style={{ width: 380 }}
          />
          <button className="btn" onClick={doUpload} disabled={!file || busy}>
            {busy ? "extracting pages…" : "↑ Ingest document"}
          </button>
          <span className="faint">chunks inherit the chat door's node/edge schema — retrieval cannot tell a doc chunk from a chat turn</span>
        </div>
        {err && <div className="note err mt">{err}</div>}
        {result?.span_assertion && (
          <div className="note ok mt">
            V1 span resolution: {result.span_assertion.checked}/{result.span_assertion.checked} chunk spans resolve back
            to page text · {result.pages} page(s) → {result.chunks} chunk(s)
            {result.duplicate ? " · duplicate source (content-addressed, already ingested)" : ""}
            {result.claims_created !== undefined ? ` · ${result.claims_created} fact claims promoted (relevance ≥ policy)` : ""}
          </div>
        )}
        {result?.redaction && (
          <div className="note warn mt">
            redacted {result.redaction.chunks_wiped} chunk(s), wiped {result.redaction.pages_wiped} page(s), deleted raw
            blob: {String(result.redaction.blob_deleted)} · PROVENANCE_CHUNK preserved:{" "}
            {result.redaction.provenance_edges_preserved} · {result.redaction.affected_claims.length} claim(s)
            re-evaluated
          </div>
        )}
      </Card>

      <Card className="mt" title="Ingested sources">
        <table>
          <thead>
            <tr>
              <th>file</th>
              <th>pages</th>
              <th>chunks</th>
              <th>redacted</th>
              <th>relevance (min/avg/max)</th>
              <th>claims</th>
              <th>status</th>
              <th>source_hash</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(docs?.documents ?? []).map((d: any) => (
              <tr key={d.id} className="click" onClick={() => setSelected(d.id)}>
                <td>
                  <strong>{d.filename}</strong>
                </td>
                <td className="mono">{d.pages}</td>
                <td className="mono">{d.chunks}</td>
                <td className="mono">{d.redacted}</td>
                <td className="mono small">{d.avg_relevance.toFixed(3)}</td>
                <td className="mono">{d.claims}</td>
                <td>
                  <StatusPill status={d.status} />
                </td>
                <td className="mono faint">{String(d.source_hash).slice(0, 12)}</td>
                <td onClick={(e) => e.stopPropagation()}>
                  {d.status !== "source_redacted" && (
                    <button className="btn danger sm" onClick={() => redact(d.id)}>
                      redact
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!docs?.documents?.length && <Empty>No documents yet — upload one above.</Empty>}
      </Card>

      {detail && (
        <div className="grid g2 mt">
          <Card
            title={`Chunks · ${detail.episode.props.filename}`}
            right={<span className="small muted">{detail.episode.status}</span>}
          >
            <table>
              <thead>
                <tr>
                  <th>ord</th>
                  <th>page</th>
                  <th>span</th>
                  <th>relevance</th>
                  <th>text</th>
                </tr>
              </thead>
              <tbody>
                {chunks.map((c: any) => (
                  <tr key={c.id} className="click" onClick={() => setSpan({ chunk: c })}>
                    <td className="mono">{c.props.ord}</td>
                    <td className="mono">{c.props.page}</td>
                    <td className="mono">
                      [{c.props.span_start},{c.props.span_end}]
                    </td>
                    <td style={{ minWidth: 90 }}>
                      <div className="mono small">{c.relevance == null ? "–" : c.relevance.toFixed(3)}</div>
                      <Bar value={c.relevance ?? 0} color={c.props.redacted ? "red" : "green"} />
                    </td>
                    <td className="small trunc" style={{ maxWidth: 300 }} title={c.props.text ?? ""}>
                      {c.props.redacted ? <em className="faint">redacted — text wiped, node kept</em> : c.props.text}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="note mt">
              Coverage invariant: relevance never deletes or rewrites a chunk — it only gates promotion to T3.
            </div>
          </Card>

          <div className="col">
            <Card
              title="Span resolution inspector (V1)"
              right={<span className={`pill ${detail.span_check.passed ? "green" : "red"}`}>{detail.span_check.passed ? "PASS" : "FAIL"}</span>}
            >
              <div className="small muted mb">
                {detail.span_check.resolved}/{detail.span_check.checked} chunk spans resolve exactly to page text
              </div>
              <div className="row mb">
                <select
                  value={span?.chunk?.id ?? ""}
                  onChange={(e) => setSpan({ chunk: chunks.find((c: any) => c.id === e.target.value) })}
                >
                  <option value="">select a chunk…</option>
                  {chunks.map((c: any) => (
                    <option key={c.id} value={c.id}>
                      p{c.props.page} [{c.props.span_start},{c.props.span_end}] {String(c.props.text ?? "–").slice(0, 40)}
                    </option>
                  ))}
                </select>
              </div>
              {span?.chunk && (
                <>
                  <div className="small muted mb">page {span.chunk.props.page} text with the chunk span highlighted</div>
                  <pre className="plain">
                    {(() => {
                      const page = pages.find((p: any) => p.page === span.chunk.props.page);
                      if (!page || page.redacted) return "(page text redacted)";
                      const { span_start, span_end, text } = span.chunk.props;
                      const slice = page.text.slice(span_start, span_end);
                      if (slice !== text) return "✗ span does not resolve to page text — invariant broken";
                      return (
                        <>
                          {page.text.slice(0, span_start)}
                          <span className="hl">{text}</span>
                          {page.text.slice(span_end)}
                        </>
                      );
                    })()}
                  </pre>
                  <div className="row mt" style={{ gap: 8 }}>
                    <span className="pill grey">content_hash {String(span.chunk.props.content_hash).slice(0, 14)}</span>
                    <span className="pill grey">source_hash {String(span.chunk.props.source_hash).slice(0, 14)}</span>
                  </div>
                </>
              )}
            </Card>

            {span?.chunk && (
              <Card title="Relevance breakdown (deterministic)">
                <dl className="kv">
                  <dt>text density</dt>
                  <dd>{span.chunk.props.relevance_breakdown?.density?.toFixed(3)}</dd>
                  <dt>length factor</dt>
                  <dd>{span.chunk.props.relevance_breakdown?.length_factor?.toFixed(3)}</dd>
                  <dt>boilerplate penalty</dt>
                  <dd>{span.chunk.props.relevance_breakdown?.boilerplate?.toFixed(3)}</dd>
                  <dt>idf salience s</dt>
                  <dd>{span.chunk.props.relevance_breakdown?.salience?.toFixed(3)}</dd>
                  <dt>1 − exp(−s/τ)</dt>
                  <dd>{span.chunk.props.relevance_breakdown?.idf_term?.toFixed(3)}</dd>
                  <dt>relevance</dt>
                  <dd style={{ fontWeight: 700 }}>{span.chunk.relevance?.toFixed(4)}</dd>
                  <dt>min for promotion</dt>
                  <dd>policy relevance.min_relevance_for_promotion</dd>
                </dl>
                <pre className="plain mt">
                  {`r = w_td·density + w_len·length − w_bp·boilerplate + w_idf·(1−exp(−s/τ))
  = ${span.chunk.props.relevance_breakdown ? JSON.stringify({
      density: +span.chunk.props.relevance_breakdown.density.toFixed(3),
      length: +span.chunk.props.relevance_breakdown.length_factor.toFixed(3),
      boilerplate: +span.chunk.props.relevance_breakdown.boilerplate.toFixed(3),
      idf: +span.chunk.props.relevance_breakdown.idf_term.toFixed(3),
    }) : "–"}`}
                </pre>
              </Card>
            )}

            <Card title="Source episode">
              <dl className="kv">
                <dt>episode</dt>
                <dd>{detail.episode.id}</dd>
                <dt>kind / status</dt>
                <dd>
                  {detail.episode.props.episode_kind} / {detail.episode.status}
                </dd>
                <dt>pages</dt>
                <dd>{pages.map((p: any) => `p${p.page}:${p.redacted ? "redacted" : p.length + "ch"}`).join("  ")}</dd>
                <dt>ingested</dt>
                <dd>{timeAgo(detail.episode.props.ingested_at)}</dd>
              </dl>
              <div className="small muted mt">claims from this document: {detail.claims.length}</div>
              <div style={{ maxHeight: 200, overflowY: "auto" }}>
                {detail.claims.slice(0, 30).map((c: any) => (
                  <div key={c.id} className="small" style={{ padding: "3px 0", borderBottom: "1px solid #eef1f5" }}>
                    <span className={`pill ${c.status === "trusted" ? "green" : c.status === "retired" ? "red" : "amber"}`} style={{ marginRight: 6 }}>
                      {c.status}
                    </span>
                    {c.props.text}
                  </div>
                ))}
              </div>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
