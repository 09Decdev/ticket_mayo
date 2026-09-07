import { Injectable, Logger } from '@nestjs/common';
import PDFDocument = require('pdfkit');
import * as QRCode from 'qrcode';
import sharp from 'sharp';
import * as path from 'path';
import * as fs from 'fs';
import { createHash } from 'crypto';

export interface TicketPdfRenderInput {
  eventTitle: string;
  startTime: Date;
  address?: string | null;
  city?: string | null;
  ticketTypeName: string;
  ticketCode: string;
  seatLabel?: string | null;
  attendee?: {
    name?: string | null;
    phone?: string | null;
    email?: string | null;
    bookedAt?: string | null;
  } | null;
  backgroundBuffer?: Buffer | null;
  supportEmail?: string | null;
  supportPhone?: string | null;
  token: string;
}

/**
 * Render PDF vé TẠI ticket-mayo (port từ content-service
 * ticket-pdf.service.ts) — vì vé giờ được render SẴN để đính kèm mail +
 * in vé cứng, không còn tải on-demand từ content. Content chỉ còn giữ
 * mint vé + QR token signing (app verify offline), KHÔNG render PDF nữa.
 * Banner ảnh event, thông tin người đặt, mã vé + QR, notice, hỗ trợ.
 * QR = chính static signed token (offline-checkin v1.1) nên scan bản in
 * vẫn check-in được. PII (tên/SĐT/email/bookedAt) truyền từ caller
 * (DB ticket-mayo / input admin) — renderer KHÔNG tự lưu (PRD §7.1 D3).
 */
@Injectable()
export class TicketPdfService {
  private readonly logger = new Logger(TicketPdfService.name);

  /**
   * Cache PDF đã render (in-memory, TUYỆT ĐỐI không Redis — PDF chứa PII
   * plaintext, PRD D3 không lưu PII). Key = sha256(input canonical).
   * Buffer dùng chung cho response — caller KHÔNG được mutate.
   */
  private readonly pdfCache = new Map<string, Buffer>();
  private static readonly PDF_CACHE_CAP = 500;

  /** Font TTF đọc 1 lần từ disk (lazy) thành Buffer — chặn 30ms I/O mỗi render. */
  private readonly fontBufferCache = new Map<string, Buffer>();
  private missingFontWarned = false;

  private readonly COLORS = {
    pageBg: '#FFFFFF',
    ticketBoxBg: '#FAF9F7',
    ticketBoxBorder: '#EBE8E3',
    title: '#20252D',
    body: '#20252D',
    muted: '#505762',
    label: '#646B74',
    codeLabel: '#59606A',
    dividerDotted: '#D6D6D6',
    perforateDivider: '#B0B5BA',
    footerDivider: '#E0E0E0',
    noticeBg: '#E8FCEB',
    noticeBorder: '#CBF4D2',
    noticeTitle: '#1F2937',
    noticeText: '#30363D',
    green: '#168D43',
    gradientA: '#1E293B',
    gradientB: '#0F172A',
  };

  /** Cache ảnh PNG tĩnh (icon, logo) đọc từ disk */
  private readonly imageBufferCache = new Map<string, Buffer>();

  private getImageBuffer(fileName: string): Buffer | null {
    const cached = this.imageBufferCache.get(fileName);
    if (cached) return cached;
    const candidates = [
      path.join(process.cwd(), 'src', 'assets', 'images', fileName),
      path.join(process.cwd(), 'dist', 'assets', 'images', fileName),
      path.join(process.cwd(), 'img', fileName),
      path.resolve(__dirname, '..', '..', '..', 'assets', 'images', fileName),
      path.resolve(__dirname, '..', '..', 'assets', 'images', fileName),
      path.resolve(__dirname, '..', '..', '..', 'img', fileName),
    ];
    for (const filePath of candidates) {
      if (fs.existsSync(filePath)) {
        const buf = fs.readFileSync(filePath);
        this.imageBufferCache.set(fileName, buf);
        return buf;
      }
    }
    return null;
  }

  async renderTicketPdf(data: TicketPdfRenderInput): Promise<Buffer> {
    // ─── LRU cache hit? Re-insert để recency, trả thẳng buffer đã render. ───
    const cacheKey = this.buildCacheKey(data);
    const cached = this.pdfCache.get(cacheKey);
    if (cached) {
      this.pdfCache.delete(cacheKey);
      this.pdfCache.set(cacheKey, cached);
      return cached;
    }

    const qrBuf = await QRCode.toBuffer(data.token, {
      errorCorrectionLevel: 'H',
      margin: 1,
      width: 320,
      color: { dark: '#20252D', light: '#FFFFFF' },
    });

    const A4_WIDTH = 595.28;
    const PAGE_HEIGHT = 841.89;
    const MARGIN_X = 35;
    const CONTENT_W = Math.round(A4_WIDTH - MARGIN_X * 2); // 525 pt
    const startX = MARGIN_X;
    let currentY = 24;

    const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true });

    const regularBuf = this.getFontBuffer('Roboto-Regular.ttf');
    if (regularBuf) doc.registerFont('Roboto', regularBuf);
    else doc.registerFont('Roboto', 'Helvetica');
    const boldBuf = this.getFontBuffer('Roboto-Bold.ttf');
    if (boldBuf) doc.registerFont('Roboto-Bold', boldBuf);
    else doc.registerFont('Roboto-Bold', 'Helvetica-Bold');
    if ((!regularBuf || !boldBuf) && !this.missingFontWarned) {
      this.missingFontWarned = true;
      this.logger.error(
        `Ticket PDF fonts missing (${path.join(process.cwd(), 'src', 'assets', 'fonts', 'Roboto-Regular.ttf')}) — fallback Helvetica sẽ vỡ ký tự tiếng Việt.`,
      );
    }

    const clockImg = this.getImageBuffer('clock.png');
    const locImg = this.getImageBuffer('location.png');
    const vectorImg = this.getImageBuffer('Vector.png');
    const logoImg = this.getImageBuffer('Logo_xoa_phong 2.png');

    const buffers: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => buffers.push(chunk));
    const done = new Promise<Buffer>((resolve, reject) => {
      doc.on('end', () => resolve(Buffer.concat(buffers)));
      doc.on('error', reject);
    });

    // ─── 0. Nền trang A4: Trắng tinh khiết ───
    doc.rect(0, 0, A4_WIDTH, PAGE_HEIGHT).fill(this.COLORS.pageBg);

    // ─── 1. BANNER: 525 x 275 pt, bo góc 14px cả 4 góc ───
    const BANNER_H = 275;
    let bannerPng: Buffer | null = null;
    if (data.backgroundBuffer) {
      try {
        bannerPng = await sharp(data.backgroundBuffer)
          .resize(CONTENT_W, BANNER_H, { fit: 'cover', position: 'center' })
          .png()
          .toBuffer();
      } catch (imgErr) {
        this.logger.warn(`Failed to convert banner image: ${(imgErr as Error).message}`);
      }
    }

    doc.save();
    doc.roundedRect(startX, currentY, CONTENT_W, BANNER_H, 14).clip();
    if (bannerPng) {
      doc.image(bannerPng, startX, currentY, { width: CONTENT_W, height: BANNER_H });
    } else {
      const grad = doc.linearGradient(startX, currentY, startX + CONTENT_W, currentY + BANNER_H);
      grad.stop(0, this.COLORS.gradientA).stop(1, this.COLORS.gradientB);
      doc.rect(startX, currentY, CONTENT_W, BANNER_H).fill(grad);
      doc
        .font('Roboto-Bold')
        .fontSize(28)
        .fillColor('#FFFFFF')
        .text('MAYogu', startX + 24, currentY + 80);
      doc
        .font('Roboto')
        .fontSize(13)
        .fillColor('#E2E8F0')
        .text('Vé điện tử sự kiện chính thức', startX + 24, currentY + 125);
    }
    doc.restore();

    // Viền nhẹ cho banner
    doc
      .roundedRect(startX, currentY, CONTENT_W, BANNER_H, 14)
      .lineWidth(1)
      .strokeColor('#E2E5E9')
      .stroke();

    currentY += BANNER_H + 12;

    // ─── 2. HỘP THÔNG TIN VÉ (TICKET BOX #FAF9F7) ───
    const ticketBoxStartY = currentY;
    const padX = 20;
    const padY = 16;
    const leftColX = startX + padX; // 55
    const leftColW = 295; // 55 + 295 = 350 (cách QR 38pt, hoàn toàn không thể đè)
    const qrSize = 144;
    const rightColW = 160;
    const rightColX = startX + CONTENT_W - padX - rightColW; // 35 + 525 - 20 - 160 = 380
    const qrX = rightColX + (rightColW - qrSize) / 2; // 380 + 8 = 388

    // Đo đạc kích thước trước để vẽ khung bao ngoài chính xác
    doc.font('Roboto-Bold').fontSize(14);
    const titleH = doc.heightOfString(data.eventTitle, { width: leftColW, lineGap: 2 });
    const locationStr = [data.address, data.city].filter(Boolean).join(', ') || 'Hoàng Thành Thăng Long';
    const timeStr = this.formatEventDate(data.startTime);
    doc.font('Roboto').fontSize(10);
    const timeH = doc.heightOfString('Thời gian: ' + timeStr, { width: leftColW - 16 });
    const locH = doc.heightOfString('Địa điểm: ' + locationStr, { width: leftColW - 16 });

    const infoRows: Array<[string, string]> = [
      ['Họ tên:', data.attendee?.name || 'Người nhận vé MAYogu'],
      ['Số điện thoại:', data.attendee?.phone || '—'],
      ['Email:', data.attendee?.email || '—'],
      ['Thời gian đặt:', data.attendee?.bookedAt || timeStr],
    ];
    if (data.seatLabel) {
      infoRows.push(['Chỗ ngồi:', data.seatLabel]);
    }
    if (data.ticketTypeName && data.ticketTypeName !== 'Vé') {
      infoRows.push(['Loại vé:', data.ticketTypeName]);
    }

    let infoRowsH = 0;
    doc.font('Roboto-Bold').fontSize(10);
    for (const [, val] of infoRows) {
      const rowH = doc.heightOfString(val, { width: leftColW - 88 });
      infoRowsH += Math.max(rowH, 14) + 4;
    }

    const leftContentH = padY + titleH + 8 + timeH + 6 + locH + 10 + 1 + 10 + 14 + 8 + infoRowsH + padY;
    const rightContentH = padY + 14 + 18 + qrSize + padY; // ~196 pt
    const ticketBoxH = Math.max(leftContentH, rightContentH, 205);

    // Vẽ nền ticket box bo góc 14px
    doc
      .roundedRect(startX, ticketBoxStartY, CONTENT_W, ticketBoxH, 14)
      .fill(this.COLORS.ticketBoxBg);
    doc
      .roundedRect(startX, ticketBoxStartY, CONTENT_W, ticketBoxH, 14)
      .lineWidth(1)
      .strokeColor(this.COLORS.ticketBoxBorder)
      .stroke();

    // ── Cột trái: Tên sự kiện, Thời gian, Địa điểm, Thông tin người đặt ──
    let ly = ticketBoxStartY + padY;
    doc
      .font('Roboto-Bold')
      .fontSize(14)
      .fillColor(this.COLORS.title)
      .text(data.eventTitle, leftColX, ly, { width: leftColW, lineGap: 2 });
    ly = doc.y + 8;

    // Dòng Thời gian (có icon clock)
    if (clockImg) {
      doc.image(clockImg, leftColX, ly + 1, { width: 11, height: 11 });
    } else {
      const cx = leftColX + 5.5;
      const cy = ly + 6.5;
      doc.circle(cx, cy, 5.5).fill('#000000');
      doc.moveTo(cx, cy - 3).lineTo(cx, cy).lineTo(cx + 2, cy).lineWidth(1).strokeColor('#FFFFFF').stroke();
    }
    doc.font('Roboto').fontSize(10).fillColor(this.COLORS.muted).text('Thời gian: ', leftColX + 16, ly, { continued: true, width: leftColW - 16 });
    doc.font('Roboto-Bold').fillColor(this.COLORS.body).text(timeStr);
    ly = doc.y + 6;

    // Dòng Địa điểm (có icon location)
    if (locImg) {
      doc.image(locImg, leftColX + 1, ly + 1, { width: 9, height: 11 });
    } else {
      const px = leftColX + 5.5;
      const py = ly + 6.5;
      doc.circle(px, py - 1.5, 3.5).fill('#000000');
      doc.moveTo(px - 3.5, py - 0.5).lineTo(px, py + 4).lineTo(px + 3.5, py - 0.5).fill('#000000');
      doc.circle(px, py - 1.5, 1.2).fill('#FFFFFF');
    }
    doc.font('Roboto').fontSize(10).fillColor(this.COLORS.muted).text('Địa điểm: ', leftColX + 16, ly, { continued: true, width: leftColW - 16 });
    doc.font('Roboto-Bold').fillColor(this.COLORS.body).text(locationStr);
    ly = doc.y + 10;

    // Đường nét đứt mảnh ở cột trái
    doc
      .moveTo(leftColX, ly)
      .lineTo(leftColX + leftColW, ly)
      .lineWidth(0.8)
      .dash(2.5, { space: 2.5 })
      .strokeColor(this.COLORS.dividerDotted)
      .stroke()
      .undash();
    ly += 10;

    // Tiêu đề THÔNG TIN NGƯỜI ĐẶT VÉ
    doc
      .font('Roboto-Bold')
      .fontSize(11)
      .fillColor(this.COLORS.title)
      .text('THÔNG TIN NGƯỜI ĐẶT VÉ', leftColX, ly);
    ly = doc.y + 8;

    for (const [label, val] of infoRows) {
      doc.font('Roboto').fontSize(10).fillColor(this.COLORS.label).text(label, leftColX, ly, { width: 85, lineBreak: false });
      doc.font('Roboto-Bold').fontSize(10).fillColor(this.COLORS.body).text(val, leftColX + 88, ly, { width: leftColW - 88 });
      ly = Math.max(doc.y, ly + 14) + 4;
    }

    // ── Cột phải: Mã vé & QR Code ──
    let ry = ticketBoxStartY + padY;
    let codeFontSize = 11;
    doc.font('Roboto').fontSize(codeFontSize);
    let codeLabelW = doc.widthOfString('Mã vé   ');
    doc.font('Roboto-Bold').fontSize(codeFontSize);
    let codeValW = doc.widthOfString(data.ticketCode);
    while (codeLabelW + codeValW > rightColW && codeFontSize > 8.5) {
      codeFontSize -= 0.5;
      doc.font('Roboto').fontSize(codeFontSize);
      codeLabelW = doc.widthOfString('Mã vé   ');
      doc.font('Roboto-Bold').fontSize(codeFontSize);
      codeValW = doc.widthOfString(data.ticketCode);
    }
    const codeTotalW = codeLabelW + codeValW;
    const codeStartX = rightColX + (rightColW - codeTotalW) / 2;

    doc.font('Roboto').fontSize(codeFontSize).fillColor(this.COLORS.codeLabel).text('Mã vé   ', codeStartX, ry, { lineBreak: false });
    doc.font('Roboto-Bold').fontSize(codeFontSize).fillColor(this.COLORS.title).text(data.ticketCode, codeStartX + codeLabelW, ry);

    ry += 18;
    doc.image(qrBuf, qrX, ry, { width: qrSize, height: qrSize });

    currentY = ticketBoxStartY + ticketBoxH + 12;

    // ─── 3. ĐƯỜNG RÃNH NÉT ĐỨT PHÂN TẦNG (PERFORATION LINE) ───
    doc
      .moveTo(startX, currentY)
      .lineTo(startX + CONTENT_W, currentY)
      .lineWidth(1)
      .dash(4, { space: 4 })
      .strokeColor(this.COLORS.perforateDivider)
      .stroke()
      .undash();

    currentY += 12;

    // ─── 4. HỘP LƯU Ý QUAN TRỌNG KHI THAM DỰ (#E8FCEB) ───
    const noticeY = currentY;
    const noticeTitle = 'Lưu ý quan trọng khi tham dự:';
    const notices = [
      'Vui lòng mở sẵn mã vé trên thiết bị di động và chuẩn bị xuất trình cho nhân viên soát vé.',
      'Hãy đến trước giờ diễn ra sự kiện tối thiểu 15 phút.',
      'Vé chỉ có giá trị sử dụng 1 lần.',
      'Mỗi mã vé chỉ có giá trị sử dụng cho một người.',
    ];

    doc.font('Roboto').fontSize(9.5);
    let totalNoticeH = 0;
    for (const n of notices) {
      totalNoticeH += doc.heightOfString('•  ' + n, { width: CONTENT_W - 32 }) + 5;
    }
    const noticeH = 14 + 14 + 8 + totalNoticeH + 10;

    doc
      .roundedRect(startX, noticeY, CONTENT_W, noticeH, 12)
      .fill(this.COLORS.noticeBg);
    doc
      .roundedRect(startX, noticeY, CONTENT_W, noticeH, 12)
      .lineWidth(1)
      .strokeColor(this.COLORS.noticeBorder)
      .stroke();

    // Icon tam giác cảnh báo
    if (vectorImg) {
      doc.image(vectorImg, startX + 16, noticeY + 14, { width: 17, height: 16 });
    } else {
      const vx = startX + 24;
      const vy = noticeY + 14;
      doc.polygon([vx, vy], [vx - 8, vy + 15], [vx + 8, vy + 15]).lineWidth(1.2).strokeColor('#168D43').stroke();
      doc.font('Roboto-Bold').fontSize(8).fillColor('#168D43').text('!', vx - 1.5, vy + 4);
    }

    doc
      .font('Roboto-Bold')
      .fontSize(11.5)
      .fillColor(this.COLORS.noticeTitle)
      .text(noticeTitle, startX + 40, noticeY + 15);

    let ny = noticeY + 15 + 18;
    doc.font('Roboto').fontSize(9.5).fillColor(this.COLORS.noticeText);
    for (const n of notices) {
      doc.text('•  ' + n, startX + 16, ny, { width: CONTENT_W - 32 });
      ny = doc.y + 5;
    }

    currentY = noticeY + noticeH + 16;

    // ─── 5. THÔNG TIN HỖ TRỢ & LOGO NỀN TẢNG MAYOGU ───
    doc
      .moveTo(startX, currentY)
      .lineTo(startX + CONTENT_W, currentY)
      .lineWidth(0.8)
      .dash(2.5, { space: 2.5 })
      .strokeColor(this.COLORS.footerDivider)
      .stroke()
      .undash();

    currentY += 12;

    const footerLeftW = Math.round(CONTENT_W * 0.52);
    const footerRightX = startX + footerLeftW;
    const footerRightW = CONTENT_W - footerLeftW;

    const supportEmail = data.supportEmail ?? 'support@mayogu.com';
    const supportPhone = data.supportPhone ?? '0966 855 560';

    // Cột trái: Thông tin hỗ trợ
    doc
      .font('Roboto-Bold')
      .fontSize(11.5)
      .fillColor(this.COLORS.title)
      .text('Thông tin hỗ trợ', startX, currentY);

    let fy = currentY + 16;
    doc
      .font('Roboto')
      .fontSize(9.5)
      .fillColor(this.COLORS.muted)
      .text('Nếu gặp khó khăn trong quá trình sử dụng vé, vui lòng liên hệ:', startX, fy, {
        width: footerLeftW - 10,
      });

    fy += 16;
    doc.font('Roboto-Bold').fontSize(10.5).fillColor(this.COLORS.title).text('Email', startX, fy);
    doc.font('Roboto').fontSize(9.5).fillColor(this.COLORS.green).text(supportEmail, startX, fy + 14);

    doc.font('Roboto-Bold').fontSize(10.5).fillColor(this.COLORS.title).text('Hotline', startX + 140, fy);
    doc.font('Roboto').fontSize(9.5).fillColor(this.COLORS.title).text(supportPhone, startX + 140, fy + 14);

    // Cột phải: Quản lý bởi nền tảng MAYogu
    doc
      .font('Roboto')
      .fontSize(9.5)
      .fillColor(this.COLORS.title)
      .text('Vé điện tử được quản lý bởi nền tảng', footerRightX, currentY, {
        width: footerRightW,
        align: 'center',
      });

    const logoW = 115;
    const logoH = 32;
    const logoX = footerRightX + (footerRightW - logoW) / 2;
    if (logoImg) {
      doc.image(logoImg, logoX, currentY + 15, { width: logoW, height: logoH });
    } else {
      doc
        .font('Roboto-Bold')
        .fontSize(18)
        .fillColor(this.COLORS.green)
        .text('MAYogu', footerRightX, currentY + 18, { width: footerRightW, align: 'center' });
    }

    doc
      .font('Roboto')
      .fontSize(9.5)
      .fillColor(this.COLORS.green)
      .text('Tham gia MAYogu ngay   App Store   Google Play', footerRightX, currentY + 52, {
        width: footerRightW,
        align: 'center',
      });

    doc.end();
    const buf = await done;
    // ─── Set cache (evict đầu LRU khi quá cap) sau khi render xong. ───
    if (this.pdfCache.size >= TicketPdfService.PDF_CACHE_CAP) {
      const oldestKey = this.pdfCache.keys().next().value;
      if (oldestKey !== undefined) this.pdfCache.delete(oldestKey);
    }
    this.pdfCache.set(cacheKey, buf);
    return buf;
  }

  /**
   * Font TTF: đọc 1 lần từ disk vào cache (lazy). File thiếu → null
   * (Helvetica fallback). Resolution theo thứ tự: (1) src/assets/fonts khi
   * chạy dev (cwd = repo root); (2) dist-side copy — build script copy fonts
   * vào dist/assets/fonts cạnh main.js để `node dist/main` luôn tìm thấy
   * bất kể cwd ở đâu (PM/serve chạy từ repo root, cwd = src/assets cũng hit).
   */
  private getFontBuffer(fileName: 'Roboto-Regular.ttf' | 'Roboto-Bold.ttf'): Buffer | null {
    const candidates = [
      path.join(process.cwd(), 'src', 'assets', 'fonts', fileName), // dev + node dist/main từ root
      path.join(TicketPdfService.distAssetsDir(), fileName), // node dist/main cwd khác root
    ];
    for (const filePath of candidates) {
      const cached = this.fontBufferCache.get(filePath);
      if (cached) return cached;
      if (fs.existsSync(filePath)) {
        const buf = fs.readFileSync(filePath);
        this.fontBufferCache.set(filePath, buf);
        return buf;
      }
    }
    return null;
  }

  /** dist/assets/fonts — font copy vào đây bởi build script (postbuild). */
  private static distAssetsDir(): string {
    // __dirname = dist/modules/ticket-pdf-storage → leo 3 mức về dist/assets/fonts
    return path.resolve(__dirname, '..', '..', '..', 'assets', 'fonts');
  }

  /**
   * Key cache = sha256(JSON canonical các field render TRỪ backgroundBuffer —
   * buffer lớn hash riêng ~1-2ms so với 92ms render nên chấp nhận; để nếu đổi
   * background chỉ cần sharp lại, không vô hiệu cache PDF cùng nội dung text.
   */
  private buildCacheKey(data: TicketPdfRenderInput): string {
    const { backgroundBuffer, ...rest } = data;
    const restHash = createHash('sha256')
      .update(TicketPdfService.canonicalJson(rest))
      .digest('hex');
    const bgHash = backgroundBuffer
      ? createHash('sha256').update(backgroundBuffer).digest('hex')
      : 'none';
    return `${restHash}:${bgHash}`;
  }

  /** JSON canonical (sort keys, Date → ISO) — field order khác nhau vẫn ra key giống nhau. */
  private static canonicalJson(value: unknown): string {
    if (value instanceof Date) return JSON.stringify(value.toISOString());
    if (Array.isArray(value)) {
      return `[${value.map((v) => TicketPdfService.canonicalJson(v)).join(',')}]`;
    }
    if (value !== null && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).sort();
      return `{${keys
        .map((k) => `${JSON.stringify(k)}:${TicketPdfService.canonicalJson(obj[k])}`)
        .join(',')}}`;
    }
    return JSON.stringify(value);
  }

  private formatEventDate(date: Date | string | null | undefined): string {
    if (!date) return '—';
    const d = new Date(date);
    if (isNaN(d.getTime())) return '—';
    const days = ['Chủ nhật', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7'];
    const dayName = days[d.getDay()];
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    return `${hours}:${minutes} - ${dayName}, ${day}/${month}/${year}`;
  }
}
