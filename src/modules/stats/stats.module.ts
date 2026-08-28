import { Module } from '@nestjs/common';
import { StatsService } from './stats.service';
import { StatsController } from './stats.controller';
import { ContentClientModule } from '../content-client/content-client.module';

@Module({
  imports: [ContentClientModule],
  controllers: [StatsController],
  providers: [StatsService],
})
export class StatsModule {}
