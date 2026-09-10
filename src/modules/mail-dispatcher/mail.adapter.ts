/**
 * File PDF vé đính kèm email — render sẵn tại ticket-mayo trước khi gửi.
 */
export interface PdfAttachment {
  /** Tên file hiển thị (vd VE-ABC123.pdf). */
  filename: string;
  /** Buffer PDF. */
  content: Buffer;
  contentType: 'application/pdf';
}

export interface ClaimMailPayload {
  jobId: string;
  email: string;
  claimToken: string;
  claimUrl: string;
  ticketTypeName: string;
  eventName: string;
  eventDate?: string | null;
  venue?: string | null;
  /** Tên người nhận vé (từ PortalUser.displayName, fallback "Người dùng MAYogu"). */
  customerName?: string | null;
  /** SĐT người nhận — ticket-mayo không lưu → để trống. */
  customerPhone?: string | null;
  /** Thời gian phát vé (ISO hoặc chuỗi hiển thị vi-VN). */
  bookedAt?: string | null;
  /** Mã vé THẬT từ bảng Ticket (content-service). */
  ticketCode?: string;
  /** contentTicketId (bảng Ticket content) — để fetch static signed QR token khi render. */
  ticketId?: string;
  /** Số vé đính kèm trong email này (email gộp quantity vé/người). */
  ticketCount?: number;
  /** Link cập nhật BTC (nhập per-job ở wizard) — rỗng → renderer fallback env. */
  btcUrl?: string | null;
  /** Body text — filled by MailDispatcherService. */
  text?: string;
  /** Body HTML (bản trình bày đẹp) — filled by MailDispatcherService; text giữ làm fallback. */
  html?: string;
  /** PDF vé đính kèm — filled by MailDispatcherService. */
  attachments?: PdfAttachment[];
}

export interface MailAdapter {
  send(payload: ClaimMailPayload): Promise<void>;
}
