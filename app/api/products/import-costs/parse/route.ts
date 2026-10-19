import { NextRequest, NextResponse } from "next/server";
import { resolveCurrentAccount } from "@/lib/current-account";
import { readSheetRows } from "@/lib/xlsx-rows";

export const runtime = "nodejs";
export const maxDuration = 30;

// Vercel corta los pedidos de más de ~4,5 MB antes de que lleguen acá.
const MAX_BYTES = 4 * 1024 * 1024;

/**
 * Convierte un Excel en filas para el importador de costos. El archivo no se
 * guarda: se lee en memoria y se devuelve solo la hoja elegida.
 */
export async function POST(request: NextRequest) {
  const account = await resolveCurrentAccount();
  if (!account) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!file || typeof file === "string") return NextResponse.json({ error: "Falta el archivo." }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "El archivo pesa más de 4 MB. Borrá las hojas que no hacen falta y volvé a subirlo." }, { status: 413 });
  const sheet = form?.get("sheet");

  try {
    const result = await readSheetRows(await file.arrayBuffer(), typeof sheet === "string" ? sheet : null);
    return NextResponse.json(result);
  } catch {
    return NextResponse.json(
      { error: "No pudimos leer el Excel. Probá guardándolo de nuevo como .xlsx, o como CSV." },
      { status: 400 }
    );
  }
}
