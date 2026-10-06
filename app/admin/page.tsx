"use client";

import { useEffect, useState } from "react";
import { TrialRequests } from "./TrialRequests";

interface AccountRow {
  id: string;
  name: string;
  ownerEmail: string;
  mlSellerId: string | null;
}

export default function AdminAccountsPage() {
  const [accounts, setAccounts] = useState<AccountRow[] | null>(null);
  const [form, setForm] = useState({ name: "", ownerEmail: "" });
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [invitingId, setInvitingId] = useState<string | null>(null);
  const [inviteLinks, setInviteLinks] = useState<Record<string, { url: string; hadPasswordAlready: boolean }>>({});
  const [inviteError, setInviteError] = useState<Record<string, string>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ name: "", ownerEmail: "" });
  const [editError, setEditError] = useState("");
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<Record<string, string>>({});
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);

  function load() {
    fetch("/api/admin/accounts")
      .then((r) => r.json())
      .then((data) => setAccounts(data.accounts ?? []));
  }

  useEffect(load, []);

  async function createAccount(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!form.name.trim() || !form.ownerEmail.trim()) {
      setError("Completá nombre y email para crear la cuenta.");
      return;
    }
    setCreating(true);
    try {
      const res = await fetch("/api/admin/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error ?? "Error al crear la cuenta");
        return;
      }
      setForm({ name: "", ownerEmail: "" });
      load();
    } finally {
      setCreating(false);
    }
  }

  /**
   * No es un registro abierto: esto genera un link de un solo uso para el
   * owner_email YA guardado de esa cuenta (nunca un email suelto), pensado
   * para pasárselo al cliente por WhatsApp o el canal que sea. El token en
   * claro viaja una sola vez, en esta respuesta — después no se puede
   * volver a ver, ni siquiera desde acá.
   */
  async function generateInvite(accountId: string) {
    setInvitingId(accountId);
    setInviteError((prev) => ({ ...prev, [accountId]: "" }));
    try {
      const res = await fetch("/api/admin/credential-invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setInviteError((prev) => ({ ...prev, [accountId]: data.error ?? "No se pudo generar la invitación." }));
        return;
      }
      const url = `${window.location.origin}/set-password?token=${data.token}`;
      setInviteLinks((prev) => ({ ...prev, [accountId]: { url, hadPasswordAlready: data.hadPasswordAlready } }));
    } finally {
      setInvitingId(null);
    }
  }

  function startEdit(a: AccountRow) {
    setEditingId(a.id);
    setEditForm({ name: a.name, ownerEmail: a.ownerEmail });
    setEditError("");
  }

  function cancelEdit() {
    setEditingId(null);
    setEditError("");
  }

  async function saveEdit(accountId: string) {
    if (!editForm.name.trim() || !editForm.ownerEmail.trim()) {
      setEditError("Nombre y email no pueden quedar vacíos.");
      return;
    }
    setEditError("");
    setSaving(true);
    try {
      const res = await fetch("/api/admin/accounts", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId, name: editForm.name, ownerEmail: editForm.ownerEmail }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setEditError(data.error ?? "No se pudo guardar.");
        return;
      }
      setEditingId(null);
      load();
    } finally {
      setSaving(false);
    }
  }

  /**
   * Confirmación en dos pasos (no un window.confirm nativo, para poder
   * mostrar el motivo si Postgres rechaza el borrado). Solo borra cuentas
   * genuinamente vacías: las foreign keys de products/orders/etc. rechazan
   * el borrado si la cuenta tiene historial real (ver migración 017).
   */
  async function confirmDelete(accountId: string) {
    setDeletingId(accountId);
    setDeleteError((prev) => ({ ...prev, [accountId]: "" }));
    try {
      const res = await fetch("/api/admin/accounts", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setDeleteError((prev) => ({ ...prev, [accountId]: data.error ?? "No se pudo borrar la cuenta." }));
        setConfirmingDeleteId(null);
        return;
      }
      setConfirmingDeleteId(null);
      load();
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div>
      <h1>Cuentas</h1>

      <TrialRequests
        onCreateAccount={(name, ownerEmail) => {
          setForm({ name, ownerEmail });
          setError("");
          document.getElementById("acc-name")?.scrollIntoView({ behavior: "smooth", block: "center" });
        }}
      />

      <h2 className="section-title">Nueva cuenta</h2>
      <form className="ad-form" onSubmit={createAccount} noValidate style={{ marginBottom: 24 }}>
        <div className="field-group">
          <label htmlFor="acc-name">Nombre</label>
          <input
            id="acc-name"
            value={form.name}
            onChange={(e) => {
              setForm((p) => ({ ...p, name: e.target.value }));
              if (error) setError("");
            }}
          />
        </div>
        <div className="field-group">
          <label htmlFor="acc-email">Email del cliente</label>
          <input
            id="acc-email"
            type="email"
            value={form.ownerEmail}
            onChange={(e) => {
              setForm((p) => ({ ...p, ownerEmail: e.target.value }));
              if (error) setError("");
            }}
          />
        </div>
        <button type="submit" className="btn btn-primary" disabled={creating}>
          {creating ? "Creando…" : "Crear"}
        </button>
        {error && <p className="field-error" role="alert">{error}</p>}
      </form>
      <p className="field-hint" style={{ marginTop: -16, marginBottom: 24 }}>
        Si el cliente usa Google, entra directo con este email. Si no (Hotmail, Outlook, etc.), generá una
        invitación desde la tabla de abajo para que ponga su contraseña.
      </p>

      <h2 className="section-title">Todas las cuentas</h2>
      {accounts === null ? (
        <p className="empty-state">Cargando cuentas…</p>
      ) : accounts.length === 0 ? (
        <div className="empty-state">Todavía no creaste ninguna cuenta.</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Email</th>
                <th>Mercado Libre</th>
                <th>Login sin Google</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id}>
                  {editingId === a.id ? (
                    <>
                      <td>
                        <input
                          value={editForm.name}
                          onChange={(e) => setEditForm((p) => ({ ...p, name: e.target.value }))}
                          style={{ width: 140 }}
                          aria-label={`Nombre de ${a.name}`}
                        />
                      </td>
                      <td>
                        <input
                          type="email"
                          value={editForm.ownerEmail}
                          onChange={(e) => setEditForm((p) => ({ ...p, ownerEmail: e.target.value }))}
                          style={{ width: 180 }}
                          aria-label={`Email de ${a.name}`}
                        />
                      </td>
                    </>
                  ) : (
                    <>
                      <td>{a.name}</td>
                      <td>{a.ownerEmail}</td>
                    </>
                  )}
                  <td>
                    {a.mlSellerId ? (
                      <span className="badge badge-paid">Conectado (seller {a.mlSellerId})</span>
                    ) : (
                      <span className="badge badge-other">Sin conectar</span>
                    )}
                  </td>
                  <td>
                    {inviteLinks[a.id] ? (
                      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)", maxWidth: 320 }}>
                        {inviteLinks[a.id].hadPasswordAlready && (
                          <p className="field-hint" style={{ margin: 0, color: "var(--negative)" }}>
                            Ya tenía contraseña puesta — este link, al usarse, la reemplaza.
                          </p>
                        )}
                        <div style={{ display: "flex", gap: "var(--space-1)" }}>
                          <input readOnly value={inviteLinks[a.id].url} style={{ fontSize: 12, flex: "1 1 auto", minWidth: 0 }} onFocus={(e) => e.target.select()} />
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={() => navigator.clipboard.writeText(inviteLinks[a.id].url)}
                          >
                            Copiar
                          </button>
                        </div>
                        <p className="field-hint" style={{ margin: 0 }}>
                          Guardalo ahora: no se puede volver a ver. Vence en 7 días o al primer uso.
                        </p>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => generateInvite(a.id)}
                        disabled={invitingId === a.id}
                      >
                        {invitingId === a.id ? "Generando…" : "Generar invitación"}
                      </button>
                    )}
                    {inviteError[a.id] && <p className="field-error">{inviteError[a.id]}</p>}
                  </td>
                  <td>
                    {editingId === a.id ? (
                      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
                        <div style={{ display: "flex", gap: "var(--space-1)" }}>
                          <button type="button" className="btn btn-primary btn-sm" onClick={() => saveEdit(a.id)} disabled={saving}>
                            {saving ? "…" : "Guardar"}
                          </button>
                          <button type="button" className="btn btn-secondary btn-sm" onClick={cancelEdit} disabled={saving}>
                            Cancelar
                          </button>
                        </div>
                        {editError && <p className="field-error">{editError}</p>}
                      </div>
                    ) : confirmingDeleteId === a.id ? (
                      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
                        <p className="field-hint" style={{ margin: 0 }}>¿Borrar &quot;{a.name}&quot;?</p>
                        <div style={{ display: "flex", gap: "var(--space-1)" }}>
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            style={{ color: "var(--negative)" }}
                            onClick={() => confirmDelete(a.id)}
                            disabled={deletingId === a.id}
                          >
                            {deletingId === a.id ? "Borrando…" : "Sí, borrar"}
                          </button>
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={() => setConfirmingDeleteId(null)}
                            disabled={deletingId === a.id}
                          >
                            Cancelar
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
                        <div style={{ display: "flex", gap: "var(--space-1)" }}>
                          <button type="button" className="btn btn-secondary btn-sm" onClick={() => startEdit(a)}>
                            Editar
                          </button>
                          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setConfirmingDeleteId(a.id)}>
                            Borrar
                          </button>
                        </div>
                        {deleteError[a.id] && <p className="field-error">{deleteError[a.id]}</p>}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
