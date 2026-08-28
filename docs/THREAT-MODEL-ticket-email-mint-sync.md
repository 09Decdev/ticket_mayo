# THREAT MODEL: Ticket Email Mint-Sync (EAGER mint + link-by-email)

**Ngày**: 2026-08-27
**Tác giả**: Security Architect (vòng /autobuild)
**Trạng thái**: Chờ phản biện chéo (Q4) + human duyệt (Q2)
**Đối tượng**: `docs/PRD-ticket-email-mint-sync.md` v1.1 (approved), `docs/WORKFLOW-ticket-email-mint-sync.md` 0.1 (draft)
**Phương pháp**: Đọc code thực tế cả 2 repo (cite `file:dòng` cho mọi claim), default hoài nghi — không chấp nhận nhận định "chắc chắn an toàn" nếu không kiểm chứng được trong code, kể cả nhận định trong PRD.

---

## 1. Tổng quan hệ thống & ranh giới tin cậy

### 1.1. Thành phần

| Thành phần | Vai trò | Ghi chú an ninh |
|---|---|---|
| Admin portal (ticket-mayo) | Submit đợt phát vé | Auth JWT admin (ngoài phạm vi chính) |
| ticket-mayo DB | DistributionJob, PreTicket, PortalUser, DistributionAudit | Chứa emailHash + **plaintext email của PortalUser** |
| content-service | Nguồn sự thật Event/TicketType/Ticket, mint + check-in | Có 4 blocker audit đang MỞ (memory `project_content_service_audit`), trong đó JWT/x-user-id auth bypass |
| user-community-service | lookup displayName theo email | Nhận plaintext email batch |
| Kafka topic `notification.send-ticket` / SMTP | Vận chuyển email vé | Chứa plaintext email + claimToken |
| User (người nhận) | Click claim-link, register/login portal | |

### 1.2. Sơ đồ ranh giới tin cậy (text)

```
┌─ TB-1: Admin ──────────────────────────────────────────────┐
│  Admin (JWT) ──POST /distribution──> ticket-mayo distribute()│
└────────────────────────────────────────────────────────────┘
┌─ TB-2: ticket-mayo ──> content-service ────────────────────┐
│  POST /content-service/internal/distribution/mint          │
│  POST /content-service/internal/distribution/link-by-email │
│  Header: x-service-token: INTERNAL_SERVICE_TOKEN (STATIC,  │
│  SHARED, không định danh caller)                           │
│  Payload mint: eventId, ticketTypeId, idempotencyKey,      │
│    recipients[{preTicketId, emailHash, userId?}]           │
│  Payload link: {emailHash, userId}                         │
│  content-service CANNOT verify emailHash ↔ userId binding  │
└────────────────────────────────────────────────────────────┘
┌─ TB-3: ticket-mayo ──> content-service DB ─────────────────┐
│  UPDATE ticket SET userId WHERE recipientEmailHash AND     │
│  userId IS NULL — nội bộ content, nằm sau TB-2             │
└────────────────────────────────────────────────────────────┘
┌─ TB-4: ticket-mayo ──> Kafka/SMTP ────────────────────────┐
│  Message body: plaintext email + claimToken + claimUrl     │
└────────────────────────────────────────────────────────────┘
┌─ TB-5: ticket-mayo ──> user-community ────────────────────┐
│  POST /users/lookup-by-emails body {emails} PLAINTEXT      │
└────────────────────────────────────────────────────────────┘
┌─ TB-6: User ──> claim-link ───────────────────────────────┐
│  GET /c/:claimToken (claimToken = UUIDv4-256bit-random,    │
│  claimToken @unique — schema.prisma:75). E1: "xem vé /     │
│  tạo tài khoản". Bắt buộc login + emailHash khớp mới thấy │
│  vé (claim.service.ts:45-48)                               │
└────────────────────────────────────────────────────────────┘
```

**Nhận xét TB-2 (quan trọng nhất)**: `ServiceTokenGuard` so sánh token bằng `===` (service-token.guard.ts:16 — không timing-safe) và token là MỘT giá trị tĩnh dùng chung mọi service. Sau guard, request được tin hoàn toàn — mint API nhận `userId` + `emailHash` tùy ý trong payload và không có cơ chế nào kiểm tra hai giá trị này khớp nhau hay có thật. Toàn bộ mô hình an ninh của EAGER mint dựa trên độ bí mật của một chuỗi tĩnh. Đây là gốc của hầu hết phân tích mục 3.

---

## 2. STRIDE — 2 API mới

### 2.1. `POST /internal/distribution/mint` (contract C-1)

| Threat | Kịch bản | Điều kiện tiên quyết | Severity | Giảm thiểu (hiện có / bắt buộc thêm) |
|---|---|---|---|---|
| **S**poofing | Caller giả mạo ticket-mayo bằng token rò rỉ → mint vô số vé | INTERNAL_SERVICE_TOKEN lộ (log, env, network) | **Critical** | Chỉ có 1 lớp: ServiceTokenGuard. BẮT BUỘC: network policy chỉ cho ticket-mayo đến content; timing-safe compare; monitoring mint bất thường |
| **T**ampering | Payload bị sửa giữa đường (MITM) | Không TLS nội bộ | High | TLS nội bộ bắt buộc; hiện `CONTENT_SERVICE_BASE_URL` mặc định `http://` (env.ts:145-146) |
| **T**ampering | Caller hợp lệ gửi `userId` fake / `emailHash` fake | Token hợp lệ nhưng caller bị compromise, hoặc bug | High | Content không thể validate; cần audit cross-check sold↔MINTED (mục 3.3) |
| **R**epudiation | Mint xảy ra nhưng không ai truy vết được ai gọi | Thiếu audit per-call | Medium | C-1 đã yêu cầu audit content-side (jobId, sold trước/sau) — phải có caller-identity, hiện chỉ có "ai giữ token" |
| **I**nformation Disclosure | Response/message lộ remaining, cấu trúc nội bộ | Gọi API thành công | Low | Message 409 đã chứa remaining (internal-ticket-distribution.service.ts:187) — chấp nhận được nội bộ |
| **D**enial of Service | Batch ≤1000 × nhiều request đồng thời → cạn sequence, khóa row TicketType, nghẽn DB | Có token (hoặc guard yếu) | High | Rate-limit/size limit nội bộ (checklist mục 5); chunk R10 giúp nhưng không chống được nhiều job song song |
| **E**levation of Privilege | Mint với `userId` của admin/victim → vé vào tài khoản sai | Token lộ HOẶC link-by-email bị lạm dụng (mục 3.4) | **Critical** | Không có sẵn; bắt buộc đối chiếu mint-logs với PreTicket (reconciliation) |

### 2.2. `POST /internal/distribution/link-by-email` (contract C-2)

| Threat | Kịch bản | Điều kiện tiên quyết | Severity | Giảm thiểu |
|---|---|---|---|---|
| **S**poofing | Caller giả mạo → gán vé unlinked của victim vào tài khoản attacker | Token lộ + biết emailHash victim | **Critical** | Không có; emailHash đọc được từ DB ticket-mayo (PreTicket.recipientEmailHash) hoặc DB content sau migration |
| **T**ampering | Gán `userId` của victim cho vé của attacker (đổ vé vào tài khoản người khác) | Token lộ | **Critical** | Không có — C-2 tin hoàn toàn cặp (emailHash, userId) |
| **R**epudiation | Link xảy ra, user phủ nhận đã nhận vé | Chỉ log `linked: N` | Medium | Cần audit per-link (emailHash, userId, N) — hiện C-2 chỉ trả số |
| **I**nformation Disclosure | `linked` count + timing để dò emailHash nào có vé | Có token | Low | Trả N hợp lệ; rate-limit |
| **D**oS | Spam link call khóa row Ticket theo emailHash | Token lộ | Medium | Rate-limit nội bộ |
| **E**oP | Kết hợp mint (userId NULL) + link tự ý → tự cấp vé cho mình | Token lộ | **Critical** | Không có; monitoring linked-count bất thường |

---

## 3. Phân tích tấn công cụ thể

### 3.1. Replay / vòng qua idempotency — bao gồm F-02 của Workflow Architect

**CHẤP NHẬN F-02 (Critical) và mở rộng phân tích theo 3 ca được yêu cầu.**

Bằng chứng code hiện tại: `distribute()` khi idempotency-hit trả job cũ và kết thúc (distribution.service.ts:32-40) — kể cả job RUNNING. Job crash giữa chừng → cùng key là dead-end, key khác tạo PreTicket mới.

Idempotency có 2 tầng, phải xét riêng từng tầng:

**Tầng 1 — ticket-mayo, theo idempotencyKey (jobId):**
- Job RUNNING kẹt + admin submit lại cùng key (WF1-R1 resume): spec mới xử lý đúng.
- Job RUNNING kẹt + admin dùng KEY KHÁC: tạo job mới + PreTicket mới cho CÙNG emailHash. Tầng 1 KHÔNG chặn. Đây chính là ca double-mint thật.
- Phân tích: đây là tấn công tự gây thương tích (self-inflicted) — không cần kẻ tấn công bên ngoài, chỉ cần operator panic khi job đứng. Severity cho tài sản: **High** (mất quota, phát vé đôi cho cùng người — người nhận có 2 vé thật, khách quan tổ chức mất doanh thu nếu bán).

**Tầng 2 — content-service, theo preTicketId (contract C-1, assumption A2 của WORKFLOW):**
- **Replay có chủ ý** (gửi lại y nguyên request cũ): C-1 trả `alreadyMinted: true`, sold không tăng → CHỐNG ĐƯỢC, **MIỄN LÀ** mapping preTicketId→Ticket là unique constraint thật ở DB (cột unique hoặc bảng mapping unique), không phải chỉ check-then-insert trong service. Nếu implement bằng "find rồi create" thì 2 request đồng thời vẫn tạo đôi. **Yêu cầu bắt buộc: unique constraint ở DB + bắt P2002 trả ticket cũ.**
- **Retry sau network fail** (timeout 15s — content-client.service.ts:32): nguy hiểm nhất. Timeout KHÔNG có nghĩa là chưa mint — content có thể đã commit xong nhưng response mất. Nếu caller coi timeout = "chưa mint" rồi tạo PreTicket/dòng mới để mint lại → double. WF1-R1 đã xử đúng (re-gọi cùng preTicketId, nội dung idempotent của C-1 là cơ chế chống đôi). Kết luận: **an toàn khi và chỉ khi A2 (unique mapping) được build như constraint DB.** Đây là điều kiện chặn, đưa vào danh sách duyệt mục 6.
- **2 job khác nhau share emailHash** (ca F-02 key-khác): tầng 2 KHÔNG chặn vì preTicketId khác nhau → 2 Ticket thật cho cùng người. Chống được ở tầng 1 không thôi là不够: cần (a) UI/ops rule "không bao giờ phát lại bằng key mới cho job chưa FAILED rõ ràng", (b) cảnh báo khi tạo job mới mà emailHash đã có PreTicket đang PENDING/MINTING của job khác (check được trong cùng DB ticket-mayo trước E1.5 — rẻ và hiệu quả), (c) reconciliation định kỳ tổng Ticket(content) vs tổng PreTicket MINTED+CLAIMED(ticket-mayo).

### 3.2. Double-mint race — bao gồm F-01 (quota check-then-act NGOÀI tx)

**CHẤP NHẬN F-01 (Critical). Bằng chứng code (đọc trực tiếp, không lấy từ WORKFLOW):**

- `issueTickets` check quota tại service layer: `tt.sold + dto.quantity > tt.quantity` → 409 (internal-ticket-distribution.service.ts:185-191) — **đọc không khóa, ngoài tx**.
- `registerTicketsWithTx` (ticket.repository.adapter.ts:250-287): trong tx chỉ có `sold: { increment }` (dòng 258-261) → nextTicketCodes → createMany. **KHÔNG có re-check quota, KHÔNG có row-lock đọc sold trước khi tăng.**
- Hệ quả: 2 request đồng thời cùng đọc `sold=90, quantity=100`, mỗi request 10 vé → cả 2 pass check → cả 2 increment → sold=110 > 100. **Over-mint thật.**
- **PRD R9 nói đây là "pattern đã có" của registerTicketsWithTx là SAI sự thật code** — đây là điểm gây tranh cãi nhất, phản biện chéo phải xác nhận lại.

C-1 đã yêu cầu đúng pattern: `UPDATE ticketType SET sold = sold + :N WHERE id = :id AND sold + :N <= :quantity` trong cùng tx, 0-row-affected → fail. Threat model bổ sung 2 điều kiện nghiệm thu:
1. Row-lock phải là kết quả của chính câu UPDATE điều kiện (không phải `SELECT ... FOR UPDATE` tách riêng rồi UPDATE vô điều kiện — vẫn race nếu write skew).
2. `nextval('ticket_global_seq')` trong tx (ticket.repository.adapter.ts:21-23) an toàn cho tính duy nhất (sequence không rollback — chỉ bỏ hụt số, chấp nhận được), nhưng test concurrency 2 tx phải có trong contract test T3.

Severity nếu mint API copy pattern cũ: **Critical** (tác động tài chính: vượt quota phát hành, khách quá sức chứa chỗ).

### 3.3. Batch injection — fake recipients / fake userIds

**Ai bảo đảm `userId` trong payload mint là PortalUser thật? Câu trả lời từ code: KHÔNG AI.**

- Content-side: guard chỉ kiểm token (service-token.guard.ts:13-21). `InternalIssueTicketsDto.userId` hiện `@IsNotEmpty` bắt buộc (internal-distribution.dto.ts:33-35) — tức API hiện tại không có khái niệm "email-only", mint mới bắt buộc đổi sang optional + thêm `emailHash`. Content không có PortalUser table → không thể FK-check → mọi `userId` string đều được nhận.
- Ticket-mayo-side: E1.4 resolve userId từ `portalUser.findMany({where:{emailHash:{in:[...]}}})` — cùng DB (A3, đã verify WORKFLOW mục 11). Đây là nguồn duy nhất hợp lệ.

Phân tích theo nguồn đe dọa:
- **Bug nội bộ** (Main): emailHash của PreTicket A map nhầm userId của user B — chỉ xảy ra nếu code gán sai; E1.4 match theo emailHash nên rủi ro thấp, nhưng phải có test TC-W2-05.
- **Caller bị compromise** (token lộ): mint với `userId` tùy ý + `emailHash` tùy ý → vé hiện trong "Vé của tôi" của user bất kỳ. Content không thể phân biệt. Giảm thiểu duy nhất hiện thực: (a) giữ ticket-mayo là caller duy nhất (network policy), (b) reconciliation: mỗi Ticket mint qua C-1 phải có PreTicket MINTED tương ứng với ĐÚNG (preTicketId, emailHash, userId) — check batch hàng ngày, lệch là alert. Severity: **Critical** (điều kiện: token lộ).
- **Admin portal bị lừa submit list email khổng lồ / email của chính mình**: xem 3.5 (không có cap recipients).

Kiến nghị ghi nhận thêm: C-1 nên yêu cầu payload kèm `jobId` (đã có qua idempotencyKey) và content ghi `createdByJob` lên Ticket/bảng mapping để truy vết 2 chiều.

### 3.4. Lạm dụng link-by-email — 2 chiều

**Chiều 1 — gán userId tùy ý vào vé của victim (đánh cắp vé):**
- Điều kiện: token lộ + biết `recipientEmailHash` của victim. emailHash đọc được từ: DB ticket-mayo (`PreTicket.recipientEmailHash`), DB content (cột mới sau migration), hoặc tính lại nếu pepper lộ (mục 3.5).
- Thao tác: `POST link-by-email {emailHash: victimHash, userId: attackerPortalUserId}` → mọi vé unlinked của victim giờ thuộc attacker. C-2 là single UPDATE trust-toàn-bộ — content không verify emailHash thuộc về userId đó.
- Sau khi đã link: vé vào "Vé của tôi" của attacker, có QR check-in. **Người nhận thật mất vé mà không hay biết** (email link cũ vẫn mở được nhưng claim-path yêu cầu emailHash khớp — claim.service.ts:45-48 — nên victim click link sẽ thấy needsAuth mãi, không có đường khiếu nại tự động).
- Severity: **Critical** (điều kiện: token lộ; tác động: mất tài sản vé).

**Chiều 2 — gán userId của victim vào vé của attacker (đổ vé rác/bán lại):**
- `POST link-by-email {emailHash: attackerHash, userId: victimId}` → vé của attacker hiện trong tài khoản victim. Tác động: nhúng lẫn dữ liệu, gây rối khiếu nại; nhẹ hơn chiều 1 nhưng cùng gốc rễ.
- Severity: High.

**Giảm thiểu bắt buộc (khuyến nghị vào C-2):**
1. **Nguyên tắc "server-side binding"**: link-by-email chỉ được gọi bởi ticket-mayo VÀ userId trong payload phải lấy từ PortalUser đã xác thực qua JWT trong request gốc (register/login/list) — không bao giờ nhận userId từ query param hay body của endpoint công khai. Kiểm tra: 3 trigger điểm WF2.2 đều thỏa (userId = `user.id` sau verify password/JWT) → thiết kế hiện tại đúng, chỉ cần giữ bất biến này khi code.
2. Content thêm assertion rẻ: nếu `userId` đã tồn tại trên Ticket khác với emailHash khác trong cùng ticketType → log cảnh báo (không chặn — người thật có thể đổi email… thực ra PortalUser không đổi email theo schema hiện tại → có thể chặn cứng, nhưng để phản biện quyết).
3. Audit per-link với (emailHash, userId, N, caller) — currently C-2 không có, phải thêm.

### 3.5. emailHash enumeration / brute-force + pepper

**Thuật toán**: HMAC-SHA256, pepper ≥16 ký tự bắt buộc (email-hash.util.ts:21-23), normalize `lowercase().trim()` (email-hash.util.ts:8-9, khớp user-community crypto-gcm.util.ts).

- **Không có pepper**: HMAC-SHA256 với pepper đủ mạnh → brute-force từng email đoán đối chi chiều dài 256-bit là vô ích. Kẻ tấn công phải THỬ từng ứng viên email (dictionary) — cùng chi phí dù có hash hay không vì email là không gian entropy thấp (tên+họ+domain). Kết luận: **hash không làm tăng độ khó enumerate so với đoán email trực tiếp** — nó chỉ ngăn "đọc hiểu trực tiếp" và ngăn join dữ liệu. Enumeration qua API: không có endpoint nào cho phép dò emailHash (claim trả 404 generic / needsAuth không leak — claim.service.ts:32-34,45-48). Không tìm thấy oracle nào khác. OK.
- **Pepper lộ** (log, env, backup): mọi emailHash trở thành dictionary-able (email entropy thấp → giải gần như toàn bộ). Hệ quả kép: (a) lộ danh tính người nhận vé từ DB content/PreTicket, (b) chiều 1 mục 3.4 trở nên dễ (tính lại hash victim). Severity pepper leak: **High**.
- **Pepper CHUNG với user-community** (email-hash.util.ts:13-17 comment xác nhận): lộ ở một service = lộ cả hai. Đây là đánh đổi đã chốt (Q2) — ghi nhận rủi ro, không re-litigate, nhưng yêu cầu: pepper là secret mức cao nhất, không bao giờ xuất hiện trong log/env-file commit.

**F-07 (pepper drift = sync chết im lặng) — CHẤP NHẬN, phân tích theo 3 câu hỏi được giao:**

1. **Phát hiện drift kiểu gì?** Linked=0 mãi mà không lỗi — không có exception nào. Cách phát hiện duy nhất đáng tin: **metric `linked-count` theo trigger** (WORKFLOW A1 đã nêu) + **reconciliation hàng ngày**: tồn tại PreTicket MINTED-unlinked > N ngày (vd 7) cho emailHash có PortalUser → alert. Thêm: metric "số request register/login có ít nhất 1 PreTicket MINTED-unlinked" — nếu liên tục linked=0 trên population đó thì chắc chắn drift (hoặc C-2 hỏng). KHÔNG dựa vào log warn (chỉ ghi khi HTTP fail, drift thì HTTP vẫn 200).
2. **Rotation pepper có làm lộ khả năng enumerate không?** Có, theo 2 cách: (a) trong cửa sổ rotation, hash mới/ cũ trộn nhau — attacker có dump trước-sau có thể phân biệt email nào "được re-hash" (tức email đang hoạt động) — metadata leak nhẹ; (b) nếu giữ pepper cũ để verify (dual-verify window) thì thời gian duyệt dictionary của attacker chỉ tăng theo số pepper từng dùng — không tệ hơn một pepper dài hơn. **Kết luận: rotation được, nhưng phải (1) re-hash toàn bộ đồng bộ 2 repo + 2 DB (PreTicket.recipientEmailHash, PortalUser.emailHash, content Ticket.recipientEmailHash) trong MỘT cửa sổ deploy, (2) version cột hash (`emailHashVersion`) nếu không đảm bảo atomicity — không version là thiếu cơ chế rotation thật; hiện tại KHÔNG có version nào → thực tế pepper là KHÔNG-thể-rotate an toàn.** Đây là rủi ro được chấp nhận ngầm — phải nêu rõ cho human duyệt Q2.
3. **Pre-flight check hash mẫu**: ĐỒNG Ý và nâng cấp — deploy-gate D1.2 (WORKFLOW 8.1) nên chạy phép kiểm tra cụ thể: chọn 1 PortalUser已知, verify `generateEmailHash(known email)` trong ticket-mayo == `PortalUser.emailHash` trong DB; sau deploy content, mint 1 vé test với emailHash đó và link → `linked ≥ 1` phải xảy ra với tài khoản test. Fail = DỪNG deploy (đây là smoke D2.4 mở rộng).

### 3.6. Thao túng quota / DoS bằng batch

- **Vượt quota bằng race**: đã phân tích 3.2 (F-01). Critical.
- **DoS/quota exhaustion bằng batch lớn**: `DistributeRequestDto.recipients` KHÔNG có `@ArrayMaxSize` (distribute-request.dto.ts:16-18 chỉ `@IsArray @IsEmail each`), `quantity` không có `@Max` (dòng 11-14 chỉ `@Min(1)`). Một submit 100.000 email × quantity 5 = 500.000 PreTicket trong 1 tx (distribution.service.ts:83-94 createMany trong transaction) + 500.000 email. Hệ quả: (a) tx dài khóa/ức chế ticket-mayo DB, (b) nếu EAGER: 500 lệnh mint 1000-vé, chiếm sequence và row-lock TicketType làm nghẽn content-service cho MỌI event khác dùng chung sequence `ticket_global_seq`, (c) cạn quota thật của event đó (lần phát "thật" sau bị 409).
- **Điều kiện tiên quyết**: tài khoản admin (hoặc admin session bị chiếm). Không phải vector unauthenticated, nhưng đúng kiểu "operator error + thiếu guardrail".
- Severity: **High** (DoS nội bộ + mất quota; không cần token service).
- Bắt buộc: `@ArrayMaxSize(1000)` recipients, `@Max(10)` quantity (hoặc theo nghiệp vụ), body size limit ở Nest (payload too large → 413), và rate-limit per-admin cho endpoint distribute. Lưu ý C-1 đã giới hạn batch ≤1000 nhưng ĐÓ là giới hạn của MỖI call mint, không phải của recipients gốc.

### 3.7. Claim-link dưới EAGER + link LAZY cũ sau upgrade

**Thiết kế E1 an toàn hơn LAZY, với 3 điều kiện:**

1. **Ai thấy vé khi link lộ?** Chỉ người đã login với emailHash khớp (claim.service.ts:42-48 — query PortalUser, so `user.emailHash !== preTicket.recipientEmailHash` → needsAuth). Token lộ một mình KHÔNG đủ để xem vé (khác LAZY về ngữ nghĩa sai biệt: LAZY token+là điều kiện mint; EAGER token chỉ là "con trỏ" đến PreTicket, authorization vẫn qua login). Điểm TỐT — giữ nguyên bất biến này khi code WF3.
2. **Token cũ single-use?** — KHÔNG, và KHÔNG cần: claimToken không phải one-time; nó là locator. Vấn đề "single-use" chỉ tồn tại nếu token cấp quyền. Vì authorization nằm ở emailHash-match, token dùng nhiều lần vô hại. NHƯNG: link cũ của LAZY-era có PreTicket PENDING → theo WF3 C3, path legacy vẫn mint-on-click (PENDING→CLAIMING→CLAIMED). Sau upgrade + backfill, các token này trỏ tới PreTicket EXPIRED (hết quota) hoặc MINTED (backfill mint rồi). Nếu backfill mint thành công: người giữ link cũ click → MINTED path → login khớp emailHash → thấy vé — ĐÚNG. Nếu EXPIRED: thông báo trung thực. → Không tìm thấy lỗ hổng trong thiết kế này, với điều kiện **WF3 switch theo status là nguồn sự thật** (bao gồm cả F-08: LAZY code cũ phải xử MINTED/LINKED — không thì rollback flag gây 500).
3. **Link leak qua email/Kafka** (TB-4): message Kafka chứa plaintext email + claimToken trong `value: JSON.stringify(payload)` với `key: payload.claimToken` (kafka-producer.adapter.ts:70-75). Ai đọc được topic = có cặp (email, token). Dưới EAGER token một mình không đủ xem vé (mục 1 trên) → rủi ro còn lại là metadata leak (email + việc người đó được phát vé) — mức Medium, giảm bằng: Kafka ACL chặn consumer trái phép, TLS broker, và cân nhắc bỏ `email` khỏi payload Kafka (chỉ cần displayName + token; SMTP adapter dựng lại từ địa chỉ nếu cần — cần review của Backend).

**Ghi chú thêm**: `PreTicket.expiresAt` (schema.prisma:83) không được enforce trong claim flow hiện tại — dưới LAZY token "không hết hạn" là chủ đích của offline checkin, nhưng với PreTicket thì nhánh WF4 EXPIRED là terminal theo status, không theo expiresAt. Không phải lỗ hổng, nhưng hai khái niệm "hết hạn" dễ nhầm — QA nên có test phân biệt.

### 3.8. x-user-id injection đến internal API

**Kiểm tra theo yêu cầu: mint/link có chấp nhận user context từ client không?**

- `ServiceTokenGuard` chỉ đọc `x-service-token` (service-token.guard.ts:13), KHÔNG đọc `x-user-id`, KHÔNG set user từ header. Sau guard chỉ có `request.isInternalRequest = true`.
- Nhờ đó, endpoint mint/link KHÔNG nhận user identity từ request — user identity chỉ đến trong JSON body (emailHash/userId) do ticket-mayo构造, nguồn gốc từ JWT của user đã verify (mục 3.4 nguyên tắc binding).
- **NHƯNG**: blocker audit content-service (JWT/x-user-id auth bypass — memory `project_content_service_audit`, 4 blocker đang MỞ) có nghĩa là CÁC endpoint khác của content-service có thể chấp nhận `x-user-id` để mạo danh user. Nếu bypass đó tồn tại trên endpoint đọc Ticket (vd `GET /internal/distribution/users/:userId/tickets` — internal-distribution.controller.ts:92-96), thì kẻ tấn công không cần token service vẫn liệt kê vé của user bất kỳ bằng cách set `x-user-id` nếu middleware tương ứng chưa vá. **Mint/link API mới phải được audit độc lập: KHÔNG mount middleware nào parse x-user-id trên 2 route này; route chỉ nằm sau ServiceTokenGuard thuần.** Yêu cầu nghiệm thu: contract test — gọi mint/link với `x-user-id: victim` + không token → 401; với token + `x-user-id: victim` → emailHash/userId trong body không bị override bởi header.
- Trạng thái blocker: theo memory, 4 blocker content-service chưa đóng. **Deploy content-service trước (D2) khi blocker JWT chưa vá = tăng exposure.** Kiến nghị: vá blocker JWT/x-user-id CÙNG release với mint API, hoặc tối thiểu xác nhận 2 route mới không dính middleware lỗi. Severity nếu bỏ qua: High.

### 3.9. RB3 — vé unlinked USED không được delete khi rollback migration

**CHẤP NHẬN (Medium → tôi đánh giá High về tính toàn vẹn dữ liệu).**

Phân tích an ninh: vé USED = đã check-in tại cửa. Xóa nó (option b RB3) tạo 2 hệ quả: (1) sold giảm nhưng người đã VÀO sự kiện — dữ liệu check-in mồ côi (check-in log trỏ Ticket đã xóa nếu không có FK restrict → orphan); (2) nếu sau này same emailHash được mint lại, người đó nhận vé "mới" cho sự kiện đã từng vào — lạm dụng tiềm năng (vào 2 lần bằng 2 lần phát). Placeholder "ROLLBACK-UNLINKED" (option a) an toàn hơn: giữ bản ghi, gán userId giả định danh. Rủi ro của placeholder: giá trị "ROLLBACK-UNLINKED" nếu được code coi là userId thật ở đâu đó (list-my-tickets của user có id đó là vô hại vì không ai có id đó; nhưng stats/checkin phải test). Đề xuất: placeholder dạng `ROLLBACK-UNLINKED-<uuid>` unique per row, không cố định một chuỗi chung, kèm flag cột riêng nếu được. Nghiệm thu: TC-W6-03 phải assert USED-unlinked KHÔNG BAO GIỜ bị delete trong mọi option downgrade.

---

## 4. PII / vệ sinh log

### 4.1. Plaintext email sống ở đâu

| Vị trí | Bằng chứng | Đánh giá |
|---|---|---|
| PortalUser.email (DB ticket-mayo) | auth.service.ts:43-51 create | Cần thiết (login) — OK |
| PreTicket seeds trong bộ nhớ khi distribute | distribution.service.ts:56-64 (`email` trong seed object) | Không persist (createMany chỉ ghi hash — dòng 83-93 không có cột email) — OK, NHƯNG seeds nằm trong memory + có thể vào stack-trace nếu throw |
| Mail payload `ClaimMailPayload.email` | mail.adapter.ts:15 | Cần thiết cho SMTP; KHÔNG cần thiết cho Kafka (mục 3.7.3) |
| Kafka message body | kafka-producer.adapter.ts:73 `JSON.stringify(payload)`, key=claimToken (dòng 72) | **Plaintext PII + token trên bus** — Medium |
| HTTP body đến user-community | user-community-client.service.ts:44-52 `body: JSON.stringify({ emails })` | Plaintext batch — cần TLS nội bộ + không log body |
| **Log stdout ticket-mayo** | **auth.service.ts:56** (`email=${email}` khi register), **auth.service.ts:84** (login), admin-bootstrap.service.ts:28,38 | **VI PHẠM trực tiếp PRD §8.6 "Cấm log plaintext email".** Log tập trung là nơi sống lâu nhất của PII |
| Log stdout khi mail fail | mail-dispatcher.service.ts:202-204 (`token=${p.claimToken}`) | claimToken trong log — dưới EAGER ít nhạy hơn (mục 3.7.1) nhưng vẫn là secret-tùy-ngữ-cảnh; nên hash/thâu gọn |
| Log content-service | issueTickets log userId + ticketTypeId (internal-ticket-distribution.service.ts:201-203), không thấy email | OK |
| DistributionAudit | emailHash only, best-effort (audit.service.ts pattern — đã verify) | ĐÚNG thiết kế — giữ |

### 4.2. Yêu cầu khắc phục (chặn merge)

1. **Xóa plaintext email khỏi mọi logger call** — auth.service.ts:56,84; admin-bootstrap.service.ts:28,38. Thay bằng `emailHash=${user.emailHash}` hoặc chỉ `userId`. Đây là fix 1-dòng từng file, không có lý do technische nào giữ.
2. Logger wrapper cấm pattern: thêm rule lint/regex gate CI (`logger.*email=` phải fail) — chống tái phát.
3. Kafka payload: bỏ trường `email` (chỉ giữ displayName, claimToken, event info); SMTP adapter cần địa chỉ người nhận thì thêm trường riêng chỉ SMTP adapter đọc, hoặc tái tạo từ token→DB query tại consumer.
4. claimToken trong error log (mail-dispatcher.service.ts:203): đổi sang `token=…${p.claimToken.slice(-8)}` — đủ debug.
5. Kiểm tra còn lại: Grep toàn bộ `logger.*token` chỉ còn mail-dispatcher (đã liệt kê); không logger nào in pepper/JWT/secret (đã Grep — sạch ngoài các điểm trên).

### 4.3. Kế hoạch pepper (tóm tắt từ 3.5)

- Hiện trạng: một pepper chung ticket-mayo + user-community, không version cột → rotation thực tế bất khả thi senza re-hash atomic 2 DB.
- Nếu human duyệt Q2 tiếp tục phương án hiện tại: bắt buộc (a) pepper trong secret manager, không env-file; (b) runbook rotation mô tả cửa sổ freeze mint+sync; (c) metric drift như 3.5.1; (d) pre-flight hash-sample 3.5.3 trong deploy-gate.
- Phương án chuẩn hơn (đề xuất, không chặn): `emailHashVersion` + dual-verify — để phản biện chéo xét.

---

## 5. Checklist AuthN/AuthZ cho 2 API mới (nghiệm thu T3)

| # | Mục | mint (C-1) | link-by-email (C-2) |
|---|---|---|---|
| 1 | Guard | `@UseGuards(ServiceTokenGuard)` — ĐÃ定 trong controller pattern (internal-distribution.controller.ts:33-34) | BẮT BUỘC như mint — KHÔNG route public, KHÔNGJwtAuthGuard thay thế |
| 2 | So sánh token timing-safe | HIỆN TẠI `===` (service-token.guard.ts:16) — **phải đổi `crypto.timingSafeEqual`** | Như trái |
| 3 | Rate limit nội bộ | BẮT BUỘC thêm (nhiều mint/s từ 1 caller = bất thường) | BẮT BUỘC (link spam khóa row) |
| 4 | Size limit | `@ArrayMaxSize(1000)` recipients (C-1 spec) + body 413 gate | Payload 2 trường — vẫn cần body limit chung |
| 5 | class-validator strict | `whitelist+forbidNonWhitelisted` đã bật global (content-service main.ts:143-163) — verify DTO mới không thoát validated type (`preTicketId` `@IsString @IsNotEmpty` từng item, `emailHash` `@IsHexadecimalLength(64)`, `userId` optional `@IsString` hoặc null) | `emailHash` hex64, `userId` non-empty string |
| 6 | Không nhận user context từ header | Verify KHÔNG middleware gắn `req.user`/x-user-id trên 2 route (mục 3.8) — thêm test: header x-user-id bị bỏ qua hoàn toàn | Như trái |
| 7 | Không log secret/PII | Log chỉ jobId, counts, sold trước/sau (C-1 đã đúng ý — WORKFLOW dòng 136) | Log emailHash + userId + N — KHÔNG plaintext |
| 8 | TLS | `CONTENT_SERVICE_BASE_URL` phải `https://` ở prod (env.ts:145-146 mặc định http://localhost — chỉ chấp nhận ở dev) | Như trái |
| 9 | CORS | Content-service hiện `origin: '*'` (main.ts:95-99) — internal API không cần CORS; **đặt lại whitelist hoặc tắt CORS cho internal routes**; Swagger public (main.ts:79-89) nên khóa ở prod | Như trái |
| 10 | INTERNAL_SERVICE_TOKEN không rỗng | ticket-mayo default `''` (env.ts:147) — **fail-start nếu trống ở prod** như pattern ACCESS_TOKEN_SECRET của content (main.ts:25-30) | Như trái |
| 11 | Error không leak | 409 message có remaining — chấp nhận nội bộ; 500 phải generic, không stack | Như trái |
| 12 | Audit | per-call (jobId, N, soldBefore/After, caller) | per-call (emailHash, userId, N) |

---

## 6. Danh sách chờ human + model khác duyệt

### 6.1. Q4 — duyệt threat-model mint/link (model phản biện chéo) — TRẢ LỜI TỪNG CÂU

1. **A2/mapping-unique**: C-1 idempotency theo preTicketId — bạn xác nhận implement là **unique constraint ở DB** (cột `Ticket.preTicketId @unique` hoặc bảng mapping unique), KHÔNG phải find-then-create? Nếu không phải constraint, mọi recovery WF1-R1 mất an toàn double-mint (mục 3.1) — phản bác hoặc chấp nhận.
2. **F-01**: Câu UPDATE quota điều kiện `WHERE sold + :N <= quantity` có được giữ nguyên không bị "tối ưu" thành SELECT FOR UPDATE tách rời? (mục 3.2).
3. **link-by-email binding**: bạn có thấy cách nào content-service tự verify emailHash↔userId mà không phá kiến trúc (content không có PortalUser)? Nếu không — chấp nhận rủi ro mục 3.4 với giảm thiểu (network policy + reconciliation) hay đòi thêm cấu trúc (vd ticket-mayo ký HMAC payload ngắn hạn theo (emailHash,userId) với khóa riêng mint-path)?
4. **§8.6 log**: fix xóa email khỏi auth.service.ts:56,84 + admin-bootstrap.service.ts:28,38 có vào merge gate không, hay để tech-debt? (Tôi cho rằng PHẢI chặn merge — 1 dòng mỗi chỗ.)
5. **recipients cap**: `@ArrayMaxSize(1000)` + `@Max(10)` quantity — số cụ thể OK hay đổi? (mục 3.6)
6. **F-07 drift**: chấp nhận metric linked-count + reconciliation + pre-flight hash-sample như đủ? Có đòi `emailHashVersion` không? (mục 3.5)
7. **3.8 x-user-id**: có thể xác nhận blocker JWT/x-user-id của content-service không dính 2 route mới (không middleware parse header) — bằng test cụ thể nào?

### 6.2. Q2 — human duyệt PII/emailHash (merge-blocker)

1. Human có duyệt emailHash HMAC-SHA256 + pepper CHUNG user-community, KHÔNG version cột — hiểu rằng pepper về thực tế không rotate được nếu không re-hash atomic 2 DB? (mục 3.5, 4.3)
2. Human có duyệt plaintext email trên Kafka topic (hiện trạng kafka-producer.adapter.ts:73) tồn tại thêm bao lâu? Đề xuất bỏ trường email khỏi payload — có chặn merge không?
3. Log plaintext email (4 vị trí mục 4.1) — human quyết: chặn merge hay chấp nhận fix sau? (Khuyến nghị Security Architect: CHẶN.)

---

## 7. Tóm tắt severity

| # | Finding | Severity | Điều kiện | Mục |
|---|---|---|---|---|
| 1 | Quota check-then-act ngoài tx (code hiện tại; PRD R9 mô tả sai) — mint mới copy là over-mint | Critical | 2 job đồng thời | 3.2 |
| 2 | INTERNAL_SERVICE_TOKEN tĩnh chia sẻ + compare không timing-safe = gốc tin hoàn toàn cho mint/link; lộ = mint vô hạn + reassign vé | Critical | Token lộ | 1.2, 2.1, 2.2 |
| 3 | link-by-email tin cặp (emailHash,userId) không verify — steal vé unlinked / đổ vé | Critical | Token lộ (+hash victim) | 3.4 |
| 4 | Idempotency 2 tầng: key-mới-tạo-PreTicket-mới = double-mint thật; idempotency content chỉ chắc chắn nếu unique-constraint DB (A2) | High→Critical nếu A2 yếu | Operator retry sai cách | 3.1 |
| 5 | Plaintext email trong log (vi phạm PRD §8.6), Kafka body, HTTP body | Medium-High | Luôn (đang tồn tại) | 4.1 |
| 6 | Không cap recipients/quantity → DoS + quota exhaustion qua 1 submit admin | High | Admin token | 3.6 |
| 7 | Pepper không version → rotation bất khả thi thực tế; drift chết im lặng (F-07) | High | Đổi pepper / drift | 3.5 |
| 8 | Blocker JWT/x-user-id content chưa vá trong khi deploy content trước | High | Nếu bypass dính route liên quan | 3.8 |
| 9 | CORS `*` + Swagger public trên content-service | Medium | Luôn | 5.9 |
| 10 | RB3 xóa vé USED-unlinked khi downgrade = check-in mồ côi + khả năng vào 2 lần | High (integrity) | Rollback migration | 3.9 |

---

## Vòng phản biện 1

*Đối tượng: `docs/DESIGN-ticket-email-mint-sync.md` (Backend Architect) và `docs/UI-SPEC-ticket-email-mint-sync.md` (UX Architect). Mỗi finding tự đánh giá [ALIVE]/[DEAD] + cite.*

### VB1-1. [ALIVE — High] Claim "quota-guard cuối ở purchase tx" của DESIGN §9.2 là SAI theo code hiện tại — over-mint qua purchase trong cửa sổ stale Redis

DESIGN §9.2 viết: *"purchase path có thể bán vượt trong cửa sổ stale (risk chấp nhận, đã có quota-guard cuối ở purchase tx tương tự mint tx)"*. Code hiện tại **không có guard đó**:

- Purchase path: `content-service/src/core/services/ticket.service.ts:639-662` — `reserveStockWithQuota` (Redis) → `registerTicketsWithTx` (dòng 656) → `finalizeStock` (dòng 664). Tx DB `registerTicketsWithTx` (`content-service/src/infrastructure/driven-adapters/persistence/postgres/ticket.repository.adapter.ts:250-287`) increment `sold` **không điều kiện** (dòng 258-261), không re-check `quantity`.
- Guard duy nhất là LUA Redis `LUA_RESERVE_WITH_DYNAMIC_QUOTA_SCRIPT` (`content-service/src/config/redis/cache.service.ts:185-245`, check `available = total - sold - reserved` dòng 221-229) — tức **chính cái mirror mà DESIGN thừa nhận có thể stale**.

Chuỗi khai thác: mint tx commit (DB `sold` tăng) → `initStock` refresh fail (DESIGN tự thừa nhận kịch bản, chỉ log + alert) → Redis `sold` cũ thấp hơn DB → LUA reserve thấy `available` ảo → purchase qua → `registerTicketsWithTx` không chặn → **vé thật vượt quota**. Conditional UPDATE của D-M1 chỉ bảo vệ mint-vs-mint, không phủ purchase-vs-mint. **Yêu cầu: thêm conditional UPDATE `sold + qty <= quantity` vào `registerTicketsWithTx` (hoặc purchase tx tương đương) trước khi bật EAGER/LAZY mode.** Điều kiện khai thác: initStock fail + purchase trong cửa sổ stale (không cần attacker chủ động — tự xảy ra khi bật chế độ mới).

### VB1-2. [ALIVE — Medium] `initStock` ghi đè `reserved: 0` phá reservation đang sống

`cache.service.ts:259-267`: `hmset` set `reserved: 0` vô điều kiện. DESIGN gọi `initStock` sau mỗi mint commit. Nếu cùng lúc có purchase reservation đang giữ `reserved > 0` (TTL 60s theo `ticket.service.ts:643`), refresh sẽ **xóa counter reserved của user khác** → `available` ảo tăng → LUA reserve cho phép vượt (kết hợp VB1-1 thành over-mint không cần stale-fail). Khuyến nghị: refresh chỉ cập nhật `total/sold/maxQuota`, giữ `reserved` nguyên (`HSET` từng field, không `hmset` cả hash).

### VB1-3. [ALIVE — High, điều kiện INTERNAL_SERVICE_TOKEN lộ] preTicketId giả → vé mồ côi không truy nguồn + không per-recipient cap

D-M2 (`Ticket.preTicketId @unique`) hóa giải **double-mint** (idempotency at-most-1 OK) nhưng content **không validate preTicketId tồn tại** trong bảng PreTicket của ticket-mayo (mint là nguồn tạo Ticket — preTicketId do caller sinh, DESIGN §2.2 chỉ ràng buộc format). Service-token holder (xuất phát từ blocker #2 của doc này) gửi 1000 UUID ngẫu nhiên, mỗi UUID 1 vé mới: quota tiêu, vé mồ côi không audit-trail, **không per-recipient cap** (một emailHash nhận không giới hạn qua N request). Tương tự `userId` optional trong DTO §2.2: mint có thể gán vé thẳng userId bất kỳ + emailHash bất kỳ. Khuyến nghị: (a) content duyệt danh sách preTicketId gegen một bảng xác nhận do ticket-mayo ký (HMAC) hoặc (b) tối thiểu per-recipient cap + alert khi mint vào emailHash chưa từng distribution. Điều kiện: token lộ — nhưng đó chính là rủi ro blocker đang mở, nên defense-in-depth bắt buộc.

### VB1-4. [ALIVE — Medium] link-by-email scope mọi event: cross-event contamination + info disclosure ticketIds

D-L1: single UPDATE `WHERE recipientEmailHash = :emailHash AND userId IS NULL` **không lọc eventId**. Hệ quả: (1) nếu người dùng có vé unlinked từ event A (được mint riêng) và admin chạy link cho distribution event B, **vé event A cũng bị gán** — user nhận vé ngoài ý muốn distribution, nghiệm thu theo distribution sai; (2) response `{linked: N, ticketIds: [...]}` trả ticketIds mọi event cho holder token → inventory enumeration nội bộ khi token lộ. Khuyến nghị: thêm `eventId` bắt buộc vào contract C-2, WHERE thêm `AND eventId = :eventId`, response chỉ trả count + ticketIds trong scope event.

### VB1-5. [ALIVE — Medium, doc-conflict] UI-P5 backfill HTTP endpoints mâu thuẫn trực tiếp DESIGN §12 trade-off #9

UI-SPEC UI-P5 định nghĩa `GET /admin/backfill/dry-run` + `POST /admin/backfill/run`. DESIGN §12 trade-off #9 **Từ chối: "Backfill qua HTTP admin API"**. Hoặc UI xây tính năng chết, hoặc backend thêm 2 endpoint admin nặng toàn bảng chưa qua threat model (scan toàn Ticket + PreTicket, dry-run đọc hàng trăm nghìn row — DoS bằng admin token nếu không pagination). Hai doc phải chốt 1 phương án trước khi implement; nếu giữ HTTP: bắt buộc pagination + job async + audit log.

### VB1-6. [DEAD — đã hóa giải bởi Backend] Conditional UPDATE chống over-mint mint-vs-mint

Kịch bản tôi đặt ra ban đầu đều được D-M1/§2.4 hóa giải: (a) 2 batch song song cùng ticketType → row-level atomic, 1 commit 1 nhận 0-row → 409; (b) 2 ticketType khác nhau song song → guard độc lập từng row, không tương tác; (c) N lớn lock timeout → Postgres rollback tx nguyên tử, retry từ đầu an toàn; (d) 0-row → rollback sạch + 409 đúng thiết kế. Finding F-01 đóng đúng cho mint path. (Purchase path còn hở — VB1-1, không phải lỗi của conditional UPDATE.)

### VB1-7. [DEAD — không phải finding an ninh] sessionStorage syncPending heuristic (UI-SPEC §6.1, dòng 521)

UX đã tự rút gọn thành heuristic boolean-only. Grep `frontend/src` hiện tại: sessionStorage chỉ dùng cho DistributionDraft admin (`frontend/src/admin/DistributionDraftContext.tsx:26,42,55`). Flag proposed không chứa email/PII, worst-case = copy "đang đồng bộ" hiện oan vài chục giây. Privacy: negligible. Chỉ lưu ý implement: flag phải là boolean, không đút email vào sessionStorage.

### VB1-8. [DEAD về lộ vé — residual Low] Claim-link landing không lộ vé cho người cầm link không phải chủ email

Nhánh (a) "XEM VÉ NGAY" của UI-SPEC §5.1 chỉ kích hoạt khi server trả `{ok:true}`, và `{ok:true}` chỉ sau emailHash match với session đã login (`ticket-mayo/src/modules/claim/claim.service.ts:42-48` đã verify ở §3). Người cầm link nhưng không có tài khoản đăng nhập đúng email → needsAuth → từ chối. EAGER không thay đổi điều này (vé chỉ xem qua API có auth). Residual Low: (1) claimToken = bearer capability — forward link = forward quyền claim (chỉ có hại nếu người nhận có tài khoản trùng email, hiếm); (2) status oracle — response khác nhau token hợp lệ/hết hạn cho phép dò tính hợp lệ token. Không chặn ship.

### VB1-9. [DEAD phần content — ALIVE phần ticket-mayo] Cap batch DTO

DESIGN §2.2 CÓ `@ArrayMaxSize(1000)` + `@ValidateNested({each:true})` + `@IsHex() @Length(64,64)` cho emailHash → checklist mục 5 của doc này THỎA cho DTO content mới. Phần còn thiếu là `ticket-mayo/src/modules/distribution/dtos/distribute-request.dto.ts:16-18` (recipients chỉ `@IsEmail`, không ArrayMaxSize; quantity chỉ `@Min(1)`) — đã nằm trong F-06 mà DESIGN §11 chấp nhận remediation, chỉ cần giữ thứ tự implement trước khi mở admin UI.

### Tổng kết vòng 1

| # | Finding | Trạng thái | Severity |
|---|---------|-----------|----------|
| VB1-1 | Purchase tx không có DB quota guard — claim §9.2 sai | ALIVE | High |
| VB1-2 | initStock hmset reserved:0 phá reservation sống | ALIVE | Medium |
| VB1-3 | preTicketId giả / không per-recipient cap / userId arbitrary | ALIVE | High (đk token lộ) |
| VB1-4 | link-by-email không scope eventId + trả ticketIds mọi event | ALIVE | Medium |
| VB1-5 | UI-P5 backfill HTTP mâu thuẫn DESIGN trade-off #9 | ALIVE | Medium (doc-conflict) |
| VB1-6 | Over-mint mint-vs-mint qua conditional UPDATE | DEAD | — |
| VB1-7 | sessionStorage syncPending | DEAD | — |
| VB1-8 | Lộ vé qua claim-link cho người cầm link | DEAD (residual Low) | — |
| VB1-9 | Cap batch DTO | DEAD content / ALIVE ticket-mayo (đã trong F-06) | — |

---

## Vòng phản biện 2 — Phán quyết

*Đối tượng: "## Vòng phản biện 1" trong `docs/DESIGN-ticket-email-mint-sync.md` (dòng 691-763). Verdict: [CONFIRMED] / [WITHDRAWN] / [DEFERRED].*

### VB1-1 — Purchase path không quota-guard DB + Redis stale → **[CONFIRMED]**

Re-seed absolute BẮT BUỘC post-commit (RB-4a) là nâng cấp đúng nhưng **chưa đủ làm tầng độc lập**:

1. **TOCTOU còn lại**: re-seed chạy *sau* mint commit. Trong cửa sổ commit→re-seed, một purchase reserve dựa trên Redis `sold` cũ → LUA cho qua → `registerTicketsWithTx` (ticket.repository.adapter.ts:257-261) increment vô điều kiện → vượt quota thật.
2. **Re-seed fail = stale vĩnh viễn**: key `ticket_stock:{id}` không TTL (cache.service.ts:261-266, `hmset` không `EX`) — đã verify. Nếu re-seed lỗi (Redis down đúng lúc), stale kéo dài đến lúc restart; "BẮT BUỘC" phải được định nghĩa operatively: mint path alert + retry backoff, không âm thầm bỏ.

**Nghiệm thu**: thêm conditional UPDATE `sold + qty <= quantity` vào `registerTicketsWithTx` (đối xứng D-M1, 0-row → throw → rollback tx + releaseStock) — **điều kiện enable DISTRIBUTION_MINT_MODE=EAGER**. LAZY ship trước được với chỉ re-seed (mint LAZY đã có guard riêng). Scope: purchase là code cũ, nhưng drift vector do feature này tạo ra (EAGER bulk mint) → gắn gate EAGER là thỏa đúng scope.

### VB1-2 — initStock ghi đè `reserved: 0` → **[CONFIRMED]**

Đã đọc lại `cache.service.ts:259-267`: `hmset` set cả 4 field, `reserved: 0` vô điều kiện. Đề xuất re-seed absolute của Backend gọi đúng `initStock(ttId, quantity, soldMới, maxQuota)` → **vẫn xóa reservation đang sống** (DB không mirror in-flight reserved, nên "absolute từ DB" không cứu được). Purchase reservation TTL 60s (ticket.service.ts:643) — re-seed giữa TTL làm `available` ảo tăng đúng lượng reserved bị xóa.

**Nghiệm thu**: re-seed đổi sang `HSET` per-field `total/sold/maxQuota`, KHÔNG đụng `reserved` (tự hết hạn theo TTL). Test bắt buộc: reservation sống (reserved>0) tồn tại nguyên vẹn qua 1 lần mint re-seed.

### VB1-3 — preTicketId giả / userId arbitrary / không per-recipient cap → **[CONFIRMED — không cần round-trip]**

Đề xuất của Backend (de-dup đầu handler + bắt P2002, mục TM-1 dòng 699) chỉ đóng **double-mint** — preTicketId *giả* là id mới, unique-constraint không chặn, vẫn mint ra vé mồ côi. Không đòi validate tồn tại (round-trip content→ticket-mayo đảo dependency + thêm availability coupling). Giải pháp stateless: **preTicketId có chữ ký** — ticket-mayo gửi kèm `sig = HMAC-SHA256(preTicketId || emailHash || userId?, MINT_SIGNING_KEY)`, key sinh riêng ≠ INTERNAL_SERVICE_TOKEN; content verify trước khi vào tx.

- Fabrication chết (không có key không tạo cặp (id,sig) hợp lệ); tamper userId/emailHash chết (signature phủ payload); replay cùng preTicketId → idempotency đã có (D-M2).
- Nghiệm thu: mint API từ chối thiếu sig/sig sai (test T3 bổ sung); MINT_SIGNING_KEY trong checklist secrets riêng, không reuse service token.

### VB1-4 — link-by-email scope mọi event + ticketIds → **[WITHDRAWN]**

UX-REB-01 xác nhận scope mọi event là **đúng product**: link-by-email chạy theo user-sync ("nhận lại MỌI vé của email mình"), không theo distribution — "cross-event contamination" của tôi chính là semantics chủ đích. TicketIds chỉ nội bộ ticket-mayo (đếm banner), không forward thẳng frontend. Điều kiện duy nhất (doc-note, không code): contract C-2 ghi rõ scope mọi event là chủ đích + ticketIds chỉ dùng server-side.

### VB1-5 — UI-P5 backfill HTTP vs CLI → **[WITHDRAWN — chốt theo Backend]**

Đồng ý chốt: **CLI canonical + GET dry-run + UI report-import**. Lý do Backend đúng (long-running, node client timeout 15s — content-client.service.ts, không progress bền, mất log CLI). Mâu thuẫn doc-doc đã hóa giải. Điều kiện ràng phần dry-run còn sống: read-only + cap/pagination số row quét (chống admin-token DoS quét toàn bảng Ticket+PreTicket).

### TM-1 (idempotency) — phần Backend chấp nhận → **[CONFIRMED — đủ]**

`@unique` DB + de-dup đầu handler + P2002→catch→re-find→alreadyMinted đóng cả 2 khe (trùng trong batch, đua chặng song song). Đủ. Nghiệm thu: 2 case này nằm trong contract test T3.

### TM-5 (double vé qua key mới + cùng emailHash) → **[CONFIRMED — chấp nhận warning, không block]**

Backend đúng: block cứng phá use-case phát lại hợp lệ (job trước FAILED rõ ràng) + multi-ticket cố ý (TM-4 cho quantity ≤10/recipient). Warning là mức đúng. Điều kiện: warning hiển thị ở màn submit (UI) + ghi audit log; nếu ops quan sát duplicate thật → nâng hard-block ở release sau (không phải scope này).

### TM-6 (plaintext email Kafka) → **[CONFIRMED — DEFERRED có điều kiện]**

Đồng ý ra scope merge (hiện trạng LAZY, không phải surface mới) VỚI 2 điều kiện: (a) debt có tracking: owner + deadline, không phải "ghi nhớ"; (b) làm NGAY phần rẻ trong release này: kiểm tra/chặn ACL Kafka topic chỉ cho consumer của mail-dispatcher — payload đang chứa plaintext email + claimToken (kafka-producer.adapter.ts:70-75); nếu topic open trong cluster, đó là rủi ro hiện tại, không phải tương lai.

### Ghi nhận phản bác ngược của Backend

- **TRB-1 (CORS)**: CHẤP NHẬN — CORS là browser-control, không phải mitigation cho mint/link service-to-service. §5.9 của doc này hạ xuống hygiene.
- **TRB-2 (sequence)**: CHẤP NHẬN — `nextval` không row-lock chéo event; mô tả cơ chế của tôi sai, kết luận (rate-limit nội bộ) giữ nguyên.

### Bảng phán quyết vòng 2

| Finding | Verdict | Ghi chú |
|---|---|---|
| VB1-1 purchase quota-guard | CONFIRMED | Re-seed cần nhưng chưa đủ; conditional UPDATE = gate enable EAGER |
| VB1-2 reserved bị xóa | CONFIRMED | Re-seed HSET per-field, không hmset cả hash |
| VB1-3 preTicketId giả | CONFIRMED | HMAC sig (preTicketId+emailHash+userId), không round-trip |
| VB1-4 scope mọi event | WITHDRAWN | Semantics đúng product (UX-REB-01); doc-note contract |
| VB1-5 backfill HTTP | WITHDRAWN | Chốt CLI canonical + dry-run (có cap) + report-import |
| TM-1 idempotency | CONFIRMED (đã đủ) | Nghiệm thu = 2 case trong T3 |
| TM-5 double vé | CONFIRMED (warning) | UI surface + audit; hard-block chỉ nếu ops thấy duplicate |
| TM-6 Kafka email | CONFIRMED (DEFERRED) | Debt tracking + ACL topic làm ngay |

---

## Vòng phản biện 3 — Final position

*Đối tượng: "## Vòng phản biện 2" trong DESIGN doc (dòng 767-805). Chỉ 2 xung đột chưa khép.*

### VB1-1 — Final: WITHDRAWN sửa purchase tx; DUY TRÌ gate enable EAGER bằng phương án thay thế (3 điều kiện)

**(a) "Re-seed fail = stale vĩnh viễn" đã hóa giải chưa? — KHÔNG.** Δ1 (DESIGN:789) chỉ mô tả happy path (`HMSET sold` + fallback key chưa tồn tại) — không một chữ về refresh THẤT BẠI: không retry, không alert spec, không self-healing. VB2-C.1 (DESIGN:802) ký nhận cửa sổ <1s tức giả định refresh thành công. Đã verify: key `ticket_stock:{id}` không TTL (cache.service.ts:261-266) → một refresh fail = stale đến khi restart content-service. "BẮT BUỘC" (RB-4a, DESIGN:741) vẫn chưa có định nghĩa operative. Lưu ý: gate CLOSED không dùng được làm fail-closed thủ công — LUA tự reopen khi available ≥ threshold (cache.service.ts:206-213), mà stale chiều available ảo CAO.

**(b) Phương án thay thế được chấp nhận làm gate EAGER** khi đủ cả 3 (tối thiểu không thỏa xuống được):

1. **refreshSoldFromDb = retry + alert CRITICAL**: fail → backoff ≥3 lần → vẫn fail → alert đến channel ops có pager (không chỉ log). T3-M5: kill Redis giữa mint run → CRITICAL kích hoạt, job kết thúc lỗi rõ ràng.
2. **Verify-trước-khi-mở-gate là bước script T7 bắt buộc**: sau mỗi mint run, đối chiếu `HGET sold` == `SELECT sold` cho mọi ticketType vừa mint; lệch → exit-code != 0. Trình tự canonical: mint → verify → mở gate. T3-M6: làm lệch 1 vé → exit != 0.
3. **Mirror-check trong reconciliation cadence ≤15 phút** (Δ9 đang là 24h — quá thưa cho oversell): HGET sold vs DB sold lệch → CRITICAL. T3-M7.

Đủ vì: điều kiện 2 đóng cửa "mint-then-open"; 1+3 thu "mint-khi-đã-mở" xuống ≤15 phút + pager. Rủi ro còn lại ký vào VB2-C. Conditional UPDATE purchase tx = mục tiêu dài hạn F-01 debt.

### VB1-3 — Final: DEFERRED (HMAC → Q4 human review) + CONFIRMED compensating event-driven

**Luận cứ HMAC đưa Q4:** (1) MINT_SIGNING_KEY không bao giờ trên wire — token nằm trong header mọi request (surface: request log, proxy); key chỉ tồn tại 2 phía sign/verify. Threat mà HMAC là tầng duy nhất chặn: token lộ qua màng không-env → kẻ có token gọi mint được nhưng không tạo cặp (preTicketId, sig) hợp lệ. (2) Reconciliation 24h trễ: 10.000 vé mồ côi (10 chunk × 1000) trong 1 đêm, quota chết, phát hiện muộn không hoàn được. (3) Bác "rotation lệch": key không trên wire → nhu cầu rotation thấp; mô hình trùng FIELD_ENCRYPTION_PEPPER đã có.

**Lý do tự rút CONFIRMED:** team đang nợ secrets-sync pre-flight — thêm key thứ 2 trước khi vận hành nổi key thứ nhất = control không vận hành được; kịch bản token-lộ-không-env xác suất thấp hơn các blocker đang mở; Backend cùng lúc phải implement 3 điều kiện VB1-1.

**Điều kiện thay thế bắt buộc trong scope:** giảm gap 24h → event-driven — **sau mỗi mint run, ticket-mayo tự đối chiếu preTicketId đã gửi vs ticketIds response trả về** (so khớp trong RAM, chi phí ~0); lệch → PARTIALLY_MINTED + alert ngay. T3-M8. Cron Δ9 giữ làm lưới cuối.

### Bảng final vòng 3

| Finding | Verdict | Điều kiện nghiệm thu tối thiểu |
|---|---|---|
| VB1-1 | WITHDRAWN sửa purchase tx / CONFIRMED gate EAGER (thay thế) | T3-M5 retry+alert CRITICAL; T3-M6 verify-script exit-code; T3-M7 mirror-check ≤15 phút |
| VB1-3 | DEFERRED → Q4 (HMAC) | T3-M8 post-mint self-verify mỗi run + alert ngay |
