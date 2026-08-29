import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { PrismaModule } from './prisma/prisma.module';
import { AuditModule } from './modules/audit/audit.module';
import { MailDispatcherModule } from './modules/mail-dispatcher/mail-dispatcher.module';
import { AuthModule } from './modules/auth/auth.module';
import { TicketModule } from './modules/ticket/ticket.module';
import { EventModule } from './modules/event/event.module';
import { DistributionModule } from './modules/distribution/distribution.module';
import { CheckInModule } from './modules/check-in/check-in.module';
import { StatsModule } from './modules/stats/stats.module';
import { TicketPortalModule } from './modules/ticket-portal/ticket-portal.module';
import { ClaimModule } from './modules/claim/claim.module';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    AuditModule,
    MailDispatcherModule,
    AuthModule,
    TicketModule,
    EventModule,
    DistributionModule,
    CheckInModule,
    StatsModule,
    TicketPortalModule,
    ClaimModule,
  ],
})
export class AppModule {}
