/**
 * T6 — sync trigger tests (F-09 dual-path, §5.4): mint là bắt buộc khi phát
 * vé → register/login LUÔN chạy syncTicketsByEmail + resolvePendingPreTickets
 * (resolve cho dữ liệu PENDING legacy từ thời LAZY).
 *  - sync fail-soft: auth KHÔNG fail khi sync return 0 (lỗi được nuốt bên
 *    trong syncTicketsByEmail); nếu sync throw thật thì auth fail — chốt
 *    contract "fail-soft phải nằm trong syncTicketsByEmail, KHÔNG ở trigger".
 *
 * Mock Prisma + JwtService + bcrypt + TicketService (spy sync/resolve).
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

// Mock bcrypt: register không mất ~100ms hash thật; login so với fake hash
// '$2b$10$abcdefghijklmnopqrstuv' (salt invalid) mà vẫn pass.
jest.mock('bcrypt', () => ({
  hash: jest.fn(async () => '$2b$10$mockedhashvalueforregister'),
  compare: jest.fn(async () => true),
}));

import { AuthService } from './auth.service';
import { TicketService } from '../ticket/ticket.service';
import { generateEmailHash } from '../../common/utils/email-hash.util';

const EMAIL = 'trigger@example.com';
const HASH = generateEmailHash(EMAIL);

function makeUser() {
  return {
    id: 'user-trigger-1',
    email: EMAIL,
    emailHash: HASH,
    passwordHash: '$2b$10$abcdefghijklmnopqrstuv',
    displayName: null,
    role: 'USER',
  };
}

/** TicketService mock — spy sync/resolve mà AuthService gọi. */
function makeTicketServiceMock() {
  return {
    syncTicketsByEmail: jest.fn(async () => 2),
    resolvePendingPreTickets: jest.fn(async () => 1),
  };
}

/**
 * @param existingUser findUnique trả user? login cần true; register cần false
 * (nếu không register dính ConflictException "email already exists").
 */
function makeAuthService(existingUser = false) {
  const ticketService = makeTicketServiceMock();
  const prisma = {
    portalUser: {
      findUnique: jest.fn(async () => (existingUser ? makeUser() : null)),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...makeUser(),
        ...data,
      })),
    },
  };
  const jwtService = { signAsync: jest.fn(async () => 'test-token') };
  const service = new AuthService(
    prisma as never,
    jwtService as never,
    ticketService as unknown as TicketService,
  );
  return { service, ticketService };
}

describe('AuthService T6 triggers (register/login — mint bắt buộc, dual-path)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('dual-path: sync luôn chạy + resolve PENDING legacy (F-09)', () => {
    it('register → syncTicketsByEmail ĐƯỢC gọi với (userId, emailHash) đúng', async () => {
      const { service, ticketService } = makeAuthService();

      const res = await service.register({ email: EMAIL, password: 'Passw0rd!123' } as never);

      expect(ticketService.syncTicketsByEmail).toHaveBeenCalledWith('user-trigger-1', HASH);
      expect(res.claimedTickets).toBe(3); // synced 2 + resolved 1
    });

    it('login → syncTicketsByEmail ĐƯỢC gọi với (userId, emailHash) từ DB', async () => {
      const { service, ticketService } = makeAuthService(true);

      const res = await service.login({ email: EMAIL, password: 'Passw0rd!123' } as never);

      expect(ticketService.syncTicketsByEmail).toHaveBeenCalledWith('user-trigger-1', HASH);
      expect(res.claimedTickets).toBe(3);
    });

    it('F-09: vẫn resolve cả PENDING cũ — claimedTickets = synced + resolved', async () => {
      const { service, ticketService } = makeAuthService(true);

      const res = await service.login({ email: EMAIL, password: 'Passw0rd!123' } as never);

      expect(ticketService.resolvePendingPreTickets).toHaveBeenCalledWith('user-trigger-1', HASH);
      expect(res.claimedTickets).toBe(3);
    });

    it('sync fail-soft đúng (return 0 khi content lỗi) → login VẪN thành công, claimedTickets = resolved', async () => {
      const { service, ticketService } = makeAuthService(true);
      // syncTicketsByEmail thật KHÔNG throw — nội bộ S5 nuốt lỗi, return 0.
      (ticketService.syncTicketsByEmail as jest.Mock).mockResolvedValueOnce(0);

      const res = await service.login({ email: EMAIL, password: 'Passw0rd!123' } as never);

      expect(res.claimedTickets).toBe(1); // 0 synced + 1 resolved
    });

    it('sync throw thật (fail-soft bị phá) → login fail — chốt contract fail-soft nằm TRONG syncTicketsByEmail', async () => {
      const { service, ticketService } = makeAuthService(true);
      // claimAtAuth dùng Promise.all — 1 reject → cả 2 reject → login throw.
      // Đây là lý do S5 (catch + return 0) phải nằm trong syncTicketsByEmail,
      // KHÔNG phải ở trigger. Test bắt regression nếu ai bỏ try/catch đó.
      (ticketService.syncTicketsByEmail as jest.Mock).mockRejectedValueOnce(
        new Error('sync exploded'),
      );

      await expect(
        service.login({ email: EMAIL, password: 'Passw0rd!123' } as never),
      ).rejects.toThrow('sync exploded');
    });
  });
});
