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
import { TicketSplitService } from './ticket-split.service';
import { SplitRollbackDto, SplitTicketTypesDto } from './dtos/ticket-split.dto';

/**
 * Admin API cho tab "Điều chuyển vé" (QUẢN LÝ). Mọi mutation đi qua
 * TicketSplitService → content internal API (+ lokal subset PreTicket
 * repoint theo contentTicketId ∈ movedIds).
 * Auth: AdminAuthGuard (JWT role ADMIN) — global prefix 'ticket-mayo'.
 */
@ApiTags('admin/ticket-split')
@Controller('admin/ticket-split')
@UseGuards(AdminAuthGuard)
@ApiBearerAuth('JWT-auth')
export class TicketSplitController {
  constructor(private readonly service: TicketSplitService) {}

  @Get('plan')
  @ApiOperation({
    summary:
      'Dry-run điều chuyển vé: content split-plan (eligible/moveCount, preview vé mới nhất, projection, blockers/warnings) + lokal PreTicket subset report',
  })
  @ApiQuery({ name: 'eventId', required: true })
  @ApiQuery({ name: 'sourceId', required: true })
  @ApiQuery({ name: 'targetId', required: true })
  @ApiQuery({ name: 'keepCount', required: true, type: Number })
  @ApiQuery({ name: 'sourceQuantity', required: false, type: Number })
  @ApiQuery({ name: 'targetQuantity', required: false, type: Number })
  plan(
    @Query('eventId') eventId: string,
    @Query('sourceId') sourceId: string,
    @Query('targetId') targetId: string,
    @Query('keepCount') keepCount: number,
    @Query('sourceQuantity') sourceQuantity?: string,
    @Query('targetQuantity') targetQuantity?: string,
  ) {
    const toNum = (v?: string) =>
      v === undefined || v === '' || Number.isNaN(Number(v)) ? undefined : Number(v);
    return this.service.plan(
      eventId,
      sourceId,
      targetId,
      Number(keepCount),
      toNum(sourceQuantity),
      toNum(targetQuantity),
    );
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Thực thi split (confirm="SPLIT"): split-plan → lokal subset repoint → content transaction. ' +
      'moveCount > 500 vé TỰ CHIA ĐỢT ≤500 (mỗi đợt plan+repoint+split riêng, trả rounds[] với auditId — ' +
      'rollback từng đợt theo thứ tự ngược). Lỗi 4xx → tự undo local.',
  })
  split(@Body() dto: SplitTicketTypesDto, @Req() req: AuthedRequest) {
    return this.service.apply(dto, req.user?.id);
  }

  @Post('rollback')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Rollback split (confirm="ROLLBACK") theo contentAuditId (+ repointAuditId nếu có): content rollback trước, local sau.',
  })
  rollback(@Body() dto: SplitRollbackDto, @Req() req: AuthedRequest) {
    return this.service.rollback(dto, req.user?.id);
  }
}
