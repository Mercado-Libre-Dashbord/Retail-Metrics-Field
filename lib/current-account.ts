import { cookies } from "next/headers";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth-options";
import { withScope } from "@/db/client";
import { getAccountByOwnerEmail, listAccounts, type Account } from "@/db/accounts";

export const CURRENT_ACCOUNT_COOKIE = "current_account_id";

export interface CurrentUser {
  email: string;
  isAdmin: boolean;
}

export async function getCurrentUser(): Promise<CurrentUser | null> {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email;
  if (!email) return null;
  // Normalized once here so every downstream use — the RLS session variable
  // in withScope, db/accounts.ts lookups, admin route checks — compares the
  // same casing. Google's email claim isn't guaranteed lowercase; a mismatch
  // here would make RLS wrongly hide a real owner's own account.
  return { email: email.trim().toLowerCase(), isAdmin: session?.user?.isAdmin === true };
}

/**
 * Resolves which account the current request should operate on.
 * Clients (non-admins) always see their own account, looked up by owner
 * email — never trust the cookie for them. Admins can browse any account,
 * picked via the `current_account_id` cookie set by the account switcher.
 *
 * Runs inside a Postgres session scoped to this user's isAdmin/email (via
 * withScope) so the RLS policy on `accounts` — not just this function's own
 * logic — is what actually decides which account rows are visible.
 */
export async function resolveCurrentAccount(): Promise<Account | null> {
  const user = await getCurrentUser();
  if (!user) return null;

  return withScope({ isAdmin: user.isAdmin, userEmail: user.email }, async (client) => {
    if (!user.isAdmin) {
      return getAccountByOwnerEmail(client, user.email);
    }

    const accounts = await listAccounts(client);
    if (accounts.length === 0) return null;
    const selectedId = (await cookies()).get(CURRENT_ACCOUNT_COOKIE)?.value;
    const selected = selectedId ? accounts.find((a) => a.id === selectedId) : undefined;
    return selected ?? accounts[0];
  });
}
