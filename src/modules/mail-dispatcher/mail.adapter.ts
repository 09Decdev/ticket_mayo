/** Ảnh nhúng inline qua CID (Content-ID) — email client hiển thị được, không bị chặn như base64. */
export interface CidAttachment {
  /** Content-ID (không có dấu < >). Trong HTML dùng src="cid:<cid>". */
  cid: string;
  /** Tên file hiển thị nếu client không render inline. */
  filename: string;
  /** Buffer nội dung ảnh. */
  content: Buffer;
  /** MIME type, vd 'image/png'. */
  contentType: string;
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
  /** Ảnh sự kiện (absolute URL hoặc presigned). Null → template dùng ảnh mặc định. */
  eventImage?: string | null;
  /** Tên người nhận vé (từ PortalUser.displayName, fallback "Người dùng MAYogu"). */
  customerName?: string | null;
  /** SĐT người nhận — ticket-mayo không lưu → để trống. */
  customerPhone?: string | null;
  /** Thời gian phát vé (ISO hoặc chuỗi hiển thị vi-VN). */
  bookedAt?: string | null;
  /** Mã vé THẬT từ bảng Ticket (content-service) — mã hóa vào QR + hiển thị trên vé. */
  ticketCode?: string;
  /** contentTicketId (bảng Ticket content) — để fetch static signed QR token khi render. */
  ticketId?: string;
  /** Generated body (HTML with embedded QR) — filled by MailDispatcherService. */
  html?: string;
  /** Ảnh inline CID: logo, notice icon, QR — filled by MailDispatcherService. */
  attachments?: CidAttachment[];
}

export interface MailAdapter {
  send(payload: ClaimMailPayload): Promise<void>;
}
