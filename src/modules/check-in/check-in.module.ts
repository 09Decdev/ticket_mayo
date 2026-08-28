import { Module } from '@nestjs/common';
import { CheckInService } from './check-in.service';
import { CheckInController } from './check-in.controller';
import { ContentClientModule } from '../content-client/content-client.module';

@Module({
  imports: [ContentClientModule],
  controllers: [CheckInController],
  providers: [CheckInService],
})
export class CheckInModule {}
