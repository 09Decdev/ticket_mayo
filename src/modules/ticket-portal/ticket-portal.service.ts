import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ContentClientService } from '../content-client/content-client.service';
import { TicketService } from '../ticket/ticket.service';

type ContentTicketView = {
  id: string;
  ticketCode: string;
  status: string;
  checkedInAt: string | null;
  createdAt: string;
  imageUrl?: string | null;
  ticketType?: { id: string; name: string; typeCode?: string | null; price?: string };
  event?: { id: string; title: string; startTime?: string; endTime?: string; address?: string; status?: string } | null;
};

/**
 * Portal tickets → content-service (quyền sở hữu do content kiểm tra theo userId).
 */
@Injectable()
export class TicketPortalService {
  private readonly logger = new Logger(TicketPortalService.name);
  private static readonly MAX_BANNER_BYTES = 5 * 1024 * 1024;

  constructor(
    private readonly content: ContentClientService,
    private readonly prisma: PrismaService,
    private readonly ticketService: TicketService,
  ) {}

  async listMyTickets(userId: string) {
    // Đồng bộ vé trước khi liệt kê: sync MINTED-unlinked qua content
    // link-by-email; PENDING legacy (F-09, dữ liệu từ thời LAZY) vẫn được
    // resolve — claimedTickets = tổng.
    let claimedTickets = 0;
    const user = await this.prisma.portalUser.findUnique({ where: { id: userId } });
    if (user) {
      const [synced, resolved] = await Promise.all([
        this.ticketService.syncTicketsByEmail(userId, user.emailHash),
        this.ticketService.resolvePendingPreTickets(userId, user.emailHash),
      ]);
      claimedTickets = synced + resolved;
    }
    const { tickets } = await this.content.getUserTickets(userId);
    return {
      tickets: tickets.map((t: ContentTicketView) => this.mapView(t)),
      claimedTickets,
    };
  }

  async getTicket(id: string, userId: string) {
    const ticket = await this.content.getTicket(id, userId);
    return this.mapView(ticket as ContentTicketView);
  }

  private mapView(t: ContentTicketView) {
    return {
      id: t.id,
      ticketCode: t.ticketCode,
      status: t.status,
      ticketType: { name: t.ticketType?.name ?? 'Vé' },
      event: { name: t.event?.title ?? 'Sự kiện' },
      checkedInAt: t.checkedInAt ?? null,
      qrPayload: t.ticketCode,
      bannerUrl: t.imageUrl ?? null,
    };
  }

  /**
   * Ảnh banner của vé (hình event lúc mint, từ content-service imageUrl).
   * Fetch proxy qua backend vì URL gốc thường là presigned S3 — trình duyệt
   * không đọc được pixel nếu thiếu CORS; qua endpoint này ảnh luôn same-origin.
   * Trả null khi: không có ảnh / URL không phải http(s) / fetch lỗi / quá
   * 5MB — caller (download PDF) fallback gradient, KHÔNG fail cả trang.
   */
  async getTicketBannerImage(
    id: string,
    userId: string,
  ): Promise<{ buffer: Buffer; contentType: string } | null> {
    const ticket = (await this.content.getTicket(id, userId)) as ContentTicketView;
    const url = ticket?.imageUrl;
    if (!url) return null;

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        this.logger.warn(`[BANNER] fetch ${res.status} cho vé ${id} — bỏ banner`);
        return null;
      }
      const contentType = res.headers.get('content-type') ?? 'image/jpeg';
      if (!contentType.startsWith('image/')) return null;
      const ab = await res.arrayBuffer();
      if (ab.byteLength > TicketPortalService.MAX_BANNER_BYTES) return null;
      return { buffer: Buffer.from(ab), contentType };
    } catch (err) {
      this.logger.warn(`[BANNER] fetch lỗi vé ${id}: ${(err as Error).message}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}