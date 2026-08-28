import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AuthedRequest, RequestUser } from '../guards/jwt-auth.guard';

/**
 * Injects the authenticated user (set by a JWT guard) or `undefined` when the
 * route allows optional auth (e.g. /claim).
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): RequestUser | undefined => {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    return req.user;
  },
);
