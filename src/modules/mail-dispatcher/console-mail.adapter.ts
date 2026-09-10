import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { Injectable, Logger } from '@nestjs/common';
import { ClaimMailPayload, MailAdapter } from './mail.adapter';
import { redactEmail, emailShortHash } from './smtp-mail.adapter';

/**
 * Console adapter — logs the email summary, writes the rendered text body
 * and attached PDFs to `mail-previews/` so nội dung email + PDF vé có thể
 * eyeball trong terminal/browser. This is the default so the app runs with
 * zero external deps.
 */
@Injectable()
export class ConsoleMailAdapter implements MailAdapter {
  private readonly logger = new Logger(ConsoleMailAdapter.name);

  async send(payload: ClaimMailPayload): Promise<void> {
    const previewDir = join(process.cwd(), 'mail-previews');
    mkdirSync(previewDir, { recursive: true });
    // TM-3: KHÔNG ghi email vào tên file preview — dùng hash ngắn (file text
    // chứa claimUrl, ai đọc được dir là claim được vé).
    const base = `${emailShortHash(payload.email)}-${payload.claimToken.slice(0, 8)}`;
    writeFileSync(join(previewDir, `${base}.txt`), payload.text ?? '', 'utf8');
    if (payload.html) {
      writeFileSync(join(previewDir, `${base}.html`), payload.html, 'utf8');
    }
    for (const att of payload.attachments ?? []) {
      writeFileSync(join(previewDir, `${base}-${att.filename}`), att.content);
    }

    // TM-3: KHÔNG log plaintext email — dùng dạng redact.
    this.logger.log(
      [
        '',
        '--- TICKET EMAIL (text + PDF) ---',
        `To:          ${redactEmail(payload.email)}`,
        `Event:       ${payload.eventName}`,
        `Ticket type: ${payload.ticketTypeName}`,
        `PDFs:        ${payload.attachments?.length ?? 0}`,
        `Claim link:  ${payload.claimUrl}`,
        `Preview:     ${join(previewDir, base)}.txt`,
        '--------------------------------',
      ].join('\n'),
    );
  }
}
