import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/db/client", () => ({ withScope: vi.fn() }));
vi.mock("@/db/trial-requests", () => ({
  insertTrialRequest: vi.fn(),
  listTrialRequests: vi.fn(),
  setTrialRequestStatus: vi.fn(),
}));
vi.mock("@/lib/current-account", () => ({ getCurrentUser: vi.fn() }));

import { POST, GET, PATCH } from "./route";
import { withScope } from "@/db/client";
import { insertTrialRequest, listTrialRequests, setTrialRequestStatus } from "@/db/trial-requests";
import { getCurrentUser } from "@/lib/current-account";

const req = (body: unknown) => ({ json: async () => body }) as any;
const valid = { name: "Laura", email: "laura@tienda.com.ar", store: "Lámparas Norte", utmCampaign: "ola1" };

describe("/api/trial-requests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({}));
  });

  it("POST guarda una solicitud válida sin pedir sesión, con un scope vacío", async () => {
    const res = await POST(req(valid));
    expect(res.status).toBe(200);
    expect(vi.mocked(withScope).mock.calls[0][0]).toEqual({});
    expect(insertTrialRequest).toHaveBeenCalledWith({}, expect.objectContaining({ email: "laura@tienda.com.ar", utmCampaign: "ola1" }));
    expect(getCurrentUser).not.toHaveBeenCalled();
  });

  it("POST devuelve 400 con datos inválidos y no toca la base", async () => {
    const res = await POST(req({ ...valid, email: "no-es-mail" }));
    expect(res.status).toBe(400);
    expect(insertTrialRequest).not.toHaveBeenCalled();
  });

  it("POST con un body roto devuelve 400", async () => {
    const res = await POST({ json: async () => { throw new SyntaxError("x"); } } as any);
    expect(res.status).toBe(400);
  });

  it("POST de un bot responde ok pero no guarda nada", async () => {
    const res = await POST(req({ ...valid, website: "spam" }));
    expect(res.status).toBe(200);
    expect(insertTrialRequest).not.toHaveBeenCalled();
  });

  it("POST devuelve 500 genérico si la base falla", async () => {
    vi.mocked(insertTrialRequest).mockRejectedValue(new Error("connection refused"));
    const res = await POST(req(valid));
    expect(res.status).toBe(500);
    expect((await res.json()).error).not.toContain("connection");
  });

  it("GET y PATCH exigen admin", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue({ email: "cliente@example.com", isAdmin: false });
    expect((await GET()).status).toBe(403);
    expect((await PATCH(req({ id: 1, status: "contactada" }))).status).toBe(403);
    vi.mocked(getCurrentUser).mockResolvedValue(null);
    expect((await GET()).status).toBe(403);
    expect(listTrialRequests).not.toHaveBeenCalled();
    expect(setTrialRequestStatus).not.toHaveBeenCalled();
  });

  it("GET de un admin lista las solicitudes con scope de admin", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue({ email: "admin@example.com", isAdmin: true });
    vi.mocked(listTrialRequests).mockResolvedValue([]);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(vi.mocked(withScope).mock.calls[0][0]).toEqual({ isAdmin: true, userEmail: "admin@example.com" });
  });

  it("PATCH valida el estado y responde 404 si no existe", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue({ email: "admin@example.com", isAdmin: true });
    expect((await PATCH(req({ id: 1, status: "borrada" }))).status).toBe(400);
    expect((await PATCH(req({ id: "1", status: "contactada" }))).status).toBe(400);
    vi.mocked(setTrialRequestStatus).mockResolvedValue(false);
    expect((await PATCH(req({ id: 9, status: "contactada" }))).status).toBe(404);
    vi.mocked(setTrialRequestStatus).mockResolvedValue(true);
    expect((await PATCH(req({ id: 1, status: "activada" }))).status).toBe(200);
  });
});
