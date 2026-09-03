import { Injectable, Logger } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import QRCode from 'qrcode';
import sharp from 'sharp';
import { env } from '../../config/env';
import { ContentClientService } from '../content-client/content-client.service';
import { CidAttachment, ClaimMailPayload, MailAdapter } from './mail.adapter';
import { renderTicketEmailHtml } from './ticket-email.renderer';

const TEMPLATE_PATH = join(
  process.cwd(),
  'mail-previews',
  'mayogu_ticket_email_template.html',
);

/** CID constants — dùng trong cả HTML template (src="cid:xxx") và attachment list. */
const CID_LOGO = 'mayogu-logo@ticket';
const CID_NOTICE_ICON = 'notice-icon@ticket';
const CID_EVENT_BANNER = 'event-banner@ticket';
const CID_TIME_ICON = 'time-icon@ticket';
const CID_LOCATION_ICON = 'location-icon@ticket';
const CID_DOWNLOAD_ICON = 'download-icon@ticket';

/** Ảnh event > ngưỡng này → bỏ qua (email vượt giới hạn kích thước Gmail/Outlook). */
const MAX_EVENT_IMAGE_BYTES = 3 * 1024 * 1024;
const EVENT_IMAGE_FETCH_TIMEOUT_MS = 10_000;

/**
 * P7: ảnh event nhúng email chỉ hiển thị 600px (template) → gửi tối đa 1200px
 * (retina ×2) JPEG q80 thay vì nhúng raw — email nhẹ hơn rõ rệt. Ảnh đã là
 * JPEG nhẹ (≤256KB) thì nhúng nguyên bản, khỏi phí CPU resize.
 */
const EVENT_IMAGE_EMAIL_MAX_WIDTH = 1200;
const EVENT_IMAGE_EMAIL_JPEG_QUALITY = 80;
const EVENT_IMAGE_OPTIMIZE_IF_BIGGER_THAN_BYTES = 256 * 1024;

/** Số payload xử lý đồng thời trong 1 đợt (P2 — tránh dồn CPU/sharp + SMTP cùng lúc). */
const MAIL_DISPATCH_CONCURRENCY = 4;

/**
 * Chạy tối đa `limit` task đồng thời. Callback nhận (item, index) — caller ghi
 * kết quả theo index để giữ đúng thứ tự input (results[] không đảo).
 */
async function runConcurrent<T>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

/**
 * Dispatches ticket emails. The concrete adapter (console | kafka | smtp) is
 * selected at module wiring time based on `env.MAIL_TRANSPORT`. Body rendered từ
 * `mail-previews/mayogu_ticket_email_template.html` (16 placeholder {{token}}).
 *
 * Ảnh logo + notice icon được nhúng qua CID inline attachment (nodemailer) —
 * cách chuẩn để email client (Gmail, Outlook, Apple Mail) hiển thị ảnh nhúng.
 */
@Injectable()
export class MailDispatcherService {
  private readonly logger = new Logger(MailDispatcherService.name);
  private template: string | null = null;

  /** Cache buffers đọc 1 lần từ disk. */
  private logoBuf: Buffer | null = null;
  private noticeIconBuf: Buffer | null = null;
  private qrLogoBuf: Buffer | null = null;
  private timeIconBuf: Buffer | null = null;
  private locationIconBuf: Buffer | null = null;
  private downloadIconBuf: Buffer | null = null;
  /** QR logo 60×60 sau resize — resize 1 lần (P5), tái dùng cho mọi QR. */
  private qrLogoResizedBuf: Buffer | null = null;

  /**
   * LRU cache QR signed token theo ticketId (P3). Token tĩnh đến hết giờ event,
   * verify chỉ dựa sig + ticketId → cache an toàn xuyên batch (đã verify REVIEW).
   */
  private readonly qrTokenCache = new Map<string, string | null>();
  private static readonly QR_TOKEN_CACHE_CAP = 5000;

  constructor(
    private readonly adapter: MailAdapter,
    private readonly content: ContentClientService,
  ) {}

  /** Load template 1 lần + cache. Throw nếu thiếu — không gửi được mail không có template. */
  private getTemplate(): string {
    if (this.template !== null) return this.template;
    try {
      this.template = readFileSync(TEMPLATE_PATH, 'utf8');
    } catch (err) {
      throw new Error(
        `Không đọc được email template tại ${TEMPLATE_PATH}: ${(err as Error).message}. ` +
          `Đảm bảo file tồn tại (hoặc chạy từ repo root).`,
      );
    }
    return this.template;
  }

  /**
   * logoUrl: nếu env BRAND_LOGO_URL set (HTTPS CDN prod) → dùng URL đó (không cần CID).
   * Ngược lại → dùng CID reference, kèm buffer từ file local.
   */
  private resolveLogoUrl(): string {
    if (env.BRAND_LOGO_URL) return env.BRAND_LOGO_URL as string;
    return `cid:${CID_LOGO}`;
  }

  /** noticeIconUrl: nếu env NOTICE_ICON_URL set → dùng URL đó. Ngược lại → CID. */
  private resolveNoticeIconUrl(): string {
    if (env.NOTICE_ICON_URL && !env.NOTICE_ICON_URL.startsWith('https://placehold')) {
      return env.NOTICE_ICON_URL as string;
    }
    return `cid:${CID_NOTICE_ICON}`;
  }

  /** Đọc + cache logo buffer từ img/Logo_xoa_phong 2.png */
  private getLogoBuf(): Buffer | null {
    if (this.logoBuf !== null) return this.logoBuf;
    try {
      this.logoBuf = readFileSync(join(process.cwd(), 'img', 'Logo_xoa_phong 2.png'));
      return this.logoBuf;
    } catch (err) {
      this.logger.warn(`Không đọc được logo: ${(err as Error).message}`);
      return null;
    }
  }

  /** Đọc + cache notice icon buffer từ img/Vector.png */
  private getNoticeIconBuf(): Buffer | null {
    if (this.noticeIconBuf !== null) return this.noticeIconBuf;
    try {
      this.noticeIconBuf = readFileSync(join(process.cwd(), 'img', 'Vector.png'));
      return this.noticeIconBuf;
    } catch (err) {
      this.logger.warn(`Không đọc được notice icon: ${(err as Error).message}`);
      return null;
    }
  }

  private getTimeIconBuf(): Buffer | null {
    if (this.timeIconBuf !== null) return this.timeIconBuf;
    try {
      this.timeIconBuf = readFileSync(join(process.cwd(), 'img', 'clock.png'));
      return this.timeIconBuf;
    } catch (err) {
      this.logger.warn(`Không đọc được time icon: ${(err as Error).message}`);
      return null;
    }
  }

  private getLocationIconBuf(): Buffer | null {
    if (this.locationIconBuf !== null) return this.locationIconBuf;
    try {
      this.locationIconBuf = readFileSync(join(process.cwd(), 'img', 'location.png'));
      return this.locationIconBuf;
    } catch (err) {
      this.logger.warn(`Không đọc được location icon: ${(err as Error).message}`);
      return null;
    }
  }

  private getDownloadIconBuf(): Buffer | null {
    if (this.downloadIconBuf !== null) return this.downloadIconBuf;
    try {
      this.downloadIconBuf = readFileSync(join(process.cwd(), 'img', 'frame.png'));
      return this.downloadIconBuf;
    } catch (err) {
      this.logger.warn(`Không đọc được download icon: ${(err as Error).message}`);
      return null;
    }
  }

  /** Build danh sách CID attachments cho logo + notice icon (nếu dùng CID). */
  private buildCidAttachments(): CidAttachment[] {
    const attachments: CidAttachment[] = [];

    // Logo — chỉ attach nếu không có BRAND_LOGO_URL (tức đang dùng CID)
    if (!env.BRAND_LOGO_URL) {
      const buf = this.getLogoBuf();
      if (buf) {
        attachments.push({
          cid: CID_LOGO,
          filename: 'mayogu-logo.png',
          content: buf,
          contentType: 'image/png',
        });
      }
    }

    // Notice icon — chỉ attach nếu không có NOTICE_ICON_URL hợp lệ
    if (!env.NOTICE_ICON_URL || env.NOTICE_ICON_URL.startsWith('https://placehold')) {
      const buf = this.getNoticeIconBuf();
      if (buf) {
        attachments.push({
          cid: CID_NOTICE_ICON,
          filename: 'notice-icon.png',
          content: buf,
          contentType: 'image/png',
        });
      }
    }

    const timeBuf = this.getTimeIconBuf();
    if (timeBuf) {
      attachments.push({ cid: CID_TIME_ICON, filename: 'clock.png', content: timeBuf, contentType: 'image/png' });
    }
    const locBuf = this.getLocationIconBuf();
    if (locBuf) {
      attachments.push({ cid: CID_LOCATION_ICON, filename: 'location.png', content: locBuf, contentType: 'image/png' });
    }
    const dlBuf = this.getDownloadIconBuf();
    if (dlBuf) {
      attachments.push({ cid: CID_DOWNLOAD_ICON, filename: 'frame.png', content: dlBuf, contentType: 'image/png' });
    }

    return attachments;
  }

  /** Đọc + cache QR logo buffer từ img/avt 2.png */
  private getQrLogoBuf(): Buffer | null {
    if (this.qrLogoBuf !== null) return this.qrLogoBuf;
    try {
      this.qrLogoBuf = readFileSync(join(process.cwd(), 'img', 'avt 2.png'));
      return this.qrLogoBuf;
    } catch (err) {
      this.logger.warn(`Không đọc được QR logo: ${(err as Error).message}`);
      return null;
    }
  }

  /** get LRU: hit → re-insert để đánh dấu recency. Miss → undefined. */
  private qrTokenCacheGet(ticketId: string): string | null | undefined {
    if (!this.qrTokenCache.has(ticketId)) return undefined;
    const v = this.qrTokenCache.get(ticketId) ?? null;
    this.qrTokenCache.delete(ticketId);
    this.qrTokenCache.set(ticketId, v);
    return v;
  }

  /** set LRU: quá cap → evict key cũ nhất (Map giữ thứ tự chèn). */
  private qrTokenCacheSet(ticketId: string, token: string | null): void {
    if (this.qrTokenCache.has(ticketId)) this.qrTokenCache.delete(ticketId);
    this.qrTokenCache.set(ticketId, token);
    if (this.qrTokenCache.size > MailDispatcherService.QR_TOKEN_CACHE_CAP) {
      const oldest = this.qrTokenCache.keys().next().value;
      if (oldest !== undefined) this.qrTokenCache.delete(oldest);
    }
  }

  /** Logo 60×60 resize 1 lần (P5) rồi tái dùng — tránh sharp resize mỗi vé. */
  private async getQrLogoResizedBuf(): Promise<Buffer | null> {
    if (this.qrLogoResizedBuf !== null) return this.qrLogoResizedBuf;
    const logoBuf = this.getQrLogoBuf();
    if (!logoBuf) return null;
    this.qrLogoResizedBuf = await sharp(logoBuf).resize(60, 60).toBuffer();
    return this.qrLogoResizedBuf;
  }

  /**
   * Nội dung QR trên vé = STATIC SIGNED TOKEN từ content-service (offline-checkin
   * v1.1 — getStaticQrToken, self-verifying, exp = hết giờ event; QR TĨNH không
   * phải link web). Chọn: token trong LRU cache (prefetch batch trước loop)
   * → ticketCode → claimUrl. Cache miss / content fail → fallback, KHÔNG fail
   * gửi email/PDF.
   */
  private resolveQrPayload(p: ClaimMailPayload): string {
    if (p.ticketId) {
      const cached = this.qrTokenCacheGet(p.ticketId);
      if (cached) return cached;
    }
    return p.ticketCode || p.claimUrl;
  }

  /** Generate QR code with logo overlaid in the center */
  private async generateQrWithLogo(url: string): Promise<Buffer> {
    const qrBuffer = await QRCode.toBuffer(url, {
      errorCorrectionLevel: 'H',
      margin: 1,
      width: 300,
      color: { dark: '#1e1b2e', light: '#ffffff' },
    });
    const logoResizedBuf = await this.getQrLogoResizedBuf();
    if (!logoResizedBuf) return qrBuffer;

    return await sharp(qrBuffer)
      .composite([
        {
          input: logoResizedBuf,
          gravity: 'center',
        },
      ])
      .png()
      .toBuffer();
  }

  /**
   * Tải ảnh event từ presigned URL (còn tươi lúc phát) để nhúng CID vào email —
   * email đã gửi hiển thị ảnh vĩnh viễn, KHÔNG phụ thuộc URL hết hạn (MinIO
   * S3_LINK_EXPIRY default 2h). Cache theo URL trong 1 đợt (cùng event = cùng ảnh).
   * Lỗi/ảnh quá lớn/không phải image → null (caller fallback banner mặc định).
   */
  private async fetchEventImage(
    url: string,
    cache: Map<string, { mime: string; buf: Buffer } | null>,
  ): Promise<{ mime: string; buf: Buffer } | null> {
    const hit = cache.get(url);
    if (hit !== undefined) return hit === null ? null : { ...hit };
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), EVENT_IMAGE_FETCH_TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetch(url, { signal: controller.signal });
      } finally {
        clearTimeout(timeout);
      }
      if (!res.ok) {
        this.logger.warn(`[MAIL-EVENT-IMG] fetch ${res.status} — fallback banner mặc định`);
        cache.set(url, null);
        return null;
      }
      const mime = res.headers.get('content-type')?.split(';')[0] ?? 'image/jpeg';
      if (!mime.startsWith('image/')) {
        this.logger.warn(`[MAIL-EVENT-IMG] content-type không phải ảnh (${mime}) — bỏ qua`);
        cache.set(url, null);
        return null;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0 || buf.length > MAX_EVENT_IMAGE_BYTES) {
        this.logger.warn(
          `[MAIL-EVENT-IMG] kích thước ${buf.length} B (cap ${MAX_EVENT_IMAGE_BYTES}) — bỏ qua`,
        );
        cache.set(url, null);
        return null;
      }
      const optimized = await this.optimizeEventImage(buf, mime);
      cache.set(url, optimized);
      return { ...optimized };
    } catch (err) {
      this.logger.warn(
        `[MAIL-EVENT-IMG] fetch lỗi: ${(err as Error).message} — fallback banner mặc định`,
      );
      cache.set(url, null);
      return null;
    }
  }

  /**
   * P7: resize + nén ảnh event trước khi nhúng CID. Có cache per-URL trong cả
   * batch (fetchEventImage) nên cùng event chỉ chạy 1 lần. KHÔNG upscale ảnh nhỏ
   * (không thể nét hơn ảnh gốc); nếu nén ra to hơn gốc → giữ nguyên bản.
   */
  private async optimizeEventImage(
    buf: Buffer,
    mime: string,
  ): Promise<{ mime: string; buf: Buffer }> {
    if (mime === 'image/jpeg' && buf.length <= EVENT_IMAGE_OPTIMIZE_IF_BIGGER_THAN_BYTES) {
      return { mime, buf };
    }
    try {
      const base = sharp(buf).rotate();
      const meta = await base.metadata();
      // Ảnh có alpha (vd poster bo góc trong suốt): flatten→JPEG sẽ nung nền
      // trắng vào vùng trong suốt → email hiện viền trắng. Giữ PNG (palette nén).
      const resized = base.resize({
        width: EVENT_IMAGE_EMAIL_MAX_WIDTH,
        withoutEnlargement: true,
      });
      const out = meta.hasAlpha
        ? await resized.png({ palette: true, quality: EVENT_IMAGE_EMAIL_JPEG_QUALITY }).toBuffer()
        : await resized
            .flatten({ background: '#ffffff' })
            .jpeg({ quality: EVENT_IMAGE_EMAIL_JPEG_QUALITY })
            .toBuffer();
      if (out.length >= buf.length) return { mime, buf };
      return { mime: meta.hasAlpha ? 'image/png' : 'image/jpeg', buf: out };
    } catch (err) {
      this.logger.warn(`[MAIL-EVENT-IMG] optimize lỗi: ${(err as Error).message} — dùng ảnh gốc`);
      return { mime, buf };
    }
  }

  async dispatchBatch(
    payloads: ClaimMailPayload[],
  ): Promise<{
    dispatched: number;
    failed: number;
    /** T5 per-email ack (F-05) — index/claimToken bám đúng payload vào; LAZY caller bỏ qua. */
    results: { claimToken: string; ok: boolean }[];
  }> {
    const template = this.getTemplate();
    const cidAttachments = this.buildCidAttachments();
    // Cache ảnh event per-URL trong 1 đợt (cùng event → fetch 1 lần).
    const eventImageCache = new Map<string, { mime: string; buf: Buffer } | null>();
    // Chỉ payload chưa render mới cần QR + ảnh — prefetch đúng phần đó (payload
    // đã có html pre-rendered không đụng content/fetch như trước).
    const toDispatch = payloads.filter((p) => !p.html);

    // P3: prefetch QR signed token theo ticketId — 1 batch call thay N call
    // (chunk ≤500 nội bộ content-client); merge vào LRU cache trước loop.
    const missingTicketIds = [
      ...new Set(toDispatch.map((p) => p.ticketId).filter((id): id is string => !!id)),
    ].filter((id) => !this.qrTokenCache.has(id));
    if (missingTicketIds.length > 0) {
      for (const [id, token] of await this.content.getTicketQrTokens(missingTicketIds)) {
        this.qrTokenCacheSet(id, token);
      }
    }

    // P6: prefetch ảnh event trước loop → payload cùng event không chờ fetch
    // trong loop (fetch lỗi cache null → loop fallback banner như cũ).
    await Promise.all(
      [
        ...new Set(toDispatch.map((p) => p.eventImage).filter((u): u is string => !!u)),
      ].map((u) => this.fetchEventImage(u, eventImageCache)),
    );

    let dispatched = 0;
    let failed = 0;
    const results: { claimToken: string; ok: boolean }[] = [];
    // P2: concurrency giới hạn (4) — QR gen + fetch ảnh + render + send chạy
    // song song; results ghi theo index → thứ tự y hệt payload order.
    await runConcurrent(payloads, MAIL_DISPATCH_CONCURRENCY, async (p, i) => {
      try {
        if (!p.html) {
          // QR: signed static token (content — LRU cache) with logo, attach as CID
          const qrCid = `qr-${p.claimToken}`;
          const qrContent = this.resolveQrPayload(p);
          const qrBuffer = await this.generateQrWithLogo(qrContent);
          const qrUrl = `cid:${qrCid}`;

          const attachments: CidAttachment[] = [
            ...cidAttachments,
            {
              cid: qrCid,
              filename: 'ticket-qr.png',
              content: qrBuffer,
              contentType: 'image/png',
            },
          ];

          // Event banner: fetch presigned ngay lúc phát → nhúng CID để email
          // đã gửi hiển thị ảnh vĩnh viễn (không phụ thuộc URL hết hạn).
          // Lỗi/ảnh quá lớn → fallback banner mặc định (không fail email).
          let bannerUrl = env.DEFAULT_BANNER_URL as string;
          if (p.eventImage) {
            const img = await this.fetchEventImage(p.eventImage, eventImageCache);
            if (img) {
              attachments.push({
                cid: CID_EVENT_BANNER,
                filename: 'event-banner',
                content: img.buf,
                contentType: img.mime,
              });
              bannerUrl = `cid:${CID_EVENT_BANNER}`;
            }
          }

          p.attachments = attachments;
          p.html = renderTicketEmailHtml(template, p, {
            qrUrl,
            bannerUrl,
            noticeIconUrl: this.resolveNoticeIconUrl(),
            logoUrl: this.resolveLogoUrl(),
            supportEmail: env.SUPPORT_EMAIL as string,
            supportPhone: env.SUPPORT_PHONE as string,
            appStoreUrl: env.APP_STORE_URL as string,
            googlePlayUrl: env.GOOGLE_PLAY_URL as string,
            pdfUrl: await this.buildTicketPdfUrl(p, qrContent),
            timeIconUrl: `cid:${CID_TIME_ICON}`,
            locationIconUrl: `cid:${CID_LOCATION_ICON}`,
            downloadIconUrl: `cid:${CID_DOWNLOAD_ICON}`,
          });
        }
        await this.adapter.send(p);
        dispatched++;
        results[i] = { claimToken: p.claimToken, ok: true };
      } catch (err) {
        failed++;
        results[i] = { claimToken: p.claimToken, ok: false };
        this.logger.error(
          `mail send failed job=${p.jobId} token=${p.claimToken}: ${(err as Error).message}`,
        );
      }
    });
    this.logger.log(
      `dispatchBatch done dispatched=${dispatched} failed=${failed} total=${payloads.length}`,
    );
    return { dispatched, failed, results };
  }

  buildClaimUrl(claimToken: string): string {
    return `${env.APP_UNIVERSAL_LINK_BASE}/c/${claimToken}`;
  }

  /**
   * URL "Tải vé PDF" — trỏ THẲNG content-service public (PDF render TẠI
   * CONTENT, verify bằng signed token; ticket-mayo không cần public).
   * qrContent là static signed token (bắt đầu 'ey' base64url JWS) → dùng làm
   * bearer secret + thả name/phone/email/bookedAt qua query để PDF in đúng
   * thông tin người đặt (PII theo yêu cầu, content không lưu — PRD §7.1 D3).
   * Không có ticketId/token (retry job fail, vé chưa mint) → fallback claimUrl.
   */
  buildTicketPdfUrl(p: ClaimMailPayload, qrContent: string): string {
    if (p.ticketId && qrContent.startsWith('ey')) {
      const base = (env.CONTENT_PUBLIC_BASE_URL ?? '').trim();
      if (base !== '') {
        const params = new URLSearchParams({ token: qrContent });
        if (p.customerName) params.set('name', p.customerName);
        if (p.customerPhone) params.set('phone', p.customerPhone);
        if (p.email) params.set('email', p.email);
        if (p.bookedAt) params.set('bookedAt', p.bookedAt);
        return `${base.replace(/\/+$/, '')}/content-service/tickets/${encodeURIComponent(p.ticketId)}/pdf?${params.toString()}`;
      }
    }
    return p.claimUrl;
  }
}
