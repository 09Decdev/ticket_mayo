import { HttpException } from '@nestjs/common';

/**
 * Wire-level test cho ContentClientService.mintForDistribution (T5):
 * stub globalThis.fetch để assert ĐÚNG shape request gửi lên content
 * (HMAC signature, userId omit, dedupe, chunk 500, idempotencyKey) và
 * mapping lỗi pass-through (whitelist 4 mã, 5xx → 502).
 *
 * env bị set trước khi import service (env.ts được evaluate 1 lần lúc import).
 */

// ─── Env stub TRƯỚC khi import module dưới test ───
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.JWT_SECRET ??= 'test-jwt-secret-32-chars-minimum-value';
process.env.FIELD_ENCRYPTION_PEPPER ??= 'test-pepper-32-chars-minimum-value';
process.env.ADMIN_EMAIL ??= 'admin@test.local';
process.env.ADMIN_PASSWORD ??= 'test-admin-password';
process.env.MAIL_TRANSPORT ??= 'console';
process.env.PUBLIC_BASE_URL ??= 'http://localhost:5174';
process.env.PORT ??= '3005';
process.env.NODE_ENV ??= 'test';
process.env.CONTENT_SERVICE_BASE_URL ??= 'http://content-test:30041';
process.env.INTERNAL_SERVICE_TOKEN ??= 'test-internal-token';
process.env.MINT_SIGNING_KEY ??= 't5-mint-test-signing-key-DO-NOT-USE-IN-PROD-32';

import { ContentClientService } from './content-client.service';
import { signRecipient, TEST_SIGNING_KEY } from './mint-signing.spec.util';

type FetchCall = { url: string; init: RequestInit };

describe('ContentClientService.mintForDistribution (wire-level)', () => {
  let service: ContentClientService;
  let calls: FetchCall[];
  let fetchImpl: (...args: unknown[]) => Promise<Response>;

  beforeEach(() => {
    service = new ContentClientService();
    calls = [];
    (globalThis as Record<string, unknown>).fetch = (...args: unknown[]) => {
      const [url, init] = args as [string, RequestInit];
      calls.push({ url: String(url), init });
      return fetchImpl(...args);
    };
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const jsonResponse = (status: number, body: unknown) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

  const successBody = (results: unknown[]) => ({
    success: true,
    data: { results, soldAfter: 42 },
  });

  const HEX64 = 'a'.repeat(64);

  describe('request shape (HMAC sig, userId omit, dedupe, chunk)', () => {
    it('ký HMAC đúng canonical form — sig = HMAC(key, `${preTicketId}.${emailHash}.${userId ?? ""}`)', async () => {
      fetchImpl = () => jsonResponse(200, successBody([]));

      await service.mintForDistribution({
        eventId: 'evt-1',
        ticketTypeId: 'tt-1',
        recipients: [{ preTicketId: 'pt-1', emailHash: HEX64, userId: 'user-1' }],
        idempotencyKey: 'job-1',
      });

      expect(calls).toHaveLength(1);
      const body = JSON.parse(calls[0].init.body as string);
      expect(body.eventId).toBe('evt-1');
      expect(body.ticketTypeId).toBe('tt-1');
      expect(body.idempotencyKey).toBe('job-1');
      expect(body.recipients).toHaveLength(1);
      expect(body.recipients[0]).toEqual({
        preTicketId: 'pt-1',
        emailHash: HEX64,
        userId: 'user-1',
        signature: signRecipient(TEST_SIGNING_KEY, 'pt-1', HEX64, 'user-1'),
      });
      expect(calls[0].init.headers).toMatchObject({
        'x-service-token': 'test-internal-token',
        'Content-Type': 'application/json',
      });
    });

    it('userId null → OMIT key hoàn toàn (không bao giờ gửi chuỗi rỗng)', async () => {
      fetchImpl = () => jsonResponse(200, successBody([]));

      await service.mintForDistribution({
        eventId: 'evt-1',
        ticketTypeId: 'tt-1',
        recipients: [{ preTicketId: 'pt-2', emailHash: HEX64, userId: null }],
        idempotencyKey: 'job-1',
      });

      const body = JSON.parse(calls[0].init.body as string);
      expect(body.recipients[0]).toEqual({
        preTicketId: 'pt-2',
        emailHash: HEX64,
        signature: signRecipient(TEST_SIGNING_KEY, 'pt-2', HEX64, null),
      });
      expect('userId' in body.recipients[0]).toBe(false);
    });

    it('dedupe preTicketId trùng trong batch — chỉ gửi bản đầu', async () => {
      fetchImpl = () => jsonResponse(200, successBody([]));

      await service.mintForDistribution({
        eventId: 'evt-1',
        ticketTypeId: 'tt-1',
        recipients: [
          { preTicketId: 'pt-dup', emailHash: HEX64, userId: null },
          { preTicketId: 'pt-dup', emailHash: 'b'.repeat(64), userId: null },
          { preTicketId: 'pt-3', emailHash: 'c'.repeat(64), userId: null },
        ],
        idempotencyKey: 'job-1',
      });

      const body = JSON.parse(calls[0].init.body as string);
      expect(body.recipients).toHaveLength(2);
      expect(body.recipients.map((r: { preTicketId: string }) => r.preTicketId)).toEqual([
        'pt-dup',
        'pt-3',
      ]);
    });

    it('chunk 500 recipient/call — 501 recipient → 2 call, mỗi chunk ≤ 500', async () => {
      fetchImpl = () => jsonResponse(200, successBody([]));

      const recipients = Array.from({ length: 501 }, (_, i) => ({
        preTicketId: `pt-${i}`,
        emailHash: HEX64,
        userId: null,
      }));
      await service.mintForDistribution({
        eventId: 'evt-1',
        ticketTypeId: 'tt-1',
        recipients,
        idempotencyKey: 'job-1',
      });

      expect(calls).toHaveLength(2);
      const chunk1 = JSON.parse(calls[0].init.body as string);
      const chunk2 = JSON.parse(calls[1].init.body as string);
      expect(chunk1.recipients).toHaveLength(500);
      expect(chunk2.recipients).toHaveLength(1);
      expect(chunk2.recipients[0].preTicketId).toBe('pt-500');
    });

    it('aggregate results từ nhiều chunk + unwrap {success,data}', async () => {
      fetchImpl = () =>
        jsonResponse(200, {
          success: true,
          data: {
            results: [
              { preTicketId: 'pt-0', ticketId: 'tk-0', ticketCode: 'TK-0', alreadyMinted: false },
            ],
            soldAfter: 1,
          },
        });

      const res = await service.mintForDistribution({
        eventId: 'evt-1',
        ticketTypeId: 'tt-1',
        recipients: [{ preTicketId: 'pt-0', emailHash: HEX64, userId: null }],
        idempotencyKey: 'job-1',
      });

      expect(res.results).toEqual([
        { preTicketId: 'pt-0', ticketId: 'tk-0', ticketCode: 'TK-0', alreadyMinted: false },
      ]);
    });

    it('fail-loud 400 khi MINT_SIGNING_KEY rỗng — KHÔNG gọi fetch', async () => {
      const noKeyService = new ContentClientService();
      // @ts-expect-error — override private readonly để test fail-loud path
      noKeyService.mintSigningKey = '';

      await expect(
        noKeyService.mintForDistribution({
          eventId: 'evt-1',
          ticketTypeId: 'tt-1',
          recipients: [{ preTicketId: 'pt-1', emailHash: HEX64, userId: null }],
          idempotencyKey: 'job-1',
        }),
      ).rejects.toMatchObject({
        status: 400,
        response: { code: 'INVALID_PRETICKET_SIGNATURE' },
      });
      expect(calls).toHaveLength(0);
    });
  });

  describe('error pass-through (Δ7 whitelist)', () => {
    it('409 TICKET_SOLD_OUT → HttpException giữ 409 + code + remaining/requested (shape filter THẬT của content)', async () => {
      // Shape ĐÚNG GlobalExceptionFilter của content-service thật: filter
      // whitelist từng field → body có success/statusCode/timestamp/path/
      // traceId + remaining/requested. (MAJOR-2: test cũ bịa field trực tiếp
      // vào mock — test này mô phỏng đúng output filter.)
      fetchImpl = () =>
        jsonResponse(409, {
          success: false,
          statusCode: 409,
          message: 'Hết vé hoặc vượt quota: remaining=10, yêu cầu=15.',
          error: 'TICKET_SOLD_OUT',
          remaining: 10,
          requested: 15,
          timestamp: '2026-08-27T00:00:00.000Z',
          path: '/content-service/internal/distribution/mint',
          traceId: '11111111-2222-3333-4444-555555555555',
        });

      await expect(
        service.mintForDistribution({
          eventId: 'evt-1',
          ticketTypeId: 'tt-1',
          recipients: [{ preTicketId: 'pt-1', emailHash: HEX64, userId: null }],
          idempotencyKey: 'job-1',
        }),
      ).rejects.toMatchObject({
        status: 409,
        response: {
          code: 'TICKET_SOLD_OUT',
          message: 'Hết vé hoặc vượt quota: remaining=10, yêu cầu=15.',
          remaining: 10,
          requested: 15,
        },
      });
    });

    it('M7: KHÔNG forward statusCode/timestamp/path/traceId/success của content vào error body', async () => {
      fetchImpl = () =>
        jsonResponse(409, {
          success: false,
          statusCode: 409,
          message: 'Hết vé hoặc vượt quota: remaining=0, yêu cầu=5.',
          error: 'TICKET_SOLD_OUT',
          remaining: 0,
          requested: 5,
          timestamp: '2026-08-27T00:00:00.000Z',
          path: '/content-service/internal/distribution/mint',
          traceId: '99999999-8888-7777-6666-555555555555',
        });

      const err = (await service
        .mintForDistribution({
          eventId: 'evt-1',
          ticketTypeId: 'tt-1',
          recipients: [{ preTicketId: 'pt-1', emailHash: HEX64, userId: null }],
          idempotencyKey: 'job-1',
        })
        .catch((e: HttpException) => e)) as HttpException;

      const body = err.getResponse() as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(['code', 'message', 'remaining', 'requested']);
    });

    it('MAJOR-1: chunk 1 OK + chunk 2 throw 409 → error gắn partialMintResults của chunk 1', async () => {
      // 501 recipients → 2 chunk (500 + 1). Chunk 1 OK trả 500 results,
      // chunk 2 vướng 409 → throw nhưng error phải MANG THEO 500 results.
      let callIdx = 0;
      fetchImpl = () => {
        callIdx++;
        if (callIdx === 1) {
          const results = Array.from({ length: 500 }, (_, i) => ({
            preTicketId: `pt-${i}`,
            ticketId: `tk-${i}`,
            ticketCode: `TK-${i}`,
            alreadyMinted: false,
          }));
          return jsonResponse(200, successBody(results));
        }
        return jsonResponse(409, {
          success: false,
          statusCode: 409,
          message: 'Hết vé hoặc vượt quota: remaining=0, yêu cầu=1.',
          error: 'TICKET_SOLD_OUT',
          remaining: 0,
          requested: 1,
        });
      };

      const recipients = Array.from({ length: 501 }, (_, i) => ({
        preTicketId: `pt-${i}`,
        emailHash: HEX64,
        userId: null,
      }));
      const err = (await service
        .mintForDistribution({
          eventId: 'evt-1',
          ticketTypeId: 'tt-1',
          recipients,
          idempotencyKey: 'job-1',
        })
        .catch(
          (e: HttpException & { partialMintResults?: unknown[] }) => e,
        )) as HttpException & { partialMintResults?: unknown[] };

      expect(err.getStatus()).toBe(409);
      expect(err.partialMintResults).toHaveLength(500);
      expect((err.partialMintResults ?? [])[0]).toMatchObject({
        preTicketId: 'pt-0',
        ticketId: 'tk-0',
      });
    });

    it('400 INVALID_PRETICKET_SIGNATURE → pass-through giữ 400 + code (sig sai)', async () => {
      fetchImpl = () =>
        jsonResponse(400, {
          message: 'Chữ ký recipient không hợp lệ: pt-bad',
          error: 'INVALID_PRETICKET_SIGNATURE',
        });

      await expect(
        service.mintForDistribution({
          eventId: 'evt-1',
          ticketTypeId: 'tt-1',
          recipients: [{ preTicketId: 'pt-bad', emailHash: HEX64, userId: null }],
          idempotencyKey: 'job-1',
        }),
      ).rejects.toMatchObject({
        status: 400,
        response: { code: 'INVALID_PRETICKET_SIGNATURE' },
      });
    });

    it('5xx → BadGatewayException 502 generic message (M6 — KHÔNG forward message thô của content)', async () => {
      fetchImpl = () => jsonResponse(500, { message: 'Internal error', error: 1000 });

      const err = (await service
        .mintForDistribution({
          eventId: 'evt-1',
          ticketTypeId: 'tt-1',
          recipients: [{ preTicketId: 'pt-1', emailHash: HEX64, userId: null }],
          idempotencyKey: 'job-1',
        })
        .catch((e: HttpException) => e)) as HttpException;

      expect(err.getStatus()).toBe(502);
      const body = err.getResponse() as { message?: string };
      expect(body.message).not.toContain('Internal error');
      expect(body.message).toContain('content-service');
    });

    it('4xx ngoài whitelist → BadGatewayException (không pass-through)', async () => {
      fetchImpl = () => jsonResponse(403, { message: 'Forbidden', error: 'SOME_OTHER_CODE' });

      await expect(
        service.mintForDistribution({
          eventId: 'evt-1',
          ticketTypeId: 'tt-1',
          recipients: [{ preTicketId: 'pt-1', emailHash: HEX64, userId: null }],
          idempotencyKey: 'job-1',
        }),
      ).rejects.toMatchObject({ status: 502 });
    });
  });
});

// ─── AC: getTicketQrToken — static signed token QR tĩnh từ bảng Ticket ───
describe('ContentClientService.getTicketQrToken (wire-level)', () => {
  let service: ContentClientService;
  let calls: FetchCall[];
  let fetchImpl: (...args: unknown[]) => Promise<Response>;

  beforeEach(() => {
    service = new ContentClientService();
    calls = [];
    (globalThis as Record<string, unknown>).fetch = (...args: unknown[]) => {
      calls.push({ url: args[0] as string, init: args[1] as RequestInit });
      return fetchImpl(...args);
    };
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).fetch;
  });

  const jsonResponse = (status: number, body: unknown) =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response);

  it('GET /internal/distribution/tickets/:id/qr-token → unwrap {success,data} → token string', async () => {
    fetchImpl = () => jsonResponse(200, { success: true, data: { token: 'signed-token-abc' } });

    const token = await service.getTicketQrToken('tk-1');

    expect(token).toBe('signed-token-abc');
    expect(calls[0].url).toContain('/internal/distribution/tickets/tk-1/qr-token');
    expect(calls[0].init.headers).toMatchObject({ 'x-service-token': 'test-internal-token' });
  });

  it('content lỗi (5xx/404) → fail-soft trả null, KHÔNG throw (email vẫn gửi với fallback)', async () => {
    fetchImpl = () => jsonResponse(500, { message: 'down' });

    expect(await service.getTicketQrToken('tk-1')).toBeNull();
  });

  it('content trả về nhưng thiếu token → null', async () => {
    fetchImpl = () => jsonResponse(200, { success: true, data: {} });

    expect(await service.getTicketQrToken('tk-1')).toBeNull();
  });
});
