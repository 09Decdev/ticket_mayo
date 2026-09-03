import { Module } from '@nestjs/common';
import { ContentClientModule } from '../content-client/content-client.module';
import { TicketMergeService } from './ticket-merge.service';
import { TicketMergeController } from './ticket-merge.controller';

/**
 * TICKET-TYPE-MERGE admin surface ("Gộp loại vé").
 * PrismaService @Global (lokal repoint runner); ContentClientModule → internal
 * merge API bên content-service (nguồn sự thật).
 */
@Module({
  imports: [ContentClientModule],
  controllers: [TicketMergeController],
  providers: [TicketMergeService],
  exports: [TicketMergeService],
})
export class TicketMergeModule {}
