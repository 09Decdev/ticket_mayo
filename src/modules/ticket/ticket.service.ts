import { Injectable, Logger } from '@nestjs/common';
import { PreTicket } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ContentClientService } from '../content-client/content-client.service';

export interface ResolvedContentTicket {
  id: string;
  ticketCode: string;
  status: string;
}

/**
 * Owns PreTicket → content Ticket resolution (the "claim" write path).
 *
 * Vé thật nằm ở content-service: khi claim, gọi inbound issue để content tạo
 * Ticket (ticketCode qua sequence, purchasePrice 0). PreTicket chỉ giữ snapshot
 * + contentTicketId/contentTicketCode cho việc nối vé cứng.
 */
@Injectable()
export class TicketService {
  private readonly logger = new Logger(TicketService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly content: ContentClientService,
  ) {}

  /** Resolve ALL pending PreTickets cho một user (register / login flow). */
  async resolvePendingPreTickets(userId: string, emailHash: string): Promise<number> {
    const pending = await this.prisma.preTicket.findMany({
      where: { recipientEmailHash: emailHash, status: 'PENDING' },
    });
    if (pending.length === 0) return 0;

    let resolved = 0;
    for (const pt of pending) {
      try {
        await this.resolvePreTicket(pt, userId);
        resolved++;
      } catch (err) {
        this.logger.error(`resolve pending preticket ${pt.id} failed: ${(err as Error).message}`);
      }
    }
    this.logger.log(`resolved ${resolved} PreTickets for user=${userId}`);
    return resolved;
  }

  /** Resolve một PreTicket (claim-link flow). Idempotent: bỏ qua nếu không còn PENDING. */
  async resolvePreTicket(preTicket: PreTicket, userId: string): Promise<ResolvedContentTicket | null> {
    // B2 race: chiếm khóa atomic PENDING→CLAIMING TRƯỚC HTTP issue — chỉ 1
    // caller đồng thời được count===1; loser trả null, tránh 2 vé thật mint.
    const locked = await this.prisma.preTicket.updateMany({
      where: { id: preTicket.id, status: 'PENDING' },
      data: { status: 'CLAIMING' },
    });
    if (locked.count === 0) {
      return null;
    }

    try {
      const result = await this.content.issueTickets({
        eventId: preTicket.eventId,
        ticketTypeId: preTicket.ticketTypeId,
        userId,
        quantity: 1,
      });
      const ticket = result.tickets[0];
      if (!ticket) {
        throw new Error(`content issue returned no ticket for preTicket ${preTicket.id}`);
      }

      const finalized = await this.prisma.preTicket.updateMany({
        where: { id: preTicket.id, status: 'CLAIMING' },
        data: {
          status: 'CLAIMED',
          claimedAt: new Date(),
          contentTicketId: ticket.id,
          contentTicketCode: ticket.ticketCode,
        },
      });
      if (finalized.count === 0) {
        throw new Error(`preTicket ${preTicket.id} lost CLAIMING lock before finalize`);
      }

      void this.audit.record({
        jobId: preTicket.jobId,
        emailHash: preTicket.recipientEmailHash,
        action: 'PRETICKET_CLAIMED',
        detail: { preTicketId: preTicket.id, contentTicketId: ticket.id, userId },
      });

      return { id: ticket.id, ticketCode: ticket.ticketCode, status: ticket.status };
    } catch (err) {
      // Nhả khóa để retry hợp lệ chạy lại được.
      await this.prisma.preTicket
        .updateMany({ where: { id: preTicket.id, status: 'CLAIMING' }, data: { status: 'PENDING' } })
        .catch((rbErr) =>
          this.logger.error(`rollback preTicket ${preTicket.id} CLAIMING→PENDING failed: ${(rbErr as Error).message}`),
        );
      throw err;
    }
  }

  /**
   * Sync vé MINTED-chưa-link về PortalUser (T6, DESIGN §5.1 S1-S5).
   * EAGER mode: PreTicket MINTED + recipientUserId NULL → gọi content
   * link-by-email gắn vé thật về user, rồi mark LINKED.
   *
   * FAIL-SOFT (§5.5): KHÔNG BAO GIỜ throw ra ngoài — mọi lỗi (timeout/5xx/
   * 429/lỗi DB) chỉ log warn + return 0. Register/login/list-my-tickets
   * không được fail vì sync lỗi; trigger kế tiếp sẽ retry.
   *
   * TM-3: log chỉ dùng emailHash, KHÔNG BAO GIỜ plaintext email.
   */
  async syncTicketsByEmail(userId: string, emailHash: string): Promise<number> {
    try {
      // S2 short-circuit: không có MINTED-unlinked → return 0 ngay (0 HTTP
      // call — index [recipientEmailHash, status] phủ).
      const first = await this.prisma.preTicket.findFirst({
        where: { recipientEmailHash: emailHash, status: 'MINTED', recipientUserId: null },
        select: { id: true, jobId: true },
      });
      if (!first) {
        return 0;
      }

      // S3: gọi content link-by-email (idempotent).
      const content = await this.content.linkByEmail(emailHash, userId);

      // S4: mark LINKED toàn bộ MINTED-unlinked — chạy KỂ CẢ khi N=0
      // (idempotent, dọn PreTicket mồ côi khi vé content đã có userId từ
      // nguồn khác). Guard recipientUserId: null chống double-mark khi 2
      // sync chạy đồng thời. KHÔNG set linkedAt (schema không có cột —
      // tránh migration; claimedAt chỉ dùng cho lazy path).
      const marked = await this.prisma.preTicket.updateMany({
        where: { recipientEmailHash: emailHash, status: 'MINTED', recipientUserId: null },
        data: { status: 'LINKED', recipientUserId: userId },
      });

      const linked = marked.count;
      // Số content trả về có thể KHÁC updateMany.count (PreTicket mồ côi —
      // ví dụ đã link từ job khác) → log cả hai để đối chiếu.
      this.logger.log(
        `sync emailHash=${emailHash} userId=${userId} linked=${linked} contentLinked=${content?.linked ?? 0}`,
      );

      // Audit 1 record cho cả batch — jobId bắt buộc, dùng PreTicket đầu.
      void this.audit.record({
        jobId: first.jobId,
        emailHash,
        action: 'PRETICKET_SYNCED',
        detail: { linked, contentLinked: content?.linked ?? 0, userId },
      });

      return linked;
    } catch (err) {
      // S5 fail-soft: log warn (TM-3 — chỉ emailHash) + return 0.
      this.logger.warn(
        `sync emailHash=${emailHash} userId=${userId} failed (fail-soft): ${(err as Error).message}`,
      );
      return 0;
    }
  }
}