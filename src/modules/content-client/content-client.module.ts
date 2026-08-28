import { Module } from '@nestjs/common';
import { ContentClientService } from './content-client.service';

@Module({
  providers: [ContentClientService],
  exports: [ContentClientService],
})
export class ContentClientModule {}