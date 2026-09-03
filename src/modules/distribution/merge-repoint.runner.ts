/**
 * MERGE-REPOINT (ticket-mayo) — cập nhật bản ghi CHIẾU ticketTypeId sau khi
 * content-service gộp loại vé (content-service/scripts/merge-ticket-types.ts).
 *
 * Bối cảnh: sau PIVOT, ticket-mayo giữ DistributionJob/PreTicket với
 * ticketTypeId là CHUỖI snapshot (không FK). Sau khi content merge:
 *  - resolvePreTicket (claim) gọi content.issueTickets(preTicket.ticketTypeId)
 *    → loser id đã XÓA → 404 TICKET_TYPE_NOT_FOUND, claim nghẹt.
 *  - retryMint (distribution.service.ts:711) dùng job.ticketTypeId
 *    → PARTIALLY_MINTED job trỏ loser sẽ fail.
 *  - backfill PENDING nhóm theo preTicket.ticketTypeId → getTicketType 404.
 * → MỌI row trạng thái SỐNG (PENDING/MINTING/CLAIMING + job
 *   PENDING/RUNNING/PARTIALLY_MINTED) phải trỏ về survivor.
 *
 * Thứ tự vận hành ĐÚNG: chạy script NÀY TRƯỚC khi merge content — survivor
 * hiện đang tồn tại nên claim/backfill vẫn chạy suốt khoảng giữa 2 bước;
 * crash giữa chừng không để lại trạng thái vỡ.
 *
 * Row lịch sử (MINTED/LINKED/CLAIMED/EXPIRED, job COMPLETED/FAILED): snapshot
 * hiển thị — mặc định GIỮ NGUYÊN (bảo toàn analytics theo type cũ).
 * --include-terminal để gộp luôn phần hiển thị (irreversible về mặt báo cáo).
 *
 * Idempotency: updateMany WHERE ticketTypeId IN losers → chạy lần 2 = 0 rows.
 * Rollback: manifest ghi trong DistributionAudit(action='MERGE_REPOINT').
 */
import { PrismaClient, PreTicketStatus, DistributionStatus } from '@prisma/client';

export const LIVE_PRETICKET_STATUSES: PreTicketStatus[] = ['PENDING', 'MINTING', 'CLAIMING'];
export const LIVE_JOB_STATUSES: DistributionStatus[] = ['PENDING', 'RUNNING', 'PARTIALLY_MINTED'];
export const TERMINAL_PRETICKET_STATUSES: PreTicketStatus[] = ['MINTED', 'LINKED', 'CLAIMED', 'EXPIRED'];
export const TERMINAL_JOB_STATUSES: DistributionStatus[] = ['COMPLETED', 'FAILED'];

export interface RepointInput {
  survivorId: string;
  loserIds: string[];
  /** Cập nhật snapshot tên trên các row sống (email chưa gửi hiển thị tên mới). */
  survivorName?: string;
  includeTerminal: boolean;
  dryRun: boolean;
}

export interface RepointPlan {
  ok: boolean;
  alreadyRepointed: boolean;
  blockers: string[];
  warnings: string[];
  counts: {
    live: { byStatus: Record<string, number>; total: number };
    terminal: { total: number };
    liveJobs: { id: string; status: string; ticketTypeName: string }[];
    terminalJobs: number;
  };
}

export async function planRepoint(prisma: PrismaClient, input: RepointInput): Promise<RepointPlan> {
  if (!input.survivorId || input.loserIds.length === 0) {
    throw new Error('Thiếu --survivor / --merge <ids>.');
  }
  const inIds = { ticketTypeId: { in: input.loserIds } };
  const [preLiveGroups, preTerminal, jobs, terminalJobs] = await Promise.all([
    prisma.preTicket.groupBy({ by: ['status', 'ticketTypeId'], where: { ...inIds, status: { in: LIVE_PRETICKET_STATUSES } }, _count: { _all: true } }),
    prisma.preTicket.count({ where: { ...inIds, status: { in: TERMINAL_PRETICKET_STATUSES } } }),
    prisma.distributionJob.findMany({
      where: { ...inIds, status: { in: input.includeTerminal ? [...LIVE_JOB_STATUSES, ...TERMINAL_JOB_STATUSES] : LIVE_JOB_STATUSES } },
      select: { id: true, status: true, ticketTypeName: true, ticketTypeId: true },
    }),
    prisma.distributionJob.count({ where: { ...inIds, status: { in: TERMINAL_JOB_STATUSES } } }),
  ]);
  const byStatus: Record<string, number> = {};
  let total = 0;
  for (const g of preLiveGroups) {
    byStatus[g.status] = (byStatus[g.status] ?? 0) + g._count._all;
    total += g._count._all;
  }
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (byStatus['MINTING']) {
    warnings.push(`${byStatus['MINTING']} PreTicket ở MINTING (đang/lỡ mint) — re-point vẫn an toàn vì finalization không gọi content bằng ticketTypeId.`);
  }
  if (total === 0 && preTerminal === 0 && jobs.length === 0) {
    return {
      ok: true,
      alreadyRepointed: true,
      blockers,
      warnings: ['Không còn row nào trỏ loser — có thể ĐÃ repoint (hoặc chưa từng phát vé cho các type này).'],
      counts: { live: { byStatus, total }, terminal: { total: preTerminal }, liveJobs: jobs, terminalJobs },
    };
  }
  if (preTerminal > 0 && !input.includeTerminal) {
    warnings.push(`${preTerminal} PreTicket LỊCH SỬ (MINTED/LINKED/CLAIMED/EXPIRED) giữ nguyên type cũ — analytics theo type cũ không đổi. Dùng --include-terminal nếu muốn gộp cả hiển thị.`);
  }
  if (total > 0 || jobs.length > 0) {
    if (!input.dryRun && !input.survivorName) {
      // Không phải blocker cứng (tên giữ nguyên được) — nhưng nhắc: email chờ gửi
      // sẽ hiển thị TÊN CŨ của loser nếu không đổi.
      warnings.push('Không có --survivor-name → ticketTypeName trên các row sống GIỮ NGUYÊN tên loại vé cũ (email chờ gửi hiển thị tên cũ). Khuyến nghị đặt tên khớp survivor.');
    }
  }
  return { ok: blockers.length === 0, alreadyRepointed: false, blockers, warnings, counts: { live: { byStatus, total }, terminal: { total: preTerminal }, liveJobs: jobs, terminalJobs } };
}

interface RepointManifest {
  version: 1;
  survivorId: string;
  loserIds: string[];
  survivorName: string | null;
  includeTerminal: boolean;
  pretickets: { id: string; oldTicketTypeId: string; oldTicketTypeName: string }[];
  jobs: { id: string; oldTicketTypeId: string; oldTicketTypeName: string }[];
}

export async function applyRepoint(
  prisma: PrismaClient,
  input: RepointInput,
  log: (m: string) => void,
): Promise<{ auditId: string; movedPreTickets: number; movedJobs: number }> {
  const preWhere = {
    ticketTypeId: { in: input.loserIds },
    status: input.includeTerminal
      ? { in: [...LIVE_PRETICKET_STATUSES, ...TERMINAL_PRETICKET_STATUSES] }
      : { in: LIVE_PRETICKET_STATUSES },
  };
  const jobStatuses = input.includeTerminal ? [...LIVE_JOB_STATUSES, ...TERMINAL_JOB_STATUSES] : LIVE_JOB_STATUSES;

  return prisma.$transaction(
    async (tx) => {
      const preRows = await tx.preTicket.findMany({
        where: preWhere,
        select: { id: true, ticketTypeId: true, ticketTypeName: true },
      });
      const jobRows = await tx.distributionJob.findMany({
        where: { ticketTypeId: { in: input.loserIds }, status: { in: jobStatuses } },
        select: { id: true, ticketTypeId: true, ticketTypeName: true },
      });
      if (preRows.length) {
        await tx.preTicket.updateMany({
          where: { id: { in: preRows.map((r) => r.id) } },
          data: { ticketTypeId: input.survivorId, ...(input.survivorName ? { ticketTypeName: input.survivorName } : {}) },
        });
      }
      if (jobRows.length) {
        await tx.distributionJob.updateMany({
          where: { id: { in: jobRows.map((r) => r.id) } },
          data: { ticketTypeId: input.survivorId, ...(input.survivorName ? { ticketTypeName: input.survivorName } : {}) },
        });
      }
      const manifest: RepointManifest = {
        version: 1,
        survivorId: input.survivorId,
        loserIds: input.loserIds,
        survivorName: input.survivorName ?? null,
        includeTerminal: input.includeTerminal,
        pretickets: preRows.map((r) => ({ id: r.id, oldTicketTypeId: r.ticketTypeId, oldTicketTypeName: r.ticketTypeName })),
        jobs: jobRows.map((r) => ({ id: r.id, oldTicketTypeId: r.ticketTypeId, oldTicketTypeName: r.ticketTypeName })),
      };
      const audit = await tx.distributionAudit.create({
        data: { jobId: 'merge-repoint', action: 'MERGE_REPOINT', detail: manifest as object },
        select: { id: true },
      });
      log(`[APPLY] repointed ${preRows.length} preTickets + ${jobRows.length} jobs. Audit=${audit.id}`);
      return { auditId: audit.id, movedPreTickets: preRows.length, movedJobs: jobRows.length };
    },
    { timeout: 60_000 },
  );
}

export async function rollbackRepoint(
  prisma: PrismaClient,
  auditId: string,
): Promise<{ movedPreTickets: number; movedJobs: number }> {
  const audit = await prisma.distributionAudit.findUnique({ where: { id: auditId } });
  if (!audit || audit.action !== 'MERGE_REPOINT') {
    throw new Error(`DistributionAudit ${auditId} không phải bản ghi MERGE_REPOINT hợp lệ.`);
  }
  const m = audit.detail as unknown as RepointManifest;
  return prisma.$transaction(
    async (tx) => {
      for (const p of m.pretickets) {
        await tx.preTicket.update({
          where: { id: p.id },
          data: { ticketTypeId: p.oldTicketTypeId, ticketTypeName: p.oldTicketTypeName },
        });
      }
      for (const j of m.jobs) {
        await tx.distributionJob.update({
          where: { id: j.id },
          data: { ticketTypeId: j.oldTicketTypeId, ticketTypeName: j.oldTicketTypeName },
        });
      }
      await tx.distributionAudit.create({
        data: { jobId: 'merge-repoint', action: 'MERGE_REPOINT_ROLLBACK', detail: { rolledBackAuditId: auditId } as object },
      });
      return { movedPreTickets: m.pretickets.length, movedJobs: m.jobs.length };
    },
    { timeout: 60_000 },
  );
}

export function parseRepointArgs(argv: string[]): { input: RepointInput; rollback?: string } {
  const get = (f: string) => {
    const i = argv.indexOf(f);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const csv = (f: string) => (get(f) ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const rollback = get('--rollback');
  return {
    rollback,
    input: {
      survivorId: get('--survivor') ?? '',
      loserIds: csv('--merge'),
      survivorName: get('--survivor-name'),
      includeTerminal: argv.includes('--include-terminal'),
      dryRun: !argv.includes('--apply'),
    },
  };
}
