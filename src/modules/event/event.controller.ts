import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AdminAuthGuard } from '../../common/guards/jwt-auth.guard';
import { EventService } from './event.service';
import { CreateEventDto } from './dtos/create-event.dto';
import { UpdateEventDto } from './dtos/update-event.dto';

@ApiTags('admin/events')
@Controller('admin/events')
@UseGuards(AdminAuthGuard)
@ApiBearerAuth('JWT-auth')
export class EventController {
  constructor(private readonly eventService: EventService) {}

  @Get()
  @ApiOperation({ summary: 'List events (optionally search by name)' })
  @ApiQuery({ name: 'search', required: false, type: String })
  listEvents(@Query('search') search?: string) {
    return this.eventService.listEvents(search);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create an event' })
  createEvent(@Body() dto: CreateEventDto) {
    return this.eventService.createEvent(dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update an event' })
  updateEvent(@Param('id') id: string, @Body() dto: UpdateEventDto) {
    return this.eventService.updateEvent(id, dto);
  }
}
