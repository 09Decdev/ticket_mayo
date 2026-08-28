import {
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PortalUser } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { TicketService } from '../ticket/ticket.service';
import { generateEmailHash } from '../../common/utils/email-hash.util';
import { RegisterDto } from './dtos/register.dto';
import { LoginDto } from './dtos/login.dto';

export interface AuthResponse {
  accessToken: string;
  user: { id: string; email: string; role: string; displayName: string | null };
  claimedTickets: number;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly bcryptRounds = 10;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly ticketService: TicketService,
  ) {}

  async register(dto: RegisterDto): Promise<AuthResponse> {
    const email = dto.email.toLowerCase().trim();
    const emailHash = generateEmailHash(email);

    const existing = await this.prisma.portalUser.findUnique({ where: { email } });
    if (existing) {
      throw new ConflictException('An account with this email already exists.');
    }

    const passwordHash = await bcrypt.hash(dto.password, this.bcryptRounds);
    const user = await this.prisma.portalUser.create({
      data: {
        email,
        emailHash,
        passwordHash,
        displayName: dto.displayName ?? null,
        role: 'USER',
      },
    });

    // T6: EAGER → sync MINTED-unlinked (F-09: dữ liệu cũ còn PENDING →
    // chạy CẢ HAI: sync + resolve; claimedTickets = tổng). LAZY → giữ
    // nguyên flow cũ resolvePendingPreTickets (§5.4).
    const claimed = await this.claimAtAuth(user.id, emailHash);
    const accessToken = await this.signJwt(user);

    // TM-3: KHÔNG log plaintext email — dùng emailHash.
    this.logger.log(`registered user=${user.id} emailHash=${emailHash} claimed=${claimed}`);
    return {
      accessToken,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        displayName: user.displayName,
      },
      claimedTickets: claimed,
    };
  }

  async login(dto: LoginDto): Promise<AuthResponse> {
    const email = dto.email.toLowerCase().trim();
    const user = await this.prisma.portalUser.findUnique({ where: { email } });
    if (!user) {
      throw new UnauthorizedException('Invalid email or password.');
    }
    const ok = await bcrypt.compare(dto.password, user.passwordHash);
    if (!ok) {
      throw new UnauthorizedException('Invalid email or password.');
    }

    // T6: EAGER → sync MINTED-unlinked (F-09: dữ liệu cũ còn PENDING →
    // chạy CẢ HAI: sync + resolve; claimedTickets = tổng). LAZY → giữ
    // nguyên flow cũ resolvePendingPreTickets (§5.4).
    const claimed = await this.claimAtAuth(user.id, user.emailHash);
    const accessToken = await this.signJwt(user);

    // TM-3: KHÔNG log plaintext email — dùng emailHash.
    this.logger.log(`login user=${user.id} emailHash=${user.emailHash} claimed=${claimed}`);
    return {
      accessToken,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        displayName: user.displayName,
      },
      claimedTickets: claimed,
    };
  }

  private async signJwt(user: PortalUser): Promise<string> {
    return this.jwtService.signAsync({
      sub: user.id,
      email: user.email,
      role: user.role,
    });
  }

  /**
   * T6: gộp trigger sync — vé mint qua email được gắn về user (sync MINTED-
   * unlinked); PENDING legacy (F-09, dữ liệu từ thời LAZY) vẫn được resolve.
   * claimedTickets = tổng. Cả 2 path fail-soft bên trong — auth không bao giờ fail.
   */
  private async claimAtAuth(userId: string, emailHash: string): Promise<number> {
    const [synced, resolved] = await Promise.all([
      this.ticketService.syncTicketsByEmail(userId, emailHash),
      this.ticketService.resolvePendingPreTickets(userId, emailHash),
    ]);
    return synced + resolved;
  }
}
