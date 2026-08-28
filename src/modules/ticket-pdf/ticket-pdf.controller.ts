import { Controller, Get, NotFoundException, Param, StreamableFile } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { DistributionService } from '../distribution/distribution.service';
import { MailDispatcherService } from '../mail-dispatcher/mail-dispatcher.service';
import { TicketPdfService } from './ticket-pdf.service';

/**
 * Nút "Tải vé PDF" trong email trỏ vào đây — public, claimToken là bearer
 * secret (cùng mô hình tin cậy với /claim/:token). Sinh lại ĐÚNG nội dung
 * template email (payload tra theo claimToken từ DB) → headless Chromium in
 * PDF → trả về dạng attachment để trình duyệt tải về.
 */
@ApiTags('ticket-pdf')
@Controller('tickets/pdf')
export class TicketPdfController {
  constructor(
    private readonly distribution: DistributionService,
    private readonly mailDispatcher: MailDispatcherService,
    private readonly pdf: TicketPdfService,
  ) {}

  @Get(':claimToken')
  @ApiOperation({
    summary: 'Download PDF của toàn bộ template email vé (banner + QR + text) theo claimToken',
  })
  async downloadPdf(@Param('claimToken') claimToken: string): Promise<StreamableFile> {
    const payload = await this.distribution.buildPayloadByClaimToken(claimToken);
    if (!payload) throw new NotFoundException('Không tìm thấy vé cho mã này.');

    const html = await this.mailDispatcher.buildPdfHtml(payload);
    const pdf = await this.pdf.renderPdf(html);

    // claimToken chỉ có [A-Za-z0-9] → filename luôn an toàn cho header.
    const code = (payload.ticketCode ?? claimToken.slice(-8)).toUpperCase();
    return new StreamableFile(pdf, {
      type: 'application/pdf',
      disposition: `attachment; filename="ve-${code}.pdf"`,
    });
  }
}