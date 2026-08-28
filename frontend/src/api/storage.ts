import type { ApiError } from './types';

const JWT_KEY = 'tm_access_token';
const REFRESH_KEY = 'tm_refresh_token';
const USER_KEY = 'tm_user';

export interface JwtPayload {
  sub?: string;
  email?: string;
  role?: string;
  roles?: string[];
  displayName?: string;
  exp?: number;
  iat?: number;
  [k: string]: unknown;
}

export function getJwt(): string | null {
  return localStorage.getItem(JWT_KEY);
}

export function setAuth(accessToken: string, refreshToken?: string, user?: unknown): void {
  localStorage.setItem(JWT_KEY, accessToken);
  if (refreshToken) localStorage.setItem(REFRESH_KEY, refreshToken);
  if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearAuth(): void {
  localStorage.removeItem(JWT_KEY);
  localStorage.removeItem(REFRESH_KEY);
  localStorage.removeItem(USER_KEY);
}

export function getStoredUser(): { id?: string; email?: string; role?: string; displayName?: string } | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function decodeJwt(token: string): JwtPayload | null {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const payloadB64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json =
      typeof atob === 'function'
        ? decodeURIComponent(
            atob(payloadB64)
              .split('')
              .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
              .join(''),
          )
        : null;
    if (!json) return null;
    return JSON.parse(json) as JwtPayload;
  } catch {
    return null;
  }
}

export function isJwtExpired(payload: JwtPayload): boolean {
  if (!payload.exp) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  return payload.exp <= nowSec;
}

export function isAdmin(payload: JwtPayload): boolean {
  if (payload.role === 'ADMIN' || payload.role === 'Admin') return true;
  if (Array.isArray(payload.roles)) {
    return payload.roles.includes('ADMIN') || payload.roles.includes('Admin');
  }
  return false;
}

export function asAxiosError(e: unknown): {
  response?: { status?: number; data?: any; headers?: any };
  message?: string;
} | null {
  if (e && typeof e === 'object' && 'isAxiosError' in e) {
    return e as any;
  }
  return null;
}

export function extractApiError(e: unknown): ApiError {
  const ax = asAxiosError(e);
  if (!ax) {
    return { message: e instanceof Error ? e.message : 'Lỗi không xác định' };
  }
  const data = ax.response?.data;
  const code =
    (data && (data.code || data.errorCode)) ||
    (typeof data === 'string' ? data : undefined);
  const message =
    (data && (data.message || data.error)) || ax.message || 'Yêu cầu thất bại';
  // T5: giữ kèm remaining/requested từ 409 quota body để UI format thân thiện.
  const remaining =
    data && typeof data === 'object' && typeof data.remaining === 'number'
      ? data.remaining
      : undefined;
  const requested =
    data && typeof data === 'object' && typeof data.requested === 'number'
      ? data.requested
      : undefined;
  return { status: ax.response?.status, code, message, remaining, requested };
}
