import { Module } from '@nestjs/common';
import { TicketPortalService } from './ticket-portal.service';
import { TicketPortalController } from './ticket-portal.controller';
import { ContentClientModule } from '../content-client/content-client.module';
import { TicketModule } from '../ticket/ticket.module';

@Module({
  imports: [ContentClientModule, TicketModule],
  controllers: [TicketPortalController],
  providers: [TicketPortalService],
})
export class TicketPortalModule {}
