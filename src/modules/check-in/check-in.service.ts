import { Injectable } from '@nestjs/common';
import { ContentClientService } from '../content-client/content-client.service';
import { CheckInDto } from './dtos/check-in.dto';

/**
 * Check-in admin → content-service (DB-status path: VALID → USED, idempotent).
 */
@Injectable()
export class CheckInService {
  constructor(private readonly content: ContentClientService) {}

  async checkIn(dto: CheckInDto, adminId: string) {
    const result = await this.content.checkIn({
      ticketCode: dto.ticketCode,
      checkerId: adminId,
      gateId: dto.gateId,
    });
    return {
      ticket: {
        id: result.ticket.id,
        ticketCode: result.ticket.ticketCode,
        status: result.ticket.status,
        checkedInAt: result.ticket.checkedInAt ?? null,
      },
      alreadyCheckedIn: result.alreadyCheckedIn,
    };
  }
}