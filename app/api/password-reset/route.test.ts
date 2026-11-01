import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const query = vi.fn();
vi.mock("@/db/client", () => ({ withScope: vi.fn((ctx: unknown, fn: (client: unknown) => unknown) => fn({ query })) }));
vi.mock("@/lib/mailer", () => ({ mailEnabled: vi.fn(() => true), sendMail: vi.fn() }));

import { POST } from "./route";
import { mailEnabled, sendMail } from "@/lib/mailer";

const req = (body: unknown) => new Request("https://retail.example/api/password-reset", { method: "POST", body: JSON.stringify(body) }) as any;

describe("POST /api/password-reset", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(mailEnabled).mockReturnValue(true);
    process.env.NEXTAUTH_URL = "https://retail.example";
  });
  afterEach(() => { delete process.env.NEXTAUTH_URL; });

  it("rejects an invalid email", async () => {
    expect((await POST(req({ email: "nope" }))).status).toBe(400);
  });

  it("says when mail is not configured", async () => {
    vi.mocked(mailEnabled).mockReturnValue(false);
    expect((await POST(req({ email: "a@b.com" }))).status).toBe(503);
  });

  it("emails a single-use link when the database allows it", async () => {
    query.mockResolvedValue({ rows: [{ ok: true }] });
    const res = await POST(req({ email: " Lucas@Example.com " }));
    expect(res.status).toBe(200);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("credential_request_reset");
    expect(params[0]).toBe("lucas@example.com");
    expect(params[1]).toMatch(/^[0-9a-f]{64}$/); // se guarda el hash, nunca el token
    const mail = vi.mocked(sendMail).mock.calls[0][0];
    expect(mail.to).toBe("lucas@example.com");
    expect(mail.text).toMatch(/https:\/\/retail\.example\/set-password\?token=inv_[\w-]+&reset=1/);
  });

  it("answers the same and sends nothing for an email without access", async () => {
    query.mockResolvedValue({ rows: [{ ok: false }] });
    const res = await POST(req({ email: "nadie@example.com" }));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(sendMail).not.toHaveBeenCalled();
  });
});
