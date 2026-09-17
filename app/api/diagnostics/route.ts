import { NextResponse } from "next/server";
import { withScope } from "@/db/client";
import { missingMigrations } from "@/db/schema-capabilities";
import { getCurrentUser, resolveCurrentAccount } from "@/lib/current-account";
import { getAdvertiserId, probeAccountRestrictions, probeProductAdsGranularity } from "@/mcp/tools";

export const runtime = "nodejs";

/**
 * Estado real de los datos de una cuenta, para responder de una "¿por qué el
 * envío/IVA me da $0?" sin tener que leer logs ni adivinar. Solo admin: son
 * detalles de infraestructura, no algo que le sirva al vendedor.
 */
export async function GET() {
  const [account, user] = await Promise.all([resolveCurrentAccount(), getCurrentUser()]);
  if (!account) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  if (!user?.isAdmin) return NextResponse.json({ error: "Solo para administradores" }, { status: 403 });

  const data = await withScope({ accountId: account.id }, async (client) => {
    const pending = await missingMigrations(client);

    const health = await client.query<Record<string, string>>(
      `SELECT
         COUNT(*) as "orderItems",
         SUM(CASE WHEN shipping_cost = 0 THEN 1 ELSE 0 END) as "sinEnvio",
         SUM(CASE WHEN cost_applied IS NULL THEN 1 ELSE 0 END) as "sinCosto",
         SUM(CASE WHEN ml_commission = 0 THEN 1 ELSE 0 END) as "sinComision"
       FROM order_items WHERE account_id = $1`,
      [account.id]
    );

    const ivaCount = pending.some((m) => m.column === "iva_applied")
      ? null
      : Number(
          (
            await client.query<{ n: string }>(
              `SELECT COUNT(*) as n FROM order_items WHERE account_id = $1 AND iva_applied IS NOT NULL AND iva_applied <> 0`,
              [account.id]
            )
          ).rows[0].n
        );

    const billingCount = pending.some((m) => m.table === "billing_charges")
      ? null
      : Number(
          (
            await client.query<{ n: string }>(`SELECT COUNT(*) as n FROM billing_charges WHERE account_id = $1`, [
              account.id,
            ])
          ).rows[0].n
        );

    // Publicidad: cuánto llegó a sincronizarse y si ML reconoce un advertiser
    // de Product Ads para esta cuenta. Sin esto, "los números de ads no dan"
    // era imposible de diagnosticar sin acceso directo a la base de otro
    // cliente: ahora lo puede ver cualquier admin desde el panel.
    let advertiserFound: boolean | null = null;
    let advertiserError: string | null = null;
    if (account.mlSellerId) {
      try {
        advertiserFound = (await getAdvertiserId(account.id)) !== null;
      } catch (err) {
        advertiserError = (err as Error).message;
      }
    }
    // Sonda de solo lectura: ¿se puede pedir el gasto de Ads por día (con el
    // endpoint que ya usamos) y por publicación puntual (sin confirmar)?
    // Solo tiene sentido correrla si ML ya reconoció un advertiser — si no,
    // no hay ninguna campaña real contra la cual probar nada.
    const adsGranularity = advertiserFound
      ? await probeProductAdsGranularity(account.id).catch((err) => ({
          advertiserFound: true as const,
          error: (err as Error).message,
        }))
      : null;
    const adsResult = await client.query<{ n: string; total: string; min_date: string | null; max_date: string | null }>(
      `SELECT COUNT(*) as n, COALESCE(SUM(amount), 0) as total, MIN(date) as min_date, MAX(date) as max_date
         FROM ads_spend WHERE account_id = $1 AND channel = 'mercado_ads'`,
      [account.id]
    );
    const ads = adsResult.rows[0];

    // Full: cuántos productos tienen inventory_id (están en Full) y cuántos
    // ya tienen una foto de stock sincronizada, más una valorización
    // aproximada (cantidad × último costo cargado) — todavía sin confirmar
    // que los nombres de campo de ML sean los correctos.
    const fullPending = pending.some((m) =>
      ["inventory_id", "full_stock_qty", "full_stock_unavailable_qty"].includes(m.column)
    );
    const full = fullPending
      ? null
      : (
          await client.query<{ con_inventory: string; con_stock: string; capital: string }>(
            `SELECT
               COUNT(*) FILTER (WHERE inventory_id IS NOT NULL) as con_inventory,
               COUNT(*) FILTER (WHERE full_stock_qty IS NOT NULL) as con_stock,
               COALESCE(SUM((full_stock_qty + COALESCE(full_stock_unavailable_qty, 0)) * latest_cost.cost), 0) as capital
             FROM products p
             LEFT JOIN LATERAL (
               SELECT cost FROM product_costs pc
               WHERE pc.account_id = p.account_id AND pc.product_id = p.id
               ORDER BY valid_from DESC LIMIT 1
             ) latest_cost ON true
             WHERE p.account_id = $1`,
            [account.id]
          )
        ).rows[0];

    // Facturas vencidas: sonda de un endpoint sin confirmar (ver comentario
    // en probeAccountRestrictions). Nunca debería tirar abajo el resto del
    // diagnóstico si no existe o el token no tiene permiso.
    const restrictions = account.mlSellerId
      ? await probeAccountRestrictions(account.id, account.mlSellerId).catch((err) => ({
          ok: false as const,
          error: (err as Error).message,
        }))
      : null;

    const row = health.rows[0];
    return {
      account: { id: account.id, name: account.name, mlSellerId: account.mlSellerId },
      migracionesPendientes: pending.map((m) => ({ tabla: m.table, columna: m.column, sql: m.ddl })),
      datos: {
        lineasDeVenta: Number(row.orderItems ?? 0),
        conEnvioEnCero: Number(row.sinEnvio ?? 0),
        sinCostoCargado: Number(row.sinCosto ?? 0),
        conComisionEnCero: Number(row.sinComision ?? 0),
        conIvaCalculado: ivaCount,
        cargosDeFacturacion: billingCount,
        regimenFiscal: account.taxCondition,
        publicidad: {
          advertiserEncontrado: advertiserFound,
          errorAlBuscarAdvertiser: advertiserError,
          filasSincronizadas: Number(ads.n ?? 0),
          totalSincronizado: Number(ads.total ?? 0),
          desde: ads.min_date,
          hasta: ads.max_date,
          granularidadProbada: adsGranularity,
        },
        full: full && {
          productosConInventoryId: Number(full.con_inventory ?? 0),
          productosConStockSincronizado: Number(full.con_stock ?? 0),
          capitalAproximado: Number(full.capital ?? 0),
        },
        facturasVencidas: restrictions,
      },
      comoLeerlo: {
        regimenFiscal:
          "Si dice 'monotributo' o 'exento', el IVA no se calcula — es correcto, no un error.",
        publicidad:
          "Si advertiserEncontrado es false, ML dice que la cuenta nunca creó una campaña de Product Ads: no hay nada que sincronizar. Si es true y totalSincronizado es 0 (o 'desde'/'hasta' quedan muy viejos), la publicidad de los últimos ~90 días no se trajo — Mercado Ads solo sirve métricas de ese rango. Apretá 'Sincronizar' de nuevo para reintentarlo.",
        granularidadProbada:
          "dailyWindowTest: si differ=true, costA y costB son distintos de verdad — confirma que se puede pedir el gasto por día achicando la ventana de fecha, sin ningún endpoint nuevo. itemLevelAttempts: tres rutas SIN CONFIRMAR para costo por publicación puntual — status 404 en las tres es la señal más fuerte de que esa ruta no existe tal cual; cualquier otra cosa (ok:true, o un status distinto) es una pista real para investigar más. Mandá el bloque completo, no solo el resumen.",
        conEnvioEnCero:
          "Si es igual a lineasDeVenta, ninguna orden tiene el envío traído de la API. Apretá 'Sincronizar' en Resumen: recorre toda la historia y repara las órdenes que quedaron en una versión vieja del cálculo.",
        conIvaCalculado:
          "null = falta correr db/postgres/migrations/002-iva-y-facturacion.sql. 0 = la migración está pero todavía no recalculaste el historial.",
        cargosDeFacturacion:
          "null = falta la tabla billing_charges (misma migración). 0 = la API de facturación no devolvió cargos (permisos, o el período todavía no cerró).",
        full:
          "productosConInventoryId es cuántas publicaciones están en Full (según shipping.logistic_type, sin confirmar el nombre del campo todavía). Si es 0 con productos en Full de verdad, avisa acá para revisar el nombre real.",
        facturasVencidas:
          "Sonda de /users/{id}/restrictions, sin confirmar contra la documentación oficial. 'ok: false' probablemente signifique que el endpoint no existe o no aplica — no asumas que la cuenta no tiene deuda solo por eso. Mandá el resultado completo para decidir si vale la pena construir algo sobre esto.",
      },
    };
  });

  return NextResponse.json(data);
}
