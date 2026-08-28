import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AdminAuthGuard } from '../../common/guards/jwt-auth.guard';
import { StatsService } from './stats.service';

@ApiTags('admin/stats')
@Controller('admin/stats')
@UseGuards(AdminAuthGuard)
@ApiBearerAuth('JWT-auth')
export class StatsController {
  constructor(private readonly service: StatsService) {}

  @Get('overview')
  @ApiOperation({ summary: 'Distribution + ticket overview counts' })
  overview() {
    return this.service.overview();
  }

  @Get('attendance')
  @ApiOperation({ summary: 'Attendance by event (with per-gate breakdown)' })
  @ApiQuery({ name: 'eventId', required: true, type: String })
  attendance(@Query('eventId') eventId: string) {
    return this.service.attendance(eventId);
  }
}
