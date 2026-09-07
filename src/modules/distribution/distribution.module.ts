import { Module } from '@nestjs/common';
import { DistributionService } from './distribution.service';
import { DistributionController } from './distribution.controller';
import { MailDispatcherModule } from '../mail-dispatcher/mail-dispatcher.module';
import { AuditModule } from '../audit/audit.module';
import { EventModule } from '../event/event.module';
import { UserCommunityClientModule } from '../user-community-client/user-community-client.module';
import { ContentClientModule } from '../content-client/content-client.module';
import { TicketPdfStorageModule } from '../ticket-pdf-storage/ticket-pdf-storage.module';

@Module({
  imports: [
    MailDispatcherModule,
    AuditModule,
    EventModule,
    UserCommunityClientModule,
    ContentClientModule,
    TicketPdfStorageModule,
  ],
  controllers: [DistributionController],
  providers: [DistributionService],
  exports: [DistributionService],
})
export class DistributionModule {}
