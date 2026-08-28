import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ContentClientService } from '../content-client/content-client.service';

/**
 * Stats controller — phân phối (DistributionJob/PreTicket) giữ local;
 * tổng vé / attendance đọc từ content-service (nguồn sự thật).
 */
@Injectable()
export class StatsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly content: ContentClientService,
  ) {}

  async overview() {
    const [
      totalDistributions,
      totalPreTickets,
      claimed,
      pending,
      sentAgg,
      failedAgg,
      contentStats,
    ] = await Promise.all([
      this.prisma.distributionJob.count(),
      this.prisma.preTicket.count(),
      this.prisma.preTicket.count({ where: { status: 'CLAIMED' } }),
      this.prisma.preTicket.count({ where: { status: 'PENDING' } }),
      this.prisma.distributionJob.aggregate({ _sum: { sent: true } }),
      this.prisma.distributionJob.aggregate({ _sum: { failed: true } }),
      this.content.getStatsOverview(),
    ]);

    return {
      totalDistributions,
      totalPreTickets,
      claimed,
      pending,
      sent: sentAgg._sum.sent ?? 0,
      failed: failedAgg._sum.failed ?? 0,
      totalTickets: contentStats.totalTickets,
      checkedIn: contentStats.checkedIn,
    };
  }

  async attendance(eventId: string) {
    return this.content.getEventAttendance(eventId);
  }
}