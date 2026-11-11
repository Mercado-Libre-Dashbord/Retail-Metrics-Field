import { NextRequest, NextResponse } from "next/server";
import { withScope } from "@/db/client";
import { hasColumn } from "@/db/schema-capabilities";
import { resolveCurrentAccount } from "@/lib/current-account";
import { revenueStatusFilter } from "@/lib/order-status";
import { classifyCharge, classifyFullChargeDetail, FULL_CHARGE_DETAIL_LABEL, type FullChargeDetail } from "@/sync/billing";
import { CHARGE_DATE_SQL } from "@/sync/period-charges";

export const runtime = "nodejs";

/**
 * Umbral de "stock antiguo" citado por fuentes externas al investigar esto
 * (no es un dato oficial confirmado de Mercado Libre): ronda los 120 días
 * para la mayoría de las categorías, con recargos que después escalan.
 * Se muestra como referencia aproximada en la pantalla, nunca como un
 * número exacto — puede variar según categoría y Mercado Libre puede
 * cambiarlo sin aviso.
 */
const OLD_STOCK_DAYS_THRESHOLD = 120;

/**
 * Ventana para estimar la velocidad de venta reciente y de ahí la rotación y
 * la previsión de agotamiento. Corta a propósito: un producto que cambió de
 * ritmo hace poco tiene que reflejarlo ya, no diluirse en un promedio de
 * todo el histórico.
 */
const SALES_VELOCITY_DAYS = 30;

interface ProductRow {
  id: string;
  title: string;
  thumbnail: string | null;
  fullStockQty: number | null;
  fullStockUnavailableQty: number | null;
  fullSince: string | null;
  currentCost: number | null;
  lowStockThreshold: number | null;
  /** Qué depósito físico usa: dos publicaciones con la misma clave comparten stock. */
  inventoryKey: string | null;
}

export async function GET(request: NextRequest) {
  const account = await resolveCurrentAccount();
  if (!account) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const { searchParams } = request.nextUrl;
  const from = searchParams.get("from") ?? "1970-01-01";
  const to = searchParams.get("to") ?? "9999-12-31";

  const data = await withScope({ accountId: account.id }, async (client) => {
    // Sin la migración de Full (013), no hay nada que mostrar acá — se
    // avisa en vez de romper la pantalla con columnas que no existen.
    if (!(await hasColumn(client, "products", "full_stock_qty"))) {
      return { available: false as const };
    }
    const hasFullSince = await hasColumn(client, "products", "full_since");
    const hasLowStock = await hasColumn(client, "products", "low_stock_threshold");
    const hasThumbnail = await hasColumn(client, "products", "thumbnail");
    const inventoryKey = (await hasColumn(client, "products", "inventory_ids"))
      ? `CASE WHEN COALESCE(array_length(p.inventory_ids, 1), 0) > 0
              THEN array_to_string(ARRAY(SELECT unnest(p.inventory_ids) ORDER BY 1), ',')
              ELSE p.inventory_id END`
      : "p.inventory_id";

    const productsResult = await client.query(
      `SELECT p.id, p.title,
              ${hasThumbnail ? "p.thumbnail" : "NULL::text"} as thumbnail,
              p.full_stock_qty as "fullStockQty",
              p.full_stock_unavailable_qty as "fullStockUnavailableQty",
              ${hasFullSince ? "p.full_since" : "NULL::timestamptz"} as "fullSince",
              ${hasLowStock ? "p.low_stock_threshold" : "NULL::integer"} as "lowStockThreshold",
              ${inventoryKey} as "inventoryKey",
              (SELECT cost FROM product_costs pc WHERE pc.account_id = p.account_id AND pc.product_id = p.id ORDER BY pc.valid_from DESC LIMIT 1) as "currentCost"
       FROM products p
       WHERE p.account_id = $1 AND p.logistic_type = 'fulfillment'
       ORDER BY p.title`,
      [account.id]
    );

    // Velocidad de venta reciente, para rotación y previsión de agotamiento.
    const salesResult = await client.query<{ product_id: string; units: string }>(
      `SELECT oi.product_id, COALESCE(SUM(oi.quantity), 0) as units
       FROM order_items oi JOIN orders o ON o.account_id = oi.account_id AND o.id = oi.order_id
       WHERE oi.account_id = $1 AND o.date_created >= now() - interval '${SALES_VELOCITY_DAYS} days'
         AND ${revenueStatusFilter()}
       GROUP BY oi.product_id`,
      [account.id]
    );
    const unitsSoldByProduct = new Map(salesResult.rows.map((r) => [r.product_id, Number(r.units)]));

    const now = Date.now();
    const products = (productsResult.rows as ProductRow[]).map((p) => {
      const availableQty = p.fullStockQty ?? 0;
      const unavailableQty = p.fullStockUnavailableQty ?? 0;
      // Capital inmovilizado: TODO lo guardado físicamente, disponible o no
      // (dañado, en revisión) — esa plata sigue inmovilizada igual.
      const fullStockValue = p.currentCost !== null ? (availableQty + unavailableQty) * p.currentCost : null;
      const daysInFull = p.fullSince ? Math.floor((now - new Date(p.fullSince).getTime()) / 86400000) : null;
      const oldStockRisk = daysInFull !== null && daysInFull >= OLD_STOCK_DAYS_THRESHOLD;

      const unitsSoldRecent = unitsSoldByProduct.get(p.id) ?? 0;
      const avgDailySales = unitsSoldRecent / SALES_VELOCITY_DAYS;
      // "Tiempo medio de rotación": cada cuántos días se vendió (en
      // promedio) una unidad en la ventana reciente.
      const rotationDays = avgDailySales > 0 ? 1 / avgDailySales : null;
      // Previsión de agotamiento: a este ritmo, cuántos días de stock
      // disponible quedan. Usa lo DISPONIBLE, no lo dañado/en revisión —
      // importa lo que se puede vender, no lo que está guardado sin poder
      // despacharse.
      const daysUntilStockout = avgDailySales > 0 ? availableQty / avgDailySales : null;

      return {
        inventoryKey: p.inventoryKey ?? null,
        id: p.id,
        title: p.title,
        thumbnail: p.thumbnail,
        availableQty,
        unavailableQty,
        fullStockValue,
        daysInFull,
        oldStockRisk,
        lowStockThreshold: p.lowStockThreshold,
        lowStock: p.lowStockThreshold !== null && availableQty <= p.lowStockThreshold,
        unitsSoldRecent,
        rotationDays,
        daysUntilStockout,
      };
    });

    // Costos de Full del período pedido: mismo bucket "full" de la
    // conciliación general (Resumen), sub-clasificado acá para separar
    // almacenamiento, stock antiguo, retiro y envío a Full.
    const costsAvailable = await hasColumn(client, "billing_charges", "detail_id");
    let costs: { detail: FullChargeDetail; label: string; amount: number }[] = [];
    if (costsAvailable) {
      const chargesResult = await client.query<{ concept: string | null; detailType: string | null; detailSubType: string | null; amount: number }>(
        `SELECT concept, detail_type as "detailType", detail_sub_type as "detailSubType", amount
         FROM billing_charges
         WHERE account_id = $1 AND ${CHARGE_DATE_SQL} BETWEEN $2::date AND $3::date`,
        [account.id, from, to]
      );
      const totals = new Map<FullChargeDetail, number>();
      for (const row of chargesResult.rows) {
        if (classifyCharge(row.concept, row.detailType, row.detailSubType) !== "full") continue;
        const detail = classifyFullChargeDetail(row.concept, row.detailType, row.detailSubType);
        totals.set(detail, (totals.get(detail) ?? 0) + Number(row.amount));
      }
      costs = [...totals.entries()]
        .map(([detail, amount]) => ({ detail, label: FULL_CHARGE_DETAIL_LABEL[detail], amount }))
        .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
    }

    // Dos publicaciones del mismo producto (clásica y premium, por ejemplo)
    // comparten el mismo stock físico en Full: Mercado Libre informa esas
    // unidades en las dos. En la tabla cada una muestra su stock, pero en los
    // totales se cuentan una sola vez — si no, las unidades y el capital
    // inmovilizado salían duplicados.
    const seenInventories = new Set<string>();
    let totalUnits = 0;
    let totalCapital = 0;
    // Primero las que tienen costo, así el depósito compartido se valoriza
    // aunque una de sus publicaciones no lo tenga cargado.
    for (const p of [...products].sort((a, b) => Number(b.fullStockValue !== null) - Number(a.fullStockValue !== null))) {
      if (p.inventoryKey) {
        if (seenInventories.has(p.inventoryKey)) continue;
        seenInventories.add(p.inventoryKey);
      }
      totalUnits += p.availableQty + p.unavailableQty;
      totalCapital += p.fullStockValue ?? 0;
    }

    return {
      available: true as const,
      oldStockDaysThreshold: OLD_STOCK_DAYS_THRESHOLD,
      salesVelocityDays: SALES_VELOCITY_DAYS,
      products: products.map(({ inventoryKey: _inventoryKey, ...p }) => p),
      totals: {
        capital: totalCapital,
        productos: products.length,
        unidades: totalUnits,
        conStockBajo: products.filter((p) => p.lowStock).length,
      },
      costs,
      costsAvailable,
    };
  });

  return NextResponse.json(data);
}
