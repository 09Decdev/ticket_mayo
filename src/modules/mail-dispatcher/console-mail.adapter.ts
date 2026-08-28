import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { Injectable, Logger } from '@nestjs/common';
import { ClaimMailPayload, MailAdapter } from './mail.adapter';
import { redactEmail, emailShortHash } from './smtp-mail.adapter';

/**
 * Console adapter — logs the email summary and writes the rendered HTML (with
 * the embedded ticket QR) to `mail-previews/` so the template can be eyeballed
 * in a browser. This is the default so the app runs with zero external deps.
 */
@Injectable()
export class ConsoleMailAdapter implements MailAdapter {
  private readonly logger = new Logger(ConsoleMailAdapter.name);

  async send(payload: ClaimMailPayload): Promise<void> {
    const previewDir = join(process.cwd(), 'mail-previews');
    mkdirSync(previewDir, { recursive: true });
    // TM-3: KHÔNG ghi email vào tên file preview — dùng hash ngắn (file HTML
    // chứa claimUrl, ai đọc được dir là claim được vé).
    const file = join(
      previewDir,
      `${emailShortHash(payload.email)}-${payload.claimToken.slice(0, 8)}.html`,
    );
    writeFileSync(file, payload.html ?? '', 'utf8');

    // TM-3: KHÔNG log plaintext email — dùng dạng redact.
    this.logger.log(
      [
        '',
        '--- TICKET CLAIM EMAIL ---',
        `To:          ${redactEmail(payload.email)}`,
        `Event:       ${payload.eventName}`,
        `Ticket type: ${payload.ticketTypeName}`,
        `Claim link:  ${payload.claimUrl}`,
        `Preview:     ${file}`,
        '--------------------------',
      ].join('\n'),
    );
  }
}