import { randomBytes, randomUUID } from 'crypto';

/**
 * Generate an unguessable single-use-ish claim token.
 * Format: `<UUID v4>-<64 hex chars>` (~104 chars total, 256-bit random suffix).
 * §6.5: token unguessable to resist enumeration; `claimToken @unique` enforces uniqueness.
 */
export function generateClaimToken(): string {
  return `${randomUUID()}-${randomBytes(32).toString('hex')}`;
}

/**
 * Generate a server-side job UUID (group id for PreTicket batch).
 * Server-generated, distinct from client `idempotencyKey`.
 */
export function generateJobId(): string {
  return randomUUID();
}
