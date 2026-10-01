import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/db/client", () => ({ withScope: vi.fn() }));
vi.mock("@/lib/current-account", () => ({ resolveCurrentAccount: vi.fn() }));

import { GET } from "./route";
import { withScope } from "@/db/client";
import { resolveCurrentAccount } from "@/lib/current-account";
import { resetColumnCache } from "@/db/schema-capabilities";

const account = { id: "acc1", name: "C", ownerEmail: "a@b.com", mlSellerId: "S1", otherTaxRate: 0, taxCondition: "responsable_inscripto" as const, taxConditionConfirmed: true, createdAt: "2026-01-01" };
const req = (qs = "") => ({ nextUrl: { searchParams: new URLSearchParams(qs) } }) as any;

describe("GET /api/export/orders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetColumnCache();
    vi.mocked(resolveCurrentAccount).mockResolvedValue(account);
  });

  it("returns 401 with no active account", async () => {
    vi.mocked(resolveCurrentAccount).mockResolvedValue(null);
    expect((await GET(req())).status).toBe(401);
  });

  it("produce un CSV con encabezado y una fila por línea de venta", async () => {
    const query = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("information_schema.columns")) {
        return { rows: [{ table_name: "order_items", column_name: "tax_applied" }, { table_name: "order_items", column_name: "iva_applied" }] };
      }
      return {
        rows: [
          {
            orderId: "O1", dateCreated: "2026-08-05T00:00:00Z", status: "paid",
            productId: "MLA1", productTitle: "Producto, con coma",
            quantity: 2, unitPrice: 1000, mlCommission: 130, shippingCost: 90,
            adsCostAllocated: 50, costApplied: 300, taxApplied: 10, ivaApplied: 42,
            netProfit: 578,
          },
        ],
      };
    });
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query }));

    const res = await GET(req("from=2026-08-01&to=2026-08-31"));
    const text = await res.text();

    expect(res.headers.get("Content-Type")).toContain("text/csv");
    expect(res.headers.get("Content-Disposition")).toContain("detalle-ventas-2026-08-01-a-2026-08-31.csv");
    const lines = text.replace(/^﻿/, "").trim().split("\n");
    expect(lines[0]).toBe(
      "orden,fecha,estado,id_producto,producto,cantidad,precio_unitario,facturacion,comision_ml,envio,publicidad,costo_producto,otros_impuestos,iva,ganancia_neta"
    );
    // El título con coma queda entre comillas, y la facturación/costo/impuesto
    // salen multiplicados por cantidad, no como el valor unitario crudo.
    expect(lines[1]).toBe('O1,2026-08-05,paid,MLA1,"Producto, con coma",2,1000,2000,130,90,50,600,20,42,578');
  });

  it("no filtra por estado: una orden cancelada también sale, con su estado", async () => {
    const query = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("information_schema.columns")) return { rows: [] };
      return {
        rows: [
          {
            orderId: "O2", dateCreated: "2026-08-06T00:00:00Z", status: "cancelled",
            productId: "MLA2", productTitle: "Otro", quantity: 1, unitPrice: 500,
            mlCommission: 0, shippingCost: 0, adsCostAllocated: 0, costApplied: null,
            taxApplied: null, ivaApplied: null, netProfit: null,
          },
        ],
      };
    });
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query }));

    const text = await (await GET(req())).text();
    expect(text).toContain("cancelled");
    // costApplied null: la línea queda vacía, no "0" ni "null" literal.
    expect(text).toContain("O2,2026-08-06,cancelled,MLA2,Otro,1,500,500,0,0,0,,,,");
  });

  it("neutraliza fórmulas de Excel en los textos, sin tocar los números negativos", async () => {
    const query = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("information_schema.columns")) return { rows: [] };
      return {
        rows: [
          {
            orderId: "O1", dateCreated: "2026-08-05T00:00:00Z", status: "paid",
            productId: "MLA1", productTitle: '=HYPERLINK("http://x","clic")',
            quantity: 1, unitPrice: 1000, mlCommission: 130, shippingCost: 0,
            adsCostAllocated: 0, costApplied: 2000, taxApplied: null, ivaApplied: null,
            netProfit: -1130,
          },
        ],
      };
    });
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({ query }));

    const text = await (await GET(req())).text();

    expect(text).toContain(`"'=HYPERLINK(""http://x"",""clic"")"`);
    expect(text).toContain("-1130");
    expect(text).not.toContain("'-1130");
  });
});

