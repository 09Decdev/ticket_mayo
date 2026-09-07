import { env } from '../../config/env';
import {
  ArchiveTicketPdfInput,
} from '../ticket-pdf-storage/ticket-pdf-storage.service';
import { MailDispatcherService } from './mail-dispatcher.service';
import { ClaimMailPayload } from './mail.adapter';
import sharp from 'sharp';

const DEFAULT_BANNER = 'https://placehold.co/600x313/1e1b2e/8b5cf6.png?text=MAYogu+Event';

function makePayload(overrides: Partial<ClaimMailPayload> = {}): ClaimMailPayload {
  return {
    jobId: 'job-1',
    email: 'user@example.com',
    claimToken: 'tok-1',
    claimUrl: 'http://localhost:5174/c/tok-1',
    ticketTypeName: 'Vé VIP',
    eventName: 'Sự kiện test',
    ...overrides,
  };
}

/**
 * CID event banner — ảnh event nhúng inline để email đã gửi hiển thị vĩnh viễn,
 * không phụ thuộc presigned URL hết hạn (MinIO S3_LINK_EXPIRY default 2h).
 * Fallback an toàn: fetch lỗi / ảnh to / không phải image → banner mặc định,
 * KHÔNG fail email.
 */
describe('MailDispatcherService — event banner CID inline', () => {
  let service: MailDispatcherService;
  let fetchMock: jest.Mock;
  let sendMock: jest.Mock;
  let tokenMock: jest.Mock;
  const EVENT_URL = 'https://minio.local/event.jpg?X-Amz-Expires=7200';

  function makeService() {
    const service = new MailDispatcherService(
      { send: sendMock } as never,
      { getTicketQrTokens: tokenMock } as never,
    );
    // Template giả — không phụ thuộc file trên disk.
    (service as unknown as { getTemplate: () => string }).getTemplate = () =>
      '<html><body><img src="{{bannerUrl}}"></body></html>';
    // QR giả — tránh sharp nặng.
    (service as unknown as { generateQrWithLogo: () => Promise<Buffer> }).generateQrWithLogo =
      jest.fn(async () => Buffer.from('fake-qr'));
    return service;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    fetchMock = jest.fn();
    (globalThis as { fetch: unknown }).fetch = fetchMock;
    sendMock = jest.fn(async () => {
      /* adapter no-op */
    });
    tokenMock = jest.fn(async () => new Map()); // batch mặc định: không có token nào
    service = makeService();
  });

  afterEach(() => {
    delete (globalThis as { fetch?: unknown }).fetch;
  });

  it('có eventImage → fetch 1 lần (cache per-URL), attach CID + bannerUrl= cid:', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      headers: { get: () => 'image/jpeg' },
      arrayBuffer: async () => new ArrayBuffer(8),
    });

    const res = await service.dispatchBatch([
      makePayload({ claimToken: 'tok-1', eventImage: EVENT_URL }),
      makePayload({ claimToken: 'tok-2', eventImage: EVENT_URL }),
    ]);

    expect(res.dispatched).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(1); // cache: cùng URL fetch 1 lần
    const sent = sendMock.mock.calls.map(([p]: [ClaimMailPayload]) => p);
    for (const p of sent) {
      const banner = p.attachments?.find((a) => a.cid === 'event-banner@ticket');
      expect(banner).toBeDefined();
      expect(banner?.contentType).toBe('image/jpeg');
      expect(p.html).toContain('src="cid:event-banner@ticket"');
      expect(p.html).not.toContain(EVENT_URL); // KHÔNG nhúng presigned URL
    }
  });

  it('fetch thất bại (403 — presigned hết hạn) → fallback banner mặc định, VẪN gửi', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403, headers: { get: () => '' } });

    const res = await service.dispatchBatch([makePayload({ eventImage: EVENT_URL })]);

    expect(res.dispatched).toBe(1);
    expect(res.failed).toBe(0);
    const p = sendMock.mock.calls[0][0] as ClaimMailPayload;
    expect(p.html).toContain(`src="${DEFAULT_BANNER}"`);
    expect(p.attachments?.some((a) => a.cid === 'event-banner@ticket')).toBe(false);
  });

  it('content-type không phải ảnh → bỏ qua (không attach, không fail)', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      headers: { get: () => 'text/html' },
      arrayBuffer: async () => new ArrayBuffer(8),
    });

    const res = await service.dispatchBatch([makePayload({ eventImage: EVENT_URL })]);

    expect(res.dispatched).toBe(1);
    const p = sendMock.mock.calls[0][0] as ClaimMailPayload;
    expect(p.html).not.toContain(EVENT_URL); // không nhúng presigned URL
    expect(p.attachments?.some((a) => a.cid === 'event-banner@ticket')).toBe(false);
  });

  it('ảnh > 3MB → bỏ qua (giới hạn dung lượng email Gmail/Outlook)', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      headers: { get: () => 'image/png' },
      arrayBuffer: async () => new ArrayBuffer(4 * 1024 * 1024),
    });

    const res = await service.dispatchBatch([makePayload({ eventImage: EVENT_URL })]);

    expect(res.dispatched).toBe(1);
    const p = sendMock.mock.calls[0][0] as ClaimMailPayload;
    expect(p.attachments?.some((a) => a.cid === 'event-banner@ticket')).toBe(false);
    expect(p.html).toContain(`src="${DEFAULT_BANNER}"`);
  });

  it('payload không có eventImage → không cố fetch, dùng banner mặc định', async () => {
    const res = await service.dispatchBatch([makePayload()]);

    expect(res.dispatched).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
    const p = sendMock.mock.calls[0][0] as ClaimMailPayload;
    expect(p.html).toContain(`src="${DEFAULT_BANNER}"`);
  });

  it('dispatch render có {{pdfUrl}} — link trỏ THẲNG content public (PDF tự content), có token + tên', async () => {
    (service as unknown as { getTemplate: () => string }).getTemplate = () =>
      '<a href="{{pdfUrl}}">tải</a>';
    // JWS thật bắt đầu 'ey' (base64url JSON header) → được coi là signed token
    tokenMock.mockResolvedValueOnce(new Map([['tk-1', 'eyJhbGciOiJFZERTQSIsImtpZCI6InQifQ.abc.def']]));
    (env as unknown as { CONTENT_PUBLIC_BASE_URL: string }).CONTENT_PUBLIC_BASE_URL =
      'https://content.example.com';

    await service.dispatchBatch([
      makePayload({
        claimToken: 'tok-pdfx1',
        ticketId: 'tk-1',
        ticketCode: 'CODE-TK1',
        customerName: 'Nguyễn Văn A',
        customerPhone: '0966 555 888',
        bookedAt: '28/08/2026 17:00',
      }),
    ]);

    const p = sendMock.mock.calls[0][0] as ClaimMailPayload;
    expect(p.html).toContain(
      'https://content.example.com/content-service/tickets/tk-1/pdf?token=eyJhbGciOiJFZERTQSIsImtpZCI6InQifQ.abc.def',
    );
    expect(p.html).toContain('name='); // tên người nhận truyền kèm để PDF in đúng tên
    expect(p.html).toContain('phone='); // SĐT — PII truyền qua URL để PDF in đủ thông tin
    expect(p.html).toContain('email='); // email người nhận (content không lưu PII)
    expect(p.html).toContain('bookedAt='); // thời gian đặt vé
    expect(p.html).not.toContain('/ticket-mayo/tickets/pdf/'); // KHÔNG còn endpoint ticket-mayo
  });

  it('không có CONTENT_PUBLIC_BASE_URL / không có ticketId → pdfUrl fallback claimUrl', async () => {
    (service as unknown as { getTemplate: () => string }).getTemplate = () =>
      '<a href="{{pdfUrl}}">tải</a>';

    await service.dispatchBatch([
      makePayload({ claimToken: 'tok-pdfx2', claimUrl: 'http://localhost:5174/c/tok-pdfx2' }),
    ]);

    const p = sendMock.mock.calls[0][0] as ClaimMailPayload;
    expect(p.html).toContain('http://localhost:5174/c/tok-pdfx2');
  });
});

// ─── VÉ-PDF-BUCKET: PDF vé phát qua email được archive vào SeaweedFS SAU khi send ok ───
describe('MailDispatcherService — archive PDF vào bucket sau khi gửi mail', () => {
  const SIGNED = 'eyJhbGciOiJFZERTQSIsImtpZCI6InQifQ.abc.def';

  function makeServiceWithStorage(sendMock: jest.Mock) {
    const archiveMock = jest.fn(async (_input: ArchiveTicketPdfInput) => {});
    const service = new MailDispatcherService(
      { send: sendMock } as never,
      {
        getTicketQrTokens: jest.fn(async () => new Map([['tk-1', SIGNED]])),
      } as never,
      { enabled: true, archiveTicketPdf: archiveMock } as never,
    );
    (service as unknown as { getTemplate: () => string }).getTemplate = () =>
      '<b>{{ticketCode}}</b>';
    (service as unknown as { generateQrWithLogo: () => Promise<Buffer> }).generateQrWithLogo =
      jest.fn(async () => Buffer.from('fake-qr'));
    return { service, archiveMock };
  }

  it('send ok + ticketId + signed token → archiveTicketPdf gọi đúng input, dispatch ok', async () => {
    const sendMock = jest.fn(async () => {});
    const { service, archiveMock } = makeServiceWithStorage(sendMock);

    const res = await service.dispatchBatch([
      makePayload({ claimToken: 'tok-a1', ticketId: 'tk-1', ticketCode: 'C1' }),
    ]);

    expect(res.dispatched).toBe(1);
    expect(archiveMock).toHaveBeenCalledTimes(1);
    expect(archiveMock.mock.calls[0][0]).toMatchObject({
      jobId: 'job-1',
      ticketId: 'tk-1',
      qrToken: SIGNED,
      ticketCode: 'C1',
    });
  });

  it('send fail → KHÔNG archive (chỉ lưu vé đã bắn email thành công)', async () => {
    const sendMock = jest.fn(async () => {
      throw new Error('smtp down');
    });
    const { service, archiveMock } = makeServiceWithStorage(sendMock);

    const res = await service.dispatchBatch([
      makePayload({ claimToken: 'tok-a2', ticketId: 'tk-1', ticketCode: 'C1' }),
    ]);

    expect(res.failed).toBe(1);
    expect(archiveMock).not.toHaveBeenCalled();
  });
});

// ─── AC: QR = STATIC SIGNED TOKEN từ content (offline-checkin v1.1), KHÔNG link web ───
describe('MailDispatcherService — QR static signed token (content API)', () => {
  let service: MailDispatcherService;
  let qrMock: jest.Mock;
  let tokenMock: jest.Mock;

  function makeService() {
    service = new MailDispatcherService({ send: jest.fn() } as never, {
      getTicketQrTokens: tokenMock,
    } as never);
    (service as unknown as { getTemplate: () => string }).getTemplate = () => '<img src="{{qrUrl}}">';
    qrMock = jest.fn(async () => Buffer.from('fake-qr'));
    (service as unknown as { generateQrWithLogo: () => Promise<Buffer> }).generateQrWithLogo =
      qrMock as never;
    return service;
  }

  beforeEach(() => {
    tokenMock = jest.fn(async () => new Map()); // batch mặc định: không có token nào
    service = makeService();
  });

  it('payload có ticketId + content trả token → QR encode SIGNED TOKEN (không phải claimUrl)', async () => {
    tokenMock.mockResolvedValueOnce(new Map([['tk-1', 'signed-token-abc123']]));

    await service.dispatchBatch([
      makePayload({ claimToken: 'tok-1', ticketId: 'tk-1', ticketCode: 'CODE-TK1' }),
    ]);

    expect(tokenMock).toHaveBeenCalledWith(['tk-1']);
    expect(qrMock).toHaveBeenCalledWith('signed-token-abc123');
  });

  it('content lỗi/null token → fallback QR encode ticketCode thật', async () => {
    // content trả token null cho id → cache null → fallback QR encode ticketCode thật
    tokenMock.mockResolvedValueOnce(new Map([['tk-1', null]]));

    await service.dispatchBatch([
      makePayload({ claimToken: 'tok-1', ticketId: 'tk-1', ticketCode: 'CODE-TK1' }),
    ]);

    expect(qrMock).toHaveBeenCalledWith('CODE-TK1');
  });

  it('không có ticketId → token URL là claimUrl (retry job fail, vé chưa có code)', async () => {
    await service.dispatchBatch([makePayload({ claimToken: 'tok-1' })]);

    expect(tokenMock).not.toHaveBeenCalled();
    expect(qrMock).toHaveBeenCalledWith('http://localhost:5174/c/tok-1');
  });
});

// ─── P7: resize + nén ảnh event trước khi nhúng CID ───
describe('MailDispatcherService — P7 optimizeEventImage', () => {
  let service: MailDispatcherService;

  beforeEach(() => {
    service = new MailDispatcherService(
      { send: jest.fn() } as never,
      { getTicketQrTokens: jest.fn() } as never,
    );
  });

  it('ảnh to → resize ≤1200px, re-encode JPEG, nhẹ hơn rõ rệt', async () => {
    // Ảnh production-like: ảnh thật có nhiễu (nén kém như ảnh chụp/upload thật)
    const w = 2000;
    const h = 1250;
    const rawPixels = Buffer.alloc(w * h * 3);
    for (let i = 0; i < rawPixels.length; i++) rawPixels[i] = (Math.random() * 256) | 0;
    const raw = await sharp(rawPixels, { raw: { width: w, height: h, channels: 3 } })
      .jpeg({ quality: 95 })
      .toBuffer();

    const out = await (service as unknown as {
      optimizeEventImage: (b: Buffer, m: string) => Promise<{ mime: string; buf: Buffer }>;
    }).optimizeEventImage(raw, 'image/jpeg');

    expect(out.mime).toBe('image/jpeg');
    const meta = await sharp(out.buf).metadata();
    expect(meta.width).toBeLessThanOrEqual(1200);
    expect(out.buf.length).toBeLessThan(raw.length);
    expect(out.buf.length / raw.length).toBeLessThan(0.5);
  });

  it('ảnh đã là JPEG nhẹ → giữ nguyên bản, không phí CPU resize', async () => {
    const raw = await sharp({
      create: { width: 640, height: 400, channels: 3, background: { r: 200, g: 200, b: 220 } },
    })
      .jpeg({ quality: 80 })
      .toBuffer();

    const out = await (service as unknown as {
      optimizeEventImage: (b: Buffer, m: string) => Promise<{ mime: string; buf: Buffer }>;
    }).optimizeEventImage(raw, 'image/jpeg');

    expect(out).toEqual({ mime: 'image/jpeg', buf: raw }); // cùng reference — không xử lý
  });

  it('PNG có alpha (poster bo góc trong suốt) → GIỮ transparency, không flatten trắng', async () => {
    // Regression chống viền trắng: flatten→JPEG nung trắng vào vùng alpha →
    // email hiện viền trắng quanh banner. Ảnh có alpha phải ra PNG alpha.
    const w = 400;
    const h = 300;
    const px = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const border = x < 3 || y < 3 || x >= w - 3 || y >= h - 3; // fringe trong suốt
        px[i] = 40; px[i + 1] = 60; px[i + 2] = 120; px[i + 3] = border ? 0 : 255;
      }
    }
    const raw = await sharp(px, { raw: { width: w, height: h, channels: 4 } })
      .png()
      .toBuffer();

    const out = await (service as unknown as {
      optimizeEventImage: (b: Buffer, m: string) => Promise<{ mime: string; buf: Buffer }>;
    }).optimizeEventImage(raw, 'image/png');

    expect(out.mime).toBe('image/png');
    const meta = await sharp(out.buf).metadata();
    expect(meta.hasAlpha).toBe(true);
    const { data } = await sharp(out.buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(data[3]).toBe(0); // góc (0,0) vẫn trong suốt — không bị nung trắng
  });

  it('JPEG không alpha → vẫn nén qua flatten+JPEG như cũ', async () => {
    const w = 1200;
    const h = 600;
    const rawPixels = Buffer.alloc(w * h * 3);
    for (let i = 0; i < w * h; i++) {
      rawPixels[i * 3] = (Math.random() * 256) | 0;
      rawPixels[i * 3 + 1] = (Math.random() * 256) | 0;
      rawPixels[i * 3 + 2] = (Math.random() * 256) | 0;
    }
    const raw = await sharp(rawPixels, { raw: { width: w, height: h, channels: 3 } })
      .png()
      .toBuffer();

    const out = await (service as unknown as {
      optimizeEventImage: (b: Buffer, m: string) => Promise<{ mime: string; buf: Buffer }>;
    }).optimizeEventImage(raw, 'image/png');

    expect(out.mime).toBe('image/jpeg');
    const meta = await sharp(out.buf).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.hasAlpha).toBe(false);
  });
});