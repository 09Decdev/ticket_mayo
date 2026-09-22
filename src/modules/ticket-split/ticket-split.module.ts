import { Module } from '@nestjs/common';
import { ContentClientModule } from '../content-client/content-client.module';
import { TicketSplitService } from './ticket-split.service';
import { TicketSplitController } from './ticket-split.controller';

/**
 * TICKET-TYPE-SPLIT admin surface ("Điều chuyển vé").
 * PrismaService @Global (subset repoint helper); ContentClientModule →
 * internal split API bên content-service (nguồn sự thật).
 */
@Module({
  imports: [ContentClientModule],
  controllers: [TicketSplitController],
  providers: [TicketSplitService],
  exports: [TicketSplitService],
})
export class TicketSplitModule {}
