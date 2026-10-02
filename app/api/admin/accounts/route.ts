import { NextRequest, NextResponse } from "next/server";
import { withScope } from "@/db/client";
import { createAccount, listAccounts, updateAccountDetails, deleteAccount } from "@/db/accounts";
import { getCurrentUser, resolveCurrentAccount } from "@/lib/current-account";

export const runtime = "nodejs";

export async function GET() {
  const user = await getCurrentUser();
  if (!user?.isAdmin) return NextResponse.json({ error: "No autorizado" }, { status: 403 });

  const accounts = await withScope({ isAdmin: true, userEmail: user.email }, (client) => listAccounts(client));
  const current = await resolveCurrentAccount();
  return NextResponse.json({
    accounts: accounts.map((a) => ({ id: a.id, name: a.name, ownerEmail: a.ownerEmail, mlSellerId: a.mlSellerId })),
    currentAccountId: current?.id ?? null,
  });
}

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user?.isAdmin) return NextResponse.json({ error: "No autorizado" }, { status: 403 });

  const body = await request.json().catch(() => ({}));
  const { name, ownerEmail } = body as { name?: string; ownerEmail?: string };
  if (!name || !ownerEmail) {
    return NextResponse.json({ error: "name y ownerEmail son requeridos" }, { status: 400 });
  }

  try {
    const account = await withScope({ isAdmin: true, userEmail: user.email }, (client) =>
      createAccount(client, name, ownerEmail)
    );
    return NextResponse.json(account, { status: 201 });
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      return NextResponse.json({ error: "Ya existe una cuenta con ese email." }, { status: 409 });
    }
    throw err;
  }
}

export async function PATCH(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user?.isAdmin) return NextResponse.json({ error: "No autorizado" }, { status: 403 });

  const body = await request.json().catch(() => ({}));
  const { accountId, name, ownerEmail } = body as { accountId?: string; name?: string; ownerEmail?: string };
  if (!accountId) return NextResponse.json({ error: "accountId es requerido" }, { status: 400 });
  if (name === undefined && ownerEmail === undefined) {
    return NextResponse.json({ error: "Mandá name y/o ownerEmail para editar." }, { status: 400 });
  }
  if (name !== undefined && !name.trim()) {
    return NextResponse.json({ error: "El nombre no puede quedar vacío." }, { status: 400 });
  }
  if (ownerEmail !== undefined && !ownerEmail.trim()) {
    return NextResponse.json({ error: "El email no puede quedar vacío." }, { status: 400 });
  }

  try {
    const updated = await withScope({ isAdmin: true, userEmail: user.email }, (client) =>
      updateAccountDetails(client, accountId, { name, ownerEmail })
    );
    if (!updated) return NextResponse.json({ error: "No se encontró esa cuenta." }, { status: 404 });
    return NextResponse.json(updated);
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      return NextResponse.json({ error: "Ya existe una cuenta con ese email." }, { status: 409 });
    }
    throw err;
  }
}

export async function DELETE(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user?.isAdmin) return NextResponse.json({ error: "No autorizado" }, { status: 403 });

  const body = await request.json().catch(() => ({}));
  const { accountId } = body as { accountId?: string };
  if (!accountId) return NextResponse.json({ error: "accountId es requerido" }, { status: 400 });

  try {
    const deleted = await withScope({ isAdmin: true, userEmail: user.email }, (client) =>
      deleteAccount(client, accountId)
    );
    if (!deleted) return NextResponse.json({ error: "No se encontró esa cuenta." }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    // Foreign key: la cuenta tiene productos, órdenes u otro dato real
    // colgando — a propósito no se borra en cascada (ver migración 017).
    if ((err as { code?: string }).code === "23503") {
      return NextResponse.json(
        { error: "Esta cuenta tiene datos asociados (productos, órdenes, etc.) y no se puede borrar." },
        { status: 409 }
      );
    }
    throw err;
  }
}
