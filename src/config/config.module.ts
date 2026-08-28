import { Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';

/**
 * Thin wrapper around `@nestjs/config` ConfigModule — also loads .env at process
 * startup via the side-effecting `env.ts` import. The actual env object is
 * exported as a plain const from `env.ts`; services inject it directly rather
 * than via `ConfigService` (keeps call sites short).
 */
@Module({
  imports: [NestConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env'] })],
  exports: [NestConfigModule],
})
export class ConfigModule {}
