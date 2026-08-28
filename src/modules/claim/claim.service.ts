import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { TicketService } from '../ticket/ticket.service';
import { RequestUser } from '../../common/guards/jwt-auth.guard';

export interface ClaimResult {
  ok?: boolean;
  alreadyClaimed?: boolean;
  needsAuth?: boolean;
  ticketId?: string | null;
  /** RB-2: PreTicket MINTING/CLAIMING — mint đang chạy, thử lại sau. */
  processing?: boolean;
  /** RB-2: PreTicket EXPIRED — vé đã hết hạn. */
  expired?: boolean;
}

@Injectable()
export class ClaimService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ticketService: TicketService,
  ) {}

  /**
   * Resolve a claim token — STATE-FIRST (F-08, T6): switch theo
   * PreTicket.status trước, KHÔNG phân tích theo mode (§8.2 — state machine
   * là nguồn sự thật xuyên suốt; flag chỉ chọn chiến lược mint khi TẠO dữ
   * liệu, nên MINTED luôn đi sync path kể cả khi flag đã rollback về LAZY).
   * - Token not found → 404.
   * - CLAIMED → alreadyClaimed.
   * - LINKED (EAGER đã sync) → alreadyClaimed — vé đã gắn user, không mint.
   * - MINTING/CLAIMING → processing (RB-2 — mint đang chạy).
   * - EXPIRED → expired (RB-2 — trung thực theo trạng thái).
   * - MINTED (EAGER đã mint, chưa link): user đã đăng nhập + emailHash khớp
   *   → syncTicketsByEmail rồi trả alreadyClaimed (redirect portal, KHÔNG
   *   mint); sync trả 0 (fail-soft) → KHÔNG kèm ticketId (vé chưa link —
   *   tránh frontend vào detail 404); chưa đăng nhập → needsAuth.
   * - PENDING (dữ liệu LAZY cũ — kể cả khi flag EAGER, F-09) → lazy-mint
   *   path resolvePreTicket như cũ.
   * - EmailHash không khớp / user không tồn tại → needsAuth (no email leak).
   *
   * §8.3: userId/emailHash đưa vào syncTicketsByEmail LUÔN là của user đã
   * verify JWT + khớp DB — không bao giờ từ client query/body.
   */
  async claim(token: string, requestingUser?: RequestUser): Promise<ClaimResult> {
    const preTicket = await this.prisma.preTicket.findUnique({
      where: { claimToken: token },
    });
    if (!preTicket) {
      throw new NotFoundException('Claim token not found.');
    }
    if (preTicket.status === 'CLAIMED') {
      return { ok: true, alreadyClaimed: true, ticketId: preTicket.contentTicketId };
    }
    if (preTicket.status === 'LINKED') {
      // Đã sync về user từ trigger khác (register/login/list) — idempotent.
      return { ok: true, alreadyClaimed: true, ticketId: preTicket.contentTicketId };
    }
    // RB-2 state contract: transient/expired trả thông báo trung thực theo
    // trạng thái (L724) — KHÔNG rơi xuống lazy-mint path.
    if (preTicket.status === 'MINTING' || preTicket.status === 'CLAIMING') {
      return { ok: true, processing: true };
    }
    if (preTicket.status === 'EXPIRED') {
      return { ok: true, expired: true };
    }

    if (!requestingUser) {
      return { needsAuth: true };
    }

    const user = await this.prisma.portalUser.findUnique({
      where: { id: requestingUser.id },
    });
    if (!user || user.emailHash !== preTicket.recipientEmailHash) {
      // Token valid but user does not match recipient — never leak the email.
      return { needsAuth: true };
    }

    // E1 state-first (§8.2): MINTED + logged-in + email khớp → sync rồi
    // redirect. KHÔNG phụ thuộc mode — khi rollback flag về LAZY mà còn
    // PreTicket MINTED (EAGER-era) thì user vẫn phải xem được vé (state
    // machine là nguồn sự thật xuyên suốt; flag chỉ chọn chiến lược mint
    // khi TẠO dữ liệu). Sync idempotent + fail-soft, vô hại khi LAZY.
    if (preTicket.status === 'MINTED') {
      const synced = await this.ticketService.syncTicketsByEmail(user.id, user.emailHash);
      // Sync fail-soft trả 0 (content chết/429/DB lỗi) → vé CHƯA link về
      // user → KHÔNG trả ticketId để frontend không navigate vào detail
      // rồi 404/502. Đã sync 1+ vé (kể cả vé khác) → vé này giờ thuộc
      // user, redirect detail an toàn.
      if (synced === 0) {
        return { ok: true, alreadyClaimed: true, ticketId: null, processing: true };
      }
      return { ok: true, alreadyClaimed: true, ticketId: preTicket.contentTicketId };
    }

    // PENDING (kể cả EAGER — F-09 dữ liệu cũ) và các trạng thái transient
    // khác → lazy-mint path cũ (resolvePreTicket tự bỏ qua nếu không còn
    // PENDING — idempotent).
    const ticket = await this.ticketService.resolvePreTicket(preTicket, user.id);
    return { ok: true, ticketId: ticket?.id ?? null, alreadyClaimed: false };
  }
}
