import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';

export interface RequestUser {
  id: string;
  email: string;
  role: 'ADMIN' | 'USER';
}

export interface AuthedRequest extends Request {
  user?: RequestUser;
}

interface JwtPayload {
  sub: string;
  email: string;
  role: 'ADMIN' | 'USER';
}

function extractBearerToken(req: Request): string | undefined {
  const header = req.headers['authorization'];
  if (!header || typeof header !== 'string') return undefined;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : undefined;
}

type GuardMode = 'requiredUser' | 'requiredAdmin' | 'optional';

/**
 * JWT-based guards. ticket-mayo owns its end-user auth (HS256, 7d).
 * `JwtAuthGuard` requires a valid user token; `AdminAuthGuard` additionally
 * requires role==ADMIN; `OptionalUserAuthGuard` attaches the user when a valid
 * Bearer is present and allows anonymous access otherwise (used by /claim).
 */
@Injectable()
export abstract class BaseJwtAuthGuard implements CanActivate {
  protected abstract readonly mode: GuardMode;
  private readonly logger = new Logger(BaseJwtAuthGuard.name);

  constructor(protected readonly jwtService: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const token = extractBearerToken(req);

    if (!token) {
      if (this.mode === 'optional') {
        return true; // anonymous — no user attached
      }
      throw new UnauthorizedException('Missing Bearer token.');
    }

    let payload: JwtPayload;
    try {
      payload = await this.jwtService.verifyAsync<JwtPayload>(token);
    } catch {
      // A present-but-invalid token is always rejected, even in optional mode.
      throw new UnauthorizedException('Invalid or expired token.');
    }

    req.user = { id: payload.sub, email: payload.email, role: payload.role };

    if (this.mode === 'requiredAdmin' && payload.role !== 'ADMIN') {
      this.logger.warn(`admin-only access denied for user=${payload.sub} role=${payload.role}`);
      throw new ForbiddenException('Admin role required.');
    }
    return true;
  }
}

@Injectable()
export class JwtAuthGuard extends BaseJwtAuthGuard {
  protected readonly mode: GuardMode = 'requiredUser';
}

@Injectable()
export class AdminAuthGuard extends BaseJwtAuthGuard {
  protected readonly mode: GuardMode = 'requiredAdmin';
}

@Injectable()
export class OptionalUserAuthGuard extends BaseJwtAuthGuard {
  protected readonly mode: GuardMode = 'optional';
}
