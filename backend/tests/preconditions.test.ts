import { describe, it, expect } from 'vitest';
import { parseIfMatch, assertIfMatch } from '../src/middlewares/preconditions.js';

function catchError(fn: () => void): any {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return null;
}

describe('If-Match', () => {
  it('sin header no exige nada', () => {
    expect(parseIfMatch(undefined)).toBeUndefined();
  });

  it('lee la versión de un ETag entre comillas', () => {
    expect(parseIfMatch('"3"')).toBe(3);
  });

  it('el asterisco acepta cualquier versión', () => {
    expect(parseIfMatch('*')).toBeUndefined();
  });

  it('un valor sin comillas es 400 VALIDATION', () => {
    const err = catchError(() => parseIfMatch('3'));
    expect(err).toMatchObject({ statusCode: 400, code: 'VALIDATION' });
  });

  it('una versión que coincide pasa', () => {
    expect(() => assertIfMatch(2, 2)).not.toThrow();
    expect(() => assertIfMatch(2, undefined)).not.toThrow();
  });

  it('una versión distinta es 412 PRECONDITION_FAILED y devuelve el ETag actual', () => {
    const err = catchError(() => assertIfMatch(2, 1));
    expect(err).toMatchObject({ statusCode: 412, code: 'PRECONDITION_FAILED' });
    expect(err.options.headers.ETag).toBe('"2"');
  });
});