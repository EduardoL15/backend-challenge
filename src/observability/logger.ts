import { hostname } from 'node:os';
import type { LoggerService, LogLevel } from '@nestjs/common';
import { trace } from '@opentelemetry/api';
import pino, { type DestinationStream, type Logger } from 'pino';
import { currentContext } from './context';

/**
 * Safety net: even if someone logs an object carrying money or a payload, it is censored.
 * Logs carry identifiers (correlationId, transactionId, walletId...) and outcomes, never
 * amounts, balances or full request/message bodies.
 */
export const REDACTED_PATHS = [
  'money',
  'amount',
  'balance',
  'initialBalance',
  'payload',
  'body',
  'data',
  '*.money',
  '*.amount',
  '*.balance',
  '*.initialBalance',
  '*.payload',
  '*.body',
  'headers.authorization',
  'req.headers.authorization',
];

export interface RootLoggerOptions {
  level: string;
  service: string;
  destination?: DestinationStream;
}

export function createRootLogger(options: RootLoggerOptions): Logger {
  return pino(
    {
      level: options.level,
      base: { service: options.service, instance: process.env.HOSTNAME ?? hostname() },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      messageKey: 'msg',
      redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },
      // Context fields + trace ids are attached to EVERY line automatically.
      mixin: () => {
        const span = trace.getActiveSpan()?.spanContext();
        return {
          ...currentContext(),
          ...(span && span.traceId !== '00000000000000000000000000000000'
            ? { traceId: span.traceId, spanId: span.spanId }
            : {}),
        };
      },
    },
    options.destination,
  );
}

/**
 * Adapts Nest's Logger API to pino, so every `new Logger('X').log(...)` in the code base
 * becomes a structured JSON line. Object messages are merged as fields.
 */
export class PinoNestLogger implements LoggerService {
  constructor(private readonly root: Logger) {}

  log(message: unknown, ...rest: unknown[]): void {
    this.write('info', message, rest);
  }
  error(message: unknown, ...rest: unknown[]): void {
    this.write('error', message, rest);
  }
  warn(message: unknown, ...rest: unknown[]): void {
    this.write('warn', message, rest);
  }
  debug(message: unknown, ...rest: unknown[]): void {
    this.write('debug', message, rest);
  }
  verbose(message: unknown, ...rest: unknown[]): void {
    this.write('trace', message, rest);
  }
  fatal(message: unknown, ...rest: unknown[]): void {
    this.write('fatal', message, rest);
  }

  setLogLevels(levels: LogLevel[]): void {
    if (levels.includes('debug') || levels.includes('verbose')) this.root.level = 'debug';
  }

  private write(level: pino.Level, message: unknown, rest: unknown[]): void {
    // Nest passes the context name as the LAST string argument.
    const context = typeof rest.at(-1) === 'string' ? (rest.at(-1) as string) : undefined;
    const stack =
      level === 'error' && typeof rest[0] === 'string' && rest.length > 1 ? rest[0] : undefined;
    if (message !== null && typeof message === 'object' && !(message instanceof Error)) {
      this.root[level]({ context, ...(message as Record<string, unknown>) });
    } else if (message instanceof Error) {
      this.root[level]({ context, err: message }, message.message);
    } else {
      this.root[level]({ context, ...(stack ? { stack } : {}) }, String(message));
    }
  }
}
