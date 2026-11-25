# Keycloak de M6 (hace de M1)

Keycloak es el proveedor de identidad de la plataforma: emite los JWT con los roles
de cliente, conductor, operador y servicio (RF-1.3 / RF-1.4). M6 **no** lo usa para
autenticar usuarios finales; lo usa para **validar la firma y los roles** de los
tokens que le llegan (RNF-12).

Este directorio trae el realm del módulo, derivado del realm de la cátedra
(`FRRe-DS/2026-TPI`, `keycloak/realm-config/ds-2026-realm.json`, commit `6dfdd40`).

## Qué se agregó al realm de la cátedra y por qué

El realm original solo tiene las cuentas de servicio de cada grupo y un `test-user`
sin roles. Con eso ningún token de persona existe, así que no se puede probar un
inicio de viaje con cliente y conductor reales.

| Cambio | Detalle |
| :--- | :--- |
| Roles de usuario | `CLIENTE`, `CONDUCTOR`, `OPERADOR` y `SERVICIO` (RF-1.3) |
| Usuarios de desarrollo | `cliente1` (CLIENTE), `conductor1` (CONDUCTOR), `operador1` (OPERADOR) |
| IDs fijos | `cliente1` = `c1e00000-0000-4000-8000-000000000001`; `conductor1` = `c0d00000-0000-4000-8000-000000000001`; `operador1` = `0be00000-0000-4000-8000-000000000001`. Se usan como `clientId` / `driverId` en los viajes |
| Contraseñas | `<usuario>-contrasena-de-desarrollo` (por ejemplo, `conductor1-contrasena-de-desarrollo`) |
| `SERVICIO` en cuentas de servicio | `grupo-01` y `grupo-17` (M2) y `grupo-04` / `grupo-13` (M5), los módulos que llaman a M6 |
| Cliente `m6-desarrollo` | Cliente público solo para pedir tokens de persona con usuario y contraseña en desarrollo |
| Scopes | Iguales a los de la cátedra (`clientes:*`, `conductores:*`); M6 no los usa para autorizar |

Se mantienen el nombre del realm (`ds-2026-realm`), los 16 clientes `grupo-NN` con
sus secretos y los roles `*-be`, para que un token de servicio siga siendo
reconocible como `SYSTEM`.

## Cómo levantarlo

Desde la raíz del repositorio:

```powershell
docker compose up -d keycloak-db keycloak
```

Queda en `http://localhost:8081` (se puede cambiar con `KEYCLOAK_PORT`). Puertos,
usuario admin y claves de su base salen de `.env`; los valores por defecto están en
`docker-compose.yml` y son solo para desarrollo.

El emisor de los tokens queda fijado en `http://localhost:8081/realms/ds-2026-realm`
(`KC_HOSTNAME` + `KC_HOSTNAME_PORT`). El backend, cuando corre en contenedor, baja las
claves por la red interna (`http://keycloak:8080/...`) pero valida ese emisor.

## Pedir un token de persona

```powershell
curl.exe -s http://localhost:8081/realms/ds-2026-realm/protocol/openid-connect/token `
  -d grant_type=password `
  -d client_id=m6-desarrollo `
  -d username=conductor1 `
  -d password=conductor1-contrasena-de-desarrollo
```

El token trae `roles: ["CONDUCTOR", "default-roles-ds-2026-realm"]` y el `sub` es el ID
fijo del usuario. Para un token de servicio se usa `client_credentials` con el cliente
`grupo-12` y su secreto (está en `realm-config/ds-2026-realm.json`) o con el cliente de
otro módulo que llame a M6.

## Configuración de M6

| Variable | Valor en el compose | Para qué |
| :--- | :--- | :--- |
| `AUTH_ISSUER` | `http://localhost:8081/realms/ds-2026-realm` | `iss` esperado en el token |
| `AUTH_JWKS_URI` | `http://keycloak:8080/realms/ds-2026-realm/protocol/openid-connect/certs` | de dónde baja las claves públicas |
| `AUTH_AUDIENCE` | vacío | opcional; este realm no emite `aud` |

Al correr el backend fuera de Docker (`npm run dev`), alcanza con
`AUTH_ISSUER=http://localhost:8081/realms/ds-2026-realm`: la URL del JWKS se deriva
del emisor.

## Límites conocidos

- **No incluye las claves de firma.** Cada instancia de Keycloak genera su propio par
  al arrancar, así que un token emitido por este Keycloak no valida contra el de otro
  grupo. Para integración entre módulos hace falta **una instancia compartida** y
  apuntar `AUTH_ISSUER` / `AUTH_JWKS_URI` a ella.
- **No es el realm de la cátedra.** Es una copia derivada para que el módulo se levante
  completo (RNF-04 / RNF-18). Si la cátedra o M1 publican roles y usuarios en el realm
  compartido, conviene migrar a ese y borrar esta carpeta.
- **Cambiar el realm exige recrear el volumen**: Keycloak importa el realm solo cuando
  la base está vacía. `docker compose down -v` borra los datos locales; usarlo con
  confirmación.
