import { Injectable, Logger } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import QRCode from 'qrcode';
import sharp from 'sharp';
import { env, NodeEnv } from '../../config/env';
import { ContentClientService } from '../content-client/content-client.service';
import { CidAttachment, ClaimMailPayload, MailAdapter } from './mail.adapter';
import { renderTicketEmailHtml, TicketEmailBrandContext } from './ticket-email.renderer';

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

  /** Banner gradient fallback cho PDF (render 1 lần qua sharp rồi cache). */
  private defaultBannerDataUriCache: string | null = null;

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

  /**
   * Nội dung QR trên vé = STATIC SIGNED TOKEN từ content-service (offline-checkin
   * v1.1 — getStaticQrToken, self-verifying, exp = hết giờ event; QR TĨNH không
   * phải link web). Chọn: content token (qua ticketId) → ticketCode → claimUrl.
   * Lỗi content → fallback, KHÔNG fail gửi email/PDF.
   */
  private async resolveQrPayload(p: ClaimMailPayload): Promise<string> {
    if (p.ticketId) {
      const token = await this.content.getTicketQrToken(p.ticketId);
      if (token) return token;
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
    const logoBuf = this.getQrLogoBuf();
    if (!logoBuf) return qrBuffer;

    return await sharp(qrBuffer)
      .composite([
        {
          input: await sharp(logoBuf).resize(60, 60).toBuffer(),
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
      const entry = { mime, buf };
      cache.set(url, entry);
      return { ...entry };
    } catch (err) {
      this.logger.warn(
        `[MAIL-EVENT-IMG] fetch lỗi: ${(err as Error).message} — fallback banner mặc định`,
      );
      cache.set(url, null);
      return null;
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
    let dispatched = 0;
    let failed = 0;
    const results: { claimToken: string; ok: boolean }[] = [];
    for (const p of payloads) {
      try {
        if (!p.html) {
          // QR: signed static token (content) with logo, attach as CID
          const qrCid = `qr-${p.claimToken}`;
          const qrBuffer = await this.generateQrWithLogo(await this.resolveQrPayload(p));
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
            pdfUrl: this.buildTicketPdfUrl(p.claimToken),
            timeIconUrl: `cid:${CID_TIME_ICON}`,
            locationIconUrl: `cid:${CID_LOCATION_ICON}`,
            downloadIconUrl: `cid:${CID_DOWNLOAD_ICON}`,
          });
        }
        await this.adapter.send(p);
        dispatched++;
        results.push({ claimToken: p.claimToken, ok: true });
      } catch (err) {
        failed++;
        results.push({ claimToken: p.claimToken, ok: false });
        this.logger.error(
          `mail send failed job=${p.jobId} token=${p.claimToken}: ${(err as Error).message}`,
        );
      }
    }
    this.logger.log(
      `dispatchBatch done dispatched=${dispatched} failed=${failed} total=${payloads.length}`,
    );
    return { dispatched, failed, results };
  }

  buildClaimUrl(claimToken: string): string {
    return `${env.APP_UNIVERSAL_LINK_BASE}/c/${claimToken}`;
  }

  /**
   * URL endpoint sinh PDF vé (nút "Tải vé PDF" trong email). Base = env
   * TICKET_MAYO_BASE_URL (public) → dev: localhost backend → PUBLIC_BASE_URL.
   */
  buildTicketPdfUrl(claimToken: string): string {
    const raw = (env.TICKET_MAYO_BASE_URL ?? '').trim();
    const base =
      raw !== ''
        ? raw
        : env.NODE_ENV === NodeEnv.Development
          ? `http://localhost:${env.PORT}`
          : env.PUBLIC_BASE_URL;
    return `${base.replace(/\/+$/, '')}/ticket-mayo/tickets/pdf/${claimToken}`;
  }

  private static toDataUri(buf: Buffer, mime: string): string {
    return `data:${mime};base64,${buf.toString('base64')}`;
  }

  /** Banner mặc định (gradient) cho PDF — tạo 1 lần qua sharp, base64 cache. */
  private async defaultBannerDataUri(): Promise<string> {
    if (this.defaultBannerDataUriCache !== null) return this.defaultBannerDataUriCache;
    const svg =
      '<svg width="600" height="313" xmlns="http://www.w3.org/2000/svg">' +
      '<rect width="600" height="313" fill="#1e1b2e"/>' +
      '<circle cx="490" cy="90" r="100" fill="#8b5cf6" opacity="0.55"/>' +
      '<circle cx="90" cy="280" r="70" fill="#4f46e5" opacity="0.4"/>' +
      '<text x="40" y="175" font-family="Segoe UI, Arial, sans-serif" font-size="36" font-weight="700" fill="#ffffff">MAYogu</text>' +
      '<text x="40" y="215" font-family="Segoe UI, Arial, sans-serif" font-size="18" fill="#c7cbe2">Vé điện tử sự kiện</text>' +
      '</svg>';
    const png = await sharp({
      create: { width: 600, height: 313, channels: 3, background: { r: 30, g: 27, b: 46 } },
    })
      .composite([{ input: Buffer.from(svg) }])
      .jpeg({ quality: 88 })
      .toBuffer();
    this.defaultBannerDataUriCache = MailDispatcherService.toDataUri(png, 'image/jpeg');
    return this.defaultBannerDataUriCache;
  }

  /**
   * HTML standalone của đúng template email (BẢN PDF) — mọi ảnh là data-URI
   * (CID không hiển thị được ngoài email client): QR + banner (fetch mới; presigned
   * trả lại tươi từ content-service) + logo/notice icon. Dùng cho endpoint
   * "Tải vé PDF" trong email — PDF là bản PDF-giống-hệt template gửi.
   */
  async buildPdfHtml(p: ClaimMailPayload): Promise<string> {
    const template = this.getTemplate();
    // PDF dùng QR signed static token (giống email) — scan trả về credential vé.
    const qrBuffer = await this.generateQrWithLogo(await this.resolveQrPayload(p));
    const banner = p.eventImage ? await this.fetchEventImage(p.eventImage, new Map()) : null;
    const bannerUri = banner
      ? MailDispatcherService.toDataUri(banner.buf, banner.mime)
      : await this.defaultBannerDataUri();

    const logoUri = this.resolveEnvOrDataUri(
      env.BRAND_LOGO_URL ?? '',
      this.getLogoBuf(),
      'image/png',
    );
    const noticeRaw = (env.NOTICE_ICON_URL ?? '').startsWith('https://placehold')
      ? ''
      : (env.NOTICE_ICON_URL ?? '');
    const noticeUri = this.resolveEnvOrDataUri(noticeRaw, this.getNoticeIconBuf(), 'image/png');

    const timeUri = this.resolveEnvOrDataUri('', this.getTimeIconBuf(), 'image/png');
    const locationUri = this.resolveEnvOrDataUri('', this.getLocationIconBuf(), 'image/png');
    const downloadUri = this.resolveEnvOrDataUri('', this.getDownloadIconBuf(), 'image/png');

    return renderTicketEmailHtml(
      template,
      p,
      {
        qrUrl: MailDispatcherService.toDataUri(qrBuffer, 'image/png'),
        bannerUrl: bannerUri,
        noticeIconUrl: noticeUri,
        logoUrl: logoUri,
        supportEmail: env.SUPPORT_EMAIL as string,
        supportPhone: env.SUPPORT_PHONE as string,
        appStoreUrl: env.APP_STORE_URL as string,
        googlePlayUrl: env.GOOGLE_PLAY_URL as string,
        pdfUrl: this.buildTicketPdfUrl(p.claimToken),
        timeIconUrl: timeUri,
        locationIconUrl: locationUri,
        downloadIconUrl: downloadUri,
      } satisfies TicketEmailBrandContext,
    );
  }

  /** Env URL set → dùng luôn (CDN prod). Chưa có → data-URI từ buffer local; trống → 1px (tránh ảnh gãy). */
  private resolveEnvOrDataUri(envUrl: string, buf: Buffer | null, mime: string): string {
    if (envUrl.trim() !== '') return envUrl;
    if (buf) return MailDispatcherService.toDataUri(buf, mime);
    return 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  }
}
