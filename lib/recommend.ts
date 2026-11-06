/**
 * Una recomendación concreta por publicación: qué hacer con el precio, a
 * cuánto, y qué cambia en la plata. Junta en un solo veredicto:
 * - el margen real (piso y sugerido, ver lib/pricing.ts),
 * - la competencia de catálogo (precio para ganar, quién gana y por qué),
 * - el precio de cada competidor del catálogo (para ver si hay lugar para
 *   subir sin perder el primer puesto),
 * - la referencia de precios de Mercado Libre (sugerido y más bajo entre
 *   publicaciones similares), que existe también fuera de catálogo.
 *
 * Nunca recomienda un precio por debajo del piso.
 */
import { marginAt, roundUpTo10, type PricingRates } from "./pricing";

export type Action =
  | "cargar_costo"
  | "subir_pierde"
  | "bajar_para_ganar"
  | "no_bajes"
  | "mejorar_condiciones"
  | "subir_sin_perder"
  | "subir_al_objetivo"
  | "revisar_costos"
  | "mas_caro_que_mercado"
  | "ok";

/** 1 = urgente (pierde plata) · 2 = oportunidad · 3 = para revisar · 4 = opcional · 5 = está bien. */
export const ACTION_PRIORITY: Record<Action, number> = {
  subir_pierde: 1,
  bajar_para_ganar: 2,
  subir_sin_perder: 2,
  subir_al_objetivo: 2,
  no_bajes: 3,
  mejorar_condiciones: 3,
  revisar_costos: 3,
  cargar_costo: 3,
  mas_caro_que_mercado: 4,
  ok: 5,
};

export interface RecommendInput {
  price: number;
  cost: number | null;
  rates: PricingRates;
  floorPrice: number | null;
  suggestedPrice: number | null;
  unitProfit: number | null;
  margin: number | null;
  /** Unidades vendidas en el período de referencia y su largo en días. */
  unitsSold: number;
  days: number;
  target: number;
  includeAds?: boolean;
  catalog?: {
    /** winning / sharing_first_place / competing / listed */
    status: string;
    priceToWin: number | null;
    winnerPrice: number | null;
    /** Lo que ML dice que te falta (envío, Full, cuotas, reputación…), ya traducido. */
    missing: string[];
    /** Precios de los OTROS vendedores del catálogo. */
    competitorPrices: number[];
  } | null;
  reference?: {
    suggestedPrice: number | null;
    lowestPrice: number | null;
  } | null;
}

export interface Recommendation {
  action: Action;
  priority: number;
  /** Una frase con lo que hay que hacer. */
  headline: string;
  /** El porqué, con números. */
  detail: string;
  /** Precio al que se recomienda ir (null si no hay que tocar el precio). */
  targetPrice: number | null;
  /** Texto del botón, si hay un precio para aplicar. */
  buttonLabel: string | null;
  /** true si el precio del botón es una salida posible pero no la recomendación principal. */
  weak?: boolean;
  /** Ganancia por unidad hoy y al precio recomendado. */
  profitNow: number | null;
  profitAtTarget: number | null;
  marginAtTarget: number | null;
  /** Ganancia por mes hoy y con el cambio, si se vendiera lo mismo (estimado). */
  monthlyNow: number | null;
  monthlyAtTarget: number | null;
}

const fmt = (n: number) => n.toLocaleString("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 });
const pct = (n: number) => `${(n * 100).toLocaleString("es-AR", { maximumFractionDigits: 1 })}%`;
const roundDownTo10 = (n: number) => Math.floor(n / 10) * 10;

export function recommend(input: RecommendInput): Recommendation {
  const { price, cost, rates, floorPrice, suggestedPrice, unitProfit, margin, target } = input;
  const includeAds = input.includeAds ?? true;
  const perMonth = input.days > 0 ? (input.unitsSold / input.days) * 30 : 0;
  const profitAt = (p: number) => (cost === null ? null : (marginAt(p, cost, rates, includeAds) ?? 0) * p);
  const marginOf = (p: number) => (cost === null ? null : marginAt(p, cost, rates, includeAds));
  const monthly = (u: number | null) => (u === null || perMonth === 0 ? null : u * perMonth);

  const base = {
    profitNow: unitProfit,
    monthlyNow: monthly(unitProfit),
  };
  const build = (action: Action, headline: string, detail: string, targetPrice: number | null, buttonLabel: string | null): Recommendation => {
    const pAt = targetPrice === null ? null : profitAt(targetPrice);
    return {
      action,
      priority: ACTION_PRIORITY[action],
      headline,
      detail,
      targetPrice,
      buttonLabel,
      ...base,
      profitAtTarget: pAt,
      marginAtTarget: targetPrice === null ? null : marginOf(targetPrice),
      monthlyAtTarget: monthly(pAt),
    };
  };

  if (cost === null || floorPrice === null || suggestedPrice === null || unitProfit === null || margin === null) {
    return build(
      "cargar_costo",
      "Cargá el costo para saber si este precio te conviene",
      "Sin el costo no se puede calcular cuánto te deja cada venta ni hasta dónde podés bajar.",
      null,
      null
    );
  }

  const cat = input.catalog ?? null;
  const ref = input.reference ?? null;
  const winning = cat !== null && (cat.status === "winning" || cat.status === "sharing_first_place");
  const losingByPrice = cat !== null && !winning && cat.priceToWin !== null && price > cat.priceToWin + 0.5;
  const refNote =
    ref?.lowestPrice != null
      ? ` El más barato entre publicaciones similares está a ${fmt(ref.lowestPrice)}.`
      : ref?.suggestedPrice != null
        ? ` Mercado Libre sugiere ${fmt(ref.suggestedPrice)}.`
        : "";

  // 1. Vende a pérdida: lo primero es dejar de perder. El precio de mercado
  // (lo que gana el catálogo, o lo que sugiere ML) pone un techo: subir muy por
  // encima de eso no sirve si después no se vende.
  if (price < floorPrice) {
    const market = cat?.winnerPrice ?? ref?.suggestedPrice ?? null;
    const cantWin = losingByPrice && cat!.priceToWin! < floorPrice;
    if (market === null || suggestedPrice <= market * 1.05) {
      return build(
        "subir_pierde",
        `Perdés ${fmt(-unitProfit)} por venta: subí a ${fmt(suggestedPrice)}`,
        `A ${fmt(price)} no cubrís costo, comisión, envío e impuestos (tu piso es ${fmt(floorPrice)}). A ${fmt(suggestedPrice)} te queda tu ${pct(target)}` +
          (market !== null ? `, y sigue cerca del precio de mercado (${fmt(market)}).` : ".") + refNote,
        suggestedPrice,
        `Subir a ${fmt(suggestedPrice)}`
      );
    }
    if (market >= floorPrice) {
      const to = Math.max(roundDownTo10(market), roundUpTo10(floorPrice));
      return build(
        "subir_pierde",
        `Perdés ${fmt(-unitProfit)} por venta: subí a ${fmt(to)} y dejás de perder`,
        `Tu piso es ${fmt(floorPrice)} y el mercado está en ${fmt(market)}. A ${fmt(to)} dejás de perder sin quedar más caro que el mercado;` +
          ` tu ${pct(target)} pediría ${fmt(suggestedPrice)}, muy arriba del mercado.`,
        to,
        `Subir a ${fmt(to)}`
      );
    }
    const to = roundUpTo10(floorPrice);
    return {
      ...build(
      "subir_pierde",
      `Perdés ${fmt(-unitProfit)} por venta y el mercado no te deja ganar: revisá el costo`,
      `Para no perder necesitás ${fmt(to)}, pero el mercado está en ${fmt(market)}` +
        (cantWin ? ` (para ganar el catálogo habría que vender a ${fmt(cat!.priceToWin!)})` : "") +
        `. Revisá el costo con tu proveedor, bajá la publicidad de este producto o subí a ${fmt(to)} sabiendo que vas a vender menos.`,
      to,
      `Subir a ${fmt(to)}`
      ),
      weak: true,
    };
  }

  // 2. Catálogo: pierde por precio.
  if (losingByPrice) {
    const win = Math.round(cat!.priceToWin!);
    const mWin = marginOf(win)!;
    const pWin = profitAt(win)!;
    if (win < floorPrice) {
      return build(
        "no_bajes",
        `No bajes: para ganar el catálogo tendrías que vender a ${fmt(win)} y perderías ${fmt(-pWin)} por venta`,
        `Tu piso es ${fmt(floorPrice)}.` + (cat!.missing.length ? ` Lo que podés mejorar en vez del precio: ${cat!.missing.join(", ")}.` : ""),
        null,
        null
      );
    }
    const enough = mWin >= target - 0.005;
    return build(
      "bajar_para_ganar",
      `Bajá ${fmt(price - win)} (a ${fmt(win)}) y ganás el catálogo`,
      `Te sigue dejando ${pct(mWin)}, ${fmt(pWin)} por venta (hoy ${fmt(unitProfit)}).` +
        (enough ? "" : ` Es menos que tu objetivo de ${pct(target)}: conviene si ganar el catálogo te trae más ventas.`) +
        (cat!.missing.length ? ` Además te falta: ${cat!.missing.join(", ")}.` : ""),
      win,
      `Bajar a ${fmt(win)}`
    );
  }

  // 3. Catálogo: pierde, pero no por precio.
  if (cat !== null && !winning && cat.status !== "listed") {
    return build(
      "mejorar_condiciones",
      cat.missing.length ? `Te ganan por ${cat.missing.join(", ")}, no por precio` : "Perdés el catálogo pero no por precio",
      `Ya estás en el precio para ganar o por debajo. Bajar más no te hace ganar: mejorá ${cat.missing.length ? cat.missing.join(", ") : "las condiciones de la publicación"}.`,
      null,
      null
    );
  }

  // 4. Catálogo: gana. ¿Hay lugar para subir y seguir primero?
  if (winning && cat!.competitorPrices.length > 0) {
    const next = Math.min(...cat!.competitorPrices.filter((p) => p > price + 0.5), Infinity);
    if (Number.isFinite(next) && next - price >= Math.max(price * 0.01, 50)) {
      const to = roundDownTo10(next - 10);
      if (to > price) {
        return build(
          "subir_sin_perder",
          `Ganás el catálogo y el siguiente está a ${fmt(next)}: podés subir a ${fmt(to)}`,
          `Seguirías siendo el más barato y ganarías ${fmt(profitAt(to)! - unitProfit)} más por venta. Mercado Libre también mira envío y reputación: si después de subir dejás de ganar, volvé.`,
          to,
          `Subir a ${fmt(to)}`
        );
      }
    }
  }

  // 5. No llega al margen objetivo (fuera de catálogo, o ganando sin datos de los demás).
  if (margin < target - 0.005) {
    const marketCeiling = ref?.suggestedPrice ?? null;
    if (marketCeiling !== null && marketCeiling < suggestedPrice) {
      return build(
        "revisar_costos",
        `Te deja ${pct(margin)}, menos que tu objetivo, y subir te deja más caro que el mercado`,
        `Para tu ${pct(target)} tendrías que cobrar ${fmt(suggestedPrice)}, pero Mercado Libre sugiere ${fmt(marketCeiling)}.` +
          ` Revisá el costo, la publicidad o el envío de este producto.` + (ref?.lowestPrice != null ? ` El más barato similar está a ${fmt(ref.lowestPrice)}.` : ""),
        null,
        null
      );
    }
    if (winning) {
      // Ganando y sin datos de los demás: no se recomienda subir a ciegas.
      return build(
        "revisar_costos",
        `Ganás el catálogo pero te deja ${pct(margin)}, menos que tu objetivo`,
        `Para tu ${pct(target)} tendrías que cobrar ${fmt(suggestedPrice)}; subir así puede hacerte perder el primer puesto.`,
        null,
        null
      );
    }
    return build(
      "subir_al_objetivo",
      `Subí a ${fmt(suggestedPrice)} para llegar a tu ${pct(target)}`,
      `Hoy te deja ${pct(margin)} (${fmt(unitProfit)} por venta).` +
        (marketCeiling !== null ? ` Mercado Libre sugiere ${fmt(marketCeiling)}: el precio entra en el mercado.` : " Sin referencia de Mercado Libre para comparar: mirá cómo responden las ventas."),
      suggestedPrice,
      `Subir a ${fmt(suggestedPrice)}`
    );
  }

  // 6. Fuera de catálogo, con margen de sobra pero más caro que la referencia.
  if (!cat && ref?.suggestedPrice != null && ref.suggestedPrice < price * 0.97) {
    const to = Math.max(roundUpTo10(ref.suggestedPrice), roundUpTo10(floorPrice));
    const m = marginOf(to)!;
    if (m >= target - 0.005) {
      return build(
        "mas_caro_que_mercado",
        `Estás ${pct(price / ref.suggestedPrice - 1)} arriba del precio que sugiere Mercado Libre`,
        `Si bajás a ${fmt(to)} te sigue dejando ${pct(m)} (${fmt(profitAt(to)!)} por venta). Conviene si querés vender más unidades.`,
        to,
        `Bajar a ${fmt(to)}`
      );
    }
  }

  return build(
    "ok",
    winning ? `Ganás el catálogo y te deja ${pct(margin)}` : `Te deja ${pct(margin)}: está bien`,
    `${fmt(unitProfit)} por venta.` + (ref?.suggestedPrice != null ? ` Mercado Libre sugiere ${fmt(ref.suggestedPrice)}.` : ""),
    null,
    null
  );
}
