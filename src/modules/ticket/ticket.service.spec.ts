/**
 * T6 — syncTicketsByEmail unit test (DESIGN §5.1 S1-S5, §5.5 fail-soft).
 *
 * Mock Prisma + ContentClient + Audit — chỉ test logic TicketService:
 *  - S2 short-circuit: không có MINTED-unlinked → 0 HTTP call
 *  - S3/S4 happy path: linkByEmail gọi 1 lần, updateMany mark LINKED
 *  - S4 khi N=0: vẫn updateMany (idempotent, dọn PreTicket mồ côi)
 *  - S5 fail-soft: linkByEmail throw (ServiceUnavailable/429) → return 0
 *  - Concurrency: 2 sync song song → guard recipientUserId: null chống
 *    double-mark (tổng = 3, KHÔNG phải 6)
 *
 * env được stub TRƯỚC khi import (env.ts evaluate 1 lần).
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

import { HttpException, ServiceUnavailableException } from '@nestjs/common';
import { TicketService } from './ticket.service';
import { AuditService } from '../audit/audit.service';
import { ContentClientService } from '../content-client/content-client.service';
import { generateEmailHash } from '../../common/utils/email-hash.util';

type PreTicketRow = {
  id: string;
  jobId: string;
  recipientEmailHash: string;
  status: string;
  recipientUserId: string | null;
};

const EMAIL = 'sync@example.com';
const HASH = generateEmailHash(EMAIL);
const USER_ID = 'user-sync-1';

function makeRow(id: string, status: string, recipientUserId: string | null = null): PreTicketRow {
  return { id, jobId: `job-${id}`, recipientEmailHash: HASH, status, recipientUserId };
}

describe('TicketService.syncTicketsByEmail (T6 — S1-S5)', () => {
  let service: TicketService;
  let preTickets: PreTicketRow[];
  let linkBehavior: 'ok' | 'okZero' | 'timeout' | 'rate429' | 'serverError';
  let linkCalls: { emailHash: string; userId: string }[];
  let auditRecords: { jobId: string; emailHash?: string; action: string; detail?: unknown }[];

  /** Prisma mock — chỉ các method syncTicketsByEmail dùng (S2 + S4). */
  function makePrismaMock() {
    return {
      preTicket: {
        // S2: findFirst WHERE recipientEmailHash + status MINTED + recipientUserId NULL.
        findFirst: jest.fn(
          ({ where }: { where: { recipientEmailHash: string; status: string; recipientUserId: null } }) =>
            preTickets.find(
              (p) =>
                p.recipientEmailHash === where.recipientEmailHash &&
                p.status === where.status &&
                p.recipientUserId === null,
            ) ?? null,
        ),
        // S4: updateMany WHERE guard đầy đủ — CHỈ đụng row MINTED + userId NULL
        // (mô phỏng đúng Prisma: guard recipientUserId null chặn double-mark).
        updateMany: jest.fn(
          ({ where, data }: { where: { recipientEmailHash: string; status: string; recipientUserId: null }; data: Partial<PreTicketRow> }) => {
            const rows = preTickets.filter(
              (p) =>
                p.recipientEmailHash === where.recipientEmailHash &&
                p.status === where.status &&
                p.recipientUserId === null,
            );
            for (const row of rows) Object.assign(row, data);
            return { count: rows.length };
          },
        ),
      },
    };
  }

  function makeContentMock() {
    return {
      linkByEmail: jest.fn(async (emailHash: string, userId: string) => {
        linkCalls.push({ emailHash, userId });
        if (linkBehavior === 'timeout') {
          throw new ServiceUnavailableException('content-service timeout');
        }
        if (linkBehavior === 'rate429') {
          throw new HttpException({ message: 'ThrottlerException: Too Many Requests', code: 'THROTTLED' }, 429);
        }
        if (linkBehavior === 'serverError') {
          throw new HttpException({ message: 'content-service: Internal error' }, 502);
        }
        // ok: link đúng số row MINTED-unlinked; okZero: content không link gì
        // (ví dụ đã link từ nguồn khác — orphan PreTicket).
        const unlinked = preTickets.filter((p) => p.status === 'MINTED' && p.recipientUserId === null).length;
        const linked = linkBehavior === 'okZero' ? 0 : unlinked;
        return { linked, ticketIds: Array.from({ length: linked }, (_, i) => `tk-${i}`) };
      }),
    };
  }

  function makeService() {
    const prisma = makePrismaMock();
    const content = makeContentMock();
    const audit = {
      record: jest.fn(async (args: { jobId: string; emailHash?: string; action: string; detail?: unknown }) => {
        auditRecords.push(args);
      }),
    };
    service = new TicketService(prisma as never, audit as unknown as AuditService, content as unknown as ContentClientService);
    (service as unknown as Record<string, unknown>).__mocks = { prisma, content, audit };
    return service;
  }

  const mocks = () =>
    (service as unknown as { __mocks: Record<string, unknown> }).__mocks as {
      prisma: ReturnType<typeof makePrismaMock>;
      content: { linkByEmail: jest.Mock };
      audit: { record: jest.Mock };
    };

  beforeEach(() => {
    jest.clearAllMocks();
    preTickets = [];
    linkBehavior = 'ok';
    linkCalls = [];
    auditRecords = [];
    service = makeService();
  });

  // ─── S2 short-circuit ───
  it('KHÔNG có MINTED-unlinked → return 0, linkByEmail KHÔNG được gọi (0 HTTP call)', async () => {
    preTickets = [
      makeRow('pt-1', 'LINKED', USER_ID),   // đã sync
      makeRow('pt-2', 'PENDING'),            // LAZY cũ — sync không đụng
      makeRow('pt-3', 'CLAIMED', USER_ID),
      makeRow('pt-4', 'MINTED', USER_ID),    // MINTED nhưng ĐÃ có userId
    ];

    const res = await service.syncTicketsByEmail(USER_ID, HASH);

    expect(res).toBe(0);
    expect(mocks().content.linkByEmail).not.toHaveBeenCalled();
    expect(mocks().prisma.preTicket.updateMany).not.toHaveBeenCalled();
  });

  // ─── S3+S4 happy path ───
  it('3 MINTED-unlinked → linkByEmail gọi 1 lần, updateMany mark 3 LINKED, return 3', async () => {
    preTickets = [
      makeRow('pt-1', 'MINTED'),
      makeRow('pt-2', 'MINTED'),
      makeRow('pt-3', 'MINTED'),
      makeRow('pt-4', 'LINKED', USER_ID), // đã link — không đếm
    ];

    const res = await service.syncTicketsByEmail(USER_ID, HASH);

    expect(res).toBe(3);
    expect(mocks().content.linkByEmail).toHaveBeenCalledTimes(1);
    expect(linkCalls[0]).toEqual({ emailHash: HASH, userId: USER_ID });
    // S4: updateMany với guard recipientUserId null + data đúng trạng thái
    expect(mocks().prisma.preTicket.updateMany).toHaveBeenCalledWith({
      where: { recipientEmailHash: HASH, status: 'MINTED', recipientUserId: null },
      data: { status: 'LINKED', recipientUserId: USER_ID },
    });
    expect(preTickets.filter((p) => p.status === 'LINKED' && p.recipientUserId === USER_ID)).toHaveLength(4);
    // Audit 1 record PRETICKET_SYNCED cho cả batch
    expect(auditRecords).toHaveLength(1);
    expect(auditRecords[0]).toMatchObject({
      jobId: 'job-pt-1',
      emailHash: HASH,
      action: 'PRETICKET_SYNCED',
    });
    expect(auditRecords[0].detail).toMatchObject({ linked: 3, contentLinked: 3, userId: USER_ID });
  });

  // ─── S4 khi N=0 (orphan PreTicket) ───
  it('content trả linked=0 → VẪN updateMany mark LINKED (idempotent, dọn orphan), không throw', async () => {
    preTickets = [makeRow('pt-1', 'MINTED')];
    linkBehavior = 'okZero';

    const res = await service.syncTicketsByEmail(USER_ID, HASH);

    expect(res).toBe(1);
    expect(mocks().content.linkByEmail).toHaveBeenCalledTimes(1);
    expect(preTickets[0].status).toBe('LINKED');
    expect(preTickets[0].recipientUserId).toBe(USER_ID);
  });

  // ─── S5 fail-soft ───
  it.each([
    ['timeout (ServiceUnavailable)', 'timeout'],
    ['429 rate-limit (HttpException 429)', 'rate429'],
    ['5xx (HttpException 502)', 'serverError'],
  ])('linkByEmail throw %s → return 0, KHÔNG throw, KHÔNG updateMany', async (_label, behavior) => {
    preTickets = [makeRow('pt-1', 'MINTED')];
    linkBehavior = behavior as typeof linkBehavior;

    const res = await service.syncTicketsByEmail(USER_ID, HASH);

    expect(res).toBe(0);
    expect(preTickets[0].status).toBe('MINTED'); // giữ nguyên — retry lần sau
    expect(mocks().prisma.preTicket.updateMany).not.toHaveBeenCalled();
    expect(auditRecords).toHaveLength(0);
  });

  it('DB lỗi ở updateMany (sau link thành công) → vẫn fail-soft return 0', async () => {
    preTickets = [makeRow('pt-1', 'MINTED')];
    const prisma = mocks().prisma;
    (prisma.preTicket.updateMany as jest.Mock).mockRejectedValueOnce(
      new Error('db write failed'),
    );

    const res = await service.syncTicketsByEmail(USER_ID, HASH);

    expect(res).toBe(0);
  });

  // ─── Concurrent sync (guard chống double-mark) ───
  it('2 sync song song cùng emailHash → linkByEmail có thể gọi 2 lần nhưng tổng mark = 3 (KHÔNG double)', async () => {
    preTickets = [makeRow('pt-1', 'MINTED'), makeRow('pt-2', 'MINTED'), makeRow('pt-3', 'MINTED')];

    // Cả 2 sync đọc cùng trạng thái ban đầu (giống race thật: 2 request
    // register/login đồng thời). updateMany mock filter theo trạng thái HIỆN
    // TẠI của row — sync 2 chỉ còn đụng row chưa bị sync 1 mark → không double.
    const [r1, r2] = await Promise.all([
      service.syncTicketsByEmail(USER_ID, HASH),
      service.syncTicketsByEmail(USER_ID, HASH),
    ]);

    // linkByEmail CÓ THỂ gọi 2 lần (content idempotent — lần 2 trả 0)
    expect(linkCalls.length).toBeGreaterThanOrEqual(1);
    expect(linkCalls.length).toBeLessThanOrEqual(2);
    // Tổng mark đúng 3 — KHÔNG double 6
    expect(r1 + r2).toBe(3);
    expect(preTickets.filter((p) => p.status === 'LINKED' && p.recipientUserId === USER_ID)).toHaveLength(3);
  });
});
