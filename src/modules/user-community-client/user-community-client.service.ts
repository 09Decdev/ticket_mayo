import { Injectable, Logger } from '@nestjs/common';
import { env } from '../../config/env';
import { normalizeEmailForLookup } from '../../common/utils/email-hash.util';

export interface UserCommunityLookupResult {
  id: string;
  email: string;
  displayName: string;
}

/**
 * HTTP client gọi user-community-service internal API.
 * Route: POST /user-community/users/lookup-by-emails (guard InternalService,
 * auth header `x-service-token` so khớp INTERNAL_SERVICE_TOKEN chung giữa các service).
 */
@Injectable()
export class UserCommunityClientService {
  private readonly logger = new Logger(UserCommunityClientService.name);
  private readonly baseUrl: string;
  private readonly token: string;

  constructor() {
    this.baseUrl = (env.USER_COMMUNITY_BASE_URL ?? 'http://localhost:3001').replace(/\/$/, '');
    this.token = env.INTERNAL_SERVICE_TOKEN ?? '';
    if (!this.token) {
      this.logger.warn(
        'INTERNAL_SERVICE_TOKEN chưa thiết lập — lookup displayName sẽ fail. ' +
          'Phải khớp INTERNAL_SERVICE_TOKEN của user-community-service.',
      );
    }
  }

  /**
   * Trao đổi 1 batch email → map<normalizedEmail, displayName>.
   * Fail gracefully: lỗi/timeout → trả map rỗng (caller fallback tên mặc định).
   */
  async lookupDisplayNames(emails: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (emails.length === 0) return out;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await globalThis.fetch(`${this.baseUrl}/user-community/users/lookup-by-emails`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'x-service-token': this.token,
        },
        body: JSON.stringify({ emails }),
      });
      if (!res.ok) {
        this.logger.warn(`lookup-by-emails → ${res.status}; fallback tên mặc định.`);
        return out;
      }
      const body = (await res.json()) as unknown;
      const rows = this.unwrap(body) as UserCommunityLookupResult[] | null;
      if (!Array.isArray(rows)) return out;
      for (const r of rows) {
        const key = normalizeEmailForLookup(r.email);
        if (key && r.displayName) out.set(key, r.displayName);
      }
      return out;
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        this.logger.warn('lookup-by-emails timeout; fallback tên mặc định.');
      } else {
        this.logger.warn(`lookup-by-emails transport error: ${(err as Error).message}`);
      }
      return out;
    } finally {
      clearTimeout(timeout);
    }
  }

  /** user-community có thể wrap response ({success,data}) hoặc trả array trực tiếp. */
  private unwrap(body: unknown): unknown {
    if (Array.isArray(body)) return body;
    if (body && typeof body === 'object') {
      const o = body as Record<string, unknown>;
      if (o.success === true && 'data' in o) return o.data;
      if ('data' in o) return o.data;
    }
    return null;
  }
}
