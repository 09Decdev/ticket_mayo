import { NotFoundException, StreamableFile } from '@nestjs/common';
import puppeteer from 'puppeteer';
import { TicketPdfController } from './ticket-pdf.controller';
import { TicketPdfService } from './ticket-pdf.service';

jest.mock('puppeteer');

describe('TicketPdfService — render HTML của template email → PDF A4', () => {
  const MOCK_PDF = Buffer.from('%PDF-1.7 mock');
  let pageMock: {
    setContent: jest.Mock;
    waitForNetworkIdle: jest.Mock;
    pdf: jest.Mock;
  };
  let browserMock: { newPage: jest.Mock; close: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    pageMock = {
      setContent: jest.fn(async () => undefined),
      waitForNetworkIdle: jest.fn(async () => undefined),
      pdf: jest.fn(async () => MOCK_PDF),
    };
    browserMock = {
      newPage: jest.fn(async () => pageMock),
      close: jest.fn(async () => undefined),
    };
    (puppeteer.launch as jest.Mock).mockResolvedValue(browserMock);
  });

  it('setContent HTML → page.pdf A4 + printBackground, trả Buffer, đóng browser', async () => {
    const out = await new TicketPdfService().renderPdf('<html><body>Vé tiếng Việt</body></html>');

    expect(Buffer.isBuffer(out)).toBe(true);
    expect(out.toString()).toContain('%PDF');
    expect(pageMock.setContent).toHaveBeenCalledWith(
      '<html><body>Vé tiếng Việt</body></html>',
      expect.objectContaining({ waitUntil: 'domcontentloaded' }),
    );
    expect(pageMock.pdf).toHaveBeenCalledWith(
      expect.objectContaining({ format: 'A4', printBackground: true }),
    );
    expect(browserMock.close).toHaveBeenCalled();
  });

  it('offline (chờ font timeout) → vẫn render PDF (fail-soft)', async () => {
    pageMock.waitForNetworkIdle = jest.fn(async () => {
      throw new Error('Timeout 4000ms exceeded');
    });
    const out = await new TicketPdfService().renderPdf('<html></html>');
    expect(Buffer.isBuffer(out)).toBe(true);
  });

  it('launch Chromium lỗi → rethrow (caller trả 500)', async () => {
    (puppeteer.launch as jest.Mock).mockRejectedValue(new Error('chrome missing'));
    await expect(new TicketPdfService().renderPdf('<html></html>')).rejects.toThrow(
      'chrome missing',
    );
  });
});

describe('TicketPdfController — GET tickets/pdf/:claimToken', () => {
  function makeController(payload: unknown) {
    const distribution = {
      buildPayloadByClaimToken: jest.fn(async () => payload),
    };
    const mailDispatcher = {
      buildPdfHtml: jest.fn(async () => '<html>rendered</html>'),
    };
    const pdf = {
      renderPdf: jest.fn(async () => Buffer.from('%PDF-1.7 real')),
    };
    const ctrl = new TicketPdfController(
      distribution as never,
      mailDispatcher as never,
      pdf as never,
    );
    return { ctrl, distribution, mailDispatcher, pdf };
  }

  it('payload tìm thấy → buildPdfHtml(rồi renderPdf) → StreamableFile attachment', async () => {
    const { ctrl, distribution, mailDispatcher, pdf } = makeController({
      ticketCode: 'ABC12345',
    });

    const res = await ctrl.downloadPdf('tok-secret1');

    expect(distribution.buildPayloadByClaimToken).toHaveBeenCalledWith('tok-secret1');
    expect(mailDispatcher.buildPdfHtml).toHaveBeenCalledWith(
      expect.objectContaining({ ticketCode: 'ABC12345' }),
    );
    expect(pdf.renderPdf).toHaveBeenCalledWith('<html>rendered</html>');
    expect(res).toBeInstanceOf(StreamableFile);
  });

  it('payload null (token không tồn tại) → 404, không render PDF', async () => {
    const { ctrl, mailDispatcher, pdf } = makeController(null);

    await expect(ctrl.downloadPdf('nosuch')).rejects.toBeInstanceOf(NotFoundException);
    expect(mailDispatcher.buildPdfHtml).not.toHaveBeenCalled();
    expect(pdf.renderPdf).not.toHaveBeenCalled();
  });
});