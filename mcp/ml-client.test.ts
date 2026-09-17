import { describe, it, expect, vi, afterEach } from "vitest";
import { mlFetch, refreshAccessToken, MlApiError } from "./ml-client";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("mlFetch", () => {
  it("sends the access token as a Bearer header and returns parsed JSON", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ hello: "world" }) });
    vi.stubGlobal("fetch", fetchMock);

    const result = await mlFetch("/users/me", "token123");

    expect(result).toEqual({ hello: "world" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.mercadolibre.com/users/me",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer token123" }) })
    );
  });

  it("throws MlApiError when the response is not ok", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => "unauthorized" }));

    await expect(mlFetch("/users/me", "bad-token")).rejects.toBeInstanceOf(MlApiError);
  });

  it("pulls a clean message out of ML's JSON error body instead of dumping the raw JSON", async () => {
    // El bug real que arregla: sin esto, el JSON entero (llaves, corchetes,
    // comillas) terminaba mostrado tal cual en la pantalla de Productos como
    // si fuera el mensaje de error.
    const body = JSON.stringify({
      message: "Invalid product data",
      error: "bad_request",
      status: 400,
      cause: [{ code: "item.available_quantity.invalid", message: "available_quantity no puede ser negativo" }],
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => body }));

    await expect(mlFetch("/items/MLA1", "token123")).rejects.toMatchObject({
      message: expect.stringContaining("Invalid product data — available_quantity no puede ser negativo"),
    });
    await expect(mlFetch("/items/MLA1", "token123")).rejects.not.toMatchObject({
      message: expect.stringContaining("{"),
    });
  });

  it("falls back to the raw text when the error body isn't JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "gateway timeout" }));

    await expect(mlFetch("/items/MLA1", "token123")).rejects.toMatchObject({
      message: expect.stringContaining("gateway timeout"),
    });
  });

  it("retries once after a 429 response and then returns the successful result", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 429, headers: { get: () => "0" }, text: async () => "rate limited" })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ hello: "world" }) });
    vi.stubGlobal("fetch", fetchMock);

    const result = await mlFetch("/users/me", "token123");

    expect(result).toEqual({ hello: "world" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after exhausting retries and throws a 429 MlApiError when ML keeps rate-limiting", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 429, headers: { get: () => "0" }, text: async () => "rate limited" });
    vi.stubGlobal("fetch", fetchMock);

    await expect(mlFetch("/users/me", "token123")).rejects.toMatchObject({ status: 429 });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});

describe("refreshAccessToken", () => {
  it("posts the refresh grant and returns the new tokens", async () => {
    process.env.ML_CLIENT_ID = "cid";
    process.env.ML_CLIENT_SECRET = "csecret";
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ access_token: "new-a", refresh_token: "new-r", expires_in: 21600 }) });
    vi.stubGlobal("fetch", fetchMock);

    const result = await refreshAccessToken("old-r");

    expect(result).toEqual({ accessToken: "new-a", refreshToken: "new-r", expiresIn: 21600 });
  });

  it("throws MlApiError when the refresh request fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => "invalid_grant" }));

    await expect(refreshAccessToken("bad-r")).rejects.toBeInstanceOf(MlApiError);
  });
});
