import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { OptionalUserAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RequestUser } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ClaimService } from './claim.service';

@ApiTags('claim')
@Controller('claim')
@UseGuards(OptionalUserAuthGuard)
export class ClaimController {
  constructor(private readonly service: ClaimService) {}

  @Get(':token')
  @ApiOperation({ summary: 'Resolve a claim token into a ticket (requires a matching logged-in user)' })
  claim(@Param('token') token: string, @CurrentUser() user: RequestUser | undefined) {
    return this.service.claim(token, user);
  }
}
