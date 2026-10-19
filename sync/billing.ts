export type ChargeBucket = "comision" | "envio" | "impuesto" | "publicidad" | "full" | "otro";

export const BUCKET_LABEL: Record<ChargeBucket, string> = {
  comision: "Comisiones de venta",
  envio: "Envíos",
  impuesto: "Impuestos y percepciones",
  publicidad: "Publicidad",
  full: "Mercado Envíos Full (almacenamiento y retiros)",
  otro: "Otros cargos",
};

export const CHARGE_BUCKETS = Object.keys(BUCKET_LABEL) as ChargeBucket[];

export function isChargeBucket(value: unknown): value is ChargeBucket {
  return typeof value === "string" && (CHARGE_BUCKETS as string[]).includes(value);
}

/**
 * Cargos que el vendedor carga a mano porque no llegan por la API de
 * facturación (facturas que ML manda por otro canal, ajustes, etc.). Viven
 * en la misma tabla billing_charges que los sincronizados, así entran en la
 * conciliación y en los costos de Full sin tocar nada más.
 *
 * El vendedor elige el concepto: se guarda en `detail_sub_type` como
 * "manual:<bucket>" y `classifyCharge` lo respeta tal cual, sin pasar por el
 * detector de palabras clave (la descripción libre podría confundirlo). El
 * `detail_id` lleva el prefijo "manual-" y nunca choca con un id de ML, así
 * el sync no los pisa ni los borra.
 */
export const MANUAL_DETAIL_TYPE = "MANUAL";
const MANUAL_SUB_TYPE_PREFIX = "manual:";

export function manualSubType(bucket: ChargeBucket): string {
  return MANUAL_SUB_TYPE_PREFIX + bucket;
}

function manualBucket(fields: (string | null | undefined)[]): ChargeBucket | null {
  for (const f of fields) {
    if (!f?.startsWith(MANUAL_SUB_TYPE_PREFIX)) continue;
    const bucket = f.slice(MANUAL_SUB_TYPE_PREFIX.length);
    if (isChargeBucket(bucket)) return bucket;
  }
  return null;
}

// Candidatos de `detail_sub_type` para cargos de Full, SIN confirmar contra
// una respuesta real de la API — salieron de una investigación externa, no
// de un log en vivo. Se buscan como código exacto (no como texto libre)
// porque si son reales van a llegar así de cortos ("FBM_STORAGE"), no como
// una frase que el detector de palabras clave de más abajo reconocería. Si
// los nombres reales resultan ser otros, esto simplemente nunca matchea y el
// cargo cae en el detector de texto de siempre — no rompe nada al estar mal.
const FULL_DETAIL_SUB_TYPES = new Set([
  "fbm_storage",
  "fbm_long_term_storage",
  "fbm_aged_stock",
  "fbm_stock_removal",
  "fbm_disposal",
  "fbm_unplanned_reception",
]);

/**
 * Clasifica un cargo de la factura de Mercado Libre en un concepto legible.
 *
 * ML no expone un enum estable de conceptos: según el tipo de cargo el texto
 * llega en `detail_type`, `detail_sub_type` o `concept`, y en castellano o
 * inglés según el recurso. Por eso se clasifica por palabras clave sobre todo
 * lo que venga, y lo que no matchea cae en "otro" en vez de descartarse — un
 * cargo sin clasificar sigue siendo plata que salió y tiene que verse.
 */
export function classifyCharge(...fields: (string | null | undefined)[]): ChargeBucket {
  const manual = manualBucket(fields);
  if (manual) return manual;
  if (fields.some((f) => f && FULL_DETAIL_SUB_TYPES.has(f.trim().toLowerCase()))) return "full";

  const haystack = fields.filter(Boolean).join(" ").toLowerCase();

  // Va primero a propósito: "Incumplimiento de envíos" contiene la palabra
  // "envíos" y caía en el bucket "envio", como si fuera flete. Es una multa
  // por una entrega tardía o un producto agotado en Full, no un costo de
  // logística — mezclarlas hacía parecer que el gasto de envío era más alto
  // de lo real y escondía la penalidad en un bucket que no le corresponde.
  if (/incumplimiento|penalidad|multa/.test(haystack)) return "otro";
  // Va antes que "envio" a propósito: un cargo de depósito Full como "Envío a
  // Fulfillment" o "Retiro de stock Full" contiene la palabra "envío" y caía
  // en el bucket de flete de venta, mezclando logística de almacenamiento con
  // el costo de mandarle el pedido al comprador — son gastos de naturaleza
  // distinta y hay que poder verlos separados.
  if (/\bfull\b|fulfillment|almacenamiento|stock antiguo|permanencia en dep[oó]sito|retiro de stock/.test(haystack)) return "full";
  if (/percep|retenc|impuesto|iva|iibb|ingresos brutos|ganancias|tax/.test(haystack)) return "impuesto";
  if (/env[ií]o|envios|shipping|mercado envios|flete|logisti/.test(haystack)) return "envio";
  if (/product ads|publicidad|advertis|campaign|ads/.test(haystack)) return "publicidad";
  // "Cargo por vender" es como Mercado Libre Argentina nombra la comisión en
  // la factura; "vender" no contiene "venta", así que caía en "otros".
  if (/comisi[oó]n|comision|sale fee|selling fee|sales charge|cargo por venta|venta|vender|cargo fijo|costo fijo/.test(haystack)) return "comision";
  return "otro";
}

export type FullChargeDetail = "almacenamiento" | "stock_antiguo" | "retiro" | "envio_a_full" | "otro";

export const FULL_CHARGE_DETAIL_LABEL: Record<FullChargeDetail, string> = {
  almacenamiento: "Almacenamiento",
  stock_antiguo: "Stock antiguo (permanencia prolongada)",
  retiro: "Retiro de stock",
  envio_a_full: "Envío de stock a Full",
  otro: "Otros cargos de Full",
};

const FULL_DETAIL_SUB_TYPE_MAP: Record<string, FullChargeDetail> = {
  fbm_storage: "almacenamiento",
  fbm_long_term_storage: "stock_antiguo",
  fbm_aged_stock: "stock_antiguo",
  fbm_stock_removal: "retiro",
  fbm_disposal: "otro",
  fbm_unplanned_reception: "otro",
};

/**
 * Sub-clasifica un cargo que `classifyCharge` ya puso en el bucket "full",
 * para separar almacenamiento normal, la penalidad por stock antiguo, el
 * retiro y el envío del propio stock al depósito — la pregunta real detrás
 * de "cuánto me cuesta Full" no se contesta con un solo total.
 *
 * Mismo criterio que el resto de esta clasificación: los códigos exactos de
 * `detail_sub_type` son un candidato sin confirmar contra una respuesta
 * real; el texto libre es el respaldo si el código no matchea.
 */
export function classifyFullChargeDetail(...fields: (string | null | undefined)[]): FullChargeDetail {
  for (const f of fields) {
    if (!f) continue;
    const mapped = FULL_DETAIL_SUB_TYPE_MAP[f.trim().toLowerCase()];
    if (mapped) return mapped;
  }

  const haystack = fields.filter(Boolean).join(" ").toLowerCase();
  // Antes que "almacenamiento" a propósito: "permanencia" y "antiguo" son
  // más específicos que el genérico "almacenamiento" que suele acompañarlos
  // en la misma descripción.
  if (/stock antiguo|permanencia|antig[uü]edad|aged/.test(haystack)) return "stock_antiguo";
  if (/retiro|removal|extracci[oó]n/.test(haystack)) return "retiro";
  if (/env[ií]o a (dep[oó]sito|fulfillment)|recepci[oó]n|inbound/.test(haystack)) return "envio_a_full";
  if (/almacenamiento|storage/.test(haystack)) return "almacenamiento";
  return "otro";
}
