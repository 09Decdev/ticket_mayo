import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AdminAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RequestUser } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { DistributionService } from './distribution.service';
import { DistributeRequestDto } from './dtos/distribute-request.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { ContentClientService } from '../content-client/content-client.service';
import {
  parseBackfillLimit,
  parseDbHost,
  runBackfill,
} from './backfill.runner';

@ApiTags('admin/distributions')
@Controller('admin/distributions')
@UseGuards(AdminAuthGuard)
@ApiBearerAuth('JWT-auth')
export class DistributionController {
  constructor(
    private readonly service: DistributionService,
    private readonly prisma: PrismaService,
    private readonly content: ContentClientService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a ticket distribution job (idempotent by idempotencyKey)' })
  distribute(@Body() dto: DistributeRequestDto, @CurrentUser() user: RequestUser) {
    return this.service.distribute(dto, user.id);
  }

  @Get('backfill/dry-run')
  @ApiOperation({
    summary:
      'Backfill dry-run report (read-only — PLAN T7: cap quét để chống admin-token DoS; CLI là run-path canonical)',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Số PENDING row tối đa quét (default 1000, hard cap 5000)',
  })
  @ApiQuery({ name: 'jobId', required: false, type: String })
  async backfillDryRun(
    @Query('limit') limit?: string,
    @Query('jobId') jobId?: string,
  ) {
    // Read-only: TÁI DÙNG logic dry-run từ backfill.runner.ts — KHÔNG mint,
    // KHÔNG ghi DB, KHÔNG audit. Cap query param → take trong findMany
    // (PLAN L313 — chống quét toàn bảng PreTicket).
    const scanLimit = parseBackfillLimit(limit);
    const res = await runBackfill(
      { prisma: this.prisma, content: this.content, audit: { record: async () => undefined } },
      {
        dryRun: true,
        jobIdFilter: jobId,
        dryRunScanLimit: scanLimit,
        dbHost: parseDbHost(process.env.DATABASE_URL ?? ''),
      },
    );
    return res.report; // DryRunReport — cùng shape JSON CLI in ra stdout (Δ5)
  }

  @Get()
  @ApiOperation({ summary: 'List distribution jobs (paginated)' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  list(@Query('page') page?: string, @Query('limit') limit?: string) {
    return this.service.list(page ? Number(page) : 1, limit ? Number(limit) : 20);
  }

  @Get(':id/status')
  @ApiOperation({ summary: 'Distribution job status (+ preTickets when includeFailed=true)' })
  @ApiQuery({ name: 'includeFailed', required: false, type: Boolean })
  status(@Param('id') id: string, @Query('includeFailed') includeFailed?: string) {
    return this.service.getStatus(id, includeFailed === 'true');
  }

  @Post(':id/retry')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Retry mint PreTickets MINTING-fail của job PARTIALLY_MINTED/FAILED (idempotent — content dedupe theo preTicketId)',
  })
  retry(@Param('id') id: string, @CurrentUser() user: RequestUser) {
    return this.service.retryMint(id, user.id);
  }

  @Post(':id/resend-emails')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Resend email cho PreTicket MINTED có emailSentAt IS NULL (idempotent — lần 2 sent=0)',
  })
  resendEmails(@Param('id') id: string, @CurrentUser() user: RequestUser) {
    return this.service.resendEmails(id, user.id);
  }
}
