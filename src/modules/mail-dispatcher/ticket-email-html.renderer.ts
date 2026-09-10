import { env } from '../../config/env';
import { ClaimMailPayload } from './mail.adapter';

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Render body HTML email vé — GIỮ NGUYÊN bố cục plain-text của
 * ticket-email-text.renderer, chỉ khác: chữ to hơn (16px) và tô đậm vài
 * chỗ quan trọng (tên sự kiện, số vé, lưu ý chính). Không card, không
 * header màu, không nút CTA.
 */
export function renderTicketEmailHtml(p: ClaimMailPayload): string {
  const eventDate = p.eventDate ? ` ngày ${esc(p.eventDate)}` : '';
  const venue = p.venue ? ` tại ${esc(p.venue)}` : '';
  const count = p.ticketCount ?? 1;
  const btcUrl =
    p.btcUrl?.trim() || env.BTC_UPDATE_URL || env.APP_UNIVERSAL_LINK_BASE || env.PUBLIC_BASE_URL;

  const body = [
    'Bạn thân mến,',
    '',
    `Chúc mừng bạn đã nhận được <b>${count} vé</b> tham dự sự kiện <b>${esc(p.eventName)}</b>${eventDate}${venue}.`,
    '',
    'Để sự kiện diễn ra thuận lợi và trọn vẹn nhất, bạn vui lòng lưu ý một số thông tin sau:',
    '- <b>Mặc trang phục lịch sự.</b>',
    '- <b>Tới cổng soát vé và trình mã vé trước tối thiểu 15 phút.</b>',
    '- <b>Mỗi mã vé chỉ dùng cho 01 người</b> và mỗi mã vé chỉ được quét <b>1 lần duy nhất</b>.',
    '',
    'Mã vé QR chi tiết đã được <b>đính kèm trực tiếp vào email này</b>.',
    '',
    `Cần thêm hỗ trợ về nội dung và sự kiện? Theo dõi các cập nhật mới nhất của BTC tại: <a href="${esc(btcUrl)}" style="color:#168D43;">${esc(btcUrl)}</a>`,
    '',
    `Hẹn gặp lại bạn tại sự kiện <b>${esc(p.eventName)}</b>!`,
    '',
    '<i>Lưu ý: Đây là email được gửi tự động từ hệ thống. Vui lòng không trả lời email này.</i>',
    '',
    'Trân trọng,',
    'BTC sự kiện',
  ].join('<br>\n');

  return `<!DOCTYPE html>
<html lang="vi">
<head><meta charset="utf-8"><title>Vé điện tử</title></head>
<body style="margin:0;padding:0;">
  <div style="font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.7;color:#000000;padding:16px 8px;">
    ${body}
  </div>
</body>
</html>`;
}
