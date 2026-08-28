/**
 * T6 — listMyTickets trigger test (sync luôn chạy + F-09 resolve PENDING legacy)
 * và claim state-first test (F-08 §8.2: MINTED → sync redirect, LINKED →
 * alreadyClaimed, PENDING → resolve fallback cho dữ liệu legacy, mismatch →
 * needsAuth; RB-2: MINTING/CLAIMING → processing, EXPIRED → expired;
 * MINOR-B: sync fail-soft 0 → KHÔNG kèm ticketId).
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

import { TicketPortalService } from './ticket-portal.service';
import { ClaimService } from '../claim/claim.service';
import { TicketService } from '../ticket/ticket.service';
import { generateEmailHash } from '../../common/utils/email-hash.util';

const EMAIL = 'portal@example.com';
const HASH = generateEmailHash(EMAIL);
const USER_ID = 'user-portal-1';
const OTHER_HASH = generateEmailHash('other@example.com');

function makeUser() {
  return { id: USER_ID, email: EMAIL, emailHash: HASH, displayName: null, role: 'USER' };
}

function makeTicketServiceMock() {
  return {
    syncTicketsByEmail: jest.fn(async () => 2),
    resolvePendingPreTickets: jest.fn(async () => 1),
    resolvePreTicket: jest.fn(async () => ({ id: 'tk-new', ticketCode: 'TK-NEW', status: 'ACTIVE' })),
  };
}

function makePortalService() {
  const ticketService = makeTicketServiceMock();
  const prisma = {
    portalUser: { findUnique: jest.fn(async () => makeUser()) },
  };
  const content = {
    getUserTickets: jest.fn(async () => ({
      tickets: [{ id: 'tk-1', ticketCode: 'TK-1', status: 'ACTIVE', checkedInAt: null, createdAt: new Date().toISOString() }],
    })),
  };
  const service = new TicketPortalService(
    content as never,
    prisma as never,
    ticketService as unknown as TicketService,
  );
  return { service, ticketService };
}

function makeClaimService(preTicket: Record<string, unknown>) {
  const ticketService = makeTicketServiceMock();
  const prisma = {
    preTicket: { findUnique: jest.fn(async () => preTicket) },
    portalUser: { findUnique: jest.fn(async () => makeUser()) },
  };
  const service = new ClaimService(prisma as never, ticketService as unknown as TicketService);
  return { service, ticketService };
}

describe('TicketPortalService.listMyTickets — T6 trigger', () => {
  beforeEach(() => jest.clearAllMocks());

  it('syncTicketsByEmail + resolvePendingPreTickets luôn chạy, claimedTickets = tổng', async () => {
    const { service, ticketService } = makePortalService();

    const res = await service.listMyTickets(USER_ID);

    expect(ticketService.syncTicketsByEmail).toHaveBeenCalledWith(USER_ID, HASH);
    expect(ticketService.resolvePendingPreTickets).toHaveBeenCalledWith(USER_ID, HASH);
    expect(res.claimedTickets).toBe(3); // 2 synced + 1 resolved
    expect(res.tickets).toHaveLength(1);
  });
});

describe('ClaimService.claim — T6 state-first (F-08)', () => {
  beforeEach(() => jest.clearAllMocks());

  const REQ_USER = { id: USER_ID, email: EMAIL, role: 'USER' } as never;

  it('token không tồn tại → 404', async () => {
    const ticketService = makeTicketServiceMock();
    const prisma = {
      preTicket: { findUnique: jest.fn(async () => null) },
      portalUser: { findUnique: jest.fn(async () => makeUser()) },
    };
    const service = new ClaimService(prisma as never, ticketService as unknown as TicketService);
    await expect(service.claim('nope-token')).rejects.toMatchObject({ status: 404 });
  });

  it('PreTicket MINTED + logged-in + emailHash khớp → sync + alreadyClaimed, KHÔNG mint', async () => {
    const preTicket = { id: 'pt-1', claimToken: 'tok-1', recipientEmailHash: HASH, status: 'MINTED', contentTicketId: 'tk-minted', jobId: 'job-1' };
    const { service, ticketService } = makeClaimService(preTicket);

    const res = await service.claim('tok-1', REQ_USER);

    expect(ticketService.syncTicketsByEmail).toHaveBeenCalledWith(USER_ID, HASH);
    expect(ticketService.resolvePreTicket).not.toHaveBeenCalled();
    expect(res).toEqual({ ok: true, alreadyClaimed: true, ticketId: 'tk-minted' });
  });

  it('PreTicket MINTED + CHƯA đăng nhập → needsAuth (không sync, không mint)', async () => {
    const preTicket = { id: 'pt-1', claimToken: 'tok-1', recipientEmailHash: HASH, status: 'MINTED', contentTicketId: 'tk-minted', jobId: 'job-1' };
    const { service, ticketService } = makeClaimService(preTicket);

    const res = await service.claim('tok-1');

    expect(ticketService.syncTicketsByEmail).not.toHaveBeenCalled();
    expect(ticketService.resolvePreTicket).not.toHaveBeenCalled();
    expect(res).toEqual({ needsAuth: true });
  });

  it('PreTicket LINKED → alreadyClaimed (idempotent — đã sync từ trigger khác)', async () => {
    const preTicket = { id: 'pt-2', claimToken: 'tok-2', recipientEmailHash: HASH, status: 'LINKED', contentTicketId: 'tk-linked', jobId: 'job-1' };
    const { service, ticketService } = makeClaimService(preTicket);

    const res = await service.claim('tok-2', REQ_USER);

    expect(ticketService.syncTicketsByEmail).not.toHaveBeenCalled();
    expect(ticketService.resolvePreTicket).not.toHaveBeenCalled();
    expect(res).toEqual({ ok: true, alreadyClaimed: true, ticketId: 'tk-linked' });
  });

  it('PreTicket PENDING (F-09 dữ liệu cũ) → resolve fallback resolvePreTicket', async () => {
    const preTicket = { id: 'pt-3', claimToken: 'tok-3', recipientEmailHash: HASH, status: 'PENDING', contentTicketId: null, jobId: 'job-1' };
    const { service, ticketService } = makeClaimService(preTicket);

    const res = await service.claim('tok-3', REQ_USER);

    expect(ticketService.resolvePreTicket).toHaveBeenCalledWith(preTicket, USER_ID);
    expect(res).toEqual({ ok: true, ticketId: 'tk-new', alreadyClaimed: false });
  });

  it('PreTicket MINTED còn sót + logged-in + khớp → VẪN sync (state-first §8.2)', async () => {
    // DESIGN §8.2: state machine là nguồn sự thật xuyên suốt — mint chiến
    // lược chỉ chọn lúc TẠO dữ liệu. PreTicket MINTED còn lại thì user vẫn
    // phải xem được vé; sync idempotent + fail-soft vô hại.
    const preTicket = { id: 'pt-4', claimToken: 'tok-4', recipientEmailHash: HASH, status: 'MINTED', contentTicketId: 'tk-minted', jobId: 'job-1' };
    const { service, ticketService } = makeClaimService(preTicket);

    const res = await service.claim('tok-4', REQ_USER);

    expect(ticketService.syncTicketsByEmail).toHaveBeenCalledWith(USER_ID, HASH);
    expect(ticketService.resolvePreTicket).not.toHaveBeenCalled();
    expect(res).toEqual({ ok: true, alreadyClaimed: true, ticketId: 'tk-minted' });
  });

  it('MINOR-B: MINTED + sync fail-soft trả 0 → KHÔNG kèm ticketId (frontend không vào detail 404)', async () => {
    const preTicket = { id: 'pt-7', claimToken: 'tok-7', recipientEmailHash: HASH, status: 'MINTED', contentTicketId: 'tk-minted', jobId: 'job-1' };
    const { service, ticketService } = makeClaimService(preTicket);
    (ticketService.syncTicketsByEmail as jest.Mock).mockResolvedValueOnce(0);

    const res = await service.claim('tok-7', REQ_USER);

    expect(ticketService.syncTicketsByEmail).toHaveBeenCalledWith(USER_ID, HASH);
    expect(ticketService.resolvePreTicket).not.toHaveBeenCalled();
    // ticketId null + processing → frontend vào list thay vì detail (vé
    // chưa link về user — getTicket sẽ 404/502).
    expect(res).toEqual({ ok: true, alreadyClaimed: true, ticketId: null, processing: true });
    expect(res.ticketId).toBeFalsy();
  });

  it('RB-2: PreTicket MINTING → processing:true (mint đang chạy, trung thực theo trạng thái)', async () => {
    const preTicket = { id: 'pt-8', claimToken: 'tok-8', recipientEmailHash: HASH, status: 'MINTING', contentTicketId: null, jobId: 'job-1' };
    const { service, ticketService } = makeClaimService(preTicket);

    const res = await service.claim('tok-8', REQ_USER);

    expect(res).toEqual({ ok: true, processing: true });
    expect(ticketService.syncTicketsByEmail).not.toHaveBeenCalled();
    expect(ticketService.resolvePreTicket).not.toHaveBeenCalled();
  });

  it('RB-2: PreTicket CLAIMING → processing:true (resolve đang chạy)', async () => {
    const preTicket = { id: 'pt-9', claimToken: 'tok-9', recipientEmailHash: HASH, status: 'CLAIMING', contentTicketId: null, jobId: 'job-1' };
    const { service, ticketService } = makeClaimService(preTicket);

    const res = await service.claim('tok-9', REQ_USER);

    expect(res).toEqual({ ok: true, processing: true });
    expect(ticketService.syncTicketsByEmail).not.toHaveBeenCalled();
    expect(ticketService.resolvePreTicket).not.toHaveBeenCalled();
  });

  it('RB-2: PreTicket EXPIRED → expired:true (vé đã hết hạn)', async () => {
    const preTicket = { id: 'pt-10', claimToken: 'tok-10', recipientEmailHash: HASH, status: 'EXPIRED', contentTicketId: null, jobId: 'job-1' };
    const { service, ticketService } = makeClaimService(preTicket);

    const res = await service.claim('tok-10', REQ_USER);

    expect(res).toEqual({ ok: true, expired: true });
    expect(ticketService.syncTicketsByEmail).not.toHaveBeenCalled();
    expect(ticketService.resolvePreTicket).not.toHaveBeenCalled();
  });

  it('RB-2: EXPIRED + CHƯA đăng nhập → vẫn expired:true (không bắt signup cho vé hết hạn)', async () => {
    // EXPIRED/MINTING/CLAIMING trả trước auth check (giữ pattern CLAIMED/
    // LINKED) — trạng thái không phụ thuộc người hỏi, không leak PII.
    const preTicket = { id: 'pt-11', claimToken: 'tok-11', recipientEmailHash: HASH, status: 'EXPIRED', contentTicketId: null, jobId: 'job-1' };
    const { service } = makeClaimService(preTicket);

    const res = await service.claim('tok-11');

    expect(res).toEqual({ ok: true, expired: true });
  });

  it('logged-in user emailHash KHÔNG khớp → needsAuth (no email leak)', async () => {
    const preTicket = { id: 'pt-5', claimToken: 'tok-5', recipientEmailHash: OTHER_HASH, status: 'MINTED', contentTicketId: 'tk-x', jobId: 'job-1' };
    const { service, ticketService } = makeClaimService(preTicket);

    const res = await service.claim('tok-5', REQ_USER);

    expect(ticketService.syncTicketsByEmail).not.toHaveBeenCalled();
    expect(ticketService.resolvePreTicket).not.toHaveBeenCalled();
    expect(res).toEqual({ needsAuth: true });
  });

  it('PreTicket CLAIMED → alreadyClaimed như cũ (regression)', async () => {
    const preTicket = { id: 'pt-6', claimToken: 'tok-6', recipientEmailHash: HASH, status: 'CLAIMED', contentTicketId: 'tk-claimed', jobId: 'job-1' };
    const { service, ticketService } = makeClaimService(preTicket);

    const res = await service.claim('tok-6', REQ_USER);

    expect(res).toEqual({ ok: true, alreadyClaimed: true, ticketId: 'tk-claimed' });
    expect(ticketService.resolvePreTicket).not.toHaveBeenCalled();
  });
});
