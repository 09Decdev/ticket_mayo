import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Best-effort distribution audit record. Never throws — audit failure must
   * not break ticket resolution or distribution.
   */
  async record(args: {
    jobId: string;
    emailHash?: string;
    action: string;
    detail?: Prisma.InputJsonValue;
  }): Promise<void> {
    try {
      await this.prisma.distributionAudit.create({
        data: {
          jobId: args.jobId,
          emailHash: args.emailHash ?? null,
          action: args.action,
          ...(args.detail ? { detail: args.detail } : {}),
        },
      });
    } catch (err) {
      this.logger.warn(`audit record failed: ${(err as Error).message}`);
    }
  }
}
