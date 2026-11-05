import { NextRequest, NextResponse, after } from "next/server";
import { withScope } from "@/db/client";
import { refreshCompetition, competitionAvailable } from "@/sync/competition";

export const runtime = "nodejs";

/**
 * Notificaciones de Mercado Libre. ML espera un 200 rápido o reintenta, así
 * que se responde enseguida y el trabajo se hace después (`after`).
 *
 * Hoy se procesa una sola cosa: los avisos de competencia de catálogo (tópico
 * "catalog_item_competition_status", hay que activarlo en la configuración de
 * la app en developers.mercadolibre.com). Cuando cambia quién gana una
 * publicación nuestra, se actualiza su foto de competencia al instante, en
 * vez de esperar a que alguien abra la pantalla. El resto de los tópicos se
 * sigue resolviendo por Sincronizar.
 */
const COMPETITION_TOPIC = /competition|price_to_win/i;

export async function POST(request: NextRequest) {
  let body: { topic?: string; resource?: string; user_id?: number | string } | null = null;
  try {
    body = await request.json();
  } catch {
    // Sin JSON válido no hay nada que hacer; igual respondemos 200.
  }

  const topic = String(body?.topic ?? "");
  const itemId = String(body?.resource ?? "").match(/M[A-Z]{2}\d+/)?.[0];
  const sellerId = body?.user_id != null ? String(body.user_id) : null;

  if (COMPETITION_TOPIC.test(topic) && itemId && sellerId) {
    after(async () => {
      try {
        const accountId = await withScope({}, async (client) => {
          if (!(await competitionAvailable(client))) return null;
          const r = await client.query<{ id: string | null }>(`SELECT account_id_for_seller($1) AS id`, [sellerId]);
          return r.rows[0]?.id ?? null;
        });
        if (!accountId) return;
        await withScope({ accountId }, (client) =>
          refreshCompetition(client, accountId, { productIds: [itemId], force: true, timeBudgetMs: 20_000 })
        );
      } catch (err) {
        console.warn("Webhook de competencia: no se pudo actualizar", itemId, (err as Error).message);
      }
    });
  }
  return NextResponse.json({ ok: true });
}
