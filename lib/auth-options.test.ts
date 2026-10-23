import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/db/client", () => ({ withScope: vi.fn() }));
vi.mock("@/db/credentials", () => ({
  getCredentialUserByEmail: vi.fn(),
  recordFailedLogin: vi.fn(),
  recordSuccessfulLogin: vi.fn(),
}));
vi.mock("@/lib/credentials-auth", () => ({ verifyPassword: vi.fn() }));

import { authorizeCredentials } from "./auth-options";
import { withScope } from "@/db/client";
import { getCredentialUserByEmail, recordFailedLogin, recordSuccessfulLogin } from "@/db/credentials";
import { verifyPassword } from "@/lib/credentials-auth";

describe("authorizeCredentials()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(withScope).mockImplementation((ctx: any, fn: any) => fn({}));
  });

  it("rejects when email or password is missing", async () => {
    expect(await authorizeCredentials({ email: "", password: "x" })).toBeNull();
    expect(await authorizeCredentials({ email: "a@example.com", password: "" })).toBeNull();
    expect(withScope).not.toHaveBeenCalled();
  });

  it("returns null when no credential user exists for that email", async () => {
    vi.mocked(getCredentialUserByEmail).mockResolvedValue(null);
    const result = await authorizeCredentials({ email: "nadie@example.com", password: "x" });
    expect(result).toBeNull();
  });

  it("returns null and never even hashes the password while locked out", async () => {
    vi.mocked(getCredentialUserByEmail).mockResolvedValue({
      email: "bloqueado@example.com", passwordHash: "h", failedAttempts: 5,
      lockedUntil: new Date(Date.now() + 60000).toISOString(),
    });
    const result = await authorizeCredentials({ email: "bloqueado@example.com", password: "x" });
    expect(result).toBeNull();
    expect(verifyPassword).not.toHaveBeenCalled();
  });

  it("allows login again once the lockout window has passed", async () => {
    vi.mocked(getCredentialUserByEmail).mockResolvedValue({
      email: "desbloqueado@example.com", passwordHash: "h", failedAttempts: 5,
      lockedUntil: new Date(Date.now() - 1000).toISOString(),
    });
    vi.mocked(verifyPassword).mockResolvedValue(true);
    const result = await authorizeCredentials({ email: "desbloqueado@example.com", password: "x" });
    expect(result).toEqual({ id: "desbloqueado@example.com", email: "desbloqueado@example.com" });
  });

  it("records a failed attempt and returns null on wrong password", async () => {
    vi.mocked(getCredentialUserByEmail).mockResolvedValue({
      email: "cliente@example.com", passwordHash: "h", failedAttempts: 0, lockedUntil: null,
    });
    vi.mocked(verifyPassword).mockResolvedValue(false);

    const result = await authorizeCredentials({ email: "cliente@example.com", password: "mala" });

    expect(result).toBeNull();
    expect(recordFailedLogin).toHaveBeenCalledWith(expect.anything(), "cliente@example.com");
    expect(recordSuccessfulLogin).not.toHaveBeenCalled();
  });

  it("records a successful login and returns the user on correct password", async () => {
    vi.mocked(getCredentialUserByEmail).mockResolvedValue({
      email: "cliente@example.com", passwordHash: "h", failedAttempts: 2, lockedUntil: null,
    });
    vi.mocked(verifyPassword).mockResolvedValue(true);

    const result = await authorizeCredentials({ email: "Cliente@Example.com", password: "buena" });

    expect(result).toEqual({ id: "cliente@example.com", email: "cliente@example.com" });
    expect(recordSuccessfulLogin).toHaveBeenCalledWith(expect.anything(), "cliente@example.com");
    expect(recordFailedLogin).not.toHaveBeenCalled();
  });

  it("degrada a login inválido si la tabla todavía no existe (migración 016 no corrida), sin tirar 500", async () => {
    vi.mocked(getCredentialUserByEmail).mockRejectedValue(new Error('relation "credential_users" does not exist'));
    const result = await authorizeCredentials({ email: "cliente@example.com", password: "x" });
    expect(result).toBeNull();
  });
});

describe("isAdminEmail", () => {
  it("suma los admins de ADMIN_EMAILS y de ADMIN_EMAILS_EXTRA, sin importar mayúsculas", async () => {
    const { isAdminEmail } = await import("./auth-options");
    const prev = { a: process.env.ADMIN_EMAILS, b: process.env.ADMIN_EMAILS_EXTRA };
    process.env.ADMIN_EMAILS = "dueno@example.com";
    process.env.ADMIN_EMAILS_EXTRA = " LCaseresPlaza@gmail.com ";
    try {
      expect(isAdminEmail("dueno@example.com")).toBe(true);
      expect(isAdminEmail("lcaseresplaza@gmail.com")).toBe(true);
      expect(isAdminEmail("otro@example.com")).toBe(false);
      delete process.env.ADMIN_EMAILS_EXTRA;
      expect(isAdminEmail("lcaseresplaza@gmail.com")).toBe(false);
    } finally {
      process.env.ADMIN_EMAILS = prev.a;
      if (prev.b === undefined) delete process.env.ADMIN_EMAILS_EXTRA; else process.env.ADMIN_EMAILS_EXTRA = prev.b;
    }
  });
});
