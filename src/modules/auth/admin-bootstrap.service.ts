import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../prisma/prisma.service';
import { env } from '../../config/env';
import { generateEmailHash } from '../../common/utils/email-hash.util';

/**
 * On application bootstrap, ensures an ADMIN PortalUser exists (seeded from
 * env.ADMIN_EMAIL / env.ADMIN_PASSWORD). Makes the app usable immediately
 * after first boot — no manual admin provisioning step required.
 */
@Injectable()
export class AdminBootstrapService implements OnModuleInit {
  private readonly logger = new Logger(AdminBootstrapService.name);
  private readonly bcryptRounds = 10;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await this.ensureAdmin();
  }

  private async ensureAdmin(): Promise<void> {
    const existing = await this.prisma.portalUser.findFirst({
      where: { role: 'ADMIN' },
    });
    if (existing) {
      // TM-3: KHÔNG log plaintext email — dùng emailHash.
      this.logger.log(
        `admin user already exists (id=${existing.id}, emailHash=${generateEmailHash(existing.email)})`,
      );
      return;
    }

    const email = env.ADMIN_EMAIL.toLowerCase().trim();
    const emailHash = generateEmailHash(email);
    const passwordHash = await bcrypt.hash(env.ADMIN_PASSWORD, this.bcryptRounds);
    const admin = await this.prisma.portalUser.create({
      data: { email, emailHash, passwordHash, role: 'ADMIN', displayName: 'Admin' },
    });
    // TM-3: KHÔNG log plaintext email — dùng emailHash.
    this.logger.log(`bootstrapped admin user id=${admin.id} emailHash=${emailHash}`);
  }
}
