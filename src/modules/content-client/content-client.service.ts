import {
  BadGatewayException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHmac } from 'crypto';
import { env } from '../../config/env';

/** Recipient gửi tới content mint API (C-1, DESIGN §2.2). */
export interface MintRecipientInput {
  preTicketId: string;
  emailHash: string;
  /** PortalUser.id nếu có; null/undefined → omit hoàn toàn (KHÔNG gửi chuỗi rỗng). */
  userId?: string | null;
}

export interface MintRecipientResult {
  preTicketId: string;
  ticketId: string;
  ticketCode: string;
  alreadyMinted: boolean;
}

export interface MintForDistributionResponse {
  results: MintRecipientResult[];
  soldAfter: number;
}

/**
 * Error mang theo results của các chunk mint ĐÃ THÀNH CÔNG trước khi một
 * chunk sau đó throw (MAJOR-1). Caller (mintEager) đọc partialMintResults
 * để cập nhật MINTED cho phần đã mint thật TRƯỚC khi đánh EXPIRED/giữ
 * MINTING cho phần còn lại — tránh đánh EXPIRED đồng loạt cả batch
 * (bao gồm vé đã mint thật → admin re-issue phát vé THỨ HAI cho cùng người).
 */
export interface PartialMintError {
  partialMintResults?: MintRecipientResult[];
}

/**
 * Mã lỗi nghiệp vụ của content-service được phép pass-through giữ nguyên
 * status + code + message (Δ7 — whitelist, không cho lộ lỗi nội bộ khác).
 * Body lỗi content có dạng { message, error: <code>, ...details }.
 */
const PASSABLE_ERROR_CODES = new Set([
  'TICKET_SOLD_OUT',
  'TICKET_QUOTA_EXCEEDED',
  'INVALID_PRETICKET_SIGNATURE',
  'DUPLICATE_PRETICKET_ID',
]);

/** Số recipient tối đa / mint call (chunk client-side, ≤ max 1000 của content DTO). */
const MINT_CHUNK_SIZE = 500;

/**
 * HTTP client gọi content-service internal APIs (x-service-token).
 * Global prefix `content-service` — base URL join đường dẫn internal/distribution.
 */
@Injectable()
export class ContentClientService {
  private readonly logger = new Logger(ContentClientService.name);
  private readonly baseUrl: string;
  private readonly token: string;

  constructor() {
    this.baseUrl = `${(env.CONTENT_SERVICE_BASE_URL ?? 'http://localhost:30041').replace(/\/$/, '')}/content-service`;
    this.token = env.INTERNAL_SERVICE_TOKEN ?? '';
    if (!this.token) {
      this.logger.warn(
        'INTERNAL_SERVICE_TOKEN chưa được thiết lập — các lệnh gọi content-service sẽ fail. ' +
          'Thiết lập trong .env (phải khớp INTERNAL_SERVICE_TOKEN của content-service).',
      );
    }
    this.mintSigningKey = env.MINT_SIGNING_KEY ?? '';
    if (!this.mintSigningKey) {
      this.logger.warn(
        'MINT_SIGNING_KEY chưa được thiết lập — mọi đợt phát vé sẽ bị content ' +
          'từ chối (fail-loud). Thiết lập trong .env (phải khớp content-service, ≥32 chars).',
      );
    }
  }

  private readonly mintSigningKey: string;

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await globalThis.fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'x-service-token': this.token,
          ...(init?.headers ?? {}),
        },
      });
      if (!res.ok) {
        let message = `content-service ${res.status}`;
        let bizCode: string | undefined;
        let remaining: number | undefined;
        let requested: number | undefined;
        try {
          const body = (await res.json()) as {
            message?: string;
            error?: string | number;
            [k: string]: unknown;
          };
          message = body?.message ?? (body?.error != null ? String(body.error) : message);
          if (typeof body?.error === 'string') {
            bizCode = body.error;
          }
          // M7: chỉ pass-through ĐÚNG 2 field whitelisted (remaining/requested) —
          // KHÔNG spread toàn bộ rest (statusCode/timestamp/path/traceId/success
          // của content không được forward vào body response admin).
          if (typeof body?.remaining === 'number') {
            remaining = body.remaining;
          }
          if (typeof body?.requested === 'number') {
            requested = body.requested;
          }
        } catch {
          /* non-JSON error body */
        }
        this.logger.error(`content ${init?.method ?? 'GET'} ${path} → ${res.status} ${message}`);

        // Δ7 pass-through: lỗi nghiệp vụ distribution (whitelist) → giữ nguyên
        // status + code + message (vd 409 TICKET_SOLD_OUT kèm remaining/requested)
        // để admin thấy đúng nguyên nhân thay vì 502 chung chung.
        if (bizCode && PASSABLE_ERROR_CODES.has(bizCode) && res.status < 500) {
          throw new HttpException(
            {
              message,
              code: bizCode,
              ...(remaining !== undefined ? { remaining } : {}),
              ...(requested !== undefined ? { requested } : {}),
            },
            res.status,
          );
        }
        // 5xx → 502 BadGateway (che error nội bộ content — M6: message generic
        // cho client, message gốc đã log server-side ở dòng logger.error trên).
        if (res.status >= 500) {
          throw new BadGatewayException(
            'content-service hiện không khả dụng. Vui lòng thử lại sau.',
          );
        }
        throw new BadGatewayException(
          'content-service trả về phản hồi không hợp lệ. Vui lòng thử lại sau.',
        );
      }
      const body = (await res.json()) as any;
      // content-service wrap mọi response trong { success, data, ... } (TransformResponseInterceptor)
      if (body && typeof body === 'object' && body.success === true && 'data' in body) {
        return body.data as T;
      }
      return body as T;
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new ServiceUnavailableException('content-service timeout');
      }
      if (err instanceof HttpException) throw err;
      this.logger.error(`content ${init?.method ?? 'GET'} ${path} transport error: ${(err as Error).message}`);
      throw new ServiceUnavailableException('content-service unavailable');
    } finally {
      clearTimeout(timeout);
    }
  }

  // ─── Events ───
  getEvents(params?: { search?: string; status?: string }) {
    const qp = new URLSearchParams();
    if (params?.search) qp.set('search', params.search);
    if (params?.status) qp.set('status', params.status);
    const qs = qp.toString();
    return this.request<any[]>('/internal/distribution/events' + (qs ? `?${qs}` : ''));
  }
  createEvent(body: any) {
    return this.request<any>('/internal/distribution/events', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }
  updateEvent(id: string, body: any) {
    return this.request<any>(`/internal/distribution/events/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
  }

  // ─── Ticket types ───
  getEventTicketTypes(eventId: string) {
    return this.request<any[]>(
      `/internal/distribution/events/${encodeURIComponent(eventId)}/ticket-types`,
    );
  }
  getTicketType(ticketTypeId: string) {
    return this.request<any>(
      `/internal/distribution/ticket-types/${encodeURIComponent(ticketTypeId)}`,
    );
  }
  createTicketType(body: any) {
    return this.request<any>('/internal/distribution/ticket-types', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }
  updateTicketType(id: string, body: any) {
    return this.request<any>(`/internal/distribution/ticket-types/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
  }

  // ─── Issuance ───
  issueTickets(body: { eventId: string; ticketTypeId: string; userId: string; quantity: number }) {
    this.logger.log(
      `[ISSUE] content /internal/distribution/issue userId=${body.userId} ticketTypeId=${body.ticketTypeId} qty=${body.quantity}`,
    );
    return this.request<{ tickets: any[] }>('/internal/distribution/issue', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  // ─── QR (email/PDF) ───
  /** Static signed QR token (offline-checkin v1.1) từ bảng Ticket content —
   *  QR tĩnh self-verifying, KHÔNG phải link web. Fail-soft → null: email/PDF
   *  vẫn gửi được, QR fallback về ticketCode ở MailDispatcher. */
  async getTicketQrToken(ticketId: string): Promise<string | null> {
    try {
      const data = await this.request<{ token?: string }>(
        `/internal/distribution/tickets/${encodeURIComponent(ticketId)}/qr-token`,
      );
      return data?.token ?? null;
    } catch (err) {
      this.logger.warn(
        `[QR] getTicketQrToken fail ticketId=${ticketId}: ${(err as Error).message}`,
      );
      return null;
    }
  }

  // ─── T5 — Eager mint batch (C-1) ───
  /**
   * Mint batch vé email distribution (timeout 15s/call như các API khác).
   *
   * - Ký HMAC-SHA256 từng recipient TRƯỚC khi gửi (Δ11 VB3-2):
   *   sig = HMAC(MINT_SIGNING_KEY, `${preTicketId}.${emailHash}.${userId ?? ''}`)
   *   hex lowercase. userId null/undefined → OMIT hoàn toàn key (không bao giờ
   *   gửi chuỗi rỗng — content FIX-2 coi '' là vé rác).
   * - Dedupe preTicketId trong batch trước khi gửi (content FIX-1 reject trùng).
   * - Chunk ≤ 500 recipient/call (R10; content DTO cho phép tối đa 1000) —
   *   một preTicketId chỉ nằm trong đúng 1 chunk.
   * - Fail nhanh khi chưa cấu hình MINT_SIGNING_KEY (fail-loud ở client,
   *   không đốt HTTP call để rồi bị 500 từ content).
   */
  async mintForDistribution(body: {
    eventId: string;
    ticketTypeId: string;
    recipients: MintRecipientInput[];
    idempotencyKey: string;
  }): Promise<MintForDistributionResponse> {
    if (!this.mintSigningKey) {
      throw new HttpException(
        {
          message: 'MINT_SIGNING_KEY chưa cấu hình ở ticket-mayo — không thể ký recipient.',
          code: 'INVALID_PRETICKET_SIGNATURE',
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    // Dedupe preTicketId (giữ bản đầu).
    const seen = new Set<string>();
    const unique = body.recipients.filter((r) => {
      if (seen.has(r.preTicketId)) return false;
      seen.add(r.preTicketId);
      return true;
    });

    // Ký recipient: userId null/undefined → omit key khỏi payload.
    const signed = unique.map((r) => {
      const canonical = `${r.preTicketId}.${r.emailHash}.${r.userId ?? ''}`;
      const signature = createHmac('sha256', this.mintSigningKey)
        .update(canonical)
        .digest('hex')
        .toLowerCase();
      const recipient: Record<string, string> = {
        preTicketId: r.preTicketId,
        emailHash: r.emailHash,
        signature,
      };
      if (r.userId != null && r.userId !== '') {
        recipient.userId = r.userId;
      }
      return recipient;
    });

    // Chunk ≤ 500/call — khi một chunk throw, các chunk TRƯỚC ĐÓ đã mint
    // thành công thật ở content (MAJOR-1): gắn partialMintResults vào error
    // để caller cập nhật MINTED phần đã mint, chỉ đánh trạng thái fail cho
    // phần chưa mint (chunk lỗi + các chunk chưa gửi).
    const allResults: MintRecipientResult[] = [];
    const totalChunks = Math.ceil(signed.length / MINT_CHUNK_SIZE);
    this.logger.log(
      `[MINT] job=${body.idempotencyKey} gửi ${signed.length} recipient → /internal/distribution/mint (${totalChunks} chunk × ≤${MINT_CHUNK_SIZE})`,
    );
    for (let i = 0; i < signed.length; i += MINT_CHUNK_SIZE) {
      const chunk = signed.slice(i, i + MINT_CHUNK_SIZE);
      const chunkNo = Math.floor(i / MINT_CHUNK_SIZE) + 1;
      const t0 = Date.now();
      try {
        const res = await this.request<MintForDistributionResponse>(
          '/internal/distribution/mint',
          {
            method: 'POST',
            body: JSON.stringify({
              eventId: body.eventId,
              ticketTypeId: body.ticketTypeId,
              recipients: chunk,
              idempotencyKey: body.idempotencyKey,
            }),
          },
        );
        if (Array.isArray(res?.results)) {
          allResults.push(...res.results);
          const justMinted = res.results.filter((r) => !r.alreadyMinted).length;
          this.logger.log(
            `[MINT] job=${body.idempotencyKey} chunk ${chunkNo}/${totalChunks} OK recipients=${chunk.length} → minted=${justMinted} alreadyMinted=${res.results.length - justMinted} soldAfter=${res.soldAfter} (${Date.now() - t0}ms)`,
          );
        }
      } catch (err) {
        const status = err instanceof HttpException ? err.getStatus() : 'transport';
        const code =
          err instanceof HttpException
            ? ((err.getResponse() as { code?: string })?.code ?? '')
            : '';
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `[MINT] job=${body.idempotencyKey} chunk ${chunkNo}/${totalChunks} FAIL http=${status} code=${code} msg=${message}`,
        );
        if (allResults.length > 0 && err instanceof HttpException) {
          (err as HttpException & PartialMintError).partialMintResults = [...allResults];
        }
        throw err;
      }
    }
    this.logger.log(`[MINT] job=${body.idempotencyKey} DONE tổng ${allResults.length} result`);
    return { results: allResults, soldAfter: -1 };
  }

  // ─── T6 — Link-by-email (sync) ───
  /**
   * Gắn vé email-only (userId NULL, emailHash khớp) ở content về PortalUser.
   * KHÔNG cần HMAC — route chỉ yêu cầu x-service-token (request() tự gắn).
   * request() tự unwrap {success, data} → { linked, ticketIds? }.
   */
  linkByEmail(emailHash: string, userId: string): Promise<{ linked: number; ticketIds?: string[] }> {
    this.logger.log(`[LINK] content /internal/distribution/link-by-email userId=${userId} → gửi`);
    return this.request<{ linked: number; ticketIds?: string[] }>(
      '/internal/distribution/link-by-email',
      { method: 'POST', body: JSON.stringify({ emailHash, userId }) },
    ).then((res) => {
      this.logger.log(
        `[LINK] DONE userId=${userId} linked=${res.linked}${res.ticketIds?.length ? ` tickets=${res.ticketIds.length}` : ''}`,
      );
      return res;
    });
  }

  // ─── Portal ───
  getUserTickets(userId: string) {
    return this.request<{ tickets: any[] }>(
      `/internal/distribution/users/${encodeURIComponent(userId)}/tickets`,
    );
  }
  getTicket(id: string, userId: string) {
    const qp = new URLSearchParams({ userId });
    return this.request<any>(
      `/internal/distribution/tickets/${encodeURIComponent(id)}?${qp.toString()}`,
    );
  }

  // ─── Check-in ───
  checkIn(body: { ticketCode: string; checkerId: string; gateId?: string }) {
    return this.request<{ ticket: any; alreadyCheckedIn: boolean }>(
      '/internal/distribution/check-in',
      { method: 'POST', body: JSON.stringify(body) },
    );
  }

  // ─── Stats ───
  getStatsOverview() {
    return this.request<{ totalTickets: number; checkedIn: number }>(
      '/internal/distribution/stats/overview',
    );
  }
  getEventAttendance(eventId: string) {
    return this.request<{
      eventId: string;
      eventName: string;
      totalTickets: number;
      checkedIn: number;
      byGate: { gateId: string | null; count: number }[];
    }>(`/internal/distribution/stats/events/${encodeURIComponent(eventId)}/attendance`);
  }
}