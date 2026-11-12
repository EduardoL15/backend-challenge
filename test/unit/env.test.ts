import { describe, expect, it } from 'bun:test';
import { loadEnv } from '../../src/config/env';

const base = { DATABASE_URL: 'postgres://u:p@localhost:5432/db' };

describe('loadEnv', () => {
  it('parses APP_ROLES as a list', () => {
    expect(loadEnv({ ...base, APP_ROLES: 'api, outbox' }).APP_ROLES).toEqual(['api', 'outbox']);
  });

  it('defaults to all roles', () => {
    expect(loadEnv(base).APP_ROLES).toEqual(['api', 'consumer', 'outbox', 'pending']);
  });

  it('rejects unknown roles', () => {
    expect(() => loadEnv({ ...base, APP_ROLES: 'api,bogus' })).toThrow();
  });

  it('requires DATABASE_URL', () => {
    expect(() => loadEnv({})).toThrow();
  });
});
