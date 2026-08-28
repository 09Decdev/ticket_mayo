# PLAN: Eager Mint & Email-Sync — Task Breakdown

**Status**: Draft v1.1 — đã hội tụ Phase 2c (thiết kế chốt: `DESIGN-ticket-email-mint-sync.md` mục "Thiết kế chốt hội tụ")
**Author**: PM (Alex)
**Date**: 2026-08-27
**PRD nguồn**: `c:\MAYogu_VIASG\ticket-mayo\docs\PRD-ticket-email-mint-sync.md` (Approved v1.1, HUMAN GATE 1 qua 2026-08-27)
**Scope file này**: Task breakdown + acceptance criteria + dependency + producer assignment. KHÔNG code, KHÔNG commit trong plan này.

---

## 0. Tổng quan

### 0.1. Mục tiêu (từ PRD §1, §2)

1. Vé tồn tại NGAY khi admin phát (eager mint) — `Ticket` + `TicketType.sold` ở content-service đổi ngay khi `distribute()` trả về.
2. Mint được cho email CHƯA có tài khoản (userId nullable + emailHash).
3. Khi user register/login/list-my-tickets → tự gắn vé email-only theo emailHash (link-by-email).
4. Chặn quota-gap: mint BẮT BUỘC trước gửi email, quota check toàn batch.
5. Backfill PreTicket PENDING cũ về cơ chế mới.

### 0.2. Quyết định đã chốt (KHÔNG mở lại khi build)

| Quyết định | Giá trị | Nguồn |
|---|---|---|
| Q1 — Identity | **PortalUser (ticket-mayo)** là "tài khoản trong app". KHÔNG dùng user-community id làm Ticket.userId | PRD §7.6 |
| Q3 — Backfill thiếu quota | Mint theo thứ tự createdAt đến cạn remaining, phần còn lại → status `EXPIRED` + audit `BACKFILL_QUOTA_EXCEEDED` + báo cáo admin | PRD §7.4 |
| D2 — Schema | `Ticket.userId` → **nullable** (KHÔNG placeholder string) | PRD §7.2 |
| D3 — PII | Content-service lưu **emailHash** (HMAC-SHA256), KHÔNG plaintext, KHÔNG encrypt | PRD §7.1 |
| D5 — Email | KHÔNG đưa ticketCode thật vào email; giữ mã hiển thị giả từ claimToken | PRD §5.2 |
| E1 — Claim-link | Giữ link, đổi semantics thành "xem vé / kích hoạt tài khoản"; bỏ path mint-on-click khi EAGER | PRD Story E |

### 0.3. Vẫn treo (KHÔNG chặn build — chặn MERGE)

| Mục | Owner | Cổng chặn |
|---|---|---|
| Q2 — Duyệt PII §7.1 (emailHash) | Security reviewer (model khác) | Trước merge content-service |
| Q4 — Threat-model API mint/link §8.2-8.3 | Security reviewer (model khác) | Trước merge content-service |
| Q5 — Copy email (đổi "Nhận vé" → "Tạo tài khoản để xem vé") | Khách hàng | Trước deploy ticket-mayo — build dùng copy hiện tại, đánh dấu TODO-Q5 trong template |
| Q10 — Chi tiết rollback migration nullable | Eng Lead content-service | Trước khi chạy migration thật (T1 phải viết downgrade kèm plan §11.3) |

### 0.4. Feature flag

- `DISTRIBUTION_MINT_MODE=LAZY|EAGER` (env, ticket-mayo).
- **Mặc định LAZY** trong code mới cho đến khi smoke test xong — bật EAGER theo môi trường qua env deploy, không cần code change.
- Mọi task đụng behavior mint/sync/claim PHẢI rẽ theo flag này.

### 0.5. Branch + deploy order (bắt buộc)

| Repo | Branch đề xuất | Ghi chú |
|---|---|---|
| `c:\MAYogu_VIASG\content-service` | `feature/ticket-email-mint-sync` | Deploy TRƯỚC |
| `c:\MAYogu_VIASG\ticket-mayo` | `feature/ticket-email-mint-sync` | Deploy SAU |

Thứ tự deploy (PRD §5.3):
1. Chạy migration content-service (nullable userId + recipientEmailHash + index) + deploy code content-service (API mint/link mới vô hại với ticket-mayo cũ).
2. Trước deploy ticket-mayo: chạy migration ticket-mayo `20260826112000_content_pivot` (**NỢ đang có** — PRD §1.3 #9, R4) + migration mới của plan này.
3. Deploy ticket-mayo với flag LAZY → smoke test mint (gọi API mint thủ công) → bật EAGER.
4. Backfill chạy sau khi EAGER ổn định (P3).

Sau build xong, giao user lệnh commit dạng text (qui trình KHÔNG auto-commit, memory `feedback_no_auto_commit`). Mọi lệnh git PHẢI `git -C <repo-path>` (memory `feedback_git_multi_repo`).

---

## 1. Task List

Quy ước: mỗi task có 1 producer chính + ≥3 critic (Code Reviewer, Reality Checker, Security Architect hoặc Application Security Engineer tùy task). Độ phức tạp: S (< 2h), M (2-6h), L (> 6h). Token ước tính cho producer (critic +30-50% thêm mỗi vòng).

---

### [ ] T1 — content-service: Migration nullable userId + recipientEmailHash + rollback

- **Repo**: content-service
- **Producer**: Backend Architect
- **Critic**: Code Reviewer + Reality Checker + Database Optimizer
- **Complexity**: M
- **Dependency**: none (task đầu tiên)
- **Mô tả KHÔNG AMBIGUOUS**:
  1. `prisma/schema.prisma` model Ticket (dòng ~484-514): đổi `userId String` → `userId String?`; thêm `recipientEmailHash String?`; thêm `@@index([recipientEmailHash])`.
  2. Tạo migration mới (Prisma migrate dev) — SQL phải:
     - `ALTER TABLE "Ticket" ALTER COLUMN "userId" DROP NOT NULL;`
     - `ALTER TABLE "Ticket" ADD COLUMN "recipientEmailHash" TEXT;`
     - `CREATE INDEX "Ticket_recipientEmailHash_idx" ON "Ticket"("recipientEmailHash");`
     - KHÔNG partial index `WHERE userId IS NULL` ở migration này (giữ đơn giản, Prisma raw khó quản lý; nếu Database Optimizer critic khẳng định cần thì tách follow-up).
  3. Viết **migration downgrade** (file SQL riêng kèm hướng dẫn chạy thủ công, theo PRD §11.3): set NOT NULL lại SAU KHI xử lý vé `userId IS NULL` theo 2 nhánh: (a) đã có user → giữ; (b) chưa gắn → gắn placeholder `"ROLLBACK-UNLINKED"` HOẶC delete vé unlinked chưa USED + giảm `sold` tương ứng. Downgrade KHÔNG chạy tự động — chỉ là rehearsed script + test.
  4. Chạy `prisma generate` — mọi chỗ TS bị break vì userId nullable phải LIỆT KÊ (không sửa logic trong task này — chỉ fix compile) và bàn cho T2.
- **Acceptance Criteria (CHECK ĐƯỢC)**:
  - [ ] `npx prisma migrate dev` tạo migration SQL đúng 3 lệnh trên, áp dụng lên DB dev thành công.
  - [ ] `npx tsc --noEmit` compile PASS hoặc danh sách lỗi userId-nullable đầy đủ được ghi vào file `docs/PLAN-ticket-email-mint-sync.md` mục T2-input (append, không sửa phần khác).
  - [ ] File downgrade SQL tồn tại + có test rehearsal chạy upgrade → insert 1 vé userId NULL → downgrade → verify vé xử lý đúng 1 trong 2 nhánh.
  - [ ] Migration chỉ chứa 3 thay đổi trên — KHÔNG tự động fix dữ liệu, KHÔNG đổi bảng khác.
- **Rủi ro riêng (Reality Checker chặn)**:
  - Migration áp lên DB production đang có vé — verify `SELECT count(*) FROM "Ticket" WHERE "userId" IS NULL` = 0 TRƯỚC upgrade (không có thì upgrade an toàn).
  - Downgrade XÓA vé unlinked phải verify vé chưa USED — nếu critic thấy script downgrade không check `status != 'USED'` → NEEDS WORK.

---

### [ ] T2 — content-service: Audit + fix raw SQL/service theo nullable userId (§6.3)

- **Repo**: content-service
- **Producer**: Backend Architect
- **Critic**: Code Reviewer + Reality Checker + Software Architect
- **Complexity**: L (rủi ro cao nhất của initiative — R1)
- **Dependency**: T1 (cần schema mới + danh sách chỗ compile break)
- **Mô tả KHÔNG AMBIGUOUS**:
  1. `src/infrastructure/driven-adapters/persistence/postgres/ticket.repository.adapter.ts`:
     - `findUserIdsByEventId`: thêm `WHERE userId IS NOT NULL` ở nhánh UNION của Ticket.
     - `countAllUserTicketCounters` (GROUP BY userId): filter NULL bucket (theo semantic: user NULL không phải 1 user).
     - `getTicketOwnerIds`: đã có IS NOT NULL — KHÔNG đổi, viết test chứng minh an toàn.
     - `findParticipatedEventIdsByUserAndCommunities` + `getTicketCountByEventIds` (ARRAY_AGG userId): filter NULL khỏi aggregate.
  2. Grep TOÀN REPO `ticket.userId` / `userId` trong mọi service dùng Ticket (matching, event, notification, stats): mỗi chỗ không phải Ticket của nội bộ distribution → đánh giá NULL-safety. Mỗi chỗ sửa: 1 test hoặc 1 ghi chú "an toàn vì X".
  3. Mọi chỗ TypeScript break do `userId: string | null`: fix compile THEO NGUYÊN TẮC không đổi behavior hiện có với vé có userId (chỉ thêm nhánh NULL rõ ràng).
- **Acceptance Criteria**:
  - [ ] Bảng §6.3 PRD — từng dòng có: file:line sau khi sửa + link commit test hoặc ghi chú an toàn. KHÔNG dòng nào "để sau".
  - [ ] Test cụ thể: `findUserIdsByEventId` với 1 vé userId NULL → kết quả KHÔNG chứa null.
  - [ ] Test: `countAllUserTicketCounters` với 2 vé userId NULL + 1 vé userId U1 → counter không có bucket null.
  - [ ] `npx tsc --noEmit` PASS.
  - [ ] Toàn bộ test hiện có của content-service PASS (`npm test` hoặc script test của repo).
  - [ ] Danh sách grep `ticket.userId` toàn repo đính kèm trong PR mô tả (audit trail).
- **Rủi ro riêng**:
  - Sót 1 query là fan-out notification cho user NULL / thống kê sai âm thầm — critic PHẢI chạy grep độc lập, không tin danh sách của producer.
  - Service khác (matching, notification) gọi repo với giả định non-null — nếu critic thấy signature đổi mà caller không xử lý → chặn.

---

### [ ] T3 — content-service: API mint batch + link-by-email + contract test

- **Repo**: content-service
- **Producer**: Backend Architect
- **Critic**: Code Reviewer + Security Architect (bắt buộc — §8) + API Tester
- **Complexity**: L
- **Dependency**: T1, T2
- **Mô tả KHÔNG AMBIGUOUS**:
  1. `src/infrastructure/driving-adapters/http-rest/dtos/request/internal-distribution.dto.ts`: thêm `InternalMintTicketsDto`:
     - `eventId: string` (IsNotEmpty), `ticketTypeId: string` (IsNotEmpty)
     - `recipients: Array<{ preTicketId: string (IsNotEmpty), emailHash: string (IsNotEmpty), userId?: string (optional) }>` (ArrayNotEmpty, max 1000 items/chunk)
     - `idempotencyKey: string` (IsNotEmpty)
     - `InternalLinkByEmailDto`: `{ emailHash: string (IsNotEmpty), userId: string (IsNotEmpty) }`
  2. `src/infrastructure/driven-adapters/persistence/postgres/ticket.repository.adapter.ts`: mở rộng `registerTicketsWithTx` (hoặc method mới `mintBatchWithTx`) nhận list `{userId?, emailHash, preTicketId}`:
     - Quota check TOÀN BATCH trong cùng tx: `sold + recipients.length > quantity` → throw `TICKET_SOLD_OUT` với remaining chính xác (giữ pattern `issueTickets` hiện có).
     - Row lock TicketType trong tx (pattern `registerTicketsWithTx` — R9).
     - Tăng `sold` 1 lần = recipients.length; createMany vé với `userId` nullable + `recipientEmailHash`.
     - Idempotency content-side: cột/id mapping `preTicketId` (unique composite hoặc ghi vào cột mới — producer chốt theo schema, phải chống double-mint khi ticket-mayo retry, R2). Conflict → trả về ticket đã tồn tại, KHÔNG tạo mới.
  3. `src/core/services/internal-ticket-distribution.service.ts`: method `mintForDistribution(dto)` (gọi repo mint, trả per-recipient result `[{preTicketId, ticketId, ticketCode, success, reason?}]` — R6) + `linkTicketsByEmail(dto)` (updateMany `WHERE recipientEmailHash = ? AND userId IS NULL`, trả `{linked: N}`).
  4. `src/infrastructure/driving-adapters/http-rest/controllers/internal-distribution.controller.ts`: `POST /internal/distribution/mint`, `POST /internal/distribution/link-by-email` — cả 2 `@UseGuards(ServiceTokenGuard)` (tái dùng, KHÔNG đổi guard).
  5. KHÔNG log plaintext email (chỉ emailHash) — §8.6. Log audit content-side: ai gọi (service token), jobId/idempotencyKey, số vé mint (§8.2c).
  6. Contract test (supertest hoặc pattern test hiện có repo): mint thành công / mint vượt quota / mint idempotent retry / link gắn đúng / link không đụng vé có userId / link emailHash sai → 0 linked.
- **Acceptance Criteria**:
  - [ ] `POST /internal/distribution/mint` không token → 401/403; token đúng → mint N vé, `sold` tăng đúng N, mỗi vé có ticketCode unique (sequence như vé thường).
  - [ ] Batch 3 recipient (1 có userId, 2 không) → 1 vé có userId, 2 vé `userId IS NULL`, cả 3 có `recipientEmailHash`.
  - [ ] Gọi mint lần 2 cùng `idempotencyKey` + cùng preTicketIds → trả về ticket đã có, `sold` KHÔNG tăng lần 2, tổng vé KHÔNG đổi.
  - [ ] Remaining 10, mint 15 → HTTP 409, message chứa `remaining=10`, `yêu cầu=15` (giữ format `issueTickets` hiện có), 0 vé tạo, sold không đổi.
  - [ ] 2 mint concurrent 60+60 với remaining 100 (test hoặc mô phỏng tx lock) → tổng ≤ 100.
  - [ ] `POST /internal/distribution/link-by-email`: vé email-only `emailHash=H` → gắn userId, trả `{linked: 1}`; gọi lần 2 → `{linked: 0}`; vé có userId khác KHÔNG bị đổi.
  - [ ] KHÔNG có chữ plaintext email trong bất kỳ log nào của 2 API (test grep output log).
  - [ ] `npx tsc --noEmit` + toàn bộ test repo PASS.
- **Rủi ro riêng (Security Architect chặn)**:
  - API mint cho phép tạo vé hàng loạt không qua user — verify: chỉ ServiceTokenGuard chặn, cần rate-limit nội bộ (§8.2b) hay chưa (khuyến nghị: log + monitoring đủ cho GA, defer rate-limit — ghi rõ trong PR).
  - Link-by-email: verify điều kiện WHERE bắt buộc `userId IS NULL` + `recipientEmailHash` chính xác — thiếu 1 trong 2 → chặn merge (§8.3).
  - Chunk >1000 recipients trong 1 request → reject 400 (R10).

---

### [ ] T3b — content-service: Conditional UPDATE quota trong purchase tx (GATE BẬT EAGER)

- **Repo**: content-service
- **Producer**: Backend Architect
- **Critic**: Code Reviewer + Reality Checker + Security Architect
- **Complexity**: M
- **Dependency**: sau T3 (cùng repo, cùng tx pattern), TRƯỚC flip EAGER ở T8
- **Bối cảnh (hội tụ Phase 2c, VB1-1)**: EAGER bulk mint tạo drift vector mới (mint-vs-purchase) — Redis `sold` stale làm LUA cho qua purchase trong cửa sổ commit→refresh. Conditional UPDATE là **merge-gate để BẬT EAGER (T8), KHÔNG phải gate merge nhánh** — nhánh ship flag LAZY trước, purchase không đổi hành vi hợp lệ nào tới khi task này + smoke xong.
- **Mô tả KHÔNG AMBIGUOUS**:
  1. `registerTicketsWithTx` (ticket.repository.adapter.ts:250-287): UPDATE TicketType đổi từ increment vô điều kiện sang `UPDATE ... SET sold = sold + N WHERE id = :id AND sold + N <= quantity`. 0-row affected → throw `QUOTA_EXCEEDED` → rollback tx → gọi `releaseStock` bồi hoàn Redis reserved (đối xứng pattern reserve hiện có).
  2. Kèm Δ1 hardening: `refreshSoldFromDb` fail → retry backoff 3 lần (1s/5s/25s) → vẫn fail → CRITICAL alert channel ops có pager (T3-M5), không âm thầm bỏ.
- **Acceptance Criteria (CHECK ĐƯỢC)**:
  - [ ] T3b-1: sold = quantity − N, mua N+1 vé → reject, tx rollback (0 vé tạo), Redis reserved được release về đúng giá trị.
  - [ ] T3b-2: purchase hợp lệ dưới quota vẫn 2xx, hành vi + data không đổi (regression test toàn purchase/reservation flow hiện có PASS).
  - [ ] T3b-3: trước flip EAGER: smoke test purchase flow ở chế độ LAZY trên staging — không regression nào so với main.
  - [ ] T3b-4: flip `DISTRIBUTION_MINT_MODE=EAGER` chỉ được chạy SAU khi T3b-1..3 PASS trên staging (ghi điều kiện này vào runbook T10).
- **Rủi ro riêng (Reality Checker chặn)**:
  - Guard mới làm purchase hợp lệ bị chặn nhầm (fail-closed) — T3b-2 phải chạy ĐẦY ĐỦ test purchase/reservation hiện có, không chỉ test mới.
  - F-01 check-then-act còn lại trong LAZY path là known-debt có T3-M5/M6/M7 che — KHÔNG mở rộng scope task này sang refactor purchase khác.

---

### [ ] T4 — ticket-mayo: Schema PreTicket states + recipientUserId + chạy migration nợ

- **Repo**: ticket-mayo
- **Producer**: Backend Architect
- **Critic**: Code Reviewer + Reality Checker
- **Complexity**: S
- **Dependency**: none (chạy song song với T1-T3 được)
- **Mô tả KHÔNG AMBIGUOUS**:
  1. `prisma/schema.prisma`: enum `PreTicketStatus` thêm `MINTING`, `MINTED` (giữ PENDING/CLAIMING/CLAIMED/EXPIRED cho dữ liệu lịch sử + backfill — D7). Model PreTicket thêm cột `recipientUserId String?` (userId đã resolve lúc phát — cho admin dashboard T8).
  2. **Cột bổ sung (Δ5 + Δ6 hội tụ Phase 2c)**: PreTicket thêm `mintedAt DateTime?`, `lastMintError String?`, `emailSentAt DateTime?`; DistributionJob thêm `mintMode String` (snapshot LAZY/EAGER tại lúc distribute — UI-P1).
  2. Migration mới (Prisma migrate dev) — các thay đổi trên (enum + 4 cột mới). Viết rollback (revert enum + drop cột) dạng SQL script kèm. Placeholder rollback per-row dùng `ROLLBACK-UNLINKED-<uuid>` (Δ6 — KHÔNG dùng chuỗi cố định vi phạm unique).
  3. Verify migration nợ `20260826112000_content_pivot` đã chạy trên DB dev trước khi migrate tiếp (`npx prisma migrate status`). Nếu chưa: báo user, KHÔNG tự chạy migration lên DB production (chỉ dev/test).
  4. `npx prisma generate` + fix compile chỗ nào break vì enum mới (không đổi logic).
- **Acceptance Criteria**:
  - [ ] `npx prisma migrate status` sạch trên dev (kể cả content_pivot) — output dán vào PR.
  - [ ] Migration mới áp dev thành công; `recipientUserId` nullable; enum có đủ 6 giá trị.
  - [ ] Rollback script tồn tại + rehearsal trên dev: upgrade → downgrade → schema về nguyên trạng.
  - [ ] `npx tsc --noEmit` PASS.
- **Rủi ro riêng**:
  - DB dev của ticket-mayo có thể KHÔNG khớp main (content_pivot chưa chạy) — nếu migrate status bẩn → dừng, báo user, không ép.

---

### [ ] T5 — ticket-mayo: distribute() eager mint + feature flag

- **Repo**: ticket-mayo
- **Producer**: Backend Architect
- **Critic**: Code Reviewer + Reality Checker + Test Automation Engineer
- **Complexity**: L
- **Dependency**: T3 (API mint tồn tại + contract đã chốt), T4 (enum/cột mới)
- **Mô tả KHÔNG AMBIGUOUS**:
  1. `src/modules/content-client/content-client.service.ts`: thêm `mintForDistribution(body)` (timeout 15s như hiện có; chunk 500-1000 recipient/call nếu batch lớn — R10).
  2. `src/modules/distribution/distribution.service.ts` — trong `distribute()`, khi flag EAGER (đọc từ env `DISTRIBUTION_MINT_MODE`):
     - Sau bước 5 (tạo job + PreTickets PENDING, transaction hiện có giữ nguyên): resolve userId từng email bằng query `portalUser` theo `recipientEmailHash` (CÙNG DB ticket-mayo — không HTTP). Ghi `recipientUserId` vào PreTicket.
     - Lock PreTicket PENDING → MINTING (atomic updateMany theo pattern CLAIMING trong `resolvePreTicket`).
     - Gọi `content-client.mintForDistribution` với `{eventId, ticketTypeId, recipients: [{preTicketId, emailHash, userId?}], idempotencyKey: jobId}`.
     - Thành công: update PreTicket `contentTicketId`, `contentTicketCode`, status MINTED. Per-recipient fail → PreTicket giữ reason, job status `PARTIALLY_MINTED` (thêm giá trị enum DistributionStatus hoặc ghi qua failed count — producer chốt, phải hiển thị được ở getStatus).
     - MINT TOÀN BỘ XONG mới gửi email (bước 6 hiện có giữ nguyên flow). Mint fail cả batch → job `FAILED`, KHÔNG gửi email nào, KHÔNG rollback PreTicket về PENDING (giữ MINTING + reason để retry idempotent, hoặc rollback PENDING — producer chốt theo pattern CLAIMING hiện có và ghi rõ trong PR).
     - LAZY flag: giữ nguyên flow hiện tại NGUYÊN VẸN (không đụng code path cũ ngoài điểm rẽ flag).
  3. `getStatus()` mở rộng trả `minted`, `mintedWithUser`, `mintedEmailOnly`, `mintFailed` (đếm từ PreTicket theo status + recipientUserId — Story H, không cần API content mới).
  4. Dịch lỗi quota từ content (TICKET_SOLD_OUT) thành ConflictException với message có remaining/requested — KHÔNG rethrow 500 (Story F).
  5. **HMAC ký recipient (Δ11)**: `mintForDistribution` ký từng recipient `sig = HMAC-SHA256(MINT_SIGNING_KEY, preTicketId + '.' + emailHash + '.' + (userId ?? ''))` trước khi gửi. Env `MINT_SIGNING_KEY` ≥32 chars, riêng (KHÔNG reuse INTERNAL_SERVICE_TOKEN), vào secrets checklist + gitleaks. Content verify trước tx → thiếu/sai sig → 400 `INVALID_PRETICKET_SIGNATURE` (test T3). Backfill CLI T7 đi qua cùng client — không đường mint nào bỏ chữ ký.
  6. **Endpoint admin gộp (Δ5, gồm P3+P4)**: `POST /admin/distributions/:id/retry` (retry per-PreTicket — chỉ PreTicket PENDING/MINTING-fail của job PARTIALLY_MINTED/FAILED, AdminGuard, idempotent dựa content-side) + `POST /admin/distributions/:id/resend-emails` (chỉ PreTicket MINTED/LINKED có `emailSentAt IS NULL` — P4; gửi xong set `emailSentAt`). Cả 2 vào status view T8.
  7. **Error pass-through (Δ7)**: `content-client.request()` parse JSON body lỗi, có `code` nghiệp vụ (whitelist: TICKET_SOLD_OUT + 4xx nội bộ distribution) → re-throw giữ status + code + message gốc; 5xx vẫn `BadGatewayException` 502 (che error nội bộ content). Nghiệm thu T3-E1/T3-E2 (DESIGN VB2-A).
  8. **Reconciliation 2 tầng (Δ9)**: (a) per-run — sau mỗi mint run đối chiếu preTicketId đã gửi vs ticketIds response trong RAM (T3-M8), lệch → job PARTIALLY_MINTED + CRITICAL alert ngay; (b) cron — mirror-check HGET sold vs DB sold **≤15 phút** (T3-M7) + orphan preTicketId check hàng ngày (Ticket có preTicketId không join được PreTicket MINTED → CRITICAL).
- **Acceptance Criteria**:
  - [ ] Flag LAZY: `distribute()` behavior GIỐNG HỆT hiện tại (test so sánh — không mint call nào ra content).
  - [ ] Flag EAGER + email có PortalUser: sau `distribute()` PreTicket MINTED + `contentTicketId` set + `recipientUserId` set; content có vé userId đó.
  - [ ] Flag EAGER + email chưa có PortalUser: PreTicket MINTED, content vé `userId NULL` + emailHash.
  - [ ] Quota vượt (remaining 10, phát 15): HTTP 4xx, message chứa remaining=10, 0 PreTicket PENDING dư, 0 email gửi, 0 vé mint. LƯU Ý: hiện tại PreTickets tạo TRƯỚC mint — nếu mint fail phải dọn PreTickets/job hoặc chặn trước (producer chốt: KHÔNG để PreTicket mồ côi job FAILED).
  - [ ] Idempotency: gọi distribute lần 2 cùng idempotencyKey sau khi mint xong → trả job cũ, sold không tăng.
  - [ ] Mint fail (mock content 500): 0 email gửi, job FAILED với reason, admin retry được.
  - [ ] `getStatus` trả đủ 4 field mint count mới.
  - [ ] Mint thiếu/sai HMAC sig → content trả 400 `INVALID_PRETICKET_SIGNATURE`, ticket-mayo hiển thị lý do per-recipient (không mint lặng).
  - [ ] Post-mint self-verify (T3-M8): giả lập response thiếu 1 ticketId → job PARTIALLY_MINTED + alert CRITICAL.
  - [ ] Retry endpoint: job PARTIALLY_MINTED → retry chỉ mint PreTicket thiếu, PreTicket đã MINTED không mint lại (idempotent).
  - [ ] Resend endpoint: chỉ gửi email cho MINTED/LINKED có `emailSentAt IS NULL`; gửi xong `emailSentAt` set; chạy 2 lần → lần 2 gửi 0.
  - [ ] Content trả 409 `TICKET_SOLD_OUT` → ticket-mayo trả 409 + body có `code, remaining, requested` (KHÔNG 502); content down → 502 (T3-E1/E2).
  - [ ] `npx tsc --noEmit` PASS.
- **Rủi ro riêng (Reality Checker chặn)**:
  - **Thứ tự tạo PreTicket trước → mint sau**: nếu mint fail, các PreTicket PENDING đã tồn tại + job FAILED → admin phát lại cùng list tạo PreTicket DOUBLING. Critic phải verify path retry an toàn.
  - Crash giữa "content mint xong" và "update PreTicket MINTED": retry phải dựa vào idempotency content-side (T3) — verify end-to-end bằng test giả lập crash (kill giữa 2 bước hoặc mock).
  - 500 recipients × timeout 15s: chunk hóa + verify tổng thời gian ≤ 60s (Story A perf AC).
  - **T3-M5**: kill Redis giữa mint run → refreshSoldFromDb retry 3 lần → CRITICAL alert kích hoạt, job kết thúc lỗi rõ ràng (không âm thầm bỏ — key không TTL nên 1 fail = stale đến restart).

---

### [ ] T6 — ticket-mayo: Sync link-by-email tại 3 điểm trigger + claim E1

- **Repo**: ticket-mayo
- **Producer**: Backend Architect
- **Critic**: Code Reviewer + Reality Checker + Security Architect
- **Complexity**: L
- **Dependency**: T3 (API link tồn tại), T4
- **Mô tả KHÔNG AMBIGUOUS**:
  1. `src/modules/content-client/content-client.service.ts`: thêm `linkByEmail(emailHash, userId)`.
  2. **Rate-limit (Δ8)**: content-side throttler 30 req/60s per-service-token trên route link-by-email. Sync fail-soft nhận 429 → bỏ qua (không retry cùng request), request kế tự retry. Nghiệm thu T3-L1: call 31 trong 60s → call 31 trả 429, register/login vẫn 2xx.
  2. `src/modules/ticket/ticket.service.ts`: method `syncTicketsByEmail(userId, emailHash)`:
     - Short-circuit: query PreTicket `WHERE recipientEmailHash = ? AND status = 'MINTED' AND recipientUserId IS NULL` (dùng `recipientUserId` làm marker link-local nhanh; nếu counter = 0 → return 0, 0 HTTP call).
     - Có → gọi content `linkByEmail` → content updateMany NULL-safe → về cập nhật `recipientUserId` cho PreTicket đã link (đồng bộ marker local) → trả linked count.
  3. Đổi 3 điểm trigger (chỉ khi flag EAGER; LAZY giữ `resolvePendingPreTickets` hiện có):
     - `src/modules/auth/auth.service.ts` register + login: thay `resolvePendingPreTickets(user.id, user.emailHash)` → `syncTicketsByEmail(user.id, user.emailHash)`. Response giữ field `claimedTickets` (= linked count). Sync fail (timeout/5xx content) → KHÔNG fail register/login — log + trả claimedTickets=0 (AC Story C: vé không mất, request kế tiếp retry).
     - `src/modules/ticket-portal/ticket-portal.service.ts` `listMyTickets`: gọi sync TRƯỚC `getUserTickets(userId)`; response giữ shape `{tickets, claimedTickets}`.
  4. `src/modules/claim/claim.service.ts` — semantics E1 khi EAGER: PreTicket MINTED + user đã login email khớp → sync + redirect "Vé của tôi" (KHÔNG mint). Chưa login → flow prompt hiện tại giữ nguyên. PreTicket PENDING (chưa backfill) → giữ lazy-mint path (transition, xóa sau backfill per Story G). Token sai → 404 generic giữ nguyên.
  5. Race 2 request đồng thời (login + list-my-tickets): sync idempotent nhờ content WHERE NULL-safe — viết test concurrent.
- **Acceptance Criteria**:
  - [ ] Register với email có 3 vé email-only MINTED: TRONG request register, 3 vé được gắn userId (verify content qua test), response `claimedTickets: 3`.
  - [ ] Login lại không vé mới: `claimedTickets: 0`, không lỗi.
  - [ ] List-my-tickets khi không còn gì sync: độ trễ tăng ≤ 200ms so với LAZY (short-circuit verify bằng đo hoặc chứng minh 0 HTTP call qua mock).
  - [ ] Sync fail (mock content timeout): register vẫn 200, `claimedTickets: 0`; request list-my-tickets KẾ TIẾP tự sync và vé hiện.
  - [ ] Concurrent 2 sync cùng emailHash: mỗi vé chỉ 1 userId, không duplicate, không 500.
  - [ ] Claim-link EAGER + PreTicket MINTED + đã login email khớp: redirect, không vé mới tạo.
  - [ ] Claim-link PreTicket MINTED nhưng mint từng phần fail: thông báo trung thực theo trạng thái PreTicket (không hứa vé không tồn tại).
  - [ ] Flag LAZY: cả 3 trigger + claim giữ NGUYÊN behavior cũ (test regression).
  - [ ] `npx tsc --noEmit` PASS.
- **Rủi ro riêng (Security Architect chặn)**:
  - ticket-mayo PHẢI chỉ gọi linkByEmail với cặp (emailHash, userId) đã xác thực JWT portal cùng user — verify không có path nào gọi link với emailHash của user khác (§8.3).
  - Short-circuit dùng `recipientUserId IS NULL` marker: nếu marker lệch trạng thái content (vd PreTicket cập nhật fail sau link) → sync bị skip vĩnh viễn. Critic verify marker update là best-effort + có đường hồi phục (fallback: nếu claimedTickets=0 nhưng user không thấy vé → vẫn gọi content? producer chốt + test).

---

### [ ] T7 — ticket-mayo: Backfill script PreTicket PENDING (CLI CANONICAL — POST run ĐÃ CẮT)

- **Repo**: ticket-mayo
- **Producer**: Backend Architect
- **Critic**: Reality Checker (nặng) + Code Reviewer
- **Complexity**: M
- **Dependency**: T3, T5 (dùng API mint qua cùng client ký HMAC), deploy cả 2 repo xong
- **Chốt hội tụ (Phase 2c, VB1-5)**: CLI là run-path CANONICAL; `POST /admin/backfill/run` + poll progress ĐÃ CẮT khỏi scope; GIỮ `GET /admin/backfill/dry-run` (read-only, tái dùng logic tính toán, có cap/pagination số row quét) + UI import báo cáo JSON từ CLI output.
- **Mô tả KHÔNG AMBIGUOUS**:
  1. Script (tsx/nestjs command) `scripts/backfill-mint.ts`:
     - Query PreTicket status PENDING (theo createdAt ASC — Q3).
     - Với mỗi batch: resolve PortalUser theo emailHash → gọi mint API (kèm userId nếu có, QUA CÙNG CLIENT KÝ HMAC Δ11) → update MINTED + contentTicketId/Code.
     - Idempotent: chạy 2 lần không mint trùng (dựa content idempotency + PreTicket status transition PENDING→MINTING→MINTED atomic).
     - Thiếu quota (Q3 ĐÃ CHỐT): mint đến cạn remaining, phần còn lại → status `EXPIRED` + audit `BACKFILL_QUOTA_EXCEEDED` + in báo cáo tổng kết cho admin (số minted, số expired, jobId các job affected) — KHÔNG âm thầm bỏ.
     - Dry-run mode (`--dry-run`): chỉ in kế hoạch (bao nhiêu PENDING, remaining bao nhiêu, dự kiến bao nhiêu EXPIRED) — KHÔNG gọi mint. Output dạng JSON import được vào UI (Δ5).
     - **Verify-trước-khi-mở-gate (T3-M6, bắt buộc)**: sau mỗi mint run, đối chiếu `HGET ticket_stock:{id} sold` == `SELECT sold` DB cho mọi ticketType vừa mint; lệch → exit-code != 0. Trình tự canonical: mint → verify → mở gate.
  2. KHÔNG xóa lazy-mint runtime path trong task này — chỉ ghi chú xóa sau GA (PRD Story G: giữ cho chạy lại nếu cần).
- **Acceptance Criteria (CHECK ĐƯỢC)**:
  - [ ] Dry-run trên DB dev với dữ liệu giả: in đúng số PENDING, remaining, dự kiến EXPIRED; JSON output import vào UI report view hiển thị đúng.
  - [ ] Chạy thật: mọi PENDING → MINTED (hoặc EXPIRED khi thiếu quota) + contentTicketId set; chạy lần 2 → 0 thay đổi.
  - [ ] Test thiếu quota: remaining < PENDING count → phần vượt thành EXPIRED + audit row `BACKFILL_QUOTA_EXCEEDED` + báo cáo in ra.
  - [ ] Script có `--job-id` filter (chạy theo job) và guard `--confirm` cho chạy thật (mặc định dry-run).
  - [ ] **T3-M6**: làm lệch 1 vé (giả lập HGET/SELECT khác nhau) → script exit-code != 0 + in ticketType lệch.
- **Rủi ro riêng (Reality Checker chặn)**:
  - Chạy nhầm lên DB production — script PHẢI đọc DATABASE_URL từ env + in DB host TRƯỚC khi chạy thật, yêu cầu gõ confirm.
  - PreTicket CLAIMING kẹt (crash cũ) — script phải bỏ qua hoặc xử lý riêng, không coi là PENDING.
  - Số PENDING cũ > remaining mà KHÔNG có dry-run trước → chặn: hướng dẫn vận hành yêu cầu dry-run bắt buộc.
  - `GET /admin/backfill/dry-run` nếu quét không cap → admin-token DoS quét toàn bảng Ticket+PreTicket — phải có pagination/limit (điều kiện Security vòng 2).

---

### [ ] T8 — ticket-mayo: Admin UI job status mint counts

- **Repo**: ticket-mayo
- **Producer**: Frontend Developer
- **Critic**: Code Reviewer + UI Finish-Gate Reviewer
- **Complexity**: S
- **Dependency**: T5 (getStatus trả field mới)
- **Mô tả KHÔNG AMBIGUOUS**:
  1. Admin job status view (frontend hiện có của distribution): hiển thị `minted`, `mintedWithUser`, `mintedEmailOnly`, `mintFailed` (từ getStatus mới). `includeFailed` list: hiện lý do fail per PreTicket.
  2. Lỗi quota (TICKET_SOLD_OUT từ T5): hiển thị message có remaining/requested rõ ràng — không raw error stack.
  3. KHÔNG hiển thị plaintext email (không có dữ liệu — chỉ emailHash rút gọn nếu cần đối chiếu).
  4. Copy template email: đánh dấu TODO-Q5 comment trong template ("Nhận vé" → chờ khách duyệt đổi "Tạo tài khoản để xem vé") — KHÔNG tự đổi copy trong task này.
- **Acceptance Criteria**:
  - [ ] Job list + status view hiển thị 4 field mint count đúng từ API.
  - [ ] Test thủ công/QA screenshot: job có mintFailed > 0 → thấy lý do từng vé trong includeFailed.
  - [ ] Không có plaintext email ở bất kỳ chỗ nào UI.
  - [ ] Build frontend PASS (`npm run build`).
- **Rủi ro riêng**: thấp — chỉ đọc API có sẵn. UI Finish-Gate chỉ chặn layout vỡ/hiển thị sai số.

---

### [ ] T9 — Integration + contract + mutation test (ASSURANCE gate)

- **Repo**: CẢ HAI (chạy ở cả 2 repo, kịch bản cross-repo qua test environment)
- **Producer**: Test Automation Engineer
- **Critic**: Reality Checker (nặng) + Code Reviewer
- **Complexity**: L
- **Dependency**: T3, T5, T6 (T7, T8 test lần cuối)
- **Mô tả KHÔNG AMBIGUOUS**:
  1. End-to-end test (2 service chạy thật trên dev + DB dev): admin phát 5 email (2 có tài khoản, 3 không) → verify content Ticket 5 dòng (2 userId, 3 NULL) + sold +5 + PreTicket MINTED + email mock gửi 5.
  2. Story C e2e: register email thuộc 3 vé email-only → claimedTickets 3 → list-my-tickets hiện 3 vé.
  3. Contract test ticket-mayo ↔ content: schema response mint/link giữ ổn định (snapshot); lỗi mapping (409 quota, 400 validate) không thành 500 ở ticket-mayo.
  4. Mutation test (Stryker hoặc tool đang dùng — memory: G2-Stryker 70% là ngưỡng dự án): focus path mint (quota check, idempotency, sold increment), link (WHERE NULL-safe), sync short-circuit. Ngưỡng theo team (≥70% pattern hiện có).
  5. gitleaks/SAST scan 2 repo — clean (không secret mới, §8.8).
  6. Regression check-in: vé mint eager check-in bằng ticketCode qua `checkInByCode` bình thường (Story B AC — không đổi code, chỉ chứng minh).
- **Acceptance Criteria**:
  - [ ] E2e 2 story trên PASS trên dev, output log đính kèm.
  - [ ] Contract snapshot PASS; intentional-break test (đổi response) → test FAIL (chứng minh snapshot sống).
  - [ ] Mutation report ≥ ngưỡng team cho 3 path trọng tâm; dưới ngưỡng → NEEDS WORK.
  - [ ] gitleaks 2 repo clean.
  - [ ] Check-in vé eager: USED + checkedInAt set đúng.
- **Rủi ro riêng (Reality Checker chặn)**:
  - Test chạy với mock content thay vì service thật → không phải e2e thật — chặn nếu phát hiện.
  - Mutation bỏ qua vì "tool chậm" → không chấp nhận cho path mint/link (PRD §8.7 hard requirement).
  - Mọi claim PASS phải có output/log đính kèm — không tin lời nói (qui trình autobuild: verify claims thủ công).

---

### [ ] T10 — Deploy runbook + smoke test + rollback checklist (không code)

- **Repo**: docs (nội dung đặt trong ticket-mayo docs, tham chiếu deployment)
- **Producer**: DevOps Automator
- **Critic**: Reality Checker + Operations Manager
- **Complexity**: S
- **Dependency**: T1-T9
- **Mô tả KHÔNG AMBIGUOUS**:
  1. Runbook theo thứ tự §0.5: kiểm tra `prisma migrate status` 2 repo → chạy content_pivot nợ (nếu chưa) → migrate content → deploy content → smoke test mint (curl với x-service-token) → migrate ticket-mayo → deploy ticket-mayo (flag LAZY) → smoke distribute nhỏ → bật EAGER → backfill dry-run → backfill thật.
  2. Rollback checklist theo PRD §11.3: flag LAZY (nhanh nhất) → revert branch → migration downgrade (kèm điều kiện Q10).
  3. Monitoring tuần đầu (PRD §11.2): mint success rate, sold reconciliation, sync 5xx, orphan/double-mint alert — ghi rõ query kiểm tra.
  4. Giao user: branch name + lệnh commit dạng text cho CẢ 2 repo (KHÔNG auto-commit).
- **Acceptance Criteria**:
  - [ ] Runbook từng bước có lệnh cụ thể + điều kiện dừng (fail → không sang bước sau).
  - [ ] Smoke test mint có curl mẫu + expected response.
  - [ ] Rollback: 3 tầng rõ ràng + điều kiện kích hoạt (§11.3 rollback criteria).
  - [ ] Text commit command cho user (git -C đúng path từng repo).
- **Rủi ro riêng**: chạy content_pivot nợ trên DB có data không khớp — runbook phải có bước kiểm tra trước (R4).

---

## 2. Ma trận dependency + thứ tự build

```
T1 (content schema) ──┬──> T2 (audit SQL) ──┬──> T3 (API mint/link) ──┬──> T5 (eager distribute) ──> T8 (admin UI)
                       │                      │       │                ├──> T6 (sync + claim E1) ────> T9 (e2e/mutation)
T4 (tm schema) ───────┴──────────────────────┴───────┼────────────────┤
                                T3b (conditional UPDATE — sau T3) <───┤
                                                                        └──> T7 (backfill) ──> T9
T10 (runbook) — viết song song từ T3 trở đi, hoàn thiện sau T9
```

Thứ tự build (wave):

| Wave | Task | Ghi chú |
|---|---|---|
| 1 | T1 + T4 (song song, 2 repo khác nhau) | Không phụ thuộc nhau |
| 2 | T2 (cần T1) | T4 đã xong sẵn cho wave 3 |
| 3 | T3 + T3b (cần T1+T2) | API contract chốt ở đây — T5/T6/T7 phụ thuộc contract. T3b: conditional UPDATE + T3-M5 — **gate flip EAGER ở T8, không gate merge nhánh** |
| 4 | T5 + T6 (song song được nếu contract T3 đóng băng; nếu 1 người thì T5 trước) | Cùng đụng distribution + ticket service |
| 5 | T7 + T8 (song song) | T7 cần T5 pattern mint; T8 cần T5 getStatus. **T8 flip EAGER chỉ sau T3b-1..4 PASS staging** |
| 6 | T9 (ASSURANCE gate) | Chặn merge nếu chưa PASS |
| 7 | T10 (runbook cuối) + security review Q2/Q4 (model khác) trước MERGE |

Merge gate (theo PRD + qui trình autobuild + hội tụ Phase 2c — định nghĩa DONE của plan):

**Merge-gates tổng hợp (từ 3 doc DESIGN/THREAT-MODEL/UI-SPEC — chi tiết bảng 2c-2 DESIGN):**
1. T9 ASSURANCE PASS (test + mutation ≥70% + gitleaks 2 repo clean).
2. **TM-1**: `crypto.timingSafeEqual` thay `===` trong ServiceTokenGuard (content-service `src/interceptors/service-token.guard.ts:16`) + 2 contract test x-user-id bỏ qua.
3. **TM-3**: dọn plaintext email 4 vị trí log — `auth.service.ts:56,84` + `admin-bootstrap.service.ts:28,38` → emailHash/userId.
4. **TM-4**: DTO limits `@ArrayMaxSize(1000)` + `@Max(10)` (ticket-mayo `distribute-request.dto.ts:16-18` + content internal-distribution DTO).
5. **T3-M5..M8**: M5 refreshSoldFromDb retry+CRITICAL alert (Δ1); M6 verify-script exit-code (T7); M7 mirror-check reconciliation ≤15 phút (Δ9); M8 post-mint self-verify per-run → PARTIALLY_MINTED + alert.
6. Security review Q2/Q4 bởi model khác — **chặn merge, không chặn build**. Q4 gồm xác nhận HMAC Δ11 (build vẫn làm trong scope).
7. Human gate (user) review diff + tự commit (no auto-commit).

Tham chiếu thiết kế chốt cho từng task: Δ1 → T3 (refreshSoldFromDb), Δ2 → T3 (de-dup preTicketId), Δ3 → T3 (timing-safe), Δ4 → T5 (log email + DTO cap), Δ5 → T4/T5/T8 (endpoint admin + cột PreTicket), Δ6 → T4 (mintMode + placeholder), Δ7 → T5 (pass-through error), Δ8 → T6 (rate-limit 30/60s), Δ9 → T5/T7 (reconciliation 2 tầng), Δ10 → ngoài scope (DEBT-kafka-pii), Δ11 → T3 verify + T5/T7 ký (HMAC MINT_SIGNING_KEY). Chi tiết: `DESIGN-ticket-email-mint-sync.md` mục VB2-B + 2c-4.

---

## 3. Điểm rủi ro Reality Checker chặn từng task

| Task | Điểm chặn chính (NEEDS WORK nếu không vượt) |
|---|---|
| T1 | Downgrade không xử lý vé NULL; migration đụng bảng khác ngoài 3 thay đổi |
| T2 | Danh sách grep không độc lập-verify; query NULL lọt fan-out/stats; compile fix ngầm đổi behavior |
| T3 | Thiếu WHERE NULL-safe ở link; mint không idempotent content-side; plaintext email trong log; quota check ngoài tx; không verify HMAC sig (Δ11) |
| T3b | Guard chặn nhầm purchase hợp lệ (chỉ test mới, không regression cũ); releaseStock bồi hoàn thiếu; flip EAGER trước khi T3b-1..4 PASS |
| T4 | Migrate khi content_pivot chưa chạy; enum thiếu giá trị lịch sử |
| T5 | PreTicket mồ côi khi mint fail; double-mint khi retry; gửi email trước mint xong; flag LAZY không nguyên vẹn; refresh Redis fail âm thầm (T3-M5) |
| T6 | Link với emailHash user khác (bảo mật); short-circuit marker kẹt vĩnh viễn; sync fail làm register 500 |
| T7 | Không dry-run mặc định; chạy nhầm production; CLAIMING kẹt bị coi là PENDING; dry-run HTTP không cap quét |
| T8 | Hiển thị plaintext email; số liệu không khớp API |
| T9 | Test dùng mock thay service thật; mutation bỏ path mint/link; claim PASS không có log |
| T10 | Thiếu điều kiện dừng giữa bước; rollback thiếu điều kiện kích hoạt; thiếu điều kiện flip EAGER sau T3b |

Rủi ro cao nhất toàn initiative (PM đánh giá):
1. **R1/T2** — nullable userId phá service khác của content-service (đã có 4 audit blocker chưa đóng ở service này — memory `project_content_service_audit`). Critic phải grep độc lập.
2. **T5 retry path** — PreTicket tồn tại trước mint + job FAILED → phát lại = doubling. Đây là chỗ thiết kế hiện tại (tạo PreTicket trong tx trước) mâu thuẫn eager mint; producer phải chốt xử lý rõ ràng.
3. **Deploy lệch pha R5** — ticket-mayo mới gọi mint khi content chưa deploy = mọi phát vé fail. Runbook T10 + flag LAZY là lớp bảo vệ.

---

## 4. Token / time budget ước tính

Ước tính theo pattern dự án (1 producer pass + 2-3 vòng critic):

| Phase | Task | Producer token ước tính | Critic (mỗi critic/vòng) | Time |
|---|---|---|---|---|
| Wave 1 | T1 + T4 | 40k + 25k | 15-25k × 2 critic/task | 0.5 ngày |
| Wave 2 | T2 | 60k (L — grep toàn repo) | 25k × 3 critic | 1 ngày |
| Wave 3 | T3 + T3b | 80k + 35k (L + M — API + contract test + conditional UPDATE) | 30k × 3 critic | 1.5-2 ngày |
| Wave 4 | T5 + T6 | 90k + 70k | 30k × 3 critic/task | 1.5-2 ngày |
| Wave 5 | T7 + T8 | 40k + 20k | 15-20k × 2 critic/task | 0.5-1 ngày |
| Wave 6 | T9 | 70k | 25k × 2 critic | 1 ngày |
| Wave 7 | T10 | 20k | 10k × 2 | 0.25 ngày |
| Tổng | | ~550k producer + ~580k critic ≈ 1.1-1.3M tokens | | ~6.5-8.5 ngày làm việc |

Lưu ý: token budget có thể vượt nếu T2 phát hiện nhiều chỗ phải sửa (R1) — nếu T2 vượt 100k producer token mà chưa xong → escalate về PM đánh giá lại scope (đúng cảnh báo PRD §7.2 option B).

---

## 5. Phụ lục

- PRD: `c:\MAYogu_VIASG\ticket-mayo\docs\PRD-ticket-email-mint-sync.md`
- Thiết kế chốt hội tụ: `c:\MAYogu_VIASG\ticket-mayo\docs\DESIGN-ticket-email-mint-sync.md` mục "Thiết kế chốt hội tụ (Phase 2c)" — Δ1-Δ11 + merge-gates + F-07 known-risk.
- File đã verify khi viết plan này: `content-service/src/core/services/internal-ticket-distribution.service.ts`, `content-service/prisma/schema.prisma` (model Ticket ~484), `ticket-mayo/src/modules/distribution/distribution.service.ts`, `ticket-mayo/prisma/schema.prisma`.
- Quy trình: autobuild 3 cổng người, critic hoài nghi, KHÔNG auto-commit, KHÔNG auto-merge, mọi git qua `git -C <repo>`.

---

## T2-input: danh sách chỗ break do T1

*(Append 2026-08-27 bởi T1 producer — không sửa nội dung nào phía trên.)*

**Kết quả compile: 0 lỗi.** `npx prisma generate` (schema Ticket với `userId String?`, `recipientEmailHash String?`, `preTicketId String? @unique`) sau đó `npx tsc --noEmit` → exit code 0, không có file nào break vì userId nullable.

Ghi chú quan trọng cho T2 (compile PASS không có nghĩa là NULL-safe):

1. **Raw SQL là điểm rủi ro chính** — TypeScript không type-check chuỗi `$queryRaw`. Theo DESIGN §9.4, T2 phải độc lập verify 3 chỗ:
   - `findUserIdsByEventId` — cần `WHERE "userId" IS NOT NULL`.
   - `countAllUserTicketCounters` — cần `IS NOT NULL` (fan-out/aggregate).
   - `getTicketOwnerIds` — đã NULL-safe sẵn (không cần sửa).
2. `npx prisma generate` báo EPERM khi rename `query_engine-windows.dll.node` trên Windows (DLL bị khóa bởi node process đang chạy) — cosmetic; `node_modules/.prisma/client/index.d.ts` đã regenerate đúng (`userId: string | null` trên các payload/aggregate type của Ticket), và `tsc` PASS xác nhận types chuẩn. Chạy lại generate khi cần engine binary.
3. Prisma index naming: index thường đặt tên `Ticket_recipientEmailHash_idx` (suffix `_idx` theo convention `@@index`), còn `preTicketId` unique đặt `Ticket_preTicketId_key` (suffix `_key` theo convention `@unique`). DESIGN §1.1 minh họa cả 2 là `_key` — migration chạy theo tên chuẩn của Prisma; T2/T10 tham chiếu index thì dùng đúng 2 tên vừa nêu.
