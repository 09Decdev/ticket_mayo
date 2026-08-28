import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RequestUser } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CheckInService } from './check-in.service';
import { CheckInDto } from './dtos/check-in.dto';

@ApiTags('admin/check-in')
@Controller('admin/check-in')
@UseGuards(AdminAuthGuard)
@ApiBearerAuth('JWT-auth')
export class CheckInController {
  constructor(private readonly service: CheckInService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Check in a ticket by code (idempotent)' })
  checkIn(@Body() dto: CheckInDto, @CurrentUser() user: RequestUser) {
    return this.service.checkIn(dto, user.id);
  }
}
