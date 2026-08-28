import { Module } from '@nestjs/common';
import { TicketService } from './ticket.service';
import { AuditModule } from '../audit/audit.module';
import { ContentClientModule } from '../content-client/content-client.module';

@Module({
  imports: [AuditModule, ContentClientModule],
  providers: [TicketService],
  exports: [TicketService],
})
export class TicketModule {}
