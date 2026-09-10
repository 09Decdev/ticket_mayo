/**
 * MAJOR-4 (SecArch MEDIUM-2 / TM-3): KHÔNG log plaintext email.
 *
 * Spy Logger của Nest (console) + fs.writeFileSync để bắt MỌI chuỗi
 * ghi ra log/file khi adapter chạy — assert plaintext email KHÔNG BAO GIỜ
 * xuất hiện (chỉ được phép có dạng redact "n***@domain" hoặc hash).
 *
 * env stub trước khi import (env.ts evaluate 1 lần).
 */

process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.JWT_SECRET ??= 'test-jwt-secret-32-chars-minimum-value';
process.env.FIELD_ENCRYPTION_PEPPER ??= 'test-pepper-32-chars-minimum-value';
process.env.ADMIN_EMAIL ??= 'admin@test.local';
process.env.ADMIN_PASSWORD ??= 'test-admin-password';
process.env.MAIL_TRANSPORT ??= 'console';
process.env.PUBLIC_BASE_URL ??= 'http://localhost:5174';
process.env.PORT ??= '3005';
process.env.NODE_ENV ??= 'test';

import { Logger } from '@nestjs/common';
import fs from 'fs';
import {
  ConsoleMailAdapter,
} from './console-mail.adapter';
import {
  SmtpMailAdapter,
  redactEmail,
  emailShortHash,
} from './smtp-mail.adapter';
import type { ClaimMailPayload } from './mail.adapter';

// SmtpMailAdapter constructor gọi nodemailer.createTransport — mock module
// để không cần SMTP thật (chỉ test log path).
jest.mock('nodemailer', () => ({
  __esModule: true,
  default: {
    createTransport: jest.fn(() => ({
      sendMail: jest.fn(async () => ({ messageId: 'test-msg-id' })),
    })),
  },
}));

const SECRET_EMAIL = 'nguyen.van.a@example.com';

function makePayload(): ClaimMailPayload {
  return {
    jobId: 'job-1',
    email: SECRET_EMAIL,
    claimToken: 'claim-token-abcdef1234567890',
    claimUrl: 'http://localhost:5174/c/claim-token-abcdef1234567890',
    ticketTypeName: 'Vé VIP',
    eventName: 'Sự kiện test',
    eventDate: '01/09/2026 | 10:00',
    venue: 'Hà Nội',
    customerName: 'Người dùng test',
    customerPhone: '',
    bookedAt: '27/08/2026 10:00',
    ticketCode: 'ABCDEF12',
    ticketCount: 2,
    text: 'Bạn thân mến,\r\n\r\nChúc mừng bạn đã nhận được 2 vé...',
    attachments: [
      {
        filename: 'VE-ABCDEF12.pdf',
        content: Buffer.from('%PDF-1.4 fake'),
        contentType: 'application/pdf',
      },
    ],
  };
}

describe('TM-3 redaction — plaintext email KHÔNG xuất hiện trong log/file (MAJOR-4)', () => {
  let logSpy: jest.SpyInstance;
  let writtenFiles: { path: string; data: string }[];
  let writeFileSyncSpy: jest.SpyInstance;
  let mkdirSpy: jest.SpyInstance;

  beforeEach(() => {
    writtenFiles = [];
    // Spy fs GỐC — ConsoleMailAdapter dùng top-level import { mkdirSync, writeFileSync }
    // nên phải spy trên chính module fs (ESM interop default export).
    writeFileSyncSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation(((
      path: fs.PathOrFileDescriptor,
      data: string,
    ) => {
      writtenFiles.push({ path: String(path), data });
    }) as typeof fs.writeFileSync);
    mkdirSpy = jest.spyOn(fs, 'mkdirSync').mockImplementation((() => undefined) as typeof fs.mkdirSync);
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('pure helpers', () => {
    it('redactEmail: "n***@domain" — KHÔNG chứa local-part đầy đủ', () => {
      const out = redactEmail('nguyen.van.a@example.com');
      expect(out).toBe('n***@example.com');
      expect(out).not.toContain('nguyen');
    });

    it('redactEmail: email không hợp lệ (không @) → "***"', () => {
      expect(redactEmail('not-an-email')).toBe('***');
    });

    it('emailShortHash: hex 12 chars, không chứa email', () => {
      const out = emailShortHash('nguyen.van.a@example.com');
      expect(out).toMatch(/^[0-9a-f]{12}$/);
      expect(out).not.toContain('@');
      // Deterministic — cùng email cùng hash
      expect(out).toBe(emailShortHash('nguyen.van.a@example.com'));
    });
  });

  describe('ConsoleMailAdapter.send', () => {
    it('log output KHÔNG chứa plaintext email (chỉ redact)', async () => {
      const adapter = new ConsoleMailAdapter();
      await adapter.send(makePayload());

      expect(logSpy).toHaveBeenCalled();
      const allLogged = logSpy.mock.calls
        .map((args: unknown[]) => args.map((a: unknown) => String(a)).join(' '))
        .join('\n');
      expect(allLogged).toContain('n***@example.com'); // dạng redact có mặt
      expect(allLogged).not.toContain(SECRET_EMAIL); // plaintext KHÔNG có mặt
      expect(allLogged).not.toContain('nguyen.van.a@');
    });

    it('tên file preview dùng emailShortHash (text + PDF), KHÔNG chứa email plaintext', async () => {
      const adapter = new ConsoleMailAdapter();
      await adapter.send(makePayload());

      // 1 file .txt (body text) + 1 file .pdf (đính kèm).
      expect(writtenFiles).toHaveLength(2);
      for (const f of writtenFiles) {
        const fileName = f.path.split(/[\\/]/).pop() ?? '';
        expect(fileName).not.toContain('@');
        expect(fileName).not.toContain('nguyen');
      }
      const txt = writtenFiles.find((f) => f.path.endsWith('.txt'));
      expect((txt?.path ?? '').split(/[\\/]/).pop()).toMatch(/^[0-9a-f]{12}-.{8}\.txt$/);
      const pdf = writtenFiles.find((f) => f.path.endsWith('.pdf'));
      expect((pdf?.path ?? '').split(/[\\/]/).pop()).toMatch(/^[0-9a-f]{12}-.{8}-VE-ABCDEF12\.pdf$/);
    });
  });

  describe('SmtpMailAdapter.send (nodemailer mocked)', () => {
    it('log output KHÔNG chứa plaintext email (chỉ redact)', async () => {
      const adapter = new SmtpMailAdapter();
      await adapter.send(makePayload());

      expect(logSpy).toHaveBeenCalled();
      const allLogged = logSpy.mock.calls
        .map((args: unknown[]) => args.map((a: unknown) => String(a)).join(' '))
        .join('\n');
      expect(allLogged).toContain('n***@example.com');
      expect(allLogged).not.toContain(SECRET_EMAIL);
      expect(allLogged).not.toContain('nguyen.van.a@');
    });
  });

  describe('AdminBootstrapService log (NEW-2 — spy Logger thật trên chính service)', () => {
    it('log "already exists" KHÔNG chứa plaintext email — chỉ emailHash', async () => {
      const { AdminBootstrapService } = await import('../auth/admin-bootstrap.service');
      const prismaFake = {
        portalUser: {
          findFirst: jest.fn(async () => ({ id: 'admin-9', email: SECRET_EMAIL })),
        },
      };
      const svc = new AdminBootstrapService(prismaFake as never);
      await svc.onModuleInit();

      expect(logSpy).toHaveBeenCalled();
      const allLogged = logSpy.mock.calls
        .map((args: unknown[]) => args.map((a: unknown) => String(a)).join(' '))
        .join('\n');
      expect(allLogged).toContain('admin user already exists (id=admin-9');
      expect(allLogged).toMatch(/emailHash=[0-9a-f]{64}/);
      expect(allLogged).not.toContain(SECRET_EMAIL);
      expect(allLogged).not.toContain('nguyen.van.a@');
    });

    it('log "bootstrapped" KHÔNG chứa plaintext email admin từ env', async () => {
      const { AdminBootstrapService } = await import('../auth/admin-bootstrap.service');
      const prismaFake = {
        portalUser: {
          findFirst: jest.fn(async () => null),
          create: jest.fn(async () => ({ id: 'admin-1' })),
        },
      };
      const svc = new AdminBootstrapService(prismaFake as never);
      await svc.onModuleInit();

      const allLogged = logSpy.mock.calls
        .map((args: unknown[]) => args.map((a: unknown) => String(a)).join(' '))
        .join('\n');
      expect(allLogged).toContain('bootstrapped admin user id=admin-1');
      expect(allLogged).toMatch(/emailHash=[0-9a-f]{64}/);
      // ADMIN_EMAIL stub trong env test là 'admin@test.local' — không được lọt log
      expect(allLogged).not.toContain('admin@test.local');
      expect(allLogged).not.toContain('@test.local');
    });
  });
});
