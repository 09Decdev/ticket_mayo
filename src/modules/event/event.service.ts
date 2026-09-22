import { Injectable, NotFoundException } from '@nestjs/common';
import { ContentClientService } from '../content-client/content-client.service';
import { CreateEventDto } from './dtos/create-event.dto';
import { UpdateEventDto } from './dtos/update-event.dto';
import {
  CreateTicketTypeDto,
  UpdateTicketTypeAppearanceDto,
  UpdateTicketTypeBasicDto,
} from './dtos/create-ticket-type.dto';
import { UpdateTicketTypeDto } from './dtos/update-ticket-type.dto';

type ContentEvent = {
  id: string;
  title: string;
  description?: string | null;
  address: string;
  city: string;
  startTime: string;
  endTime: string;
  status: string;
  serialPrefix?: string | null;
  eventImageUrl?: string | null;
  /** EVENT-EDIT: sức chứa hiện tại của event (content maxParticipants). */
  maxParticipants?: number | null;
};
type ContentTicketType = {
  id: string;
  eventId: string;
  name: string;
  typeCode?: string | null;
  price: string;
  quantity: number;
  sold: number;
  remaining: number;
  maxTicketsPerUser: number | null;
  note?: string | null;
  /** VÉ-EMAIL: true = chỉ phát qua email, được chọn ở bước phát vé. */
  emailDistribution?: boolean;
  /** VÉ-MIỄN-PHÍ-MINH-CHỨNG: true = yêu cầu ảnh minh chứng trước khi phát vé. */
  requireProof?: boolean;
  /** VÉ-MIỄN-PHÍ-MINH-CHỨNG: mô tả nhiệm vụ cho AI kiểm tra ảnh. */
  proofTaskDescription?: string | null;
  /** TICKET-APPEARANCE: file id ảnh riêng của loại vé (upload-service). */
  ticketImageFileId?: string | null;
  /** TICKET-APPEARANCE: màu module QR (dark), hex #RGB/#RRGGBB. */
  qrForegroundColor?: string | null;
  /** TICKET-APPEARANCE: màu nền QR (light), hex #RGB/#RRGGBB. */
  qrBackgroundColor?: string | null;
  /** TICKET-APPEARANCE: presigned URL ảnh riêng (đã resolve ở content). */
  ticketImageUrl?: string | null;
  event?: {
    id: string;
    title: string;
    startTime: string;
    endTime: string;
    address: string;
    eventImageUrl?: string | null;
  } | null;
};

/**
 * Event / TicketType proxy → content-service (nguồn sự thật).
 * Map shape content -> shape cũ của ticket-mayo để frontend không đổi.
 */
@Injectable()
export class EventService {
  constructor(private readonly content: ContentClientService) {}

  // ─── Events ───
  async listEvents(search?: string) {
    const events = await this.content.getEvents({ search });
    return events.map((e) => this.mapEvent(e));
  }

  async createEvent(dto: CreateEventDto) {
    const created = await this.content.createEvent({
      title: dto.name,
      description: null,
      address: dto.venue ?? '',
      city: '',
      startTime: dto.startAt ? new Date(dto.startAt) : new Date(),
      endTime: dto.endAt ? new Date(dto.endAt) : new Date(),
      status: 'PUBLISHED',
    });
    return this.mapEvent(created);
  }

  async updateEvent(id: string, dto: UpdateEventDto) {
    const body: Record<string, string | number> = {};
    if (dto.name !== undefined) body.title = dto.name;
    if (dto.venue !== undefined) body.address = dto.venue;
    if (dto.startAt !== undefined) body.startTime = dto.startAt;
    if (dto.endAt !== undefined) body.endTime = dto.endAt;
    // EVENT-EDIT: sức chứa — content validate >= số đã đăng ký, thấp hơn →
    // 400 EVENT_MAX_PARTICIPANTS_BELOW_REGISTERED kèm registeredCount
    // (HttpException pass-through — frontend hiển thị min sức chứa).
    if (dto.maxParticipants !== undefined) body.maxParticipants = dto.maxParticipants;
    const updated = await this.content.updateEvent(id, body);
    return this.mapEvent(updated);
  }

  /**
   * Dữ liệu cho edit screen admin (EVENT-EDIT): các field cần để sửa
   * name/venue/startAt/endAt/maxParticipants. maxParticipants hiện tại để
   * điền form; số đã đăng ký (registeredCount) lấy từ lỗi 400 của content
   * khi admin nhập thấp hơn (server re-read, không tin client).
   */
  async getEventForEdit(id: string) {
    const e = await this.content.getEvent(id);
    if (!e) throw new NotFoundException(`Event ${id} not found.`);
    return this.mapEvent(e);
  }

  // ─── Ticket types ───
  async listTicketTypes(eventId?: string) {
    if (eventId) {
      const types = await this.content.getEventTicketTypes(eventId);
      return types.map((t) => this.mapTicketType(t));
    }
    // Không có eventId → flatten theo mọi event.
    const events = await this.content.getEvents({});
    const groups = await Promise.all(
      events.map((e) => this.content.getEventTicketTypes(e.id).catch(() => [])),
    );
    return groups.flat().map((t) => this.mapTicketType(t as ContentTicketType));
  }

  async createTicketType(dto: CreateTicketTypeDto) {
    const created = await this.content.createTicketType({
      eventId: dto.eventId,
      name: dto.name,
      price: dto.price ?? 0,
      quantity: dto.quota,
      typeCode: dto.codePrefix ?? undefined,
      // MAX-PER-USER: truyền thẳng content (content default 4 khi không gửi).
      maxTicketsPerUser: dto.maxTicketsPerUser ?? undefined,
      // VÉ-EMAIL: admin chọn lúc tạo (default false) — truyền thẳng content.
      emailDistribution: dto.emailDistribution ?? false,
      // VÉ-MIỄN-PHÍ-MINH-CHỨNG: truyền thẳng content (content validate mô tả
      // bắt buộc khi bật — 400 VALIDATION_ERROR nếu thiếu).
      requireProof: dto.requireProof ?? false,
      proofTaskDescription: dto.proofTaskDescription ?? undefined,
    });
    return this.mapTicketType(created);
  }

  async updateTicketType(id: string, dto: UpdateTicketTypeDto) {
    const body: Record<string, unknown> = {};
    if (dto.name !== undefined) body.name = dto.name;
    if (dto.price !== undefined) body.price = dto.price;
    if (dto.quota !== undefined) body.quantity = dto.quota;
    if (dto.codePrefix !== undefined) body.typeCode = dto.codePrefix;
    if (dto.eventId !== undefined) body.eventId = dto.eventId;
    const updated = await this.content.updateTicketType(id, body);
    return this.mapTicketType(updated);
  }

  /**
   * Edit screen admin: sửa name + quantity + (VÉ-MIỄN-PHÍ-MINH-CHỨNG)
   * requireProof/proofTaskDescription qua PATCH .../basic của content.
   * Content validate quantity >= sold và requireProof cần mô tả ở service
   * layer (không tin client) — vi phạm → 400 pass-through kèm sold/field
   * trong response body — frontend hiển thị min quantity / lỗi thiếu mô tả.
   */
  async updateTicketTypeBasic(
    id: string,
    dto: {
      name: string;
      quantity: number;
      maxTicketsPerUser?: number;
      requireProof?: boolean;
      proofTaskDescription?: string;
    },
  ) {
    const updated = await this.content.updateTicketTypeBasic(id, {
      name: dto.name,
      quantity: dto.quantity,
      maxTicketsPerUser: dto.maxTicketsPerUser,
      requireProof: dto.requireProof,
      proofTaskDescription: dto.proofTaskDescription,
    });
    return this.mapTicketType(updated);
  }

  /**
   * DELETE-INTERNAL: xóa loại vé qua DELETE .../ticket-types/:id của content.
   * Content (nguồn sự thật) hard-delete trong tx + AuditLog và validate
   * sold = 0 ở service layer (re-read DB, không tin client) — đã có vé
   * được cấp → 400 TICKET_TYPE_HAS_SOLD_TICKETS kèm sold (HttpException
   * pass-through để frontend hiển thị lý do chặn).
   */
  async deleteTicketType(id: string) {
    return this.content.deleteTicketType(id);
  }

  // ─── TICKET-APPEARANCE ───
  /**
   * Dữ liệu cho appearance screen admin (/admin/ticket-types/:id/appearance):
   * giá trị hiển thị hiện tại (ảnh riêng + màu QR + context event) để điền
   * form + render preview ngay khi mở trang.
   */
  async getTicketTypeAppearance(id: string) {
    const tt = await this.content.getTicketType(id);
    if (!tt) throw new NotFoundException(`Ticket type ${id} not found.`);
    return {
      id: tt.id,
      eventId: tt.eventId,
      name: tt.name,
      ticketImageFileId: (tt as ContentTicketType).ticketImageFileId ?? null,
      qrForegroundColor: (tt as ContentTicketType).qrForegroundColor ?? null,
      qrBackgroundColor: (tt as ContentTicketType).qrBackgroundColor ?? null,
      ticketImageUrl: (tt as ContentTicketType).ticketImageUrl ?? null,
      event: tt.event
        ? {
            id: tt.event.id,
            title: tt.event.title,
            startTime: tt.event.startTime,
            endTime: tt.event.endTime,
            address: tt.event.address,
            eventImageUrl: tt.event.eventImageUrl ?? null,
          }
        : null,
    };
  }

  /**
   * Lưu cấu hình hiển thị (ảnh riêng + màu QR) qua PATCH ticket-types/:id của
   * content (route updateTicketType đã nhận 3 field này — additive, không cần
   * endpoint mới). Content persist thẳng vào DB (nguồn sự thật).
   */
  async updateTicketTypeAppearance(id: string, dto: UpdateTicketTypeAppearanceDto) {
    const body: Record<string, string | null> = {};
    if (dto.ticketImageFileId !== undefined) body.ticketImageFileId = dto.ticketImageFileId;
    if (dto.qrForegroundColor !== undefined) body.qrForegroundColor = dto.qrForegroundColor;
    if (dto.qrBackgroundColor !== undefined) body.qrBackgroundColor = dto.qrBackgroundColor;
    const updated = await this.content.updateTicketType(id, body);
    // Trả về shape giống getTicketTypeAppearance để frontend cập nhật preview
    // sau save mà không cần refetch riêng.
    const fresh = await this.content.getTicketType(id).catch(() => null);
    const source = fresh ?? updated;
    return {
      id: source.id,
      eventId: source.eventId,
      name: source.name,
      ticketImageFileId: (source as ContentTicketType).ticketImageFileId ?? null,
      qrForegroundColor: (source as ContentTicketType).qrForegroundColor ?? null,
      qrBackgroundColor: (source as ContentTicketType).qrBackgroundColor ?? null,
      ticketImageUrl: (source as ContentTicketType).ticketImageUrl ?? null,
      event: (source as ContentTicketType).event ?? null,
    };
  }

  /**
   * Upload ảnh vé (multipart) lên upload-service → trả file id để frontend
   * PUT vào PATCH appearance. KHÔNG tự PATCH ticketImageFileId — để admin xem
   * preview trước khi bấm lưu (không ghi rác DB khi upload xong đổi ý).
   */
  async uploadTicketTypeImage(id: string, file: {
    buffer: Buffer;
    originalname: string;
    mimetype: string;
    size: number;
  }) {
    // 404 sớm khi loại vé không tồn tại — tránh upload file rác rồi mới fail.
    const tt = await this.content.getTicketType(id);
    if (!tt) throw new NotFoundException(`Ticket type ${id} not found.`);
    const uploaded = await this.content.uploadEventImage(file);
    return {
      ticketTypeId: id,
      fileId: uploaded.id,
      status: uploaded.status,
      type: uploaded.type,
    };
  }

  /**
   * Proxy presigned URL → bytes ảnh (same-origin) cho preview của admin UI —
   * trình duyệt chặn cross-origin GET SeaweedFS (CORS) nên phải đi qua backend.
   * Fail-soft trả 404 thay vì 500 (UI hiện placeholder).
   */
  async getTicketTypeImage(url: string) {
    if (!/^https?:\/\//i.test(url)) {
      throw new NotFoundException('Invalid image URL');
    }
    try {
      const res = await globalThis.fetch(url, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const contentType = res.headers.get('content-type') ?? 'image/png';
      if (!contentType.startsWith('image/')) throw new Error(`content-type ${contentType}`);
      const arrayBuf = await res.arrayBuffer();
      if (arrayBuf.byteLength > 5 * 1024 * 1024) throw new Error('image too large (>5MB)');
      return { buffer: Buffer.from(arrayBuf), contentType };
    } catch {
      // Không log presigned url (có signature) — fail-soft 404 cho UI.
      throw new NotFoundException('Image not available');
    }
  }  /** Resolve một ticket type (kèm event + số lượng) — dùng cho snapshot khi phát vé. */
  async getTicketTypeWithEvent(ticketTypeId: string): Promise<{    id: string;
    eventId: string;
    name: string;
    eventName: string;
    eventStartAt: Date | null;
    eventEndAt: Date | null;
    venue: string | null;
    eventImageUrl: string | null;
    quantity: number;
    sold: number;
    remaining: number;
    maxTicketsPerUser: number | null;
  }> {
    const tt = await this.content.getTicketType(ticketTypeId);
    if (!tt) throw new NotFoundException(`Ticket type ${ticketTypeId} not found.`);
    return {
      id: tt.id,
      eventId: tt.eventId,
      name: tt.name,
      eventName: tt.event?.title ?? '',
      eventStartAt: tt.event?.startTime ? new Date(tt.event.startTime) : null,
      eventEndAt: tt.event?.endTime ? new Date(tt.event.endTime) : null,
      venue: tt.event?.address ?? null,
      eventImageUrl: tt.event?.eventImageUrl ?? null,
      quantity: tt.quantity,
      sold: tt.sold,
      remaining: tt.remaining,
      maxTicketsPerUser: tt.maxTicketsPerUser ?? null,
    };
  }

  /**
   * Dữ liệu cho edit screen admin: name + quantity + (VÉ-MIỄN-PHÍ-MINH-CHỨNG)
   * requireProof/proofTaskDescription (sold hiển thị read-only làm min
   * quantity, remaining để hint).
   */
  async getTicketTypeForEdit(id: string) {
    const tt = await this.content.getTicketType(id);
    if (!tt) throw new NotFoundException(`Ticket type ${id} not found.`);
    return {
      id: tt.id,
      eventId: tt.eventId,
      name: tt.name,
      quantity: tt.quantity,
      sold: tt.sold,
      remaining: tt.remaining,
      // MAX-PER-USER: điền form edit số vé tối đa mỗi người nhận.
      maxTicketsPerUser: tt.maxTicketsPerUser ?? null,
      eventName: tt.event?.title ?? null,
      // VÉ-MIỄN-PHÍ-MINH-CHỨNG: điền form edit proof flag + mô tả nhiệm vụ.
      requireProof: (tt as ContentTicketType).requireProof ?? false,
      proofTaskDescription: (tt as ContentTicketType).proofTaskDescription ?? null,
    };
  }

  // ─── Mappers ───
  private mapEvent(e: ContentEvent) {
    return {
      id: e.id,
      name: e.title,
      venue: e.address || null,
      startAt: e.startTime,
      endAt: e.endTime,
      imageUrl: e.eventImageUrl ?? null,
      // EVENT-EDIT: lộ sức chứa hiện tại cho edit screen.
      maxParticipants: e.maxParticipants ?? null,
    };
  }

  private mapTicketType(t: ContentTicketType) {
    return {
      id: t.id,
      eventId: t.eventId,
      name: t.name,
      price: t.price,
      quota: t.remaining,
      quantity: t.quantity,
      sold: t.sold,
      remaining: t.remaining,
      maxTicketsPerUser: t.maxTicketsPerUser ?? null,
      codePrefix: t.typeCode ?? null,
      // VÉ-EMAIL: lộ cho UI lọc ở bước phát vé.
      emailDistribution: t.emailDistribution ?? false,
      // VÉ-MIỄN-PHÍ-MINH-CHỨNG: lộ cho UI (badge/label loại vé yêu cầu minh chứng).
      requireProof: t.requireProof ?? false,
      proofTaskDescription: t.proofTaskDescription ?? null,
    };
  }
}