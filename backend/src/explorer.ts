import "dotenv/config";
import http from "node:http";
import crypto from "node:crypto";
import { PrismaClient, TripState, ActorRole } from "../generated/prisma/client.js";

const prisma = new PrismaClient();
const PORT = 3006;

const VALID_TRANSITIONS: Record<TripState, TripState[]> = {
  PENDING_ARRIVAL: ["DRIVER_ARRIVED", "CANCELLED_BY_CLIENT", "CANCELLED_BY_DRIVER"],
  DRIVER_ARRIVED: ["IN_PROGRESS", "CANCELLED_BY_CLIENT", "CANCELLED_BY_DRIVER"],
  IN_PROGRESS: ["COMPLETED"],
  COMPLETED: [],
  CANCELLED_BY_CLIENT: [],
  CANCELLED_BY_DRIVER: [],
};

async function parseBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    });
  });
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);

  try {
    if (req.method === "GET" && url.pathname === "/api/data") {
      const trips = await prisma.trip.findMany({
        orderBy: { createdAt: "desc" },
        include: { events: { orderBy: { createdAt: "asc" } } },
      });
      const events = await prisma.tripEventHistory.findMany({
        orderBy: { createdAt: "desc" },
      });
      return sendJson(res, 200, { trips, events });
    }

    if (req.method === "POST" && url.pathname === "/api/seed") {
      const count = await prisma.trip.count();
      const req1 = crypto.randomUUID();
      const req2 = crypto.randomUUID();
      const req3 = crypto.randomUUID();

      const client1 = "c1111111-1111-4111-8111-111111111111";
      const driver1 = "d1111111-1111-4111-8111-111111111111";
      const vehicle1 = "a1111111-1111-4111-8111-111111111111";

      await prisma.$transaction(async (tx) => {
        const t1 = await tx.trip.create({
          data: {
            requestId: req1,
            clientId: client1,
            driverId: driver1,
            vehicleId: vehicle1,
            originLatitude: -27.4514,
            originLongitude: -58.9792,
            destinationLatitude: -27.4512,
            destinationLongitude: -58.9866,
            state: "COMPLETED",
            distanceKm: 1.8,
            durationMinutes: 7,
          },
        });
        await tx.tripEventHistory.createMany({
          data: [
            {
              tripId: t1.id,
              state: "PENDING_ARRIVAL",
              actorRole: "SYSTEM",
              metadata: { source: "M5_DISPATCH", requestId: req1 },
            },
            {
              tripId: t1.id,
              state: "DRIVER_ARRIVED",
              actorId: driver1,
              actorRole: "DRIVER",
            },
            {
              tripId: t1.id,
              state: "IN_PROGRESS",
              actorId: driver1,
              actorRole: "DRIVER",
              metadata: { qrVerifiedWithM8: true },
            },
            {
              tripId: t1.id,
              state: "COMPLETED",
              actorId: driver1,
              actorRole: "DRIVER",
              metadata: { distanceKm: 1.8, durationMinutes: 7 },
            },
          ],
        });

        const t2 = await tx.trip.create({
          data: {
            requestId: req2,
            clientId: "c2222222-2222-4222-8222-222222222222",
            driverId: "d2222222-2222-4222-8222-222222222222",
            vehicleId: "a2222222-2222-4222-8222-222222222222",
            originLatitude: -27.4411,
            originLongitude: -58.9652,
            destinationLatitude: -27.4321,
            destinationLongitude: -58.9588,
            state: "PENDING_ARRIVAL",
          },
        });
        await tx.tripEventHistory.create({
          data: {
            tripId: t2.id,
            state: "PENDING_ARRIVAL",
            actorRole: "SYSTEM",
            metadata: { source: "M5_DISPATCH", requestId: req2 },
          },
        });

        const client3 = "c3333333-3333-4333-8333-333333333333";
        const t3 = await tx.trip.create({
          data: {
            requestId: req3,
            clientId: client3,
            driverId: "d3333333-3333-4333-8333-333333333333",
            vehicleId: "a3333333-3333-4333-8333-333333333333",
            originLatitude: -27.4605,
            originLongitude: -58.9831,
            destinationLatitude: -27.4712,
            destinationLongitude: -58.9915,
            state: "CANCELLED_BY_CLIENT",
          },
        });
        await tx.tripEventHistory.createMany({
          data: [
            {
              tripId: t3.id,
              state: "PENDING_ARRIVAL",
              actorRole: "SYSTEM",
              metadata: { source: "M5_DISPATCH", requestId: req3 },
            },
            {
              tripId: t3.id,
              state: "CANCELLED_BY_CLIENT",
              actorId: client3,
              actorRole: "CLIENT",
              reason: "Demora excesiva del conductor asignado",
            },
          ],
        });
      });

      return sendJson(res, 201, { message: "Datos de prueba insertados correctamente", previousCount: count });
    }

    if (req.method === "POST" && url.pathname === "/api/trips") {
      const body = await parseBody(req);
      const requestId = body.requestId || crypto.randomUUID();
      const clientId = body.clientId || crypto.randomUUID();
      const driverId = body.driverId || crypto.randomUUID();
      const vehicleId = body.vehicleId || crypto.randomUUID();
      const originLatitude = Number(body.originLatitude ?? -27.4514);
      const originLongitude = Number(body.originLongitude ?? -58.9792);
      const destinationLatitude = Number(body.destinationLatitude ?? -27.4512);
      const destinationLongitude = Number(body.destinationLongitude ?? -58.9866);

      const existing = await prisma.trip.findUnique({ where: { requestId } });
      if (existing) {
        const samePayload =
          existing.clientId === clientId &&
          existing.driverId === driverId &&
          existing.vehicleId === vehicleId &&
          existing.originLatitude === originLatitude &&
          existing.originLongitude === originLongitude &&
          existing.destinationLatitude === destinationLatitude &&
          existing.destinationLongitude === destinationLongitude;

        if (samePayload) {
          return sendJson(res, 200, {
            idempotentReplay: true,
            message: "Idempotencia (200 OK): Ya existía un viaje con este requestId y mismos datos. No se duplicó.",
            trip: existing,
          });
        } else {
          return sendJson(res, 409, {
            error: "CONFLICT_REQUEST_ID",
            message: "Conflicto (409): El requestId ya existe en la BD pero con datos diferentes.",
          });
        }
      }

      const created = await prisma.$transaction(async (tx) => {
        const trip = await tx.trip.create({
          data: {
            requestId,
            clientId,
            driverId,
            vehicleId,
            originLatitude,
            originLongitude,
            destinationLatitude,
            destinationLongitude,
            state: "PENDING_ARRIVAL",
          },
        });
        await tx.tripEventHistory.create({
          data: {
            tripId: trip.id,
            state: "PENDING_ARRIVAL",
            actorRole: "SYSTEM",
            metadata: { source: "M5_DISPATCH", requestId },
          },
        });
        return trip;
      });

      return sendJson(res, 201, { idempotentReplay: false, trip: created });
    }

    if (req.method === "POST" && url.pathname === "/api/transition") {
      const body = await parseBody(req);
      const { tripId, targetState, reason, distanceKm, durationMinutes } = body;

      const trip = await prisma.trip.findUnique({ where: { id: tripId } });
      if (!trip) return sendJson(res, 404, { error: "Viaje no encontrado" });

      const allowed = VALID_TRANSITIONS[trip.state] || [];
      if (!allowed.includes(targetState)) {
        return sendJson(res, 409, {
          error: "INVALID_STATE_TRANSITION",
          message: `Transición inválida: No se puede pasar de ${trip.state} a ${targetState} (RF-6.1).`,
        });
      }

      const actorRole: ActorRole =
        targetState === "CANCELLED_BY_CLIENT" ? "CLIENT" : "DRIVER";
      const actorId =
        targetState === "CANCELLED_BY_CLIENT" ? trip.clientId : trip.driverId;

      const updated = await prisma.$transaction(async (tx) => {
        const u = await tx.trip.update({
          where: { id: tripId },
          data: {
            state: targetState,
            ...(targetState === "COMPLETED"
              ? {
                  distanceKm: Number(distanceKm ?? 3.4),
                  durationMinutes: Number(durationMinutes ?? 12),
                }
              : {}),
          },
        });

        await tx.tripEventHistory.create({
          data: {
            tripId,
            state: targetState,
            actorId,
            actorRole,
            reason: reason || null,
            metadata:
              targetState === "COMPLETED"
                ? { distanceKm: u.distanceKm, durationMinutes: u.durationMinutes }
                : targetState === "IN_PROGRESS"
                ? { qrValidatedWithM8: true }
                : undefined,
          },
        });

        return u;
      });

      return sendJson(res, 200, { trip: updated });
    }

    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(HTML_PAGE);
    }

    sendJson(res, 404, { error: "Ruta no encontrada" });
  } catch (err: any) {
    sendJson(res, 500, { error: err?.message || "Error interno" });
  }
});

const HTML_PAGE = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Módulo M6 — Explorador de Persistencia y Ciclo de Vida</title>
  <style>
    :root {
      --bg: #0b0f19;
      --surface: #111827;
      --surface-2: #1f2937;
      --border: #374151;
      --text: #f9fafb;
      --muted: #9ca3af;
      --accent: #3b82f6;
      --accent-hover: #2563eb;
      --success: #10b981;
      --warning: #f59e0b;
      --danger: #ef4444;
      --purple: #8b5cf6;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
      background: var(--bg);
      color: var(--text);
      padding: 24px;
      line-height: 1.5;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%);
      border: 1px solid var(--border);
      padding: 20px 24px;
      border-radius: 14px;
      margin-bottom: 24px;
      flex-wrap: wrap;
      gap: 16px;
    }
    .header h1 { font-size: 1.35rem; font-weight: 700; display: flex; align-items: center; gap: 10px; }
    .header p { color: var(--muted); font-size: 0.9rem; margin-top: 4px; }
    .badge-db {
      background: rgba(16, 185, 129, 0.15);
      color: #34d399;
      border: 1px solid rgba(16, 185, 129, 0.4);
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 0.75rem;
      font-weight: 600;
    }
    .actions-bar { display: flex; gap: 10px; flex-wrap: wrap; }
    button {
      background: var(--accent);
      color: white;
      border: none;
      padding: 9px 15px;
      border-radius: 8px;
      font-weight: 600;
      font-size: 0.85rem;
      cursor: pointer;
      transition: all 0.15s;
    }
    button:hover { background: var(--accent-hover); transform: translateY(-1px); }
    button.secondary { background: var(--surface-2); border: 1px solid var(--border); color: var(--text); }
    button.secondary:hover { background: #374151; }
    button.success { background: var(--success); }
    button.warning { background: var(--warning); color: #111827; }
    button.danger { background: var(--danger); }
    button.sm { padding: 5px 10px; font-size: 0.75rem; border-radius: 6px; }

    .stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 14px;
      margin-bottom: 24px;
    }
    .stat-card {
      background: var(--surface);
      border: 1px solid var(--border);
      padding: 16px;
      border-radius: 12px;
    }
    .stat-card .label { color: var(--muted); font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; }
    .stat-card .val { font-size: 1.7rem; font-weight: 700; margin-top: 4px; }

    .toast {
      display: none;
      padding: 12px 18px;
      border-radius: 10px;
      margin-bottom: 20px;
      font-weight: 500;
      font-size: 0.9rem;
    }
    .toast.ok { display: block; background: rgba(16, 185, 129, 0.15); border: 1px solid var(--success); color: #6ee7b7; }
    .toast.err { display: block; background: rgba(239, 68, 68, 0.15); border: 1px solid var(--danger); color: #fca5a5; }

    .section {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 14px;
      margin-bottom: 24px;
      overflow: hidden;
    }
    .section-header {
      padding: 16px 20px;
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: rgba(255,255,255,0.02);
    }
    .section-header h2 { font-size: 1.05rem; display: flex; align-items: center; gap: 8px; }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; text-align: left; font-size: 0.84rem; }
    th {
      background: #0f172a;
      color: var(--muted);
      font-weight: 600;
      padding: 12px 14px;
      border-bottom: 1px solid var(--border);
      white-space: nowrap;
    }
    td {
      padding: 12px 14px;
      border-bottom: 1px solid rgba(55, 65, 81, 0.5);
      vertical-align: middle;
    }
    tr:hover td { background: rgba(255, 255, 255, 0.02); }
    .mono {
      font-family: 'Cascadia Code', 'Fira Code', monospace;
      font-size: 0.78rem;
      background: rgba(255,255,255,0.06);
      padding: 3px 6px;
      border-radius: 5px;
      color: #cbd5e1;
    }
    .state-badge {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 0.73rem;
      font-weight: 700;
      letter-spacing: 0.02em;
    }
    .st-PENDING_ARRIVAL { background: rgba(245, 158, 11, 0.18); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.4); }
    .st-DRIVER_ARRIVED { background: rgba(59, 130, 246, 0.18); color: #60a5fa; border: 1px solid rgba(59, 130, 246, 0.4); }
    .st-IN_PROGRESS { background: rgba(139, 92, 246, 0.2); color: #c084fc; border: 1px solid rgba(139, 92, 246, 0.45); }
    .st-COMPLETED { background: rgba(16, 185, 129, 0.18); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.4); }
    .st-CANCELLED_BY_CLIENT, .st-CANCELLED_BY_DRIVER { background: rgba(239, 68, 68, 0.18); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.4); }

    .transition-btns { display: flex; gap: 6px; flex-wrap: wrap; }
    .empty { padding: 32px; text-align: center; color: var(--muted); }
  </style>
</head>
<body>

  <div class="header">
    <div>
      <h1>
        🚕 Módulo M6: Persistencia PostgreSQL + Prisma ORM
        <span class="badge-db">● PostgreSQL :5433 Conectado</span>
      </h1>
      <p>Grupo 12 — Desarrollo de Software 2026 | Inspección en vivo de tablas <code>Trip</code> y <code>TripEventHistory</code> (Inmutable)</p>
    </div>
    <div class="actions-bar">
      <button onclick="seedData()">✨ Cargar 3 Viajes de Prueba (Seed)</button>
      <button class="success" onclick="createNewTrip()">➕ Nuevo Viaje (M5)</button>
      <button class="secondary" onclick="testIdempotency()">🔁 Probar Idempotencia (requestId)</button>
      <button class="secondary" onclick="loadData()">🔄 Actualizar</button>
    </div>
  </div>

  <div id="toast" class="toast"></div>

  <div class="stats">
    <div class="stat-card">
      <div class="label">Total Viajes (Tabla Trip)</div>
      <div class="val" id="st-total">0</div>
    </div>
    <div class="stat-card">
      <div class="label">Viajes Activos</div>
      <div class="val" id="st-active" style="color:#60a5fa">0</div>
    </div>
    <div class="stat-card">
      <div class="label">Completados</div>
      <div class="val" id="st-completed" style="color:#34d399">0</div>
    </div>
    <div class="stat-card">
      <div class="label">Eventos de Auditoría (Append-Only)</div>
      <div class="val" id="st-events" style="color:#c084fc">0</div>
    </div>
  </div>

  <div class="section">
    <div class="section-header">
      <h2>📋 Tabla 1: <code>Trip</code> (Cabecera y Estado Vigente)</h2>
      <span style="color:var(--muted);font-size:0.8rem">PK: <code>id (UUID)</code> | UK: <code>requestId (UUID @unique)</code></span>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>ID Viaje (PK)</th>
            <th>Request ID (M5 @unique)</th>
            <th>Estado Actual</th>
            <th>Cliente / Conductor / Vehículo</th>
            <th>Origen &rarr; Destino (Lat, Lng)</th>
            <th>Métricas</th>
            <th>Transiciones Válidas (RF-6.1)</th>
          </tr>
        </thead>
        <tbody id="trips-body"></tbody>
      </table>
    </div>
  </div>

  <div class="section">
    <div class="section-header">
      <h2>🔒 Tabla 2: <code>TripEventHistory</code> (Historial de Auditoría Inmutable - RF-6.8)</h2>
      <span style="color:var(--muted);font-size:0.8rem">FK: <code>tripId</code> (ON DELETE RESTRICT) | Índice: <code>(tripId, createdAt)</code></span>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Fecha / Hora (createdAt)</th>
            <th>ID Evento (PK)</th>
            <th>Trip ID (FK)</th>
            <th>Estado Transicionado</th>
            <th>Rol Actor</th>
            <th>Actor ID</th>
            <th>Motivo / Metadata (JSONB)</th>
          </tr>
        </thead>
        <tbody id="events-body"></tbody>
      </table>
    </div>
  </div>

  <script>
    let lastTrip = null;

    function showToast(msg, isErr = false) {
      const el = document.getElementById('toast');
      el.className = 'toast ' + (isErr ? 'err' : 'ok');
      el.innerText = msg;
      setTimeout(() => { el.className = 'toast'; }, 6000);
    }

    function shortUuid(u) {
      if (!u) return '—';
      return u.slice(0, 8) + '…';
    }

    async function loadData() {
      const res = await fetch('/api/data');
      const { trips, events } = await res.json();
      if (trips.length > 0) lastTrip = trips[0];

      document.getElementById('st-total').innerText = trips.length;
      document.getElementById('st-active').innerText = trips.filter(t => ['PENDING_ARRIVAL','DRIVER_ARRIVED','IN_PROGRESS'].includes(t.state)).length;
      document.getElementById('st-completed').innerText = trips.filter(t => t.state === 'COMPLETED').length;
      document.getElementById('st-events').innerText = events.length;

      const tbody = document.getElementById('trips-body');
      if (trips.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="empty">No hay viajes en la base de datos. Hacé clic en <b>"✨ Cargar 3 Viajes de Prueba"</b> arriba a la derecha.</td></tr>';
      } else {
        tbody.innerHTML = trips.map(t => {
          let btns = '';
          if (t.state === 'PENDING_ARRIVAL') {
            btns = \`
              <button class="sm" onclick="transition('\${t.id}', 'DRIVER_ARRIVED')">📍 Llego </button>
              <button class="sm danger" onclick="transition('\${t.id}', 'CANCELLED_BY_CLIENT', 'Cancelado por el pasajero')">✖ Cancelo Cliente</button>
              <button class="sm warning" onclick="transition('\${t.id}', 'CANCELLED_BY_DRIVER', 'Desperfecto mecánico')">✖ Cancelo conductor</button>
            \`;
          } else if (t.state === 'DRIVER_ARRIVED') {
            btns = \`
              <button class="sm success" onclick="transition('\${t.id}', 'IN_PROGRESS')">▶ Validar QR e Iniciar</button>
              <button class="sm danger" onclick="transition('\${t.id}', 'CANCELLED_BY_CLIENT', 'Cancelado por el pasajero')">✖ Cancelo Cliente</button>
            \`;
          } else if (t.state === 'IN_PROGRESS') {
            btns = \`
              <button class="sm success" onclick="transition('\${t.id}', 'COMPLETED')">🏁 Finalizar Viaje (km/min)</button>
            \`;
          } else {
            btns = '<span style="color:var(--muted);font-size:0.78rem">🔒 Estado Terminal</span>';
          }

          return \`<tr>
            <td><span class="mono" title="\${t.id}">\${shortUuid(t.id)}</span></td>
            <td><span class="mono" title="\${t.requestId}">\${shortUuid(t.requestId)}</span></td>
            <td><span class="state-badge st-\${t.state}">\${t.state}</span></td>
            <td style="font-size:0.78rem;color:var(--muted)">
              👤 C: <span class="mono" title="\${t.clientId}">\${shortUuid(t.clientId)}</span><br/>
              🛞 D: <span class="mono" title="\${t.driverId}">\${shortUuid(t.driverId)}</span>
            </td>
            <td style="font-size:0.8rem">
              🟢 (\${t.originLatitude}, \${t.originLongitude})<br/>
              🔴 (\${t.destinationLatitude}, \${t.destinationLongitude})
            </td>
            <td>\${t.distanceKm != null ? \`<b>\${t.distanceKm} km</b> / \${t.durationMinutes} min\` : '<span style="color:var(--muted)">—</span>'}</td>
            <td><div class="transition-btns">\${btns}</div></td>
          </tr>\`;
        }).join('');
      }

      const ebody = document.getElementById('events-body');
      if (events.length === 0) {
        ebody.innerHTML = '<tr><td colspan="7" class="empty">Sin eventos registrados.</td></tr>';
      } else {
        ebody.innerHTML = events.map(e => \`<tr>
          <td style="color:var(--muted);white-space:nowrap">\${new Date(e.createdAt).toLocaleString('es-AR')}</td>
          <td><span class="mono" title="\${e.id}">\${shortUuid(e.id)}</span></td>
          <td><span class="mono" title="\${e.tripId}">\${shortUuid(e.tripId)}</span></td>
          <td><span class="state-badge st-\${e.state}">\${e.state}</span></td>
          <td><b>\${e.actorRole}</b></td>
          <td><span class="mono" title="\${e.actorId || ''}">\${shortUuid(e.actorId)}</span></td>
          <td style="font-size:0.8rem">
            \${e.reason ? \`<div>💬 <b>Motivo:</b> \${e.reason}</div>\` : ''}
            \${e.metadata ? \`<span class="mono">\${JSON.stringify(e.metadata)}</span>\` : ''}
          </td>
        </tr>\`).join('');
      }
    }

    async function seedData() {
      const res = await fetch('/api/seed', { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        showToast('✅ Se insertaron 3 viajes y sus eventos de auditoría en PostgreSQL.');
        loadData();
      } else {
        showToast('❌ ' + (data.error || 'Error'), true);
      }
    }

    async function createNewTrip() {
      const res = await fetch('/api/trips', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({}) });
      const data = await res.json();
      if (res.ok) {
        showToast('✅ Viaje creado en estado PENDING_ARRIVAL (201 Created) con su evento inicial en TripEventHistory.');
        loadData();
      } else {
        showToast('❌ ' + (data.message || data.error), true);
      }
    }

    async function testIdempotency() {
      if (!lastTrip) {
        return showToast('Primero creá o cargá al menos un viaje para probar reenviar su mismo requestId.', true);
      }
      const res = await fetch('/api/trips', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({
          requestId: lastTrip.requestId,
          clientId: lastTrip.clientId,
          driverId: lastTrip.driverId,
          vehicleId: lastTrip.vehicleId,
          originLatitude: lastTrip.originLatitude,
          originLongitude: lastTrip.originLongitude,
          destinationLatitude: lastTrip.destinationLatitude,
          destinationLongitude: lastTrip.destinationLongitude,
        })
      });
      const data = await res.json();
      showToast('🛡️ ' + data.message, !res.ok);
    }

    async function transition(tripId, targetState, reason = null) {
      const res = await fetch('/api/transition', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ tripId, targetState, reason })
      });
      const data = await res.json();
      if (res.ok) {
        showToast(\`✅ Transición aplicada: Viaje pasó a \${targetState} y se agregó fila inmutable en TripEventHistory.\`);
        loadData();
      } else {
        showToast('❌ ' + (data.message || data.error), true);
      }
    }

    loadData();
  </script>
</body>
</html>`;

server.listen(PORT, () => {
  console.log(`\n🚀 Panel Visual de Persistencia M6 corriendo en: http://localhost:${PORT}\n`);
});
