# PRD: Eager Mint & Email-Sync — Vé tồn tại ngay khi phát, tự gắn theo email khi user có tài khoản

**Status**: Approved v1.1 — HUMAN GATE 1 ĐÃ QUA (2026-08-27). Q1 chốt: PortalUser ticket-mayo. Q3 chốt: EXPIRED + audit + báo admin. §7.1/§7.2/Q2/Q4 vẫn chờ reviewer bảo mật (model khác) trước merge.
**Author**: PM (Alex)
**Last Updated**: 2026-08-27
**Version**: 1.0
**Stakeholders**: Khách hàng (Mayo), Eng Lead content-service, Eng Lead ticket-mayo, Reviewer bảo mật (model khác — bắt buộc cho §8)
**Repo liên quan**: `c:\MAYogu_VIASG\ticket-mayo` (phát vé + portal), `c:\MAYogu_VIASG\content-service` (nguồn sự thật Event/TicketType/Ticket/check-in)
**Supersede một phần**: `docs/DESIGN-ticket-service.md` §5.2 (lazy claim), §6.6 (quota caveat) — phần mint-on-claim bị thay bởi eager mint; phần bridge identity giữ nguyên tinh thần.

---

## 1. Problem Statement

### 1.1. Yêu cầu khách hàng (VERBATIM)

> "nếu user đã có tài khoản trong app thì lưu cả userID cả email, nêu chưa có app thì sẽ lưu mỗi email thôi và khi user có vé nhưng chưa có tài khoản tạo đúng với email này thì ở các api lấy vé của tôi các thứ sẽ call thêm cả email nữa để đồng bộ"

### 1.2. Vấn đề cần giải

Hệ thống phát vé qua email hiện dùng cơ chế **lazy claim**: khi admin phát vé, hệ thống chỉ tạo `PreTicket` (trạng thái PENDING) trong DB ticket-mayo và gửi email claim-link. Vé thật (`Ticket`) chỉ được tạo trong content-service khi người nhận claim (đăng ký/đăng nhập). Điều này gây 4 vấn đề đã xác minh qua code:

1. **Data không đổi khi phát vé**: Sau khi admin phát N vé, bảng `Ticket` và `TicketType.sold` bên content-service KHÔNG thay đổi. Admin nhìn dashboard thấy "đã phát 500 vé" nhưng content-service báo "0 vé tồn tại". Khách hàng muốn vé tồn tại NGAY khi phát.
2. **Ràng buộc schema**: `Ticket.userId` non-nullable (`content-service/prisma/schema.prisma` dòng ~487, model Ticket dòng ~484) — không thể tạo vé khi người nhận chưa có tài khoản. Đây là lý do gốc của thiết kế lazy claim.
3. **Lỗ hổng quota (quota-gap)**: Quota chỉ check lúc claim (`internal-ticket-distribution.service.ts` `issueTickets`: `sold + quantity > quantity` → `TICKET_SOLD_OUT`). Nếu admin phát 1.200 email trong khi còn 1.000 vé, 200 người cuối nhận email "bạn có vé" nhưng bị lỗi hết vé khi claim. Đây là lời hứa sai trong email — lỗi nghiêm trọng về trải nghiệm và uy tín.
4. **Ràng buộc sync**: `PreTicket` chỉ lưu `recipientEmailHash` (HMAC-SHA256, không reverse) — plaintext email không được persist. Khi user tạo tài khoản sau, hệ thống cần cơ chế gắn (link) vé đã mint theo email vào userId.

### 1.3. Evidence (đã verify code 2026-08-27)

| # | Bằng chứng | File |
|---|-----------|------|
| 1 | `distribute()` chỉ tạo DistributionJob + PreTicket PENDING + gửi email, KHÔNG gọi content-service mint | `ticket-mayo/src/modules/distribution/distribution.service.ts` (bước 4-6) |
| 2 | Mint chỉ xảy ra lúc claim: lock PENDING→CLAIMING → `content.issueTickets` → finalize CLAIMED | `ticket-mayo/src/modules/ticket/ticket.service.ts` (`resolvePreTicket`) |
| 3 | `InternalIssueTicketsDto.userId` bắt buộc (`@IsNotEmpty()`) — không thể mint email-only | `content-service/src/infrastructure/driving-adapters/http-rest/dtos/request/internal-distribution.dto.ts` (dòng 29-35) |
| 4 | `Ticket.userId String` non-nullable, KHÔNG có cột email | `content-service/prisma/schema.prisma` (model Ticket, dòng ~484-514) |
| 5 | Quota check + tăng sold chỉ trong `issueTickets`/`registerTicketsWithTx` (lúc claim) | `content-service/src/core/services/internal-ticket-distribution.service.ts` (`issueTickets`), `content-service/src/infrastructure/driven-adapters/persistence/postgres/ticket.repository.adapter.ts` (`registerTicketsWithTx`) |
| 6 | Sync hiện tại chỉ là "resolve PreTicket PENDING → mint", không có khái niệm gắn vé email-only | `ticket-mayo/src/modules/ticket-portal/ticket-portal.service.ts` (`listMyTickets`), `ticket-mayo/src/modules/auth/auth.service.ts` (register/login) |
| 7 | PreTicket chỉ lưu `recipientEmailHash`, không có plaintext email; `contentTicketId @unique` đã có (tốt cho idempotency) | `ticket-mayo/prisma/schema.prisma` (model PreTicket) |
| 8 | Email gửi kèm mã hiển thị GIẢ (`claimToken.slice(-8)`), không phải ticketCode thật | `distribution.service.ts` (payload `ticketCode`) |
| 9 | Migration `20260826112000_content_pivot` của ticket-mayo CHƯA chạy trên DB (nợ kỹ thuật từ pivot) | `ticket-mayo/prisma/migrations/20260826112000_content_pivot/migration.sql` |

### 1.4. Vì sao bây giờ?

- Hệ thống vừa pivot (2026-08-26) sang kiến trúc content-service làm nguồn sự thật — chưa có dữ liệu production lớn theo cơ chế lazy (PreTicket PENDING cũ còn ít), đây là thời điểm đổi cơ chế mint với chi phí backfill thấp nhất.
- Lỗ hổng quota là rủi ro hoạt động hiện hữu: mỗi đợt phát gần hết quota đều có thể tạo email hứa hẹn sai. Khách hàng chủ động yêu cầu — có nội bộ lẫn khách hàng đều thấy vấn đề.

---

## 2. Goals & Success Metrics

| Goal | Metric | Baseline hiện tại | Target | Cửa sổ đo |
|------|--------|-------------------|--------|-----------|
| Vé tồn tại ngay khi phát | % PreTicket mới có `contentTicketId` ngay sau `distribute()` trả về | 0% (lazy) | 100% | Tại thời điểm deploy, đo trên mọi job mới |
| Sold đồng bộ khi phát | `TicketType.sold` (content) sau phát = sold trước + tổng vé phát | Không đổi khi phát (0%) | 100% job đạt | Mỗi job, verify qua admin dashboard |
| Khử quota-gap | Số user nhận email "có vé" nhưng bị TICKET_SOLD_OUT khi claim/xem vé | Rủi ro tồn tại (không đo được) | 0 trường hợp | 90 ngày sau GA |
| Sync vé khi tạo tài khoản | % vé email-only được gắn userId trong cùng request register/login/list-my-tickets | Không tồn tại flow này | ≥ 99% (phần còn lại sync ở request kế tiếp) | 30 ngày sau GA |
| Độ trễ register → thấy vé | Thời gian từ response register thành công đến vé xuất hiện trong list | N/A (flow mới) | ≤ 2 giây (sync inline, không cần reload lần 2) | 30 ngày sau GA |
| Giữ chuyển đổi claim-link (guardrail) | Tỷ lệ click claim-link → có tài khoản → thấy vé | Baseline cần đo trước launch (instrument trước 1 tuần) | Không giảm > 10% so với baseline | 60 ngày sau GA |
| Toàn vẹn dữ liệu | Số vé mint trùng (2 Ticket cho 1 PreTicket) / vé mồ côi (Ticket không PreTicket) | 0 | 0 | Vĩnh viễn (alert) |

---

## 3. Non-Goals

Rõ ràng nói KHÔNG làm trong iteration này:

1. **KHÔNG đổi behaviour check-in**: `checkInByCode` theo `ticketCode` giữ nguyên nguyên vẹn (online + offline check-in, Ed25519 QR, snapshot version). Vé mint eager có `ticketCode` chuẩn qua sequence — check-in không cần biết vé được mint khi nào.
2. **KHÔNG làm mobile app / scanner**: ngoài scope.
3. **KHÔNG đổi flow mua vé (Reservation/register) của content-service**: chỉ đụng internal distribution surface + schema Ticket.
4. **KHÔNG đưa plaintext email vào content-service** (khuyến nghị — xem §7.1): email chỉ đi qua ticket-mayo; content nhận emailHash.
5. **KHÔNG xử lý user đổi email** (PortalUser hiện không có flow đổi email).
6. **KHÔNG làm refund/cancel/hủy vé đã mint** (admin ops tooling — để iteration sau).
7. **KHÔNG phát hành vé trả phí**: eager mint chỉ áp dụng cho path phát vé miễn phí qua email (purchasePrice = 0 như hiện tại).
8. **KHÔNG tự động retry gửi email fail** (job hiện chỉ ghi `failed` count; vé vẫn an toàn vì đã mint — xem risk R7).

---

## 4. Personas & User Stories

**Persona 1 — Admin vé (Mayo operations)**: người vận hành ticket-mayo admin portal, phát vé theo đợt (paste list email), theo dõi tiến độ, chạy check-in tại sự kiện. Cần số liệu "đã phát" khớp "vé tồn tại" ngay lập tức.

**Persona 2 — Người nhận vé (end user)**: nhận email vé, có thể đã có tài khoản portal (email + password) hoặc chưa. Muốn thấy vé + QR trong portal "Vé của tôi" mà không cần thao tác thừa.

---

### Story A — Phát vé cho người nhận ĐÃ có tài khoản

**Story**: As a Admin vé, I want mỗi vé phát cho email đã có tài khoản được tạo ngay trong content-service kèm cả userId và emailHash, so that vé hiển thị ngay trong "Vé của tôi" của người nhận mà không cần chờ họ claim, và dashboard sold phản ánh đúng số vé đã phát.

**Acceptance Criteria**:
- [ ] Given admin phát vé cho email `x@y.com` mà `PortalUser` tồn tại với emailHash khớp, when `distribute()` hoàn tất, then content-service có ≥ 1 dòng `Ticket` với `userId = <portalUserId>`, `recipientEmailHash = hash(x@y.com)`, `status = 'VALID'`, `purchasePrice = 0`.
- [ ] Given đợt phát 50 email × 2 vé = 100 PreTicket cho người đều có tài khoản, when mint xong, then `TicketType.sold` tăng đúng +100 và số dòng Ticket mới = 100 (verify bằng `GET /internal/distribution/ticket-types/:id` trước/sau).
- [ ] Given PreTicket đã mint kèm userId, when user đó login và mở "Vé của tôi" (mà không hề click claim-link), then vé xuất hiện đầy đủ (ticketCode, tên loại vé, tên sự kiện, trạng thái VALID).
- [ ] Performance: `distribute()` với 500 recipients × 1 vé hoàn tất mint trong ≤ 60 giây (batch mint, không quá 15 giây/HTTP call tới content — timeout hiện có của `content-client.service.ts`).
- [ ] Idempotency: gọi lại `distribute()` với cùng `idempotencyKey` sau khi mint xong → trả về job cũ, KHÔNG mint thêm vé, `sold` không tăng lần 2.

### Story B — Phát vé cho người nhận CHƯA có tài khoản (email-only mint)

**Story**: As a Admin vé, I want vé được tạo ngay cả khi email chưa có tài khoản — Ticket lưu emailHash và userId để trống, so that vé tồn tại thật, quota được trừ ngay, và người nhận không bị phụ thuộc thời điểm tạo tài khoản.

**Acceptance Criteria**:
- [ ] Given admin phát vé cho email chưa có PortalUser, when `distribute()` hoàn tất, then content-service có dòng `Ticket` với `userId IS NULL`, `recipientEmailHash = hash(email)`, `status = 'VALID'`.
- [ ] Given vé email-only đã mint, then vé này ĐẾM vào `sold` và bị trừ quota như vé thường (behavior đồng nhất).
- [ ] Given vé email-only đã mint, when check-in theo `ticketCode` (admin manual path), then check-in hoạt động bình thường — không phụ thuộc userId. (Chỉ verify không regression; không đổi code check-in.)
- [ ] Given đợt phát hỗn hợp (30 email có tài khoản, 70 chưa), when mint xong, then 30 vé có userId + 70 vé userId NULL, đúng 100 vé, sold +100.
- [ ] Given mint xong cho email chưa có tài khoản, email gửi đi vẫn chứa claim-link hoạt động (xem Story E) và KHÔNG chứa ticketCode thật (chỉ mã hiển thị giả như hiện tại — xem quyết định D5).

### Story C — Người nhận tạo tài khoản sau đó → tự động sync vé

**Story**: As a Người nhận vé, I want khi tôi tạo tài khoản bằng đúng email đã nhận vé, mọi vé email-only gắn với email đó tự động thuộc về tôi, so that tôi thấy toàn bộ vé trong "Vé của tôi" ngay mà không cần nhập mã hay bấm link nào.

**Acceptance Criteria**:
- [ ] Given có 3 vé email-only với `recipientEmailHash = H`, when user register thành công với email có hash H (cùng `FIELD_ENCRYPTION_PEPPER`, normalize lowercase/trim), then TRONG CÙNG request register (trước khi trả response) content-service update 3 vé đó `userId = <portalUserId>`, và response register trả `claimedTickets: 3`.
- [ ] Given sync đã chạy, when user gọi "Vé của tôi", then đủ 3 vé xuất hiện.
- [ ] Given user register xong rồi login lại (không có vé email-only mới), when login, then sync chạy idempotent — `linkedCount = 0`, không lỗi, không trùng vé.
- [ ] Race: 2 request đồng thời (login + list-my-tickets) cùng trigger sync cho cùng emailHash → kết quả cuối: mỗi vé email-only chỉ có đúng 1 userId, không duplicate vé, không 500. (UpdateMany điều kiện `userId IS NULL` — idempotent.)
- [ ] Given sync fail (content-service timeout), when register vẫn trả thành công, then vé chưa gắn nhưng KHÔNG mất — request "Vé của tôi" KẾ TIẾP tự retry sync (điểm sync thứ 3) và vé hiện sau đó. Độ trễ chấp nhận: 1 request kế tiếp.
- [ ] Sync KHÔNG đụng vé đã có userId của user khác (điều kiện update bắt buộc `userId IS NULL`) và không đụng vé của email khác (điều kiện `recipientEmailHash = H` chính xác).

### Story D — API "Vé của tôi" đồng bộ theo cả email

**Story**: As a Người nhận vé, I want mọi API lấy vé của tôi (list, chi tiết) tự động đồng bộ vé email-only theo email của tôi trước khi trả kết quả, so that tôi không bao giờ rơi vào trạng thái "đã có tài khoản + đã có vé nhưng không thấy vé".

**Acceptance Criteria**:
- [ ] `GET /tickets/me` (ticket-portal) chạy sync theo emailHash TRƯỚC khi gọi `getUserTickets(userId)` — đúng yêu cầu khách hàng "các api lấy vé của tôi... call thêm cả email nữa để đồng bộ".
- [ ] Sync chạy tại 3 điểm: register, login, list-my-tickets (đều idempotent, chi phí 1 HTTP call khi không có gì để sync — có thể short-circuit bằng check local: chỉ gọi content khi còn PreTicket MINTED chưa link, xem §6).
- [ ] Performance: list-my-tickets với 0 vé cần sync tăng độ trễ ≤ 200ms so với hiện tại (short-circuit); với N vé cần sync ≤ 2s cho N ≤ 50.
- [ ] `GET /tickets/:id` ownership check theo userId hoạt động với vé vừa được sync (vé hiện hữu của user).

### Story E — Claim-link: giữ và đổi vai trò

**Story**: As a Người nhận vé chưa có tài khoản, I want email tôi nhận được vẫn có link dẫn tôi tới portal, so that tôi biết phải làm gì để XEM vé của mình (thay vì "nhận" vé — vé đã có sẵn).

**Câu hỏi sản phẩm phải chốt: khi vé mint sẵn, claim-link làm gì?** — Options và khuyến nghị:

| Option | Mô tả | Ưu | Nhược |
|--------|-------|----|----|
| **E1 — Giữ link, đổi semantics thành "xem vé / kích hoạt tài khoản" (RECOMMEND)** | Link vẫn unique per PreTicket. Click → nếu đã login với email khớp: sync (nếu cần) + redirect "Vé của tôi". Nếu chưa có tài khoản: prompt register; register xong (Story C) → thấy vé. KHÔNG còn path mint-on-click. | Không đổi template email/UX; giữ kênh conversion; đo được click→register; thay đổi code tối thiểu (ClaimService bỏ gọi mint, gọi sync) | Văn bản email nên đổi nhẹ ("Nhận vé" → "Xem vé / Tạo tài khoản để xem vé") — cần khách duyệt copy |
| E2 — Bỏ link, email thành thông báo thuần | Email chỉ nói "bạn được phát vé, đăng ký tại portal để xem" | Đơn giản nhất | Mất deep-link conversion; đổi template lớn; khó đo; trải nghiệm tệ hơn |
| E3 — Đưa ticketCode thật vào email (không cần tài khoản để có mã) | Mint sẵn có code thật, đưa thẳng vào email/QR | Người nhận không cần tài khoản | Email forward/rơi vào spam = lộ mã vào cửa; checkInByCode chỉ cần code — vi phạm nguyên tắc "email không phải vé"; độ trễ mint phải chặn gửi email | 

**Recommend E1** — Lý do: giữ nguyên hành vi người dùng đã quen, thay đổi kỹ thuật nhỏ nhất, không mở rủi ro bảo mật mới. E3 bị loại vì lý do bảo mật (mã vé trong email = vé trong email).

**Acceptance Criteria (theo E1)**:
- [ ] Given PreTicket đã MINTED, when click claim-link với user đã login và emailHash khớp, then redirect "Vé của tôi" và vé hiển thị (không mint lại, không tạo vé mới).
- [ ] Given click claim-link chưa login, then flow hiện tại giữ nguyên (prompt đăng nhập/đăng ký; sau register → Story C sync → thấy vé).
- [ ] Given PreTicket MINTED nhưng mint fail từng phần (xem R6), when click link, then hiển thị thông báo lỗi trung thực (không hứa vé không tồn tại) — hành vi cụ thể theo quyết định backfill (§7.4).
- [ ] Token không tồn tại → 404 generic (không leak email — giữ nguyên behavior hiện có của `claim.service.ts`).
- [ ] Guardrail: tỷ lệ click-link → register không giảm > 10% so với baseline (đo trước launch).

### Story F — Quota cập nhật NGAY khi phát (khử quota-gap)

**Story**: As a Admin vé, I want đợt phát bị chặn NGAY nếu vượt số vé còn lại — trước khi email nào được gửi, so that không bao giờ có user nhận email "bạn có vé" rồi bị lỗi hết vé.

**Acceptance Criteria**:
- [ ] Given TicketType remaining = 10, when admin phát 15 vé (15 PreTicket), then `distribute()` trả lỗi 4xx rõ ràng (thông điệp chứa remaining=10, requested=15), KHÔNG tạo PreTicket, KHÔNG mint, KHÔNG gửi email, `sold` không đổi.
- [ ] Given remaining = 15, phát 15 → thành công toàn bộ, `sold` đạt `quantity` (đầy quota), các đợt phát sau bị chặn đúng.
- [ ] Mint là BẮT BUỘC trước gửi email: nếu mint fail (content lỗi/quota đổi giữa chừng do service khác), then 0 email được gửi, job `FAILED` với reason, admin retry an toàn bằng idempotencyKey.
- [ ] Given 2 admin phát đồng thời 2 đợt (60 + 60) với remaining = 100, then tổng vé mint ≤ 100, đợt nào trúng sau bị chặn với thông báo remaining chính xác (quota check trong cùng transaction/row-lock với `sold` increment — không over-mint).
- [ ] Contract test: mock content-service trả TICKET_SOLD_OUT → ticket-mayo dịch thành thông báo admin rõ ràng (không 500).

### Story G — Back-compat: các PreTicket PENDING phát theo cơ chế cũ

**Story**: As a Admin vé, I want các PreTicket PENDING tạo trước lần deploy này cũng được mint theo cơ chế mới (backfill), so that toàn hệ thống về một cơ chế duy nhất và quota-gap không còn tồn tại ở dữ liệu cũ.

**Acceptance Criteria**:
- [ ] Script backfill: với mỗi PreTicket PENDING cũ → mint email-only (hoặc kèm userId nếu email đã có PortalUser) → set `contentTicketId` + status MINTED. Chạy được idempotent (chạy 2 lần không mint trùng).
- [ ] Given backfill gặp quota không đủ cho toàn bộ PreTicket PENDING cũ, then hành động theo quyết định §7.4 (khuyến nghị: mint đến khi hết quota, phần còn lại đánh dấu EXPIRED + audit + báo cáo admin — KHÔNG âm thầm bỏ qua).
- [ ] Sau backfill xong, không còn code path "lazy mint on claim" chạy trong runtime (chỉ giữ trong script để chạy lại nếu cần) — giảm 2 code path song song.

### Story H — Admin thấy được vé email-only đang chờ

**Story**: As a Admin vé, I want dashboard đợt phát hiển thị rõ: số vé đã mint, số vé mint kèm userId, số vé email-only chưa có người dùng, so that tôi hiểu trạng thái thực của đợt phát và nhắc nhở người nhận chưa tạo tài khoản nếu cần.

**Acceptance Criteria**:
- [ ] Job status (đã có `getStatus`) bổ sung: `minted`, `mintedWithUser`, `mintedEmailOnly`, `mintFailed` — tính từ PreTicket (không cần API mới content).
- [ ] Vé mint fail (nếu có) hiện trong `includeFailed` với lý do.
- [ ] KHÔNG hiển thị plaintext email (ticket-mayo không lưu) — chỉ mã hash rút gọn nếu cần đối chiếu. (Xem open question Q6 nếu khách muốn xem email.)

---

## 5. Solution Overview

### 5.1. Kiến trúc đích (2 thay đổi trục)

**Thay đổi 1 — Eager mint tại thời điểm phát (ticket-mayo → content-service):**

```
distribute() mới:
  1. Validate + dedupe recipients (như hiện tại)
  2. Resolve userId cho từng email: query PortalUser (cùng DB) theo emailHash
  3. Gọi content-service MỚI: POST /internal/distribution/mint
     body: { eventId, ticketTypeId, recipients: [{ preTicketId, emailHash, userId? }], idempotencyKey: jobId }
     → content check quota TOÀN BATCH trong 1 tx (sold + total ≤ quantity), mint tất cả,
       trả [{ preTicketId, ticketId, ticketCode }]
  4. Update PreTicket: contentTicketId, contentTicketCode, status MINTED (lock MINTING chống race,
     tái dùng pattern CLAIMING hiện có)
  5. CHỈ SAU KHI MINT THÀNH CÔNG: gửi email (như hiện tại + có thể kèm ticketCode hiển thị thật — quyết định D5)
  6. Job status COMPLETED kèm số liệu mint
```

Kết quả: vé tồn tại ngay (userId hoặc emailHash), `sold` tăng ngay, quota chặn trước khi gửi email — fix đồng thời 3 vấn đề (1), (3), và precondition của (2).

**Thay đổi 2 — Email-sync khi user có tài khoản (link-by-email):**

```
Điểm trigger (đều idempotent): register / login / list-my-tickets (ticket-mayo)
  1. Hash email user (HMAC-SHA256, FIELD_ENCRYPTION_PEPPER — đã có generateEmailHash)
  2. Short-circuit: nếu không còn PreTicket MINTED chưa link cho emailHash này → bỏ qua (0 HTTP call)
  3. Gọi content-service MỚI: POST /internal/distribution/link-by-email
     body: { emailHash, userId }
     → content: UPDATE Ticket SET userId WHERE recipientEmailHash = ? AND userId IS NULL
     → trả { linked: N }
  4. Audit + trả số vé gắn cho response (claimedTickets giữ field hiện có)
```

Vé email-only sau khi link có userId → mọi API hiện có theo userId (`listUserTickets`, `getTicket`) hoạt động không đổi.

### 5.2. Key Design Decisions

- **D1 — Mint qua API batch mới (không reuse `issueTickets` từng vé)**: API mint nhận cả list recipient, check quota toàn batch 1 lần, mint trong tx (hoặc chunk tx có quota check lũy kế). Tránh N HTTP call + chặn quota-gap dạng "check từng phần". Trade-off: API mới cần contract test + versioning; `issueTickets` cũ giữ cho back-compat trong giai đoạn chuyển đổi.
- **D2 — `Ticket.userId` thành nullable (không dùng placeholder string)**: xem §7.2 — placeholder ("UNCLAIMED", "email:...") gây dữ liệu bẩn, phá thống kê `GROUP BY userId`, nguy cơ collision với portalUserId thật. Nullable là mô hình đúng cho "chưa có chủ". Trade-off: phải audit mọi query/raw SQL đang giả định userId luôn có (liệt kê trong §6).
- **D3 — content-service lưu `recipientEmailHash` (không plaintext email)**: xem §7.1 — content không cần email plaintext để mint/sync; hash đủ match, không tăng mặt lộ PII cho service đã có 4 audit blocker. Trade-off: content không hiển thị được email trong admin/audit phía mình — ticket-mayo là nơi duy nhất biết mapping (qua PreTicket).
- **D4 — Sync chủ động pull tại 3 điểm trigger (không event-driven)**: đúng yêu cầu khách hàng ("api lấy vé... call thêm email"), đơn giản, idempotent, không thêm Kafka consumer/retry/DLQ. Trade-off: nếu user không bao giờ gọi 3 API này thì vé không tự gắn — chấp nhận được vì user phải dùng API này mới cần thấy vé. (Pre-warm event-driven để sau nếu có nhu cầu.)
- **D5 — KHÔNG đưa ticketCode thật vào email**: mint sớm cho phép đưa mã thật, nhưng email ≠ vé (forward/spam = lộ mã vào cửa). Giữ nguyên mã hiển thị giả từ claimToken. Trade-off: người nhận không xem được mã vé cho tới khi có tài khoản — đúng thiết kế "xem vé trong portal".
- **D6 — Feature flag `DISTRIBUTION_MINT_MODE=LAZY|EAGER`** (env): rollback hành vi nhanh không deploy lại. LAZY path chỉ giữ trong 1-2 release rồi xóa sau khi EAGER ổn định.
- **D7 — PreTicket thêm trạng thái `MINTING` + `MINTED`**: tái dùng đúng pattern CLAIMING (lock atomic + rollback PENDING khi fail) đã được chứng minh trong `resolvePreTicket`. `CLAIMED` giữ cho dữ liệu lịch sử + backfill path.

### 5.3. Thứ tự deploy (bắt buộc)

1. **content-service TRƯỚC**: migration schema (nullable userId + cột mới) + API mint/link — deploy lên, ticket-mayo cũ vẫn chạy (không đụng API mới).
2. **ticket-mayo SAU**: dùng API mới. LƯU Ý: migration `20260826112000_content_pivot` đang nợ chưa chạy trên DB — phải chạy trước deploy code mới này (code hiện tại trên main đã theo schema content_pivot).
3. Backfill chạy sau khi cả 2 deploy xong + flag EAGER bật.

---

## 6. Phân tích ĐÃ CÓ vs CẦN THÊM (theo module)

### 6.1. content-service

| Module / File | ĐÃ CÓ (tái dùng) | CẦN THÊM |
|---|---|---|
| `src/core/services/internal-ticket-distribution.service.ts` | `issueTickets` (quota check `sold + quantity > quantity` → TICKET_SOLD_OUT), `listUserTickets`, `getTicket` (ownership theo userId) | Method `mintForDistribution(dto)` — nhận batch recipients (emailHash + userId tùy chọn), quota check TOÀN BATCH, gọi repo mint; method `linkTicketsByEmail(emailHash, userId)` — updateMany `WHERE recipientEmailHash = ? AND userId IS NULL` |
| `src/infrastructure/driven-adapters/persistence/postgres/ticket.repository.adapter.ts` | `registerTicketsWithTx` (tx: tăng sold + sinh ticketCode sequence + createMany — tái dùng gần nguyên vẹn) | Tham số `userId?` nullable + `recipientEmailHash`; method `linkByEmailHash` (updateMany điều kiện NULL-safe); **AUDIT các raw SQL** (xem §6.3) |
| `src/infrastructure/driving-adapters/http-rest/dtos/request/internal-distribution.dto.ts` | `InternalIssueTicketsDto` (pattern validation) | `InternalMintTicketsDto` (recipients[] với userId optional, emailHash bắt buộc, preTicketId để idempotent mapping), `InternalLinkByEmailDto` |
| `src/infrastructure/driving-adapters/http-rest/controllers/internal-distribution.controller.ts` | Toàn bộ route nội bộ đã có `@UseGuards(ServiceTokenGuard)` | `POST /internal/distribution/mint`, `POST /internal/distribution/link-by-email` (cùng guard) |
| `src/interceptors/service-token.guard.ts` | So khớp `x-service-token` với `INTERNAL_SERVICE_TOKEN` | KHÔNG đổi — tái dùng cho 2 API mới |
| `prisma/schema.prisma` (model Ticket dòng ~484) | `ticketCode @unique`, status VALID/USED/CANCELLED, totpSecret, checkedIn* | `userId String?` (nullable — quyết định §7.2), `recipientEmailHash String?`, `@@index([recipientEmailHash])` (partial `WHERE userId IS NULL` nếu PostgreSQL hỗ trợ qua Prisma raw migration); migration + ROLLBACK (§11) |
| `prisma/schema.prisma` (TicketType) | `quantity`, `sold @default(0)` — dùng cho quota batch | KHÔNG đổi schema; quota check batch dùng sold trong cùng tx |

### 6.2. ticket-mayo

| Module / File | ĐÃ CÓ (tái dùng) | CẦN THÊM |
|---|---|---|
| `src/modules/distribution/distribution.service.ts` | `distribute()`: idempotencyKey, dedupe theo emailHash, PreTicket seeds, dispatchBatch email, audit DISTRIBUTION_START | Bước resolve userId (query `portalUser` theo emailHash — cùng DB, không cần HTTP); gọi `content.mintForDistribution` sau khi tạo PreTicket, TRƯỚC khi gửi email; update PreTicket (contentTicketId/Code, status MINTING→MINTED); job status mở rộng (minted/failed counts); thất bại mint → job FAILED, không gửi email |
| `src/modules/ticket/ticket.service.ts` | `resolvePreTicket` (pattern atomic lock PENDING→CLAIMING + rollback — TÁI DÙNG cho MINTING/MINTED), `resolvePendingPreTickets` | Method `syncTicketsByEmail(userId, emailHash)` — short-circuit nếu không còn PreTicket MINTED chưa link, gọi `content.linkByEmail`; giữ `resolvePendingPreTickets` cho path lazy (flag LAZY) + backfill |
| `src/modules/ticket-portal/ticket-portal.service.ts` | `listMyTickets` — resolve pending rồi getUserTickets | Đổi `resolvePendingPreTickets` → `syncTicketsByEmail` (khi flag EAGER); response giữ shape `{ tickets, claimedTickets }` (claimedTickets = linked count) |
| `src/modules/auth/auth.service.ts` | Register/login đã gọi `resolvePendingPreTickets(user.id, user.emailHash)` — đúng điểm trigger | Đổi target call sang sync (khi EAGER); giữ `claimedTickets` trong AuthResponse |
| `src/modules/claim/claim.service.ts` | Token lookup, emailHash match check, 404 không leak email, `needsAuth` flow | Bỏ path mint-on-click khi EAGER: PreTicket MINTED → sync + redirect; PreTicket PENDING (dữ liệu cũ chưa backfill) → vẫn lazy-mint (transition) hoặc báo "đang xử lý" tùy quyết định §7.4 |
| `src/modules/content-client/content-client.service.ts` | `request()` với x-service-token, timeout 15s, unwrap `{success,data}`; `issueTickets`, `getUserTickets` | `mintForDistribution(body)`, `linkByEmail(emailHash, userId)` |
| `src/modules/user-community-client/user-community-client.service.ts` | `lookupDisplayNames` (chỉ để lấy tên hiển thị trong email) | KHÔNG đổi — KHÔNG dùng user-community id làm Ticket.userId (xem open question Q1) |
| `prisma/schema.prisma` (PreTicket) | `contentTicketId @unique` (chống double-link), status enum, `recipientEmailHash`, claimToken unique | Enum thêm `MINTING`, `MINTED`; cột `recipientUserId String?` (userId đã resolve lúc phát — để admin dashboard + tránh query lại); migration + rollback |
| Frontend admin (distribution job status) | Job list + status view có sẵn | Hiển thị minted/mintedEmailOnly/mintFailed; copy thông báo lỗi quota rõ ràng |
| Frontend user portal | "Vé của tôi" | KHÔNG đổi UI — chỉ dữ liệu đầy đủ hơn |

### 6.3. AUDIT raw SQL content-service bắt buộc trước khi nullable userId (rủi ro cao nhất — liên quan D2)

Các query đang giả định `Ticket.userId` luôn có giá trị (đã đọc và xếp loại):

| Query | File | Rủi ro khi NULL | Xử lý |
|---|---|---|---|
| `findUserIdsByEventId` (UNION Ticket + Reservation, `SELECT DISTINCT userId`) | ticket.repository.adapter.ts | Trả dòng `userId = NULL` → downstream fan-out notification cho user NULL | Thêm `WHERE userId IS NOT NULL` |
| `countAllUserTicketCounters` (GROUP BY userId) | ticket.repository.adapter.ts | Nhóm NULL vào 1 bucket "user NULL" | Filter NULL hoặc COALESCE tùy semantic |
| `getTicketOwnerIds` | ticket.repository.adapter.ts | ĐÃ có `IS NOT NULL` — an toàn | Không đổi (verify bằng test) |
| `findParticipatedEventIdsByUserAndCommunities`, `getTicketCountByEventIds` (ARRAY_AGG userId) | ticket.repository.adapter.ts | NULL lọt vào mảng userIds của event | Filter ở aggregate |
| Các service dùng `ticket.userId` ngoài repo (matching, event, notification...) | cần grep toàn repo | NPE / logic sai | Bắt buộc grep + test trong Gate kỹ thuật |

---

## 7. Quyết định sản phẩm cần MỞ (chờ human gate duyệt)

Mỗi mục: options, khuyến nghị PM, và cái gì mất nếu chọn hướng khác.

### 7.1. [PII — CẦN MODEL KHÁC DUYỆT] Email trong content-service Ticket: plaintext / hash / encrypt?

| Option | Ưu | Nhược |
|---|---|---|
| A — `recipientEmailHash` HMAC-SHA256 (RECOMMEND) | Không lộ PII mới ở content-service (service đã có 4 audit blocker); đủ cho sync (match 1 chiều); không cần share pepper cho content (ticket-mayo hash trước khi gửi) | Content không hiển thị/tra cứu email theo plaintext; mọi nhu cầu hiển thị email phải qua ticket-mayo |
| B — plaintext `recipientEmail` | Đọc trực tiếp khi debug/admin; đúng nghĩa đen "lưu email" của khách | content DB leak → lộ toàn bộ danh sách phân phối email; tăng mặt tấn công PII cho service lớn nhất hệ |
| C — AES-GCM encrypt (pattern user-community) | Cả lưu trữ an toàn lẫn đọc được | Content chưa có helper crypto này; quản lý key mới; phức tạp hóa sync (decrypt để match) — không cần thiết cho use case |

**Khuyến nghị: A.** Nhu cầu thật đằng sau "lưu email" là *nhận diện người nhận để gắn userId sau này* — hash đáp ứng đầy đủ, an toàn hơn. Nếu khách hàng cần XEM email ở đâu đó, đó là nhu cầu của admin ticket-mayo (xem Q6 — hiện ticket-mayo cũng không persist plaintext).

### 7.2. `Ticket.userId`: nullable vs placeholder string

| Option | Ưu | Nhược |
|---|---|---|
| A — `userId String?` nullable (RECOMMEND) | Mô hình dữ liệu đúng ("chưa có chủ" = NULL); query thống kê dùng `IS NOT NULL` rõ ràng; không collision | Phải audit + sửa mọi chỗ giả định non-null (§6.3) — effort + rủi ro regression |
| B — placeholder `"UNCLAIMED"` / `"email:<hash>"` | Không đổi ràng buộc NOT NULL; migration nhẹ | Dữ liệu bẩn vĩnh viễn; mọi GROUP BY/DISTINCT userId bị ô nhiễm; nguy cơ trùng portalUserId thật (portalUserId là opaque string); khó dọn về sau |

**Khuyến nghị: A** — nợ kỹ thuật của B lớn hơn nhiều chi phí audit một lần. B chỉ chấp nhận nếu audit phát hiện quá nhiều chỗ phụ thuộc (khi đó nên cân nhắc lại scope cả initiative).

### 7.3. Hành vi claim-link cũ — đã trình bày Story E. Khuyến nghị E1.

### 7.4. Back-compat các PreTicket PENDING cũ (phát theo lazy, chưa ai claim)

| Option | Mô tả | Ưu | Nhược |
|---|---|---|---|
| A — Backfill toàn bộ (RECOMMEND) | Script mint mọi PreTicket PENDING cũ theo cơ chế mới (kèm userId nếu email đã có PortalUser) | Về 1 cơ chế duy nhất; xóa lazy path khỏi runtime; quota trở nên chính xác tuyệt đối | Nếu tổng PreTicket PENDING cũ > remaining → phải xử lý tranh chấp quota (xem dưới) |
| B — Giữ lazy song song | PreTicket cũ vẫn mint-on-claim | Không cần script | 2 code path song song vĩnh viễn; quota-gap vẫn sống ở dữ liệu cũ; complexity test nhân đôi |
| C — Hủy PreTicket PENDING cũ (EXPIRED) + phát lại | Đánh dấu hết hạn, admin phát lại | Sạch sẽ | User đã nhận email "có vé" bị mất vé — TỪ CHỐI: tái tạo lời hứa sai mà ta đang cố fix |

**Khuyến nghị: A.** Với trường hợp backfill thiếu quota (không đủ vé cho mọi PreTicket PENDING cũ): khuyến nghị mint theo thứ tự createdAt đến khi cạn remaining, phần còn lại → status `EXPIRED` + audit `BACKFILL_QUOTA_EXCEEDED` + báo cáo admin để liên hệ người nhận. Đây là quyết định vận hành cảm nhận được — **cần khách hàng duyệt trước khi triển khai** (open question Q3).

### 7.5. Hiển thị vé email-only ở đâu (admin visibility)

- Vé email-only KHÔNG hiển thị ở bất kỳ user portal nào (không có chủ).
- Admin ticket-mayo: qua job status (Story H) — đếm từ PreTicket + `recipientUserId`.
- Admin content-service: KHÔNG hiển thị (không có email plaintext; userId NULL khó diễn giải ngoài context). Nếu cần dashboard vé chưa gắn: thêm sau qua API nội bộ `GET /internal/distribution/tickets/unlinked` — defer, không cần cho GA.
- KHÔNG có API public nào cho phép "claim bằng email chưa verified" — vé chỉ gắn khi email là tài khoản portal đã đăng ký (có password).

### 7.6. Ai là "user có tài khoản trong app"? (PHÂN BIỆT IDENTITY — quan trọng)

Yêu cầu khách nói "tài khoản trong app". Hệ thống có 2 loại tài khoản:
- **PortalUser (ticket-mayo)** — auth email+password của portal vé. `Ticket.userId` hiện đang là portalUserId (`InternalIssueTicketsDto` comment ghi rõ "portalUserId của ticket-mayo").
- **User (user-community-service)** — tài khoản app MAYogu (chat). `lookupDisplayNames` chỉ lấy displayName.

**Khuyến nghị: scope MVP bind theo PortalUser** — nhất quán với toàn bộ code hiện tại (auth, list-my-tickets, ownership check đều portalUserId). Nếu khách hàng có ý "tài khoản MAYogu app" (user-community), đó là bài toán identity-mapping khác (portal account ↔ community account) — cần phase riêng. **Phải confirm với khách hàng trước khi build** (open question Q1).

---

## 8. Bảo mật & PII — [HUMAN GATE: TOÀN MỤC NÀY CẦN MODEL KHÁC DUYỆT THREAT-MODEL]

Theo qui trình autobuild + ASSURANCE: mọi thay động auth/PII phải có threat-model được review bởi model khác trước khi merge. Các điểm cần duyệt:

1. **Auth service-to-service (tái dùng, không đổi cơ chế)**: 2 API mới (`mint`, `link-by-email`) nằm dưới `ServiceTokenGuard` (`x-service-token` so khớp `INTERNAL_SERVICE_TOKEN`) — cùng surface với các API nội bộ hiện có. KHÔNG tin `x-user-id` từ client (content-service có audit blocker JWT/x-user-id auth bypass đang mở — mint/link là internal-only nên không nhận user identity từ client, chỉ nhận từ ticket-mayo đã xác thực).
2. **Threat mới cần model**: API `mint` cho phép ticket-mayo tạo vé hàng loạt không qua user. Câu hỏi: (a) ai kiểm soát INTERNAL_SERVICE_TOKEN (biết token = mint vé vượt quota? — không, quota vẫn check; nhưng có thể mint email tùy ý); (b) có cần rate-limit/throttle API mint nội bộ không; (c) log audit content-side cho mint (ai mint, bao nhiêu, job nào).
3. **Threat mới cần model**: API `link-by-email` cho phép gắn vé email-only vào userId. Yêu cầu: caller chỉ được là ticket-mayo (service-token); ticket-mayo CHỈ gọi với cặp (emailHash, userId) mà nó đã xác thực qua JWT portal (user đăng nhập bằng đúng email). Rủi ro nếu ticket-mayo bị compromise: gắn vé của email nạn nhân vào tài khoản kẻ tấn công → cần đánh giá + có thể thêm giới hạn (vé chỉ gắn được vào user có emailHash khớp chính xác — đã là điều kiện WHERE; còn gì nữa?).
4. **PII — emailHash xuống content DB** (quyết định §7.1): emailHash là HMAC-SHA256 với `FIELD_ENCRYPTION_PEPPER` — không reverse nếu không biết pepper; pepper KHÔNG rời ticket-mayo/user-community. Content lưu hash thuần. Cần duyệt: hash có được coi là PII giả danh (pseudonymised) theo yêu cầu compliance nội bộ không; retention.
5. **KHÔNG đưa plaintext email qua API mint/link**: contract là emailHash-only. Bắt buộc trong design review.
6. **PII trong log/audit**: audit content-side và ticket-mayo DistributionAudit chỉ ghi emailHash (ticket-mayo đã theo pattern này). Cấm log plaintext email trong request/response log của 2 API mới.
7. **Quota as security control**: mint nâng `sold` — cần đảm bảo tx mint + sold increment là atomic (tránh sold lệch → hết vé thật hoặc phát vượt). Contract test + mutation test cho path này.
8. **Secret-scan**: không thêm secret mới; INTERNAL_SERVICE_TOKEN + FIELD_ENCRYPTION_PEPPER đã có trong env — gitleaks/SAST phải clean (ASSURANCE gate).

---

## 9. Risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|-----------|--------|------------|
| R1 | Nullable `userId` phá raw SQL / service khác của content-service (matching, notification fan-out, stats) — đã liệt kê §6.3 nhưng có thể sót | Medium | High | Grep toàn repo `userId` trên model Ticket + test tích hợp; danh sách §6.3 là checklist review bắt buộc; hard gate: không merge nếu chưa có test cho từng query đã sửa |
| R2 | Race double-mint: `distribute()` crash giữa "content mint xong" và "update PreTicket" → retry tạo vé đôi | Low | High | Pattern lock MINTING (như CLAIMING hiện có); API mint nhận `preTicketId` mapping + `jobId` làm idempotency key content-side (unique composite preTicketId) — insert conflict → trả ticket đã có |
| R3 | Backfill thiếu quota cho PreTicket PENDING cũ → user nhận email cũ nhưng không có vé | Medium | Medium | Quyết định §7.4 (mint theo thứ tự + EXPIRED + báo cáo admin); số PENDING cũ hiện thấp (hệ thống mới pivot) — verify count trước khi chạy |
| R4 | Migration `content_pivot` ticket-mayo chưa chạy trên DB → deploy code mới fail/deviation | High (nợ đang có) | Medium | Chạy migration này TRƯỚC trong phase deploy; kiểm tra `prisma migrate status` cả 2 repo trước deploy — thêm vào launch checklist |
| R5 | Deploy lệch pha: ticket-mayo mới gọi API mint mà content chưa có → mọi đợt phát fail | Medium | High | Thứ tự deploy §5.3 bắt buộc + feature flag LAZY fallback + smoke test mint sau deploy content, trước deploy ticket-mayo |
| R6 | Mint fail giữa batch (chunk tx) → một phần vé mint, một phần không — email chưa gửi nhưng job cần rõ trạng thái | Medium | Medium | API mint trả kết quả per-recipient (success + reason fail); PreTicket ghi trạng thái từng vé; job `PARTIALLY_MINTED` → admin thấy và quyết định retry phần fail |
| R7 | Mint xong nhưng gửi email fail → vé tồn tại, user không biết | Medium | Low | Vé an toàn (không mất — tốt hơn chiều ngược); job ghi `failed` count; admin xem failed list; retry email là scope sau (non-goal #8) |
| R8 | Khách hàng hiểu "tài khoản app" = user-community (không phải PortalUser) → build sai hướng | Medium | High | Open question Q1 — CONFIRM TRƯỚC KHI BUILD |
| R9 | 2 admin phát đồng thời vượt quota (check-then-mint race giữa 2 request) | Low | Medium | Quota check + sold increment trong CÙNG transaction (row lock TicketType) — đã là pattern của `registerTicketsWithTx`, giữ nguyên cho batch |
| R10 | Hiệu năng distribute với list lớn (15k email): mint batch dài | Medium | Medium | Chunk 500-1000 vé/tx + quota check lũy kế; mint song song với pipeline email theo chunk (chunk i mint xong → gửi email chunk i) — KHÔNG gửi email trước khi chunk đó mint xong |

---

## 10. Open Questions (chờ người duyệt)

| # | Câu hỏi | Owner | Cần chốt trước | Ảnh hưởng |
|---|---------|-------|----------------|-----------|
| Q1 | "Tài khoản trong app" = PortalUser (ticket-mayo) hay User (user-community/MAYogu app)? Khuyến nghị: PortalUser cho MVP. Nếu khách muốn cả user-community → cần identity-mapping phase riêng, PRD phải mở lại | Khách hàng + PM | Trước khi bắt tay design kỹ thuật | Toàn bộ identity của Ticket.userId, sync flow |
| Q2 | [PII] Duyệt §7.1: emailHash-only trong content-service Ticket (khuyến nghị A — hash) | Security reviewer (model khác) | Trước design kỹ thuật content-service | Schema + sync contract |
| Q3 | Backfill thiếu quota: hành động với PreTicket PENDING cũ không mint được (khuyến nghị: EXPIRED + audit + admin report) | Khách hàng + PM | Trước khi viết script backfill | Story G, vận hành |
| Q4 | [SECURITY] Threat-model cho 2 API nội bộ mới (mint, link-by-email) — mục §8.2, §8.3 | Security reviewer (model khác) | Trước merge content-service | API contract |
| Q5 | Copy email có cần đổi khi semantics claim-link đổi ("Nhận vé" → "Tạo tài khoản để xem vé")? | Khách hàng | Trước deploy ticket-mayo | Template email |
| Q6 | Admin có cần xem plaintext email của người nhận sau khi phát? (Hiện KHÔNG lưu ở đâu — cả ticket-mayo chỉ có emailHash. Nếu có: thêm cột encrypted/plaintext ở PreTicket = thay đổi PII cần duyệt riêng) | Khách hàng + PM | Không chặn GA | Scope nhỏ tách riêng |
| Q7 | Cho phép đưa ticketCode THẬT vào email sau này (hiện khuyến nghị KHÔNG — D5)? | Khách hàng + Security | Defer | Template email tương lai |
| Q8 | Vé email-only có "hết hạn chờ kích hoạt" không (auto-CANCELLED sau X ngày không có tài khoản)? Hiện đề xuất: KHÔNG (vé tồn tại vĩnh viễn, chờ user) — nhưng ảnh hưởng sold/remaining dài hạn | Khách hàng + PM | Trước GA | Policy vé |
| Q9 | Có cần dashboard vé chưa gắn (unlinked) bên content-service cho GA? (Khuyến nghị: defer — admin ticket-mayo đủ) | PM | Không chặn GA | Scope |
| Q10 | Migration rollback nullable userId: nếu buộc rollback, vé email-only hiện có xử lý thế nào? (Khuyến nghị trong §11.3: backfill userId placeholder hoặc delete vé unlinked + hoàn sold) | Eng Lead content-service | Trước khi viết migration | Migration rollback plan |

---

## 11. Launch Plan

### 11.1. Phases

| Phase | Nội dung | Gate ra |
|-------|----------|---------|
| P0 — Human gate sản phẩm | Duyệt PRD: Q1-Q3, Q5; chốt các khuyến nghị §7 | Quyết định khách hàng + PM ký |
| P1 — content-service | Migration (userId nullable + recipientEmailHash + index) + API mint/link + audit raw SQL §6.3 + tests + contract test + migration rollback test + threat-model review (model khác) | ASSURANCE hard-gates PASS (tests, mutation ≥ ngưỡng team, SAST/gitleaks clean, contract test, rollback rehearsal); deploy content trước |
| P2 — ticket-mayo | distribute() eager mint + sync 3 điểm + claim semantics E1 + PreTicket states + admin UI + flag DISTRIBUTION_MINT_MODE | Hard-gates PASS; chạy migration content_pivot đang nợ + migration mới; deploy sau content; smoke test mint |
| P3 — Backfill + GA | Chạy backfill PreTicket PENDING (sau Q3); bật flag EAGER production; monitor metric bảng §2 | 30 ngày metric đạt target |

### 11.2. Monitoring sau GA (tuần đầu: daily)

- Mint success rate / job (alert nếu < 100% — mọi mint fail đều phải visible).
- `sold` khớp tổng PreTicket MINTED (reconciliation job/alert).
- Sync: linked count per register/login (alert nếu register thành công mà sync lỗi 5xx > 1%).
- Vé mồ côi / double-mint: query đối soát Ticket ↔ PreTicket (alert != 0).
- Guardrail: claim-link click→register conversion.

### 11.3. Rollback plan

- **Hành vi (nhanh nhất)**: `DISTRIBUTION_MINT_MODE=LAZY` — quay về lazy claim không deploy lại. Vé đã mint email-only vẫn hợp lệ (schema tương thích 2 chiều).
- **Code**: revert feature branch ticket-mayo (content API mới vô hại nếu không ai gọi).
- **Migration content (Q10)**: trước khi set lại NOT NULL phải xử lý vé `userId IS NULL`: (a) đã có user → giữ nguyên (đã có userId); (b) chưa gắn → gắn placeholder `"ROLLBACK-UNLINKED"` (đánh dấu dọn sau) hoặc delete vé unlinked + `sold` giảm tương ứng (chỉ khi vé chưa USED). Viết migration downgrade + test rehearsal TRƯỚC khi chạy upgrade (ASSURANCE).
- **Rollback criteria**: mint fail rate > 5% job trong 24h; sai lệch sold/reconciliation > 0 vé không giải thích được; sync 5xx > 1% register → flag LAZY + điều tra.

---

## 12. Appendix

- Yêu cầu gốc (verbatim): §1.1.
- Design doc nền tảng: `c:\MAYogu_VIASG\ticket-mayo\docs\DESIGN-ticket-service.md` (§5.2 lazy claim — bị supersede phần mint; §7 email-hash binding — giữ nguyên; §8.5 cảnh báo content blockers — vẫn hiệu lực).
- Code evidence: bảng §1.3.
- Quy trình: autobuild — 3 cổng người, critic hoài nghi, verify thủ công, KHÔNG auto-merge; mọi thay đổi qua feature branch; KHÔNG auto-commit.
- Bối cảnh pivot: memory `project_ticket_mayo.md` — content-service là nguồn sự thật Event/TicketType/Ticket/check-in (internal API x-service-token, PORT 30041); ticket-mayo giữ PortalUser + Distribution/UI; migration content_pivot CHƯA chạy.
