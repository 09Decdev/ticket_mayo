import { env } from '../../config/env';
import { ContentClientService } from '../content-client/content-client.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TicketPdfService } from './ticket-pdf.service';
import { TicketPdfStorageService } from './ticket-pdf-storage.service';

type MutableEnv = {
  S3_ENDPOINT: string;
  S3_ACCESS_KEY: string;
  S3_SECRET_KEY: string;
};

/** Mock deps 3 constructor arg: renderer (render local), content, prisma. */
const makeService = (opts: {
  render?: (input: unknown) => Promise<Buffer>;
  ticketType?: Record<string, unknown> | null;
  job?: { ticketTypeId: string; ticketTypeName: string; eventName: string } | null;
}) => {
  const renderer = {
    renderTicketPdf:
      opts.render ??
      jest.fn(async () => Buffer.from('%PDF-1.4\nrendered\n%%EOF')),
  } as unknown as TicketPdfService;
  const content = {
    getTicketType: jest.fn(async () => opts.ticketType ?? null),
  } as unknown as ContentClientService;
  const prisma = {
    distributionJob: {
      findUnique: jest.fn(async () => opts.job ?? null),
    },
  } as unknown as PrismaService;
  return {
    service: new TicketPdfStorageService(renderer, content, prisma),
    renderer,
    content,
    prisma,
  };
};

describe('TicketPdfStorageService', () => {
  const saved = {
    S3_ENDPOINT: env.S3_ENDPOINT,
    S3_ACCESS_KEY: env.S3_ACCESS_KEY,
    S3_SECRET_KEY: env.S3_SECRET_KEY,
  };

  afterEach(() => {
    Object.assign(env as unknown as MutableEnv, saved);
    delete (globalThis as { fetch?: unknown }).fetch;
  });

  it('thiếu S3 config → enabled=false, render vẫn chạy (PDF trả về để đính kèm email)', async () => {
    (env as unknown as MutableEnv).S3_ENDPOINT = '';
    const { service, renderer } = makeService({});
    expect(service.enabled).toBe(false);
    // renderTicketPdfForEmail không phụ thuộc S3 — luôn render, chỉ upload bị tắt.
    const buf = await service.renderTicketPdfForEmail({ jobId: 'j1', ticketId: 't1', qrToken: 'eyabc' });
    expect(buf).not.toBeNull();
    expect(renderer.renderTicketPdf).toHaveBeenCalled();
  });

  it('buildEmailKey → email/<jobId>/<ticketId>.pdf', () => {
    const { service } = makeService({});
    expect(service.buildEmailKey({ jobId: 'job 1', ticketId: 't/1' })).toBe(
      'email/job%201/t%2F1.pdf',
    );
  });

  it('render lỗi → fail-soft trả null (không throw, email flow không ảnh hưởng)', async () => {
    (env as unknown as MutableEnv).S3_ENDPOINT = 'http://127.0.0.1:8333';
    (env as unknown as MutableEnv).S3_ACCESS_KEY = 'a';
    (env as unknown as MutableEnv).S3_SECRET_KEY = 'b';
    const { service } = makeService({
      render: jest.fn(async () => {
        throw new Error('renderer boom');
      }),
    });
    await expect(
      service.renderTicketPdfForEmail({ jobId: 'j1', ticketId: 't1', qrToken: 'eyabc' }),
    ).resolves.toBeNull();
  });

  it('renderTicketPdfForEmail: job → getTicketType → renderer với event ctx + PII', async () => {
    (env as unknown as MutableEnv).S3_ENDPOINT = 'http://127.0.0.1:8333';
    (env as unknown as MutableEnv).S3_ACCESS_KEY = 'a';
    (env as unknown as MutableEnv).S3_SECRET_KEY = 'b';
    const { service, renderer, content, prisma } = makeService({
      ticketType: {
        id: 'tt-1',
        name: 'VIP',
        event: {
          title: 'Sự kiện A',
          startTime: '2026-09-10T09:00:00.000Z',
          address: '123 Lê Lợi',
          city: 'Đà Nẵng',
          eventImageUrl: null,
        },
      },
      job: { ticketTypeId: 'tt-1', ticketTypeName: 'VIP', eventName: 'Sự kiện A' },
    });

    const buf = await service.renderTicketPdfForEmail({
      jobId: 'j1',
      ticketId: 't1',
      qrToken: 'eyabc',
      ticketCode: 'TC-001',
      attendee: { name: 'Nguyễn Văn A', email: 'a@example.com' },
    });

    expect(buf?.toString()).toContain('%PDF');
    expect(prisma.distributionJob.findUnique).toHaveBeenCalledWith({
      where: { id: 'j1' },
      select: { ticketTypeId: true, ticketTypeName: true, eventName: true },
    });
    expect(content.getTicketType).toHaveBeenCalledWith('tt-1');
    const input = (renderer as unknown as { renderTicketPdf: jest.Mock }).renderTicketPdf.mock
      .calls[0][0];
    expect(input.eventTitle).toBe('Sự kiện A');
    expect(input.ticketTypeName).toBe('VIP');
    expect(input.ticketCode).toBe('TC-001');
    expect(input.token).toBe('eyabc');
    expect(input.attendee).toEqual({ name: 'Nguyễn Văn A', email: 'a@example.com' });
  });

  it('content getTicketType lỗi → fallback job snapshot (eventName/ticketTypeName), vẫn render', async () => {
    (env as unknown as MutableEnv).S3_ENDPOINT = 'http://127.0.0.1:8333';
    (env as unknown as MutableEnv).S3_ACCESS_KEY = 'a';
    (env as unknown as MutableEnv).S3_SECRET_KEY = 'b';
    const { service, renderer } = makeService({
      ticketType: null,
      job: { ticketTypeId: 'tt-1', ticketTypeName: 'Regular', eventName: 'Sự kiện B' },
    });

    await service.renderTicketPdfForEmail({ jobId: 'j2', ticketId: 't2', qrToken: 'eyabc' });
    const input = (renderer as unknown as { renderTicketPdf: jest.Mock }).renderTicketPdf.mock
      .calls[0][0];
    expect(input.eventTitle).toBe('Sự kiện B');
    expect(input.ticketTypeName).toBe('Regular');
  });

  it('fetchPrintTicketPdf: attendee luôn là "Vé nhà tài trợ", PII khác trống', async () => {
    (env as unknown as MutableEnv).S3_ENDPOINT = 'http://127.0.0.1:8333';
    (env as unknown as MutableEnv).S3_ACCESS_KEY = 'a';
    (env as unknown as MutableEnv).S3_SECRET_KEY = 'b';
    const { service, renderer } = makeService({
      ticketType: null,
      job: { ticketTypeId: 'tt-1', ticketTypeName: 'Regular', eventName: 'Sự kiện B' },
    });

    const buf = await service.fetchPrintTicketPdf({
      jobId: 'j3',
      ticketId: 't3',
      qrToken: 'eyxyz',
      ticketCode: 'TC-003',
    });
    expect(buf.toString()).toContain('%PDF');
    const input = (renderer as unknown as { renderTicketPdf: jest.Mock }).renderTicketPdf.mock
      .calls[0][0];
    expect(input.attendee).toEqual({ name: 'Vé nhà tài trợ' });
    expect(input.ticketCode).toBe('TC-003');
  });
});

// ─── VÉ-PDF-ZIP: writeZip gom nhiều PDF trong bucket thành 1 zip có folder ───
describe('TicketPdfStorageService — writeZip', () => {
  const fixture = (label: string) => Buffer.from(`%PDF-1.4\n${label}\n%%EOF`);

  it('entries mix có/không có PDF → added đúng, missing + _THIEU_PDF.txt, zip "PK"', async () => {
    const { service } = makeService({});
    jest
      .spyOn(service, 'getBuffer')
      .mockImplementation(async (key: string) =>
        key.endsWith('t-001.pdf') || key.endsWith('t-002.pdf') ? fixture(key) : null,
      );

    const chunks: Buffer[] = [];
    const out = new (require('stream').PassThrough)();
    out.on('data', (c: Buffer) => chunks.push(c));
    const ended = new Promise<void>((r) => out.on('end', () => r()));

    const res = await service.writeZip(
      [
        { key: 'email/j1/t-001.pdf', name: 'CODE1.pdf' },
        { key: 'email/j1/t-missing.pdf', name: 'CODEMISS.pdf' },
        { key: 'email/j1/t-002.pdf', name: 'CODE2.pdf' },
      ],
      'Ve VIP',
      out,
    );
    expect(res.added).toBe(2);
    expect(res.missing).toEqual(['CODEMISS.pdf']);

    await ended;
    const zip = Buffer.concat(chunks);
    expect(zip.subarray(0, 2).toString('latin1')).toBe('PK');
    // level 0 (STORE) → tên entry lưu plaintext, assert không cần unzip lib.
    expect(zip.includes(Buffer.from('Ve VIP/CODE1.pdf'))).toBe(true);
    expect(zip.includes(Buffer.from('Ve VIP/CODE2.pdf'))).toBe(true);
    expect(zip.includes(Buffer.from('Ve VIP/_THIEU_PDF.txt'))).toBe(true);
    expect(zip.includes(Buffer.from('CODEMISS.pdf'))).toBe(true); // note liệt kê file thiếu
  });

  it('rỗng entries → zip vẫn hợp lệ (PK header, 0 bytes nội dung file)', async () => {
    const { service } = makeService({});
    const out = new (require('stream').PassThrough)();
    const chunks: Buffer[] = [];
    out.on('data', (c: Buffer) => chunks.push(c));
    const ended = new Promise<void>((r) => out.on('end', () => r()));
    const res = await service.writeZip([], 'Empty', out);
    await ended;
    expect(res).toEqual({ added: 0, missing: [] });
    const zip = Buffer.concat(chunks);
    expect(zip.subarray(0, 2).toString('latin1')).toBe('PK');
  });
});
