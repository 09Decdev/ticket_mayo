import { Injectable, Logger } from '@nestjs/common';
import puppeteer from 'puppeteer';

/**
 * Render HTML của đúng template email vé → PDF A4 (nút "Tải vé PDF" trong
 * email). Card/bảng inline của template là table-CSS nên Chromium headless
 * in ra trung thực: banner + QR + toàn bộ text, cùng nút tải lại lần nữa.
 *
 * Mỗi lần gọi launch 1 Chromium headless mới (rẻ cho click-scale, không giữ
 * tiến trình thừa). Lỗi font (hệ thống thiếu Segoe UI/Arial) → Chromium tự
 * fallback; PDF vẫn ra.
 */
@Injectable()
export class TicketPdfService {
  private readonly logger = new Logger(TicketPdfService.name);

  async renderPdf(html: string): Promise<Buffer> {
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--font-render-hinting=none'],
    });
    try {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      // Fonts Google (Be Vietnam Pro) — chờ best-effort, offline vẫn in (Arial).
      try {
        await page.waitForNetworkIdle({ timeout: 4_000, idleTime: 400 });
      } catch {
        /* offline — dùng font fallback */
      }
      const pdf = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: '8mm', bottom: '8mm', left: '8mm', right: '8mm' },
      });
      return Buffer.from(pdf);
    } catch (err) {
      this.logger.error(`renderPDF lỗi: ${(err as Error).message}`);
      throw err;
    } finally {
      await browser.close().catch(() => undefined);
    }
  }
}