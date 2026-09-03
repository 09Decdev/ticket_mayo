import axios, { AxiosError, AxiosInstance } from 'axios';
import { asAxiosError, clearAuth, extractApiError, getJwt } from './storage';
import type {
  ApiError,
  AttendanceStats,
  AuthResponse,
  CheckInResult,
  ClaimResult,
  DistributionJob,
  DistributionStatusResp,
  Event,
  OverviewStats,
  TicketType,
  TicketView,
} from './types';

const TICKET_BASE = (import.meta.env.VITE_TICKET_API_BASE as string | undefined) || '';
const PREFIX = '/ticket-mayo';

if (!TICKET_BASE) {
  // eslint-disable-next-line no-console
  console.warn('[ticket-mayo] VITE_TICKET_API_BASE chua cau hinh');
}

export const http: AxiosInstance = axios.create({
  baseURL: TICKET_BASE + PREFIX,
  timeout: 30000,
  headers: { 'Content-Type': 'application/json' },
});

http.interceptors.request.use((config) => {
  const token = getJwt();
  if (token) {
    config.headers = config.headers || {};
    (config.headers as any).Authorization = `Bearer ${token}`;
  }
  return config;
});

http.interceptors.response.use(
  (r) => r,
  (error: AxiosError) => {
    if (error.response?.status === 401) {
      clearAuth();
      if (typeof window !== 'undefined') {
        const path = window.location.pathname;
        // Redirect theo khu vực: portal user → /portal/login, admin → /admin/login.
        if (path.startsWith('/portal') && !path.startsWith('/portal/login')) {
          const next = encodeURIComponent(window.location.pathname + window.location.search);
          window.location.assign(`/portal/login?next=${next}`);
        } else if (!path.startsWith('/admin/login')) {
          window.location.assign('/admin/login');
        }
      }
    }
    return Promise.reject(error);
  },
);

function unwrap<T>(promise: Promise<{ data: T }>): Promise<T> {
  return promise.then((r) => r.data);
}

function qs(params?: Record<string, string | number | boolean | undefined | null>): string {
  if (!params) return '';
  const pairs: string[] = [];
  for (const k of Object.keys(params)) {
    const v = params[k];
    if (v === undefined || v === null || v === '') continue;
    pairs.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return pairs.length ? '?' + pairs.join('&') : '';
}

function toApiError(e: unknown): ApiError {
  return extractApiError(e);
}

export const ticketClient = {
  async health(): Promise<{ status?: string }> {
    try {
      return await unwrap<{ status?: string }>(http.get('/health'));
    } catch (e) {
      throw toApiError(e);
    }
  },

  async register(body: { email: string; password: string; displayName?: string }): Promise<AuthResponse> {
    try {
      return await unwrap<AuthResponse>(http.post('/auth/register', body));
    } catch (e) {
      throw toApiError(e);
    }
  },
  async login(body: { email: string; password: string }): Promise<AuthResponse> {
    try {
      return await unwrap<AuthResponse>(http.post('/auth/login', body));
    } catch (e) {
      throw toApiError(e);
    }
  },

  async listEvents(search?: string): Promise<Event[]> {
    try {
      const res: any = await unwrap<unknown>(http.get(`/admin/events${qs({ search })}`));
      return Array.isArray(res) ? res : (res?.data ?? []);
    } catch (e) {
      throw toApiError(e);
    }
  },
  async createEvent(body: { name: string; venue?: string; startAt?: string; endAt?: string }): Promise<Event> {
    try {
      return await unwrap<Event>(http.post('/admin/events', body));
    } catch (e) {
      throw toApiError(e);
    }
  },
  /** Edit screen: lấy 1 event (name/venue/thời gian/maxParticipants). */
  async getEventForEdit(id: string): Promise<Event> {
    try {
      return await unwrap<Event>(http.get(`/admin/events/${encodeURIComponent(id)}`));
    } catch (e) {
      throw toApiError(e);
    }
  },
  /**
   * Edit screen: sửa event (name/venue/thời gian/maxParticipants). Backend
   * (content-service) validate maxParticipants >= số người đã đăng ký —
   * vi phạm → 400 EVENT_MAX_PARTICIPANTS_BELOW_REGISTERED kèm registeredCount
   * trong body (ApiError.registeredCount); endTime <= startTime → 400
   * EVENT_TIME_INVALID.
   */
  async updateEvent(
    id: string,
    body: Partial<{ name: string; venue?: string; startAt?: string; endAt?: string; maxParticipants?: number }>,
  ): Promise<Event> {
    try {
      return await unwrap<Event>(http.patch(`/admin/events/${encodeURIComponent(id)}`, body));
    } catch (e) {
      throw toApiError(e);
    }
  },

  async listTicketTypes(eventId?: string): Promise<TicketType[]> {
    try {
      const res: any = await unwrap<unknown>(http.get(`/admin/ticket-types${qs({ eventId })}`));
      return Array.isArray(res) ? res : (res?.data ?? []);
    } catch (e) {
      throw toApiError(e);
    }
  },
  async createTicketType(body: {
    eventId: string;
    name: string;
    price?: number;
    quota: number;
    codePrefix?: string;
    emailDistribution?: boolean;
  }): Promise<TicketType> {
    try {
      return await unwrap<TicketType>(http.post('/admin/ticket-types', body));
    } catch (e) {
      throw toApiError(e);
    }
  },
  /** Edit screen: lấy 1 ticket type (name/quantity/sold) để điền form. */
  async getTicketTypeForEdit(id: string): Promise<TicketType> {
    try {
      return await unwrap<TicketType>(http.get(`/admin/ticket-types/${encodeURIComponent(id)}/basic`));
    } catch (e) {
      throw toApiError(e);
    }
  },
  /**
   * Edit screen: sửa CHỈ name + quantity. Backend (content-service) validate
   * quantity >= sold — vi phạm → 400 TICKET_TYPE_QUANTITY_BELOW_SOLD kèm
   * sold trong body (ApiError.sold) để hiển thị số vé đã bán.
   */
  async updateTicketTypeBasic(id: string, body: { name: string; quantity: number }): Promise<TicketType> {
    try {
      return await unwrap<TicketType>(http.patch(`/admin/ticket-types/${encodeURIComponent(id)}/basic`, body));
    } catch (e) {
      throw toApiError(e);
    }
  },
  /**
   * Xóa loại vé. Backend (content-service) hard-delete + AuditLog, chỉ khi
   * sold = 0 (re-read DB) — đã có vé được cấp → 400
   * TICKET_TYPE_HAS_SOLD_TICKETS kèm sold trong body (ApiError.sold).
   */
  async deleteTicketType(id: string): Promise<{ deleted: boolean; id: string }> {
    try {
      return await unwrap<{ deleted: boolean; id: string }>(
        http.delete(`/admin/ticket-types/${encodeURIComponent(id)}`),
      );
    } catch (e) {
      throw toApiError(e);
    }
  },

  async createDistribution(body: {
    ticketTypeId: string;
    quantity: number;
    recipients: string[];
    idempotencyKey?: string;
  }): Promise<{ job: DistributionJob }> {
    try {
      const res: any = await http.post('/admin/distributions', body, {
        validateStatus: (s) => s >= 200 && s < 300,
      });
      return (res?.data?.job ? res.data : res) as { job: DistributionJob };
    } catch (e) {
      throw toApiError(e);
    }
  },
  async listDistributions(params?: { page?: number; limit?: number }): Promise<{ data: DistributionJob[]; meta?: any }> {
    try {
      const res: any = await unwrap<unknown>(http.get(`/admin/distributions${qs(params)}`));
      if (Array.isArray(res)) return { data: res };
      return { data: res?.data ?? [], meta: res?.meta };
    } catch (e) {
      throw toApiError(e);
    }
  },
  async getDistributionStatus(jobId: string, includeFailed = false): Promise<DistributionStatusResp> {
    try {
      return await unwrap<DistributionStatusResp>(
        http.get(`/admin/distributions/${encodeURIComponent(jobId)}/status${qs({ includeFailed })}`),
      );
    } catch (e) {
      throw toApiError(e);
    }
  },

  async checkIn(body: { ticketCode: string; gateId?: string }): Promise<CheckInResult> {
    try {
      return await unwrap<CheckInResult>(http.post('/admin/check-in', body));
    } catch (e) {
      throw toApiError(e);
    }
  },

  async getOverviewStats(): Promise<OverviewStats> {
    try {
      return await unwrap<OverviewStats>(http.get('/admin/stats/overview'));
    } catch (e) {
      throw toApiError(e);
    }
  },
  async getAttendanceStats(params: { eventId?: string }): Promise<AttendanceStats> {
    try {
      return await unwrap<AttendanceStats>(http.get(`/admin/stats/attendance${qs(params)}`));
    } catch (e) {
      throw toApiError(e);
    }
  },

  async getMyTickets(): Promise<{ tickets: TicketView[]; claimedTickets?: number }> {
    try {
      return await unwrap<{ tickets: TicketView[] }>(http.get('/tickets/me'));
    } catch (e) {
      throw toApiError(e);
    }
  },
  async getTicket(id: string): Promise<TicketView> {
    try {
      return await unwrap<TicketView>(http.get(`/tickets/${encodeURIComponent(id)}`));
    } catch (e) {
      throw toApiError(e);
    }
  },
  /** Banner image bytes (proxy same-origin). Lỗi thường là 404 — caller fallback. */
  async getTicketImage(id: string): Promise<Blob> {
    const res = await http.get(`/tickets/${encodeURIComponent(id)}/image`, {
      responseType: 'blob',
      timeout: 15000,
    });
    return res.data as Blob;
  },

  async resolveClaim(token: string): Promise<ClaimResult> {
    try {
      const res: any = await unwrap<unknown>(http.get(`/claim/${encodeURIComponent(token)}`));
      if (res?.needsAuth) return { ok: false, needsAuth: true };
      if (res?.ok) {
        return {
          ok: true,
          // RB-2: sync fail-soft → ticketId null — KHÔNG chuyển hóa null
          // thành undefined để page phân biệt được "chưa link" và vào list.
          ticketId: res.ticketId ?? null,
          alreadyClaimed: res.alreadyClaimed,
          processing: res.processing,
          expired: res.expired,
        };
      }
      return { ok: false, message: res?.message };
    } catch (e) {
      const r = asAxiosError(e)?.response;
      const data: any = r?.data;
      if (data?.needsAuth) return { ok: false, needsAuth: true };
      return { ok: false, status: r?.status, code: data?.code, message: data?.message || data?.error };
    }
  },
};
