import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { readSheetRows } from "./xlsx-rows";

async function workbook(): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  const stock = wb.addWorksheet("STOCK");
  stock.addRow(["CODIGO", "EAN", "ARTICULO", "COSTO"]);
  stock.addRow([null, null, new Date(Date.UTC(2026, 9, 9))]);
  stock.addRow(["JM2125", 7798353739823, "ESPEJO LED", { formula: "1690/2", result: 845 }]);
  const clientes = wb.addWorksheet("CLIENTES");
  clientes.addRow(["NOMBRE", "TELEFONO"]);
  clientes.addRow(["Persona", "11-0000-0000"]);
  const buf = await wb.xlsx.writeBuffer();
  return buf as ArrayBuffer;
}

describe("readSheetRows", () => {
  it("lee la hoja STOCK por defecto, con resultados de fórmulas y la fecha de corte", async () => {
    const r = await readSheetRows(await workbook());
    expect(r.sheets).toEqual(["STOCK", "CLIENTES"]);
    expect(r.sheet).toBe("STOCK");
    expect(r.fileDate).toBe("2026-10-09");
    expect(r.rows[2]).toEqual(["JM2125", 7798353739823, "ESPEJO LED", 845]);
    expect(JSON.stringify(r.rows)).not.toContain("Persona");
  });
  it("lee otra hoja solo si se la pide", async () => {
    const r = await readSheetRows(await workbook(), "CLIENTES");
    expect(r.rows[1]).toEqual(["Persona", "11-0000-0000"]);
  });
});
