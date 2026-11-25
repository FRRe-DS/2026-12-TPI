/**
 * Token de servicio para llamar a otro módulo (por ejemplo M8) en nombre de M6.
 *
 * Se pide al emisor de identidad (M1/Keycloak) con `client_credentials` y se
 * cachea hasta poco antes de que venza. Así no hay credenciales de larga vida
 * en el repositorio ni en el entorno de ejecución (RNF-06 / RNF-12).
 */
export interface TokenProvider {
  /** Devuelve el token o `undefined` si no hay credenciales configuradas. */
  getToken(): Promise<string | undefined>;
}

/** No se pudo obtener el token (configuración, red o respuesta del emisor). */
export class ServiceTokenError extends Error {}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Se renueva el token cuando le queda menos de este margen. */
const REFRESH_MARGIN_MS = 30_000;

export interface ClientCredentialsOptions {
  tokenUrl?: string;
  clientId?: string;
  clientSecret?: string;
  timeoutMs?: number;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

export class ClientCredentialsTokenProvider implements TokenProvider {
  private cached: CachedToken | null = null;
  private inFlight: Promise<string> | null = null;

  constructor(
    private readonly options: ClientCredentialsOptions,
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  async getToken(): Promise<string | undefined> {
    const { tokenUrl, clientId, clientSecret } = this.options;
    if (!tokenUrl || !clientId || !clientSecret) return undefined;

    if (this.cached && this.cached.expiresAt - REFRESH_MARGIN_MS > Date.now()) {
      return this.cached.token;
    }

    // Varias peticiones concurrentes comparten un solo pedido de token.
    if (!this.inFlight) {
      this.inFlight = this.requestToken().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  private async requestToken(): Promise<string> {
    const { tokenUrl, clientId, clientSecret, timeoutMs = 3000 } = this.options;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await this.fetchImpl(tokenUrl!, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: clientId!,
          client_secret: clientSecret!,
        }).toString(),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new ServiceTokenError(
          `El emisor respondió HTTP ${response.status} al pedir el token de servicio.`
        );
      }

      const body = (await response.json().catch(() => ({}))) as {
        access_token?: unknown;
        expires_in?: unknown;
      };
      if (typeof body.access_token !== "string" || body.access_token.trim() === "") {
        throw new ServiceTokenError("El emisor no devolvió un access_token válido.");
      }

      const ttlSeconds = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 60;
      this.cached = {
        token: body.access_token,
        expiresAt: Date.now() + ttlSeconds * 1000,
      };
      return body.access_token;
    } catch (err) {
      if (err instanceof ServiceTokenError) throw err;
      const reason = err instanceof Error ? err.message : "error desconocido";
      throw new ServiceTokenError(`No se pudo obtener el token de servicio: ${reason}.`);
    } finally {
      clearTimeout(timer);
    }
  }
}
