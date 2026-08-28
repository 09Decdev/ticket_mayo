import { Module } from '@nestjs/common';
import { UserCommunityClientService } from './user-community-client.service';

@Module({
  providers: [UserCommunityClientService],
  exports: [UserCommunityClientService],
})
export class UserCommunityClientModule {}
