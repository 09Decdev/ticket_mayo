import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AdminAuthGuard } from './jwt-auth.guard';

/**
 * T7 supplement — unit test AdminAuthGuard (guard chặn endpoint
 * GET /admin/backfill/dry-run). Repo không có sẵn controller/e2e test
 * pattern (mọi spec hiện có là service-level), nên test guard trực tiếp
 * với mock JwtService + mock ExecutionContext — đúng contract của guard.
 */
describe('AdminAuthGuard (T7 dry-run endpoint)', () => {
  const makeCtx = (headers: Record<string, string>) => {
    const req = { headers, user: undefined as unknown };
    return {
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
  };

  const makeGuard = (verify: (t: string) => Promise<unknown>) => {
    const jwt = { verifyAsync: jest.fn(verify) } as unknown as JwtService;
    return { guard: new AdminAuthGuard(jwt), jwt: jwt as unknown as { verifyAsync: jest.Mock }, req: null };
  };

  it('không có token → 401 UnauthorizedException', async () => {
    const g = makeGuard(async () => ({}));
    const ctx = makeCtx({});
    await expect(g.guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('header sai format (không Bearer) → 401', async () => {
    const g = makeGuard(async () => ({}));
    const ctx = makeCtx({ authorization: 'Basic abc' });
    await expect(g.guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('token invalid/expired (verifyAsync throw) → 401', async () => {
    const g = makeGuard(async () => {
      throw new Error('jwt expired');
    });
    const ctx = makeCtx({ authorization: 'Bearer bad-token' });
    await expect(g.guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('token hợp lệ nhưng role=USER → 403 ForbiddenException', async () => {
    const g = makeGuard(async () => ({ sub: 'u1', email: 'u@x', role: 'USER' }));
    const ctx = makeCtx({ authorization: 'Bearer user-token' });
    await expect(g.guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  it('token ADMIN hợp lệ → true + req.user được attach (id/email/role)', async () => {
    const g = makeGuard(async () => ({ sub: 'admin-1', email: 'admin@x', role: 'ADMIN' }));
    const ctx = makeCtx({ authorization: 'Bearer admin-token' });
    const req = ctx.switchToHttp().getRequest<{ user?: { id: string; role: string } }>();
    await expect(g.guard.canActivate(ctx)).resolves.toBe(true);
    expect(g.jwt.verifyAsync).toHaveBeenCalledWith('admin-token');
    expect(req.user).toEqual({ id: 'admin-1', email: 'admin@x', role: 'ADMIN' });
  });
});
