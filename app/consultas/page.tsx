"use client";

import { useEffect, useRef, useState } from "react";
import { NoAccountState } from "../NoAccountState";

interface QuestionDraft {
  mlQuestionId: string;
  productId: string;
  productTitle: string;
  thumbnail: string | null;
  questionText: string;
  draftAnswer: string;
  dateCreated: string;
  draftSource: "rules" | "ai" | "manual";
  aiConfident: boolean | null;
  aiMissing: string | null;
}

type DraftResult =
  | { mlQuestionId: string; ok: true; answer: string; confident: boolean; missing: string }
  | { mlQuestionId: string; ok: false; error: string };

/** Vueltas máximas de borradores automáticos por carga de la página (6 consultas cada una). */
const MAX_AUTO_ROUNDS = 6;

const ago = (iso: string) => {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 60) return `hace ${mins} min`;
  const h = Math.round(mins / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.round(h / 24);
  return `hace ${d} ${d === 1 ? "día" : "días"}`;
};

export default function PreguntasPage() {
  const [questions, setQuestions] = useState<QuestionDraft[] | null>(null);
  const [editing, setEditing] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<{ id: string; action: "save" | "send" } | null>(null);
  const [noAccount, setNoAccount] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [ai, setAi] = useState<{ enabled: boolean; hasInfo: boolean } | null>(null);
  const [drafting, setDrafting] = useState<Set<string>>(new Set());
  const [autoDrafting, setAutoDrafting] = useState(false);
  const [bulk, setBulk] = useState<{ done: number; total: number } | null>(null);
  const autoRan = useRef(false);

  function applyDraft(r: DraftResult) {
    if (!r.ok) {
      setErrors((prev) => ({ ...prev, [r.mlQuestionId]: r.error }));
      return;
    }
    setQuestions((prev) =>
      prev?.map((q) =>
        q.mlQuestionId === r.mlQuestionId
          ? { ...q, draftAnswer: r.answer, draftSource: "ai", aiConfident: r.confident, aiMissing: r.missing || null }
          : q
      ) ?? prev
    );
    setEditing((prev) => ({ ...prev, [r.mlQuestionId]: r.answer }));
  }

  async function requestDrafts(ids?: string[]): Promise<{ results: DraftResult[]; more: boolean } | null> {
    const res = await fetch("/api/questions/draft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ids ? { mlQuestionIds: ids.map(Number) } : {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (ids) for (const id of ids) setErrors((prev) => ({ ...prev, [id]: data.error ?? "No se pudo escribir el borrador." }));
      return null;
    }
    for (const r of data.results as DraftResult[]) applyDraft(r);
    return data;
  }

  /** Las consultas nuevas pasan solas por la IA; las que el vendedor ya editó, no. */
  async function autoDraft() {
    setAutoDrafting(true);
    try {
      for (let round = 0; round < MAX_AUTO_ROUNDS; round++) {
        const data = await requestDrafts();
        if (!data || !data.more || !data.results.some((r) => r.ok)) break;
      }
    } finally {
      setAutoDrafting(false);
    }
  }

  async function redraft(id: string) {
    setErrors((prev) => ({ ...prev, [id]: "" }));
    setDrafting((prev) => new Set(prev).add(id));
    try {
      await requestDrafts([id]);
    } finally {
      setDrafting((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  function load() {
    setLoadError("");
    return fetch("/api/questions").then(async (r) => {
      if (r.status === 401) { setNoAccount(true); return null; }
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        setLoadError(data.error ?? "No se pudieron cargar las preguntas.");
        setQuestions([]);
        return null;
      }
      const rows: QuestionDraft[] = await r.json();
      setQuestions(rows);
      setEditing((prev) => {
        const next = { ...prev };
        for (const q of rows) if (next[q.mlQuestionId] === undefined) next[q.mlQuestionId] = q.draftAnswer;
        return next;
      });
      return rows;
    });
  }

  useEffect(() => {
    const info = fetch("/api/account/answer-info")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const state = d ? { enabled: Boolean(d.aiEnabled) && d.available !== false, hasInfo: Boolean(d.sellerInfo?.trim()) } : { enabled: false, hasInfo: false };
        setAi(state);
        return state;
      })
      .catch(() => ({ enabled: false, hasInfo: false }));
    Promise.all([load(), info]).then(([rows, state]) => {
      if (autoRan.current || !rows || !state.enabled) return;
      autoRan.current = true;
      if (rows.some((q) => q.draftSource === "rules")) autoDraft();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (noAccount) {
    return (
      <div>
        <h1>Consultas</h1>
        <NoAccountState />
      </div>
    );
  }

  async function send(mlQuestionId: string, action: "save" | "send"): Promise<boolean> {
    const answer = (editing[mlQuestionId] ?? "").trim();
    if (!answer) {
      setErrors((prev) => ({ ...prev, [mlQuestionId]: "Escribí una respuesta antes de guardar o enviar." }));
      return false;
    }
    setErrors((prev) => ({ ...prev, [mlQuestionId]: "" }));
    const res = await fetch("/api/questions", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mlQuestionId: Number(mlQuestionId), answer, action }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setErrors((prev) => ({ ...prev, [mlQuestionId]: data.error ?? "No se pudo guardar." }));
      return false;
    }
    if (action === "send") setQuestions((prev) => prev?.filter((q) => q.mlQuestionId !== mlQuestionId) ?? prev);
    else setQuestions((prev) => prev?.map((q) => (q.mlQuestionId === mlQuestionId ? { ...q, draftSource: "manual" } : q)) ?? prev);
    return true;
  }

  async function respond(mlQuestionId: string, action: "save" | "send") {
    setSavingId({ id: mlQuestionId, action });
    try {
      await send(mlQuestionId, action);
    } finally {
      setSavingId(null);
    }
  }

  const isReady = (q: QuestionDraft) =>
    q.draftSource === "ai" && q.aiConfident === true && (editing[q.mlQuestionId] ?? "").trim() !== "";
  const ready = (questions ?? []).filter(isReady);
  const toReview = (questions ?? []).filter((q) => !isReady(q));

  async function sendReady() {
    const list = ready.map((q) => q.mlQuestionId);
    if (!list.length) return;
    if (!window.confirm(`Se van a mandar ${list.length} ${list.length === 1 ? "respuesta" : "respuestas"} a Mercado Libre, tal como están escritas. ¿Seguimos?`)) return;
    setBulk({ done: 0, total: list.length });
    try {
      for (const [i, id] of list.entries()) {
        await send(id, "send");
        setBulk({ done: i + 1, total: list.length });
      }
    } finally {
      setBulk(null);
    }
  }

  const total = questions?.length ?? 0;

  return (
    <div>
      <div className="title-row">
        <h1>Consultas</h1>
        {ready.length > 0 && (
          <button className="btn btn-primary" onClick={sendReady} disabled={bulk !== null}>
            {bulk ? `Enviando ${bulk.done} de ${bulk.total}…` : `Enviar las ${ready.length} listas`}
          </button>
        )}
      </div>

      {questions !== null && total > 0 && (
        <p className="page-finding" aria-live="polite">
          {autoDrafting ? (
            <>Escribiendo respuestas con la ficha y la descripción de cada publicación…</>
          ) : ai?.enabled ? (
            <>
              <strong>{ready.length} de {total}</strong> {total === 1 ? "consulta tiene" : "consultas tienen"} una respuesta lista para enviar
              {toReview.length > 0 && <>; {toReview.length} {toReview.length === 1 ? "necesita" : "necesitan"} que la revises</>}.
            </>
          ) : (
            <>
              <strong>{total}</strong> {total === 1 ? "consulta sin responder" : "consultas sin responder"}. Los borradores son sugerencias: revisalos antes de mandar.
            </>
          )}
        </p>
      )}

      {ai?.enabled && !ai.hasInfo && (
        <p className="field-hint" style={{ marginBottom: "var(--space-4)" }}>
          La IA responde con la ficha y la descripción de cada publicación. Para que también sepa de envíos, factura,
          garantía o retiro, <a href="/configuracion#respuestas">cargá la información de tu tienda</a>.
        </p>
      )}

      {loadError && <p className="field-error" role="alert" style={{ marginBottom: "var(--space-4)" }}>{loadError}</p>}
      {questions === null ? (
        <p className="empty-state">Cargando consultas…</p>
      ) : questions.length === 0 ? (
        <div className="empty-state">No tenés consultas sin responder por ahora.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
          {questions.map((q) => {
            const busy = drafting.has(q.mlQuestionId) || (autoDrafting && q.draftSource === "rules");
            return (
              <div key={q.mlQuestionId} className="day-card" style={{ marginBottom: 0 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--space-3)" }}>
                  <span className="cell-product field-hint" style={{ margin: 0, minWidth: 0 }}>
                    {q.thumbnail ? (
                      <img className="cell-thumb" src={q.thumbnail} alt="" loading="lazy" />
                    ) : (
                      <span className="cell-thumb" aria-hidden="true" />
                    )}
                    <span>{q.productTitle}</span>
                  </span>
                  <span className="field-hint" style={{ margin: 0, whiteSpace: "nowrap" }}>{ago(q.dateCreated)}</span>
                </div>
                <p style={{ margin: "var(--space-2) 0", fontWeight: 600 }}>{q.questionText}</p>
                <div className="field-group">
                  <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", flexWrap: "wrap" }}>
                    <label className="field-hint" htmlFor={`answer-${q.mlQuestionId}`} style={{ margin: 0 }}>
                      Respuesta
                    </label>
                    {busy ? (
                      <span className="pill pill-neutral">Escribiendo…</span>
                    ) : q.draftSource === "ai" && q.aiConfident ? (
                      <span className="pill pill-pos">Lista para enviar</span>
                    ) : q.draftSource === "ai" ? (
                      <span className="pill pill-neg">Revisar</span>
                    ) : q.draftSource === "manual" ? (
                      <span className="pill pill-neutral">Editada por vos</span>
                    ) : null}
                  </div>
                  {!busy && q.draftSource === "ai" && !q.aiConfident && q.aiMissing && (
                    <p className="field-hint" style={{ margin: "var(--space-1) 0 0" }}>Falta: {q.aiMissing}</p>
                  )}
                  <textarea
                    id={`answer-${q.mlQuestionId}`}
                    rows={3}
                    maxLength={2000}
                    value={editing[q.mlQuestionId] ?? ""}
                    disabled={busy}
                    onChange={(e) => {
                      setEditing((prev) => ({ ...prev, [q.mlQuestionId]: e.target.value }));
                      if (errors[q.mlQuestionId]) setErrors((prev) => ({ ...prev, [q.mlQuestionId]: "" }));
                    }}
                    style={{
                      width: "100%",
                      background: "var(--surface)",
                      border: "1px solid var(--border)",
                      color: "var(--text)",
                      borderRadius: "var(--radius-sm)",
                      padding: "9px 10px",
                      fontFamily: "inherit",
                      fontSize: 14,
                      resize: "vertical",
                    }}
                  />
                  {errors[q.mlQuestionId] && <p className="field-error">{errors[q.mlQuestionId]}</p>}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginTop: "var(--space-2)", flexWrap: "wrap" }}>
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => respond(q.mlQuestionId, "send")}
                    disabled={savingId?.id === q.mlQuestionId || busy || bulk !== null}
                  >
                    {savingId?.id === q.mlQuestionId && savingId.action === "send" ? "Enviando…" : "Enviar a Mercado Libre"}
                  </button>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => respond(q.mlQuestionId, "save")}
                    disabled={savingId?.id === q.mlQuestionId || busy}
                  >
                    {savingId?.id === q.mlQuestionId && savingId.action === "save" ? "Guardando…" : "Guardar borrador"}
                  </button>
                  {ai?.enabled && (
                    <button className="link-btn" style={{ marginLeft: "auto" }} onClick={() => redraft(q.mlQuestionId)} disabled={busy}>
                      {q.draftSource === "ai" ? "Reescribir con IA" : "Responder con IA"}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
