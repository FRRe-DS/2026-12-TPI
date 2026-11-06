import { describe, it, expect } from 'vitest';
import {
  checkCancellationReason,
  requiresRedispatch,
  isCancellationReason,
} from '../src/domain/cancellation-rules.js';

describe('Reglas de cancelación (RF-6.6 / RF-6.7)', () => {
  const now = new Date('2026-11-02T12:00:00Z');
  const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);

  it('acepta un motivo que corresponde al rol', () => {
    expect(checkCancellationReason('CLIENT', 'CHANGE_OF_PLANS', null, now, 5)).toBeNull();
    expect(checkCancellationReason('DRIVER', 'VEHICLE_PROBLEM', null, now, 5)).toBeNull();
    expect(checkCancellationReason('OPERATOR', 'SECURITY_INCIDENT', null, now, 5)).toBeNull();
  });

  it('rechaza un motivo que no corresponde al rol', () => {
    expect(checkCancellationReason('CLIENT', 'VEHICLE_PROBLEM', null, now, 5)).not.toBeNull();
    expect(checkCancellationReason('DRIVER', 'CHANGE_OF_PLANS', null, now, 5)).not.toBeNull();
    expect(checkCancellationReason('OPERATOR', 'DRIVER_NO_SHOW', null, now, 5)).not.toBeNull();
  });

  it('CLIENT_NO_SHOW se rechaza antes de los 5 minutos del arribo', () => {
    expect(checkCancellationReason('DRIVER', 'CLIENT_NO_SHOW', minutesAgo(4), now, 5)).not.toBeNull();
  });

  it('CLIENT_NO_SHOW se acepta desde los 5 minutos del arribo', () => {
    expect(checkCancellationReason('DRIVER', 'CLIENT_NO_SHOW', minutesAgo(5), now, 5)).toBeNull();
    expect(checkCancellationReason('DRIVER', 'CLIENT_NO_SHOW', minutesAgo(30), now, 5)).toBeNull();
  });

  it('CLIENT_NO_SHOW se rechaza si el conductor todavía no arribó', () => {
    expect(checkCancellationReason('DRIVER', 'CLIENT_NO_SHOW', null, now, 5)).not.toBeNull();
  });

  it('requiresRedispatch: solo cuando cancela el conductor y no es CLIENT_NO_SHOW', () => {
    expect(requiresRedispatch('DRIVER', 'VEHICLE_PROBLEM')).toBe(true);
    expect(requiresRedispatch('DRIVER', 'OTHER')).toBe(true);
    expect(requiresRedispatch('DRIVER', 'CLIENT_NO_SHOW')).toBe(false);
    expect(requiresRedispatch('CLIENT', 'CHANGE_OF_PLANS')).toBe(false);
    expect(requiresRedispatch('OPERATOR', 'SECURITY_INCIDENT')).toBe(false);
  });

  it('isCancellationReason reconoce solo los motivos del contrato', () => {
    expect(isCancellationReason('OTHER')).toBe(true);
    expect(isCancellationReason('porque quiero')).toBe(false);
    expect(isCancellationReason(undefined)).toBe(false);
  });
});