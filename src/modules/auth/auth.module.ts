import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { env } from '../../config/env';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AdminBootstrapService } from './admin-bootstrap.service';
import {
  AdminAuthGuard,
  JwtAuthGuard,
  OptionalUserAuthGuard,
} from '../../common/guards/jwt-auth.guard';
import { TicketModule } from '../ticket/ticket.module';

/**
 * Global — exports JwtModule (so JwtService is injectable everywhere) and the
 * JWT guards so any feature module can use `@UseGuards(AdminAuthGuard)` etc.
 */
@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      useFactory: () => ({
        secret: env.JWT_SECRET,
        signOptions: { expiresIn: '7d' },
      }),
    }),
    TicketModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, AdminBootstrapService, JwtAuthGuard, AdminAuthGuard, OptionalUserAuthGuard],
  exports: [JwtModule, AuthService, JwtAuthGuard, AdminAuthGuard, OptionalUserAuthGuard],
})
export class AuthModule {}
