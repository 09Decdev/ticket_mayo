import { HttpException } from '@nestjs/common';

/**
 * Wire-level test cho ContentClientService.deleteTicketType (DELETE-INTERNAL):
 * - DELETE /internal/distribution/ticket-types/:id → unwrap {success,data}.
 * - 400 TICKET_TYPE_HAS_SOLD_TICKETS → pass-through giữ 400 + code + sold
 *   (M7: numeric whitelist — KHÔNG forward field khác).
 * - 4xx mã ngoài whitelist → 502 BadGateway (không pass-through).
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

type FetchCall = { url: string; init: RequestInit };

const jsonResponse = (status: number, body: unknown) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );

describe('ContentClientService.deleteTicketType (wire-level)', () => {
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
    delete (globalThis as Record<string, unknown>).fetch;
    jest.restoreAllMocks();
  });

  it('DELETE /internal/distribution/ticket-types/:id → unwrap {success,data} + headers x-service-token', async () => {
    fetchImpl = () =>
      jsonResponse(200, { success: true, data: { deleted: true, id: 'tt-1' } });

    const res = await service.deleteTicketType('tt-1');

    expect(res).toEqual({ deleted: true, id: 'tt-1' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/internal/distribution/ticket-types/tt-1');
    expect(calls[0].init.method).toBe('DELETE');
    expect(calls[0].init.headers).toMatchObject({
      'x-service-token': 'test-internal-token',
      'Content-Type': 'application/json',
    });
  });

  it('id có ký tự đặc biệt → encodeURIComponent trong path', async () => {
    fetchImpl = () =>
      jsonResponse(200, { success: true, data: { deleted: true, id: 'tt/1' } });

    await service.deleteTicketType('tt/1');

    expect(calls[0].url).toContain('/internal/distribution/ticket-types/tt%2F1');
  });

  it('400 TICKET_TYPE_HAS_SOLD_TICKETS → pass-through 400 + code + sold (shape filter THẬT của content)', async () => {
    // Shape ĐÚNG GlobalExceptionFilter của content-service thật: filter
    // whitelist từng field → body có success/statusCode/timestamp/path/
    // traceId + sold.
    fetchImpl = () =>
      jsonResponse(400, {
        success: false,
        statusCode: 400,
        message: 'Cannot delete ticket type "VIP" because 7 ticket(s) have already been claimed.',
        error: 'TICKET_TYPE_HAS_SOLD_TICKETS',
        sold: 7,
        timestamp: '2026-09-03T00:00:00.000Z',
        path: '/content-service/internal/distribution/ticket-types/tt-1',
        traceId: '11111111-2222-3333-4444-555555555555',
      });

    await expect(service.deleteTicketType('tt-1')).rejects.toMatchObject({
      status: 400,
      response: {
        code: 'TICKET_TYPE_HAS_SOLD_TICKETS',
        sold: 7,
      },
    });
  });

  it('M7: KHÔNG forward statusCode/timestamp/path/traceId/success của content vào error body', async () => {
    fetchImpl = () =>
      jsonResponse(400, {
        success: false,
        statusCode: 400,
        message: 'Cannot delete ticket type "VIP" because 5 ticket(s) have already been claimed.',
        error: 'TICKET_TYPE_HAS_SOLD_TICKETS',
        sold: 5,
        timestamp: '2026-09-03T00:00:00.000Z',
        path: '/content-service/internal/distribution/ticket-types/tt-1',
        traceId: '99999999-8888-7777-6666-555555555555',
      });

    const err = (await service
      .deleteTicketType('tt-1')
      .catch((e: HttpException) => e)) as HttpException;

    const body = err.getResponse() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['code', 'message', 'sold']);
  });

  it('4xx mã ngoài whitelist → BadGatewayException 502 (không pass-through)', async () => {
    fetchImpl = () => jsonResponse(403, { message: 'Forbidden', error: 'SOME_OTHER_CODE' });

    await expect(service.deleteTicketType('tt-1')).rejects.toMatchObject({
      status: 502,
    });
  });
});
