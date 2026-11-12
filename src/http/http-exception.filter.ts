import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  ApplicationError,
  ConflictError,
  NotFoundError,
  TransientInfrastructureError,
  ValidationError,
} from '../shared/application/errors';
import { DomainError } from '../shared/domain/errors';
import { FailureCode } from '../shared/domain/failure-code';

export interface ErrorBody {
  error: {
    code: string;
    message: string;
    retryable: boolean;
    details?: { path: string; message: string }[];
  };
}

/** Domain errors that describe a malformed request rather than a business rejection. */
const CONTRACT_CODES = new Set<string>([
  FailureCode.InvalidPayload,
  FailureCode.InvalidAmount,
  FailureCode.InternalKindNotAllowed,
]);

export const TRANSIENT_RETRY_AFTER_SECONDS = 1;

/**
 * One consistent mapping for every endpoint. `retryable` tells the provider, without parsing
 * the message, whether resending the same request (same Idempotency-Key) can succeed.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const [status, body] = this.map(exception);
    if (status === 503) {
      res.setHeader('Retry-After', String(TRANSIENT_RETRY_AFTER_SECONDS));
    }
    if (status >= 500) {
      this.logger.error({
        msg: 'Request failed',
        status,
        code: body.error.code,
        error: exception instanceof Error ? exception.message : String(exception),
        stack: exception instanceof Error ? exception.stack : undefined,
      });
    }
    res.status(status).json(body);
  }

  private map(exception: unknown): [number, ErrorBody] {
    if (exception instanceof ValidationError) {
      return [
        HttpStatus.BAD_REQUEST,
        body(exception.code, exception.message, false, exception.issues),
      ];
    }
    if (exception instanceof DomainError) {
      return CONTRACT_CODES.has(exception.code)
        ? [HttpStatus.BAD_REQUEST, body(exception.code, exception.message, false)]
        : [HttpStatus.UNPROCESSABLE_ENTITY, body(exception.code, exception.message, false)];
    }
    if (exception instanceof NotFoundError) {
      return [HttpStatus.NOT_FOUND, body(exception.code, exception.message, false)];
    }
    if (exception instanceof ConflictError) {
      return [HttpStatus.CONFLICT, body(exception.code, exception.message, false)];
    }
    if (exception instanceof TransientInfrastructureError) {
      return [
        HttpStatus.SERVICE_UNAVAILABLE,
        body(exception.code, 'Temporarily unavailable, retry with the same Idempotency-Key', true),
      ];
    }
    if (exception instanceof ApplicationError) {
      return [HttpStatus.INTERNAL_SERVER_ERROR, body('INTERNAL_ERROR', 'Internal error', false)];
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      // Malformed JSON body (express body-parser) and similar framework-level 4xx.
      const code =
        status === 404
          ? 'ROUTE_NOT_FOUND'
          : status < 500
            ? FailureCode.InvalidPayload
            : 'INTERNAL_ERROR';
      return [status, body(code, exception.message, status >= 500)];
    }
    if (isBodyParserError(exception)) {
      return [
        HttpStatus.BAD_REQUEST,
        body(FailureCode.InvalidPayload, 'Malformed JSON body', false),
      ];
    }
    return [HttpStatus.INTERNAL_SERVER_ERROR, body('INTERNAL_ERROR', 'Internal error', false)];
  }
}

function body(
  code: string,
  message: string,
  retryable: boolean,
  details?: { path: string; message: string }[],
): ErrorBody {
  return { error: { code, message, retryable, ...(details?.length ? { details } : {}) } };
}

function isBodyParserError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { type?: unknown }).type === 'entity.parse.failed'
  );
}
