# WORKFLOW: Ticket Email Eager-Mint & Sync (ticket-mayo x content-service)

**Version**: 0.1
**Date**: 2026-08-27
**Author**: Workflow Architect
**Status**: Draft
**Implements**: `docs/PRD-ticket-email-mint-sync.md` (Approved v1.1)
**Repos**: `c:\MAYogu_VIASG\ticket-mayo` (orchestrator + email + portal), `c:\MAYogu_VIASG\content-service` (nguồn sự thật Event/TicketType/Ticket/check-in)

---

## 0. Phạm vi doc này

6 workflow, mỗi cái một mục riêng:

| WF | Tên | Trigger chính |
|---|---|---|
| WF1 | Eager distribution (admin submit → mint → email) | Admin UI "Phát vé" |
| WF2 | Sync link-by-email (3 điểm trigger) | register / login / list-my-tickets |
| WF3 | Claim-link semantics E1 ("xem vé / tạo tài khoản") | User click link trong email |
| WF4 | Backfill PreTicket PENDING cũ | Script ops chạy 1 lần |
| WF5 | Feature flag LAZY/EAGER runtime switch | Ops đổi env |
| WF6 | Deploy / rollback | Release train |

Mọi wf dùng chung 2 state machine và 2 handoff contract ở mục 1–2. Doc này là **behavior spec** — không quyết định implementation (Prisma raw SQL, cache, v.v. do Backend Architect).

**Code đã verify làm nền** (đọc 2026-08-27, không lấy từ mô tả):
- `ticket-mayo/src/modules/distribution/distribution.service.ts` — `distribute()` hiện tại: idempotency check → resolve TicketType → normalize+dedupe → tx tạo Job(RUNNING)+PreTicket(PENDING) → dispatchBatch email tuần tự per-email try/catch → update job COMPLETED/FAILED.
- `ticket-mayo/src/modules/ticket/ticket.service.ts` — `resolvePreTicket`: atomic lock `updateMany WHERE status='PENDING' → CLAIMING` (count===0 thua lock), fail → rollback CLAIMING→PENDING. Đây là pattern tái dùng cho MINTING.
- `ticket-mayo/src/modules/claim/claim.service.ts` — token lookup, 404 không leak email, `needsAuth` khi chưa login HOẶC emailHash không khớp.
- `ticket-mayo/src/modules/auth/auth.service.ts` + `ticket-portal/ticket-portal.service.ts` — 3 điểm gọi `resolvePendingPreTickets` hiện có.
- `ticket-mayo/src/modules/content-client/content-client.service.ts` — timeout 15s/call, `x-service-token`, unwrap `{success,data}`, non-OK → BadGateway, timeout → ServiceUnavailable.
- `ticket-mayo/src/modules/mail-dispatcher/mail-dispatcher.service.ts` — `dispatchBatch` per-email try/catch, trả `{dispatched, failed}`, KHÔNG retry.
- `ticket-mayo/prisma/schema.prisma` — PreTicket status enum `PENDING|CLAIMING|CLAIMED|EXPIRED`, `contentTicketId @unique`, `claimToken @unique`; DistributionJob status `PENDING|RUNNING|COMPLETED|FAILED`, `idempotencyKey @unique`. **Chưa có** MINTING/MINTED/LINKED, **chưa có** `recipientUserId`.
- `content-service/src/core/services/internal-ticket-distribution.service.ts` — `issueTickets`: quota check `sold + quantity > quantity` → `TICKET_SOLD_OUT` (409) **NGOÀI tx** (check-then-act — xem F-01), rồi mới `registerTicketsWithTx`.
- `content-service/src/infrastructure/driven-adapters/persistence/postgres/ticket.repository.adapter.ts` — `registerTicketsWithTx`: tx { sold increment → nextTicketCodes sequence → createMany }.
- `content-service/prisma/schema.prisma` — Ticket.userId **non-nullable**, không có cột email.

---

## 1. State Machines (nguồn sự thật cho mọi WF)

### 1.1. PreTicket (ticket-mayo) — enum MỚI: `PENDING | MINTING | MINTED | LINKED | CLAIMING | CLAIMED | EXPIRED`

```
                         ┌──────────────────────────────────────────────┐
                         │  (legacy lazy path — flag LAZY / backfill    │
                         │   transition, xóa sau khi EAGER ổn định)     │
                         v                                              │
 [PENDING] ──claim/login─> [CLAIMING] ──issue ok──> [CLAIMED] (terminal)│
    │                        │                                          │
    │ rollback               │ fail (caught)                            │
    │ <──────────────────────┘                                          │
    │                                                                   │
    │  WF1: distribute() eager mint (flag EAGER)                        │
    v                                                                   │
 [PENDING] ──lock──> [MINTING] ──content mint ok + update local──> [MINTED]
    ^                     │                                            │   │
    │ rollback (caught    │                                            │   │ WF2: link-by-email ok
    │ fail, mint-safe vì  │                                            │   v (recipientUserId NULL)
    │ idempotent content) │                                            │ [LINKED] (terminal cho
    └─────────────────────┘                                            │   vòng đời phát hành)
    │                                                                  │
    │  crash giữa mint xong và update local → MINTING stuck ───────────┘ recover: resume
    │  (WF1-R) re-gọi mint idempotent → MINTED
    │
    │  WF4: backfill hết quota
    +──────────────────────────────────────────> [EXPIRED] (terminal — không hồi sinh)
```

Bảng transition chuẩn (mọi WF phải tuân):

| # | Từ → Đến | Ai thực hiện | Guard | Ghi chú |
|---|---|---|---|---|
| PT-1 | PENDING → MINTING | `distribute()` (WF1) / backfill (WF4) | atomic `updateMany WHERE id IN (batch) AND status='PENDING'`; per-PreTicket count kiểm tra | Chống 2 caller cùng mint 1 PreTicket |
| PT-2 | MINTING → MINTED | `distribute()` sau mint response | content trả ticketId cho preTicketId đó | Ghi `contentTicketId`, `contentTicketCode`, `recipientUserId` (nếu resolve được) |
| PT-3 | MINTING → PENDING | `distribute()` khi mint fail (caught) | chỉ khi đã nhận response fail rõ ràng (4xx/5xx) | AN TOÀN vì content mint idempotent theo preTicketId (contract C-1) — retry không double |
| PT-4 | MINTED → LINKED | sync (WF2) sau `link-by-email` thành công | PreTicket `recipientUserId IS NULL`; link call trả HTTP 200 (dù linked=0) | **Bắt buộc có** — không có trạng thái này thì short-circuit WF2 không bao giờ true (xem F-03) |
| PT-5 | PENDING → CLAIMING → CLAIMED | legacy claim path (WF3 transition / flag LAZY) | pattern `resolvePreTicket` hiện có, giữ nguyên | Chỉ cho PreTicket sinh ra trước deploy EAGER |
| PT-6 | PENDING/MINTING → EXPIRED | backfill (WF4) khi hết quota | backfill quyết định, kèm audit `BACKFILL_QUOTA_EXCEEDED` | Terminal. Admin phát lại bằng job MỚI |

Quy ước: `MINTING` tồn tại > 10 phút = **stuck** (crash giữa chừng) — chỉ thoát bằng WF1-R resume hoặc backfill, KHÔNG bao giờ rollback tự động về PENDING bởi background job (tránh mint đôi khi content đã mint xong nhưng response mất).

### 1.2. DistributionJob (ticket-mayo) — enum MỚI thêm `PARTIALLY_MINTED`: `PENDING | RUNNING | COMPLETED | FAILED | PARTIALLY_MINTED`

| Từ → Đến | Điều kiện | Ý nghĩa admin |
|---|---|---|
| → RUNNING | tạo job trong tx cùng PreTicket (hiện có) | job bắt đầu |
| RUNNING → COMPLETED | 100% PreTicket MINTED + email dispatch xong (email fail từng cái KHÔNG làm job fail — đếm vào `failed` hiện có) | Đợt phát xong. Có thể có `failed` email > 0 — xem cột trong UI |
| RUNNING → FAILED | 0 PreTicket MINTED (mint fail toàn bộ HOẶC quota chặn toàn batch trước khi tạo — trường hợp này job không tồn tại, xem E1.2) | Không email nào gửi; retry an toàn |
| RUNNING → PARTIALLY_MINTED | một phần PreTicket MINTED, một phần PENDING (mint per-recipient/chunk fail) | Cần action "retry phần fail" (WF1-R2) |
| RUNNING → RUNNING (resume) | idempotency-hit với job RUNNING (WF1-R) | Job kẹt được kéo tiếp |

Số liệu mint (`minted`, `mintedWithUser`, `mintedEmailOnly`, `mintFailed`) — **derived từ PreTicket** theo PRD Story H, không thêm cột.

### 1.3. Ticket (content-service) — schema change

- `userId String?` (nullable), `recipientEmailHash String?`, index `(recipientEmailHash) WHERE userId IS NULL` (partial) hoặc thường — Backend Architect chọn, behavior cần: lookup theo emailHash nhanh.
- Trạng thái vé `VALID/USED/CANCELLED` và check-in flow KHÔNG đổi.
- Vé unlinked (`userId IS NULL`): không hiện ở portal nào; chỉ thao tác được: link-by-email, check-in theo code, admin ops.
- `getTicket` ownership check hiện `ticket.userId !== userId` → null-safe tự nhiên (null ≠ string → 403). QA phải có regression test (TC-W6-xx).

---

## 2. Handoff Contracts

### C-1: ticket-mayo → content-service `POST /internal/distribution/mint`

- Guard: `ServiceTokenGuard` (`x-service-token`), KHÔNG nhận user identity từ client.
- Request:
```json
{
  "eventId": "string",
  "ticketTypeId": "string",
  "idempotencyKey": "string — jobId của ticket-mayo",
  "recipients": [
    { "preTicketId": "string — idempotency domain", "emailHash": "string HMAC-SHA256", "userId": "string? — NULL nếu chưa có PortalUser" }
  ]
}
```
- Behavior bắt buộc:
  1. **Quota check toàn batch trong cùng tx với sold increment, có row-lock TicketType** (`UPDATE ticketType SET sold = sold + :N WHERE id = :id AND sold + :N <= quantity`; 0 row affected → fail batch với remaining chính xác). KHÔNG lặp pattern check-then-act hiện tại của `issueTickets` (xem F-01).
  2. **Idempotent theo preTicketId**: với mỗi recipient, nếu đã tồn tại Ticket mapping preTicketId → trả ticket cũ kèm `"alreadyMinted": true`, KHÔNG tạo mới, KHÔNG tăng sold lần 2. (Mapping qua cột unique hoặc bảng mapping — implementation tự chọn, contract là at-most-1 Ticket per preTicketId.)
  3. Chunking (R10): nếu batch > 1000 vé thì chia chunk, mỗi chunk atomic với quota check lũy kế; response gộp.
- Success 200:
```json
{ "results": [ { "preTicketId": "string", "ticketId": "string", "ticketCode": "string", "alreadyMinted": false } ], "soldAfter": 123 }
```
- Failure (toàn batch):
```json
{ "message": "Hết vé hoặc vượt quota: remaining=10, yêu cầu=15.", "code": "TICKET_SOLD_OUT" }
```
  HTTP 409. Các mã: `TICKET_SOLD_OUT` (409), `TICKET_TYPE_NOT_FOUND` (404), validation (400).
- Per-recipient fail (validation data xấu từng dòng): mục trong `results` mang `"error": "code"` thay vì ticketId — batch còn lại vẫn mint.
- Timeout phía caller: 15s (theo `content-client` hiện có). Timeout ≠ fail definitively — caller PHẢI xử theo PT-3/WF1-R (re-mint idempotent), không được coi timeout = "chưa mint" rồi quên.
- Audit content-side: log mỗi mint call (jobId, số vé, sold trước/sau). Không log plaintext email (chỉ có hash trong payload — giữ nguyên).

### C-2: ticket-mayo → content-service `POST /internal/distribution/link-by-email`

- Request: `{ "emailHash": "string", "userId": "string" }`
- Behavior: `UPDATE ticket SET userId = :userId WHERE recipientEmailHash = :emailHash AND userId IS NULL` — một statement atomic; mọi caller đồng thời chạy tuần tự trên cùng dòng, thằng sau update 0 dòng.
- Success 200: `{ "linked": N }` (N ≥ 0; N=0 hợp lệ — idempotent).
- Failure: 4xx/5xx theo guard/validation; không có case "conflict".
- Timeout 15s. Timeout/5xx tại caller = sync fail-soft (WF2 — KHÔNG fail request gốc).

---

## 3. WF1 — Eager Distribution

### 3.1. Actors

| Actor | Role |
|---|---|
| Admin vé | submit form phát vé (event, ticketType, quantity, list email, idempotencyKey) |
| ticket-mayo `DistributionService.distribute()` | orchestrator |
| ticket-mayo DB (Prisma) | DistributionJob, PreTicket, DistributionAudit |
| content-service mint API (C-1) | tạo Ticket thật + tăng sold |
| MailDispatcher (SMTP) | gửi email claim-link |
| Người nhận | nhận email (passive trong WF1) |

### 3.2. Workflow tree

```
E1.1 SUBMIT & IDEMPOTENCY CHECK (distribute() đầu hàm)
E1.2 RESOLVE TICKETTYPE + PRE-QUOTA CHECK (fail nhanh)
E1.3 NORMALIZE + DEDUPE RECIPIENTS
E1.4 RESOLVE userId TỪNG EMAIL (query PortalUser theo emailHash — cùng DB)
E1.5 TX: tạo Job(RUNNING) + PreTickets(PENDING, kèm recipientUserId nếu có)
E1.6 LOCK PENDING→MINTING (atomic updateMany, per PreTicket)
E1.7 MINT: POST /internal/distribution/mint (C-1)
     ├─ all ok ──────────────> E1.8
     ├─ timeout ─────────────> E1.7-F1
     ├─ 409 TICKET_SOLD_OUT ─> E1.7-F2
     ├─ per-recipient fail ──> E1.7-F3
     └─ 5xx/other 4xx ───────> E1.7-F4
E1.8 UPDATE PreTicket → MINTED (contentTicketId, contentTicketCode)
E1.9 EMAIL DISPATCH (chỉ PreTicket MINTED) → E1.10 FINALIZE JOB
```

### 3.3. Chi tiết từng bước

**E1.1 — Idempotency check**
- Caller: `distribute(dto, adminId)`. Query: `distributionJob.findUnique({ idempotencyKey })` (hiện có).
- Guard: `dto.idempotencyKey` có giá trị.
- Nhánh:
  - Job tồn tại, status `COMPLETED|FAILED|PARTIALLY_MINTED` → trả job cũ nguyên trạng (spec hiện có giữ nguyên).
  - Job tồn tại, status `RUNNING` → **RESUME (WF1-R1)**, không phải no-op. Lý do: code hiện tại trả về job RUNNING và bỏ luôn — job crash giữa chừng sẽ kẹt vĩnh viễn vì cùng key không chạy tiếp, key khác thì mint/email đôi (xem F-02).
  - Không tồn tại → đi tiếp. Race insert cùng key → `P2002` → re-read (hiện có, giữ).

**E1.2 — Resolve TicketType + pre-check quota**
- Caller: `eventService.getTicketTypeWithEvent(ticketTypeId)` (hiện có).
- Fail: 404 → trả admin lỗi, chưa tạo gì (hiện có).
- Pre-check quota (MỚI, chỉ để fail nhanh — KHÔNG phải nguồn sự thật): `tt.sold + seeds.length > tt.quantity` ước lượng từ response → trả 4xx kèm `remaining`, `requested`. Không tạo job/PreTicket, không mint, không email (Story F).
  - Lưu ý: remaining đọc được có thể stale — mint tx ở content mới là guard cuối.

**E1.3 — Normalize + dedupe**: giữ nguyên `normalizeAndDedupe` (lowercase/trim, dedupe theo hash). Fail: 0 email hợp lệ → 409, chưa tạo gì.

**E1.4 — Resolve userId từng email (MỚI)**
- Query: `portalUser.findMany({ where: { emailHash: { in: [...] } } })` — cùng DB ticket-mayo, không HTTP.
- Kết quả gắn vào seed: `recipientUserId: string | null`. KHÔNG gọi user-community (nguyên tắc Q1: identity = PortalUser).

**E1.5 — TX tạo Job + PreTickets (sửa bước 5 hiện có)**
- Giữ nguyên tx `create job + createMany preTicket`, thêm cột `recipientUserId`.
- Job `total` = số PreTicket (như hiện tại: recipients × quantity, mỗi vé 1 PreTicket 1 claim token).
- Fail: tx rollback → không có gì phải cleanup (chưa mint, chưa email).

**E1.6 — Lock PENDING→MINTING (MỚI, tái dùng pattern CLAIMING)**
- `updateMany({ where: { jobId, status: 'PENDING' }, data: { status: 'MINTING' } })` — batch lock trước khi gọi HTTP (khác claim: claim lock 1 PreTicket).
- Crash sau lock, trước mint xong → MINTING stuck → chỉ WF1-R1 gỡ.

**E1.7 — Mint (C-1)** — các failure mode:

| Mode | Phát hiện | Hành động | PreTicket sau đó | Email | Job |
|---|---|---|---|---|---|
| **E1.7-F1 timeout** (15s) | `ServiceUnavailableException` từ content-client | KHÔNG rollback vội về PENDING nếu định retry ngay trong process: retry 1 lần (backoff 5s, re-gọi mint — idempotent theo preTicketId). Vẫn timeout → rollback PT-3 về PENDING + đánh dấu lỗi per-recipient | PENDING | 0 email cho các vé này | Nếu 0 vé MINTED → FAILED; một phần → PARTIALLY_MINTED |
| **E1.7-F2 SOLD_OUT toàn batch** | HTTP 409 `TICKET_SOLD_OUT` | Rollback tất cả MINTING→PENDING. KHÔNG gửi email nào. Thông báo admin kèm remaining/requested từ message content | PENDING | 0 | FAILED (reason=quota) |
| **E1.7-F3 per-recipient fail** | mục `results[i].error` | PreTicket thất bại → rollback về PENDING (giữ để retry R2); PreTicket thành công → MINTED | Mix MINTED/PENDING | Email CHỈ cho MINTED | ≥1 MINTED → PARTIALLY_MINTED; 0 → FAILED |
| **E1.7-F4 5xx/4xx khác** | BadGatewayException | Như F1: retry 1 lần → fail → rollback PENDING, đánh dấu | PENDING | 0 | FAILED/PARTIALLY_MINTED |
| **Crash process giữa mint xong (content committed) và E1.8** | Không có catch chạy | PreTicket kẹt MINTING; content ĐÃ có Ticket + mapping preTicketId | MINTING (stuck) | 0 email | RUNNING (stuck) → WF1-R1 |

**E1.8 — Update PreTicket → MINTED**
- Per-recipient: `updateMany({ where: { id, status: 'MINTING' }, data: { status: 'MINTED', contentTicketId, contentTicketCode } })` — count===0 nghĩa là mất lock (bất thường) → log error + audit, không throw cả batch.
- `contentTicketId @unique` đã có — conflict = bất biến bị phá (double-mint) → log CRITICAL + alert (monitoring mục 8 PRD).

**E1.9 — Email dispatch (chỉ MINTED)**
- Giữ `dispatchBatch` per-email try/catch hiện có, payload lọc `preTicket.status === 'MINTED'` (hoặc đợi theo chunk — R10: chunk i mint xong thì email chunk i).
- Email fail từng cái: vé vẫn an toàn (đã MINTED), job vẫn hoàn tất được; `failed` count ghi như hiện tại; admin xem `includeFailed`. KHÔNG auto-retry (non-goal #8).
- Toàn bộ email fail (dispatched=0, mọi vé MINTED): job COMPLETED với sent=0? — QUYẾT ĐỊNH: job `COMPLETED` (mint thành công là điều kiện nghiệp vụ chính) + audit `EMAIL_ALL_FAILED` để admin thấy. Không FAILED vì vé đã tồn tại, retry-by-key sẽ no-op.

**E1.10 — Finalize job**: update `sent/failed` + status theo bảng 1.2. Trả job cho admin UI.

### 3.4. WF1-R — Recovery paths

**WF1-R1: Resume job RUNNING kẹt (admin bấm lại submit cùng idempotencyKey, hoặc admin action "resume job")**
1. Đọc job + PreTickets.
2. `MINTING` (stuck > 10 phút): re-gọi C-1 với đúng danh sách `preTicketId` này → content trả ticket cũ (`alreadyMinted: true`) hoặc mint mới → update MINTED. Idempotency content-side là cơ chế chống double (không phải lock phía ticket-mayo — lock đã mất khi crash).
3. `PENDING` trong job: mint tiếp như E1.6–E1.8.
4. Email: chỉ gửi cho PreTicket MINTED **chưa từng gửi** — cần dấu hiệu đã gửi per-PreTicket. **YÊU CẦU MỚI (F-05)**: thêm cột `emailSentAt DateTime?` trên PreTicket (hoặc tính từ job status nếu throttle đủ) — không có dấu này, resume sẽ gửi email đôi cho người đã nhận.

**WF1-R2: Retry phần fail của job PARTIALLY_MINTED (admin action trên job status UI)**
- Guard: job status = PARTIALLY_MINTED; PreTicket PENDING của job đó.
- Chạy lại E1.6–E1.9 CHỈ cho PreTicket PENDING. Email chỉ cho newly-MINTED.
- Lưu ý QUAN TRỌNG: "retry bằng idempotencyKey" như PRD Story F nói là CHỐ—an toàn vì trả job cũ—nhưng KHÔNG retry được cái gì. Retry thật sự phải là action này. Xem F-04.

**WF1-R3: 2 admin phát đồng thời đụng quota (R9)**
- Cả 2 job tạo được PreTicket PENDING (không chặn ở E1.5 — remaining stale).
- Cả 2 gọi C-1; content tx row-lock TicketType → job A commit trước (mint đủ), job B thấy `sold + N > quantity` trong tx → 409 → E1.7-F2 path → job B FAILED sạch (PENDING rollback, 0 email).
- Bất biến QA: tổng Ticket mint ≤ quantity; không over-mint kể cả 2 request đồng thời.

### 3.5. Observable states (WF1)

| Thời điểm | Admin thấy | DB ticket-mayo | DB content | Logs/Audit |
|---|---|---|---|---|
| E1.5 xong | job "RUNNING", total=N | Job RUNNING, N PreTicket PENDING (recipientUserId set/không) | chưa đổi | `DISTRIBUTION_START` |
| E1.7 đang chạy | job RUNNING (minting) | PreTicket MINTING | (trong tx) sold chưa đổi tới khi commit | content log mint call |
| E1.8 xong từng vé | minted count tăng (poll getStatus) | PreTicket MINTED + contentTicketId | Ticket VALID, userId hoặc NULL, sold +N | `PRETICKET_MINTED` per vé (khuyến nghị batch 1 audit/job) |
| E1.9 xong | COMPLETED/PARTIALLY_MINTED, sent/failed | emailSentAt set | không đổi | dispatchBatch log dispatched/failed |
| Fail quota | FAILED + message remaining rõ | PreTicket PENDING (rollback) | KHÔNG đổi (tx rollback content) | audit `MINT_BATCH_REJECTED` |
| Crash | job RUNNING đứng > 10p (alert) | MINTING stuck | Ticket có mapping preTicketId | alert reconciliation |

---

## 4. WF2 — Sync link-by-email (3 điểm trigger)

### 4.1. Tree chung

```
S1. TRIGGER: register | login | list-my-tickets  (ticket-mayo, sau khi user đã xác thực)
S2. LOCAL SHORT-CIRCUIT CHECK
    ├─ không còn PreTicket (status MINTED AND recipientUserId IS NULL) cho emailHash
    │    → BỎ QUA (0 HTTP call) ──> S5 (request gốc tiếp tục bình thường)
    └─ còn ──> S3
S3. POST /internal/distribution/link-by-email (C-2)
    ├─ 200 {linked: N} ──> S4
    ├─ timeout / 5xx ───> S-FAIL (fail-soft)
    └─ 4xx validation ──> S-FAIL (log — bug caller, không retry tự động)
S4. MARK LINKED: updateMany PreTicket (emailHash, status MINTED, recipientUserId NULL)
    → status LINKED (kể cả khi N=0 — claim an toàn vì mọi vé content-side của emailHash giờ đều có userId
       hoặc không tồn tại; vé mint SAU thời điểm này sẽ được resolve userId ngay ở E1.4)
    → claimedTickets = N trong response
S5. REQUEST GỐC TIẾP TỤC (listMyTickets gọi getUserTickets như hiện có)

S-FAIL (sync fail-soft):
  - KHÔNG throw, KHÔNG fail register/login/list
  - claimedTickets = 0; log warn `sync link-by-email failed user=… emailHash=…`
  - PreTicket vẫn MINTED (short-circuit S2 lần sau vẫn true) → request KẾ TIẾP tự retry
```

### 4.2. Per-trigger chi tiết

| Trigger | Vị trí code | Trước/sau gì | Response field |
|---|---|---|---|
| register | `auth.service.ts register()` sau `portalUser.create`, TRƯỚC signJwt — HTTP call KHÔNG nằm trong tx tạo user | user đã commit là điều kiện sync chạy; sync fail không ảnh hưởng user | `claimedTickets` (giữ tên field hiện có) |
| login | `auth.service.ts login()` sau verify password | như trên | `claimedTickets` |
| list-my-tickets | `ticket-portal.service.ts listMyTickets()` TRƯỚC `content.getUserTickets` — đúng yêu cầu "api lấy vé của tôi call thêm email" | sync xong mới list → vé vừa link hiện ngay cùng request | `claimedTickets` (đổi semantics mint-count → linked-count) |

### 4.3. Race & idempotency

- **2 trigger đồng thời** (login + list-my-tickets cùng user): C-2 là single UPDATE với guard `userId IS NULL` → PG tuần tự hóa trên cùng dòng; call sau `linked=0`. Không duplicate, không 500. QA: TC-W2-04.
- **S4 race với mint mới** (admin phát cho cùng email lúc user đang register): mint resolve userId ở E1.4 — nếu user chưa commit thì vé mint email-only, PreTicket MINTED-unlinked sinh ra SAU S4 → short-circuit lần trigger kế vẫn bắt. An toàn theo thiết kế.
- **Idempotent**: gọi lại bao nhiêu lần cũng `linked=0`, PreTicket đã LINKED không vào lại S3.

### 4.4. Observable states (WF2)

| Trạng thái | User thấy | DB |
|---|---|---|
| Short-circuit (0 sync) | response nhanh (+0ms HTTP) | PreTicket toàn LINKED/CLAIMED hoặc không có |
| Sync ok N>0 | register response `claimedTickets: N`; "Vé của tôi" đủ N vé (list trigger) | Ticket.userId set; PreTicket LINKED |
| Sync ok N=0 | bình thường | PreTicket LINKED (dọn short-circuit) |
| Sync fail | register/login vẫn 200; list vẫn 200 (vé cũ); vé mới chưa hiện | PreTicket vẫn MINTED-unlinked; log warn |

---

## 5. WF3 — Claim-link semantics E1

### 5.1. Tree

```
C1. CLICK LINK /c/:token ──> claim(token, requestingUser?)
C2. LOOKUP PreTicket theo claimToken (unique)
    └─ không tồn tại ──> 404 GENERIC (không leak email — giữ nguyên behavior hiện có)
C3. SWITCH theo PreTicket.status:
    ├─ MINTED / LINKED, user đã login, emailHash khớp
    │     → (nếu MINTED: chạy sync WF2 S2–S4) → redirect "Vé của tôi"
    │       KHÔNG mint, KHÔNG tạo vé mới (assert contentTicketId đã có)
    ├─ MINTED / LINKED, chưa login ──> { needsAuth: true } ──> prompt login/register
    │     (register xong → WF2 sync → thấy vé — Story C)
    ├─ MINTED / LINKED, đã login nhưng emailHash KHÔNG khớp ──> { needsAuth: true } (không leak)
    ├─ PENDING (dữ liệu cũ chưa backfill — giai đoạn transition)
    │     → PATH LEGACY: resolvePreTicket lazy-mint như hiện tại (lock PENDING→CLAIMING→CLAIMED)
    │       [chỉ tồn tại tới khi backfill xong + xóa lazy runtime path]
    ├─ MINTING → trả { processing: true } — UI hiện "Đang xử lý, thử lại sau" (thường < 1 phút)
    ├─ CLAIMING → như hiện tại (in-flight) — trả processing hoặc retry
    ├─ CLAIMED, cùng user ──> { ok, alreadyClaimed, ticketId } (hiện có)
    └─ EXPIRED (backfill hết quota) ──> thông báo trung thực:
          "Vé này đã hết hạn do hết lượt phát — vui lòng liên hệ ban tổ chức"
          (KHÔNG hứa vé; không leak email; audit CLAIM_EXPIRED_VIEW)
```

### 5.2. Ghi chú behavior

- Email template copy đổi "Nhận vé" → "Xem vé / Tạo tài khoản để xem vé" (Q5 — khách duyệt copy trước deploy ticket-mayo; workflow không phụ thuộc copy).
- Mã hiển thị trong email vẫn là `claimToken.slice(-8)` giả (D5) — giữ nguyên.
- MINTED + user khớp nhưng sync fail (content timeout): vẫn redirect "Vé của tôi" — vé có userId từ lúc mint (E1.4 resolve được) → hiện ngay; trường hợp email-only thì sync fail → vé chưa hiện, request kế retry (WF2 fail-soft). UI không được hard-error.
- Transition path PENDING-legacy CHỈ chạy khi: flag EAGER + PreTicket sinh trước deploy + backfill chưa chạy tới. Sau backfill: không còn PENDING → path chết → xóa code (PRD Story G).

---

## 6. WF4 — Backfill PreTicket PENDING cũ

### 6.1. Tree

```
B0. PRECONDITIONS: content đã deploy (C-1 sống) + ticket-mayo đã deploy + flag EAGER
    + đã verify count PreTicket PENDING (dry-run report trước)
B1. DRY-RUN: đếm PreTicket PENDING theo (ticketTypeId) + remaining từng loại
    → in kế hoạch: sẽ mint bao nhiêu, sẽ EXPIRED bao nhiêu → ADMIN XÁC NHẬN
B2. LOOP theo ticketTypeId (remaining riêng từng loại):
    B2.1. Lấy PreTicket PENDING của ticketTypeId, ORDER BY createdAt ASC
    B2.2. Batch ≤ 500: lock PENDING→MINTING, resolve recipientUserId (PortalUser có thể
          đã đăng ký từ khi phát), gọi C-1 mint
          ├─ ok → MINTED (như E1.8)
          ├─ SOLD_OUT (hết remaining của loại này) → GOTO B3 cho phần còn lại của loại
          └─ timeout/5xx → rollback PENDING, đánh dấu skip, tiếp tục batch sau (report cuối)
B3. HẾT QUOTA của một ticketTypeId:
    - Mọi PreTicket PENDING còn lại của loại đó → status EXPIRED
    - Audit per PreTicket: action=BACKFILL_QUOTA_EXCEEDED,
      detail={preTicketId, emailHash, ticketTypeId, jobId gốc, remainingAtFail}
    - KHÔNG gửi email thông báo gì cho người nhận (ops decision Q3 — admin liên hệ thủ công)
B4. REPORT: tổng minted / mintedWithUser / mintedEmailOnly / expired / skipped(technical fail)
    → in ra + ghi audit BACKFILL_SUMMARY → ADMIN review
```

### 6.2. Idempotency & chạy lại

- Chạy lại chỉ đụng PreTicket `PENDING` (MINTED/LINKED/CLAIMED/EXPIRED bị where loại) → không mint trùng. Idempotency 2 tầng: local status + content C-1 theo preTicketId.
- **EXPIRED là terminal**: chạy lại KHÔNG hồi sinh kể cả khi admin đã tăng `quantity`. Muốn phát cho những người đó → admin tạo đợt phát MỚI (job mới, email mới).QA: TC-W4-03.
- Technical-fail (timeout) items: stays PENDING → chạy lại tự nhặt.

### 6.3. Observable states (WF4)

| Trạng thái | Admin thấy | DB | Audit |
|---|---|---|---|
| Dry-run | bảng kế hoạch per ticketType | không đổi | — |
| Đang mint | tiến độ batch | PENDING→MINTING→MINTED | content log + sold tăng dần |
| Hết quota | cảnh báo trong report | PreTicket EXPIRED | BACKFILL_QUOTA_EXCEEDED per vé |
| Xong | report tổng kết | 0 PreTicket PENDING còn lại (nếu không technical-fail) | BACKFILL_SUMMARY |

Sau WF4 thành công: tắt path legacy lazy-mint trong runtime (WF3 C3-PENDING chết) — PRD Story G acceptance.

---

## 7. WF5 — Feature flag `DISTRIBUTION_MINT_MODE=LAZY|EAGER`

### 7.1. Ma trận hành vi theo flag

| Điểm code | LAZY (cũ) | EAGER (mới) |
|---|---|---|
| `distribute()` E1.5–E1.8 | bỏ qua (PreTicket PENDING thẳng tới email như hiện tại) | mint trước email |
| register/login/list sync | `resolvePendingPreTickets` (mint-on-login) | `syncTicketsByEmail` (link-only) |
| claim click (WF3) | mint-on-click như hiện tại | xem 5.1 |
| Backfill script | không chạy (guard flag) | chạy |

### 7.2. Chuyển flag 2 chiều an toàn

- **Điểm đọc flag**: đọc MỘT LẦN tại entrance của mỗi flow (distribute / sync / claim), không đọc lại giữa chừng — một request chạy trọn một mode.
- **LAZY → EAGER** (lên): an toàn mọi lúc. Dữ liệu PENDING cũ do LAZY tạo vẫn được claim path C3-PENDING legacy xử tới khi backfill. Trong giai đoạn chuyển tiếp, sync EAGER tại 3 điểm **phải chạy CẢ HAI**: `resolvePendingPreTickets` (dọn PENDING cũ theo cách cũ — mint kèm userId) VÀ `syncTicketsByEmail` (link MINTED). Bỏ cái đầu trước khi backfill xong = PreTicket PENDING cũ kẹt không ai mint. QA: TC-W5-02.
- **EAGER → LAZY** (rollback hành vi, PRD §11.3): an toàn mọi lúc. Vé MINTED/LINKED đã tồn tại vẫn hợp lệ (schema tương thích). PreTicket MINTED gặp claim path LAZY: LAZY code chỉ hiểu PENDING/CLAIMING/CLAIMED → **bắt buộc** LAZY path cũng xử MINTED/MINTING/LINKED như 5.1 (state machine là nguồn sự thật, flag chỉ chọn chiến lược mint) — nếu không, rollback flag sẽ làm claim-click 500 trên mọi vé EAGER. QA: TC-W5-03.
- **Không có migration nào chạy khi đổi flag** — flag thuần hành vi.

---

## 8. WF6 — Deploy & Rollback

### 8.1. Deploy tree (thứ tự BẮT BUỘC)

```
D1. PRE-FLIGHT
    D1.1. `prisma migrate status` CẢ 2 repo — migration nợ `20260826112000_content_pivot`
          (ticket-mayo) PHẢI chạy trước (R4). Có drift → DỪNG.
    D1.2. Verify env: INTERNAL_SERVICE_TOKEN khớp 2 service, FIELD_ENCRYPTION_PEPPER
          không đổi (đổi pepper = mọi emailHash mismatch = sync chết im lặng — F-07).
D2. DEPLOY CONTENT-SERVICE TRƯỚC
    D2.1. Migration: userId nullable + recipientEmailHash + index (viết kèm downgrade + rehearsal TRƯỚC — §8.2)
    D2.2. Code: mint API + link API + audit raw SQL §6.3 PRD (mỗi query sửa có test)
    D2.3. Deploy xong → ticket-mayo CŨ vẫn chạy (không gọi API mới) — không phá gì
    D2.4. SMOKE TEST MINT (bắt buộc trước D3): tạo event+ticketType test (quantity nhỏ),
          curl POST mint 2 vé (1 có userId, 1 không) → verify: 2 Ticket, sold +2,
          re-gọi cùng preTicketId → alreadyMinted=true, sold KHÔNG tăng; link-by-email → linked đúng
    D2.5. SMOKE TEST QUOTA: mint vượt remaining → 409 + remaining đúng; xóa dữ liệu test
D3. DEPLOY TICKET-MAYO SAU (flag mặc định LAZY)
    D3.1. Migration: enum MINTING/MINTED/LINKED + PARTIALLY_MINTED + recipientUserId + emailSentAt
    D3.2. Deploy code mới, flag LAZY → verify regression: phân phát cũ vẫn chạy
D4. BẬT EAGER (env per-environment) → smoke 1 đợt phát thật nhỏ (2-3 email nội bộ)
D5. BACKFILL (WF4) sau khi EAGER ổn định
D6. MONITORING bật (mục 11.2 PRD): mint success rate, reconciliation sold↔MINTED, sync 5xx
```

### 8.2. Rollback tree

```
RB1. HÀNH VI (nhanh nhất, luôn an toàn — xem 7.2): DISTRIBUTION_MINT_MODE=LAZY
RB2. CODE ticket-mayo: revert branch — content API mới vô hại (không ai gọi);
     PreTicket MINTED/LINKED từ EAGER-era: schema tương thích, vé vẫn hợp lệ, claim LAZY
     phải xử state như 7.2 (đã build trong D3)
RB3. MIGRATION CONTENT (Q10 — chỉ khi buộc): set userId NOT NULL lại.
    TRƯỚC KHI chạy downgrade phải phân loại vé userId IS NULL:
    ┌─ đã có userId (linked) ──────────────> giữ nguyên (phần lớn)
    ├─ userId NULL + status USED ──────────> KHÔNG được delete (đã check-in!)
    │                                          → gán placeholder "ROLLBACK-UNLINKED"
    ├─ userId NULL + status VALID ─────────> 2 option (Eng Lead chọn, mặc định a):
    │    a) gán placeholder "ROLLBACK-UNLINKED" (giữ vé, dọn sau — AN TOÀN)
    │    b) delete + sold giảm tương ứng (mất vé đã hứa — chỉ khi admin duyệt từng vé)
    └─ downgrade REHEARSAL trên DB test trước khi chạy (ASSURANCE gate)
RB4. ROLLBACK CRITERIA (theo PRD §11.3): mint fail > 5% job/24h; lệch reconciliation
    không giải thích được; sync 5xx > 1% register → RB1 + điều tra
```

Lưu ý RB3: option delete (b) vi phạm tinh thần "không thu hồi lời hứa" — mọi workflow khác trong doc này ưu tiên giữ vé; chỉ chạy khi admin chủ động duyệt.

---

## 9. Cleanup Inventory (WF1 tạo gì thì phải dọn gì)

| Resource | Tạo ở bước | Dọn bởi | Cách dọn |
|---|---|---|---|
| DistributionJob RUNNING | E1.5 | E1.10 / WF1-R1 | update status cuối; KHÔNG delete (audit trail) |
| PreTicket PENDING | E1.5 | E1.6→E1.8 (MINTED) hoặc rollback giữ PENDING để retry; backfill EXPIRED | không delete |
| Ticket content (mint thật) | E1.7 (content-side) | KHÔNG BAO GIỜ auto-delete | vé đã mint = đã hứa; chỉ RB3 xử lý |
| sold increment | E1.7 tx | rollback tx tự hoàn | tx atomic — không dọn tay |
| Email đã gửi | E1.9 | không thể thu hồi | lý do phải mint TRƯỚC email |

---

## 10. Test Case Matrix (tối thiểu cho QA — mỗi nhánh 1 test)

### WF1
| TC | Kịch bản | Kỳ vọng |
|---|---|---|
| TC-W1-01 | Happy path 3 email (2 có tài khoản, 1 chưa), quota đủ | 3 Ticket (2 có userId, 1 NULL), sold +3, 3 email, job COMPLETED, mintedEmailOnly=1 |
| TC-W1-02 | Quota thiếu toàn batch (remaining 10, phát 15) | 4xx message remaining=10 requested=15; 0 job/PreTicket/mint/email; sold không đổi |
| TC-W1-03 | Timeout mint, retry lần 2 ok | 1 vé mint đúng (không đôi) nhờ idempotent preTicketId |
| TC-W1-04 | Per-recipient fail (1 email data xấu) | job PARTIALLY_MINTED; email chỉ cho MINTED; PreTicket fail còn PENDING |
| TC-W1-05 | Crash (kill process) sau content commit, trước E1.8 | PreTicket MINTING stuck; re-submit cùng key → resume, alreadyMinted, KHÔNG mint đôi, email không gửi đôi (emailSentAt) |
| TC-W1-06 | 2 admin đồng thời 60+60, remaining 100 | 1 job đủ 100-type flow: 1 thành công, 1 SẠCH 409; tổng Ticket ≤ quantity |
| TC-W1-07 | Cùng idempotencyKey gọi lại sau COMPLETED | trả job cũ, sold không tăng, 0 email mới |
| TC-W1-08 | Mint xong, toàn bộ email fail SMTP | job COMPLETED, sent=0 failed=N, vé vẫn MINTED, audit EMAIL_ALL_FAILED |
| TC-W1-09 | 500 recipients × 1 ≤ 60s (chunk mint + email pipeline) | SLA đạt; không email nào đi trước chunk nó mint xong |

### WF2
| TC | Kịch bản | Kỳ vọng |
|---|---|---|
| TC-W2-01 | Register email có 3 vé email-only | Cùng request: 3 Ticket có userId; response claimedTickets=3; PreTicket LINKED |
| TC-W2-02 | List-my-tickets khi không còn gì sync | 0 HTTP call (short-circuit), +latency ≤ 200ms |
| TC-W2-03 | Content timeout lúc register | register 200, claimedTickets=0, PreTicket vẫn MINTED; request list KẾ tiếp sync thành công |
| TC-W2-04 | login + list đồng thời cùng user có 5 vé unlinked | tổng linked=5 (không double), không 500 |
| TC-W2-05 | Sync không đụng vé user khác / email khác | chỉ UPDATE đúng emailHash + userId IS NULL |
| TC-W2-06 | Login lại khi đã sync hết | linked=0, PreTicket đã LINKED không re-call (short-circuit) |

### WF3
| TC | Kịch bản | Kỳ vọng |
|---|---|---|
| TC-W3-01 | Click link, đã login email khớp, PreTicket MINTED | redirect "Vé của tôi", vé hiện, KHÔNG Ticket mới |
| TC-W3-02 | Click link chưa login | needsAuth → register → thấy vé (WF2) |
| TC-W3-03 | Token không tồn tại | 404 generic |
| TC-W3-04 | Đã login email KHÁC | needsAuth (không leak) |
| TC-W3-05 | PreTicket EXPIRED | thông báo hết hạn trung thực, không hứa vé |
| TC-W3-06 | PreTicket PENDING cũ (pre-backfill) | lazy-mint legacy → CLAIMED (transition) |
| TC-W3-07 | PreTicket MINTING (đang mint) | processing, thử lại sau |

### WF4
| TC | Kịch bản | Kỳ vọng |
|---|---|---|
| TC-W4-01 | Backfill 30 PENDING, quota đủ | 30 MINTED (kèm userId nếu user mới có tài khoản), sold +30, idempotent |
| TC-W4-02 | Backfill 30 PENDING, quota 10 | 10 MINTED (createdAt ASC đầu), 20 EXPIRED + audit BACKFILL_QUOTA_EXCEEDED, report đủ |
| TC-W4-03 | Chạy lại sau khi tăng quantity | EXPIRED KHÔNG hồi sinh; 0 mint mới từ EXPIRED |
| TC-W4-04 | Backfill crash giữa chừng, chạy lại | tiếp tục từ PENDING còn lại, 0 double |

### WF5/WF6
| TC | Kịch bản | Kỳ vọng |
|---|---|---|
| TC-W5-01 | Flag LAZY: phân phát + claim cũ | hành vi legacy nguyên vẹn |
| TC-W5-02 | EAGER + tồn tại PENDING cũ: login user có cả PENDING cũ lẫn MINTED mới | cả hai được xử (mint legacy + link mới) |
| TC-W5-03 | Đã EAGER tạo vé MINTED → flip LAZY → click claim | redirect xem vé (không 500) |
| TC-W6-01 | Deploy content trước, ticket-mayo cũ | mọi flow cũ sống |
| TC-W6-02 | Rollback flag giữa đợt phát đang chạy | request đang chạy trọn mode của nó; job kế theo mode mới |
| TC-W6-03 | Migration downgrade với vé unlinked (VALID + USED) | USED không bị delete; VALID theo option; script rehearsal pass |

---

## 11. Assumptions

| # | Assumption | Verify ở đâu | Risk nếu sai |
|---|---|---|---|
| A1 | `FIELD_ENCRYPTION_PEPPER` ticket-mayo ổn định — emailHash content khớp lifecycle | env prod + memory (đã từng nợ sync OTP) | Sync im lặng match 0 — cần metric linked-count để phát hiện |
| A2 | Content mint API chứa mapping preTicketId unique (cột hoặc bảng) — PRD R2 nói "unique composite" | phải build ở P1 | Mọi recovery WF1-R mất an toàn double-mint |
| A3 | PortalUser và PreTicket cùng DB ticket-mayo (đã verify code — E1.4 query local) | code | Nếu tách service sau này → E1.4 thành HTTP |
| A4 | SMTP dispatch tuần tự chấp nhận được với batch lớn (R10 chunk) | load test | Thời gian distribute kéo dài, không mất dữ liệu |
| A5 | Timing stuck MINTING = 10 phút đủ lớn hơn mint batch chunk (15s timeout × retry) | đo P3 | Resume nhầm job đang mint thật |
| A6 | Content `nextTicketCodes` sequence an toàn dưới concurrent tx (đã dùng cho register flow) | code + test concurrency | Trùng ticketCode → unique violation → mint fail (fail an toàn) |

---

## 12. Reality Checker Findings / PRD gaps phát hiện khi vẽ tree

| # | Finding | Severity | Chi tiết |
|---|---|---|---|
| F-01 | **Quota check hiện tại của content là check-then-act NGOÀI tx** (`issueTickets` check trước, `registerTicketsWithTx` tăng sold sau). Nếu mint API mới copy pattern này thì 2 job đồng thời VẪN over-mint (cả 2 pass check, cả 2 tăng sold). C-1 buộc check+increment cùng tx row-lock. | **Critical** | §C-1, WF1-R3; PRD R9 nói đúng ý nhưng code nền là vi dụ phản diện |
| F-02 | **Idempotency-hit với job RUNNING hiện tại là dead-end**: code trả về job cũ và bỏ qua. Job crash giữa chừng không thể hoàn tất bằng cùng key; dùng key khác = PreTicket mới = mint đôi thật (idempotency preTicketId khác domain). Cần WF1-R1 resume + kết hợp A2. | **Critical** | §3.3 E1.1, WF1-R1; PRD không specced resume |
| F-03 | **Không có trạng thái LINKED thì short-circuit WF2 không bao giờ true** — PRD chỉ nói "short-circuit check local" nhưng không chỉ ra local state nào báo "đã link xong" (link xảy ra content-side, ticket-mayo không biết nếu không tự ghi). → PT-4 + cột/không cần cột mới (dùng status). | High | §1.1 PT-4, WF2 S4; PRD §5.1 bước 2 thiếu cơ chế |
| F-04 | **"Retry bằng idempotencyKey" (PRD Story F) là no-op, không phải retry**: cùng key trả job cũ không làm gì; key mới phát lại TOÀN BỘ (email đôi cho người đã thành công). Retry thật = WF1-R2 per-PreTicket. | High | §3.4 WF1-R2; PRD chấp nhận-criteria mâu thuẫn nhau |
| F-05 | **Không có dấu "email đã gửi per-PreTicket"** → resume WF1-R1 sẽ gửi email đôi. Cần `emailSentAt` (hoặc tương đương). | High | §3.4 WF1-R1, cleanup §9; PRD không đề cập |
| F-06 | **Job COMPLETED với dispatched=0 (SMTP chết toàn bộ)**: PRD chỉ định nghĩa FAILED/PARTIALLY_MINTED theo mint. Chốt ở đây: mint thành công → COMPLETED + audit EMAIL_ALL_FAILED (vé đã tồn tại, không rollback được). | Medium | §3.3 E1.9 |
| F-07 | **Pepper drift = sync chết im lặng**: nếu `FIELD_ENCRYPTION_PEPPER` đổi giữa môi trường/backup-restore, mọi emailHash mismatch, link-by-email linked=0 mãi mà không lỗi. Cần monitoring linked-count + pre-flight D1.2. | Medium | §8.1 D1.2, A1 |
| F-08 | **Rollback flag EAGER→LAZY với vé MINTED**: claim path LAZY cũ chỉ hiểu PENDING/CLAIMING/CLAIMED — nếu không xử MINTED/MINTING/LINKED thì rollback flag gây 500 hàng loạt trên claim-click. Đã spec state-first (7.2); QA TC-W5-03 phải chặn. | High | §7.2 |
| F-09 | **Sync EAGER tại 3 điểm phải CHẠY THÊM resolvePendingPreTickets trong giai đoạn có PENDING cũ** (chưa backfill) — nếu thay hoàn toàn như PRD §6.2 gợi ý ("đổi target call sang sync") thì PreTicket PENDING cũ không bao giờ được mint cho user đã đăng ký trước backfill. | High | §7.2, TC-W5-02 |
| F-10 | **MINTING stuck do crash không được rollback tự động** — phân biệt với rollback khi caught-fail: rollback về PENDING chỉ an toàn NHỜ idempotency content (A2). Nếu A2 không build, PT-3 tự thành cơ chế double-mint. | High (liên kết A2) | §1.1, §3.3 E1.7 |
| F-11 | **Vé email-only USED khi rollback migration không được delete** — PRD Q10 option (b) ghi "chỉ khi vé chưa USED" nhưng không specced nhánh USED-unlinked. Đã thêm decision matrix RB3. | Medium | §8.2 RB3 |

---

## 13. Open Questions (đưa lại cho PM/Eng Lead — không chặn build theo khuyến nghị)

1. Admin có cần action UI "resume job" / "retry failed mint" tách biệt (WF1-R1/R2) hay chỉ dùng submit-lại-cùng-key? (Khuyến nghị: UI tách bạch, dùng key ngầm.)
2. Thông báo cho người nhận PreTicket EXPIRED (backfill): email thông báo phụ hay chỉ admin liên hệ tay? (PRD Q3 chốt admin-side; gửi email "tiếc quá" là scope sau.)
3. `emailSentAt` thêm cột hay dùng bảng email-log? (Backend Architect quyết — behavior cần là "biết email nào đã đi".)
4. Threshold stuck-MINTING 10 phút — đo lại sau load test chunk (A5).

## 14. Spec vs Reality Audit Log

| Date | Finding | Action |
|---|---|---|
| 2026-08-27 | Initial spec từ PRD v1.1 + code verify cả 2 repo (các file liệt kê mục 0) | — |
