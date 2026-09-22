/**
 * SPLIT-REPOINT (ticket-mayo) — cập nhật PreTicket có vé content THẬT nằm
 * trong tập chuyển (contentTicketId ∈ movedIds) sau TICKET-TYPE-SPLIT.
 *
 * Khác MERGE-REPOINT (repoint CẢ type vì loser bị xóa → claim nghẹt):
 * split giữ source sống nên claim/mint theo ticketTypeId KHÔNG bị gãy —
 * bước này thuần SNAPSHOT HIỂN THỊ: PreTicket đã mint (contentTicketId set)
 * trỏ vé đã sang target thì ticketTypeId/ticketTypeName cũ sẽ sai lệch.
 * Vậy chỉ repoint ĐÚNG subset theo contentTicketId (PENDING/MINTING chưa có
 * contentTicketId → tự nhiên không dính).
 *
 * File riêng (không nhét vào service) để spec T8 jest.mock như
 * merge-repoint.runner. Idempotent: updateMany WHERE id IN → chạy 2 lần = 0.
 * Rollback: manifest DistributionAudit(action='SPLIT_REPOINT').
 */
import { PrismaClient } from '@prisma/client';

export interface SplitRepointInput {
  sourceId: string;
  targetId: string;
  /** Tên loại target — snapshot hiển thị trên email/PDF chờ gửi. */
  targetName: string | null;
  movedIds: string[];
}

export interface SplitRepointPlan {
  affectedPreTickets: number;
  byStatus: Record<string, number>;
}

interface SplitRepointManifest {
  version: 1;
  sourceId: string;
  targetId: string;
  targetName: string | null;
  movedContentTicketIds: string[];
  pretickets: { id: string; oldTicketTypeId: string; oldTicketTypeName: string }[];
}

export async function planSplitRepoint(
  prisma: PrismaClient,
  movedIds: string[],
): Promise<SplitRepointPlan> {
  if (movedIds.length === 0) return { affectedPreTickets: 0, byStatus: {} };
  const groups = await prisma.preTicket.groupBy({
    by: ['status'],
    where: { contentTicketId: { in: movedIds } },
    _count: { _all: true },
  });
  const byStatus: Record<string, number> = {};
  let total = 0;
  for (const g of groups) {
    byStatus[g.status] = (byStatus[g.status] ?? 0) + g._count._all;
    total += g._count._all;
  }
  return { affectedPreTickets: total, byStatus };
}

export async function applySplitRepoint(
  prisma: PrismaClient,
  input: SplitRepointInput,
  log: (m: string) => void,
): Promise<{ auditId: string; movedPreTickets: number }> {
  if (input.movedIds.length === 0) {
    throw new Error('movedIds rỗng — không có gì để repoint.');
  }
  return prisma.$transaction(
    async (tx) => {
      const rows = await tx.preTicket.findMany({
        where: { contentTicketId: { in: input.movedIds } },
        select: { id: true, ticketTypeId: true, ticketTypeName: true },
      });
      if (rows.length > 0) {
        await tx.preTicket.updateMany({
          where: { id: { in: rows.map((r) => r.id) } },
          data: {
            ticketTypeId: input.targetId,
            ...(input.targetName ? { ticketTypeName: input.targetName } : {}),
          },
        });
      }
      const manifest: SplitRepointManifest = {
        version: 1,
        sourceId: input.sourceId,
        targetId: input.targetId,
        targetName: input.targetName,
        movedContentTicketIds: input.movedIds,
        pretickets: rows.map((r) => ({
          id: r.id,
          oldTicketTypeId: r.ticketTypeId,
          oldTicketTypeName: r.ticketTypeName,
        })),
      };
      const audit = await tx.distributionAudit.create({
        data: { jobId: 'split-repoint', action: 'SPLIT_REPOINT', detail: manifest as object },
        select: { id: true },
      });
      log(
        `[SPLIT-REPOINT] repointed ${rows.length}/${input.movedIds.length} preTickets → ${input.targetId}. Audit=${audit.id}`,
      );
      return { auditId: audit.id, movedPreTickets: rows.length };
    },
    { timeout: 60_000 },
  );
}

export async function rollbackSplitRepoint(
  prisma: PrismaClient,
  auditId: string,
): Promise<{ movedPreTickets: number }> {
  const audit = await prisma.distributionAudit.findUnique({ where: { id: auditId } });
  if (!audit || audit.action !== 'SPLIT_REPOINT') {
    throw new Error(`DistributionAudit ${auditId} không phải bản ghi SPLIT_REPOINT hợp lệ.`);
  }
  const m = audit.detail as unknown as SplitRepointManifest;
  return prisma.$transaction(
    async (tx) => {
      for (const p of m.pretickets) {
        await tx.preTicket.update({
          where: { id: p.id },
          data: { ticketTypeId: p.oldTicketTypeId, ticketTypeName: p.oldTicketTypeName },
        });
      }
      await tx.distributionAudit.create({
        data: {
          jobId: 'split-repoint',
          action: 'SPLIT_REPOINT_ROLLBACK',
          detail: { rolledBackAuditId: auditId } as object,
        },
      });
      return { movedPreTickets: m.pretickets.length };
    },
    { timeout: 60_000 },
  );
}
