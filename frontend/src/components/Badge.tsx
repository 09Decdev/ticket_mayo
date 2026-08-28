import type { TicketStatus } from '../api/types';
import { statusBadgeClass } from '../common/format';

export function StatusBadge({ status }: { status?: TicketStatus | null }) {
  return <span className={statusBadgeClass(status ?? undefined)}>{status || '—'}</span>;
}
