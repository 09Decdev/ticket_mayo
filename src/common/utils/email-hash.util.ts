import { createHmac } from 'crypto';
import { env } from '../../config/env';

/**
 * Normalize email for hashing — match user-community `crypto-gcm.util.ts:128`
 * `generateBlindIndex`: `email.toLowerCase().trim()`.
 */
function normalizeEmail(email: string): string {
  return email.toLowerCase().trim();
}

/**
 * HMAC-SHA256 blind index for recipientEmailHash. MUST use the same pepper as
 * user-community `FIELD_ENCRYPTION_PEPPER` so a user's login email hash matches
 * the PreTicket created by admin distribution.
 *
 * Verified: user-community `crypto-gcm.util.ts:125-130` uses the same algorithm.
 */
export function generateEmailHash(email: string): string {
  const pepper = env.FIELD_ENCRYPTION_PEPPER;
  if (!pepper || pepper.length < 16) {
    throw new Error('[email-hash] FIELD_ENCRYPTION_PEPPER missing or too short (<16 chars)');
  }
  return createHmac('sha256', pepper).update(normalizeEmail(email)).digest('hex');
}

export function normalizeEmailForLookup(email: string): string {
  return normalizeEmail(email);
}
