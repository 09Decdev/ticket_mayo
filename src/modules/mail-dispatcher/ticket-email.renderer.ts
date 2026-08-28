import { ClaimMailPayload } from './mail.adapter';

/** Dữ liệu ảnh/thương hiệu dùng chung cho mọi email (từ env, không per-recipient). */
export interface TicketEmailBrandContext {
  qrUrl: string;
  bannerUrl: string;
  noticeIconUrl: string;
  logoUrl: string;
  supportEmail: string;
  supportPhone: string;
  appStoreUrl: string;
  googlePlayUrl: string;
  /** URL nút "Tải vé PDF" — endpoint sinh PDF của đúng template email. */
  pdfUrl: string;
  timeIconUrl: string;
  locationIconUrl: string;
  downloadIconUrl: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Render template `mayogu_ticket_email_template.html` bằng cách thay 16 placeholder
 * `{{token}}`. Dùng split-join (không regex) để tránh escape; escape HTML mọi giá trị
 * vì token xuất hiện cả trong text lẫn attribute (alt/src/href) → chống injection.
 */
export function renderTicketEmailHtml(
  template: string,
  p: ClaimMailPayload,
  ctx: TicketEmailBrandContext,
): string {
  const tokens: Record<string, string> = {
    eventName: p.eventName ?? '',
    eventDate: p.eventDate ?? '',
    location: p.venue ?? '',
    ticketCode: p.ticketCode ?? '',
    customerName: p.customerName ?? '',
    customerPhone: p.customerPhone ?? '',
    customerEmail: p.email ?? '',
    bookedAt: p.bookedAt ?? '',
    qrUrl: ctx.qrUrl,
    bannerUrl: ctx.bannerUrl,
    noticeIconUrl: ctx.noticeIconUrl,
    logoUrl: ctx.logoUrl,
    supportEmail: ctx.supportEmail,
    supportPhone: ctx.supportPhone,
    appStoreUrl: ctx.appStoreUrl,
    googlePlayUrl: ctx.googlePlayUrl,
    pdfUrl: ctx.pdfUrl,
    timeIconUrl: ctx.timeIconUrl,
    locationIconUrl: ctx.locationIconUrl,
    downloadIconUrl: ctx.downloadIconUrl,
  };
  let out = template;
  // Bỏ HTML comment (template chỉ có comment thông thường, không có `[if mso]`)
  // → tránh placeholder `{{token}}` trong comment bị fill trùng (đặc biệt base64 QR).
  out = out.replace(/<!--[\s\S]*?-->/g, '');
  for (const [k, v] of Object.entries(tokens)) {
    out = out.split(`{{${k}}}`).join(escapeHtml(v));
  }
  return out;
}
