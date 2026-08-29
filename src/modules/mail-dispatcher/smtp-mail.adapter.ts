import { Injectable, Logger } from '@nestjs/common';
import nodemailer, { Transporter } from 'nodemailer';
import { createHash } from 'crypto';
import { env } from '../../config/env';
import { ClaimMailPayload, MailAdapter } from './mail.adapter';

/**
 * Redact email cho log/preview (TM-3): giữ local-part 1 ký tự đầu + domain
 * đủ trace nghiệp vụ, KHÔNG bao giờ ghi plaintext email vào log.
 * vd "nguyen.van@example.com" → "n***@example.com"
 */
export function redactEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}

/** Hash ngắn (hex 12 chars) của email — dùng cho tên file preview (không reversible bằng mắt). */
export function emailShortHash(email: string): string {
  return createHash('sha256').update(email).digest('hex').slice(0, 12);
}

/**
 * SMTP adapter — gửi email claim thật qua relay SMTP (nodemailer).
 * Dùng khi MAIL_TRANSPORT=smtp. Port 465 => secure (SSL/TLS).
 */
@Injectable()
export class SmtpMailAdapter implements MailAdapter {
  private readonly logger = new Logger(SmtpMailAdapter.name);
  private readonly transporter: Transporter;

  constructor() {
    // env.MAIL_PORT giữ nguyên là string (decorator transform không chạy trong buildEnv)
    const port = Number(env.MAIL_PORT);
    this.transporter = nodemailer.createTransport({
      // P2: pool SMTP connections — gửi song song (dispatch concurrency 4) qua
      // tối đa 5 connection, mỗi connection tối đa 100 messages rồi reconnect.
      pool: true,
      maxConnections: 5,
      maxMessages: 100,
      host: env.MAIL_HOST,
      port,
      secure: port === 465,
      auth: {
        user: env.MAIL_USER,
        pass: env.MAIL_PASS,
      },
    });
  }

  async send(payload: ClaimMailPayload): Promise<void> {
    const code = payload.ticketCode ? ` - ${payload.ticketCode}` : '';
    const subject = payload.eventName
      ? `Vé điện tử - ${payload.eventName}${code}`
      : 'Vé điện tử của bạn';

    await this.transporter.sendMail({
      from: env.MAIL_FROM ?? env.MAIL_USER,
      to: payload.email,
      subject,
      html: payload.html ?? '',
      attachments: (payload.attachments ?? []).map((a) => ({
        filename: a.filename,
        content: a.content,
        cid: a.cid,
        contentType: a.contentType,
        contentDisposition: 'inline',
      })),
    });

    // TM-3: KHÔNG log plaintext email — dùng dạng redact.
    this.logger.log(
      `email sent to ${redactEmail(payload.email)} (${payload.ticketTypeName} — ${payload.eventName})`,
    );
  }
}