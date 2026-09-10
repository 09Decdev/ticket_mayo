import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  BucketAlreadyExists,
  BucketAlreadyOwnedByYou,
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import archiver from 'archiver';
import { env } from '../../config/env';
import { PrismaService } from '../../prisma/prisma.service';
import { ContentClientService } from '../content-client/content-client.service';
import { TicketPdfService } from './ticket-pdf.service';

/** 1 file trong zip tải hàng loạt: key S3 + tên hiển thị trong folder zip. */
export interface ZipEntry {
  key: string;
  name: string;
}

/**
 * Event + loại vé data để render PDF — resolve 1 lần theo jobId rồi tái dùng
 * cho mọi vé trong job (banner cache theo URL, gọi 1 lần).
 */
interface EventRenderContext {
  eventTitle: string;
  startTime: Date | null;
  address: string | null;
  city: string | null;
  ticketTypeName: string;
  eventImageUrl: string | null;
}

/** Một vé PDF cần lưu lên SeaweedFS (luồng bắn email). */
export interface ArchiveTicketPdfInput {
  jobId: string;
  ticketId: string;
  /** Static signed QR token — nội dung QR in trên PDF (offline check-in). */
  qrToken: string;
  /** Mã vé THẬT (bảng Ticket của content) — hiển thị dưới QR. */
  ticketCode?: string | null;
  /** PII in trên PDF (name/phone/email/bookedAt) — từ payload mail. */
  attendee?: { name?: string | null; phone?: string | null; email?: string | null; bookedAt?: string | null };
}

/** Fetch banner ảnh event quá time này → dùng gradient fallback. */
const BANNER_FETCH_TIMEOUT_MS = 10_000;
/** Ảnh banner > 3MB → bỏ (tránh render PDF nặng vì nhúng ảnh lớn). */
const MAX_BANNER_BYTES = 3 * 1024 * 1024;

/**
 * Lưu PDF vé phát qua email lên bucket SeaweedFS (S3-compatible, cùng hạ tầng
 * upload-service dùng). Bucket PRIVATE vì PDF chứa PII người nhận — chỉ nội bộ
 * đọc được (attach vào email / presigned sau này).
 *
 * Fail-soft toàn bộ: S3 cấu hình thiếu / server chết / fetch PDF lỗi → log
 * warn, KHÔNG BAO GIỜ làm fail luồng gửi email.
 */
@Injectable()
export class TicketPdfStorageService implements OnModuleInit {
  private readonly logger = new Logger(TicketPdfStorageService.name);
  private s3: S3Client | null = null;
  private readonly renderer: TicketPdfService;
  private readonly content: ContentClientService;
  private readonly prisma: PrismaService;
  /** EventRenderContext theo jobId — 1 job chỉ resolve 1 lần (job = 1 loại vé). */
  private readonly eventCtxCache = new Map<string, Promise<EventRenderContext | null>>();
  /** Banner buffer theo URL — cùng event fetch 1 lần, fail cache null. */
  private readonly bannerCache = new Map<string, Promise<Buffer | null>>();

  constructor(renderer: TicketPdfService, content: ContentClientService, prisma: PrismaService) {
    this.renderer = renderer;
    this.content = content;
    this.prisma = prisma;
  }

  get enabled(): boolean {
    return !!(env.S3_ENDPOINT && env.S3_ACCESS_KEY && env.S3_SECRET_KEY);
  }

  get bucket(): string {
    return env.S3_TICKET_PDF_BUCKET ?? 'ticket-email-pdfs';
  }

  private getClient(): S3Client {
    if (this.s3) return this.s3;
    // localhost→127.0.0.1: S3 của SeaweedFS chỉ listen IPv4 (như upload-service).
    let endpoint = env.S3_ENDPOINT as string;
    endpoint = endpoint.replace(/^http:\/\/localhost/, 'http://127.0.0.1');
    this.s3 = new S3Client({
      region: 'us-east-1',
      endpoint,
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY as string,
        secretAccessKey: env.S3_SECRET_KEY as string,
      },
      forcePathStyle: true,
    });
    return this.s3;
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.logger.log('[TICKET-PDF-S3] chưa cấu hình S3_* → lưu PDF vé vào bucket TẮT.');
      return;
    }
    try {
      await this.ensureBucket();
      this.logger.log(`[TICKET-PDF-S3] bucket sẵn sàng: ${this.bucket}`);
    } catch (err) {
      // Không throw — ticket-mayo phải boot được khi SeaweedFS chưa chạy.
      this.logger.warn(
        `[TICKET-PDF-S3] ensureBucket(${this.bucket}) lỗi: ${(err as Error).message} — sẽ thử lại khi có upload.`,
      );
    }
  }

  /** Idempotent: HeadBucket → CreateBucket nếu chưa có (pattern upload-service). */
  async ensureBucket(): Promise<void> {
    const client = this.getClient();
    const name = this.bucket;
    try {
      await client.send(new HeadBucketCommand({ Bucket: name }));
      return;
    } catch {
      // chưa có → create
    }
    try {
      await client.send(new CreateBucketCommand({ Bucket: name }));
      this.logger.log(`[TICKET-PDF-S3] đã tạo bucket ${name} (private — không set public policy)`);
    } catch (err) {
      if (err instanceof BucketAlreadyExists || err instanceof BucketAlreadyOwnedByYou) return;
      throw err;
    }
  }

  /** Key chuẩn cho vé luồng email: email/<jobId>/<ticketId>.pdf */
  buildEmailKey(input: Pick<ArchiveTicketPdfInput, 'jobId' | 'ticketId'>): string {
    return `email/${encodeURIComponent(input.jobId)}/${encodeURIComponent(input.ticketId)}.pdf`;
  }

  /**
   * VÉ CỨNG: key riêng print/<jobId>/<ticketId>.pdf — tách bạch khỏi prefix
   * `email/` để zip "tải vé in" chỉ gom đúng vé không người nhận, không bao giờ
   * trộn lẫn PDF PII của luồng email (Phần 2 đổi email sang plain-text + PDF
   * đính kèm vẫn tái dùng prefix email/ không xung đột).
   */
  buildPrintKey(input: Pick<ArchiveTicketPdfInput, 'jobId' | 'ticketId'>): string {
    return `print/${encodeURIComponent(input.jobId)}/${encodeURIComponent(input.ticketId)}.pdf`;
  }

  /**
   * VÉ CỨNG: render PDF 1 vé in (họ tên = "Vé nhà tài trợ") — PII khác để
   * trống (phone/email/bookedAt KHÔNG truyền → renderer in "—") đúng yêu cầu
   * vé in. Return buffer để caller quyết định upload/thu thập lỗi — không
   * fail-soft ở đây vì luồng print CẦN biết vé nào thiếu PDF (fail-soft sẽ để
   * zip thiếu file âm thầm).
   */
  async fetchPrintTicketPdf(
    input: Pick<ArchiveTicketPdfInput, 'jobId' | 'ticketId' | 'qrToken' | 'ticketCode'>,
  ): Promise<Buffer> {
    return this.renderLocalPdf({ ...input, attendee: { name: 'Vé nhà tài trợ' } });
  }

  /**
   * VÉ EMAIL (Phần 2): render PDF 1 vé kèm PII người nhận — buffer trả về
   * để MailDispatcherService ĐÍNH KÈM email (nội dung y hệt renderLocalPdf
   * của luồng in). Fail-soft: lỗi render chỉ log warn, trả null — email
   * vẫn gửi (thiếu PDF vé đó).
   */
  async renderTicketPdfForEmail(
    input: Pick<ArchiveTicketPdfInput, 'jobId' | 'ticketId' | 'qrToken' | 'ticketCode'> & {
      attendee?: ArchiveTicketPdfInput['attendee'];
    },
  ): Promise<Buffer | null> {
    try {
      return await this.renderLocalPdf(input);
    } catch (err) {
      this.logger.warn(
        `[TICKET-PDF] render email lỗi ticket=${input.ticketId} job=${input.jobId}: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Lưu PDF đã render (đính kèm email) lên key email/ — để zip tải PDF về sau
   * đọc được. Fail-soft: lỗi upload chỉ log warn, không ảnh hưởng luồng email.
   */
  async uploadEmailPdf(jobId: string, ticketId: string, buffer: Buffer): Promise<void> {
    try {
      if (!this.enabled) return;
      await this.uploadPdf(this.buildEmailKey({ jobId, ticketId }), buffer);
    } catch (err) {
      this.logger.warn(
        `[TICKET-PDF-S3] upload email PDF lỗi ticket=${ticketId} job=${jobId}: ${(err as Error).message}`,
      );
    }
  }

  /** Upload buffer thẳng lên bucket (dùng cho PDF nhà tài trợ render sẵn — bước sau). */
  async uploadPdf(key: string, buffer: Buffer): Promise<void> {
    await this.getClient().send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: buffer,
        ContentType: 'application/pdf',
      }),
    );
  }

  /** Đọc 1 object từ bucket. Không tồn tại/lỗi → null (caller tự bỏ qua). */
  async getBuffer(key: string): Promise<Buffer | null> {
    if (!this.enabled) return null;
    try {
      const res = await this.getClient().send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return Buffer.from(await res.Body!.transformToByteArray());
    } catch (err) {
      if (err instanceof NoSuchKey) return null;
      this.logger.warn(`[TICKET-PDF-S3] getBuffer(${key}) lỗi: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Gói nhiều PDF trong bucket thành 1 zip STREAM ra `out` (HTTP res / file),
   * mọi file nằm trong folder `folder` bên trong zip → unzip ra đúng 1 folder.
   * Fetch S3 trước theo cửa sổ 8 (prefetch song song) nhưng append THEO THỨ TỰ
   * entries. PDF đã nén sẵn → zip level 0 (STORE), tiết kiệm CPU.
   * key không tồn tại → bỏ vào missing[], không fail cả zip.
   */
  async writeZip(
    entries: ZipEntry[],
    folder: string,
    out: NodeJS.WritableStream,
  ): Promise<{ added: number; missing: string[] }> {
    // archiver v7 CJS — v8 là ESM-only, Jest (toolchain CJS) không parse được.
    const archive = archiver('zip', { zlib: { level: 0 } });
    const finished = new Promise<void>((resolve, reject) => {
      archive.on('warning', (w: archiver.ArchiverError) => this.logger.warn(`[TICKET-PDF-ZIP] ${w.message}`));
      archive.on('error', reject);
      archive.on('close', () => resolve());
    });
    archive.pipe(out);

    const WINDOW = 8;
    const inflight = new Map<number, Promise<Buffer | null>>();
    let started = 0;
    const fillWindow = () => {
      while (inflight.size < WINDOW && started < entries.length) {
        const i = started++;
        inflight.set(i, this.getBuffer(entries[i].key));
      }
    };
    fillWindow();

    let added = 0;
    const missing: string[] = [];
    for (let i = 0; i < entries.length; i++) {
      const buf = (await inflight.get(i)!) ?? null;
      inflight.delete(i);
      fillWindow();
      if (buf) {
        added++;
        // append trả chính instance (chainable) — backpressure lo bên trong
        // transform pipeline, không cần check thêm.
        archive.append(buf, { name: `${folder}/${entries[i].name}` });
      } else {
        missing.push(entries[i].name);
      }
    }
    if (missing.length > 0) {
      // Admin cần biết vé nào chưa có PDF trong bucket (job cũ trước khi bật S3_*).
      const note = Buffer.from(
        `Các vé sau KHÔNG có PDF trong bucket (bỏ qua khi gói zip):\n${missing.join('\n')}\n`,
        'utf8',
      );
      archive.append(note, { name: `${folder}/_THIEU_PDF.txt` });
    }
    await archive.finalize();
    await finished;
    return { added, missing };
  }

  /**
   * Render PDF vé TẠI ticket-mayo (không còn call content): resolve event ctx
   * theo jobId (1 lần/job) → banner ảnh (cache theo URL) → renderer. Thiếu
   * event ctx (job cũ/event bị xóa) → vẫn render với tên job snapshot.
   */
  private async renderLocalPdf(input: ArchiveTicketPdfInput): Promise<Buffer> {
    const ctx = await this.resolveEventContext(input.jobId);
    let backgroundBuffer: Buffer | null = null;
    if (ctx?.eventImageUrl) {
      backgroundBuffer = await this.fetchBanner(ctx.eventImageUrl);
    }
    return this.renderer.renderTicketPdf({
      eventTitle: ctx?.eventTitle || '',
      startTime: ctx?.startTime ?? new Date(),
      address: ctx?.address ?? null,
      city: ctx?.city ?? null,
      ticketTypeName: ctx?.ticketTypeName || '',
      ticketCode: input.ticketCode || input.ticketId,
      attendee: input.attendee ?? null,
      backgroundBuffer,
      supportEmail: env.SUPPORT_EMAIL,
      supportPhone: env.SUPPORT_PHONE,
      token: input.qrToken,
    });
  }

  /**
   * Event ctx theo jobId — DistributionJob.ticketTypeId → raw getTicketType
   * (event kèm startTime/address/city/eventImageUrl). Cache Promise để job
   * 200 vé chỉ gọi content 1 lần kể cả khi các render chạy song song.
   * Lỗi content → null (render vẫn chạy với job snapshot).
   */
  private resolveEventContext(jobId: string): Promise<EventRenderContext | null> {
    let p = this.eventCtxCache.get(jobId);
    if (!p) {
      p = (async () => {
        const job = await this.prisma.distributionJob.findUnique({
          where: { id: jobId },
          select: { ticketTypeId: true, ticketTypeName: true, eventName: true },
        });
        if (!job) return null;
        let raw: Record<string, any> | null = null;
        try {
          raw = await this.content.getTicketType(job.ticketTypeId);
        } catch (err) {
          this.logger.warn(
            `[TICKET-PDF] getTicketType(${job.ticketTypeId}) lỗi: ${(err as Error).message} — render theo job snapshot.`,
          );
        }
        const ev = raw?.event ?? null;
        return {
          eventTitle: ev?.title ?? job.eventName,
          startTime: ev?.startTime ? new Date(ev.startTime) : null,
          address: ev?.address ?? null,
          city: (ev as { city?: string } | null)?.city ?? null,
          ticketTypeName: raw?.name ?? job.ticketTypeName,
          eventImageUrl: ev?.eventImageUrl ?? null,
        };
      })();
      this.eventCtxCache.set(jobId, p);
      // Job cũ tích lũy vô hạn → cap đơn giản: giữ 100 job gần nhất.
      if (this.eventCtxCache.size > 100) {
        const oldest = this.eventCtxCache.keys().next().value;
        if (oldest !== undefined) this.eventCtxCache.delete(oldest);
      }
    }
    return p;
  }

  /**
   * Banner ảnh event → buffer (cache theo URL, fail cache null → gradient
   * fallback trong renderer). Mirror fetchEventImage của mail-dispatcher.
   */
  private fetchBanner(url: string): Promise<Buffer | null> {
    let p = this.bannerCache.get(url);
    if (!p) {
      p = (async () => {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), BANNER_FETCH_TIMEOUT_MS);
          let res: Response;
          try {
            res = await fetch(url, { signal: controller.signal });
          } finally {
            clearTimeout(timeout);
          }
          if (!res.ok) return null;
          const mime = res.headers.get('content-type')?.split(';')[0] ?? '';
          if (!mime.startsWith('image/')) return null;
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length === 0 || buf.length > MAX_BANNER_BYTES) return null;
          return buf;
        } catch {
          return null;
        }
      })();
      this.bannerCache.set(url, p);
      // Cap 50 URL — mỗi URL chỉ fetch 1 lần nên giới hạn đơn giản là đủ.
      if (this.bannerCache.size > 50) {
        const oldest = this.bannerCache.keys().next().value;
        if (oldest !== undefined) this.bannerCache.delete(oldest);
      }
    }
    return p;
  }
}
