import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AdminAuthGuard } from '../../common/guards/jwt-auth.guard';
import { EventService } from './event.service';
import { CreateTicketTypeDto, UpdateTicketTypeBasicDto } from './dtos/create-ticket-type.dto';
import { UpdateTicketTypeDto } from './dtos/update-ticket-type.dto';

@ApiTags('admin/ticket-types')
@Controller('admin/ticket-types')
@UseGuards(AdminAuthGuard)
@ApiBearerAuth('JWT-auth')
export class TicketTypeController {
  constructor(private readonly eventService: EventService) {}

  @Get()
  @ApiOperation({ summary: 'List ticket types (optionally filtered by eventId)' })
  @ApiQuery({ name: 'eventId', required: false, type: String })
  list(@Query('eventId') eventId?: string) {
    return this.eventService.listTicketTypes(eventId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a ticket type' })
  create(@Body() dto: CreateTicketTypeDto) {
    return this.eventService.createTicketType(dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a ticket type' })
  update(@Param('id') id: string, @Body() dto: UpdateTicketTypeDto) {
    return this.eventService.updateTicketType(id, dto);
  }

  @Get(':id/basic')
  @ApiOperation({ summary: 'Get one ticket type for edit screen (name/quantity/sold)' })
  getForEdit(@Param('id') id: string) {
    return this.eventService.getTicketTypeForEdit(id);
  }

  @Patch(':id/basic')
  @ApiOperation({
    summary:
      'Update ticket type basic info (name + quantity only) — content validate quantity >= sold',
  })
  updateBasic(@Param('id') id: string, @Body() dto: UpdateTicketTypeBasicDto) {
    return this.eventService.updateTicketTypeBasic(id, dto);
  }

  // DELETE-INTERNAL: xóa loại vé — content hard-delete + AuditLog, chỉ khi
  // sold = 0. sold > 0 → 400 TICKET_TYPE_HAS_SOLD_TICKETS kèm sold.
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Delete a ticket type — chỉ khi chưa có vé được cấp (sold = 0)',
  })
  remove(@Param('id') id: string) {
    return this.eventService.deleteTicketType(id);
  }
}
