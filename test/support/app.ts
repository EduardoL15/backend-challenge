import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Server } from 'node:http';
import { TEST_DATABASE_URL } from './db';

export interface TestApp {
  app: INestApplication;
  baseUrl: string;
  close(): Promise<void>;
}

/** Boots the real AppModule (HTTP role only) against the test database on a random port. */
export async function startTestApp(env: Record<string, string> = {}): Promise<TestApp> {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    APP_ROLES: 'api',
    DATABASE_URL: TEST_DATABASE_URL,
    DB_POOL_MAX: '20',
    ...env,
  });
  // Imported lazily so the env above is in place before any module reads it.
  const { AppModule } = await import('../../src/app.module');
  const app = await NestFactory.create(AppModule, { logger: false });
  app.enableShutdownHooks();
  await app.listen(0, '127.0.0.1');
  const server = app.getHttpServer() as Server;
  const { port } = server.address() as AddressInfo;
  return {
    app,
    baseUrl: `http://127.0.0.1:${String(port)}`,
    close: () => app.close(),
  };
}

export interface ApiResponse<T = Record<string, unknown>> {
  status: number;
  body: T;
  headers: Headers;
}

export async function api<T = Record<string, unknown>>(
  baseUrl: string,
  method: string,
  path: string,
  options: { body?: unknown; headers?: Record<string, string>; rawBody?: string } = {},
): Promise<ApiResponse<T>> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...options.headers },
    ...(options.rawBody !== undefined
      ? { body: options.rawBody }
      : options.body !== undefined
        ? { body: JSON.stringify(options.body) }
        : {}),
  });
  const text = await res.text();
  return {
    status: res.status,
    body: (text ? JSON.parse(text) : {}) as T,
    headers: res.headers,
  };
}
