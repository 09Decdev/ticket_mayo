import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AdminAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RequestUser } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { DistributionService } from './distribution.service';
import { DistributeRequestDto } from './dtos/distribute-request.dto';
import { PrintRequestDto } from './dtos/print-request.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { ContentClientService } from '../content-client/content-client.service';
import { TicketPdfStorageService } from '../ticket-pdf-storage/ticket-pdf-storage.service';
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
    private readonly pdfStorage: TicketPdfStorageService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a ticket distribution job (idempotent by idempotencyKey)' })
  distribute(@Body() dto: DistributeRequestDto, @CurrentUser() user: RequestUser) {
    return this.service.distribute(dto, user.id);
  }

  // VÉ CỨNG: mint N vé không người nhận + render PDF (PII trống) lên bucket —
  // sync theo yêu cầu HTTP như distribute (quantity ≤5000, KHÔNG cron/queue).
  @Post('print')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Vé cứng: mint N vé không người nhận + render PDF in (QR thật, PII trống) + upload S3 (idempotent by idempotencyKey)',
  })
  createPrint(@Body() dto: PrintRequestDto, @CurrentUser() user: RequestUser) {
    return this.service.createPrintJob(dto, user.id);
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

  // ZIP PDF của CẢ LOẠI VÉ (mọi job) — stream thẳng qua @Res nên exception
  // filter của Nest KHÔNG áp dụng; tự map status trong try/catch. Route tĩnh
  // 'ticket-types' đặt trước ':id/status' để không bị tham số nuốt.
  @Get('ticket-types/:ticketTypeId/pdfs.zip')
  @ApiOperation({
    summary: 'Tải zip toàn bộ PDF vé đã archive của 1 loại vé (1 folder = tên loại vé)',
  })
  async downloadTicketTypePdfsZip(
    @Param('ticketTypeId') ticketTypeId: string,
    @Res() res: Response,
  ): Promise<void> {
    try {
      const plan = await this.service.buildPdfZipPlan(ticketTypeId);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(plan.zipName)}`,
      );
      await this.pdfStorage.writeZip(plan.entries, plan.folder, res);
    } catch (err) {
      const status = err instanceof HttpException ? err.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
      if (!res.headersSent) {
        res
          .status(status)
          .json({
            statusCode: status,
            message: err instanceof HttpException ? err.message : 'Tạo zip PDF thất bại.',
          });
      } else {
        // Đang stream dở mà lỗi → cắt kết nối để client không nhận zip cụt coi như hợp lệ.
        res.destroy();
      }
    }
  }

  // VÉ CỨNG: zip CHỈ PDF vé in (job mintMode='PRINT') — route tĩnh đặt cạnh
  // pdfs.zip, trước ':id/status' để không bị tham số nuốt.
  @Get('ticket-types/:ticketTypeId/print-pdfs.zip')
  @ApiOperation({
    summary: 'Tải zip PDF vé in của 1 loại vé (folder "Ve in - <tên loại vé>")',
  })
  async downloadTicketTypePrintPdfsZip(
    @Param('ticketTypeId') ticketTypeId: string,
    @Res() res: Response,
  ): Promise<void> {
    try {
      const plan = await this.service.buildPrintPdfZipPlan(ticketTypeId);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(plan.zipName)}`,
      );
      await this.pdfStorage.writeZip(plan.entries, plan.folder, res);
    } catch (err) {
      const status = err instanceof HttpException ? err.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
      if (!res.headersSent) {
        res
          .status(status)
          .json({
            statusCode: status,
            message: err instanceof HttpException ? err.message : 'Tạo zip vé in thất bại.',
          });
      } else {
        res.destroy();
      }
    }
  }

  @Get(':id/status')
  @ApiOperation({ summary: 'Distribution job status (+ preTickets when includeFailed=true)' })
  @ApiQuery({ name: 'includeFailed', required: false, type: Boolean })
  status(@Param('id') id: string, @Query('includeFailed') includeFailed?: string) {
    return this.service.getStatus(id, includeFailed === 'true');
  }

  @Get(':id/emails/:claimToken')
  @ApiOperation({
    summary: 'Nội dung email ĐÃ gửi cho 1 vé (claimToken) — text + html để admin xem lại',
  })
  sentEmail(@Param('id') id: string, @Param('claimToken') claimToken: string) {
    return this.service.getSentEmail(id, claimToken);
  }

  @Get(':id/emails/:claimToken/pdf/:ticketId')
  @ApiOperation({
    summary: 'Tải PDF vé ĐÍNH KÈM của 1 email đã gửi (chỉ ticketId có trong email đó)',
  })
  async sentEmailPdf(
    @Param('id') id: string,
    @Param('claimToken') claimToken: string,
    @Param('ticketId') ticketId: string,
    @Res() res: Response,
  ): Promise<void> {
    try {
      const { buffer, filename } = await this.service.getSentEmailPdf(id, claimToken, ticketId);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `inline; filename*=UTF-8''${encodeURIComponent(filename)}`,
      );
      res.end(buffer);
    } catch (err) {
      const status =
        err instanceof HttpException ? err.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
      if (!res.headersSent) {
        res
          .status(status)
          .json({
            statusCode: status,
            message: err instanceof HttpException ? err.message : 'Tải PDF thất bại.',
          });
      }
    }
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
