import { HttpException } from '@nestjs/common';

/**
 * Wire-level test cho ContentClientService phía TICKET-TYPE-MERGE:
 * - URL/param shape của merge-plan (CSV loserIds, unwrap {success,data});
 * - POST merge/rollback path + body pass-through + x-service-token;
 * - pass-through blockers/warnings CHỈ khi bizCode là TICKET_TYPE_MERGE_*
 *   (code khác có field blockers cũng không được forward — gate startsWith).
 */

// ─── Env stub TRƯỚC khi import module dưới test (env.ts evaluate 1 lần) ───
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

describe('ContentClientService — ticket-type merge (wire-level)', () => {
  let service: ContentClientService;
  let calls: FetchCall[];
  let fetchImpl: (...args: unknown[]) => Promise<any>;

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
  });

  const jsonResponse = (status: number, body: unknown) =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    });

  it('getMergePlan: eventId bắt buộc, survivorId/loserIds (CSV) chỉ gửi khi có', async () => {
    fetchImpl = () => jsonResponse(200, { success: true, data: { mode: 'plan', types: [] } });

    await service.getMergePlan({ eventId: 'evt-1' });
    expect(calls[0].url).toContain('/internal/distribution/ticket-types/merge-plan?eventId=evt-1');
    expect(calls[0].url).not.toContain('survivorId');
    expect(calls[0].url).not.toContain('loserIds');

    await service.getMergePlan({ eventId: 'evt-1', survivorId: 'tt-a', loserIds: ['tt-b', 'tt-c'] });
    const url = new URL(calls[1].url);
    expect(url.searchParams.get('survivorId')).toBe('tt-a');
    expect(url.searchParams.get('loserIds')).toBe('tt-b,tt-c');
    expect(calls[1].init.method ?? 'GET').toBe('GET');
  });

  it('getMergePlan unwrap {success,data} → trả data thẳng', async () => {
    fetchImpl = () =>
      jsonResponse(200, { success: true, data: { mode: 'plan', types: [{ id: 'tt-a' }] } });

    const out = await service.getMergePlan({ eventId: 'evt-1' });
    expect(out).toEqual({ mode: 'plan', types: [{ id: 'tt-a' }] });
  });

  it('mergeTicketTypes: POST đúng path + body + x-service-token', async () => {
    fetchImpl = () => jsonResponse(200, { success: true, data: { mode: 'apply', auditId: 'a-1' } });

    const out = await service.mergeTicketTypes({
      eventId: 'evt-1',
      survivorId: 'tt-a',
      loserIds: ['tt-b'],
      overrides: { quantity: 300 },
      actorId: 'admin-9',
    });

    expect(out).toEqual({ mode: 'apply', auditId: 'a-1' });
    expect(calls[0].url).toContain('/internal/distribution/ticket-types/merge');
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      eventId: 'evt-1',
      survivorId: 'tt-a',
      loserIds: ['tt-b'],
      overrides: { quantity: 300 },
      actorId: 'admin-9',
    });
    expect(calls[0].init.headers).toMatchObject({ 'x-service-token': 'test-internal-token' });
  });

  it('409 TICKET_TYPE_MERGE_BLOCKED → pass-through giữ 409 + code + blockers + warnings', async () => {
    fetchImpl = () =>
      jsonResponse(409, {
        success: false,
        statusCode: 409,
        message: 'Không thể gộp: còn reservation đang chờ.',
        error: 'TICKET_TYPE_MERGE_BLOCKED',
        blockers: ['tt-b: 3 reservation PENDING'],
        warnings: ['tt-c có 1 ghế đã chọn'],
        timestamp: '2026-09-03T00:00:00.000Z',
        path: '/content-service/internal/distribution/ticket-types/merge',
      });

    const err = (await service
      .mergeTicketTypes({ eventId: 'evt-1', survivorId: 'tt-a', loserIds: ['tt-b'] })
      .catch((e) => e)) as HttpException;

    expect(err.getStatus()).toBe(409);
    const body = err.getResponse() as Record<string, unknown>;
    expect(body.code).toBe('TICKET_TYPE_MERGE_BLOCKED');
    expect(body.blockers).toEqual(['tt-b: 3 reservation PENDING']);
    expect(body.warnings).toEqual(['tt-c có 1 ghế đã chọn']);
    // M7: không forward field thừa của content
    expect(body.timestamp).toBeUndefined();
    expect(body.path).toBeUndefined();
    expect(body.statusCode).toBeUndefined();
  });

  it('blockers[] trên KHÔNG phải merge-code → KHÔNG forward (gate startsWith)', async () => {
    fetchImpl = () =>
      jsonResponse(400, {
        message: 'bad',
        error: 'TICKET_TYPE_QUANTITY_BELOW_SOLD',
        sold: 5,
        blockers: ['phải bị bỏ qua vì không phải merge code'],
      });

    const err = (await service
      .mergeTicketTypes({ eventId: 'evt-1', survivorId: 'tt-a', loserIds: ['tt-b'] })
      .catch((e) => e)) as HttpException;

    const body = err.getResponse() as Record<string, unknown>;
    expect(body.code).toBe('TICKET_TYPE_QUANTITY_BELOW_SOLD');
    expect(body.sold).toBe(5);
    expect(body.blockers).toBeUndefined();
  });

  it('mergeRollback: POST /ticket-types/merge/rollback {auditId,actorId}', async () => {
    fetchImpl = () =>
      jsonResponse(200, { success: true, data: { rolledBack: true, auditId: 'a-1' } });

    const out = await service.mergeRollback({ auditId: 'a-1', actorId: 'admin-9' });

    expect(out).toEqual({ rolledBack: true, auditId: 'a-1' });
    expect(calls[0].url).toContain('/internal/distribution/ticket-types/merge/rollback');
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ auditId: 'a-1', actorId: 'admin-9' });
  });

  it('404 TICKET_TYPE_MERGE_AUDIT_NOT_FOUND → pass-through 404 (rollback form phân nhánh)', async () => {
    fetchImpl = () =>
      jsonResponse(404, { message: 'Không tìm thấy audit', error: 'TICKET_TYPE_MERGE_AUDIT_NOT_FOUND' });

    const err = (await service.mergeRollback({ auditId: 'missing' }).catch((e) => e)) as HttpException;
    expect(err.getStatus()).toBe(404);
    expect((err.getResponse() as any).code).toBe('TICKET_TYPE_MERGE_AUDIT_NOT_FOUND');
  });

  it('content 500 → BadGateway 502 generic (không leak message thô)', async () => {
    fetchImpl = () => jsonResponse(500, { message: 'internal stack trace', error: 1000 });

    const err = (await service
      .mergeTicketTypes({ eventId: 'evt-1', survivorId: 'tt-a', loserIds: ['tt-b'] })
      .catch((e) => e)) as HttpException;

    expect(err.getStatus()).toBe(502);
    expect(JSON.stringify(err.getResponse())).not.toContain('internal stack trace');
  });
});
