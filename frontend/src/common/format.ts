import type { ApiError, TicketStatus } from '../api/types';

export function statusBadgeClass(status?: TicketStatus): string {
  switch (status) {
    case 'VALID':
      return 'badge badge-valid';
    case 'USED':
      return 'badge badge-used';
    case 'CANCELLED':
      return 'badge badge-cancelled';
    default:
      return 'badge badge-progress';
  }
}

export function formatDateTime(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatPercent(rate?: number): string {
  if (rate === undefined || rate === null || isNaN(rate)) return '—';
  return `${Math.round(rate * 100)}%`;
}

export function shortCode(code?: string): string {
  if (!code) return '—';
  return code.length > 16 ? code.slice(0, 8) + '…' + code.slice(-6) : code;
}

/**
 * TM-3: rút gọn emailHash (6-8 ký tự đầu + …) — chỉ dùng để đối chiếu,
 * KHÔNG bao giờ render plaintext email.
 */
export function shortHash(hash?: string | null): string {
  if (!hash) return '—';
  return hash.length > 8 ? hash.slice(0, 8) + '…' : hash;
}

/**
 * T8: format lỗi quota thân thiện từ 409 body {code, remaining, requested}
 * — KHÔNG hiển thị raw error stack. Fallback message cho các lỗi khác.
 */
export function formatApiError(err: unknown): string {
  const e = err as ApiError | null | undefined;
  if (!e) return 'Lỗi không xác định.';
  const isQuota =
    e.status === 409 && (e.code === 'TICKET_SOLD_OUT' || e.code === 'TICKET_QUOTA_EXCEEDED');
  if (isQuota) {
    const parts: string[] = ['Vé đã hết hạn mức (quota)'];
    if (typeof e.remaining === 'number' && typeof e.requested === 'number') {
      parts.push(`chỉ còn ${e.remaining} vé nhưng yêu cầu ${e.requested}`);
    } else if (typeof e.remaining === 'number') {
      parts.push(`chỉ còn ${e.remaining} vé`);
    }
    parts.push('Hãy giảm số lượng hoặc tăng quota loại vé rồi phát lại.');
    return parts.join(' — ') + '.';
  }
  if (typeof e.remaining === 'number' && typeof e.requested === 'number') {
    // 409 khác nhưng vẫn có remaining/requested → vẫn format số rõ ràng.
    return `${e.message || 'Yêu cầu bị từ chối'} (còn ${e.remaining}, yêu cầu ${e.requested}).`;
  }
  return e.message || 'Yêu cầu thất bại.';
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
