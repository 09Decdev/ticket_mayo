/**
 * Test-suite T5 — EAGER mint flow của DistributionService.
 *
 * Mock toàn bộ dependency (Prisma, MailDispatcher, Audit, EventService,
 * UserCommunityClient, ContentClient) — chỉ test logic trạng thái của
 * distribution.service. Wire-level (fetch stub) nằm ở
 * content-client/content-client.service.spec.ts.
 *
 * env được stub trước khi import (env.ts evaluate 1 lần).
 */

process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.JWT_SECRET ??= 'test-jwt-secret-32-chars-minimum-value';
process.env.FIELD_ENCRYPTION_PEPPER ??= 'test-pepper-32-chars-minimum-value';
process.env.ADMIN_EMAIL ??= 'admin@test.local';
process.env.ADMIN_PASSWORD ??= 'test-admin-password';
process.env.MAIL_TRANSPORT ??= 'console';
process.env.PUBLIC_BASE_URL ??= 'http://localhost:5174';
process.env.PORT ??= '3005';
process.env.NODE_ENV ??= 'test';

import { ConflictException, HttpException } from '@nestjs/common';
import { DistributionService } from './distribution.service';
import { MailDispatcherService } from '../mail-dispatcher/mail-dispatcher.service';
import { AuditService } from '../audit/audit.service';
import { EventService } from '../event/event.service';
import { UserCommunityClientService } from '../user-community-client/user-community-client.service';
import { ContentClientService } from '../content-client/content-client.service';
import { generateEmailHash } from '../../common/utils/email-hash.util';

// ─── Types cho mock state ───
type PreTicketRow = {
  id: string;
  jobId: string;
  recipientEmailHash: string;
  claimToken: string;
  ticketTypeId: string;
  eventId: string;
  status: string;
  recipientUserId: string | null;
  contentTicketId: string | null;
  contentTicketCode: string | null;
  mintedAt: Date | null;
  lastMintError: string | null;
  emailSentAt: Date | null;
};

type JobRow = {
  id: string;
  ticketTypeId: string;
  ticketTypeName?: string;
  eventName: string;
  eventId: string;
  total: number;
  sent: number;
  failed: number;
  status: string;
  mintMode: string;
  idempotencyKey: string | null;
  createdAt: Date;
};

/** Dữ liệu content mock cho mỗi call mintForDistribution. */
interface MintCall {
  eventId: string;
  ticketTypeId: string;
  recipients: { preTicketId: string; emailHash: string; userId?: string | null }[];
  idempotencyKey: string;
}

describe('DistributionService — EAGER mint flow (T5)', () => {
  let service: DistributionService;

  // Mock state (reset mỗi test)
  let preTickets: PreTicketRow[];
  let jobs: JobRow[];
  let portalUsers: { id: string; emailHash: string; email: string; displayName: string }[];
  let mintCalls: MintCall[];
  let mintBehavior: 'success' | 'quota409' | 'serverError' | 'partialMissing' | 'sigFail400' | 'chunk1OkChunk2Quota';
  let dispatchedPayloads: { claimToken: string; ticketCode?: string; ticketId?: string; ok: boolean }[];
  let auditActions: string[];

  const TT = {
    id: 'tt-1',
    eventId: 'evt-1',
    name: 'Vé VIP',
    eventName: 'Sự kiện test',
    eventStartAt: new Date('2026-09-01T10:00:00Z'),
    eventEndAt: new Date('2026-09-01T12:00:00Z'),
    venue: 'Hà Nội',
    eventImageUrl: null,
    quantity: 1000,
    sold: 0,
    remaining: 1000,
  };

  const ADMIN = 'admin-1';
  const EMAIL_USER = 'user@example.com'; // có PortalUser
  const EMAIL_GUEST = 'guest@example.com'; // KHÔNG PortalUser
  const HASH_USER = generateEmailHash(EMAIL_USER);
  const HASH_GUEST = generateEmailHash(EMAIL_GUEST);

  /** Build mock PrismaService — chỉ các method DistributionService dùng. */
  function makePrismaMock() {
    return {
      distributionJob: {
        findUnique: jest.fn(
          ({ where }: { where: { id?: string; idempotencyKey?: string } }) =>
            jobs.find((j) => j.id === where.id) ??
            (where.idempotencyKey
              ? jobs.find((j) => j.idempotencyKey === where.idempotencyKey) ?? null
              : null) ??
            null,
        ),
        create: jest.fn(({ data }: { data: Partial<JobRow> }) => {
          const job: JobRow = {
            id: data.id!,
            ticketTypeId: data.ticketTypeId!,
            eventName: data.eventName!,
            eventId: data.eventId!,
            total: data.total!,
            sent: 0,
            failed: 0,
            status: data.status!,
            mintMode: data.mintMode ?? 'EAGER',
            idempotencyKey: data.idempotencyKey ?? null,
            createdAt: new Date(),
          };
          jobs.push(job);
          return job;
        }),
        update: jest.fn(({ where, data }: { where: { id: string }; data: Partial<JobRow> }) => {
          const job = jobs.find((j) => j.id === where.id)!;
          Object.assign(job, data);
          return job;
        }),
      },
      preTicket: {
        findUnique: jest.fn(({ where }: { where: { claimToken: string } }) =>
          preTickets.find((p) => p.claimToken === where.claimToken) ?? null,
        ),
        createMany: jest.fn(({ data }: { data: Partial<PreTicketRow>[] }) => {
          for (const d of data) {
            preTickets.push({
              id: `pt-${preTickets.length + 1}`,
              jobId: d.jobId!,
              recipientEmailHash: d.recipientEmailHash!,
              claimToken: d.claimToken!,
              ticketTypeId: d.ticketTypeId!,
              eventId: d.eventId!,
              status: d.status!,
              recipientUserId: d.recipientUserId ?? null,
              contentTicketId: null,
              contentTicketCode: null,
              mintedAt: null,
              lastMintError: null,
              emailSentAt: null,
            });
          }
          return { count: data.length };
        }),
        findMany: jest.fn(({ where }: { where: Record<string, unknown> }) => {
          let rows = [...preTickets];
          if (where.jobId) rows = rows.filter((p) => p.jobId === (where as { jobId: string }).jobId);
          const w = where as {
            jobId?: string;
            status?: { in?: string[] };
            emailSentAt?: Date | null;
            select?: Record<string, boolean>;
          };
          if (w.status?.in) rows = rows.filter((p) => w.status!.in!.includes(p.status));
          if (typeof w.status === 'string') rows = rows.filter((p) => p.status === w.status);
          if (w.emailSentAt === null) rows = rows.filter((p) => p.emailSentAt === null);
          if (w.select) {
            return rows.map((p) => {
              const sel = w.select as Record<string, boolean>;
              const out: Record<string, unknown> = {};
              for (const k of Object.keys(sel)) out[k] = (p as unknown as Record<string, unknown>)[k];
              return out;
            });
          }
          return rows;
        }),
        count: jest.fn(({ where }: { where: Record<string, unknown> }) => {
          const w = where as {
            jobId?: string;
            status?: { in?: string[] };
            recipientUserId?: { not?: string | null };
            lastMintError?: { not?: string | null };
          };
          let rows = [...preTickets];
          if (w.jobId) rows = rows.filter((p) => p.jobId === w.jobId);
          if (w.status?.in) rows = rows.filter((p) => w.status!.in!.includes(p.status));
          // Prisma filter recipientUserId: {not: null} = có userId,
          // recipientUserId: null = KHÔNG có userId (guest).
          if (w.recipientUserId?.not !== undefined) {
            rows = rows.filter((p) => p.recipientUserId !== null);
          } else if (w.recipientUserId === null) {
            rows = rows.filter((p) => p.recipientUserId === null);
          }
          if (w.lastMintError?.not !== undefined) {
            rows = rows.filter((p) => p.lastMintError !== null);
          }
          return rows.length;
        }),
        updateMany: jest.fn(({ where, data }: { where: Record<string, unknown>; data: Partial<PreTicketRow> }) => {
          const w = where as {
            jobId?: string;
            id?: { in?: string[] };
            claimToken?: { in?: string[] };
            status?: { in?: string[] };
          };
          let rows = [...preTickets];
          if (w.jobId) rows = rows.filter((p) => p.jobId === w.jobId);
          if (typeof w.id === 'string') {
            rows = rows.filter((p) => p.id === w.id);
          } else if (w.id?.in) {
            rows = rows.filter((p) => w.id!.in!.includes(p.id));
          }
          if (w.claimToken?.in) rows = rows.filter((p) => w.claimToken!.in!.includes(p.claimToken));
          if (typeof (where as { status?: unknown }).status === 'string') {
            const st = (where as { status: string }).status;
            rows = rows.filter((p) => p.status === st);
          }
          let count = 0;
          for (const row of rows) {
            Object.assign(row, data);
            count++;
          }
          return { count };
        }),
      },
      portalUser: {
        findUnique: jest.fn(({ where }: { where: { emailHash: string } }) =>
          portalUsers.find((u) => u.emailHash === where.emailHash) ?? null,
        ),
        findMany: jest.fn(({ where }: { where: { emailHash: { in: string[] } } }) =>
          portalUsers.filter((u) => where.emailHash.in.includes(u.emailHash)),
        ),
      },
      $transaction: jest.fn((fn: (tx: unknown) => Promise<JobRow>) =>
        fn({
          distributionJob: {
            create: ({ data }: { data: Partial<JobRow> }) => {
              const job: JobRow = {
                id: data.id!,
                ticketTypeId: data.ticketTypeId!,
                eventName: data.eventName!,
                eventId: data.eventId!,
                total: data.total!,
                sent: 0,
                failed: 0,
                status: data.status!,
                mintMode: data.mintMode ?? 'EAGER',
                idempotencyKey: data.idempotencyKey ?? null,
                createdAt: new Date(),
              };
              jobs.push(job);
              return job;
            },
          },
          preTicket: {
            createMany: ({ data }: { data: Partial<PreTicketRow>[] }) => {
              for (const d of data) {
                preTickets.push({
                  id: `pt-${preTickets.length + 1}`,
                  jobId: d.jobId!,
                  recipientEmailHash: d.recipientEmailHash!,
                  claimToken: d.claimToken!,
                  ticketTypeId: d.ticketTypeId!,
                  eventId: d.eventId!,
                  status: d.status!,
                  recipientUserId: d.recipientUserId ?? null,
                  contentTicketId: null,
                  contentTicketCode: null,
                  mintedAt: null,
                  lastMintError: null,
                  emailSentAt: null,
                });
              }
              return { count: data.length };
            },
          },
        }),
      ),
    };
  }

  function makeService() {
    const prisma = makePrismaMock();
    const mailDispatcher = {
      buildClaimUrl: (token: string) => `http://localhost:5174/c/${token}`,
      dispatchBatch: jest.fn(async (payloads: { claimToken: string; ticketCode?: string; ticketId?: string }[]) => {
        dispatchedPayloads = payloads.map((p) => ({
          claimToken: p.claimToken,
          ticketCode: p.ticketCode as string | undefined,
          ticketId: p.ticketId as string | undefined,
          ok: true,
        }));
        return {
          dispatched: payloads.length,
          failed: 0,
          results: dispatchedPayloads,
        };
      }),
    };
    const audit = {
      record: jest.fn(async ({ action }: { action: string }) => {
        auditActions.push(action);
      }),
    };
    const eventService = {
      getTicketTypeWithEvent: jest.fn(async () => TT),
    };
    const userCommunity = {
      lookupDisplayNames: jest.fn(async () => new Map<string, string>()),
    };
    const content = {
      mintForDistribution: jest.fn(async (call: MintCall) => {
        mintCalls.push(call);
        if (mintBehavior === 'chunk1OkChunk2Quota') {
          // MAJOR-1: mint client-side KHÔNG chunk trong service-mock — mô phỏng
          // đúng hành vi ContentClientService thật: chunk đầu OK (trả 500 kết
          // quả), chunk sau 409 → error gắn partialMintResults của chunk đầu.
          // Giả lập 1 batch 800 = 500 (chunk 1 OK) + 300 (chunk 2 throw).
          const CHUNK_SIZE = 500;
          const total = call.recipients.length;
          if (total <= CHUNK_SIZE) {
            throw new HttpException(
              {
                message: 'Hết vé hoặc vượt quota: remaining=0, yêu cầu=300.',
                code: 'TICKET_SOLD_OUT',
                remaining: 0,
                requested: 300,
              },
              409,
            );
          }
          const firstChunk = call.recipients.slice(0, CHUNK_SIZE);
          const results = firstChunk.map((r) => ({
            preTicketId: r.preTicketId,
            ticketId: `tk-${r.preTicketId}`,
            ticketCode: `CODE-${r.preTicketId}`,
            alreadyMinted: false,
          }));
          const err = new HttpException(
            {
              message: 'Hết vé hoặc vượt quota: remaining=0, yêu cầu=300.',
              code: 'TICKET_SOLD_OUT',
              remaining: 0,
              requested: 300,
            },
            409,
          ) as HttpException & { partialMintResults?: typeof results };
          err.partialMintResults = results;
          throw err;
        }
        if (mintBehavior === 'quota409') {
          throw new HttpException(
            {
              message: 'Hết vé hoặc vượt quota: remaining=0, yêu cầu=2.',
              code: 'TICKET_SOLD_OUT',
              remaining: 0,
              requested: 2,
            },
            409,
          );
        }
        if (mintBehavior === 'serverError') {
          throw new HttpException({ message: 'content-service: Internal error' }, 502);
        }
        if (mintBehavior === 'sigFail400') {
          throw new HttpException(
            {
              message: 'Chữ ký recipient không hợp lệ: pt-1',
              code: 'INVALID_PRETICKET_SIGNATURE',
            },
            400,
          );
        }
        const results = call.recipients.map((r, i) => {
          if (mintBehavior === 'partialMissing' && i === call.recipients.length - 1) {
            return { preTicketId: r.preTicketId, ticketId: '', ticketCode: '', alreadyMinted: false };
          }
          return {
            preTicketId: r.preTicketId,
            ticketId: `tk-${r.preTicketId}`,
            ticketCode: `CODE-${r.preTicketId}`,
            alreadyMinted: false,
          };
        });
        return { results, soldAfter: results.length };
      }),
    };

    service = new DistributionService(
      prisma as never,
      mailDispatcher as unknown as MailDispatcherService,
      audit as unknown as AuditService,
      eventService as unknown as EventService,
      userCommunity as unknown as UserCommunityClientService,
      content as unknown as ContentClientService,
    );
    // Expose mocks cho assertion
    (service as unknown as Record<string, unknown>).__mocks = {
      prisma,
      mailDispatcher,
      audit,
      content,
      eventService,
      userCommunity,
    };
    return service;
  }

  function makeDto(recipients: string[], quantity = 1) {
    return { ticketTypeId: 'tt-1', recipients, quantity };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    preTickets = [];
    jobs = [];
    portalUsers = [{ id: 'user-1', emailHash: HASH_USER, email: EMAIL_USER, displayName: 'User Có Tên' }];
    mintCalls = [];
    mintBehavior = 'success';
    dispatchedPayloads = [];
    auditActions = [];
    service = makeService();
  });

  const mocks = () => (service as unknown as { __mocks: Record<string, unknown> }).__mocks as {
    prisma: ReturnType<typeof makePrismaMock>;
    mailDispatcher: { dispatchBatch: jest.Mock };
    audit: { record: jest.Mock };
    content: { mintForDistribution: jest.Mock };
    eventService: { getTicketTypeWithEvent: jest.Mock };
    userCommunity: { lookupDisplayNames: jest.Mock };
  };

  // ─── AC: EAGER 2 nhánh (có/không PortalUser) ───
  describe('EAGER mode — resolve userId per email', () => {
    it('recipient có PortalUser → gửi userId; guest → omit userId', async () => {
      await service.distribute(makeDto([EMAIL_USER, EMAIL_GUEST]), ADMIN);

      expect(mocks().content.mintForDistribution).toHaveBeenCalledTimes(1);
      const call = mintCalls[0];
      expect(call.idempotencyKey).toBe(jobs[0].id);
      expect(call.recipients).toHaveLength(2);

      const userRecipient = call.recipients.find((r) => r.emailHash === HASH_USER);
      const guestRecipient = call.recipients.find((r) => r.emailHash === HASH_GUEST);
      expect(userRecipient?.userId).toBe('user-1');
      // Service truyền userId: null cho guest — wire-level OMIT key
      // (chứng minh ở content-client.service.spec.ts "userId null → OMIT key").
      expect(guestRecipient?.userId).toBeNull();

      // PreTicket persist recipientUserId đúng
      const userPreTicket = preTickets.find((p) => p.recipientEmailHash === HASH_USER);
      const guestPreTicket = preTickets.find((p) => p.recipientEmailHash === HASH_GUEST);
      expect(userPreTicket?.recipientUserId).toBe('user-1');
      expect(guestPreTicket?.recipientUserId).toBeNull();
    });

    it('mint thành công → PreTicket MINTED + contentTicketId/Code/mintedAt, job COMPLETED', async () => {
      await service.distribute(makeDto([EMAIL_USER]), ADMIN);

      expect(preTickets[0].status).toBe('MINTED');
      expect(preTickets[0].contentTicketId).toBe(`tk-${preTickets[0].id}`);
      expect(preTickets[0].contentTicketCode).toBe(`CODE-${preTickets[0].id}`);
      expect(preTickets[0].mintedAt).toBeInstanceOf(Date);
      expect(jobs[0].status).toBe('COMPLETED');
      // Email gửi SAU mint + emailSentAt được set (per-ack)
      expect(dispatchedPayloads).toHaveLength(1);
      expect(preTickets[0].emailSentAt).toBeInstanceOf(Date);
      // ticketCode trong email/PDF = mã vé THẬT từ bảng Ticket (content-service),
      // KHÔNG phải slice claimToken giả.
      expect(dispatchedPayloads[0]).toMatchObject({
        claimToken: preTickets[0].claimToken,
        ticketCode: `CODE-${preTickets[0].id}`,
        ticketId: `tk-${preTickets[0].id}`,
      });
      expect(dispatchedPayloads[0].ticketCode).toBe(preTickets[0].contentTicketCode);
      expect(dispatchedPayloads[0].ticketId).toBe(preTickets[0].contentTicketId);
    });
  });

  // ─── AC: MAJOR-1 multi-chunk — chunk 1 mint thật, chunk 2 quota ───
  describe('EAGER multi-chunk quota — KHÔNG đánh EXPIRED vé đã mint thật (MAJOR-1)', () => {
    it('batch 800: chunk 1 (500) OK + chunk 2 (300) 409 → 500 MINTED + 300 EXPIRED, KHÔNG EXPIRED vé chunk-1', async () => {
      mintBehavior = 'chunk1OkChunk2Quota';

      // 800 recipients (≤ cap 1000) → 800 PreTicket → client chunk 500+300.
      const emails = Array.from({ length: 800 }, (_, i) => `bulk${i}@example.com`);
      await expect(service.distribute(makeDto(emails), ADMIN)).rejects.toMatchObject({
        status: 409,
        response: {
          code: 'TICKET_SOLD_OUT',
          remaining: 0,
          requested: 300,
        },
      });

      expect(preTickets).toHaveLength(800);
      // 500 vé chunk-1 mint THẬT → MINTED (KHÔNG BỊ EXPIRED)
      const minted = preTickets.filter((p) => p.status === 'MINTED');
      const expired = preTickets.filter((p) => p.status === 'EXPIRED');
      expect(minted).toHaveLength(500);
      expect(expired).toHaveLength(300);
      // MINTED có đủ contentTicketId/Code/mintedAt (mint thật)
      expect(minted.every((p) => p.contentTicketId?.startsWith('tk-pt-'))).toBe(true);
      expect(minted.every((p) => p.mintedAt instanceof Date)).toBe(true);
      // EXPIRED có lastMintError quota
      expect(expired.every((p) => p.lastMintError !== null)).toBe(true);
      // Job FAILED nhưng vé chunk-1 KHÔNG mất
      expect(jobs[0].status).toBe('FAILED');
      // KHÔNG gửi email nào (distribute throw trước bước email)
      expect(mocks().mailDispatcher.dispatchBatch).not.toHaveBeenCalled();
      expect(auditActions).toContain('MINT_EAGER_PARTIAL_APPLIED');
    });

    it('partial-error 5xx sau chunk 1 → 500 MINTED + 300 giữ MINTING (retry được)', async () => {
      // Biến thể: chunk 2 lỗi 5xx (không phải quota) — phần chunk-1 vẫn MINTED,
      // phần còn lại GIỮ MINTING để retry idempotent (không EXPIRED).
      const emails = Array.from({ length: 800 }, (_, i) => `bulk5xx${i}@example.com`);
      const content = mocks().content;
      content.mintForDistribution.mockImplementationOnce(async (call: MintCall) => {
        mintCalls.push(call);
        const CHUNK_SIZE = 500;
        const firstChunk = call.recipients.slice(0, CHUNK_SIZE);
        const results = firstChunk.map((r) => ({
          preTicketId: r.preTicketId,
          ticketId: `tk-${r.preTicketId}`,
          ticketCode: `CODE-${r.preTicketId}`,
          alreadyMinted: false,
        }));
        const err = new HttpException(
          { message: 'content-service: Internal error' },
          502,
        ) as HttpException & { partialMintResults?: typeof results };
        err.partialMintResults = results;
        throw err;
      });

      await expect(service.distribute(makeDto(emails), ADMIN)).rejects.toMatchObject({
        status: 502,
      });

      const minted = preTickets.filter((p) => p.status === 'MINTED');
      const stillMinting = preTickets.filter((p) => p.status === 'MINTING');
      const expired = preTickets.filter((p) => p.status === 'EXPIRED');
      expect(minted).toHaveLength(500);
      expect(stillMinting).toHaveLength(300);
      expect(expired).toHaveLength(0); // 5xx KHÔNG EXPIRED — giữ MINTING retry
      expect(jobs[0].status).toBe('FAILED');
    });
  });

  // ─── AC: M1 idempotency distribute — cùng key 2 lần ───
  describe('distribute idempotency (M1 — AC 235)', () => {
    it('gọi distribute 2 lần cùng idempotencyKey → job cũ trả về, mint gọi 1 lần, không tạo preTickets thêm', async () => {
      const dto = { ...makeDto([EMAIL_USER]), idempotencyKey: 'idem-key-1' };

      const first = await service.distribute(dto, ADMIN);
      expect(first.job.id).toBe(jobs[0].id);
      expect(mocks().content.mintForDistribution).toHaveBeenCalledTimes(1);
      expect(preTickets).toHaveLength(1);

      const second = await service.distribute(dto, ADMIN);
      // Trả về ĐÚNG job cũ — không tạo job mới
      expect(second.job.id).toBe(first.job.id);
      expect(jobs).toHaveLength(1);
      // KHÔNG mint thêm
      expect(mocks().content.mintForDistribution).toHaveBeenCalledTimes(1);
      expect(mintCalls).toHaveLength(1);
      // KHÔNG tạo PreTicket thêm
      expect(preTickets).toHaveLength(1);
    });
  });

  // ─── AC: quota 409 + không email + không orphan doubling ───
  describe('EAGER quota fail (409 TICKET_SOLD_OUT)', () => {
    it('throw ConflictException với remaining/requested; PreTicket EXPIRED (không mồ côi); KHÔNG email', async () => {
      mintBehavior = 'quota409';

      await expect(service.distribute(makeDto([EMAIL_USER, EMAIL_GUEST]), ADMIN)).rejects.toMatchObject(
        {
          status: 409,
          response: {
            code: 'TICKET_SOLD_OUT',
            remaining: 0,
            requested: 2,
          },
        },
      );

      // KHÔNG PreTicket mồ côi PENDING — tất cả EXPIRED terminal
      expect(preTickets.every((p) => p.status === 'EXPIRED')).toBe(true);
      expect(preTickets.every((p) => p.lastMintError !== null)).toBe(true);
      expect(jobs[0].status).toBe('FAILED');
      // KHÔNG gửi email
      expect(mocks().mailDispatcher.dispatchBatch).not.toHaveBeenCalled();
      expect(dispatchedPayloads).toHaveLength(0);
      expect(ConflictException).toBeDefined();
    });

    it('admin phát lại job MỚI sau quota → preTicketIds mới (không doubling vé cũ)', async () => {
      mintBehavior = 'quota409';
      await expect(service.distribute(makeDto([EMAIL_USER]), ADMIN)).rejects.toBeInstanceOf(
        ConflictException,
      );
      const firstJobPreTicketIds = preTickets.map((p) => p.id);

      // Admin tạo job mới (mint thành công lần này)
      mintBehavior = 'success';
      const res = await service.distribute(makeDto([EMAIL_USER]), ADMIN);

      expect(jobs).toHaveLength(2);
      const newPreTickets = preTickets.filter((p) => p.jobId === jobs[1].id);
      expect(newPreTickets).toHaveLength(1);
      // preTicketIds mới HOÀN TOÀN khác cũ — content dedupe theo preTicketId
      // chỉ áp trong cùng id → vé cũ (không tồn tại) không thể mint đôi.
      expect(firstJobPreTicketIds).not.toContain(newPreTickets[0].id);
      expect(newPreTickets[0].status).toBe('MINTED');
    });
  });

  // ─── AC: pre-check quota NGAY từ server (trước khi tạo job/mint) ───
  describe('quota pre-check server-side (409 TICKET_QUOTA_EXCEEDED) — trước khi tạo job', () => {
    it('recipients×quantity > remaining → ConflictException ngay; KHÔNG tạo job/PreTicket, KHÔNG mint, KHÔNG email', async () => {
      mocks().eventService.getTicketTypeWithEvent.mockResolvedValueOnce({
        ...TT,
        quantity: 1000,
        sold: 995,
        remaining: 5,
      });

      const tenEmails = Array.from({ length: 10 }, (_, i) => `user${i}@example.com`);
      await expect(service.distribute(makeDto(tenEmails), ADMIN)).rejects.toMatchObject({
        status: 409,
        response: {
          code: 'TICKET_QUOTA_EXCEEDED',
          remaining: 5,
          requested: 10,
        },
      });

      expect(jobs).toHaveLength(0); // chưa tạo job
      expect(preTickets).toHaveLength(0); // chưa có vé nào được tạo
      expect(mintCalls).toHaveLength(0); // chưa gọi content mint
      expect(mocks().mailDispatcher.dispatchBatch).not.toHaveBeenCalled();
    });

    it('quantity mỗi người > 1 cũng nhân vào tổng (3 người × 2 vé > 5 còn lại → 409)', async () => {
      mocks().eventService.getTicketTypeWithEvent.mockResolvedValueOnce({
        ...TT,
        quantity: 1000,
        sold: 995,
        remaining: 5,
      });

      await expect(
        service.distribute(makeDto([EMAIL_USER, EMAIL_GUEST, 'third@example.com'], 2), ADMIN),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: 'TICKET_QUOTA_EXCEEDED', remaining: 5, requested: 6 },
      });
      expect(jobs).toHaveLength(0);
      expect(mintCalls).toHaveLength(0);
    });

    it('boundary: tổng vé = đúng remaining → VẪN distribute bình thường (chỉ chặn khi >)', async () => {
      mocks().eventService.getTicketTypeWithEvent.mockResolvedValueOnce({
        ...TT,
        quantity: 1000,
        sold: 998,
        remaining: 2,
      });

      const res = await service.distribute(makeDto([EMAIL_USER, EMAIL_GUEST]), ADMIN);
      expect(res).toBeTruthy();
      expect(jobs).toHaveLength(1);
      expect(preTickets.filter((p) => p.jobId === jobs[0].id)).toHaveLength(2);
      expect(mintCalls).toHaveLength(1);
    });
  });

  // ─── AC: mint fail cả batch (5xx/transport) → giữ MINTING + FAILED + không email ───
  describe('EAGER mint fail cả batch (5xx)', () => {
    it('PreTickets GIỮ MINTING + lastMintError, job FAILED, KHÔNG rollback PENDING, KHÔNG email', async () => {
      mintBehavior = 'serverError';

      await expect(service.distribute(makeDto([EMAIL_USER]), ADMIN)).rejects.toMatchObject({
        status: 502,
      });

      expect(preTickets.every((p) => p.status === 'MINTING')).toBe(true);
      expect(preTickets.every((p) => p.lastMintError !== null)).toBe(true);
      expect(jobs[0].status).toBe('FAILED');
      expect(mocks().mailDispatcher.dispatchBatch).not.toHaveBeenCalled();
    });
  });

  // ─── AC: PARTIALLY_MINTED + lastMintError (response thiếu ticketId → Δ9a) ───
  describe('EAGER reconciliation Δ9a — response thiếu ticketId', () => {
    it('preTicket thiếu ticketId → lastMintError + job PARTIALLY_MINTED + CRITICAL log, phần còn lại MINTED', async () => {
      mintBehavior = 'partialMissing';

      const res = await service.distribute(makeDto([EMAIL_USER, EMAIL_GUEST]), ADMIN);

      // 2 PreTicket: 1 mint OK (pt-1), 1 thiếu ticketId (pt-2 — partialMissing đánh dấu cuối)
      const minted = preTickets.filter((p) => p.status === 'MINTED');
      const stuck = preTickets.filter((p) => p.status === 'MINTING');
      expect(minted).toHaveLength(1);
      expect(stuck).toHaveLength(1);
      expect(stuck[0].lastMintError).toContain('Δ9a');
      expect(jobs[0].status).toBe('PARTIALLY_MINTED');
      // Email chỉ gửi cho MINTED
      expect(dispatchedPayloads).toHaveLength(1);
      expect(dispatchedPayloads[0].claimToken).toBe(minted[0].claimToken);
    });
  });

  // ─── AC: idempotency retry (alreadyMinted → không mint lại) ───
  describe('admin retry — idempotent dựa content alreadyMinted', () => {
    it('retry job FAILED (MINTING stuck) → mint lại cùng preTicketId; alreadyMinted=true không tạo vé mới', async () => {
      // Lần 1: fail 5xx — PreTickets giữ MINTING
      mintBehavior = 'serverError';
      await expect(service.distribute(makeDto([EMAIL_USER]), ADMIN)).rejects.toBeTruthy();
      const stuckIds = preTickets.map((p) => p.id);
      expect(jobs[0].status).toBe('FAILED');

      // Lần 2: content đã mint sẵn (alreadyMinted) — retry thành công.
      // mockImplementationOnce TRÁNG mock mặc định (mock đẩy call vào mintCalls)
      // → cần push call trong impl once này nữa, không thì mintCalls[1] undefined.
      mintBehavior = 'success';
      const content = mocks().content;
      content.mintForDistribution.mockImplementationOnce(async (call: MintCall) => {
        mintCalls.push(call);
        return {
          results: call.recipients.map((r) => ({
            preTicketId: r.preTicketId,
            ticketId: `tk-${r.preTicketId}`,
            ticketCode: `CODE-${r.preTicketId}`,
            alreadyMinted: true, // content nhận ra preTicketId đã mint từ lần crash
          })),
          soldAfter: 0, // sold KHÔNG tăng
        };
      });

      const res = await service.retryMint(jobs[0].id, ADMIN);

      // Retry dùng ĐÚNG preTicketIds cũ (content dedupe → không doubling)
      expect(mintCalls[1].recipients.map((r) => r.preTicketId)).toEqual(stuckIds);
      expect(res.alreadyMinted).toBe(1);
      expect(res.minted).toBe(1);
      expect(res.status).toBe('COMPLETED');
      expect(preTickets.every((p) => p.status === 'MINTED')).toBe(true);
    });

    it('retry job đang COMPLETED → ConflictException (chỉ PARTIALLY_MINTED/FAILED)', async () => {
      await service.distribute(makeDto([EMAIL_USER]), ADMIN);
      await expect(service.retryMint(jobs[0].id, ADMIN)).rejects.toBeInstanceOf(ConflictException);
    });

    it('retry job quota-EXPIRED → ConflictException (EXPIRED terminal, không mint lại)', async () => {
      mintBehavior = 'quota409';
      await expect(service.distribute(makeDto([EMAIL_USER]), ADMIN)).rejects.toBeInstanceOf(
        ConflictException,
      );
      await expect(service.retryMint(jobs[0].id, ADMIN)).rejects.toBeInstanceOf(ConflictException);
      // KHÔNG gọi mint lần 2 — không doubling
      expect(mintCalls).toHaveLength(1);
    });
  });

  // ─── AC: sig sai → 400 pass-through với per-recipient reason ───
  describe('EAGER sig sai (400 INVALID_PRETICKET_SIGNATURE)', () => {
    it('pass-through 400, PreTickets giữ MINTING + lastMintError chứa preTicketId vi phạm, KHÔNG email', async () => {
      mintBehavior = 'sigFail400';

      await expect(service.distribute(makeDto([EMAIL_USER]), ADMIN)).rejects.toMatchObject({
        status: 400,
        response: { code: 'INVALID_PRETICKET_SIGNATURE' },
      });

      // Sig fail = lỗi cấu hình key KHÔNG phải quota → giữ MINTING để retry
      expect(preTickets.every((p) => p.status === 'MINTING')).toBe(true);
      expect(preTickets[0].lastMintError).toContain('pt-1');
      expect(jobs[0].status).toBe('FAILED');
      expect(mocks().mailDispatcher.dispatchBatch).not.toHaveBeenCalled();
    });
  });

  // ─── AC: resend 2 lần — lần 2 gửi 0 ───
  describe('admin resend-emails — idempotent', () => {
    it('lần 1 gửi N email + set emailSentAt; lần 2 gửi 0 (đã set)', async () => {
      await service.distribute(makeDto([EMAIL_USER]), ADMIN);
      // Email gửi trong distribute() + emailSentAt set → resend lần 1 = 0
      const first = await service.resendEmails(jobs[0].id, ADMIN);
      expect(first.sent).toBe(0);

      // Reset emailSentAt (giả lập email fail lúc trước) → resend gửi 1
      for (const p of preTickets) p.emailSentAt = null;
      const second = await service.resendEmails(jobs[0].id, ADMIN);
      expect(second.sent).toBe(1);
      expect(preTickets[0].emailSentAt).toBeInstanceOf(Date);

      // Lần 3: đã set lại → 0
      const third = await service.resendEmails(jobs[0].id, ADMIN);
      expect(third.sent).toBe(0);
    });

    it('chỉ MINTED có emailSentAt IS NULL — PreTicket MINTING-fail không được gửi', async () => {
      mintBehavior = 'partialMissing';
      await service.distribute(makeDto([EMAIL_USER, EMAIL_GUEST]), ADMIN);
      const stuck = preTickets.find((p) => p.status === 'MINTING')!;

      for (const p of preTickets) p.emailSentAt = null; // reset để resend
      const res = await service.resendEmails(jobs[0].id, ADMIN);

      expect(res.sent).toBe(1); // chỉ 1 MINTED — stuck KHÔNG được gửi
      expect(stuck.emailSentAt).toBeNull();
    });
  });

  // ─── AC: getStatus 4 field mint counts ───
  describe('getStatus — mint counts (minted, mintedWithUser, mintedEmailOnly, mintFailed)', () => {
    it('trả đủ 4 field với số đúng theo trạng thái PreTicket', async () => {
      mintBehavior = 'partialMissing';
      await service.distribute(makeDto([EMAIL_USER, EMAIL_GUEST]), ADMIN);

      const status = await service.getStatus(jobs[0].id);
      expect(status.mint).toEqual({
        minted: 1,          // 1 MINTED
        mintedWithUser: 1,  // MINTED đó có PortalUser
        mintedEmailOnly: 0,
        mintFailed: 1,      // 1 MINTING + lastMintError
      });
    });

    it('includeFailed=true vẫn có mint counts', async () => {
      await service.distribute(makeDto([EMAIL_USER, EMAIL_GUEST]), ADMIN);
      const status = await service.getStatus(jobs[0].id, true);
      expect(status.mint).toEqual({
        minted: 2,
        mintedWithUser: 1,
        mintedEmailOnly: 1,
        mintFailed: 0,
      });
      expect(status.preTickets).toHaveLength(2);
    });
  });

  // ─── AC: buildPayloadByClaimToken — phục dựng payload cho nút "Tải vé PDF" ───
  describe('buildPayloadByClaimToken (nút "Tải vé PDF" trong email)', () => {
    beforeEach(() => {
      preTickets.length = 0;
      jobs.length = 0;
    });

    function seed(token: string) {
      jobs.push({
        id: 'job-pdf',
        ticketTypeId: 'tt-1',
        ticketTypeName: 'Vé VIP',
        eventName: 'Sự kiện test',
        eventId: 'evt-1',
        total: 1,
        sent: 1,
        failed: 0,
        status: 'COMPLETED',
        mintMode: 'EAGER',
        idempotencyKey: null,
        createdAt: new Date('2026-08-28T10:00:00Z'),
      });
      preTickets.push({
        id: 'pt-pdf',
        jobId: 'job-pdf',
        recipientEmailHash: HASH_USER,
        claimToken: token,
        ticketTypeId: 'tt-1',
        eventId: 'evt-1',
        status: 'CLAIMED',
        recipientUserId: 'user-1',
        contentTicketId: 'tk-1',
        contentTicketCode: null,
        mintedAt: null,
        lastMintError: null,
        emailSentAt: new Date(),
      });
    }

    it('token hợp lệ → payload đủ thông tin (email thật, displayName, eventDate/venue từ content, ticketCode slice-8)', async () => {
      seed('tok-secret1');
      const p = await service.buildPayloadByClaimToken('tok-secret1');

      expect(p).not.toBeNull();
      expect(p!.email).toBe(EMAIL_USER);
      expect(p!.claimUrl).toBe('http://localhost:5174/c/tok-secret1');
      expect(p!.ticketTypeName).toBe('Vé VIP');
      expect(p!.eventName).toBe('Sự kiện test');
      expect(p!.ticketCode).toBe('tok-secret1'.slice(-8).toUpperCase());
      expect(p!.customerName).toBe('User Có Tên');
      expect(p!.venue).toBe('Hà Nội');
      expect(p!.eventImage).toBeNull();
      expect(p!.eventDate).not.toBe('');
    });

    it('token không tồn tại → null (controller trả 404)', async () => {
      expect(await service.buildPayloadByClaimToken('nosuch-token')).toBeNull();
    });

    it('user-community có tên → dùng tên đó (ưu tiên hơn portalUser.displayName — fix "API Test")', async () => {
      seed('tok-uc1');
      // PortalUser.displayName trong DB local là "User Có Tên"; user-community
      // (SOT tên thật của user app) trả về tên khác → PDF phải in tên user-community.
      (mocks().userCommunity.lookupDisplayNames as jest.Mock).mockResolvedValueOnce(
        new Map([[EMAIL_USER, 'Nguyễn Văn An']]),
      );

      const p = await service.buildPayloadByClaimToken('tok-uc1');
      expect(p!.customerName).toBe('Nguyễn Văn An');
    });

    it('lookup user-community rỗng/lỗi → fallback portalUser.displayName rồi mới tên mặc định', async () => {
      seed('tok-uc2');
      (mocks().userCommunity.lookupDisplayNames as jest.Mock).mockResolvedValueOnce(
        new Map<string, string>(),
      );

      const p = await service.buildPayloadByClaimToken('tok-uc2');
      expect(p!.customerName).toBe('User Có Tên');
    });

    it('job không tồn tại → null', async () => {
      preTickets.push({
        id: 'pt-orphan',
        jobId: 'job-dau',
        recipientEmailHash: HASH_USER,
        claimToken: 'tok-orphan',
        ticketTypeId: 'tt-1',
        eventId: 'evt-1',
        status: 'MINTED',
        recipientUserId: null,
        contentTicketId: null,
        contentTicketCode: null,
        mintedAt: null,
        lastMintError: null,
        emailSentAt: null,
      });
      expect(await service.buildPayloadByClaimToken('tok-orphan')).toBeNull();
    });

    it('content-service lỗi → vẫn trả payload (fail-soft: thiếu eventDate/venue/ảnh)', async () => {
      seed('tok-grace1');
      mocks().eventService.getTicketTypeWithEvent.mockRejectedValueOnce(
        new Error('content down'),
      );

      const p = await service.buildPayloadByClaimToken('tok-grace1');
      expect(p).not.toBeNull();
      expect(p!.eventDate).toBe('');
      expect(p!.venue).toBeNull();
      expect(p!.eventImage).toBeNull();
      expect(p!.ticketCode).toBe('tok-grace1'.slice(-8).toUpperCase()); // phần còn lại vẫn đủ
    });
  });
});
