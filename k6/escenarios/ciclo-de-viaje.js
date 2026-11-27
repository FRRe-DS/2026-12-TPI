// Escenario k6: ciclo de vida completo de un viaje en M6 — Grupo 12.
// Especificación cerrada en k6/PROPUESTA.md.
//
// Flujo por iteración:
//   1. SYSTEM  POST /api/v1/trips
//   2. DRIVER  POST /api/v1/trips/:id/arrived
//   3a. CLIENT POST /api/v1/trips/:id/cancel (15%, motivo CHANGE_OF_PLANS) -> fin
//   3b. DRIVER POST /api/v1/trips/:id/start (QR-<id>) -> POST /api/v1/trips/:id/complete (2..12 km)
//   4. DRIVER  GET /api/v1/trips/:id y GET /api/v1/trips/:id/history (20% de los completados)
//
// Autenticación:
//   Atajos de demo habilitados en el servidor de prueba con ENABLE_DEMO_AUTH=true:
//   Bearer SYSTEM:m5-despacho-N, Bearer DRIVER:<uuid>, Bearer CLIENT:<uuid>.
//
// Modos soportados (variable de entorno MODO):
//   - smoke      : 2 VUs, rampa 10s, régimen 20s.
//   - serie      : VUs configurables (50/100/500/1000), IDs nuevos por iteración, sin 429.
//   - limites    : 500 VUs, IDs fijos por VU y un solo SYSTEM (m5-despacho-1), provoca 429.
//   - individual : VUs, rampa y duración configurables, umbrales de serie.
//   - local      : corrida local con límites altos, umbrales de serie.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';

function numeroEnv(valor, defecto) {
  if (valor === undefined || valor === null || String(valor).trim() === '') {
    return defecto;
  }
  const parsed = Number(valor);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Valor numérico inválido: "${valor}"`);
  }
  return parsed;
}

const MODOS_VALIDOS = new Set(['smoke', 'serie', 'limites', 'individual', 'local']);
const MODO = String(__ENV.MODO || 'serie').trim().toLowerCase();
if (!MODOS_VALIDOS.has(MODO)) {
  throw new Error(`MODO inválido: "${MODO}". Valores permitidos: smoke, serie, limites, individual, local.`);
}

const BASE_URL = String(__ENV.BASE_URL || 'http://localhost:3006').trim().replace(/\/+$/, '');

const ES_SMOKE = MODO === 'smoke';
const ES_LIMITES = MODO === 'limites';

const VUS = ES_SMOKE ? 2 : ES_LIMITES ? 500 : numeroEnv(__ENV.VUS, 50);
if (!Number.isInteger(VUS) || VUS < 1) {
  throw new Error(`VUS debe ser un entero positivo. Recibido: ${VUS}`);
}

const RAMPA = ES_SMOKE ? '10s' : String(__ENV.RAMPA || '1m').trim();
const DURACION = ES_SMOKE ? '20s' : String(__ENV.DURACION || '3m').trim();
const BAJADA = String(__ENV.BAJADA || '20s').trim();

const PORCENTAJE_CANCELACION = numeroEnv(__ENV.PORCENTAJE_CANCELACION, 15);
const PORCENTAJE_LECTURAS = numeroEnv(
  __ENV.PORCENTAJE_LECTURAS !== undefined ? __ENV.PORCENTAJE_LECTURAS : __ENV.LECTURAS,
  20,
);

// En modo límites todos los VUs comparten m5-despacho-1.
// En los demás modos se usa un pool de ceil(VUs / 20) + 2 tokens SYSTEM para no tocar el límite de 1200/min.
const SYSTEM_TOKENS = ES_LIMITES
  ? 1
  : numeroEnv(__ENV.SYSTEM_TOKENS, Math.ceil(VUS / 20) + 2);

const TEST_ID = String(__ENV.TEST_ID || '').trim();

function construirUmbrales(modo) {
  if (modo === 'smoke') {
    return {
      http_req_failed: ['rate<0.01'],
      checks: ['rate>0.99'],
      m6_viajes_completados: ['count>0'],
    };
  }
  if (modo === 'limites') {
    // En modo límites los 429 son esperados y no hacen fallar la corrida:
    // no se evalúa http_req_failed ni checks.
    return {
      m6_http_5xx: ['count==0'],
      'http_req_duration{expected_response:true}': ['p(95)<1500'],
      m6_http_429: ['count>0'],
    };
  }
  // serie, individual y local (límites desactivados)
  return {
    http_req_failed: ['rate<0.05'],
    http_req_duration: ['p(95)<1500'],
    checks: ['rate>0.99'],
    m6_http_429: ['count==0'],
  };
}

export const options = {
  scenarios: {
    ciclo_de_viaje: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: RAMPA, target: VUS },
        { duration: DURACION, target: VUS },
        { duration: BAJADA, target: 0 },
      ],
      gracefulRampDown: '15s',
    },
  },
  tags: Object.assign(
    {
      grupo: '12',
      modo: MODO,
      vus: String(VUS),
    },
    TEST_ID ? { testid: TEST_ID } : {},
  ),
  thresholds: construirUmbrales(MODO),
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

// Contadores propios de M6 (sección 3.4 de k6/PROPUESTA.md)
const viajesCompletados = new Counter('m6_viajes_completados');
const viajesCancelados = new Counter('m6_viajes_cancelados');
const ciclosFallidos = new Counter('m6_ciclos_fallidos');
const http429 = new Counter('m6_http_429');
const http5xx = new Counter('m6_http_5xx');
const lecturas = new Counter('m6_lecturas');

// En modo límites cada VU mantiene su propio par clientId/driverId fijo durante toda la corrida.
let identidadFijaVu = null;

// ---------- utilidades ----------

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function tokenDemo(rol, sub) {
  return `${rol}:${sub}`;
}

function llamar(metodo, ruta, nombre, token, cuerpo) {
  const headers = {
    Authorization: `Bearer ${token}`,
  };
  let payload = null;
  if (cuerpo !== undefined && cuerpo !== null) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(cuerpo);
  }
  const res = http.request(metodo, `${BASE_URL}${ruta}`, payload, {
    headers,
    tags: { name: nombre },
  });
  if (res.status === 429) {
    http429.add(1);
  } else if (res.status >= 500) {
    http5xx.add(1);
  }
  return res;
}

function obtenerIdentidades() {
  if (ES_LIMITES) {
    if (!identidadFijaVu) {
      const clientId = uuid();
      const driverId = uuid();
      identidadFijaVu = {
        clientId,
        driverId,
        tokenConductor: tokenDemo('DRIVER', driverId),
        tokenCliente: tokenDemo('CLIENT', clientId),
      };
    }
    return identidadFijaVu;
  }

  const clientId = uuid();
  const driverId = uuid();
  return {
    clientId,
    driverId,
    tokenConductor: tokenDemo('DRIVER', driverId),
    tokenCliente: tokenDemo('CLIENT', clientId),
  };
}

// ---------- ciclo de vida k6 ----------

export function setup() {
  // Inicializamos los contadores en 0 para asegurar su presencia en el JSON de resumen
  // y en la evaluación de umbrales (por ejemplo, m6_http_429 == 0 o m6_http_5xx == 0).
  viajesCompletados.add(0);
  viajesCancelados.add(0);
  ciclosFallidos.add(0);
  http429.add(0);
  http5xx.add(0);
  lecturas.add(0);

  const sistemas = [];
  for (let i = 1; i <= SYSTEM_TOKENS; i += 1) {
    sistemas.push(tokenDemo('SYSTEM', `m5-despacho-${i}`));
  }
  return { sistemas };
}

export default function (datos) {
  const tokenSistema = datos.sistemas[(__VU - 1) % datos.sistemas.length];
  const { clientId, driverId, tokenConductor, tokenCliente } = obtenerIdentidades();

  // 1. SYSTEM crea el viaje
  const alta = llamar('POST', '/api/v1/trips', 'POST /api/v1/trips', tokenSistema, {
    requestId: uuid(),
    clientId,
    driverId,
    vehicleId: uuid(),
    vehicleType: Math.random() < 0.7 ? 'AUTO' : 'MOTO',
    originLatitude: -27.4511,
    originLongitude: -58.9867,
    destinationLatitude: -27.4698,
    destinationLongitude: -58.8306,
  });

  if (!check(alta, { 'crear viaje: 201': (r) => r.status === 201 })) {
    ciclosFallidos.add(1);
    return;
  }

  let id = null;
  try {
    id = alta.json('id');
  } catch {
    id = null;
  }
  if (!id) {
    ciclosFallidos.add(1);
    return;
  }

  sleep(0.2 + Math.random() * 0.3);

  // 2. DRIVER registra el arribo (cuerpo vacío)
  const arribo = llamar('POST', `/api/v1/trips/${id}/arrived`, 'POST /api/v1/trips/:id/arrived', tokenConductor);
  if (!check(arribo, { 'arribo: 200': (r) => r.status === 200 })) {
    ciclosFallidos.add(1);
    return;
  }

  sleep(0.2 + Math.random() * 0.1);

  // 3. 15% de las iteraciones cancelan con CLIENT; los cancelados no ejecutan lecturas
  if (Math.random() * 100 < PORCENTAJE_CANCELACION) {
    const cancelacion = llamar(
      'POST',
      `/api/v1/trips/${id}/cancel`,
      'POST /api/v1/trips/:id/cancel',
      tokenCliente,
      { reason: 'CHANGE_OF_PLANS' },
    );
    if (check(cancelacion, { 'cancelar: 200': (r) => r.status === 200 })) {
      viajesCancelados.add(1);
    } else {
      ciclosFallidos.add(1);
    }
    return;
  }

  // 4. 85% restante: DRIVER inicia con QR-<id>
  const inicio = llamar('POST', `/api/v1/trips/${id}/start`, 'POST /api/v1/trips/:id/start', tokenConductor, {
    verificationToken: `QR-${id}`,
  });
  if (!check(inicio, { 'inicio: 200': (r) => r.status === 200 })) {
    ciclosFallidos.add(1);
    return;
  }

  sleep(0.3 + Math.random() * 0.5);

  // 5. DRIVER finaliza el viaje con distanceKm aleatorio entre 2 y 12
  const fin = llamar('POST', `/api/v1/trips/${id}/complete`, 'POST /api/v1/trips/:id/complete', tokenConductor, {
    distanceKm: Math.round((2 + Math.random() * 10) * 10) / 10,
  });
  if (!check(fin, { 'finalizar: 200': (r) => r.status === 200 })) {
    ciclosFallidos.add(1);
    return;
  }
  viajesCompletados.add(1);

  // 6. 20% de los viajes completados ejecutan lecturas de estado e historial
  if (Math.random() * 100 < PORCENTAJE_LECTURAS) {
    const detalle = llamar('GET', `/api/v1/trips/${id}`, 'GET /api/v1/trips/:id', tokenConductor);
    if (check(detalle, { 'obtener viaje: 200': (r) => r.status === 200 })) {
      lecturas.add(1);
    }

    const historial = llamar(
      'GET',
      `/api/v1/trips/${id}/history`,
      'GET /api/v1/trips/:id/history',
      tokenConductor,
    );
    if (check(historial, { 'obtener historial: 200': (r) => r.status === 200 })) {
      lecturas.add(1);
    }
  }
}
