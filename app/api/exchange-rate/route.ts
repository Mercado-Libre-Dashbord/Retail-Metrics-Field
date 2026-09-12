import { NextResponse } from "next/server";
import { resolveCurrentAccount } from "@/lib/current-account";
import { getExchangeRates } from "@/lib/exchange-rate";

export const runtime = "nodejs";

/**
 * Cotización pública del dólar (oficial y blue), para poder cargar costos en
 * dólares sin que el vendedor tenga que ir a buscar el número a otro lado.
 * Se pide del lado del servidor (no desde el navegador) para no depender de
 * que la API pública habilite CORS, y para tener un solo lugar donde cambiar
 * de proveedor si hiciera falta.
 */
export async function GET() {
  const account = await resolveCurrentAccount();
  if (!account) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  return NextResponse.json(await getExchangeRates());
}
