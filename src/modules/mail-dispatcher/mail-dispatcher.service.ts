import { Injectable, Logger, Optional } from '@nestjs/common';
import { env } from '../../config/env';
import { generateEmailHash } from '../../common/utils/email-hash.util';
import { ContentClientService } from '../content-client/content-client.service';
import { TicketPdfStorageService } from '../ticket-pdf-storage/ticket-pdf-storage.service';
import { ClaimMailPayload, MailAdapter, PdfAttachment } from './mail.adapter';
import { renderTicketEmailHtml } from './ticket-email-html.renderer';
import { renderTicketEmailText } from './ticket-email-text.renderer';

/** Số email xử lý đồng thời trong 1 đợt (P2 — tránh dồn CPU render PDF + SMTP). */
const MAIL_DISPATCH_CONCURRENCY = 4;

/** LRU cache QR signed token theo ticketId. Token tĩnh đến hết giờ event,
 * verify chỉ dựa sig + ticketId → cache an toàn xuyên batch. */
const QR_TOKEN_CACHE_CAP = 5000;

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
 * Dispatches ticket emails — PLAIN TEXT + PDF ĐÍNH KÈM (kiểu boarding-pass
 * sân bay). PDF được render TẠI ticket-mayo từ trước rồi mới đính kèm;
 * 1 người nhận quantity vé → 1 email gộp quantity PDF.
 *
 * Adapter (console | kafka | smtp) chọn lúc module wiring theo
 * `env.MAIL_TRANSPORT`.
 */
@Injectable()
export class MailDispatcherService {
  private readonly logger = new Logger(MailDispatcherService.name);

  private readonly qrTokenCache = new Map<string, string | null>();

  constructor(
    private readonly adapter: MailAdapter,
    private readonly content: ContentClientService,
    // Tùy chọn — spec cũ vẫn new 2 tham số. Thiếu/là undefined → không render PDF.
    @Optional() private readonly pdfStorage?: TicketPdfStorageService,
  ) {}

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
    if (this.qrTokenCache.size > QR_TOKEN_CACHE_CAP) {
      const oldest = this.qrTokenCache.keys().next().value;
      if (oldest !== undefined) this.qrTokenCache.delete(oldest);
    }
  }

  /**
   * Nội dung QR trên vé = STATIC SIGNED TOKEN từ content-service
   * (offline-checkin v1.1 — self-verifying, exp = hết giờ event). Cache miss /
   * content fail → fallback ticketCode, KHÔNG fail gửi email/PDF.
   */
  private resolveQrPayload(p: ClaimMailPayload): string {
    if (p.ticketId) {
      const cached = this.qrTokenCacheGet(p.ticketId);
      if (cached) return cached;
    }
    return p.ticketCode || p.claimUrl;
  }

  /**
   * Render PDF 1 vé (đính kèm email) + upload lên bucket email/ (cho zip tải
   * PDF về sau) — fail-soft: lỗi render/upload log warn và trả null (email
   * vẫn gửi, thiếu PDF vé đó).
   */
  private async renderTicketPdfAttachment(
    p: ClaimMailPayload,
    qrContent: string,
  ): Promise<PdfAttachment | null> {
    if (!this.pdfStorage || !p.ticketId || !qrContent.startsWith('ey')) return null;
    try {
      const buf = await this.pdfStorage.renderTicketPdfForEmail({
        jobId: p.jobId,
        ticketId: p.ticketId,
        qrToken: qrContent,
        ticketCode: p.ticketCode,
        attendee: {
          name: p.customerName,
          phone: p.customerPhone,
          email: p.email,
          bookedAt: p.bookedAt,
        },
      });
      if (!buf) return null;
      // Archive sau khi render ok — lỗi upload KHÔNG làm fail đính kèm.
      void this.pdfStorage.uploadEmailPdf(p.jobId, p.ticketId, buf).catch(() => undefined);
      return {
        filename: `VE-${(p.ticketCode || p.claimToken.slice(-8)).toUpperCase()}.pdf`,
        content: buf,
        contentType: 'application/pdf',
      };
    } catch (err) {
      this.logger.warn(
        `[MAIL-PDF] render lỗi ticket=${p.ticketId} job=${p.jobId}: ${(err as Error).message}`,
      );
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
    /** Nội dung email ĐÃ gửi thành công (1 mục/nhóm email) — caller lưu để admin xem lại. */
    sentEmails: {
      jobId: string;
      emailHash: string;
      text: string;
      html: string;
      /** PDF vé đính kèm đã gửi (ticketId → key S3 email/<jobId>/<ticketId>.pdf). */
      attachments: { ticketId: string; filename: string }[];
    }[];
  }> {
    // P3: prefetch QR signed token theo ticketId — 1 batch call thay N call
    // (chunk ≤500 nội bộ content-client); merge vào LRU cache trước loop.
    const missingTicketIds = [
      ...new Set(payloads.map((p) => p.ticketId).filter((id): id is string => !!id)),
    ].filter((id) => !this.qrTokenCache.has(id));
    if (missingTicketIds.length > 0) {
      try {
        for (const [id, token] of await this.content.getTicketQrTokens(missingTicketIds)) {
          this.qrTokenCacheSet(id, token);
        }
      } catch (err) {
        this.logger.warn(
          `[MAIL-QR] prefetch token fail: ${(err as Error).message} — fallback ticketCode.`,
        );
      }
    }

    // Gộp vé theo email — 1 người quantity vé → 1 email gộp quantity PDF.
    const groups = new Map<string, { email: string; items: ClaimMailPayload[] }>();
    for (const p of payloads) {
      let g = groups.get(p.email);
      if (!g) {
        g = { email: p.email, items: [] };
        groups.set(p.email, g);
      }
      g.items.push(p);
    }
    const groupList = [...groups.values()];

    let dispatched = 0;
    let failed = 0;
    const results: { claimToken: string; ok: boolean }[] = [];
    const sentEmails: {
      jobId: string;
      emailHash: string;
      text: string;
      html: string;
      attachments: { ticketId: string; filename: string }[];
    }[] = [];
    await runConcurrent(groupList, MAIL_DISPATCH_CONCURRENCY, async (g) => {
      try {
        // Render PDF MỌI vé của nhóm trước khi gửi — email chứa đầy đủ PDF.
        const attachments: PdfAttachment[] = [];
        const attachmentMeta: { ticketId: string; filename: string }[] = [];
        const tokens: { payload: ClaimMailPayload; qrContent: string }[] = [];
        for (const p of g.items) {
          const qrContent = this.resolveQrPayload(p);
          tokens.push({ payload: p, qrContent });
          const att = await this.renderTicketPdfAttachment(p, qrContent);
          if (att) {
            attachments.push(att);
            if (p.ticketId) attachmentMeta.push({ ticketId: p.ticketId, filename: att.filename });
          }
        }

        // Dùng payload vé ĐẦU làm đại diện cho thông tin event của email.
        const first = g.items[0];
        const payload: ClaimMailPayload = { ...first };
        payload.ticketCount = g.items.length;
        payload.text = renderTicketEmailText(payload);
        payload.html = renderTicketEmailHtml(payload);
        payload.attachments = attachments;

        await this.adapter.send(payload);
        dispatched++;
        sentEmails.push({
          jobId: first.jobId,
          emailHash: generateEmailHash(g.email),
          text: payload.text ?? '',
          html: payload.html ?? '',
          attachments: attachmentMeta,
        });
        for (const p of g.items) {
          results.push({ claimToken: p.claimToken, ok: true });
        }
      } catch (err) {
        failed++;
        const first = g.items[0];
        this.logger.error(
          `mail send failed job=${first.jobId} token=${first.claimToken}: ${(err as Error).message}`,
        );
        for (const p of g.items) {
          results.push({ claimToken: p.claimToken, ok: false });
        }
      }
    });
    this.logger.log(
      `dispatchBatch done dispatched=${dispatched} failed=${failed} emails=${groupList.length} tickets=${payloads.length}`,
    );
    return { dispatched, failed, results, sentEmails };
  }

  /** Gửi lại từng vé riêng (dùng khi caller không gộp nhóm — vd kiểm thử). */
  buildClaimUrl(claimToken: string): string {
    return `${env.APP_UNIVERSAL_LINK_BASE}/c/${claimToken}`;
  }
}
