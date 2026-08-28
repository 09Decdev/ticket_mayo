import { Injectable, NotFoundException } from '@nestjs/common';
import { AnalyticsRepository } from './analytics.repository';
import {
  DistributionDetailStatsResponseDto,
  OverviewStatsResponseDto,
} from './dtos/stats.dto';

/**
 * Analytics aggregate (§4.1 A7-A9). Distribution counts come from ticket-mayo
 * DB (jobs + pre-tickets); attendance numbers are derived from claim status.
 */
@Injectable()
export class AnalyticsService {

  constructor(private readonly repo: AnalyticsRepository) {}

  async getOverview(
    from?: Date,
    to?: Date,
    eventId?: string,
  ): Promise<OverviewStatsResponseDto> {
    const counts = await this.repo.getOverviewCounts(from, to);
    const byTicketType = await this.repo.groupByTicketType(from, to);

    return {
      distribution: {
        totalJobs: counts.totalJobs,
        totalPreTickets: counts.totalPreTickets,
        emailSent: counts.emailSent,
        emailFailed: counts.emailFailed,
        claimed: counts.claimed,
        unclaimed: counts.unclaimed,
        byTicketType,
      },
      window: { from: from?.toISOString(), to: to?.toISOString() },
    };
  }

  async getDistributionDetail(jobId: string): Promise<DistributionDetailStatsResponseDto> {
    const result = await this.repo.getDistributionDetail(jobId);
    if (!result) throw new NotFoundException(`Distribution job ${jobId} not found.`);
    const { job, progress } = result;
    return {
      job: {
        jobId: job.id,
        status: job.status,
        recipientCount: job.total,
        totalPreTickets: job.total,
      },
      progress: {
        emailSent: progress.sent,
        emailFailed: progress.failed,
        claimed: progress.claimed,
        unclaimed: progress.total - progress.claimed,
      },
    };
  }
}
