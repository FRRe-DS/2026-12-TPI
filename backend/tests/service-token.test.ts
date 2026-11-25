import { describe, it, expect, vi, afterEach } from "vitest";
import {
  ClientCredentialsTokenProvider,
  ServiceTokenError,
} from "../src/services/service-token.service.js";

const OPTIONS = {
  tokenUrl: "http://keycloak:8080/realms/ds-2026-realm/protocol/openid-connect/token",
  clientId: "grupo-12",
  clientSecret: "dev-secret",
  timeoutMs: 500,
};

function tokenResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ClientCredentialsTokenProvider", () => {
  it("sin credenciales no pide token", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    const provider = new ClientCredentialsTokenProvider({ tokenUrl: OPTIONS.tokenUrl });

    await expect(provider.getToken()).resolves.toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("pide el token con client_credentials por formulario", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(tokenResponse({ access_token: "jwt-abc", expires_in: 300 }));
    vi.stubGlobal("fetch", mockFetch);

    const provider = new ClientCredentialsTokenProvider(OPTIONS);
    await expect(provider.getToken()).resolves.toBe("jwt-abc");

    expect(mockFetch).toHaveBeenCalledWith(
      OPTIONS.tokenUrl,
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "grant_type=client_credentials&client_id=grupo-12&client_secret=dev-secret",
      })
    );
  });

  it("reutiliza el token mientras siga vigente", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(tokenResponse({ access_token: "jwt-abc", expires_in: 300 }));
    vi.stubGlobal("fetch", mockFetch);

    const provider = new ClientCredentialsTokenProvider(OPTIONS);
    await provider.getToken();
    await provider.getToken();

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("vuelve a pedir el token cuando está por vencer", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(tokenResponse({ access_token: "jwt-corto", expires_in: 20 }));
    vi.stubGlobal("fetch", mockFetch);

    const provider = new ClientCredentialsTokenProvider(OPTIONS);
    await provider.getToken();
    await provider.getToken();

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("varias llamadas concurrentes comparten un solo pedido", async () => {
    let resolveFetch: (value: unknown) => void = () => {};
    const pending = new Promise((resolve) => {
      resolveFetch = resolve;
    });
    const mockFetch = vi.fn().mockReturnValue(pending);
    vi.stubGlobal("fetch", mockFetch);

    const provider = new ClientCredentialsTokenProvider(OPTIONS);
    const first = provider.getToken();
    const second = provider.getToken();
    resolveFetch(tokenResponse({ access_token: "jwt-uno", expires_in: 300 }));

    await expect(Promise.all([first, second])).resolves.toEqual(["jwt-uno", "jwt-uno"]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("un error HTTP del emisor es ServiceTokenError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(tokenResponse({}, 401)));
    const provider = new ClientCredentialsTokenProvider(OPTIONS);

    await expect(provider.getToken()).rejects.toBeInstanceOf(ServiceTokenError);
  });

  it("una respuesta sin access_token es ServiceTokenError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(tokenResponse({ expires_in: 300 })));
    const provider = new ClientCredentialsTokenProvider(OPTIONS);

    await expect(provider.getToken()).rejects.toBeInstanceOf(ServiceTokenError);
  });

  it("un error de red es ServiceTokenError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const provider = new ClientCredentialsTokenProvider(OPTIONS);

    await expect(provider.getToken()).rejects.toBeInstanceOf(ServiceTokenError);
  });
});
