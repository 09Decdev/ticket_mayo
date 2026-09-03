export type TicketStatus = 'VALID' | 'USED' | 'CANCELLED';
// T5: PARTIALLY_MINTED — job EAGER mint fail một phần (Prisma DistributionStatus).
export type DistributionStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'PARTIALLY_MINTED';
// T5: PreTicketStatus đầy đủ theo Prisma enum (UI cũ chỉ biết PENDING/CLAIMED/EXPIRED).
export type PreTicketStatus =
  | 'PENDING'
  | 'MINTING'
  | 'MINTED'
  | 'LINKED'
  | 'CLAIMING'
  | 'CLAIMED'
  | 'EXPIRED';
export type PortalUserRole = 'ADMIN' | 'USER';

export interface PortalUser {
  id: string;
  email: string;
  role: PortalUserRole;
  displayName?: string | null;
}

export interface AuthResponse {
  accessToken: string;
  user: PortalUser;
  claimedTickets?: number;
}

export interface Event {
  id: string;
  name: string;
  venue?: string | null;
  startAt?: string | null;
  endAt?: string | null;
}

export interface TicketType {
  id: string;
  eventId: string;
  name: string;
  price?: string | number | null;
  quota: number;
  codePrefix?: string | null;
  /** Số vé từ content-service (nguồn sự thật) — hiển thị số lượng & còn lại. */
  quantity?: number;
  sold?: number;
  remaining?: number;
  maxTicketsPerUser?: number | null;
}

export interface TicketView {
  id: string;
  ticketCode: string;
  status: TicketStatus;
  ticketType: { name: string };
  event: { name: string };
  checkedInAt?: string | null;
  qrPayload?: string | null;
  /** Ảnh banner (proxy same-origin qua GET /tickets/:id/image khi có). */
  bannerUrl?: string | null;
}

export interface DistributionJob {
  id: string;
  ticketTypeId: string;
  ticketTypeName: string;
  eventName: string;
  eventId: string;
  total: number;
  sent: number;
  failed: number;
  status: DistributionStatus;
  /** T5: snapshot LAZY/EAGER lúc distribute — LAZY job không có mint counts. */
  mintMode?: 'LAZY' | 'EAGER' | string | null;
  idempotencyKey?: string | null;
  createdAt: string;
}

/** T5 (getStatus): 4 mint count — chỉ job EAGER có dữ liệu (LAZY = 0). */
export interface MintCounts {
  minted: number;
  mintedWithUser: number;
  mintedEmailOnly: number;
  mintFailed: number;
}

export interface PreTicketView {
  id: string;
  /** TM-3: KHÔNG render plaintext email — chỉ hash rút gọn để đối chiếu. */
  recipientEmailHash: string;
  claimToken: string;
  status: PreTicketStatus;
  ticketId?: string | null;
  createdAt: string;
  claimedAt?: string | null;
  /** T5 includeFailed: lý do mint fail từng PreTicket (null = không fail). */
  lastMintError?: string | null;
  /** T5: vé thật ở content-service (đã mint) — hiển thị thay boolean ticketId. */
  contentTicketCode?: string | null;
}

export interface DistributionStatusResp {
  job: DistributionJob;
  /** T5: mint counts — có ở MỌI call getStatus (kể cả không includeFailed). */
  mint?: MintCounts;
  preTickets?: PreTicketView[];
}

/** T5: ConflictException 409 quota — body có code/remaining/requested. */
export interface QuotaExceededInfo {
  code?: string;
  remaining?: number;
  requested?: number;
  message?: string;
}

export interface OverviewStats {
  totalDistributions: number;
  totalPreTickets: number;
  claimed: number;
  pending: number;
  sent: number;
  failed: number;
  totalTickets: number;
  checkedIn: number;
}

export interface AttendanceByGate {
  gateId?: string | null;
  count: number;
}

export interface AttendanceStats {
  eventId?: string | null;
  eventName?: string | null;
  totalTickets: number;
  checkedIn: number;
  byGate: AttendanceByGate[];
}

export interface CheckInResult {
  ticket?: TicketView;
  alreadyCheckedIn?: boolean;
}

export interface ClaimResult {
  ok: boolean;
  ticketId?: string;
  alreadyClaimed?: boolean;
  needsAuth?: boolean;
  /** RB-2: PreTicket MINTING/CLAIMING hoặc sync fail-soft — đang xử lý, thử lại sau. */
  processing?: boolean;
  /** RB-2: PreTicket EXPIRED — vé đã hết hạn. */
  expired?: boolean;
  status?: number;
  code?: string;
  message?: string;
}

export interface ApiError {
  status?: number;
  code?: string;
  message?: string;
  /** T5: 409 quota body — {code, remaining, requested} (nếu có). */
  remaining?: number;
  requested?: number;
  /** VÉ-EDIT: 400 TICKET_TYPE_QUANTITY_BELOW_SOLD — số vé đã bán (min quantity). */
  sold?: number;
}
