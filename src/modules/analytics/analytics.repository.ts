import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Aggregate queries against ticket-mayo DB. Counts only — no plaintext email
 * is exposed in the response (§8.9 / §8.3 PII).
 */
@Injectable()
export class AnalyticsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async getOverviewCounts(from?: Date, to?: Date) {
    const jobWhere = this.rangeWhere(from, to);
    const preTicketWhere = this.preTicketRangeWhere(from, to);

    const [totalJobs, totalPreTickets, sentAgg, failedAgg, claimed, unclaimed] =
      await Promise.all([
        this.prisma.distributionJob.count({ where: jobWhere }),
        this.prisma.preTicket.count({ where: preTicketWhere }),
        this.prisma.distributionJob.aggregate({ where: jobWhere, _sum: { sent: true } }),
        this.prisma.distributionJob.aggregate({ where: jobWhere, _sum: { failed: true } }),
        this.prisma.preTicket.count({ where: { ...preTicketWhere, status: 'CLAIMED' } }),
        this.prisma.preTicket.count({ where: { ...preTicketWhere, status: { not: 'CLAIMED' } } }),
      ]);

    return {
      totalJobs,
      totalPreTickets,
      emailSent: sentAgg._sum.sent ?? 0,
      emailFailed: failedAgg._sum.failed ?? 0,
      claimed,
      unclaimed,
    };
  }

  async groupByTicketType(from?: Date, to?: Date): Promise<
    Array<{
      ticketTypeId: string;
      ticketTypeName: string;
      count: number;
      claimed: number;
    }>
  > {
    const rows = await this.prisma.preTicket.groupBy({
      by: ['ticketTypeId', 'ticketTypeName'],
      where: this.preTicketRangeWhere(from, to),
      _count: { _all: true },
    });
    const claimedRows = await this.prisma.preTicket.groupBy({
      by: ['ticketTypeId'],
      where: {
        ...this.preTicketRangeWhere(from, to),
        status: 'CLAIMED',
      },
      _count: { _all: true },
    });
    const countOf = (r: { _count: unknown }) =>
      (r._count as { _all?: number } | undefined)?._all ?? 0;
    const claimedMap = new Map<string, number>(
      claimedRows.map((r) => [r.ticketTypeId, countOf(r)]),
    );
    return rows.map((r) => ({
      ticketTypeId: r.ticketTypeId,
      ticketTypeName: r.ticketTypeName,
      count: countOf(r),
      claimed: claimedMap.get(r.ticketTypeId) ?? 0,
    }));
  }

  async getDistributionDetail(jobId: string) {
    const job = await this.prisma.distributionJob.findUnique({
      where: { id: jobId },
    });
    if (!job) return null;
    const [claimed, total] = await Promise.all([
      this.prisma.preTicket.count({
        where: { jobId: job.id, status: 'CLAIMED' },
      }),
      this.prisma.preTicket.count({ where: { jobId: job.id } }),
    ]);
    return { job, progress: { sent: job.sent, failed: job.failed, claimed, total } };
  }

  private rangeWhere(from?: Date, to?: Date) {
    const where: { createdAt?: { gte?: Date; lte?: Date } } = {};
    if (from || to) where.createdAt = { gte: from ?? undefined, lte: to ?? undefined };
    return where;
  }

  private preTicketRangeWhere(from?: Date, to?: Date) {
    const where: { createdAt?: { gte?: Date; lte?: Date } } = {};
    if (from || to) where.createdAt = { gte: from ?? undefined, lte: to ?? undefined };
    return where;
  }
}
