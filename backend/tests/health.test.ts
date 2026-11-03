import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HealthService } from '../src/services/health.service.js';

beforeEach(() => {
  // El servicio registra en consola los fallos reales; se silencia para no ensuciar la salida.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('GET /health/details: servicio', () => {
  it('con la base respondiendo: 200 y status OK', async () => {
    const service = new HealthService(async () => true);
    const { statusCode, report } = await service.getDetails();

    expect(statusCode).toBe(200);
    expect(report.status).toBe('OK');
    expect(report.components.postgres.status).toBe('OK');
    expect(typeof report.components.postgres.latencyMs).toBe('number');
    expect(report.components.rabbitmq).toEqual({ status: 'NOT_CONFIGURED' });
    expect(report.components.redis).toEqual({ status: 'NOT_CONFIGURED' });
    expect(report.outbox).toBeNull();
    expect(typeof report.version).toBe('string');
    expect(new Date(report.upSince).toString()).not.toBe('Invalid Date');
  });

  it('con la base caída: 503, status ERROR y sin exponer el mensaje original', async () => {
    const service = new HealthService(async () => {
      throw new Error('connect ECONNREFUSED postgresql://m6user:secreto@localhost:5433/m6_trips');
    });
    const { statusCode, report } = await service.getDetails();

    expect(statusCode).toBe(503);
    expect(report.status).toBe('ERROR');
    expect(report.components.postgres.status).toBe('ERROR');
    expect(report.outbox).toBeNull();
    const text = JSON.stringify(report);
    expect(text).not.toContain('secreto');
    expect(text).not.toContain('m6user');
  });

  it('si la base no responde dentro del plazo: 503 con detalle de timeout', async () => {
    const service = new HealthService(() => new Promise(() => {}), 20);
    const { statusCode, report } = await service.getDetails();

    expect(statusCode).toBe(503);
    expect(report.components.postgres.status).toBe('ERROR');
    expect(report.components.postgres.detail).toContain('Sin respuesta');
  });
});