import { randomBytes } from 'crypto';

/**
 * Generate a unique ticket code.
 * Format: `${codePrefix || 'TC'}-${12 hex uppercase}` (6 random bytes).
 * Caller retries on P2002 unique-violation (TicketService).
 */
export function generateTicketCode(codePrefix?: string | null): string {
  const trimmed = codePrefix?.trim();
  const prefix = trimmed && trimmed.length > 0 ? trimmed : 'TC';
  const suffix = randomBytes(6).toString('hex').toUpperCase();
  return `${prefix}-${suffix}`;
}
