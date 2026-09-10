import { env } from '../../config/env';
import { ClaimMailPayload } from './mail.adapter';

/**
 * Render body TEXT email vé (kiểu boarding-pass sân bay — Phần 2: email
 * plain-text + PDF đính kèm, thay HTML + CID). Không HTML → không cần
 * escape; mọi giá trị chèn thẳng.
 */
export function renderTicketEmailText(p: ClaimMailPayload): string {
  const eventDate = p.eventDate ? ` ngày ${p.eventDate}` : '';
  const venue = p.venue ? ` tại ${p.venue}` : '';
  return [
    'Bạn thân mến,',
    '',
    `Chúc mừng bạn đã nhận được ${p.ticketCount ?? 1} vé tham dự sự kiện ${p.eventName}${eventDate}${venue}.`,
    '',
    'Để sự kiện diễn ra thuận lợi và trọn vẹn nhất, bạn vui lòng lưu ý một số thông tin sau:',
    '- Mặc trang phục lịch sự.',
    '- Tới cổng soát vé và trình mã vé trước tối thiểu 15 phút.',
    '- Mỗi mã vé chỉ dùng cho 01 người và mỗi mã vé chỉ được quét 1 lần duy nhất.',
    '',
    'Mã vé QR chi tiết đã được đính kèm trực tiếp vào email này.',
    '',
    'Cần thêm hỗ trợ về nội dung và sự kiện? Theo dõi các cập nhật mới nhất của BTC tại: ' +
      (p.btcUrl?.trim() ||
        env.BTC_UPDATE_URL ||
        env.APP_UNIVERSAL_LINK_BASE ||
        env.PUBLIC_BASE_URL),
    '',
    `Hẹn gặp lại bạn tại sự kiện ${p.eventName}!`,
    '',
    'Lưu ý: Đây là email được gửi tự động từ hệ thống. Vui lòng không trả lời email này.',
    '',
    'Trân trọng,',
    'BTC sự kiện',
  ].join('\r\n');
}
