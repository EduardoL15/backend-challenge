import { randomUUID } from 'node:crypto';
import {
  createParamDecorator,
  type ExecutionContext as NestExecutionContext,
  Injectable,
  type NestMiddleware,
} from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import type { ExecutionContext } from '../shared/application/ports';

export const CORRELATION_HEADER = 'x-correlation-id';
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

interface RequestWithContext extends Request {
  executionContext?: ExecutionContext;
}

/** Accepts a well-formed X-Correlation-Id from the caller or creates one; echoes it back. */
@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  use(req: RequestWithContext, res: Response, next: NextFunction): void {
    const incoming = req.header(CORRELATION_HEADER);
    const correlationId = incoming && SAFE_ID.test(incoming) ? incoming : randomUUID();
    const requestId = randomUUID();
    req.executionContext = { correlationId, causationId: requestId };
    res.setHeader('X-Correlation-Id', correlationId);
    next();
  }
}

/** Injects the ExecutionContext built by CorrelationMiddleware into a handler parameter. */
export const RequestContext = createParamDecorator(
  (_data: unknown, ctx: NestExecutionContext): ExecutionContext => {
    const req = ctx.switchToHttp().getRequest<RequestWithContext>();
    return req.executionContext ?? { correlationId: randomUUID() };
  },
);
