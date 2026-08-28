/**
 * T7 — Backfill logic (importable — jest rootDir=src không scan scripts/).
 * CLI entry: scripts/backfill-mint.ts (thin wrapper — parse args, inject real
 * services, print JSON, exit code).
 *
 * lazy-mint runtime kept until GA (PRD Story G) — module này KHÔNG đụng
 * runtime path claim/ticket, chỉ xử lý PreTicket PENDING tồn từ đợt LAZY.
 *
 * Design (DESIGN §6 + PLAN T7):
 *  - Query PENDING ORDER BY createdAt ASC, nhóm theo ticketTypeId.
 *  - remaining = quantity - sold (content getTicketType — DB truth).
 *  - Mint đủ min(pending, remaining); phần thiếu quota → EXPIRED terminal
 *    + audit BACKFILL_QUOTA_EXCEEDED. KHÔNG silently drop (Q3).
 *  - Idempotent 2 tầng: local guard updateMany status + content-side
 *    preTicketId unique (alreadyMinted) — chạy 2 lần KHÔNG mint đôi.
 *  - T3-M6 verify: soldAfter(DB) == soldBefore + minted — lệch → exitCode 2.
 *    Chưa có Redis endpoint → verify là DB-side (M6); --verify-redis = no-op
 *    placeholder cho M7 (mirror Redis).
 *  - KHÔNG gửi email trong backfill (§6.3 — claim-link cũ vẫn hoạt động).
 *  - TM-3: KHÔNG log plaintext email — chỉ emailHash.
 */
import { BadRequestException, HttpException, Logger } from '@nestjs/common';
import { ContentClientService, MintRecipientResult } from '../content-client/content-client.service';
import { AuditService } from '../audit/audit.service';

const logger = new Logger('BackfillMint');

// ─── Anti-DoS cap cho GET /admin/backfill/dry-run (PLAN L313) ───
export const BACKFILL_DRY_RUN_DEFAULT_LIMIT = 1000;
export const BACKFILL_DRY_RUN_MAX_LIMIT = 5000;

/**
 * Parse query param `limit` của endpoint dry-run:
 * undefined/'' → default 1000; integer ≥ 1; > 5000 → kẹp về 5000;
 * garbage/nhỏ hơn 1 → 400 BadRequest.
 */
export function parseBackfillLimit(raw: string | undefined): number {
  if (raw === undefined || raw === '') return BACKFILL_DRY_RUN_DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new BadRequestException('limit phải là integer ≥ 1.');
  }
  return Math.min(n, BACKFILL_DRY_RUN_MAX_LIMIT);
}

// ─── CLI options ───
export interface BackfillCliOptions {
  confirm: boolean;
  yes: boolean;
  jobId?: string;
  verifyRedis: boolean;
  /** dry-run khi KHÔNG có --confirm (default). */
  dryRun: boolean;
}

export function parseArgs(argv: string[]): BackfillCliOptions {
  const hasFlag = (f: string) => argv.includes(f);
  const getOpt = (f: string) => {
    const i = argv.indexOf(f);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const known = ['--confirm', '--yes', '--verify-redis'];
  for (const a of argv) {
    if (a.startsWith('--') && !known.includes(a) && a !== '--job-id') {
      logger.warn(`Flag lạ "${a}" — bỏ qua.`);
    }
  }
  const confirm = hasFlag('--confirm');
  return {
    confirm,
    yes: hasFlag('--yes'),
    jobId: getOpt('--job-id'),
    verifyRedis: hasFlag('--verify-redis'),
    dryRun: !confirm,
  };
}

// ─── Deps (mock-friendly — spec dùng interface này) ───
export interface BackfillPrisma {
  preTicket: {
    /** PrismaService thỏa mãn structural typing — spec mock cùng shape. */
    findMany(
      args: {
        where: {
          status?: import('@prisma/client').PreTicketStatus;
          jobId?: string;
          id?: { in: string[] };
        };
        orderBy?: { createdAt: 'asc' | 'desc' };
        select?: Record<string, boolean>;
        take?: number;
      },
    ): Promise<BackfillPendingRow[]>;
    count(args: {
      where: {
        status?: import('@prisma/client').PreTicketStatus;
        jobId?: string;
      };
    }): Promise<number>;
    updateMany(args: {
      where: {
        status?: import('@prisma/client').PreTicketStatus;
        jobId?: string;
        id?: { in: string[] };
      };
      data: Record<string, unknown>;
    }): Promise<{ count: number }>;
    groupBy(args: {
      by: ['status'];
      where: { status?: { in: import('@prisma/client').PreTicketStatus[] }; jobId?: string };
      _count: { _all: true };
    }): Promise<{ status: string; _count: { _all: number } }[]>;
  };
  portalUser: {
    findMany(args: {
      where: { emailHash: { in: string[] } };
      select: { id: true; emailHash: true };
    }): Promise<{ id: string; emailHash: string }[]>;
  };
  /**
   * MAJOR-2: khi backfill technical-fail giữ PreTicket MINTING, job phải được
   * flag PARTIALLY_MINTED để retryMint (T5 — distribution.service.ts) là rescue
   * path; backfill re-run chỉ quét PENDING nên không tự nhặt các row đó.
   */
  distributionJob: {
    updateMany(args: {
      where: {
        id?: { in: string[] };
        status?: { notIn: import('@prisma/client').DistributionStatus[] };
      };
      data: Record<string, unknown>;
    }): Promise<{ count: number }>;
  };
}

export interface BackfillDeps {
  prisma: BackfillPrisma;
  content: Pick<ContentClientService, 'getTicketType' | 'mintForDistribution'>;
  audit: Pick<AuditService, 'record'>;
}

export interface BackfillPendingRow {
  id: string;
  jobId: string;
  eventId: string;
  ticketTypeId: string;
  ticketTypeName: string;
  eventName: string;
  recipientEmailHash: string;
  recipientUserId: string | null;
}

// ─── Reports (JSON ra stdout — Δ5 UI import được) ───
export interface TicketTypePlan {
  ticketTypeId: string;
  eventName: string;
  ticketTypeName: string;
  pendingCount: number;
  /** null = không đọc được từ content (getTicketType fail). */
  remaining: number | null;
  toMint: number;
  expectedExpired: number;
}

export interface DryRunReport {
  mode: 'dry-run';
  generatedAt: string;
  jobIdFilter: string | null;
  dbHost: string;
  pendingCountByType: { ticketTypeId: string; pendingCount: number }[];
  plans: TicketTypePlan[];
  totals: { pending: number; toMint: number; expectedExpired: number };
  /** MINTING/CLAIMING kẹt — KHÔNG phải PENDING, không backfill (chỉ cảnh báo). */
  stuckCounts: { status: string; count: number }[];
  /**
   * Anti-DoS cap (PLAN L313): endpoint scan tối đa `scanLimit` PENDING rows.
   * truncated=true → totals/plans chỉ tính phần scanned; CLI scan không cap
   * (limit=Infinity) nên luôn truncated=false.
   */
  scan: {
    limit: number;
    scannedCount: number;
    totalPending: number;
    truncated: boolean;
  };
  warnings: string[];
}

export interface RealRunReport {
  mode: 'real';
  generatedAt: string;
  jobIdFilter: string | null;
  dbHost: string;
  totals: {
    pendingAtStart: number;
    minted: number;
    mintedWithUser: number;
    mintedEmailOnly: number;
    expired: number;
    skippedTechnical: number;
    alreadyMinted: number;
  };
  perType: {
    ticketTypeId: string;
    pending: number;
    minted: number;
    expired: number;
    verify: { expectedSold: number; actualSold: number | null; ok: boolean };
  }[];
  /** các jobId có PreTicket bị EXPIRED — admin dùng để liên hệ tay (Q3). */
  expiredJobIds: string[];
  verification: {
    mode: 'db-side (M6)';
    allOk: boolean;
    mismatches: { ticketTypeId: string; expectedSold: number; actualSold: number | null }[];
  };
  warnings: string[];
}

export interface BackfillRunResult {
  /** true = guard từ chối (không gõ BACKFILL) — KHÔNG đụng gì, exit 0. */
  aborted?: boolean;
  report?: DryRunReport | RealRunReport;
  exitCode: number;
}

// ─── Helpers ───
/** Parse host (host:port) từ DATABASE_URL — admin thấy đúng DB trước guard. */
export function parseDbHost(url: string): string {
  const m = url.match(/@([^/?]+)\//);
  return m ? m[1] : 'unknown';
}

function isQuotaError(err: unknown): {
  code?: string;
  remaining?: number;
  requested?: number;
  message?: string;
} {
  if (!(err instanceof HttpException)) return {};
  const body = err.getResponse() as {
    code?: string;
    remaining?: number;
    requested?: number;
    message?: string;
  };
  if (
    err.getStatus() === 409 &&
    (body?.code === 'TICKET_SOLD_OUT' || body?.code === 'TICKET_QUOTA_EXCEEDED')
  ) {
    return body;
  }
  return {};
}

/** Nhóm PENDING theo ticketTypeId, createdAt ASC trong nhóm (index [ticketTypeId, status, createdAt]). */
async function loadPendingGroups(
  prisma: BackfillPrisma,
  jobIdFilter?: string,
  take?: number,
): Promise<{ pending: BackfillPendingRow[]; groups: Map<string, BackfillPendingRow[]> }> {
  const pending = await prisma.preTicket.findMany({
    ...(take !== undefined ? { take } : {}),
    where: { status: 'PENDING', ...(jobIdFilter ? { jobId: jobIdFilter } : {}) },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      jobId: true,
      eventId: true,
      ticketTypeId: true,
      ticketTypeName: true,
      eventName: true,
      recipientEmailHash: true,
      recipientUserId: true,
    },
  });
  const groups = new Map<string, BackfillPendingRow[]>();
  for (const pt of pending) {
    const arr = groups.get(pt.ticketTypeId) ?? [];
    arr.push(pt);
    groups.set(pt.ticketTypeId, arr);
  }
  return { pending, groups };
}

interface ProcessedGroupResult {
  minted: number;
  mintedWithUser: number;
  mintedEmailOnly: number;
  expired: number;
  skippedTechnical: number;
  alreadyMinted: number;
  expiredJobIds: string[];
  /** đã xử lý quota qua 409 runtime — tránh đánh EXPIRED 2 lần. */
  quotaHandled: boolean;
}

export interface BackfillRunOptions {
  jobIdFilter?: string;
  verifyRedis?: boolean;
  /**
   * Anti-DoS cap cho dry-run (PLAN L313): số PENDING row tối đa quét qua
   * findMany take. Endpoint admin truyền từ query param `limit` (default 1000,
   * hard cap 5000 — parseBackfillLimit). CLI KHÔNG truyền → scan toàn bộ
   * (không cap — exact như trước đây).
   */
  dryRunScanLimit?: number;
  /**
   * Real-run guard: CLI truyền hàm đọc stdin (yêu cầu gõ đúng "BACKFILL");
   * trả false → abort exit 0 không đụng gì. Test truyền mock.
   */
  confirm?: () => Promise<boolean>;
  /** DB host in trong report (từ DATABASE_URL — parse ở CLI). */
  dbHost: string;
  /** log người đọc → stderr; stdout dành riêng JSON (Δ5). */
  log?: (...a: unknown[]) => void;
}

/** Đọc remaining của 1 ticket type từ content (DB truth). null = không đọc được. */
async function readSoldRemaining(
  content: BackfillDeps['content'],
  ticketTypeId: string,
): Promise<{ sold: number | null; remaining: number | null }> {
  try {
    const tt = await content.getTicketType(ticketTypeId);
    if (typeof tt?.sold === 'number' && typeof tt?.quantity === 'number') {
      return { sold: tt.sold, remaining: tt.quantity - tt.sold };
    }
    return { sold: null, remaining: null };
  } catch {
    return { sold: null, remaining: null };
  }
}

// ─── Entry (dry-run HOẶC real-run — cùng 1 code path) ───
export async function runBackfill(
  deps: BackfillDeps,
  opts: BackfillRunOptions & { dryRun: boolean },
): Promise<BackfillRunResult> {
  const log = opts.log ?? (() => undefined);
  const warnings: string[] = [];

  if (opts.verifyRedis) {
    const w =
      '--verify-redis: chưa có Redis endpoint (M7) — hiện chỉ verify DB-side (M6). Flag là no-op placeholder.';
    warnings.push(w);
    log(`[WARN] ${w}`);
  }

  if (opts.dryRun) {
    return { report: await dryRun(deps, opts, warnings, log), exitCode: 0 };
  }
  return realRun(deps, opts, warnings, log);
}

// ─── B1: DRY-RUN — KHÔNG mint, KHÔNG ghi DB ───
async function dryRun(
  deps: BackfillDeps,
  opts: BackfillRunOptions,
  warnings: string[],
  log: (...a: unknown[]) => void,
): Promise<DryRunReport> {
  log('=== BACKFILL DRY-RUN (không mint, không ghi DB) ===');
  const scanLimit = opts.dryRunScanLimit ?? Infinity;
  // Infinity KHÔNG hợp lệ làm `take` của Prisma → chỉ truyền take khi finite.
  const { pending, groups } = await loadPendingGroups(
    deps.prisma,
    opts.jobIdFilter,
    Number.isFinite(scanLimit) ? scanLimit : undefined,
  );
  if (pending.length === 0) {
    log('Không có PreTicket PENDING — không cần backfill.');
  }

  // Tổng PENDING thật (prisma count — không tốn kết quả row) để báo truncated.
  let totalPending = pending.length;
  if (scanLimit !== Infinity) {
    totalPending = await deps.prisma.preTicket.count({
      where: { status: 'PENDING', ...(opts.jobIdFilter ? { jobId: opts.jobIdFilter } : {}) },
    });
  }
  const truncated = totalPending > pending.length;
  if (truncated) {
    const w =
      `Kết quả BỊ CẮT vì cap quét: scanned ${pending.length}/${totalPending} PENDING ` +
      `(limit=${scanLimit}) — dùng query ?limit= cao hơn (max 5000) hoặc lọc jobId.`;
    warnings.push(w);
    log(`[WARN] ${w}`);
  }

  const plans: TicketTypePlan[] = [];
  for (const [ticketTypeId, rows] of groups) {
    const { remaining } = await readSoldRemaining(deps.content, ticketTypeId);
    if (remaining === null) {
      log(`[WARN] getTicketType(${ticketTypeId}) fail — remaining unknown.`);
      warnings.push(`getTicketType(${ticketTypeId}) fail — remaining unknown.`);
    }
    const pendingCount = rows.length;
    const toMint = remaining === null ? pendingCount : Math.min(pendingCount, remaining);
    plans.push({
      ticketTypeId,
      eventName: rows[0].eventName,
      ticketTypeName: rows[0].ticketTypeName,
      pendingCount,
      remaining,
      toMint,
      expectedExpired: pendingCount - toMint,
    });
  }

  // CLAIMING/MINTING kẹt KHÔNG phải PENDING — cảnh báo riêng, không backfill.
  const stuck = await deps.prisma.preTicket.groupBy({
    by: ['status'],
    where: {
      status: { in: ['MINTING', 'CLAIMING'] },
      ...(opts.jobIdFilter ? { jobId: opts.jobIdFilter } : {}),
    },
    _count: { _all: true },
  });
  const stuckCounts = stuck.map((s) => ({ status: s.status, count: s._count._all }));
  for (const s of stuckCounts) {
    warnings.push(
      `${s.count} PreTicket đang kẹt ở trạng thái ${s.status} (không tính là PENDING, không backfill).`,
    );
    log(`[WARN] ${s.count} PreTicket stuck ở ${s.status} — không xử lý trong backfill này.`);
  }

  return {
    mode: 'dry-run',
    generatedAt: new Date().toISOString(),
    jobIdFilter: opts.jobIdFilter ?? null,
    dbHost: opts.dbHost,
    pendingCountByType: plans.map((p) => ({
      ticketTypeId: p.ticketTypeId,
      pendingCount: p.pendingCount,
    })),
    plans,
    totals: {
      pending: pending.length,
      toMint: plans.reduce((a, p) => a + p.toMint, 0),
      expectedExpired: plans.reduce((a, p) => a + p.expectedExpired, 0),
    },
    stuckCounts,
    scan: {
      limit: scanLimit,
      scannedCount: pending.length,
      totalPending,
      truncated,
    },
    warnings,
  };
}

// ─── B2-B4: REAL RUN ───
async function realRun(
  deps: BackfillDeps,
  opts: BackfillRunOptions,
  warnings: string[],
  log: (...a: unknown[]) => void,
): Promise<BackfillRunResult> {
  const { pending: pendingAll } = await loadPendingGroups(deps.prisma, opts.jobIdFilter);
  if (pendingAll.length === 0) {
    log('Không có PreTicket PENDING — không cần backfill.');
    const empty: RealRunReport = {
      mode: 'real',
      generatedAt: new Date().toISOString(),
      jobIdFilter: opts.jobIdFilter ?? null,
      dbHost: opts.dbHost,
      totals: {
        pendingAtStart: 0,
        minted: 0,
        mintedWithUser: 0,
        mintedEmailOnly: 0,
        expired: 0,
        skippedTechnical: 0,
        alreadyMinted: 0,
      },
      perType: [],
      expiredJobIds: [],
      verification: { mode: 'db-side (M6)', allOk: true, mismatches: [] },
      warnings,
    };
    return { report: empty, exitCode: 0 };
  }

  // Guard: in DB host + PENDING count, yêu cầu confirm (gõ BACKFILL / --yes).
  log('\n================ SẴN SÀNG CHẠY THẬT ================');
  log(`DB host         : ${opts.dbHost}`);
  log(`PENDING count   : ${pendingAll.length}`);
  if (opts.jobIdFilter) log(`Job filter      : ${opts.jobIdFilter}`);

  // MINOR-4: không parse được DB host → DATABASE_URL lạ/đỏ — REFUSE chạy thật
  // (mint thật vào DB không xác định còn nguy hiểm hơn bỏ run). Dry-run KHÔNG
  // bị chặn (read-only).
  if (!opts.dbHost || opts.dbHost === 'unknown') {
    log(
      '\n[REFUSE] Không parse được DB host từ DATABASE_URL — từ chối chạy thật. ' +
        'Kiểm tra DATABASE_URL (dạng postgresql://user:pass@host:port/db) rồi chạy lại.',
    );
    return { aborted: true, exitCode: 0 };
  }

  log('\nGõ đúng chữ "BACKFILL" rồi Enter để chạy thật. Ctrl-C để hủy.');
  if (opts.confirm) {
    const ok = await opts.confirm();
    if (!ok) {
      log('Từ chối confirm — hủy. Không đụng gì (exit 0).');
      return { aborted: true, exitCode: 0 };
    }
  }

  // Re-load sau guard — data có thể đổi trong lúc admin đọc prompt.
  const { groups } = await loadPendingGroups(deps.prisma, opts.jobIdFilter);
  const totals = {
    pendingAtStart: 0,
    minted: 0,
    mintedWithUser: 0,
    mintedEmailOnly: 0,
    expired: 0,
    skippedTechnical: 0,
    alreadyMinted: 0,
  };
  const perType: RealRunReport['perType'] = [];
  const expiredJobIdsAll: string[] = [];
  const mismatches: RealRunReport['verification']['mismatches'] = [];
  let firstJobId = '';

  for (const [ticketTypeId, rows] of groups) {
    totals.pendingAtStart += rows.length;
    if (!firstJobId) firstJobId = rows[0].jobId;
    const eventId = rows[0].eventId;

    // remaining từ content (DB truth). Không đọc được → mint full batch,
    // bắt 409 tại runtime như mintEager.
    const { sold, remaining } = await readSoldRemaining(deps.content, ticketTypeId);
    const soldBefore = sold;
    if (soldBefore === null) {
      log(`[WARN] getTicketType(${ticketTypeId}) fail — mint full batch, bắt 409 runtime.`);
      warnings.push(`getTicketType(${ticketTypeId}) fail pre-run — dựa vào 409 runtime.`);
    }

    // Cắt batch theo remaining nếu biết — phần vượt KHÔNG drop: EXPIRED + audit (B3).
    let mintRows = rows;
    let overQuotaRows: BackfillPendingRow[] = [];
    if (remaining !== null && rows.length > remaining) {
      mintRows = rows.slice(0, remaining);
      overQuotaRows = rows.slice(remaining);
    }

    // B2.1: lock PENDING → MINTING (atomic guard — idempotent).
    const locked = await deps.prisma.preTicket.updateMany({
      where: { id: { in: mintRows.map((r) => r.id) }, status: 'PENDING' },
      data: { status: 'MINTING' },
    });
    if (locked.count !== mintRows.length) {
      log(`[WARN] ${ticketTypeId}: lock ${locked.count}/${mintRows.length} — một số row đổi trạng thái giữa chừng.`);
    }

    // B2.2: resolve PortalUser by emailHash (pattern distribution.service.ts:78-83)
    // — user có thể đã đăng ký SAU đợt phát gốc.
    const minting = await deps.prisma.preTicket.findMany({
      where: { id: { in: mintRows.map((r) => r.id) }, status: 'MINTING' },
      select: { id: true, recipientEmailHash: true, recipientUserId: true },
    });
    const hashes = [...new Set(minting.map((r) => r.recipientEmailHash))];
    const users =
      hashes.length > 0
        ? await deps.prisma.portalUser.findMany({
            where: { emailHash: { in: hashes } },
            select: { id: true, emailHash: true },
          })
        : [];
    const userIdByHash = new Map(users.map((u) => [u.emailHash, u.id]));

    const recipients = minting.map((pt) => ({
      preTicketId: pt.id,
      emailHash: pt.recipientEmailHash,
      userId: userIdByHash.get(pt.recipientEmailHash) ?? pt.recipientUserId ?? null,
    }));

    const result: ProcessedGroupResult = {
      minted: 0,
      mintedWithUser: 0,
      mintedEmailOnly: 0,
      expired: 0,
      skippedTechnical: 0,
      alreadyMinted: 0,
      expiredJobIds: [],
      quotaHandled: false,
    };
    const idempotencyKey = `backfill-${ticketTypeId}-${new Date().toISOString()}`;

    try {
      const res = await deps.content.mintForDistribution({
        eventId,
        ticketTypeId,
        recipients,
        idempotencyKey,
      });

      // Δ9a reconciliation in-RAM (pattern distribution.service.ts:276-311).
      const resultByPreTicket = new Map(res.results.map((r) => [r.preTicketId, r]));
      const mintedIds: string[] = [];
      const missing: string[] = [];
      for (const pt of minting) {
        const r = resultByPreTicket.get(pt.id);
        if (r?.ticketId) mintedIds.push(pt.id);
        else missing.push(pt.id);
      }
      const sentIds = new Set(minting.map((pt) => pt.id));
      const extras = res.results
        .map((r) => r.preTicketId)
        .filter((id) => !sentIds.has(id) && !!id);
      if (extras.length > 0) {
        log(`[CRITICAL] Δ9a extras ${ticketTypeId}: ${extras.length} preTicketId ngoài batch: ${extras.join(', ')}`);
        warnings.push(`Δ9a extras ${ticketTypeId}: ${extras.length} preTicketId lạ — đối chiếu tay.`);
      }
      if (missing.length > 0) {
        log(`[CRITICAL] Δ9a missing ${ticketTypeId}: ${missing.length} preTicket không có ticketId: ${missing.join(', ')}`);
        await deps.prisma.preTicket.updateMany({
          where: { id: { in: missing }, status: 'MINTING' },
          data: { lastMintError: 'Mint result missing from content response (Δ9a)' },
        });
        result.skippedTechnical += missing.length;
        warnings.push(`Δ9a missing ${ticketTypeId}: ${missing.length} preTicket — đối chiếu tay.`);
      }

      // MINTED per-recipient — guard status='MINTING' (idempotent).
      const mintedAt = new Date();
      for (const ptId of mintedIds) {
        const r = resultByPreTicket.get(ptId)!;
        await deps.prisma.preTicket.updateMany({
          where: { id: { in: [ptId] }, status: 'MINTING' },
          data: {
            status: 'MINTED',
            contentTicketId: r.ticketId,
            contentTicketCode: r.ticketCode,
            mintedAt,
          },
        });
        if (r.alreadyMinted) result.alreadyMinted++;
        else {
          result.minted++;
          const rec = recipients.find((x) => x.preTicketId === ptId);
          if (rec?.userId) result.mintedWithUser++;
          else result.mintedEmailOnly++;
        }
      }
    } catch (err) {
      // MAJOR-1: áp partialMintResults TRƯỚC khi đánh EXPIRED/giữ MINTING
      // (pattern distribution.service.ts:336-378) — vé đã mint thật
      // KHÔNG BAO GIỜ bị EXPIRED.
      const partialResults = (err as HttpException & { partialMintResults?: MintRecipientResult[] })
        .partialMintResults;
      if (Array.isArray(partialResults) && partialResults.length > 0) {
        const partialByPreTicket = new Map(partialResults.map((r) => [r.preTicketId, r]));
        const partialMintedIds: string[] = [];
        for (const pt of minting) {
          const r = partialByPreTicket.get(pt.id);
          if (r?.ticketId) partialMintedIds.push(pt.id);
        }
        const mintedAt = new Date();
        for (const ptId of partialMintedIds) {
          const r = partialByPreTicket.get(ptId)!;
          await deps.prisma.preTicket.updateMany({
            where: { id: { in: [ptId] }, status: 'MINTING' },
            data: {
              status: 'MINTED',
              contentTicketId: r.ticketId,
              contentTicketCode: r.ticketCode,
              mintedAt,
            },
          });
          if (r.alreadyMinted) result.alreadyMinted++;
          else {
            result.minted++;
            const rec = recipients.find((x) => x.preTicketId === ptId);
            if (rec?.userId) result.mintedWithUser++;
            else result.mintedEmailOnly++;
          }
        }
        log(`${ticketTypeId}: áp dụng ${partialMintedIds.length} vé mint thật từ chunk thành công trước khi xử lý lỗi (MAJOR-1).`);
      }

      const quota = isQuotaError(err);
      if (quota.code) {
        // 409 quota runtime → phần MINTING còn lại của loại → EXPIRED terminal.
        result.quotaHandled = true;
        const stillMinting = await deps.prisma.preTicket.findMany({
          where: { id: { in: mintRows.map((r) => r.id) }, status: 'MINTING' },
          select: { id: true, jobId: true },
        });
        if (stillMinting.length > 0) {
          await deps.prisma.preTicket.updateMany({
            where: { id: { in: stillMinting.map((r) => r.id) }, status: 'MINTING' },
            data: { status: 'EXPIRED', lastMintError: quota.message ?? 'Quota exceeded' },
          });
          result.expired += stillMinting.length;
          for (const r of stillMinting)
            if (!result.expiredJobIds.includes(r.jobId)) result.expiredJobIds.push(r.jobId);
          log(`${ticketTypeId}: 409 ${quota.code} — ${stillMinting.length} PreTicket → EXPIRED terminal (remaining=${quota.remaining}, requested=${quota.requested}).`);
        }
      } else {
        // Lỗi khác (5xx/transport/timeout) → giữ MINTING + lastMintError
        // (idempotent retry), KHÔNG rollback PENDING, KHÔNG EXPIRED (§6.2).
        const message = err instanceof Error ? err.message : String(err);
        log(`${ticketTypeId}: technical fail — giữ MINTING để retry: ${message}`);
        await deps.prisma.preTicket.updateMany({
          where: { id: { in: mintRows.map((r) => r.id) }, status: 'MINTING' },
          data: { lastMintError: message },
        });
        result.skippedTechnical += minting.length - result.minted - result.alreadyMinted;

        // MAJOR-2: các row giữ MINTING sẽ KHÔNG bao giờ được backfill re-run
        // nhặt (re-run chỉ quét PENDING). Flag job PARTIALLY_MINTED (idempotent
        // — chỉ set khi chưa FAILED/PARTIALLY_MINTED) để retryMint (T5,
        // distribution.service.ts — chỉ chạy với PARTIALLY_MINTED/FAILED) là
        // rescue path vận hành. Giữ MINTING đúng pattern mintEager.
        const stuckJobIds = [...new Set(minting.map((r) => (mintRows.find((m) => m.id === r.id)?.jobId ?? '')))].filter(Boolean);
        if (stuckJobIds.length > 0) {
          const flagged = await deps.prisma.distributionJob.updateMany({
            where: { id: { in: stuckJobIds }, status: { notIn: ['FAILED', 'PARTIALLY_MINTED'] } },
            data: { status: 'PARTIALLY_MINTED' },
          });
          if (flagged.count > 0) {
            log(`[RESCUE] ${flagged.count} job → PARTIALLY_MINTED — retryMint(jobId) là lối thoát (T5).`);
          }
        }
        warnings.push(`${ticketTypeId}: technical fail — PreTicket giữ MINTING để retry (job đã flag PARTIALLY_MINTED — retryMint cứu được).`);
      }
    }

    // B3: over-quota rows khi biết remaining TRƯỚC. MINOR-2: chạy CẢ khi
    // 409 runtime đã xảy ra (quotaHandled) — các row này còn PENDING và cũng
    // vượt quota; updateMany where status='PENDING' idempotent, không đụng
    // rows vừa bị 409-EXPIRED (đang MINTING→EXPIRED).
    let precheckExpiredCount = 0;
    if (overQuotaRows.length > 0) {
      precheckExpiredCount = overQuotaRows.length;
      await deps.prisma.preTicket.updateMany({
        where: { id: { in: overQuotaRows.map((r) => r.id) }, status: 'PENDING' },
        data: {
          status: 'EXPIRED',
          lastMintError: `Quota exceeded — remaining=${remaining} at ${new Date().toISOString()}`,
        },
      });
      result.expired += overQuotaRows.length;
      for (const r of overQuotaRows)
        if (!result.expiredJobIds.includes(r.jobId)) result.expiredJobIds.push(r.jobId);
    }

    // Audit BACKFILL_QUOTA_EXCEEDED per-group (best-effort) — jobId của
    // PreTicket đầu nhóm expired; detail: ticketTypeId, expired count, reason.
    // MINOR-2: expired có thể gồm cả 409-runtime lẫn precheck — reason là cơ
    // chế chủ đạo, precheckExpiredCount tách bạch phần precheck.
    if (result.expired > 0) {
      const groupJobId = result.expiredJobIds[0] ?? rows[0].jobId;
      await deps.audit.record({
        jobId: groupJobId,
        action: 'BACKFILL_QUOTA_EXCEEDED',
        detail: {
          ticketTypeId,
          expiredCount: result.expired,
          reason: result.quotaHandled ? '409_RUNTIME' : 'PRECHECK_REMAINING',
          precheckExpiredCount,
          remaining: remaining ?? null,
          requested: rows.length,
          jobIds: [...result.expiredJobIds],
        },
      });
    }

    // T3-M6 verify (DB-side): soldAfter == soldBefore + minted MỚI
    // (alreadyMinted không làm sold tăng). Không đọc được → skip, không fail
    // (MAJOR-1: mint ĐÃ thành công — verify fail là lỗi đọc, KHÔNG phải lệch
    // dữ liệu; ok=true + warning, KHÔNG push mismatch → không exit 2).
    let verify = { expectedSold: -1, actualSold: null as number | null, ok: true };
    if (soldBefore !== null) {
      const expectedSold = soldBefore + result.minted;
      let actualSold: number | null = null;
      let verifyReadFailed = false;
      try {
        const tt = await deps.content.getTicketType(ticketTypeId);
        actualSold = typeof tt?.sold === 'number' ? tt.sold : null;
      } catch (err) {
        verifyReadFailed = true;
        log(`[WARN] verify getTicketType(${ticketTypeId}) fail: ${(err as Error).message}`);
      }
      if (actualSold === null) verifyReadFailed = true;
      if (verifyReadFailed) {
        const w = `verify skipped ${ticketTypeId}: không đọc được sold từ content (getTicketType fail) — mint ĐÃ áp DB, verify thủ công khi service ổn định.`;
        warnings.push(w);
        log(`[WARN] ${w}`);
        verify = { expectedSold, actualSold: null, ok: true };
      } else {
        verify = { expectedSold, actualSold, ok: actualSold === expectedSold };
        if (!verify.ok) {
          mismatches.push({ ticketTypeId, expectedSold, actualSold });
          log(`[VERIFY-FAIL] ${ticketTypeId}: expected sold=${expectedSold}, actual sold=${actualSold}`);
        }
      }
    }

    perType.push({
      ticketTypeId,
      pending: rows.length,
      minted: result.minted,
      expired: result.expired,
      verify,
    });
    totals.minted += result.minted;
    totals.mintedWithUser += result.mintedWithUser;
    totals.mintedEmailOnly += result.mintedEmailOnly;
    totals.expired += result.expired;
    totals.skippedTechnical += result.skippedTechnical;
    totals.alreadyMinted += result.alreadyMinted;
    expiredJobIdsAll.push(...result.expiredJobIds);
  }

  // B4: audit BACKFILL_SUMMARY (best-effort).
  await deps.audit.record({
    jobId: firstJobId || 'backfill',
    action: 'BACKFILL_SUMMARY',
    detail: {
      mode: 'real',
      jobIdFilter: opts.jobIdFilter ?? null,
      minted: totals.minted,
      mintedWithUser: totals.mintedWithUser,
      mintedEmailOnly: totals.mintedEmailOnly,
      expired: totals.expired,
      skippedTechnical: totals.skippedTechnical,
      alreadyMinted: totals.alreadyMinted,
      dbHost: opts.dbHost,
    },
  });

  const report: RealRunReport = {
    mode: 'real',
    generatedAt: new Date().toISOString(),
    jobIdFilter: opts.jobIdFilter ?? null,
    dbHost: opts.dbHost,
    totals,
    perType,
    expiredJobIds: [...new Set(expiredJobIdsAll)],
    verification: { mode: 'db-side (M6)', allOk: mismatches.length === 0, mismatches },
    warnings,
  };
  log(
    `\n=== TỔNG KẾT: minted=${totals.minted} (user=${totals.mintedWithUser}, emailOnly=${totals.mintedEmailOnly}) ` +
      `expired=${totals.expired} skippedTechnical=${totals.skippedTechnical} alreadyMinted=${totals.alreadyMinted} ===`,
  );
  if (mismatches.length > 0) {
    log(`[VERIFY-FAIL] ${mismatches.length} ticketType lệch sold — xem report JSON (exit 2).`);
    return { report, exitCode: 2 };
  }
  return { report, exitCode: 0 };
}
