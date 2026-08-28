import { createHmac } from 'crypto';

/**
 * Helper dùng chung cho T5 specs — dựng chữ ký HMAC đúng canonical form
 * của content-service (Δ11 VB3-2) để verify client ký khớp.
 */
export function signRecipient(
  key: string,
  preTicketId: string,
  emailHash: string,
  userId?: string | null,
): string {
  const canonical = `${preTicketId}.${emailHash}.${userId ?? ''}`;
  return createHmac('sha256', key).update(canonical).digest('hex').toLowerCase();
}

/** Test key theo prompt T5 — KHÔNG dùng ở prod. */
export const TEST_SIGNING_KEY = 't5-mint-test-signing-key-DO-NOT-USE-IN-PROD-32';
