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
  /** EVENT-EDIT: sức chứa hiện tại (content maxParticipants) — min khi sửa. */
  maxParticipants?: number | null;
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
  /** VÉ-EMAIL: true = chỉ phát qua email — chỉ hiện ở bước phát vé. */
  emailDistribution?: boolean;
  /** VÉ-MIỄN-PHÍ-MINH-CHỨNG: true = yêu cầu ảnh minh chứng làm nhiệm vụ
   *  (gửi vào bình luận sự kiện) trước khi được phát vé. */
  requireProof?: boolean;
  /** Mô tả nhiệm vụ cho AI kiểm tra ảnh minh chứng (khi requireProof=true). */
  proofTaskDescription?: string | null;
  /** TICKET-APPEARANCE: file id ảnh riêng của loại vé (upload-service). */
  ticketImageFileId?: string | null;
  /** TICKET-APPEARANCE: màu module QR (dark), hex #RGB/#RRGGBB. */
  qrForegroundColor?: string | null;
  /** TICKET-APPEARANCE: màu nền QR (light), hex #RGB/#RRGGBB. */
  qrBackgroundColor?: string | null;
}

/** TICKET-APPEARANCE: GET /admin/ticket-types/:id/appearance — giá trị hiện
 *  tại + event context cho preview (title/venue/thời gian/ảnh fallback). */
export interface TicketTypeAppearance {
  id: string;
  eventId: string;
  name: string;
  ticketImageFileId?: string | null;
  qrForegroundColor?: string | null;
  qrBackgroundColor?: string | null;
  /** Presigned URL ảnh riêng (đã resolve ở content — đi qua image-proxy). */
  ticketImageUrl?: string | null;
  event?: {
    id: string;
    title: string;
    startTime?: string | null;
    endTime?: string | null;
    address?: string | null;
    eventImageUrl?: string | null;
  } | null;
}

/** TICKET-APPEARANCE: kết quả upload ảnh (chưa gắn vào loại vé). */
export interface TicketTypeImageUpload {
  ticketTypeId: string;
  fileId: string;
  status: string;
  type: string;
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
  /** Thời điểm email gửi thành công (null = chưa gửi) — bật nút "Xem email". */
  emailSentAt?: string | null;
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
  /** EVENT-EDIT: 400 EVENT_MAX_PARTICIPANTS_BELOW_REGISTERED — số người đã
   *  đăng ký (min sức chứa khi sửa event). */
  registeredCount?: number;
  /** TICKET-MERGE: 409 TICKET_TYPE_MERGE_BLOCKED / 400 INVALID_INPUT — mảng
   *  lý do chặn gộp (pass-through từ content-service). */
  blockers?: string[];
  warnings?: string[];
  /** TICKET-MERGE apply fail 4xx: local repoint đã được tự undo chưa. */
  localRepointRolledBack?: boolean;
  repointAuditId?: string;
  /** SPLIT batch (D16): các đợt ≤500 vé ĐÃ COMMIT trước khi lỗi ở đợt sau. */
  completedRounds?: SplitApplyRound[];
}

// ─── TICKET-MERGE: "Gộp loại vé" admin page ───
/** Một vé đã mua trong report per-type (userId = NULL với vé email chưa claim). */
export interface MergeTicketBuyer {
  ticketId: string;
  ticketCode: string;
  userId: string | null;
  status: TicketStatus;
  purchasePrice: string;
  createdAt: string;
}

/** Stat per loại vé từ content merge-plan (report dry-run). */
export interface MergeTypeStat {
  id: string;
  name: string;
  typeCode: string | null;
  price: string;
  quantity: number;
  sold: number;
  remaining: number;
  maxTicketsPerUser: number;
  emailDistribution: boolean;
  tickets: {
    total: number;
    byStatus: Record<string, number>;
    buyers: MergeTicketBuyer[];
    buyersTruncated: boolean;
  };
  reservations: { total: number; byStatus: Record<string, number> };
  seats: number;
  giftCampaigns: number;
}

export interface MergeProjection {
  quantity: number;
  sold: number;
  name: string;
  price: string;
  maxTicketsPerUser: number;
  emailDistribution: boolean;
}

/** GET /admin/ticket-merge/plan → { content, local } */
export interface MergePlanReport {
  content: {
    mode: 'plan';
    eventId: string;
    event: { id: string; title: string; maxParticipants: number | null };
    types: MergeTypeStat[];
    mergeTarget: {
      survivorId: string | null;
      loserIds: string[];
      overrides: MergeTicketOverrides | null;
      ok: boolean;
      shapeErrors: string[];
      blockers: string[];
      warnings: string[];
      projection: MergeProjection | null;
      movedCounts: { tickets: number; reservations: number; seats: number; giftCampaigns: number };
      maxParticipantsBefore: number | null;
      maxParticipantsAfter: number | null;
    } | null;
    generatedAt: string;
  };
  /** Báo cáo repoint DB lokal (PreTicket/DistributionJob) — null khi chưa chọn survivor+losers. */
  local: {
    ok: boolean;
    alreadyRepointed: boolean;
    blockers: string[];
    warnings: string[];
    counts: {
      live: { byStatus: Record<string, number>; total: number };
      terminal: { total: number };
      liveJobs: { id: string; status: string; ticketTypeName: string }[];
      terminalJobs: number;
    };
  } | { error: string } | null;
}

export interface MergeTicketOverrides {
  name?: string;
  price?: number;
  quantity?: number;
  maxTicketsPerUser?: number;
  emailDistribution?: boolean;
}

export interface MergeApplyResult {
  status: 'merged' | 'merged-after-ambiguous-error';
  content: {
    auditId: string;
    survivor: unknown;
    mergedLosers: { id: string; name: string }[];
    moved: { tickets: number; reservations: number; seats: number; giftCampaigns: number };
    projection: MergeProjection;
    event: { maxParticipantsBefore: number | null; maxParticipantsAfter: number };
    soldReconcile: { counter: number; dbCount: number; drift: boolean };
    warnings: string[];
    rollbackHint?: string;
  } | null;
  local: { repointAuditId: string; movedPreTickets: number; movedJobs: number };
  note?: string;
}

export interface MergeRollbackResult {
  status: 'rolled_back';
  content: {
    rolledBack: boolean;
    auditId: string;
    eventId: string;
    survivorId: string;
    restoredLosers: string[];
    restored: { tickets: number; reservations: number; seats: number; giftCampaigns: number };
  } | null;
  local: { movedPreTickets: number; movedJobs: number } | null;
  warning?: string;
}

// ─── TICKET-SPLIT: "Điều chuyển vé" admin page ───
/** Một vé trong movePreview (mới nhất trước) từ content split-plan. */
export interface SplitMovePreviewItem {
  ticketId: string;
  ticketCode: string;
  userId: string | null;
  createdAt: string;
  status: TicketStatus;
  checkedInAt?: string | null;
}

/** Snapshot loại vé từ content split-plan (source/target). */
export interface SplitTypeSnap {
  id: string;
  name: string;
  price: string;
  quantity: number;
  sold: number;
  remaining: number;
}

export interface SplitProjectionSide {
  quantity: number;
  sold: number;
  remaining: number;
}

export interface SplitPlanContent {
  ok: boolean;
  mode?: 'plan';
  eventId: string;
  shapeErrors: string[];
  blockers: string[];
  warnings: string[];
  eligibleCount: number;
  moveCount: number;
  movePreview: SplitMovePreviewItem[];
  movePreviewTruncated: boolean;
  projection: {
    sourceAfter: SplitProjectionSide;
    targetAfter: SplitProjectionSide;
    maxParticipantsAfter: number | null;
  } | null;
  source: SplitTypeSnap | null;
  target: SplitTypeSnap | null;
  event: { maxParticipantsBefore: number | null; checkInSnapshotVersionBefore?: number | null };
  generatedAt: string;
}

/** GET /admin/ticket-split/plan → { content, local } */
export interface SplitPlanReport {
  content: SplitPlanContent;
  /** Báo cáo subset PreTicket lokal (contentTicketId ∈ movedIds). */
  local:
    | {
        affectedPreTickets: number;
        byStatus: Record<string, number>;
        note?: string;
      }
    | { error: string }
    | null;
}

export interface SplitApplyRound {
  round: number;
  keepCount: number;
  movedTickets: number | null;
  contentAuditId: string | null;
  repointAuditId: string;
}

/** Một vé đã chuyển (gom từ movePreview của MỌI đợt apply — không bị cap 500). */
export interface SplitMovedTicket {
  ticketId: string;
  ticketCode: string;
  userId: string | null;
  status: string;
  createdAt: string;
}

export interface SplitApplyResult {
  status: 'split' | 'split-batched' | 'split-after-ambiguous-error';
  content: {
    auditId: string;
    moved: { tickets: number; seats: number };
    projection: {
      sourceAfter: SplitProjectionSide;
      targetAfter: SplitProjectionSide;
      maxParticipantsAfter: number | null;
    } | null;
    event: { maxParticipantsBefore: number | null; maxParticipantsAfter: number | null };
    soldReconcile?: { counter: number; dbCount: number; drift: boolean };
    warnings: string[];
    rollbackHint?: string;
  } | null;
  local: { repointAuditId: string; movedPreTickets: number; movedIdsCount: number } | null;
  // split-batched (D16): moveCount > 500 → apply tự chia đợt ≤500 vé
  totalMoved?: number;
  totalMovedKnown?: number;
  partial?: boolean;
  contentAuditIds?: string[];
  repointAuditIds?: string[];
  rounds?: SplitApplyRound[];
  /** Toàn bộ vé đã chuyển (mọi đợt) — để đối chiếu DB sau apply. */
  moved?: SplitMovedTicket[];
  note?: string;
}

export interface SplitRollbackResult {
  status: 'rolled_back';
  content: {
    rolledBack: boolean;
    auditId: string;
    restored: { tickets: number; seats: number };
    event: { maxParticipantsRestored: number | null };
  } | null;
  local: { movedPreTickets: number } | null;
  warning?: string;
}
