import { Module } from '@nestjs/common';
import { DistributionModule } from '../distribution/distribution.module';
import { MailDispatcherModule } from '../mail-dispatcher/mail-dispatcher.module';
import { TicketPdfController } from './ticket-pdf.controller';
import { TicketPdfService } from './ticket-pdf.service';

@Module({
  imports: [MailDispatcherModule, DistributionModule],
  controllers: [TicketPdfController],
  providers: [TicketPdfService],
})
export class TicketPdfModule {}