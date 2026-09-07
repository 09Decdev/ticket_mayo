import { Module } from '@nestjs/common';
import { ContentClientModule } from '../content-client/content-client.module';
import { TicketPdfService } from './ticket-pdf.service';
import { TicketPdfStorageService } from './ticket-pdf-storage.service';

// PrismaModule là @Global → không cần import (PrismaService inject được trực tiếp).
@Module({
  imports: [ContentClientModule],
  providers: [TicketPdfService, TicketPdfStorageService],
  exports: [TicketPdfStorageService],
})
export class TicketPdfStorageModule {}
