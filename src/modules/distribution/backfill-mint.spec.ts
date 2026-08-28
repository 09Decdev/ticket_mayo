/**
 * Test-suite T7 — Backfill PreTicket PENDING → EAGER mint
 * (src/modules/distribution/backfill.runner.ts — logic importable; CLI entry
 * scripts/backfill-mint.ts là thin wrapper, jest rootDir=src không scan scripts/).
 *
 * Mock toàn bộ dependency (Prisma, ContentClient, Audit) — chỉ test logic:
 *  - dry-run JSON đúng số + KHÔNG gọi mint
 *  - idempotent: chạy 2x → lần 2 không mint (PreTicket đã MINTED)
 *  - quota shortage: remaining < PENDING → phần vượt EXPIRED + audit
 *    BACKFILL_QUOTA_EXCEEDED + report
 *  - T3-M6 verify: soldAfter != soldBefore + minted → exitCode 2
 *  - guard: không confirm → dry-run only
 *
 * env được stub trước khi import (env.ts evaluate 1 lần — pattern
 * distribution.service.spec.ts).
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

import { HttpException, HttpStatus } from '@nestjs/common';
import {
  runBackfill,
  parseArgs,
  parseDbHost,
  parseBackfillLimit,
  BACKFILL_DRY_RUN_DEFAULT_LIMIT,
  BACKFILL_DRY_RUN_MAX_LIMIT,
  type BackfillDeps,
  type BackfillPendingRow,
} from './backfill.runner';
import { DistributionController } from './distribution.controller';

// ─── Mock state types ───
type PtRow = BackfillPendingRow & {
  status: string;
  contentTicketId: string | null;
  contentTicketCode: string | null;
  mintedAt: Date | null;
  lastMintError: string | null;
  createdAt: Date;
};

type AuditRecord = { jobId: string; emailHash?: string; action: string; detail?: unknown };

interface ContentTicketTypeState {
  id: string;
  eventId: string;
  quantity: number;
  sold: number;
}

/** Job-row mock (MAJOR-2) — type ở scope describe. */
type JobRow = { id: string; status: string };

describe('Backfill T7 — backfill.runner', () => {
  let preTickets: PtRow[];
  let portalUsers: { id: string; emailHash: string }[];
  let audits: AuditRecord[];
  let ticketTypes: Map<string, ContentTicketTypeState>;
  let mintCalls: {
    eventId: string;
    ticketTypeId: string;
    recipients: { preTicketId: string; emailHash: string; userId?: string | null }[];
    idempotencyKey: string;
  }[];
  let mintBehavior: 'success' | 'quota409' | 'serverError';
  let ttReadCount: Map<string, number>;
  /** MAJOR-2: job rows — mock distributionJob.updateMany dùng state này. */
  let jobs: JobRow[];
  /** MINOR-3: lỗi verify-read (getTicketType lần 2 throw) — MAJOR-1 path. */
  let verifyReadFail: boolean;

  const TT1 = { id: 'tt-1', eventId: 'evt-1', quantity: 100, sold: 10 };
  const TT2 = { id: 'tt-2', eventId: 'evt-1', quantity: 50, sold: 49 };

  function makePt(
    id: string,
    ticketTypeId: string,
    createdAtOffsetMs: number,
    overrides?: Partial<PtRow>,
  ): PtRow {
    return {
      id,
      jobId: overrides?.jobId ?? 'job-1',
      eventId: overrides?.eventId ?? 'evt-1',
      ticketTypeId,
      ticketTypeName: overrides?.ticketTypeName ?? `Loại ${ticketTypeId}`,
      eventName: overrides?.eventName ?? 'Sự kiện test',
      recipientEmailHash: overrides?.recipientEmailHash ?? `hash-${id}`,
      recipientUserId: overrides?.recipientUserId ?? null,
      status: overrides?.status ?? 'PENDING',
      contentTicketId: overrides?.contentTicketId ?? null,
      contentTicketCode: overrides?.contentTicketCode ?? null,
      mintedAt: overrides?.mintedAt ?? null,
      lastMintError: overrides?.lastMintError ?? null,
      createdAt: new Date(2026, 0, 1, 0, 0, 0, createdAtOffsetMs),
    };
  }

  /** Reset state + build mocks chuẩn cho mỗi test. */
  function setup(state: { preTickets: PtRow[]; ticketTypes: ContentTicketTypeState[] }) {
    preTickets = state.preTickets.map((p) => ({ ...p }));
    portalUsers = state.preTickets
      .filter((p) => p.recipientUserId)
      .map((p) => ({ id: p.recipientUserId!, emailHash: p.recipientEmailHash }));
    audits = [];
    mintCalls = [];
    mintBehavior = 'success';
    ticketTypes = new Map(state.ticketTypes.map((t) => [t.id, { ...t }]));
    ttReadCount = new Map();
    // MAJOR-2: mỗi jobId khác nhau → 1 job row RUNNING (giống job đã distribute xong).
    jobs = [...new Set(state.preTickets.map((p) => p.jobId))].map((id) => ({
      id,
      status: 'RUNNING',
    }));
    verifyReadFail = false;

    const prismaMock = {
      preTicket: {
        findMany: jest.fn(async ({ where, take }: { where: Record<string, unknown>; take?: number }) => {
          const ids = (where.id as { in: string[] } | undefined)?.in;
          const rows = preTickets
            .filter((p) => {
              if (where.status && p.status !== where.status) return false;
              if (where.jobId && p.jobId !== where.jobId) return false;
              if (ids && !ids.includes(p.id)) return false;
              return true;
            })
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
          return take !== undefined ? rows.slice(0, take) : rows;
        }),
        count: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
          preTickets.filter((p) => {
            if (where.status && p.status !== where.status) return false;
            if (where.jobId && p.jobId !== where.jobId) return false;
            return true;
          }).length,
        ),
        updateMany: jest.fn(
          async ({
            where,
            data,
          }: {
            where: { status?: string; id?: { in: string[] }; jobId?: string };
            data: Record<string, unknown>;
          }) => {
            let count = 0;
            for (const p of preTickets) {
              if (where.status && p.status !== where.status) continue;
              if (where.jobId && p.jobId !== where.jobId) continue;
              if (where.id && !where.id.in.includes(p.id)) continue;
              Object.assign(p, data);
              count++;
            }
            return { count };
          },
        ),
        groupBy: jest.fn(
          async ({
            where,
          }: {
            where: { status?: { in: string[] } };
          }) => {
            const statuses = where.status?.in ?? [];
            const counts = new Map<string, number>();
            for (const p of preTickets) {
              if (!statuses.includes(p.status)) continue;
              counts.set(p.status, (counts.get(p.status) ?? 0) + 1);
            }
            return [...counts.entries()].map(([status, count]) => ({
              status,
              _count: { _all: count },
            }));
          },
        ),
      },
      portalUser: {
        findMany: jest.fn(
          async ({ where }: { where: { emailHash: { in: string[] } } }) =>
            portalUsers.filter((u) => where.emailHash.in.includes(u.emailHash)),
        ),
      },
      // MAJOR-2: mock distributionJob.updateMany — honor notIn status filter.
      distributionJob: {
        updateMany: jest.fn(
          async ({
            where,
            data,
          }: {
            where: { id?: { in: string[] }; status?: { notIn: string[] } };
            data: Record<string, unknown>;
          }) => {
            let count = 0;
            for (const j of jobs) {
              if (where.id && !where.id.in.includes(j.id)) continue;
              if (where.status?.notIn && where.status.notIn.includes(j.status)) continue;
              Object.assign(j, data);
              count++;
            }
            return { count };
          },
        ),
      },
    };

    const contentMock = {
      getTicketType: jest.fn(async (id: string) => {
        ttReadCount.set(id, (ttReadCount.get(id) ?? 0) + 1);
        // MINOR-3 / MAJOR-1: lần đọc thứ 2 (verify) có thể fail — content
        // chết ngay SAU mint thành công.
        if (verifyReadFail && (ttReadCount.get(id) ?? 0) >= 2) {
          throw new HttpException('content-service down', HttpStatus.BAD_GATEWAY);
        }
        const tt = ticketTypes.get(id);
        if (!tt) throw new HttpException('not found', HttpStatus.NOT_FOUND);
        return { ...tt };
      }),
      mintForDistribution: jest.fn(
        async (body: {
          eventId: string;
          ticketTypeId: string;
          recipients: { preTicketId: string; emailHash: string; userId?: string | null }[];
          idempotencyKey: string;
        }) => {
          mintCalls.push(body);
          if (mintBehavior === 'quota409') {
            throw new HttpException(
              {
                message: 'Hết vé hoặc vượt quota: remaining=0.',
                code: 'TICKET_SOLD_OUT',
                remaining: 0,
                requested: body.recipients.length,
              },
              HttpStatus.CONFLICT,
            );
          }
          if (mintBehavior === 'serverError') {
            throw new HttpException(
              'content-service hiện không khả dụng.',
              HttpStatus.BAD_GATEWAY,
            );
          }
          // success: mint mới các PreTicket chưa có vé (idempotent content-side
          // theo preTicketId unique — alreadyMinted khi PreTicket này đã mint).
          const tt = ticketTypes.get(body.ticketTypeId)!;
          const results = body.recipients.map((r) => {
            const pt = preTickets.find((p) => p.id === r.preTicketId);
            const alreadyMinted = !!pt?.contentTicketId;
            if (!alreadyMinted && tt.sold < tt.quantity) {
              tt.sold++;
              return {
                preTicketId: r.preTicketId,
                ticketId: `ticket-${r.preTicketId}`,
                ticketCode: `CODE-${r.preTicketId}`,
                alreadyMinted: false,
              };
            }
            return {
              preTicketId: r.preTicketId,
              ticketId: pt?.contentTicketId ?? `ticket-${r.preTicketId}`,
              ticketCode: pt?.contentTicketCode ?? `CODE-${r.preTicketId}`,
              alreadyMinted: true,
            };
          });
          return { results, soldAfter: tt.sold };
        },
      ),
    };

    const auditMock = {
      record: jest.fn(async (args: AuditRecord) => {
        audits.push(args);
      }),
    };

    const deps: BackfillDeps = {
      prisma: prismaMock as unknown as BackfillDeps['prisma'],
      content: contentMock as unknown as BackfillDeps['content'],
      audit: auditMock as unknown as BackfillDeps['audit'],
    };
    return { deps, prismaMock, contentMock, auditMock };
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ─── 1. DRY-RUN ───
  describe('dry-run (default — KHÔNG confirm)', () => {
    it('N PENDING 2 ticketTypes, remaining đủ/thiếu → JSON đúng số, KHÔNG gọi mint', async () => {
      // TT1: 3 PENDING, remaining 90 → mint 3, expired 0.
      // TT2: 2 PENDING, remaining 1 → mint 1, expired 1.
      const { deps, contentMock } = setup({
        preTickets: [
          makePt('pt-1', TT1.id, 1),
          makePt('pt-2', TT1.id, 2),
          makePt('pt-3', TT1.id, 3),
          makePt('pt-4', TT2.id, 4),
          makePt('pt-5', TT2.id, 5),
        ],
        ticketTypes: [TT1, TT2],
      });

      const res = await runBackfill(deps, { dryRun: true, dbHost: 'localhost:55432' });

      expect(res.exitCode).toBe(0);
      expect(contentMock.mintForDistribution).not.toHaveBeenCalled();
      const report = res.report!;
      expect(report.mode).toBe('dry-run');

      const tt1 = (report as { plans: { ticketTypeId: string; pendingCount: number; remaining: number | null; toMint: number; expectedExpired: number }[] }).plans.find(
        (p) => p.ticketTypeId === TT1.id,
      );
      const tt2 = (report as { plans: { ticketTypeId: string; pendingCount: number; remaining: number | null; toMint: number; expectedExpired: number }[] }).plans.find(
        (p) => p.ticketTypeId === TT2.id,
      );
      expect(tt1).toMatchObject({ pendingCount: 3, remaining: 90, toMint: 3, expectedExpired: 0 });
      expect(tt2).toMatchObject({ pendingCount: 2, remaining: 1, toMint: 1, expectedExpired: 1 });
      expect(report.totals).toEqual({ pending: 5, toMint: 4, expectedExpired: 1 });

      // Dry-run KHÔNG đổi trạng thái PreTicket.
      for (const pt of preTickets) expect(pt.status).toBe('PENDING');
      // Dry-run KHÔNG audit.
      expect(audits).toHaveLength(0);
    });

    it('cảnh báo stuck MINTING/CLAIMING riêng — không tính là PENDING', async () => {
      const { deps } = setup({
        preTickets: [
          makePt('pt-1', TT1.id, 1),
          makePt('pt-2', TT1.id, 2, { status: 'MINTING' }),
          makePt('pt-3', TT1.id, 3, { status: 'CLAIMING' }),
        ],
        ticketTypes: [TT1],
      });
      const res = await runBackfill(deps, { dryRun: true, dbHost: 'localhost:55432' });
      const report = res.report as {
        totals: { pending: number };
        stuckCounts: { status: string; count: number }[];
      };
      expect(report.totals.pending).toBe(1); // chỉ pt-1
      expect(report.stuckCounts).toContainEqual({ status: 'MINTING', count: 1 });
      expect(report.stuckCounts).toContainEqual({ status: 'CLAIMING', count: 1 });
    });
  });

  // ─── 2. GUARD ───
  describe('guard real-run', () => {
    it('KHÔNG gõ BACKFILL → abort, KHÔNG mint, KHÔNG ghi DB, exit 0', async () => {
      const { deps, contentMock } = setup({
        preTickets: [makePt('pt-1', TT1.id, 1)],
        ticketTypes: [TT1],
      });
      const res = await runBackfill(deps, {

        dryRun: false,
        dbHost: 'localhost:55432',
        confirm: async () => false, // gõ sai / Ctrl-C
      });
      expect(res.aborted).toBe(true);
      expect(res.exitCode).toBe(0);
      expect(contentMock.mintForDistribution).not.toHaveBeenCalled();
      expect(preTickets[0].status).toBe('PENDING'); // KHÔNG đụng gì
    });

    it('parseArgs: không --confirm → dryRun=true (guard dry-run default)', () => {
      expect(parseArgs([])).toMatchObject({ confirm: false, dryRun: true });
      expect(parseArgs(['--confirm'])).toMatchObject({ confirm: true, dryRun: false });
      expect(parseArgs(['--job-id', 'job-9'])).toMatchObject({ jobId: 'job-9', dryRun: true });
      expect(parseArgs(['--confirm', '--yes'])).toMatchObject({ confirm: true, yes: true });
    });

    it('MINOR-4: dbHost unknown/rỗng → REFUSE chạy thật (aborted exit 0), KHÔNG mint', async () => {
      const { deps, contentMock, prismaMock } = setup({
        preTickets: [makePt('pt-1', TT1.id, 1)],
        ticketTypes: [TT1],
      });
      const res = await runBackfill(deps, {
        dryRun: false,
        dbHost: 'unknown', // parseDbHost không match @host/
        confirm: async () => true, // kể cả khi operator gõ đúng BACKFILL
      });
      expect(res.aborted).toBe(true);
      expect(res.exitCode).toBe(0);
      expect(contentMock.mintForDistribution).not.toHaveBeenCalled();
      expect(prismaMock.preTicket.updateMany).not.toHaveBeenCalled();
      expect(preTickets[0].status).toBe('PENDING'); // KHÔNG đụng gì
    });
  });

  // ─── 3. REAL RUN — idempotency ───
  describe('idempotent — chạy 2x', () => {
    it('lần 2 KHÔNG mint PreTicket đã MINTED (chỉ đụng PENDING)', async () => {
      const { deps, contentMock } = setup({
        preTickets: [
          makePt('pt-1', TT1.id, 1, { recipientUserId: 'user-1' }),
          makePt('pt-2', TT1.id, 2),
        ],
        ticketTypes: [TT1],
      });
      const confirm = async () => true;

      // Lần 1: mint cả 2.
      const r1 = await runBackfill(deps, { dryRun: false, dbHost: 'localhost:55432', confirm });
      expect(r1.exitCode).toBe(0);
      expect((r1.report as { totals: { minted: number } }).totals.minted).toBe(2);
      expect(mintCalls).toHaveLength(1);

      // Lần 2: 0 PENDING → 0 mint call.
      const r2 = await runBackfill(deps, { dryRun: false, dbHost: 'localhost:55432', confirm });
      expect(r2.exitCode).toBe(0);
      expect((r2.report as { totals: { pendingAtStart: number; minted: number } }).totals).toMatchObject({
        pendingAtStart: 0,
        minted: 0,
      });
      expect(mintCalls).toHaveLength(1); // không có call mới
      expect(preTickets.every((p) => p.status === 'MINTED')).toBe(true);
    });

    it('content trả alreadyMinted (crash giữa chừng cũ) → KHÔNG đếm mint mới, KHÔNG mint đôi', async () => {
      // pt-1 đã MINTED từ đợt trước nhưng status DB vẫn PENDING (khối crash cũ
      // trước khi update) — content-side preTicketId unique trả ticket cũ.
      const { deps } = setup({
        preTickets: [
          makePt('pt-1', TT1.id, 1, { status: 'PENDING', contentTicketId: 'ticket-old', contentTicketCode: 'CODE-old' }),
          makePt('pt-2', TT1.id, 2),
        ],
        ticketTypes: [TT1],
      });
      const res = await runBackfill(deps, {
        dryRun: false,
        dbHost: 'localhost:55432',
        confirm: async () => true,
      });
      const report = res.report as { totals: { minted: number; alreadyMinted: number } };
      expect(report.totals.minted).toBe(1);
      expect(report.totals.alreadyMinted).toBe(1);
      expect(res.exitCode).toBe(0);
    });
  });

  // ─── 4. QUOTA SHORTAGE (Q3) ───
  describe('quota shortage — remaining < PENDING', () => {
    it('phần vượt → EXPIRED terminal + audit BACKFILL_QUOTA_EXCEEDED + report', async () => {
      // TT2: quantity 50, sold 49 → remaining 1; 3 PENDING → mint 1, EXPIRED 2.
      const tt2Low = { id: TT2.id, eventId: TT2.eventId, quantity: 50, sold: 49 };
      const { deps } = setup({
        preTickets: [
          makePt('pt-1', tt2Low.id, 1),
          makePt('pt-2', tt2Low.id, 2),
          makePt('pt-3', tt2Low.id, 3),
        ],
        ticketTypes: [tt2Low],
      });
      const res = await runBackfill(deps, {
        dryRun: false,
        dbHost: 'localhost:55432',
        confirm: async () => true,
      });
      const report = res.report as {
        totals: { minted: number; expired: number };
        expiredJobIds: string[];
        perType: { ticketTypeId: string; minted: number; expired: number }[];
      };
      expect(report.totals.minted).toBe(1);
      expect(report.totals.expired).toBe(2);
      expect(report.expiredJobIds).toContain('job-1');

      // PreTicket trạng thái cuối: 1 MINTED + 2 EXPIRED.
      const statuses = preTickets.map((p) => p.status).sort();
      expect(statuses).toEqual(['EXPIRED', 'EXPIRED', 'MINTED']);
      // EXPIRED có lastMintError ghi nhận quota.
      const expired = preTickets.filter((p) => p.status === 'EXPIRED');
      expect(expired.every((p) => !!p.lastMintError)).toBe(true);

      // Audit BACKFILL_QUOTA_EXCEEDED + BACKFILL_SUMMARY.
      const quotaAudit = audits.find((a) => a.action === 'BACKFILL_QUOTA_EXCEEDED');
      expect(quotaAudit).toBeDefined();
      expect(quotaAudit!.detail).toMatchObject({
        ticketTypeId: tt2Low.id,
        expiredCount: 2,
      });
      expect(audits.find((a) => a.action === 'BACKFILL_SUMMARY')).toBeDefined();
      expect(res.exitCode).toBe(0);
    });

    it('409 runtime TICKET_SOLD_OUT (không đọc remaining trước) → phần còn lại EXPIRED, KHÔNG silently drop', async () => {
      // getTicketType throw → script mint full batch, bắt 409 runtime.
      const tt2Low = { id: TT2.id, eventId: TT2.eventId, quantity: 50, sold: 50 };
      const { deps, contentMock } = setup({
        preTickets: [makePt('pt-1', tt2Low.id, 1), makePt('pt-2', tt2Low.id, 2)],
        ticketTypes: [tt2Low],
      });
      (contentMock.getTicketType as jest.Mock).mockRejectedValue(
        new HttpException('content down', HttpStatus.BAD_GATEWAY),
      );
      mintBehavior = 'quota409';

      const res = await runBackfill(deps, {
        dryRun: false,
        dbHost: 'localhost:55432',
        confirm: async () => true,
      });
      const report = res.report as { totals: { expired: number }; verification: { allOk: boolean } };
      expect(report.totals.expired).toBe(2);
      expect(preTickets.every((p) => p.status === 'EXPIRED')).toBe(true);
      expect(audits.find((a) => a.action === 'BACKFILL_QUOTA_EXCEEDED')).toBeDefined();
      // soldBefore unknown → verify skip, không fail.
      expect(report.verification.allOk).toBe(true);
    });
  });

  // ─── 5. T3-M6 VERIFY ───
  describe('T3-M6 verify DB-side', () => {
    it('soldAfter != soldBefore + minted → exitCode 2 + mismatch trong report', async () => {
      const { deps, contentMock } = setup({
        preTickets: [makePt('pt-1', TT1.id, 1)],
        ticketTypes: [TT1],
      });
      // Sau mint (sold 10→11), verify đọc sold BỊA 99 → mismatch.
      (contentMock.getTicketType as jest.Mock).mockImplementation(async (id: string) => {
        const n = ttReadCount.get(id) ?? 0;
        ttReadCount.set(id, n + 1);
        const tt = ticketTypes.get(id)!;
        // Lần đọc verify (lần 2) trả lệch.
        return { id, sold: n >= 1 ? 99 : tt.sold, quantity: tt.quantity };
      });

      const res = await runBackfill(deps, {
        dryRun: false,
        dbHost: 'localhost:55432',
        confirm: async () => true,
      });
      expect(res.exitCode).toBe(2);
      const report = res.report as {
        verification: {
          allOk: boolean;
          mismatches: { ticketTypeId: string; expectedSold: number; actualSold: number }[];
        };
      };
      expect(report.verification.allOk).toBe(false);
      expect(report.verification.mismatches).toEqual([
        { ticketTypeId: TT1.id, expectedSold: 11, actualSold: 99 },
      ]);
    });

    it('soldAfter == soldBefore + minted → exitCode 0', async () => {
      const { deps } = setup({
        preTickets: [makePt('pt-1', TT1.id, 1)],
        ticketTypes: [TT1],
      });
      const res = await runBackfill(deps, {
        dryRun: false,
        dbHost: 'localhost:55432',
        confirm: async () => true,
      });
      expect(res.exitCode).toBe(0);
      const report = res.report as { verification: { allOk: boolean } };
      expect(report.verification.allOk).toBe(true);
    });

    it('MAJOR-1: verify-read fail (getTicketType lần 2 throw) → ok=true + warning, KHÔNG exit 2', async () => {
      // Mint thành công, rồi content chết NGAY SAU → verify không đọc được
      // sold. Mint ĐÃ áp DB — đây là lỗi đọc, KHÔNG phải lệch dữ liệu.
      const { deps } = setup({
        preTickets: [makePt('pt-1', TT1.id, 1)],
        ticketTypes: [TT1],
      });
      verifyReadFail = true; // lần getTicketType thứ 2 (verify) throw 502

      const res = await runBackfill(deps, {
        dryRun: false,
        dbHost: 'localhost:55432',
        confirm: async () => true,
      });
      expect(res.exitCode).toBe(0); // KHÔNG phải 2
      const report = res.report as {
        verification: { allOk: boolean; mismatches: unknown[] };
        perType: { verify: { ok: boolean; actualSold: number | null } }[];
        warnings: string[];
      };
      expect(report.verification.allOk).toBe(true);
      expect(report.verification.mismatches).toEqual([]);
      expect(report.perType[0].verify).toMatchObject({ ok: true, actualSold: null });
      expect(report.warnings.some((w) => w.includes('verify skipped'))).toBe(true);
      // Mint vẫn được áp DB đầy đủ.
      expect(preTickets[0].status).toBe('MINTED');
    });
  });

  // ─── 6. TECHNICAL FAIL — 5xx/transport (MAJOR-2 + MINOR-3) ───
  describe('technical fail 5xx — giữ MINTING + job PARTIALLY_MINTED (MAJOR-2)', () => {
    it('MINOR-3(1): 500 toàn batch → mọi row giữ MINTING + lastMintError + skippedTechnical + job PARTIALLY_MINTED', async () => {
      const { deps, prismaMock } = setup({
        preTickets: [
          makePt('pt-1', TT1.id, 1),
          makePt('pt-2', TT1.id, 2),
          makePt('pt-3', TT1.id, 3, { jobId: 'job-2' }),
        ],
        ticketTypes: [TT1],
      });
      mintBehavior = 'serverError';

      const res = await runBackfill(deps, {
        dryRun: false,
        dbHost: 'localhost:55432',
        confirm: async () => true,
      });
      const report = res.report as {
        totals: { skippedTechnical: number; minted: number };
        warnings: string[];
      };
      // Mọi row giữ MINTING (KHÔNG rollback PENDING, KHÔNG EXPIRED).
      expect(preTickets.every((p) => p.status === 'MINTING')).toBe(true);
      expect(preTickets.every((p) => !!p.lastMintError)).toBe(true);
      expect(report.totals.skippedTechnical).toBe(3);
      expect(report.totals.minted).toBe(0);
      // MAJOR-2: cả 2 job bị flag PARTIALLY_MINTED → retryMint là rescue path.
      expect(prismaMock.distributionJob.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: { in: expect.arrayContaining(['job-1', 'job-2']) },
            status: { notIn: ['FAILED', 'PARTIALLY_MINTED'] },
          }),
          data: { status: 'PARTIALLY_MINTED' },
        }),
      );
      expect(jobs.every((j) => j.status === 'PARTIALLY_MINTED')).toBe(true);
      expect(report.warnings.some((w) => w.includes('PARTIALLY_MINTED'))).toBe(true);
      expect(res.exitCode).toBe(0);
    });

    it('MINOR-3(2): 500 giữa chunk + partialMintResults → chunk thành công áp MINTED, phần còn lại giữ MINTING + job flag', async () => {
      const { deps, prismaMock } = setup({
        preTickets: [
          makePt('pt-1', TT1.id, 1),
          makePt('pt-2', TT1.id, 2),
          makePt('pt-3', TT1.id, 3),
        ],
        ticketTypes: [TT1],
      });
      // Mint thật pt-1 trong content, rồi throw 502 kèm partialMintResults.
      (deps.content.mintForDistribution as unknown as jest.Mock).mockImplementation(
        async (body: {
          recipients: { preTicketId: string; emailHash: string; userId?: string | null }[];
        }) => {
          mintCalls.push(body as never);
          const tt = ticketTypes.get(TT1.id)!;
          tt.sold++; // pt-1 mint thật
          const partial = {
            preTicketId: body.recipients[0].preTicketId,
            ticketId: `ticket-${body.recipients[0].preTicketId}`,
            ticketCode: `CODE-${body.recipients[0].preTicketId}`,
            alreadyMinted: false,
          };
          const err = new HttpException('content-service chết giữa chunk', HttpStatus.BAD_GATEWAY) as HttpException & {
            partialMintResults: unknown[];
          };
          err.partialMintResults = [partial];
          throw err;
        },
      );

      const res = await runBackfill(deps, {
        dryRun: false,
        dbHost: 'localhost:55432',
        confirm: async () => true,
      });
      const report = res.report as { totals: { minted: number; skippedTechnical: number } };
      // pt-1 mint thật → MINTED; pt-2/pt-3 giữ MINTING.
      expect(preTickets.find((p) => p.id === 'pt-1')!.status).toBe('MINTED');
      expect(preTickets.find((p) => p.id === 'pt-1')!.contentTicketId).toBe('ticket-pt-1');
      expect(['pt-2', 'pt-3'].every((id) => preTickets.find((p) => p.id === id)!.status === 'MINTING')).toBe(true);
      expect(report.totals.minted).toBe(1);
      expect(report.totals.skippedTechnical).toBe(2);
      // MAJOR-2: job được flag dù có partial mint.
      expect(prismaMock.distributionJob.updateMany).toHaveBeenCalled();
      expect(jobs[0].status).toBe('PARTIALLY_MINTED');
      // MAJOR-1 path: verify-read OK (sold 10→11, expected 11).
      expect(res.exitCode).toBe(0);
    });
  });

  // ─── 6. --job-id filter ───
  describe('--job-id filter', () => {
    it('chỉ xử lý PreTicket của job đó (dry-run)', async () => {
      const { deps } = setup({
        preTickets: [
          makePt('pt-1', TT1.id, 1, { jobId: 'job-a' }),
          makePt('pt-2', TT1.id, 2, { jobId: 'job-b' }),
        ],
        ticketTypes: [TT1],
      });
      const res = await runBackfill(deps, {
        dryRun: true,
        jobIdFilter: 'job-a',
        dbHost: 'localhost:55432',
      });
      const report = res.report as { totals: { pending: number } };
      expect(report.totals.pending).toBe(1);
    });
  });

  // ─── 7. Endpoint GET /admin/backfill/dry-run — anti-DoS cap (PLAN L313) ───
  describe('dry-run scan limit (endpoint GET /admin/backfill/dry-run)', () => {
    it('mặc định KHÔNG cap (CLI path) → truncated=false, scan full', async () => {
      const { deps } = setup({
        preTickets: [makePt('pt-1', TT1.id, 1), makePt('pt-2', TT1.id, 2)],
        ticketTypes: [TT1],
      });
      const res = await runBackfill(deps, { dryRun: true, dbHost: 'localhost:55432' });
      const report = res.report as {
        totals: { pending: number };
        scan: { truncated: boolean; scannedCount: number; totalPending: number };
      };
      expect(report.scan).toEqual({ limit: Infinity, scannedCount: 2, totalPending: 2, truncated: false });
      expect(report.totals.pending).toBe(2);
    });

    it('6000 PENDING + limit default 1000 → truncated=true, scannedCount=1000, totalPending=6000', async () => {
      // 6000 PENDING qua 2 ticketTypes — endpoint không truyền limit → 1000.
      const many = Array.from({ length: 6000 }, (_, i) =>
        makePt(`pt-${i}`, i < 3000 ? TT1.id : TT2.id, i),
      );
      const { deps, contentMock, prismaMock } = setup({
        preTickets: many,
        ticketTypes: [TT1, TT2],
      });

      const res = await runBackfill(deps, {
        dryRun: true,
        dbHost: 'localhost:55432',
        dryRunScanLimit: BACKFILL_DRY_RUN_DEFAULT_LIMIT,
      });

      const report = res.report as {
        totals: { pending: number; toMint: number };
        plans: { ticketTypeId: string; pendingCount: number }[];
        scan: { limit: number; scannedCount: number; totalPending: number; truncated: boolean };
        warnings: string[];
      };
      expect(report.scan).toEqual({ limit: 1000, scannedCount: 1000, totalPending: 6000, truncated: true });
      expect(report.totals.pending).toBe(1000); // totals chỉ tính phần scanned
      // findMany được gọi với take=1000 (anti-DoS: KHÔNG quét toàn bảng).
      expect((prismaMock.preTicket.findMany as jest.Mock).mock.calls[0][0]).toMatchObject({ take: 1000 });
      // getTicketType chỉ gọi theo số group trong phần scanned: 1000 row đầu
      // (createdAt asc) đều là TT1 → 1 group → 1 call; TT2 (3000 row sau)
      // KHÔNG bao giờ được fetch — cap chống quét toàn bảng hoạt động.
      expect(contentMock.getTicketType).toHaveBeenCalledTimes(1);
      expect(contentMock.getTicketType).toHaveBeenCalledWith(TT1.id);
      // Warning báo bị cắt.
      expect(report.warnings.some((w) => w.includes('BỊ CẮT'))).toBe(true);
    });

    it('limit > 5000 → bị kẹp về 5000 (parseBackfillLimit)', () => {
      expect(parseBackfillLimit('999999')).toBe(BACKFILL_DRY_RUN_MAX_LIMIT);
      expect(parseBackfillLimit('5001')).toBe(5000);
      expect(parseBackfillLimit('5000')).toBe(5000);
      expect(parseBackfillLimit('100')).toBe(100);
      expect(parseBackfillLimit(undefined)).toBe(1000);
      expect(parseBackfillLimit('')).toBe(1000);
      expect(() => parseBackfillLimit('0')).toThrow();
      expect(() => parseBackfillLimit('-5')).toThrow();
      expect(() => parseBackfillLimit('abc')).toThrow();
    });

    it('read-only tuyệt đối: dry-run với scanLimit KHÔNG updateMany / mint / audit', async () => {
      const { deps, prismaMock, contentMock, auditMock } = setup({
        preTickets: [
          makePt('pt-1', TT1.id, 1),
          makePt('pt-2', TT2.id, 2),
          makePt('pt-3', TT2.id, 3),
        ],
        ticketTypes: [TT1, TT2],
      });
      await runBackfill(deps, {
        dryRun: true,
        dbHost: 'localhost:55432',
        dryRunScanLimit: 2,
      });
      expect(prismaMock.preTicket.updateMany).not.toHaveBeenCalled();
      expect(contentMock.mintForDistribution).not.toHaveBeenCalled();
      expect(auditMock.record).not.toHaveBeenCalled();
      for (const pt of preTickets) expect(pt.status).toBe('PENDING');
    });

    it('jobId filter hoạt động với scanLimit (đếm totalPending đúng theo filter)', async () => {
      const { deps } = setup({
        preTickets: [
          makePt('pt-1', TT1.id, 1, { jobId: 'job-a' }),
          makePt('pt-2', TT1.id, 2, { jobId: 'job-a' }),
          makePt('pt-3', TT2.id, 3, { jobId: 'job-b' }),
        ],
        ticketTypes: [TT1, TT2],
      });
      const res = await runBackfill(deps, {
        dryRun: true,
        dbHost: 'localhost:55432',
        dryRunScanLimit: 1,
        jobIdFilter: 'job-a',
      });
      const report = res.report as {
        totals: { pending: number };
        scan: { scannedCount: number; totalPending: number; truncated: boolean };
      };
      // job-a có 2 PENDING, scan 1 → truncated, và KHÔNG đếm pt-3 (job-b).
      expect(report.scan).toEqual({ limit: 1, scannedCount: 1, totalPending: 2, truncated: true });
      expect(report.totals.pending).toBe(1);
    });
  });

  // ─── 7. ENDPOINT GET /admin/backfill/dry-run (DistributionController) ───
  describe('endpoint GET /admin/backfill/dry-run — DistributionController', () => {
    it('trả DryRunReport đúng + truyền limit/jobId xuống DB (take + where)', async () => {
      const { prismaMock, contentMock } = setup({
        preTickets: [
          makePt('pt-1', TT1.id, 1, { jobId: 'job-a' }),
          makePt('pt-2', TT1.id, 2, { jobId: 'job-a' }),
          makePt('pt-3', TT2.id, 3, { jobId: 'job-b' }),
        ],
        ticketTypes: [TT1, TT2],
      });
      const controller = new DistributionController(
        {} as unknown as import('./distribution.service').DistributionService,
        prismaMock as unknown as import('../../prisma/prisma.service').PrismaService,
        contentMock as unknown as import('../content-client/content-client.service').ContentClientService,
      );

      const report = (await controller.backfillDryRun('2', 'job-a')) as {
        mode: string;
        scan: { limit: number; scannedCount: number; totalPending: number; truncated: boolean };
      };

      expect(report.mode).toBe('dry-run');
      expect(report.scan).toEqual({ limit: 2, scannedCount: 2, totalPending: 2, truncated: false });
      // findMany nhận take=2 + jobId filter (anti-DoS + filter giống CLI --job-id).
      expect((prismaMock.preTicket.findMany as jest.Mock).mock.calls[0][0]).toMatchObject({
        take: 2,
        where: { status: 'PENDING', jobId: 'job-a' },
      });
      // Endpoint read-only: không updateMany/mint.
      expect(prismaMock.preTicket.updateMany).not.toHaveBeenCalled();
      expect(contentMock.mintForDistribution).not.toHaveBeenCalled();
    });

    it('limit không hợp lệ → BadRequestException (validate đầu vào endpoint)', async () => {
      const { prismaMock, contentMock } = setup({
        preTickets: [makePt('pt-1', TT1.id, 1)],
        ticketTypes: [TT1],
      });
      const controller = new DistributionController(
        {} as unknown as import('./distribution.service').DistributionService,
        prismaMock as unknown as import('../../prisma/prisma.service').PrismaService,
        contentMock as unknown as import('../content-client/content-client.service').ContentClientService,
      );
      await expect(controller.backfillDryRun('abc', undefined)).rejects.toThrow(HttpException);
      expect(prismaMock.preTicket.findMany).not.toHaveBeenCalled(); // fail fast, không quét DB
    });
  });

  // ─── 8. Helpers ───
  describe('helpers', () => {
    it('parseDbHost trích host:port từ DATABASE_URL', () => {
      expect(parseDbHost('postgresql://u:p@localhost:55432/ticket_mayo?schema=public')).toBe(
        'localhost:55432',
      );
      expect(parseDbHost('postgresql://u:p@db.prod.internal:5432/tm')).toBe(
        'db.prod.internal:5432',
      );
    });
  });
});
