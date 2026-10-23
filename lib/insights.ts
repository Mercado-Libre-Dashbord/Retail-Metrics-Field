/**
 * Conclusiones del período para el Resumen: pocas frases, cada una con su
 * número y la acción que corresponde. Todo sale de datos que la app ya tiene
 * guardados; nada se estima. Las frases se arman acá (puro, testeado) y la
 * consulta vive en /api/insights.
 */

export type InsightTone = "neg" | "pos" | "info";

export interface Insight {
  id: string;
  tone: InsightTone;
  /** Partes de la frase: los objetos con `strong` van en negrita. */
  parts: (string | { strong: string })[];
  action?: { label: string; href: string };
  /** Plata en juego, para ordenar (más alto primero). */
  weight: number;
}

export interface Breakdown {
  revenue: number;
  commission: number;
  shipping: number;
  cost: number;
  ads: number;
  taxes: number;
  /** Ganancia neta del período (ya con los ajustes de publicidad y cargos). */
  netProfit: number;
}

export interface InsightInput {
  current: Breakdown;
  previous: Breakdown | null;
  /** Productos con ventas en el período y ganancia negativa, del que más pierde al que menos. */
  losing: { title: string; units: number; profit: number }[];
  /** Productos que vendieron sin costo cargado. */
  missingCost: { products: number; units: number; revenue: number };
  /** Stock en Full sin ventas en los últimos 30 días. */
  idleFull: { products: number; units: number; capital: number; top: string | null };
  /** El producto que más ganancia dejó en el período. */
  best: { title: string; profit: number } | null;
}

const money = (n: number) => `$${Math.round(Math.abs(n)).toLocaleString("es-AR")}`;
const pct1 = (n: number) => `${(n * 100).toLocaleString("es-AR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
const pp = (n: number) => `${(n * 100).toLocaleString("es-AR", { maximumFractionDigits: 1 })} puntos`;

const COMPONENT_LABEL: Record<"commission" | "shipping" | "cost" | "ads" | "taxes", string> = {
  commission: "la comisión de Mercado Libre",
  shipping: "el envío",
  cost: "el costo de los productos",
  ads: "la publicidad",
  taxes: "los impuestos",
};

/** Margen que se mueve menos que esto (en puntos) no se menciona. */
const MARGIN_MOVE = 0.015;

export function buildInsights(d: InsightInput): Insight[] {
  const out: Insight[] = [];
  const { current: cur, previous: prev } = d;

  if (d.losing.length > 0) {
    const total = d.losing.reduce((s, p) => s + p.profit, 0);
    const units = d.losing.reduce((s, p) => s + p.units, 0);
    const worst = d.losing[0];
    out.push({
      id: "losing",
      tone: "neg",
      parts: [
        d.losing.length === 1 ? "1 producto vende a pérdida: " : `${d.losing.length} productos venden a pérdida: `,
        { strong: `−${money(total)}` },
        ` en ${units} ${units === 1 ? "unidad" : "unidades"}.`,
        d.losing.length > 1 ? ` El que más pierde es ${worst.title} (−${money(worst.profit)}).` : "",
      ],
      action: { label: "Ver productos", href: "/productos" },
      weight: Math.abs(total),
    });
  }

  if (prev && prev.revenue > 0 && cur.revenue > 0) {
    const mNow = cur.netProfit / cur.revenue;
    const mPrev = prev.netProfit / prev.revenue;
    const diff = mNow - mPrev;
    if (Math.abs(diff) >= MARGIN_MOVE) {
      // Qué costo cambió más como parte de la facturación: es la explicación.
      const keys = Object.keys(COMPONENT_LABEL) as (keyof typeof COMPONENT_LABEL)[];
      const moves = keys.map((k) => ({ k, delta: cur[k] / cur.revenue - prev[k] / prev.revenue }));
      const driver = diff < 0 ? moves.sort((a, b) => b.delta - a.delta)[0] : moves.sort((a, b) => a.delta - b.delta)[0];
      const explains = driver && (diff < 0 ? driver.delta > 0.005 : driver.delta < -0.005);
      out.push({
        id: "margin",
        tone: diff < 0 ? "neg" : "pos",
        parts: [
          `Tu margen ${diff < 0 ? "bajó" : "subió"} de ${pct1(mPrev)} a `,
          { strong: pct1(mNow) },
          " contra el período anterior",
          explains
            ? `, sobre todo por ${COMPONENT_LABEL[driver.k]} (${diff < 0 ? "+" : "−"}${pp(Math.abs(driver.delta))} de la facturación).`
            : ".",
        ],
        weight: Math.abs(diff) * cur.revenue,
      });
    }
  }

  if (d.missingCost.products > 0) {
    out.push({
      id: "missing-cost",
      tone: "info",
      parts: [
        `Faltan costos en ${d.missingCost.products} ${d.missingCost.products === 1 ? "producto" : "productos"} que vendieron `,
        { strong: money(d.missingCost.revenue) },
        ": esas ventas quedan fuera de la ganancia.",
      ],
      action: { label: "Cargar costos", href: "/productos" },
      // Una venta sin costo puede esconder una pérdida: pesa como el 20% de lo facturado.
      weight: d.missingCost.revenue * 0.2,
    });
  }

  if (d.idleFull.products > 0 && d.idleFull.capital > 0) {
    out.push({
      id: "idle-full",
      tone: "info",
      parts: [
        "Tenés ",
        { strong: money(d.idleFull.capital) },
        ` en stock en Full sin ventas hace 30 días (${d.idleFull.products} ${d.idleFull.products === 1 ? "producto" : "productos"}`,
        d.idleFull.top ? `, el mayor: ${d.idleFull.top}` : "",
        "). Full cobra el almacenamiento.",
      ],
      action: { label: "Ver Full", href: "/full" },
      weight: d.idleFull.capital * 0.1,
    });
  }

  if (d.best && d.best.profit > 0 && cur.netProfit > 0) {
    out.push({
      id: "best",
      tone: "pos",
      parts: [
        `${d.best.title} es el que más deja: `,
        { strong: money(d.best.profit) },
        `, ${Math.round((d.best.profit / Math.max(cur.netProfit, d.best.profit)) * 100)}% de tu ganancia.`,
      ],
      weight: 0,
    });
  }

  // Lo que necesita atención primero, después lo que está bien; cuatro como mucho.
  const rank = (i: Insight) => (i.tone === "neg" ? 0 : i.tone === "info" ? 1 : 2);
  return out.sort((a, b) => rank(a) - rank(b) || b.weight - a.weight).slice(0, 4);
}
