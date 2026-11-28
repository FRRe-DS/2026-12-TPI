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

describe('GET /health/details: RabbitMQ y outbox', () => {
  const dbOk = async () => true;
  const brokerOk = async () => {};
  const stats = (pending: number, oldestPendingSeconds: number) => async () => ({
    pending,
    oldestPendingSeconds,
  });

  it('con el broker respondiendo y sin atrasos: OK', async () => {
    const service = new HealthService(dbOk, 100, { checkBroker: brokerOk, outboxStats: stats(0, 0) });
    const { statusCode, report } = await service.getDetails();

    expect(statusCode).toBe(200);
    expect(report.status).toBe('OK');
    expect(report.components.rabbitmq.status).toBe('OK');
    expect(report.outbox).toEqual({ pending: 0, oldestPendingSeconds: 0 });
  });

  it('si el broker falla: 200 DEGRADED y sin exponer el error', async () => {
    const service = new HealthService(dbOk, 100, {
      checkBroker: async () => {
        throw new Error('ACCESS_REFUSED amqp://m6:secreto@broker:5672');
      },
      outboxStats: stats(0, 0),
    });
    const { statusCode, report } = await service.getDetails();

    expect(statusCode).toBe(200);
    expect(report.status).toBe('DEGRADED');
    expect(report.components.rabbitmq.status).toBe('ERROR');
    expect(report.components.rabbitmq.detail).toBeUndefined();
    expect(JSON.stringify(report)).not.toContain('secreto');
  });

  it('si el broker no responde dentro del plazo: DEGRADED', async () => {
    const service = new HealthService(dbOk, 20, {
      checkBroker: () => new Promise(() => {}),
      outboxStats: stats(0, 0),
    });
    const { report } = await service.getDetails();

    expect(report.status).toBe('DEGRADED');
    expect(report.components.rabbitmq.status).toBe('ERROR');
  });

  it('sin broker y sin pendientes: OK y NOT_CONFIGURED', async () => {
    const service = new HealthService(dbOk, 100, { outboxStats: stats(0, 0) });
    const { report } = await service.getDetails();

    expect(report.status).toBe('OK');
    expect(report.components.rabbitmq).toEqual({ status: 'NOT_CONFIGURED' });
  });

  it('con un evento esperando mas de 60 s: DEGRADED', async () => {
    const service = new HealthService(dbOk, 100, { outboxStats: stats(1, 61) });
    const { statusCode, report } = await service.getDetails();

    expect(statusCode).toBe(200);
    expect(report.status).toBe('DEGRADED');
    expect(report.outbox).toEqual({ pending: 1, oldestPendingSeconds: 61 });
  });

  it('con un evento esperando exactamente 60 s: todavia OK', async () => {
    const service = new HealthService(dbOk, 100, { outboxStats: stats(1, 60) });
    const { report } = await service.getDetails();

    expect(report.status).toBe('OK');
  });

  it('con la base caida: ERROR, outbox null y sin consultarla', async () => {
    const outboxStats = vi.fn(stats(1, 61));
    const service = new HealthService(
      async () => {
        throw new Error('connection refused');
      },
      100,
      { checkBroker: brokerOk, outboxStats }
    );
    const { statusCode, report } = await service.getDetails();

    expect(statusCode).toBe(503);
    expect(report.status).toBe('ERROR');
    expect(report.outbox).toBeNull();
    expect(outboxStats).not.toHaveBeenCalled();
  });

  it('si falla la consulta de la outbox: outbox null', async () => {
    const service = new HealthService(dbOk, 100, {
      outboxStats: async () => {
        throw new Error('fallo la consulta');
      },
    });
    const { statusCode, report } = await service.getDetails();

    expect(statusCode).toBe(200);
    expect(report.outbox).toBeNull();
  });
});