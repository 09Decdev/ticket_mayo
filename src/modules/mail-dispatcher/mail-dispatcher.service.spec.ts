import { env } from '../../config/env';
import { MailDispatcherService } from './mail-dispatcher.service';
import { ClaimMailPayload } from './mail.adapter';
import { renderTicketEmailText } from './ticket-email-text.renderer';

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

const SIGNED = 'eyJhbGciOiJFZERTQSIsImtpZCI6InQifQ.abc.def';

/** Fake pdfStorage — record render calls, return buffer mô phỏng PDF. */
function makePdfStorage() {
  const renderMock = jest.fn(
    async (input: { jobId: string; ticketId: string; qrToken: string }) =>
      Buffer.from(`%PDF-1.4\n${input.ticketId}\n%%EOF`),
  );
  const uploadMock = jest.fn(async () => undefined);
  return { renderMock, uploadMock, storage: { renderTicketPdfForEmail: renderMock, uploadEmailPdf: uploadMock } as never };
}

describe('MailDispatcherService — boarding-pass text + PDF attach (Phần 2)', () => {
  let service: MailDispatcherService;
  let sendMock: jest.Mock;
  let tokenMock: jest.Mock;

  function makeService(pdfStorage?: never) {
    return new MailDispatcherService(
      { send: sendMock } as never,
      { getTicketQrTokens: tokenMock } as never,
      pdfStorage,
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
    sendMock = jest.fn(async () => {
      /* adapter no-op */
    });
    tokenMock = jest.fn(async () => new Map()); // batch mặc định: không có token nào
    service = makeService();
  });

  it('payload cơ bản → gửi text + 0 PDF, có claimToken ok', async () => {
    const res = await service.dispatchBatch([makePayload()]);

    expect(res.dispatched).toBe(1);
    expect(res.failed).toBe(0);
    expect(res.results).toEqual([{ claimToken: 'tok-1', ok: true }]);
    const p = sendMock.mock.calls[0][0] as ClaimMailPayload;
    expect(p.text).toContain('Chúc mừng bạn đã nhận được 1 vé');
    expect(p.attachments).toEqual([]);
  });

  it('quantity vé cùng 1 email → 1 email duy nhất gộp N PDF, ticketCount=N', async () => {
    const { storage, renderMock } = makePdfStorage();
    tokenMock.mockResolvedValueOnce(
      new Map([['tk-1', SIGNED], ['tk-2', SIGNED]]),
    );
    const service2 = new MailDispatcherService(
      { send: sendMock } as never,
      { getTicketQrTokens: tokenMock } as never,
      storage,
    );

    const res = await service2.dispatchBatch([
      makePayload({ claimToken: 'tok-1', email: 'a@example.com', ticketId: 'tk-1', ticketCode: 'C1' }),
      makePayload({ claimToken: 'tok-2', email: 'a@example.com', ticketId: 'tk-2', ticketCode: 'C2' }),
      makePayload({ claimToken: 'tok-3', email: 'b@example.com' }), // không render (không ticketId)
    ]);

    expect(res.dispatched).toBe(2); // 2 email (a@example.com gộp, b@example.com riêng)
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(renderMock).toHaveBeenCalledTimes(2); // tk-1 + tk-2

    const sentA = sendMock.mock.calls.find(
      ([p]: [ClaimMailPayload]) => p.email === 'a@example.com',
    )?.[0] as ClaimMailPayload;
    expect(sentA.ticketCount).toBe(2);
    expect(sentA.attachments?.map((a) => a.filename)).toEqual(['VE-C1.pdf', 'VE-C2.pdf']);
    expect(sentA.text).toContain('nhận được 2 vé');
    // results per claimToken: 3 vé đều ok (nhóm chạy concurrent → thứ tự push
    // theo hoàn thành, sort trước khi assert).
    expect([...res.results].sort((a, b) => a.claimToken.localeCompare(b.claimToken))).toEqual([
      { claimToken: 'tok-1', ok: true },
      { claimToken: 'tok-2', ok: true },
      { claimToken: 'tok-3', ok: true },
    ]);
  });

  it('signed token → render PDF với qrToken đúng; upload archive lên bucket', async () => {
    const { storage, renderMock, uploadMock } = makePdfStorage();
    tokenMock.mockResolvedValueOnce(new Map([['tk-1', SIGNED]]));
    const service2 = new MailDispatcherService(
      { send: sendMock } as never,
      { getTicketQrTokens: tokenMock } as never,
      storage,
    );

    await service2.dispatchBatch([
      makePayload({ claimToken: 'tok-a1', ticketId: 'tk-1', ticketCode: 'C1' }),
    ]);

    expect(renderMock).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'job-1', ticketId: 'tk-1', qrToken: SIGNED, ticketCode: 'C1' }),
    );
    // upload archive chạy async fire-and-forget — flush microtask trước assert.
    await new Promise((r) => setImmediate(r));
    expect(uploadMock).toHaveBeenCalledWith('job-1', 'tk-1', expect.any(Buffer));
  });

  it('content trả token null → fallback ticketCode, KHÔNG render PDF (không bắt đầu "ey")', async () => {
    const { storage, renderMock } = makePdfStorage();
    tokenMock.mockResolvedValueOnce(new Map([['tk-1', null]]));
    const service2 = new MailDispatcherService(
      { send: sendMock } as never,
      { getTicketQrTokens: tokenMock } as never,
      storage,
    );

    const res = await service2.dispatchBatch([
      makePayload({ claimToken: 'tok-1', ticketId: 'tk-1', ticketCode: 'CODE-TK1' }),
    ]);

    expect(res.dispatched).toBe(1);
    expect(renderMock).not.toHaveBeenCalled(); // fallback CODE → không phải signed token
    const p = sendMock.mock.calls[0][0] as ClaimMailPayload;
    expect(p.attachments).toEqual([]);
  });

  it('send fail → failed=1, results ok=false cho mọi vé trong nhóm', async () => {
    sendMock.mockImplementationOnce(async () => {
      throw new Error('smtp down');
    });

    const res = await service.dispatchBatch([
      makePayload({ claimToken: 'tok-1', email: 'a@example.com' }),
      makePayload({ claimToken: 'tok-2', email: 'a@example.com' }),
    ]);

    expect(res.failed).toBe(1);
    expect(res.results).toEqual([
      { claimToken: 'tok-1', ok: false },
      { claimToken: 'tok-2', ok: false },
    ]);
  });

  it('prefetch token fail → warn + fallback, email vẫn gửi', async () => {
    tokenMock.mockRejectedValueOnce(new Error('content down'));

    const res = await service.dispatchBatch([
      makePayload({ claimToken: 'tok-1', ticketId: 'tk-1', ticketCode: 'CODE-TK1' }),
    ]);

    expect(res.dispatched).toBe(1);
    expect(res.failed).toBe(0);
  });
});

// ─── QR = STATIC SIGNED TOKEN từ content (offline-checkin v1.1) ───
describe('MailDispatcherService — QR static signed token (content API)', () => {
  let sendMock: jest.Mock;
  let tokenMock: jest.Mock;
  let renderMock: jest.Mock;

  function makeService() {
    return new MailDispatcherService(
      { send: sendMock } as never,
      { getTicketQrTokens: tokenMock } as never,
      { renderTicketPdfForEmail: renderMock } as never,
    );
  }

  beforeEach(() => {
    sendMock = jest.fn(async () => undefined);
    renderMock = jest.fn(async () => Buffer.from('%PDF-1.4\n%%EOF'));
    tokenMock = jest.fn(async () => new Map());
  });

  it('payload có ticketId + content trả token → PDF render với SIGNED TOKEN (không phải claimUrl)', async () => {
    tokenMock.mockResolvedValueOnce(new Map([['tk-1', SIGNED]]));

    await makeService().dispatchBatch([
      makePayload({ claimToken: 'tok-1', ticketId: 'tk-1', ticketCode: 'CODE-TK1' }),
    ]);

    expect(tokenMock).toHaveBeenCalledWith(['tk-1']);
    expect(renderMock.mock.calls[0][0].qrToken).toBe(SIGNED);
  });

  it('content lỗi/null token → fallback ticketCode thật (không render)', async () => {
    tokenMock.mockResolvedValueOnce(new Map([['tk-1', null]]));

    await makeService().dispatchBatch([
      makePayload({ claimToken: 'tok-1', ticketId: 'tk-1', ticketCode: 'CODE-TK1' }),
    ]);

    expect(renderMock).not.toHaveBeenCalled(); // 'CODE-TK1' không bắt đầu 'ey'
  });

  it('không có ticketId → không gọi token API, không render', async () => {
    await makeService().dispatchBatch([makePayload({ claimToken: 'tok-1' })]);

    expect(tokenMock).not.toHaveBeenCalled();
    expect(renderMock).not.toHaveBeenCalled();
  });
});

// ─── Body text boarding-pass theo template ───
describe('renderTicketEmailText — template boarding-pass', () => {
  const savedBtc = (env as unknown as { BTC_UPDATE_URL?: string }).BTC_UPDATE_URL;

  afterEach(() => {
    (env as unknown as { BTC_UPDATE_URL?: string }).BTC_UPDATE_URL = savedBtc;
  });

  it('đủ slot: số vé, tên event, ngày, venue, link BTC', () => {
    (env as unknown as { BTC_UPDATE_URL?: string }).BTC_UPDATE_URL = 'https://fb.com/btc';
    const text = renderTicketEmailText(
      makePayload({
        eventName: 'Festival Thăng Long',
        eventDate: '01/10/2026 | 19:00',
        venue: 'Cung Văn hóa Hữu nghị',
        ticketCount: 3,
      }),
    );

    expect(text).toContain('Chúc mừng bạn đã nhận được 3 vé tham dự sự kiện Festival Thăng Long');
    expect(text).toContain('ngày 01/10/2026 | 19:00');
    expect(text).toContain('tại Cung Văn hóa Hữu nghị');
    expect(text).toContain('Mã vé QR chi tiết đã được đính kèm trực tiếp vào email này.');
    expect(text).toContain('https://fb.com/btc');
    expect(text).toContain('Hẹn gặp lại bạn tại sự kiện Festival Thăng Long!');
    expect(text).toContain('Vui lòng không trả lời email này.');
  });

  it('thiếu eventDate/venue → câu vẫn tự nhiên, không "null"', () => {
    const text = renderTicketEmailText(makePayload({ ticketCount: 1 }));

    expect(text).toContain('nhận được 1 vé tham dự sự kiện Sự kiện test.');
    expect(text).not.toContain('null');
    expect(text).not.toContain('undefined');
  });
});
