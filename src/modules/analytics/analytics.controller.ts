import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AdminAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AnalyticsService } from './analytics.service';

@ApiTags('analytics')
@Controller('admin/stats')
@UseGuards(AdminAuthGuard)
export class AnalyticsController {
  constructor(private readonly service: AnalyticsService) {}

  @Get('overview')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'A7 — analytics overview (distribution)' })
  @ApiQuery({ name: 'eventId', required: false, type: String })
  @ApiQuery({ name: 'from', required: false, type: String, description: 'ISO date' })
  @ApiQuery({ name: 'to', required: false, type: String, description: 'ISO date' })
  async overview(
    @Query('eventId') eventId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.service.getOverview(
      from ? new Date(from) : undefined,
      to ? new Date(to) : undefined,
      eventId,
    );
  }

  @Get('distribution/:jobId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'A8 — distribution detail (progress + cross-check)' })
  async distributionDetail(@Param('jobId') jobId: string) {
    return this.service.getDistributionDetail(jobId);
  }
}
