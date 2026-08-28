import { Module } from '@nestjs/common';
import { EventService } from './event.service';
import { EventController } from './event.controller';
import { TicketTypeController } from './ticket-type.controller';
import { ContentClientModule } from '../content-client/content-client.module';

@Module({
  imports: [ContentClientModule],
  controllers: [EventController, TicketTypeController],
  providers: [EventService],
  exports: [EventService],
})
export class EventModule {}