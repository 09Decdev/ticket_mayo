import { Controller, Get, NotFoundException, Param, StreamableFile, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RequestUser } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { TicketPortalService } from './ticket-portal.service';

@ApiTags('tickets')
@Controller('tickets')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT-auth')
export class TicketPortalController {
  constructor(private readonly service: TicketPortalService) {}

  @Get('me')
  @ApiOperation({ summary: "List the current user's tickets (with QR payload)" })
  listMine(@CurrentUser() user: RequestUser) {
    return this.service.listMyTickets(user.id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single ticket detail (owner only)' })
  getOne(@Param('id') id: string, @CurrentUser() user: RequestUser) {
    return this.service.getTicket(id, user.id);
  }

  @Get(':id/image')
  @ApiOperation({ summary: 'Download banner image of a ticket (owner only, same-origin proxy)' })
  async getImage(@Param('id') id: string, @CurrentUser() user: RequestUser) {
    const img = await this.service.getTicketBannerImage(id, user.id);
    if (!img) throw new NotFoundException('Vé này không có ảnh banner.');
    return new StreamableFile(img.buffer, { type: img.contentType });
  }
}
