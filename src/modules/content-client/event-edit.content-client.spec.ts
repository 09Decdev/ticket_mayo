import { HttpException } from '@nestjs/common';
import { validateSync } from 'class-validator';

import { CreateEventDto } from '../event/dtos/create-event.dto';
import { UpdateEventDto } from '../event/dtos/update-event.dto';

/**
 * Wire-level test cho ContentClientService event-edit (EVENT-EDIT):
 * - getEvent: GET /internal/distribution/events/:id → unwrap {success,data}.
 * - updateEvent: PATCH → đúng path + body.
 * - 400 EVENT_MAX_PARTICIPANTS_BELOW_REGISTERED → pass-through giữ 400 + code
 *   + registeredCount (M7: numeric whitelist — KHÔNG forward field khác).
 * - 400 EVENT_TIME_INVALID → pass-through giữ 400 + code.
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

describe('ContentClientService event-edit (wire-level)', () => {
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

  describe('getEvent — GET /internal/distribution/events/:id', () => {
    it('unwrap {success,data} → event shape (kèm maxParticipants)', async () => {
      fetchImpl = () =>
        jsonResponse(200, {
          success: true,
          data: {
            id: 'evt-1',
            title: 'TechTalk Hà Nội 2026',
            address: '88 Láng Hạ',
            city: 'Hà Nội',
            startTime: '2026-01-01T00:00:00.000Z',
            endTime: '2026-01-02T00:00:00.000Z',
            status: 'PUBLISHED',
            maxParticipants: 100,
          },
        });

      const ev = await service.getEvent('evt-1');

      expect(ev).toMatchObject({ id: 'evt-1', title: 'TechTalk Hà Nội 2026', maxParticipants: 100 });
      expect(calls[0].url).toContain('/internal/distribution/events/evt-1');
      expect(calls[0].init.method).toBeUndefined(); // GET mặc định
      expect(calls[0].init.headers).toMatchObject({
        'x-service-token': 'test-internal-token',
        'Content-Type': 'application/json',
      });
    });

    it('id có ký tự đặc biệt → encodeURIComponent trong path', async () => {
      fetchImpl = () =>
        jsonResponse(200, { success: true, data: { id: 'evt/1' } });

      await service.getEvent('evt/1');

      expect(calls[0].url).toContain('/internal/distribution/events/evt%2F1');
    });
  });

  describe('updateEvent — PATCH /internal/distribution/events/:id', () => {
    it('PATCH body đúng shape đã map (title/address/startTime/endTime/maxParticipants)', async () => {
      fetchImpl = () =>
        jsonResponse(200, { success: true, data: { id: 'evt-1', title: 'Tên mới' } });

      await service.updateEvent('evt-1', {
        title: 'Tên mới',
        address: '1 Nguyễn Huệ',
        startTime: '2026-03-01T00:00:00.000Z',
        endTime: '2026-03-02T00:00:00.000Z',
        maxParticipants: 150,
      });

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toContain('/internal/distribution/events/evt-1');
      expect(calls[0].init.method).toBe('PATCH');
      expect(JSON.parse(calls[0].init.body as string)).toEqual({
        title: 'Tên mới',
        address: '1 Nguyễn Huệ',
        startTime: '2026-03-01T00:00:00.000Z',
        endTime: '2026-03-02T00:00:00.000Z',
        maxParticipants: 150,
      });
    });

    it('400 EVENT_MAX_PARTICIPANTS_BELOW_REGISTERED → pass-through 400 + code + registeredCount (shape filter THẬT của content)', async () => {
      // Shape ĐÚNG GlobalExceptionFilter của content-service thật: filter
      // whitelist từng field → body có success/statusCode/timestamp/path/
      // traceId + registeredCount.
      fetchImpl = () =>
        jsonResponse(400, {
          success: false,
          statusCode: 400,
          message: 'Max participants (3) cannot be lower than the number of already registered users (5).',
          error: 'EVENT_MAX_PARTICIPANTS_BELOW_REGISTERED',
          registeredCount: 5,
          timestamp: '2026-09-03T00:00:00.000Z',
          path: '/content-service/internal/distribution/events/evt-1',
          traceId: '11111111-2222-3333-4444-555555555555',
        });

      await expect(
        service.updateEvent('evt-1', { maxParticipants: 3 }),
      ).rejects.toMatchObject({
        status: 400,
        response: {
          code: 'EVENT_MAX_PARTICIPANTS_BELOW_REGISTERED',
          registeredCount: 5,
        },
      });
    });

    it('M7: KHÔNG forward statusCode/timestamp/path/traceId/success của content vào error body', async () => {
      fetchImpl = () =>
        jsonResponse(400, {
          success: false,
          statusCode: 400,
          message: 'Max participants (2) cannot be lower than the number of already registered users (7).',
          error: 'EVENT_MAX_PARTICIPANTS_BELOW_REGISTERED',
          registeredCount: 7,
          timestamp: '2026-09-03T00:00:00.000Z',
          path: '/content-service/internal/distribution/events/evt-1',
          traceId: '99999999-8888-7777-6666-555555555555',
        });

      const err = (await service
        .updateEvent('evt-1', { maxParticipants: 2 })
        .catch((e: HttpException) => e)) as HttpException;

      const body = err.getResponse() as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(['code', 'message', 'registeredCount']);
    });

    it('400 EVENT_TIME_INVALID → pass-through 400 + code', async () => {
      fetchImpl = () =>
        jsonResponse(400, {
          success: false,
          statusCode: 400,
          message: 'Event end time must be after start time.',
          error: 'EVENT_TIME_INVALID',
        });

      await expect(
        service.updateEvent('evt-1', { endTime: '2025-12-31T00:00:00.000Z' }),
      ).rejects.toMatchObject({
        status: 400,
        response: { code: 'EVENT_TIME_INVALID' },
      });
    });

    it('4xx mã ngoài whitelist → BadGatewayException 502 (không pass-through)', async () => {
      fetchImpl = () => jsonResponse(403, { message: 'Forbidden', error: 'SOME_OTHER_CODE' });

      await expect(
        service.updateEvent('evt-1', { title: 'X' }),
      ).rejects.toMatchObject({ status: 502 });
    });
  });
});

// ─── DTO: UpdateEventDto (PartialType CreateEventDto) — whitelist shape ───
describe('UpdateEventDto / CreateEventDto — validation (EVENT-EDIT)', () => {
  it('maxParticipants hợp lệ (int >= 0) → PASS', () => {
    const dto = new CreateEventDto();
    dto.name = 'Sự kiện';
    dto.maxParticipants = 150;
    const errors = validateSync(dto, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors.length).toBe(0);
  });

  it('maxParticipants âm → Min(0) chặn', () => {
    const dto = new CreateEventDto();
    dto.name = 'Sự kiện';
    dto.maxParticipants = -1;
    const errors = validateSync(dto, { whitelist: true, forbidNonWhitelisted: true });
    const invalid = errors.find((e) => e.property === 'maxParticipants');
    expect(invalid?.constraints).toHaveProperty('min');
  });

  it('maxParticipants string → IsInt chặn', () => {
    const dto = new CreateEventDto();
    dto.name = 'Sự kiện';
    (dto as any).maxParticipants = '150';
    const errors = validateSync(dto, { whitelist: true, forbidNonWhitelisted: true });
    const invalid = errors.find((e) => e.property === 'maxParticipants');
    expect(invalid?.constraints).toHaveProperty('isInt');
  });

  it('UpdateEventDto: body rỗng → hợp lệ (PATCH no-op)', () => {
    const dto = new UpdateEventDto();
    const errors = validateSync(dto, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors.length).toBe(0);
  });
});
