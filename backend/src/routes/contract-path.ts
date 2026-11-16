/** Prefijo canónico de la API, igual que en el resto de los módulos. */
export const CONTRACT_PREFIX = "/api/v1";

/**
 * Devuelve la ruta interna del contrato. Acepta `/api/v1/trips` (canónica) y
 * `/trips` (alias sin prefijo, por compatibilidad con los clientes existentes).
 */
export function toContractPath(pathname: string): string {
  if (pathname === CONTRACT_PREFIX) return "/";
  if (pathname.startsWith(`${CONTRACT_PREFIX}/`)) {
    return pathname.slice(CONTRACT_PREFIX.length);
  }
  return pathname;
}
