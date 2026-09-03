import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AdminAuthGuard, AuthedRequest } from '../../common/guards/jwt-auth.guard';
import { TicketMergeService } from './ticket-merge.service';
import { MergeRollbackDto, MergeTicketTypesDto } from './dtos/ticket-merge.dto';

/**
 * Admin API cho tab "Gộp loại vé" (QUẢN LÝ). Mọi mutation đi qua
 * TicketMergeService → content internal API (+ lokal repoint).
 * Auth: AdminAuthGuard (JWT role ADMIN) — global prefix 'ticket-mayo'.
 */
@ApiTags('admin/ticket-merge')
@Controller('admin/ticket-merge')
@UseGuards(AdminAuthGuard)
@ApiBearerAuth('JWT-auth')
export class TicketMergeController {
  constructor(private readonly service: TicketMergeService) {}

  @Get('plan')
  @ApiOperation({
    summary:
      'Dry-run gộp loại vé: content report (vé đã mua + userId per type, blockers, projection) + lokal repoint report (PreTicket/job)',
  })
  @ApiQuery({ name: 'eventId', required: true })
  @ApiQuery({ name: 'survivorId', required: false })
  @ApiQuery({ name: 'loserIds', required: false, description: 'CSV: id1,id2' })
  plan(
    @Query('eventId') eventId: string,
    @Query('survivorId') survivorId?: string,
    @Query('loserIds') loserIds?: string | string[],
  ) {
    return this.service.plan(eventId, survivorId, loserIds);
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Thực thi merge (confirm="MERGE"): lokal repoint → content transaction. Lỗi 4xx → tự undo local.',
  })
  merge(@Body() dto: MergeTicketTypesDto, @Req() req: AuthedRequest) {
    return this.service.apply(dto, req.user?.id);
  }

  @Post('rollback')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Rollback merge (confirm="ROLLBACK") theo contentAuditId (+ repointAuditId nếu có): content rollback trước, local sau.',
  })
  rollback(@Body() dto: MergeRollbackDto, @Req() req: AuthedRequest) {
    return this.service.rollback(dto, req.user?.id);
  }
}
