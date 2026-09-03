import { Injectable, NotFoundException } from '@nestjs/common';
import { ContentClientService } from '../content-client/content-client.service';
import { CreateEventDto } from './dtos/create-event.dto';
import { UpdateEventDto } from './dtos/update-event.dto';
import {
  CreateTicketTypeDto,
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
      // VÉ-EMAIL: admin chọn lúc tạo (default false) — truyền thẳng content.
      emailDistribution: dto.emailDistribution ?? false,
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
   * Edit screen admin: sửa CHỈ name + quantity qua PATCH .../basic của content.
   * Content validate quantity >= sold ở service layer (không tin client) —
   * vi phạm → 400 TICKET_TYPE_QUANTITY_BELOW_SOLD (HttpException pass-through
   * kèm sold trong response body — frontend hiển thị min quantity).
   */
  async updateTicketTypeBasic(id: string, dto: { name: string; quantity: number }) {
    const updated = await this.content.updateTicketTypeBasic(id, {
      name: dto.name,
      quantity: dto.quantity,
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

  /** Resolve một ticket type (kèm event + số lượng) — dùng cho snapshot khi phát vé. */
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
   * Dữ liệu cho edit screen admin: CHỈ các field cần để sửa name + quantity
   * (sold hiển thị read-only làm min quantity, remaining để hint).
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
      eventName: tt.event?.title ?? null,
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
    };
  }
}