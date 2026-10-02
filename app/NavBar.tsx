"use client";

import { useEffect, useState, type JSX } from "react";
import { usePathname } from "next/navigation";
import { useSession, signOut } from "next-auth/react";

interface AccountOption {
  id: string;
  name: string;
}

const NAV_ITEMS = [
  { href: "/", label: "Resumen", icon: "grid" },
  { href: "/productos", label: "Productos", icon: "box" },
  { href: "/full", label: "Full", icon: "warehouse" },
  { href: "/consultas", label: "Consultas", icon: "question" },
  { href: "/campanas", label: "Campañas", icon: "megaphone" },
  { href: "/tendencias", label: "Tendencias", icon: "trend" },
  { href: "/loyalty", label: "Fidelización", icon: "loyalty" },
  { href: "/configuracion", label: "Configuración", icon: "settings" },
] as const;

function NavIcon({ name }: { name: string }) {
  const paths: Record<string, JSX.Element> = {
    grid: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="3" width="7" height="7" rx="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" />
        <rect x="14" y="14" width="7" height="7" rx="1.5" />
      </>
    ),
    box: <path d="M3 7.5L12 3l9 4.5-9 4.5-9-4.5zM3 7.5v9L12 21m0-9v9m9-13.5v9L12 21" />,
    trend: <path d="M3 17l6-6 4 4 8-8M15 7h6v6" />,
    megaphone: (
      <>
        <path d="M3 11v2a2 2 0 0 0 2 2h1l1 5h2l-1-5h2l8 4V6l-8 4H5a2 2 0 0 0-2 2z" />
        <path d="M18 9.5a3.5 3.5 0 0 1 0 5" />
      </>
    ),
    question: (
      <>
        <circle cx="12" cy="12" r="9.2" />
        <path d="M9.2 9.3a2.8 2.8 0 1 1 4.2 2.4c-.9.6-1.4 1.1-1.4 2.1" />
        <circle cx="12" cy="17.2" r="0.1" fill="currentColor" />
      </>
    ),
    loyalty: (
      <>
        <path d="M12 21s-7.5-4.7-9.4-9.2A5.2 5.2 0 0 1 12 6.6a5.2 5.2 0 0 1 9.4 5.2C19.5 16.3 12 21 12 21z" />
      </>
    ),
    settings: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </>
    ),
    users: (
      <>
        <circle cx="9" cy="8" r="3.2" />
        <path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6M16 8.2A3.2 3.2 0 1 1 16 14.6M21.5 20c0-3-2-5.2-4.8-5.8" />
      </>
    ),
    warehouse: (
      <>
        <path d="M3 21V10L12 4l9 6v11" />
        <path d="M3 21h18" />
        <rect x="8" y="13" width="8" height="8" rx="0.5" />
      </>
    ),
  };
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

/**
 * Marca del sidebar. Prueba varios nombres de archivo dentro de public/ y recién
 * después cae en el monograma original. Así el logo funciona sin importar con qué
 * extensión se haya subido, y la app nunca muestra una imagen rota mientras el
 * archivo no exista.
 */
const LOGO_CANDIDATES = ["/logo.png", "/logo.svg", "/logo.webp", "/logo.jpg"] as const;

function BrandMark() {
  const [attempt, setAttempt] = useState(0);

  if (attempt >= LOGO_CANDIDATES.length) {
    return (
      <span className="sidebar-mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none">
          <path d="M4 17L9 8L13 14L16 9L20 17" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    );
  }

  const src = LOGO_CANDIDATES[attempt];
  return (
    <img
      key={src}
      className="sidebar-logo"
      src={src}
      alt="MetricsField"
      onError={() => setAttempt((n) => n + 1)}
    />
  );
}

export function NavBar() {
  const { data: session, status } = useSession();
  const pathname = usePathname();
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [currentAccountId, setCurrentAccountId] = useState("");

  const isAdmin = session?.user?.isAdmin === true;

  useEffect(() => {
    if (!isAdmin) return;
    fetch("/api/admin/accounts")
      .then((r) => r.json())
      .then((data: { accounts: AccountOption[]; currentAccountId: string | null }) => {
        setAccounts(data.accounts);
        setCurrentAccountId(data.currentAccountId ?? "");
      });
  }, [isAdmin]);

  if (status !== "authenticated") return null;

  async function switchAccount(accountId: string) {
    setCurrentAccountId(accountId);
    await fetch("/api/admin/select-account", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId }),
    });
    window.location.href = "/";
  }

  return (
    <nav className="sidebar" aria-label="Navegación principal">
      <div className="sidebar-brand">
        <BrandMark />
        <span className="sidebar-brand-text">Rentabilidad ML</span>
      </div>

      {isAdmin && accounts.length > 0 && (
        <div className="sidebar-account">
          <label>
            <span className="sidebar-account-label">Cuenta activa</span>
            <select value={currentAccountId} onChange={(e) => switchAccount(e.target.value)}>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      <div className="sidebar-links">
        {NAV_ITEMS.map((item) => (
          <a
            key={item.href}
            href={item.href}
            className={`sidebar-link${pathname === item.href ? " active" : ""}`}
            aria-current={pathname === item.href ? "page" : undefined}
          >
            <NavIcon name={item.icon} />
            <span>{item.label}</span>
          </a>
        ))}
        {isAdmin && (
          <a
            href="/admin"
            className={`sidebar-link${pathname === "/admin" ? " active" : ""}`}
            aria-current={pathname === "/admin" ? "page" : undefined}
          >
            <NavIcon name="users" />
            <span>Cuentas</span>
          </a>
        )}
      </div>

      <div className="sidebar-spacer" />

      <div className="sidebar-user">
        <span className="sidebar-user-email">{session?.user?.email}</span>
        <button className="btn btn-secondary btn-sm" onClick={() => signOut({ callbackUrl: "/login" })}>
          Salir
        </button>
      </div>
    </nav>
  );
}
