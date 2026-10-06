import type { QueryExecutor } from "./client";
import type { TrialRequestInput, TrialStatus } from "@/lib/trial-request";

export interface TrialRequest extends TrialRequestInput {
  id: number;
  createdAt: string;
  status: TrialStatus;
}

interface TrialRequestRow {
  id: string | number;
  created_at: string | Date;
  name: string;
  email: string;
  store: string;
  monthly_sales: string | null;
  phone: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  referrer: string | null;
  status: TrialStatus;
}

/**
 * Sin RETURNING ni ON CONFLICT a propósito: RLS deja insertar a cualquiera
 * pero leer solo a un admin, y los dos necesitan permiso de lectura. Un
 * email repetido choca con el índice único sobre lower(email) y se toma
 * como éxito: la solicitud ya estaba.
 */
export async function insertTrialRequest(db: QueryExecutor, r: TrialRequestInput): Promise<void> {
  try {
    await db.query(
      `INSERT INTO trial_requests (name, email, store, monthly_sales, phone, utm_source, utm_medium, utm_campaign, utm_content, referrer)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [r.name, r.email, r.store, r.monthlySales, r.phone, r.utmSource, r.utmMedium, r.utmCampaign, r.utmContent, r.referrer]
    );
  } catch (err) {
    if ((err as { code?: string }).code === "23505") return;
    throw err;
  }
}

export async function listTrialRequests(db: QueryExecutor): Promise<TrialRequest[]> {
  const result = await db.query<TrialRequestRow>(`SELECT * FROM trial_requests ORDER BY created_at DESC LIMIT 500`);
  return result.rows.map((row) => ({
    id: Number(row.id),
    createdAt: new Date(row.created_at).toISOString(),
    name: row.name,
    email: row.email,
    store: row.store,
    monthlySales: row.monthly_sales,
    phone: row.phone,
    utmSource: row.utm_source,
    utmMedium: row.utm_medium,
    utmCampaign: row.utm_campaign,
    utmContent: row.utm_content,
    referrer: row.referrer,
    status: row.status,
  }));
}

export async function setTrialRequestStatus(db: QueryExecutor, id: number, status: TrialStatus): Promise<boolean> {
  const result = await db.query(`UPDATE trial_requests SET status = $1 WHERE id = $2 RETURNING id`, [status, id]);
  return result.rows.length > 0;
}
