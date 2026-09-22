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
  MergeApplyResult,
  MergePlanReport,
  MergeRollbackResult,
  MergeTicketOverrides,
  OverviewStats,
  SplitPlanReport,
  SplitApplyResult,
  SplitRollbackResult,
  TicketType,
  TicketTypeAppearance,
  TicketTypeImageUpload,
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
    /** MAX-PER-USER: số vé tối đa mỗi người nhận (default 4 khi không gửi). */
    maxTicketsPerUser?: number;
    codePrefix?: string;
    emailDistribution?: boolean;
    /** VÉ-MIỄN-PHÍ-MINH-CHỨNG: yêu cầu ảnh minh chứng nhiệm vụ (default false). */
    requireProof?: boolean;
    /** Mô tả nhiệm vụ cho AI — bắt buộc khi bật requireProof. */
    proofTaskDescription?: string;
  }): Promise<TicketType> {
    try {
      return await unwrap<TicketType>(http.post('/admin/ticket-types', body));
    } catch (e) {
      throw toApiError(e);
    }
  },
  /** Edit screen: lấy 1 ticket type (name/quantity/sold/requireProof) để điền form. */
  async getTicketTypeForEdit(id: string): Promise<TicketType> {
    try {
      return await unwrap<TicketType>(http.get(`/admin/ticket-types/${encodeURIComponent(id)}/basic`));
    } catch (e) {
      throw toApiError(e);
    }
  },
  /**
   * Edit screen: sửa name + quantity + requireProof/proofTaskDescription.
   * Backend (content-service) validate quantity >= sold — vi phạm → 400
   * TICKET_TYPE_QUANTITY_BELOW_SOLD kèm sold trong body (ApiError.sold) để
   * hiển thị số vé đã bán. Bật requireProof mà thiếu mô tả → 400
   * VALIDATION_ERROR (field proofTaskDescription).
   */
  async updateTicketTypeBasic(
    id: string,
    body: {
      name: string;
      quantity: number;
      /** MAX-PER-USER: không gửi thì giữ nguyên giá trị hiện tại. */
      maxTicketsPerUser?: number;
      requireProof?: boolean;
      proofTaskDescription?: string;
    },
  ): Promise<TicketType> {
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

  // ─── TICKET-APPEARANCE ("Ảnh vé & màu QR") ───
  /** Appearance screen: giá trị hiện tại (ảnh riêng + màu QR + event context). */
  async getTicketTypeAppearance(id: string): Promise<TicketTypeAppearance> {
    try {
      return await unwrap<TicketTypeAppearance>(
        http.get(`/admin/ticket-types/${encodeURIComponent(id)}/appearance`),
      );
    } catch (e) {
      throw toApiError(e);
    }
  },
  /**
   * Lưu cấu hình hiển thị. null = reset về default (ảnh dùng chung event,
   * QR đen/trắng). Hex #RGB/#RRGGBB — backend validate mirror content safeHex.
   */
  async updateTicketTypeAppearance(
    id: string,
    body: {
      ticketImageFileId?: string | null;
      qrForegroundColor?: string | null;
      qrBackgroundColor?: string | null;
    },
  ): Promise<TicketTypeAppearance> {
    try {
      return await unwrap<TicketTypeAppearance>(
        http.patch(`/admin/ticket-types/${encodeURIComponent(id)}/appearance`, body),
      );
    } catch (e) {
      throw toApiError(e);
    }
  },
  /**
   * Upload ảnh vé (multipart — tự set Content-Type multipart/form-data, KHÔNG
   * dùng default JSON của instance). Trả fileId CHƯA gắn — admin xem preview
   * rồi bấm Lưu mới PATCH ticketImageFileId.
   */
  async uploadTicketTypeImage(id: string, file: File): Promise<TicketTypeImageUpload> {
    try {
      const form = new FormData();
      form.append('file', file, file.name);
      const res = await http.post<TicketTypeImageUpload>(
        `/admin/ticket-types/${encodeURIComponent(id)}/appearance/image`,
        form,
        { timeout: 120_000, headers: { 'Content-Type': 'multipart/form-data' } },
      );
      return res.data;
    } catch (e) {
      throw toApiError(e);
    }
  },
  /**
   * Proxy presigned URL → bytes ảnh same-origin cho preview (backend fetch
   * thay trình duyệt — tránh CORS SeaweedFS). Lỗi 404 → caller fallback.
   */
  async getAppearanceImage(ticketTypeId: string, presignedUrl: string): Promise<Blob> {
    const res = await http.get<Blob>(
      `/admin/ticket-types/${encodeURIComponent(ticketTypeId)}/appearance/image-proxy`,
      {
        params: { url: presignedUrl },
        responseType: 'blob',
        timeout: 15000,
      },
    );
    return res.data as Blob;
  },

  async createDistribution(body: {
    ticketTypeId: string;
    quantity: number;
    recipients: string[];
    idempotencyKey?: string;
    btcUrl?: string;
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

  /** Nội dung email ĐÃ gửi cho 1 vé (claimToken) — trang chi tiết phát vé xem lại. */
  async getSentEmail(
    jobId: string,
    claimToken: string,
  ): Promise<{
    sentAt: string | null;
    text: string;
    html: string;
    attachments?: { ticketId: string; filename: string }[];
  }> {
    try {
      return await unwrap<{
        sentAt: string | null;
        text: string;
        html: string;
        attachments?: { ticketId: string; filename: string }[];
      }>(
        http.get(
          `/admin/distributions/${encodeURIComponent(jobId)}/emails/${encodeURIComponent(claimToken)}`,
        ),
      );
    } catch (e) {
      throw toApiError(e);
    }
  },

  /** Tải 1 PDF vé đính kèm của email đã gửi (blob — kèm Authorization qua interceptor). */
  async downloadSentEmailPdf(jobId: string, claimToken: string, ticketId: string): Promise<Blob> {
    try {
      const res = await http.get<Blob>(
        `/admin/distributions/${encodeURIComponent(jobId)}/emails/${encodeURIComponent(claimToken)}/pdf/${encodeURIComponent(ticketId)}`,
        { responseType: 'blob' },
      );
      return res.data;
    } catch (e) {
      throw toApiError(e);
    }
  },

  /**
   * VÉ CỨNG: mint N vé không người nhận + render PDF in (PII trống) + upload
   * bucket. Sync như createDistribution — timeout cao vì render vài nghìn PDF
   * có thể lâu hơn 30s default (5 phút an toàn cho 5000 vé).
   */
  async createPrintDistribution(body: {
    ticketTypeId: string;
    quantity: number;
    idempotencyKey?: string;
  }): Promise<{ job: DistributionJob; pdf?: { uploaded: number; failed: number } }> {
    try {
      const res: any = await http.post('/admin/distributions/print', body, {
        validateStatus: (s) => s >= 200 && s < 300,
        timeout: 300_000,
      });
      return (res?.data?.job ? res.data : res) as {
        job: DistributionJob;
        pdf?: { uploaded: number; failed: number };
      };
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

  /** ZIP toàn bộ PDF vé đã archive của 1 loại vé (server stream, có thể lâu → timeout 2 phút). */
  async downloadTicketTypePdfsZip(ticketTypeId: string): Promise<Blob> {
    // XHR-blob bị Edge abort giữa chừng với response chunked lớn (~58MB) —
    // net::ERR_FAILED 200 (OK) dù server trả đủ. fetch() không đi qua XHR
    // nên tránh được bug này; lỗi HTTP vẫn map status cho caller (404/503/409).
    const res = await fetch(
      `${TICKET_BASE}${PREFIX}/admin/distributions/ticket-types/${encodeURIComponent(ticketTypeId)}/pdfs.zip`,
      {
        headers: { Authorization: `Bearer ${getJwt() ?? ''}` },
        signal: AbortSignal.timeout(120_000),
      },
    );
    if (!res.ok) {
      throw toApiError({
        isAxiosError: true,
        response: { status: res.status, data: await res.json().catch(() => null) },
        message: `HTTP ${res.status}`,
      });
    }
    return res.blob();
  },

  /** VÉ CỨNG: zip CHỈ PDF vé in (job PRINT — PII trống) của 1 loại vé. */
  async downloadTicketTypePrintPdfsZip(ticketTypeId: string): Promise<Blob> {
    const res = await fetch(
      `${TICKET_BASE}${PREFIX}/admin/distributions/ticket-types/${encodeURIComponent(ticketTypeId)}/print-pdfs.zip`,
      {
        headers: { Authorization: `Bearer ${getJwt() ?? ''}` },
        signal: AbortSignal.timeout(120_000),
      },
    );
    if (!res.ok) {
      throw toApiError({
        isAxiosError: true,
        response: { status: res.status, data: await res.json().catch(() => null) },
        message: `HTTP ${res.status}`,
      });
    }
    return res.blob();
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

  // ─── TICKET-MERGE ("Gộp loại vé") ───
  /**
   * GET plan (dry-run): { content: <merge-plan report>, local: <repoint report> }.
   * Truyền survivorId/loserIds → có mergeTarget (blockers/warnings/projection).
   */
  async mergePlan(params: {
    eventId: string;
    survivorId?: string;
    loserIds?: string[];
  }): Promise<MergePlanReport> {
    try {
      return await unwrap<MergePlanReport>(
        http.get(
          `/admin/ticket-merge/plan${qs({
            eventId: params.eventId,
            survivorId: params.survivorId,
            loserIds: params.loserIds?.length ? params.loserIds.join(',') : undefined,
          })}`,
        ),
      );
    } catch (e) {
      throw toApiError(e);
    }
  },
  /**
   * POST merge (confirm="MERGE"). Timeout 130s — content transaction lớn có
   * thể chạy tới 120s; axios default 30s sẽ abort sớm hơn backend.
   */
  async mergeTicketTypes(body: {
    eventId: string;
    survivorId: string;
    loserIds: string[];
    overrides?: MergeTicketOverrides;
    includeTerminal?: boolean;
    confirm: 'MERGE';
  }): Promise<MergeApplyResult> {
    try {
      return await unwrap<MergeApplyResult>(
        http.post('/admin/ticket-merge', body, { timeout: 130_000 }),
      );
    } catch (e) {
      throw toApiError(e);
    }
  },
  /** POST rollback (confirm="ROLLBACK") — content trước, local sau. */
  async mergeRollback(body: {
    contentAuditId: string;
    repointAuditId?: string;
    confirm: 'ROLLBACK';
  }): Promise<MergeRollbackResult> {
    try {
      return await unwrap<MergeRollbackResult>(
        http.post('/admin/ticket-merge/rollback', body, { timeout: 130_000 }),
      );
    } catch (e) {
      throw toApiError(e);
    }
  },

  // ─── TICKET-SPLIT ("Điều chuyển vé") ───
  /**
   * GET plan (dry-run): { content: <split-plan report>, local: <subset PreTicket report> }.
   * movePreview = moveCount vé MỚI NHẤT sẽ chuyển (order createdAt desc).
   */
  async splitPlan(params: {
    eventId: string;
    sourceId: string;
    targetId: string;
    keepCount: number;
    sourceQuantity?: number;
    targetQuantity?: number;
  }): Promise<SplitPlanReport> {
    try {
      return await unwrap<SplitPlanReport>(
        http.get(
          `/admin/ticket-split/plan${qs({
            eventId: params.eventId,
            sourceId: params.sourceId,
            targetId: params.targetId,
            keepCount: params.keepCount,
            sourceQuantity: params.sourceQuantity,
            targetQuantity: params.targetQuantity,
          })}`,
        ),
      );
    } catch (e) {
      throw toApiError(e);
    }
  },
  /**
   * POST split (confirm="SPLIT"). Timeout 130s — content transaction lớn có
   * thể chạy tới 120s; axios default 30s sẽ abort sớm hơn backend.
   */
  async splitTicketTypes(body: {
    eventId: string;
    sourceId: string;
    targetId: string;
    keepCount: number;
    sourceQuantity?: number;
    targetQuantity?: number;
    confirm: 'SPLIT';
  }): Promise<SplitApplyResult> {
    try {
      return await unwrap<SplitApplyResult>(
        http.post('/admin/ticket-split', body, { timeout: 130_000 }),
      );
    } catch (e) {
      throw toApiError(e);
    }
  },
  /** POST rollback (confirm="ROLLBACK") — content trước, local sau. */
  async splitRollback(body: {
    contentAuditId: string;
    repointAuditId?: string;
    confirm: 'ROLLBACK';
  }): Promise<SplitRollbackResult> {
    try {
      return await unwrap<SplitRollbackResult>(
        http.post('/admin/ticket-split/rollback', body, { timeout: 130_000 }),
      );
    } catch (e) {
      throw toApiError(e);
    }
  },
};
