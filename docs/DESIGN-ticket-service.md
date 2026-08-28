# DESIGN: Ticket Service (ticket-mayo)

**Status**: Draft v3 — PIVOT 2026-08-25 sang SELF-CONTAINED (supersede v2)
**Author**: Backend Architect
**Last Updated**: 2026-08-25
**Source PRD**: `c:\MAYogu_VIASG\chat-app\docs\PRD-ticket-email-distribution.md` v1.0
**Repo target**: `c:\MAYogu_VIASG\ticket-mayo`

> **PIVOT 2026-08-25 (QUAN TRỌNG — supersede phần lớn v2):** Design v2 định *delegate auth cho gateway-auth* + *tích hợp content-service* (Ticket/TicketType/Event/check-in/QR/stats ở content-service). **PROVEN UNVIABLE** qua việc đọc code thật: gateway-auth `/auth/register/complete` (auth-register.service.ts:272-291) bắt buộc **email OTP + SMS OTP + SĐT Việt Nam** (`isValidVNPhone`), và `/auth/login` (auth-login.service.ts:75-81) gọi `user-community.checkUser` → người nhận vé chỉ có email **KHÔNG THỂ** thành user-community user → register + login đều fail. Quyết định LOCKED: **ticket-mayo TỰ CHỨA hoàn toàn** — tự sở hữu PortalUser(email+password, bcrypt, JWT HS256/JWT_SECRET), Event, TicketType, Ticket(qrPayload, checkedInAt, checkedInGateId), check-in, Distribution, PreTicket, Stats. KHÔNG dùng gateway-auth/user-community/content-service. Các section §5.5 (auth delegate), §3 (schema chỉ PreTicket/Distribution), §1.3/§5 (content-service source-of-truth), Phụ lục A bị supersede. Email binding vẫn dùng `generateEmailHash`=HMAC-SHA256(FIELD_ENCRYPTION_PEPPER, email.toLowerCase().trim()) (giữ nguyên, đã verify khớp user-community). Xem memory `project_ticket_mayo.md`.

---

> Ghi chú phương pháp: Design doc này dựa trên đọc code thật từ 5 service liên quan (content-service, user-community-service, gateway-auth-service, noti-analytics-service, chat-app). **content-service là source-of-truth cho Ticket/TicketType/Event/check-in/QR/scanner/stats** (đã verify code — xem §1.3 + Phụ lục A). ticket-mayo CHỈ là lớp **phát vé qua email + user portal + admin analytics dashboard**, gọi API nội bộ content-service. chat-app chỉ là reference cho stack (React + Vite) — KHÔNG phải target repo. Mọi tham chiếu đều kèm file/dòng cụ thể làm bằng chứng. KHÔNG viết code implementation — chỉ thiết kế.

---

## 1. Overview & Mục tiêu

### 1.1. Bài toán

Admin cần một web tool để "phát vé (voucher) qua email": nhập/paste/import một **danh sách email** người nhận (các email này **CÓ THỂ CHƯA TỒN TẠI** trong app — chưa phải user), chọn loại vé + số lượng vé, hệ thống gửi email cho từng người trong list. Khi một người **tạo tài khoản** trên ticket-mayo portal bằng đúng email đã nhận vé → portal hiển thị vé + QR tự động (không cần nhập mã). Check-in (quét QR) diễn ra ở content-service scanner (mobile app `mobile-app/.../scan_ticket/`) — KHÔNG qua ticket-mayo.

Khái niệm "select all / individual / quantity" từ PRD gốc được hiểu lại theo flow mới: admin paste 1 list email → chọn loại vé (lấy từ content-service) → chọn số lượng (mỗi email hoặc tổng) → gửi cho cả list. "All" = gửi cho toàn bộ email trong list đã nhập (KHÔNG phải "tất cả user đã có trong app").

### 1.2. ticket-mayo giải bài toán gì

ticket-mayo là app **FULL-STACK tự chứa** trong repo `ticket-mayo` (KHÔNG đụng `chat-app`). Nó KHÔNG tự có Ticket/TicketType/Event/check-in/QR/scanner — toàn bộ domain đó thuộc **content-service** (đã verify code, xem §1.3). ticket-mayo CHỈ đảm nhận 3 trách nhiệm:

- **(A) Lớp phát vé qua email (Distribution)**:
  - Admin import/paste list email → chọn `ticketTypeId` (tham chiếu content-service `TicketType`) + số lượng → ticket-mayo tạo **PreTicket** (email-bound, chưa có `userId` vì content-service `Ticket.userId` BẮT BUỘC — `schema.prisma:487`) + **DistributionJob** (batch idempotent).
  - ticket-mayo emit Kafka `notification.send-ticket` → noti-analytics gửi mail chứa **claim link** (KHÔNG phải QR — QR chỉ có sau khi user signup và content-service tạo Ticket thật).
- **(B) User portal "vé của tôi"**:
  - User signup/login bằng email (gọi `gateway-auth /auth/register` + `/auth/login`) → JWT → gọi `GET /tickets/me`.
  - ticket-mayo detect PreTicket chưa claim (query `recipientEmailHash` từ email trong JWT) → resolve `userId` (qua `POST /user-community/users/lookup-by-emails`) → gọi content-service tạo **Ticket thật** (POST, có `userId`) → lưu `contentServiceTicketId` vào PreTicket (mark claimed).
  - User portal hiển thị vé + QR (lấy `ticketCode` + signed QR token từ content-service `GET /tickets/:id/qr` hoặc `GET /tickets/my-tickets`).
  - Trạng thái check-in (VALID/USED/CANCELLED) lấy từ content-service (proxy, KHÔNG tự lưu).
- **(C) Admin analytics dashboard**:
  - **Distribution stats** (từ ticket-mayo DB): email đã gửi, delivered, claimed (đã signup nhận vé thật), unclaimed, bounce/fail, theo `TicketType`/`DistributionJob`.
  - **Attendance / check-in stats** (từ content-service): vé đã phát (VALID), đã check-in (USED / `checkedInAt` not null), tỷ lệ đi đến, theo Event/TicketType/gate. ticket-mayo proxy/gọi content-service stats endpoints.

ticket-mayo **gọi API nội bộ content-service** (REST + `x-service-token`):
1. (Quyết định 1) KHÔNG tự có Ticket/TicketType/Event/check-in/QR/scanner/stats — source-of-truth ở content-service.
2. (Quyết định 2) Bridge "email-chưa-là-user" qua PreTicket + claim link + lazy resolve lúc `/tickets/me` (xem §5.2).
3. (Quyết định 3) Module Analytics tổng hợp distribution (ticket-mayo) + attendance (content-service).

ticket-mayo KHÔNG tự implement auth user portal, KHÔNG tạo bảng User riêng (delegated sang gateway-auth + user-community).

### 1.3. Ranh giới (KHÔNG làm gì — content-service đã có)

content-service ĐÃ CÓ SẴN toàn bộ domain ticket + check-in (đã verify code thật):

| Domain | Ai làm (source-of-truth) | Bằng chứng code content-service |
|--------|--------------------------|--------------------------------|
| `Event` (organizerId, communityId, title, startTime/endTime, address, city, maxParticipants, status, signing keys, offlineCheckInEnabled, checkInSnapshotVersion) | content-service | `content-service/prisma/schema.prisma:281-340` |
| `TicketType` (eventId, name, typeCode, price, quantity, sold, maxTicketsPerUser, saleStartsAt/EndsAt, qrForegroundColor/BackgroundColor) | content-service | `content-service/prisma/schema.prisma:603-625` |
| `Ticket` (`ticketTypeId`, `userId` **BẮT BUỘC không nullable**, `ticketCode @unique`, `status` "VALID"\|"USED"\|"CANCELLED", `purchasePrice`, `checkedInAt`, `checkedInBy`, `checkedInGateId`, `totpSecret`, `checkedInDeviceEventId`, `seatLabel`) | content-service | `content-service/prisma/schema.prisma:484-514` |
| `Gate` (eventId, name), `CheckinAssignment` (gateId, userId, eventId), `Seat` | content-service | `content-service/prisma/schema.prisma:516-650` |
| `OfflineCheckinRequest` (idempotency table offline sync) | content-service | `content-service/prisma/schema.prisma:543-555` |
| Online check-in (verify QR Ed25519, first-wins atomic UPDATE VALID→USED, bump snapshotVersion, Redis counters + timeline) | content-service | `content-service/src/core/services/checkin.service.ts:42-237` |
| Offline check-in sync (batch idempotent first-wins, version/snapshot/delta endpoints) | content-service | `content-service/src/core/services/offline-checkin.service.ts`; controllers `offline-checkin.controller.ts`, `offline-checkin-snapshot.controller.ts` |
| Ed25519 signed-QR (JWS compact EdDSA, per-event keypair, envelope-encrypted private key với `TICKET_SIGNING_MASTER_KEY`) | content-service | `content-service/src/core/helper/signing-key.helper.ts` |
| Tạo Ticket (register, reserve, finalize, queue), `GET /tickets/my-tickets`, `GET /tickets/:id/qr` (static/dynamic signed token) | content-service | `content-service/src/core/services/ticket.service.ts`; controller `ticket.controller.ts` |
| Event dashboard stats (`GET /event/my-events/created/dashboard`, `GET /event/:id?includeStats=true`, `GET /event/:id/registration-trend`), `ServiceTokenGuard` cho internal endpoints | content-service | branch `feat/gate-assignments-checkin-stats` — `event.controller.ts:200,318`, `internal.controller.ts:38` (`@UseGuards(ServiceTokenGuard)`) |
| Scanner Flutter (qr_scanner_screen, checkin widgets) | mobile-app | `mobile-app/lib/feature/screens/event/view/scan_ticket/` |
| Pattern "admin distribute by email" (AdminKeyGuard) — đã có ở content-service `GiftController` (dùng cho gift campaign, KHÔNG dùng cho ticket-mayo) | content-service | `content-service/.../gift.controller.ts:49-68` (`POST /gifts/admin/distribute-email`, `AdminKeyGuard`) |

→ **ticket-mayo KHÔNG tự có** bất kỳ domain nào trong bảng trên. Đây là tham chiếu — KHÔNG duplicate. ticket-mayo chỉ lưu `PreTicket` (email-bound pre-registration) + `DistributionJob` (batch) + `DistributionAudit` (audit distribution actions) trong DB riêng của nó.

### 1.4. Nguyên tắc kiến trúc

- **Full-stack self-contained**: ticket-mayo chứa cả backend NestJS + frontend (Vite + React) — 2 portal (admin + user). KHÔNG đụng chat-app.
- **Source-of-truth tách bạch**: Ticket/TicketType/Event/check-in/QR/scanner/stats = content-service. ticket-mayo = distribution + portal + analytics aggregate. KHÔNG duplicate Ticket/TicketType schema.
- **PreTicket bridge cho email-chưa-là-user**: content-service `Ticket.userId` BẮT BUỘC → ticket-mayo KHÔNG tạo Ticket thật ngay khi admin phát (chưa có userId). Lưu PreTicket (email-bound, `recipientEmailHash` HMAC) → khi user signup bằng đúng email → lazy resolve → tạo content-service Ticket thật (xem §5.2).
- **Auth delegated**: user portal signup/login qua gateway-auth (`/auth/register` + `/auth/login`); ticket-mayo KHÔNG tự auth, KHÔNG có bảng User.
- **Email-first binding**: PreTicket bind theo email (HMAC-SHA256 `recipientEmailHash`); khi user signup, `recipientEmailHash` match → resolve userId → tạo content-service Ticket (userId từ user-community `lookup-by-emails`).
- **Service-to-service auth thật**: ticket-mayo → content-service nội bộ PHẢI dùng `x-service-token` (ServiceTokenGuard pattern), KHÔNG trust `x-user-id` header từ client (cảnh báo content-service blockers — §8.5).
- **Event-driven** cho email: ticket-mayo emit Kafka `notification.send-ticket`, noti-analytics consume → giảm coupling, có retry/DLQ sẵn.
- **Idempotency ở batch level**: mỗi đợt phát có `idempotencyKey` + `jobId` — retry/refresh không tạo PreTicket trùng.

---

## 2. Kiến trúc & Vị trí service

### 2.1. Sơ đồ tổng thể

```
┌──────────────────────────────────────────────────────────────┐
│  ticket-mayo/frontend  (Vite + React + TypeScript)            │
│  ┌─────────────────────────┐  ┌────────────────────────────┐ │
│  │  Admin portal            │  │  User portal "vé của tôi"   │ │
│  │  - Import/paste email    │  │  - Signup (email+pwd)       │ │
│  │  - Chọn TicketType       │  │  - Login                     │ │
│  │    (list từ content-svc) │  │  - List vé + QR (từ CS)      │ │
│  │  - Confirm + preview     │  │  - Trạng thái VALID/USED     │ │
│  │  - Distribution progress │  │                              │ │
│  │  - Analytics dashboard   │  │                              │ │
│  │    (dist + attendance)    │  │                              │ │
│  └──────────┬──────────────┘  └──────────┬───────────────────┘ │
└─────────────┼───────────────────────────┼─────────────────────┘
              │                           │
              │  (register/login)         │ (register/login)
              │  → /auth/register,        │ → KHÔNG qua chat-app
              │    /auth/login             │
              ▼                           ▼
       ┌──────────────────────────────────────────────────────────┐
       │          gateway-auth-service (ingress)                │
       │  - POST /auth/register → JWT  (auth-register.service)  │
       │  - POST /auth/login    → JWT  (auth.controller:71)      │
       │  - JwtStrategy verify ACCESS_TOKEN_SECRET               │
       │  - Proxy /ticket-mayo/* → backend (forward x-user-*)    │
       │  - Throttler (3 tầng, Redis)                            │
       └──────┬───────────────────────────┬────────────────────┘
              │                           │ Bearer JWT (forward header
              │                           │  x-user-id, x-user-email)
              │ x-service-token           │
              ▼                           ▼
   ┌────────────────────────┐  ┌──────────────────────────────────┐
   │ user-community-service │  │  ticket-mayo/backend (NestJS)    │
   │ - User (AES-GCM +      │  │  - DistributionJob (batch)         │
   │   emailHash HMAC)      │  │  - PreTicket (email-bound bridge)  │
   │ - POST /users/         │  │  - DistributionAudit (distribution │
   │   lookup-by-emails     │  │    actions only — KHÔNG checkin)    │
   │   (InternalService)    │  │  - GET /tickets/me (lazy claim +    │
   │ - GET /users (Admin)  │  │    proxy content-service)           │
   │   (KHÔNG dùng select   │  │  - Admin analytics (aggregate dist  │
   │   recipient)           │  │    + proxy content-service stats)  │
   └───────────▲───────────┘  │  - Kafka producer                  │
               │              │  - content-service REST client     │
               │              │    (x-service-token, ServiceToken  │
               │              │     Guard pattern)                  │
               │              └──────┬──────────┬──────────────────┘
               │                     │          │ REST nội bộ
               │                     │          │ x-service-token
               │                     │          ▼
               │                     │  ┌──────────────────────────────┐
               │                     │  │ content-service (SOT Ticket)   │
               │                     │  │ - POST tạo Ticket (userId bắt │
               │                     │  │   buộc) — ticket.service        │
               │                     │  │ - GET /tickets/my-tickets      │
               │                     │  │ - GET /tickets/:id/qr (signed) │
               │                     │  │ - checkin.service (online)     │
               │                     │  │ - offline-checkin.service      │
               │                     │  │ - signing-key.helper (Ed25519) │
               │                     │  │ - event.service stats (branch  │
               │                     │  │   gate-assignments-checkin-    │
               │                     │  │   stats): dashboard,           │
               │                     │  │   findOneWithStats, reg-trend  │
               │                     │  └──────────────────────────────┘
               │                     │
               │                     │ Kafka topic notification.send-ticket
               │                     ▼
               │            ┌──────────────────────────────────┐
               │            │  noti-analytics-service            │
               │            │  - TicketMailConsumer              │
               │            │    (reuse OtpConsumer: retry 3+DLQ) │
               │            │  - MailService.sendTicketMail       │
               │            │    (nodemailer SMTP) — claim link   │
               │            │  - KafkaProducerAdapter → DLQ       │
               │            └──────────────────────────────────┘
               │
               └── ticket-mayo gọi (REST nội bộ, x-service-token) — CHỈ lookup-by-emails (best-effort resolve userId, nullable)

  LƯU Ý: KHÔNG đụng chat-app. Tất cả UI (admin + user portal) nằm trong ticket-mayo/frontend.
  Check-in (scanner) nằm ở mobile-app — KHÔNG qua ticket-mayo.
```

### 2.2. Protocol

| Tuyến | Protocol | Bằng chứng code |
|-------|----------|-----------------|
| ticket-mayo frontend (admin + user portal) → gateway-auth (register/login) | REST HTTPS (KHÔNG qua chat-app) | `gateway-auth/.../auth-register.service.ts` (register), `gateway-auth/.../auth.controller.ts:71-86` (`POST /auth/login`) |
| gateway → ticket-mayo backend | REST nội bộ (proxy prefix `/ticket-mayo/`) + forward JWT claim qua header (`x-user-id`, `x-user-email`) | PRD §1.2 #10 (cần thêm route proxy); pattern tương tự gateway → user-community trong `user.repository.adapter.ts` |
| **ticket-mayo → content-service** (TẠO Ticket, đọc QR/my-tickets, stats) | REST nội bộ + header `x-service-token: INTERNAL_SERVICE_TOKEN` (ServiceTokenGuard) | `content-service/.../internal.controller.ts:38` (`@UseGuards(ServiceTokenGuard)` `@ApiSecurity('service-token')`); pattern `x-service-token` ở `checkin.service.ts:270` + `ticket.service.ts:67` |
| ticket-mayo → user-community (lookup-by-emails) | REST nội bộ + header `x-service-token: INTERNAL_SERVICE_TOKEN` (CHỈ cho `lookup-by-emails` — best-effort resolve userId) | `gateway-auth/.../user.repository.adapter.ts:30-38` (pattern `x-service-token`), `user-community/.../user.controller.ts:438` (endpoint `lookup-by-emails` gắn `AccessRole.InternalService`) |
| ticket-mayo → noti-analytics | **Kafka** topic `notification.send-ticket` (producer→consumer) — email chứa **claim link** (KHÔNG phải QR) | `noti-analytics/.../KafkaProducerAdapter.ts`, `noti-analytics/.../otpComsumer.kafka.ts:18` (template consumer) |
| noti-analytics → SMTP | nodemailer transport | `noti-analytics/.../mail.service.ts:10-18` |
| User check-in (scanner) → content-service | REST HTTPS (mobile app) — KHÔNG qua ticket-mayo | `content-service/.../checkin.controller.ts:14` (`POST /tickets/check-in`), `mobile-app/.../scan_ticket/` |

### 2.3. Vai trò data flow

- **content-service là source of truth** cho Ticket/TicketType/Event/check-in/QR/scanner/stats.
- **ticket-mayo là source of truth** cho DistributionJob + PreTicket + DistributionAudit (chỉ distribution actions).
- **user-community** là source of truth cho User (email mã hóa + emailHash).
- ticket-mayo **không duplicate** User hay Ticket — chỉ lưu `PreTicket.recipientEmailHash` (để query khi user đăng nhập) + `PreTicket.contentServiceTicketId` (tham chiếu logic tới content-service Ticket, nullable tới khi claim).
- **Email-first, resolve sau (PreTicket bridge)**: email admin nhập CHƯA là user lúc phát vé → tạo PreTicket (chưa có `contentServiceTicketId`). Khi user signup bằng đúng email → lazy resolve tại `GET /tickets/me` → tạo content-service Ticket (có userId) → lưu `contentServiceTicketId` vào PreTicket (mark claimed). Check-in diễn ra ở content-service scanner (KHÔNG qua ticket-mayo).
- **noti-analytics** là transport cho email — không lưu vé, chỉ gửi mail claim link theo payload Kafka.

---

## 3. Data Model (Prisma schema đề xuất)

> Viết schema Prisma thật cho các model ticket-mayo GIỮ (DistributionJob, PreTicket, DistributionAudit). **BỎ** `Ticket` + `TicketType` + `TicketAudit` (như draft v1) — chuyển thành "tham chiếu content-service" (cite `schema.prisma:281` Event, `:484-514` Ticket, `:603-625` TicketType). KHÔNG duplicate User — chỉ lưu `userId` (nullable) + `recipientEmailHash`.

### 3.1. Schema

```prisma
// ticket-mayo/prisma/schema.prisma

generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL") // DB riêng (xem §12 open question #1)
}

// ─── MVP: batch phát vé qua email ────
// Đổi tên từ TicketDistribution (draft v1) → DistributionJob cho rõ nghĩa "job".
// ticketTypeId là tham chiếu LOGIC tới content-service TicketType.id (KHÔNG FK
// vật lý vì khác DB). KHÔNG duplicate tên/khác metadata của TicketType — fetch
// live qua content-service khi cần (§4.1).
model DistributionJob {
  id                  String        @id @default(uuid())
  jobId               String        @unique // UUID — đây là idempotency key ở batch level (đổi tên từ batchId cho rõ)
  adminId             String        // tham chiếu logic → User.id
  adminName           String?      // snapshot tên admin (tránh join cross-DB)
  ticketTypeId        String        // tham chiếu logic → content-service TicketType.id
  eventId             String        // tham chiếu logic → content-service Event.id (cho analytics filter + attendance proxy)
  recipientMode       String        // "ALL_EMAILS" = gửi cho cả list email admin nhập (MVP); "INDIVIDUAL" = legacy (KHÔNG dùng trong flow mới)
  recipientCount      Int           // = số email trong list (sau dedupe)
  quantityPerEmail    Int           // số vé mỗi email (MVP); v1.1 có thể thêm "TOTAL" mode (chia đều)
  totalPreTickets     Int           // = recipientCount * quantityPerEmail (số PreTicket tạo ra)
  status              DistributionStatus @default(IN_PROGRESS)
  idempotencyKey      String        @unique // client-generated UUID, chống double-click (PRD §5.2)
  recipientSnapshot   Json          // snapshot danh sách {email, emailHash, userId?}[] admin nhập tại thời điểm confirm (userId? = best-effort resolve qua lookup-by-emails; null nếu email chưa là user) (PRD §5.5)
  failedRecipients     Json?        // [{email, reason}] — cập nhật khi consumer DLQ (v1.1 retry)
  createdAt           DateTime      @default(now())
  completedAt         DateTime?

  preTickets          PreTicket[]

  @@index([adminId])
  @@index([eventId])
  @@index([createdAt])
  @@index([status])
}

// ─── MVP: PreTicket — email-bound pre-registration (CỐT LÕI MỚI) ────
// Bridge cho "email-chưa-là-user": content-service Ticket.userId BẮT BUỘC
// (schema.prisma:487) → KHÔNG tạo Ticket thật ngay lúc admin phát. Lưu PreTicket
// (email-bound) → lúc user signup, lazy resolve → tạo content-service Ticket.
model PreTicket {
  id                       String        @id @default(uuid())
  distributionJobId        String       // FK → DistributionJob.id
  recipientEmail           String       // email plaintext người nhận (do admin nhập) — CẨN THẬN (xem §8 PII)
  recipientEmailHash       String       // HMAC-SHA256 blind index, đồng bộ với User.emailHash (§7.3)
  ticketTypeId             String       // tham chiếu logic → content-service TicketType.id (snapshot lúc phát — tránh drift nếu content-service sửa type)
  ticketTypeName           String       // snapshot tên loại (tránh join cross-DB; dùng cho email payload)
  quantity                 Int          // số lượng vé cho email này (thường = DistributionJob.quantityPerEmail; tách ra cho v1.1 "TOTAL" mode)
  // Cơ chế claim: email chứa claim link `GET /claim/:claimToken` (public-ish).
  // Token unguessable (UUID v4 + random 256-bit suffix) + single-use-ish
  // (mark claimedAt sau khi resolve, không reuse — §8.6).
  claimToken               String       @unique // unguessable, single-use-ish (§8.6)
  claimTokenExpiresAt      DateTime?    // nullable: MVP không hết hạn; v1.1 = 90 ngày
  // Trạng thái claim + tham chiếu content-service Ticket thật:
  contentServiceTicketId   String?      // tham chiếu logic → content-service Ticket.id (NULLABLE tới khi claim resolve). UNIQUE để chống 2 PreTicket tạo 2 content-service Ticket trùng.
  claimedAt                DateTime?    // null = chưa claim; set khi lazy resolve thành công
  userId                   String?      // userId (từ user-community lookup) — set khi claim. Tham chiếu logic, KHÔNG FK.
  // Email delivery tracking (idempotent consumer):
  emailSentAt              DateTime?    // null = chưa gửi mail; consumer check để idempotent (§6.2)
  emailDeliveredAt         DateTime?    // v1.1: SMTP webhook / delivery status
  emailBouncedAt           DateTime?    // v1.1: bounce webhook
  emailStatus              EmailStatus  @default(PENDING)
  createdAt                DateTime     @default(now())

  distributionJob          DistributionJob @relation(fields: [distributionJobId], references: [id])

  @@unique([contentServiceTicketId]) //_bucket: 1 PreTicket → 1 content-service Ticket tối đa (chống race tạo trùng khi 2 request lazy-resolve cùng lúc)
  @@index([recipientEmailHash])       // query /tickets/me — index chính (emailHash match)
  @@index([distributionJobId])
  @@index([ticketTypeId])
  @@index([userId])                   // query dự phòng nếu đã claim
  @@index([claimToken])               // query /claim/:token
  @@index([emailStatus])
  @@index([createdAt(sort: Desc)])    // sort list PreTicket theo ngày phát
}

// ─── MVP: Audit log CHO DISTRIBUTION ACTIONS CHỈ ────
// content-service đã có `AuditLog` (schema.prisma:809-825) cho ticket/checkin
// ops (ActionType.CHECK_IN, OFFLINE_CHECKIN_ACCEPTED, v.v. — xem
// checkin.service.ts:204, offline-checkin.service.ts:464). KHÔNG duplicate
// audit cho checkin. ticket-mayo dùng DistributionAudit RIÊNG cho distribution
// actions (admin distribute, claim resolve, email retry) — domain ticket-mayo
// KHÔNG thuộc content-service.
model DistributionAudit {
  id                  String        @id @default(uuid())
  actorId             String        // adminId (distribute) HOẶC userId (claim) HOẶC "SYSTEM" (consumer)
  actionType          String        // "DISTRIBUTION_START" | "DISTRIBUTION_COMPLETE" | "PRETICKET_CLAIMED" | "EMAIL_RETRIED" | "EMAIL_BOUNCED" | ...
  targetType          String        // "DISTRIBUTION_JOB" | "PRETICKET"
  targetId            String        // id của object bị tác động
  metadata            Json?         // snapshot dữ liệu (KHÔNG chứa plaintext email — chỉ emailHash)
  createdAt           DateTime      @default(now())

  @@index([actorId, createdAt])
  @@index([actionType])
  @@index([targetType, targetId])
}

enum EmailStatus {
  PENDING      // MVP — mới tạo, chưa gửi mail
  SENT         // MVP — consumer gửi mail xong
  DELIVERED    // v1.1 — SMTP webhook
  BOUNCED      // v1.1 — bounce webhook
  FAILED       // v1.1 — retry hết
}

enum DistributionStatus {
  IN_PROGRESS          // MVP
  COMPLETED            // MVP
  PARTIALLY_FAILED     // MVP (có PreTicket nhưng email fail)
  CANCELLED            // v1.1
}
```

> **LƯU Ý SO VỚI DRAFT v1**: Đã BỎ `model Ticket` + `model TicketType` + `model TicketAudit` (generic) khỏi ticket-mayo. `Ticket`/`TicketType` giờ là "tham chiếu content-service" — cite `content-service/prisma/schema.prisma:484-514` (Ticket) + `:603-625` (TicketType) + `:281-340` (Event). `TicketDistribution` → `DistributionJob` (đổi tên). THÊM `PreTicket` (cốt lõi mới). `TicketAudit` → `DistributionAudit` (scope thu hẹp: chỉ distribution actions, KHÔNG checkin — checkin audit ở content-service `AuditLog`).

### 3.2. Giải thích quyết định

| Quyết định | Lý do | Bằng chứng |
|------------|-------|------------|
| BỎ `Ticket` + `TicketType` khỏi ticket-mayo | content-service là source-of-truth (Quyết định 1 LOCKED). Duplicate = drift + inconsistency (check-in cập nhật status ở content-service, ticket-mayo không biết) | `content-service/prisma/schema.prisma:484-514, 603-625` |
| THÊM `PreTicket` (email-bound bridge) | content-service `Ticket.userId` BẮT BUỘC (`:487`) → KHÔNG tạo Ticket khi email chưa có user. PreTicket lưu email + claimToken → resolve sau (Quyết định 2 LOCKED) | `content-service/prisma/schema.prisma:487` |
| `PreTicket.recipientEmailHash` là index chính cho `/tickets/me` | Bảo mật + đồng bộ với `User.emailHash` blind index pattern (HMAC-SHA256). Khi user signup, hash email trong JWT → match PreTicket | `user-community/prisma/schema.prisma:20-21` (`emailHash @unique`); §7.3 ✅ VERIFIED |
| `PreTicket.claimToken` unique + single-use-ish | Cơ chế claim link qua email (KHÔNG phải QR — userId chưa có). Token unguessable chống enumerate | §8.6 |
| `PreTicket.contentServiceTicketId` UNIQUE + nullable | Chống race: 2 request lazy-resolve cùng lúc cho cùng PreTicket → unique constraint đảm bảo chỉ 1 content-service Ticket được tạo | `content-service/prisma/schema.prisma:488` (`Ticket.ticketCode @unique` first-wins) |
| `DistributionJob.ticketTypeId` tham chiếu logic (KHÔNG FK) | content-service nằm DB khác (§12 #1). Fetch live qua content-service khi cần (list TicketType cho admin) | §4.1 |
| `DistributionJob.eventId` | Tham chiếu logic → content-service Event.id — cần cho analytics filter + proxy attendance stats theo Event | `content-service/prisma/schema.prisma:281-340` |
| `DistributionAudit` RIÊNG (không reuse content-service `AuditLog`) | content-service `AuditLog` (schema.prisma:809-825) đã audit checkin ops (ActionType.CHECK_IN…). Distribution actions (admin distribute, claim) là domain ticket-mayo, KHÔNG thuộc content-service. Bảng riêng cho query/filter + PII control | `content-service/prisma/schema.prisma:809-825` (AuditLog generic); `checkin.service.ts:204-222` (CHECK_IN audit ở content-service) |
| `recipientEmail` plaintext vẫn lưu ở PreTicket | Cần để gửi email (Kafka payload); nhưng phải mã hóa/che trong audit log (§8.3) | PRD §5.10 PII concern |
| `jobId` + `idempotencyKey` tách biệt | `jobId` = server sinh (group PreTicket); `idempotencyKey` = client sinh (chống double-click). Cả 2 unique | PRD §5.2 + Story 2 AC4 |
| `recipientSnapshot` (Json) | Snapshot list email admin nhập + emailHash + userId? (best-effort resolve). Chống race: email signup sau KHÔNG nhận vé retroactively (PRD §5.5) | PRD §5.5 |

### 3.3. MVP vs v1.1 field mapping

| Field / Model | MVP | v1.1 | Future |
|---------------|-----|------|--------|
| `PreTicket.claimTokenExpiresAt` | nullable (always null — token không hết hạn) | 90 ngày | — |
| `PreTicket.emailDeliveredAt/emailBouncedAt` | nullable (ignore) | webhook SMTP | — |
| `PreTicket.emailStatus` | PENDING/SENT only | DELIVERED/BOUNCED/FAILED | — |
| `DistributionStatus.CANCELLED` | unused | cancel in-progress | — |
| `DistributionAudit` | DISTRIBUTION_START/COMPLETE, PRETICKET_CLAIMED only | EMAIL_RETRIED, EMAIL_BOUNCED events | — |
| `DistributionJob` cancel/retry | unused | retry failed emails (DLQ) | — |
| Analytics attendance (proxy content-service) | basic (count VALID/USED) | filter Event/time/TicketType/gate | trend chart |
| Content-service stats endpoint exact | branch `feat/gate-assignments-checkin-stats` (verify exact field — §12 open) | stabilized | — |

---

## 4. API Design

> Prefix `/ticket-mayo` (gateway proxy). Endpoint admin gắn `@UseAuthGuard()` + `@RoleBaseAccessControl(AccessRole.Admin)`. Endpoint user portal dùng JWT user (gateway forward `x-user-*` header — §5.4 lựa chọn A). Endpoint claim (`GET /claim/:token`) là public-ish (KHÔNG cần JWT — token本身就是 auth factor) nhưng có rate-limit + IP throttle.

### 4.1. Admin endpoints

| # | Method | Path | Role | Phase | Mô tả |
|---|--------|------|------|-------|-------|
| A1 | GET | `/ticket-mayo/admin/ticket-types` | Admin | **MVP** | **List TicketType từ content-service** (proxy read — KHÔNG CRUD ở ticket-mayo). Query `?eventId=` filter. |
| A2 | GET | `/ticket-mayo/admin/ticket-types/:id` | Admin | **MVP** | Chi tiết 1 TicketType (proxy content-service). |
| A3 | POST | `/ticket-mayo/admin/distributions` | Admin | **MVP** | Phát vé (tạo DistributionJob + N PreTicket + Kafka emit mail claim link). |
| A4 | GET | `/ticket-mayo/admin/distributions/:jobId/status` | Admin | **MVP** | Tiến độ đợt phát (sent/claimed/bounced). |
| A5 | GET | `/ticket-mayo/admin/distributions` | Admin | v1.1 | Lịch sử đợt phát (phân trang + filter). |
| A6 | POST | `/ticket-mayo/admin/distributions/:jobId/retry` | Admin | v1.1 | Gửi lại email fail. |
| **A7** | **GET** | **`/ticket-mayo/admin/stats/overview`** | Admin | **MVP** | **Analytics tổng hợp** (distribution + attendance aggregate, filter `?eventId=&from=&to=`). |
| **A8** | **GET** | **`/ticket-mayo/admin/stats/distribution/:jobId`** | Admin | **MVP** | **Distribution detail** (progress: sent/claimed/checked-in theo PreTicket + cross-check content-service). |
| **A9** | **GET** | **`/ticket-mayo/admin/stats/attendance`** | Admin | **MVP** | **Attendance proxy** (gọi content-service stats — vé phát, đã check-in, tỷ lệ đi đến, theo Event/TicketType/gate). Query `?eventId=&from=&to=&groupBy=`. |

> **BỎ** so với draft v1: A1-A5 (CRUD TicketType) — đã chuyển sang proxy content-service (chỉ read list/detail, KHÔNG tạo/sửa/xóa — TicketType CRUD nằm ở content-service admin).

### 4.2. User portal endpoints (user-facing)

| # | Method | Path | Role | Phase | Mô tả |
|---|--------|------|------|-------|-------|
| U1 | GET | `/ticket-mayo/tickets/me` | User (JWT) | **MVP** | Vé của user — PreTicket chưa claim (lazy resolve thành content-service Ticket) + proxy content-service `GET /tickets/my-tickets` cho đã claim. Trả `ticketCode` + QR + trạng thái VALID/USED. |
| U2 | GET | `/ticket-mayo/tickets/:id` | User (JWT) | **MVP** | Chi tiết 1 vé — proxy content-service `GET /tickets/:id/qr` (signed QR token). |
| **U3** | **GET** | **`/ticket-mayo/claim/:claimToken`** | **Public-ish** (token = auth) | **MVP** | **Claim link** (trong email). Nếu user chưa login → redirect gateway-auth login → quay lại claim. Nếu đã login → resolve PreTicket → tạo content-service Ticket → redirect "vé của tôi". |

### 4.3. Payload & Response ước tính (MVP endpoints)

**A1. GET /ticket-mayo/admin/ticket-types?eventId=...** (proxy content-service)
```jsonc
// Response 200 (proxy từ content-service)
{
  "data": [
    { "id": "uuid", "name": "VIP", "price": "0", "quantity": 1000, "sold": 523,
      "maxTicketsPerUser": 4, "eventId": "uuid", "ticketImageFileId": null }
  ]
}
// content-service endpoint thật: ticket-type.controller.ts (list theo eventId)
```

**A3. POST /ticket-mayo/admin/distributions** (endpoint then chốt)
```jsonc
// Request — admin paste/import list email (CÓ THỂ CHƯA là user trong app)
{
  "emails": ["a@b.com", "c@d.com", "..."],   // list email admin nhập/paste
                                              // backend validate format + dedupe (lowercase/trim)
  "ticketTypeId": "uuid",                     // content-service TicketType.id
  "eventId": "uuid",                          // content-service Event.id (cho analytics + attendance proxy)
  "quantityPerEmail": 1,                      // số vé mỗi email (phải > 0, @Max(10))
  "idempotencyKey": "client-uuid"             // client sinh (UUID v4) — chống double-click
}

// Response 202 Accepted (batch tạo, đang xử lý async)
{
  "jobId": "server-uuid",
  "status": "IN_PROGRESS",
  "recipientCount": 15000,                   // = số email hợp lệ sau dedupe
  "totalPreTickets": 15000,                  // = recipientCount * quantityPerEmail
  "ticketTypeId": "uuid",
  "eventId": "uuid",
  "createdAt": "2026-08-25T10:00:00.000Z"
}

// Response 200 (idempotency hit — cùng idempotencyKey đã từng gửi)
{ /* trả lại kết quả job cũ, KHÔNG tạo trùng */ }
```

> Lưu ý: KHÔNG tạo content-service Ticket ở endpoint này (vì chưa có userId). CHỈ tạo DistributionJob + N PreTicket (email-bound) + emit Kafka `notification.send-ticket` (email chứa claim link). Content-service Ticket tạo LUC CLAIM (§5.2).

**A4. GET /ticket-mayo/admin/distributions/:jobId/status**
```jsonc
// Response
{
  "jobId": "uuid",
  "status": "IN_PROGRESS",
  "recipientCount": 15000,
  "totalPreTickets": 15000,
  "emailSentCount": 12345,          // COUNT PreTicket WHERE emailStatus = SENT
  "emailFailedCount": 12,           // COUNT WHERE emailStatus = FAILED/BOUNCED
  "claimedCount": 8700,             // COUNT PreTicket WHERE contentServiceTicketId IS NOT NULL (resolved)
  "unclaimedCount": 6300,           // = total - claimed
  "failedRecipients": [              // v1.1: chỉ trả khi ?includeFailed=true
    { "email": "a@b.com", "reason": "SMTP timeout" }
  ],
  "createdAt": "...",
  "completedAt": null
}
```

**A7. GET /ticket-mayo/admin/stats/overview?eventId=&from=&to=** (Analytics tổng hợp)
```jsonc
// Response 200 — aggregate từ ticket-mayo DB + proxy content-service
{
  "distribution": {                       // từ ticket-mayo DB
    "totalJobs": 42,
    "totalPreTickets": 630000,
    "emailSent": 620000,
    "emailFailed": 1200,
    "claimed": 540000,                    // resolved thành content-service Ticket
    "unclaimed": 90000,
    "byTicketType": [                     // group theo ticketTypeId (snapshot từ DistributionJob)
      { "ticketTypeId": "uuid", "ticketTypeName": "VIP", "count": 100000, "claimed": 85000 }
    ]
  },
  "attendance": {                          // proxy content-service stats (branch gate-assignments-checkin-stats)
    "issued": 540000,                      // vé đã phát (VALID + USED) — từ content-service
    "checkedIn": 421000,                  // USED / checkedInAt != null
    "attendanceRate": 0.78,               // checkedIn / issued
    "byEvent": [                           // nếu KHÔNG có eventId filter
      { "eventId": "uuid", "eventName": "...", "issued": 5000, "checkedIn": 3900 }
    ],
    "byGate": [                            // v1.1
      { "gateId": "uuid", "gateName": "Cổng VIP", "checkedIn": 1200 }
    ]
  },
  "window": { "from": "2026-08-01", "to": "2026-08-25" }
}
```

**A8. GET /ticket-mayo/admin/stats/distribution/:jobId** (Distribution detail)
```jsonc
// Response 200 — per-job progress + cross-check content-service
{
  "job": { "jobId": "uuid", "status": "COMPLETED", "recipientCount": 15000, "totalPreTickets": 15000 },
  "progress": {
    "emailSent": 14988, "emailFailed": 12,
    "claimed": 10200, "unclaimed": 4800,
    "claimedAndCheckedIn": 8100           // PreTicket đã claim VÀ content-service Ticket status = USED
  },
  "failedRecipients": [ ... ]              // ?includeFailed=true
}
```

**A9. GET /ticket-mayo/admin/stats/attendance?eventId=&from=&to=&groupBy=event** (Attendance proxy)
```jsonc
// Response 200 — proxy từ content-service stats endpoints
// (branch feat/gate-assignments-checkin-stats: GET /event/:id?includeStats=true,
//  GET /event/my-events/created/dashboard, GET /event/:id/registration-trend)
{
  "eventId": "uuid",
  "eventName": "...",
  "issued": 5000,                          // COUNT content-service Ticket WHERE ticketType.eventId = ?
  "checkedIn": 3900,                       // COUNT WHERE status = USED
  "cancelled": 100,
  "attendanceRate": 0.78,
  "byTicketType": [
    { "ticketTypeId": "uuid", "name": "VIP", "issued": 1000, "checkedIn": 820 }
  ],
  "byGate": [ ... ],                        // v1.1
  "timeline": [ ... ]                       // v1.1: checkin timeline (content-service Redis zset event:*:checkin:timeline)
}
```

**U1. GET /ticket-mayo/tickets/me** (lazy claim + proxy)
```jsonc
// Header: Authorization: Bearer <JWT>
// Backend parse JWT → lấy email (plaintext) → hash HMAC → query PreTicket WHERE recipientEmailHash = hash(email)

// Backend flow:
// 1. Query PreTicket chưa claim (contentServiceTicketId IS NULL) theo emailHash
// 2. Lazy resolve: gọi user-community lookup-by-emails → resolve userId
//    → gọi content-service POST tạo Ticket (userId) → lưu contentServiceTicketId vào PreTicket (mark claimed)
//    (idempotent: @@unique([contentServiceTicketId]) — nếu 2 request cùng lúc, 1 cái fail unique)
// 3. Proxy content-service GET /tickets/my-tickets → trả QR + status VALID/USED

// Response 200
{
  "data": [
    { "preTicketId": "uuid",                         // id ticket-mayo
      "contentServiceTicketId": "uuid",              // id content-service (null nếu claim fail)
      "ticketCode": "EVT-SE001-0001",                // từ content-service
      "ticketTypeName": "VIP",
      "eventName": "Đại nhạc hội 2026",
      "status": "VALID",                             // VALID/USED/CANCELLED — từ content-service
      "isCheckedIn": false,                          // = (status === 'USED')
      "checkedInAt": null,
      "qrStaticUrl": "data:image/png;base64,...",   // signed QR token (content-service buildStaticToken)
      "eventStartTime": "2026-09-01T09:00:00.000Z",
      "createdAt": "2026-08-25T10:00:00.000Z"
    }
    // ... sort by createdAt DESC
  ],
  "meta": { "total": 3, "page": 1, "limit": 10, "totalPages": 1 }
}

// Response 200 + empty array (user chưa có PreTicket — chưa nhận email vé)
{ "data": [], "meta": { "total": 0, ... } }
```

> Lưu ý auth (KHÔNG phải API của ticket-mayo): ticket-mayo frontend (admin + user portal) gọi `gateway-auth /auth/register` + `/auth/login` để nhận JWT. KHÔNG có endpoint register/login trong ticket-mayo. `emails[]` trong A3 KHÔNG cần lookup user trước — backend best-effort resolve `userId` qua `POST /user-community/users/lookup-by-emails` (nullable) chỉ để ghi vào `recipientSnapshot` snapshot (cho analytics insight "X email đã là user lúc phát").

### 4.4. Quyền (RBAC) — tham chiếu pattern

- Admin endpoints: `@UseAuthGuard()` + `@RoleBaseAccessControl(AccessRole.Admin)` — reuse pattern từ `user-community/.../admin.controller.ts:47-49` và `noti-analytics/.../adminAuth.decorator.ts`.
- App endpoints (`/tickets/me`, `/tickets/:id`): JWT user qua gateway proxy — `AccessRole.Public` ở ticket-mayo (gateway đã verify JWT trước khi forward).
- Claim endpoint (`/claim/:claimToken`): public-ish (token = auth factor) — KHÔNG cần JWT nhưng có IP throttle (§8.5) + token phải unguessable.
- Service-to-service (ticket-mayo → content-service): header `x-service-token: INTERNAL_SERVICE_TOKEN` — pattern `ServiceTokenGuard` từ `content-service/.../internal.controller.ts:38`, và pattern `x-service-token` ở `gateway-auth/.../user.repository.adapter.ts:30-38`. **KHÔNG trust `x-user-id` header từ client** (§8.5 cảnh báo content-service blockers).

---

## 5. Integration (tham chiếu code thật)

### 5.1. ticket-mayo → content-service (TẠO Ticket, đọc QR/my-tickets, stats)

**Mục đích** (Quyết định 1 LOCKED): ticket-mayo gọi content-service nội bộ cho:
1. **Tạo Ticket thật lúc claim** (POST): khi user signup + PreTicket chưa claim → resolve userId → gọi content-service tạo Ticket (có userId bắt buộc). Content-service endpoint `POST /tickets/register` (`ticket.controller.ts:25-40`) hoặc `POST /tickets/reserve` (deprecated, `:76-93`) — chọn `register` (free ticket path, tạo vé ngay). Payload `{ ticketTypeId, quantity }` + header `x-user-id: <userId>` + `x-service-token`. *Caveat: content-service `registerTicket` có gate phone-verified (`ticket.service.ts:521-528`) — nếu user chưa verify SĐT, tạo vé fail. ticket-mayo cần handle lỗi này (preTicket vẫn unclaimed, hint user verify SĐT).*
2. **Đọc vé user** (GET proxy): `GET /tickets/my-tickets` (`ticket.controller.ts:42-61`) — trả danh sách vé + `qrStaticUrl` (signed QR, `ticket.service.ts:728-744`). ticket-mayo proxy endpoint này cho U1 `/tickets/me`.
3. **Đọc QR chi tiết** (GET proxy): `GET /tickets/:id/qr?type=static|dynamic` (`ticket.controller.ts:63-74`) — trả `{ qrDataUrl, expiresIn, type }` (signed token, `ticket.service.ts:753-777`).
4. **Attendance stats** (GET proxy): branch `feat/gate-assignments-checkin-stats` — `GET /event/:id?includeStats=true` (`event.service.findOneWithStats`, `:1076`), `GET /event/my-events/created/dashboard` (`:200`), `GET /event/:id/registration-trend` (`:441`). Internal service-to-service dùng `ServiceTokenGuard` (`internal.controller.ts:38`).

**Bằng chứng code**:
- `content-service/src/core/services/checkin.service.ts` — online check-in (verifyScannedToken Ed25519, first-wins UPDATE VALID→USED, bump snapshotVersion, Redis counters + timeline). **ticket-mayo KHÔNG gọi trực tiếp checkin** — chỉ đọc stats.
- `content-service/src/core/services/offline-checkin.service.ts` — offline sync (version/snapshot/delta, batch first-wins). **ticket-mayo KHÔNG gọi trực tiếp** — scanner mobile-app gọi.
- `content-service/src/core/helper/signing-key.helper.ts` — Ed25519 signed QR (JWS compact EdDSA, per-event keypair, envelope-encrypted private key với `TICKET_SIGNING_MASTER_KEY`). ticket-mayo KHÔNG verify sig — chỉ forward `qrStaticUrl` từ content-service cho user portal.
- `content-service/src/core/services/ticket.service.ts` — `registerTicket` (`:517-555`), `getMyTickets` (`:675-751` — trả `qrStaticUrl` signed), `getQRCode` (`:753-777`), `buildStaticToken`/`buildDynamicToken` (`:783-816`).
- `content-service/.../ticket.controller.ts:25` (`POST /tickets/register`), `:42` (`GET /tickets/my-tickets`), `:63` (`GET /tickets/:id/qr`).
- Pattern service-to-service: `content-service/.../internal.controller.ts:38` (`@UseGuards(ServiceTokenGuard)` `@ApiSecurity('service-token')`); `checkin.service.ts:270` + `ticket.service.ts:67` (header `x-service-token: INTERNAL_SERVICE_TOKEN`).

### 5.2. Bridge claim: signup detect → resolve userId → tạo content-service Ticket (Quyết định 2 LOCKED)

**Cơ chế**: khi user signup bằng đúng email admin phát vé → ticket-mayo detect PreTicket chưa claim → resolve userId → tạo content-service Ticket.

**Lựa chọn cơ chế detect (đỀ XUẤT — chọn LAZY)**:

| Lựa chọn | Cách | Ưu | Nhược |
|----------|------|----|------|
| **(A) Lazy resolve tại `GET /tickets/me`** ✅ ĐỀ XUẤT | Khi user gọi `/tickets/me`, query PreTicket chưa claim theo `recipientEmailHash` → resolve userId qua `POST /user-community/users/lookup-by-emails` → gọi content-service POST tạo Ticket → lưu `contentServiceTicketId` (mark claimed). | Đơn giản, không cần Kafka consumer. User cần xem vé anyway — resolve tại đó. Idempotent: `PreTicket.contentServiceTicketId @@unique` chống race. | Lần đầu `/tickets/me` chậm (gọi content-service tạo Ticket). Có thể bổ sung event-driven v1.1 pre-warm. |
| (B) Event-driven (gateway-auth emit `user-registered` → ticket-mayo consume) | Kafka topic mới, consumer resolve PreTicket + tạo content-service Ticket. | Pre-warm — user thấy vé ngay khi signup. | Phức tạp: topic mới + consumer + retry + DLQ. Race: user signup xong gọi `/tickets/me` ngay có thể TRƯỚC khi consumer xử lý → vé chưa hiện (cần fallback lazy anyway). |

**Chọn (A) Lazy resolve** — đơn giản cho MVP, không cần Kafka consumer mới, không race với user flow. v1.1 có thể thêm (B) để pre-warm (giảm latency lần đầu).

**Flow lazy claim**:
1. User signup/login → gateway-auth issue JWT (email plaintext trong payload — §7.3 ✅).
2. User gọi `GET /ticket-mayo/tickets/me` (Bearer JWT).
3. gateway proxy forward `x-user-email` (plaintext) → ticket-mayo.
4. ticket-mayo `generateBlindIndex(email)` → query `PreTicket WHERE recipientEmailHash = hash AND contentServiceTicketId IS NULL`.
5. Nếu có PreTicket chưa claim:
   a. Gọi `POST /user-community/users/lookup-by-emails` (x-service-token) → resolve `userId`.
   b. Gọi `POST /content-service/tickets/register` (x-service-token + x-user-id) → tạo Ticket thật (userId bắt buộc).
   c. Lưu `contentServiceTicketId` vào PreTicket + set `claimedAt` + `userId` (idempotent: `@@unique([contentServiceTicketId])` — nếu race, 1 cái fail → re-read existing).
6. Proxy content-service `GET /tickets/my-tickets` → trả vé + QR + status.

> **Caveat content-service `registerTicket` gate**: `ticket.service.ts:521-528` yêu cầu user đã verify SĐT (`isPhoneVerified`). Nếu user chưa verify → tạo Ticket fail (`TICKET_PHONE_NOT_VERIFIED`). ticket-mayo handle: PreTicket vẫn unclaimed, trả hint cho user "Vui lòng xác thực SĐT để nhận vé". Có thể v1.1 thêm content-service endpoint internal tạo Ticket bypass phone-gate cho service-to-service (xem §12 open #5).

### 5.3. ticket-mayo → user-community (lookup-by-emails — best-effort resolve userId)

**Mục đích**:
- KHÔNG dùng `GET /user-community/users` để "select ALL users" (flow mới: admin paste/import list email, KHÔNG chọn từ user đã có trong app).
- Khi tạo PreTicket → ticket-mayo gọi `POST /user-community/users/lookup-by-emails` (InternalService) để resolve `email → userId` **best-effort** (lưu vào `recipientSnapshot` cho analytics insight "X email đã là user lúc phát"; nullable nếu chưa — vẫn phát PreTicket + gửi mail).
- Khi lazy claim (§5.2) → gọi lại `lookup-by-emails` để resolve userId cho user vừa signup.

**Bằng chứng code**:
- Endpoint `POST /user-community/users/lookup-by-emails` (InternalService): `user-community/.../user.controller.ts:438-455` — `getUserByEmails(body)` trả `GetUserByEmailsResponseDto[]` = `[{id, email, displayName}]` (`getUserByEmails.dto.ts:13-22`).
- Pattern service-to-service call với `x-service-token`: `gateway-auth/.../user.repository.adapter.ts:30-38` — `INTERNAL_SERVICE_TOKEN` từ env, header `x-service-token`.

> Open question §12 #2: chọn gọi trực tiếp (cùng VPC, x-service-token) hay qua gateway proxy. (Đề xuất: trực tiếp — ít hop, nhanh. Pattern đã có ở `gateway-auth/.../user.repository.adapter.ts`.)

### 5.4. ticket-mayo verify JWT (user portal endpoint `/tickets/me`)

**Mục đích**: User đăng nhập qua gateway-auth → nhận JWT → ticket-mayo user portal gọi `/tickets/me` → ticket-mayo parse JWT lấy email.

**Bằng chứng code**:
- Login endpoint: `gateway-auth/.../auth.controller.ts:71-86` — `POST /auth/login` (email+password) → `LoginResponseDto` (JWT).
- Register endpoint: `gateway-auth/.../auth-register.service.ts` — `POST /auth/register` tạo account ở user-community.
- JWT payload (verify): `gateway-auth/.../jwt.strategy.ts:26-48` — payload có `sub` (userId), `email` (plaintext), `displayName`, `avatar`, `tokenVersion`, `installationId`. Verify qua `ACCESS_TOKEN_SECRET` (HS256).
- `@User('id')` decorator pattern: `noti-analytics/.../user.decorator.ts:4-13`.

**Lựa chọn đã chốt** (auth delegated):

| Lựa chọn | Cách | Trạng thái |
|----------|------|-----------|
| **(A) Gateway proxy + forward header** ✅ ĐÃ CHỐT | Gateway verify JWT, forward `x-user-id` + `x-user-email` header tới ticket-mayo. ticket-mayo không cần `ACCESS_TOKEN_SECRET`. | **Chọn** — không share secret; nhất quán với cách gateway proxy tới user-community. Lưu ý PII: gateway forward email plaintext trong header (cần HTTPS nội bộ + giới hạn VPC). |
| (B) Share `ACCESS_TOKEN_SECRET` | ticket-mayo tự verify JWT (passport-jwt + cùng secret). | KHÔNG chọn — secret chia sẻ nhiều service = tăng mặt tấn công. |

> ✅ §12 #3 RESOLVED — chọn A (gateway proxy + forward header). Còn phụ thuộc §12 #10 (config route `/ticket-mayo/*` ở gateway).

### 5.5. ticket-mayo frontend → gateway-auth (user portal signup/login)

**Mục đích**: User portal "vé của tôi" cần signup/login. ticket-mayo KHÔNG tự implement auth, KHÔNG tạo bảng User — delegated sang gateway-auth.

**Flow** (KHÔNG qua chat-app):
1. User mở ticket-mayo user portal → nhập email + password.
2. Signup: frontend gọi `POST /auth/register` (gateway-auth, `auth-register.service.ts`) → gateway-auth orchestrate tạo account ở user-community.
3. Login: frontend gọi `POST /auth/login` (gateway-auth, `auth.controller.ts:71-86`) → nhận JWT (payload có `email` plaintext — §7.3 ✅).
4. Frontend gọi `GET /ticket-mayo/tickets/me` (Authorization: Bearer JWT) → gateway proxy forward `x-user-email` → ticket-mayo backend `generateBlindIndex(email)` → query `PreTicket.recipientEmailHash` → lazy claim (§5.2) → proxy content-service → trả vé + QR.

**Bằng chứng code**:
- `gateway-auth/.../auth-register.service.ts` (register logic đã có).
- `gateway-auth/.../auth.controller.ts:71-86` (`POST /auth/login`).
- JWT payload email plaintext: §7.3 ✅ RESOLVED.

**Lưu ý**: Frontend config gateway URL qua env `VITE_GATEWAY_AUTH_URL` (KHÔNG hardcode). Admin portal login cũng qua cùng flow `/auth/login` + check `AccessRole.Admin` từ JWT.

### 5.6. Kafka emit `notification.send-ticket` → noti-analytics (email claim link)

**Mục đích**: ticket-mayo emit N message Kafka (mỗi message = 1 PreTicket cần gửi email claim link), noti-analytics consume → gửi mail.

**Bằng chứng code**:
- Producer pattern: `noti-analytics/.../KafkaProducerAdapter.ts` — `send(topic, message)` publish JSON vào Kafka, `clientId: 'notification-service'`, broker từ `KAFKA_BROKER` env. ticket-mayo replicate class này (clientId: `'ticket-service'`).
- Consumer pattern (template cho `TicketMailConsumer` mới): `noti-analytics/.../otpComsumer.kafka.ts:18` — `@EventPattern('notification.send-otp')`, retry 3 (backoff `1000 * attempt` ms), DLQ `mail-dead-letter`, validate email regex, normalize lowercase/trim. `TicketMailConsumer` mới reuse y hệt, chỉ đổi topic + method gọi `sendTicketMail()`.
- MailService pattern: `noti-analytics/.../mail.service.ts:10-18` — transporter `nodemailer.createTransport`. Cần thêm method `sendTicketMail(body)` + template HTML mới (claim link, KHÔNG phải QR — userId chưa có).

**Kafka message format** (ticket-mayo emit — email chứa claim link):
```jsonc
{
  "preTicketId": "uuid",
  "jobId": "uuid",
  "email": "user@example.com",         // plaintext để consumer gửi mail
  "claimToken": "unguessable-token",   // cho link GET /claim/:token
  "claimUrl": "https://ticket-mayo.local/claim/<token>",  // URL frontend resolve
  "ticketTypeName": "VIP",             // snapshot từ DistributionJob (tránh join)
  "eventName": "Đại nhạc hội 2026",     // snapshot (lấy từ content-service lúc admin chọn eventId)
  "language": "VI",                    // default VI (xem §12 #5)
  "issuedAt": "2026-08-25T10:00:00.000Z"
}
// LƯU Ý: KHÔNG có ticketCode/QR trong payload — userId chưa có, content-service Ticket
// chưa tạo. Email chỉ chứa CLAIM LINK. QR chỉ có SAU khi user signup + claim resolve
// (lấy từ content-service GET /tickets/my-tickets tại /tickets/me).
```

### 5.7. Audit log vào pattern đã có

**Mục đích**: Ghi log distribution actions (admin distribute, claim resolve, email retry).

**Bằng chứng code**:
- content-service `AuditLog` (`schema.prisma:809-825`) — generic, đã audit checkin ops (ActionType.CHECK_IN, OFFLINE_CHECKIN_ACCEPTED… — `checkin.service.ts:204`, `offline-checkin.service.ts:464`).
- `History` model generic ở user-community (`schema.prisma:344-354`).

**Lý do dùng `DistributionAudit` RIÊNG trong ticket-mayo** (KHÔNG reuse content-service AuditLog hay user-community History):
1. Cross-DB query chậm/phức tạp (ticket-mayo DB riêng — §12 #1).
2. content-service `AuditLog` không có field structured cho distribution domain (jobId, claimToken, emailHash).
3. PII concern: distribution audit cần kiểm soát chặt email (chỉ emailHash), bảng riêng cho phép enforce ở app layer.
4. KHÔNG duplicate checkin audit — checkin audit ở content-service `AuditLog`, ticket-mayo KHÔNG audit checkin.

---

## 6. Email Flow + Idempotency + Rate-limit + Bulk

### 6.1. Flow end-to-end (admin ấn "Phát vé" + user claim)

```
[Admin UI: "Phát vé" button click]
   │ (frontend generate idempotencyKey UUID, disable button)
   ▼
POST /ticket-mayo/admin/distributions  (idempotencyKey, emails[], ticketTypeId, eventId, quantityPerEmail)
   │
   ▼
[ticket-mayo DistributionService]
   1. Check idempotencyKey unique trong DistributionJob → nếu tồn tại, return old result (idempotent)
   2. Parse `emails[]` → validate email format + normalize (lowercase/trim) + dedupe
      → snapshot list {email, emailHash, userId?}[]:
        - Best-effort: gọi POST /user-community/users/lookup-by-emails để resolve userId cho email nào đã là user (nullable)
        - KHÔNG gọi GET /user-community/users để "select ALL" (flow mới: admin tự paste list)
   3. Tạo DistributionJob record (jobId=UUID, status=IN_PROGRESS, recipientSnapshot=Json, recipientMode="ALL_EMAILS")
   4. Tạo N PreTicket records (createMany batch 1000/transaction — PRD §5.11)
      - recipientEmailHash = HMAC-SHA256(email, FIELD_ENCRYPTION_PEPPER) — cùng key với user-community
      - claimToken = UUID v4 + random 256-bit suffix (unguessable, single-use-ish)
      - contentServiceTicketId = NULL (chưa claim — chưa có userId)
      - userId = resolved từ lookup (nullable — email có thể chưa là user, sẽ resolve lúc claim)
      - emailStatus = PENDING
      - ticketTypeName = snapshot từ content-service TicketType (fetch lúc admin chọn)
   5. Publish N Kafka messages topic notification.send-ticket (rate-limit: 100 msg/s — §6.3)
      - Payload có claimUrl (KHÔNG có QR — userId chưa có)
   6. Ghi DistributionAudit (actionType=DISTRIBUTION_START)
   7. Return 202 + jobId
   │
   ▼
[Kafka: notification.send-ticket]  (N messages)
   │
   ▼
[noti-analytics TicketMailConsumer]  (reuse OtpConsumer pattern)
   - Validate email format + normalize (lowercase/trim)
   - Idempotency consumer: check PreTicket.emailSentAt (qua HTTP callback hoặc DB share — §12 #4)
     → nếu != null → skip (đã gửi)
   - Retry 3 (backoff 1s * attempt)
   - Fail → DLQ mail-dead-letter + update DistributionJob.failedRecipients + PreTicket.emailStatus=FAILED
   - Success → MailService.sendTicketMail() (email chứa CLAIM LINK) + mark PreTicket.emailSentAt + emailStatus=SENT
   │
   ▼
[SMTP]  →  [User Inbox]  (email có claim link, KHÔNG có QR)

────────────────────────────────────────────────────────

[User nhận email → click claim link HOẶC signup rồi /tickets/me]
   │
   ├─ If chưa login → redirect gateway-auth /auth/login → quay lại /claim/:token
   │
   ▼
[ticket-mayo ClaimService (lazy resolve — §5.2 lựa chọn A)]
   1. Query PreTicket WHERE claimToken = :token AND contentServiceTicketId IS NULL
   2. (Hoặc nếu user vào /tickets/me trực tiếp: query theo recipientEmailHash)
   3. Resolve userId: POST /user-community/users/lookup-by-emails (x-service-token) → userId
   4. Tạo content-service Ticket: POST /content-service/tickets/register
      (x-service-token + x-user-id: <userId>, body { ticketTypeId, quantity })
      → content-service registerTicket (ticket.service.ts:517) — GATE phone-verified (:521-528)
        * Nếu user chưa verify SĐT → fail TICKET_PHONE_NOT_VERIFIED → hint user
        * Nếu OK → trả Ticket { id, ticketCode, status=VALID, ... }
   5. Lưu contentServiceTicketId vào PreTicket + set claimedAt + userId (idempotent @@unique)
   6. Ghi DistributionAudit (actionType=PRETICKET_CLAIMED)
   7. Return redirect /tickets/me (hoặc redirect trực tiếp nếu /claim/:token flow)
   │
   ▼
[User /tickets/me] → proxy content-service GET /tickets/my-tickets → trả vé + qrStaticUrl (signed QR)
   → User thấy vé + QR (check-in ở content-service scanner mobile-app, KHÔNG qua ticket-mayo)

────────────────────────────────────────────────────────

[Check-in (KHÔNG qua ticket-mayo)]
   - User mobile-app scanner → POST /content-service/tickets/check-in (checkin.service.ts:42)
   - content-service verifyScannedToken (Ed25519) → first-wins UPDATE VALID→USED → bump snapshotVersion
   - ticket-mayo KHÔNG đụng. Stats attendance proxy từ content-service (A9).
```

### 6.2. Idempotency (đa tầng)

| Tầng | Cơ chế | Chống gì |
|------|--------|----------|
| **Client** | Frontend generate `idempotencyKey` (UUID) + disable button khi click | Double-click |
| **API** | `DistributionJob.idempotencyKey @unique` — request thứ 2 với cùng key return old result | Admin refresh/retry |
| **DB PreTicket** | `PreTicket.claimToken @unique` + `@@unique([contentServiceTicketId])` — race lazy-resolve cùng PreTicket → 1 cái fail, re-read existing | Race condition 2 request claim cùng lúc |
| **DB content-service** | `Ticket.ticketCode @unique` (`schema.prisma:488`) — first-wins atomic UPDATE VALID→USED (`checkin.service.ts:145-178`) | Check-in trùng (content-service đảm bảo) |
| **Kafka consumer** | Consumer check `PreTicket.emailSentAt` — nếu đã gửi (not null) → skip | Kafka at-least-once delivery trùng |
| **Batch** | `DistributionJob.jobId @unique` — group PreTicket, query status theo jobId | Tạo trùng batch |

### 6.3. Rate-limit + chunking (list email lớn)

**Vấn đề**: List email admin import có thể 15,000+ email (PRD §5.4). Nếu publish 15,000 Kafka message cùng lúc → SMTP overload + spam folder.

**Giải pháp**:
1. **Producer rate-limit**: ticket-mayo publish Kafka message với throttle (vd: 100 msg/s) — simple loop + sleep, hoặc batching `producer.send({ messages: [10 messages] })` mỗi 100ms.
2. **Parse + dedupe list email lớn**: stream/parse list 15,000 email từng batch (validate format, normalize, dedupe theo emailHash).
3. **Batch DB insert**: Prisma `createMany` 1000 records/transaction (PRD §5.11) — tránh 15,000 round-trip.
4. **Gateway throttler** (cho admin API): gateway-auth đã có 3 tầng throttler Redis (`gateway-auth/src/app.module.ts:68-93`). Thêm rule: 1 distribution/30s/admin.
5. **v1.1 SMTP throttle**: noti-analytics consumer batch process (gop 10 email/gói) hoặc sequential với delay — giới hạn theo SMTP capacity (vd 50 email/s).

### 6.4. Retry + DLQ

Reuse pattern `OtpConsumer` (`noti-analytics/.../otpComsumer.kafka.ts:51-73`):
- Retry 3 lần, backoff `1000 * attempt` ms.
- Hết retry → publish `mail-dead-letter` với `{error, topic, payload, timestamp}` + update `PreTicket.emailStatus=FAILED` + `DistributionJob.failedRecipients`.
- v1.1: admin xem DLQ + trigger retry từng email hoặc cả batch (endpoint A6).

### 6.5. Claim token sinh + anti-enumerate

- Format: `claimToken = UUID v4 + "-" + crypto.randomBytes(32).toString('hex')` (vd: `a1b2c3d4-...-e5f6...` + 64 hex suffix). Tổng ~104 ký tự — enough entropy chống brute-force.
- DB unique constraint `PreTicket.claimToken @unique`.
- **Single-use-ish**: sau khi claim resolve thành công, set `claimedAt` + `contentServiceTicketId` → request thứ 2 với cùng token thấy `contentServiceTicketId != null` → return "Vé đã được nhận" (KHÔNG tạo trùng content-service Ticket).
- **MVP không hết hạn** (`claimTokenExpiresAt = null`). v1.1: 90 ngày.
- **Rate-limit claim endpoint**: IP throttle (10 req/phút/IP) — chống brute-force token.

### 6.6. Chống phát vượt số lượng (anti-inflation)

- **MVP**: validate `emails[]` không rỗng + `quantityPerEmail > 0`. KHÔNG có "recipientMode" logic rẽ nhánh.
- **v1.1**: `TicketType.quantity` từ content-service — trước khi phát, ticket-mayo query content-service `GET /ticket-types/:id` → check `sold + totalPreTickets mới >= quantity` → 422. (Caveat: content-service `TicketType.sold` cập nhật khi `registerTicket` — nếu ticket-mayo phát PreTicket nhưng chưa claim, `sold` chưa tăng → cần count PreTicket chưa claim + content-service sold.)
- **Future**: dual approval khi phát > 5,000 vé (PRD §5.1).

---

## 7. Ticket-Email Binding (CỐT LÕI)

> Phần này là then chốt — giải bài toán "user đăng nhập bằng email → thấy vé của mình". Binding giờ là **PreTicket.recipientEmailHash → (lúc claim) → content-service Ticket (userId)**.

### 7.1. Cơ chế binding

```
[Admin phát vé]
   │ recipientEmail = "user@example.com" (plaintext, admin paste/import —
   │   CÓ THỂ CHƯA là user trong app lúc phát)
   │
   ▼
[ticket-mayo: hash email]
   recipientEmailHash = HMAC-SHA256(normalize(email), FIELD_ENCRYPTION_PEPPER)
   // normalize: lowercase + trim (giống OtpConsumer pattern)
   // FIELD_ENCRYPTION_PEPPER = cùng key user-community dùng cho User.emailHash
   │
   ▼
[Lưu PreTicket { recipientEmail, recipientEmailHash, claimToken, contentServiceTicketId=NULL }]
   // contentServiceTicketId = null vì email chưa có user → chưa tạo content-service Ticket
   // userId = best-effort resolve lúc phát (nullable)

[User signup/login tại ticket-mayo user portal]  (KHÔNG qua chat-app)
   │ POST /auth/register  →  gateway-auth tạo account ở user-community
   │ POST /auth/login     { email, password }
   │
   ▼
[gateway-auth: verify credentials → issue JWT]
   // JWT payload chứa: { sub: userId, email: "user@example.com", ... }
   // (jwt.strategy.ts:26-48 — email là plaintext, §7.3 ✅)
   │
   ▼
[ticket-mayo user portal gọi GET /ticket-mayo/tickets/me  (Authorization: Bearer JWT)]
   │ (gateway proxy forward x-user-email)
   │
   ▼
[ticket-mayo: parse JWT / header → lấy email]
   loggedInEmail = JWT.email  // "user@example.com"
   │
   ▼
[ticket-mayo: hash email cùng cách]
   queryHash = HMAC-SHA256(normalize(loggedInEmail), FIELD_ENCRYPTION_PEPPER)
   │
   ▼
[Query PreTicket WHERE recipientEmailHash = queryHash AND contentServiceTicketId IS NULL]
   │
   ▼
[Lazy resolve (§5.2 — lựa chọn A)]
   1. resolve userId qua POST /user-community/users/lookup-by-emails
   2. tạo content-service Ticket: POST /content-service/tickets/register (x-user-id, x-service-token)
   3. lưu contentServiceTicketId vào PreTicket (mark claimed)
   │
   ▼
[Proxy content-service GET /tickets/my-tickets → trả vé + qrStaticUrl (signed QR) + status VALID/USED]
   // user thấy vé + QR của mình (email match → PreTicket claim → content-service Ticket tạo → vé hiện)
   // check-in diễn ra ở content-service scanner (mobile-app), KHÔNG qua ticket-mayo
```

### 7.2. Tại sao dùng emailHash (KHÔNG lưu plaintext để query)

| Lý do | Giải thích |
|-------|-----------|
| **Bảo mật** | Nếu DB ticket-mayo bị lộ, kẻ tấn công không thấy plaintext email trong index. `recipientEmail` plaintext vẫn lưu (để gửi mail Kafka) nhưng index query dùng hash. |
| **Đồng nhất với user-community** | `User.emailHash` đã dùng pattern này (`user-community/prisma/schema.prisma:20-21`). Đồng bộ giúp 2 service dùng cùng cơ chế lookup. |
| **Performance** | HMAC-SHA256 output cố định (64 hex chars), index B-tree on `recipientEmailHash` hiệu quả hơn index trên email plaintext (varying length). |
| **Privacy** | Audit log chỉ cần emailHash (không leak email). Query `/tickets/me` không cần decrypt. |

### 7.3. Yêu cầu kỹ thuật bắt buộc ✅ VERIFIED (bảo toàn từ draft v1)

1. **Share `FIELD_ENCRYPTION_PEPPER`**: ticket-mayo phải dùng cùng HMAC key với user-community để hash email. Nếu không, hash không khớp → user không thấy vé. ✅ **ĐÃ VERIFY**: env var là `FIELD_ENCRYPTION_PEPPER` (`user-community/src/common/utils/crypto-gcm.util.ts:28-37` `getPepper()`), thuật toán `HMAC-SHA256(pepper, text.toLowerCase().trim())` (cùng file `:125-130`). Pepper phải vĩnh viễn không đổi (comment `:122-123` cảnh báo). → §12 #6 RESOLVED.
2. **Normalize nhất quán**: cả 2 phía (lúc phát vé + lúc query) phải `email.toLowerCase().trim()` trước khi hash. Pattern chuẩn tại `crypto-gcm.util.ts:128` (`generateBlindIndex`) — reuse nguyên hàm này.
3. **Email trong JWT phải là plaintext gốc** user dùng đăng nhập. ✅ **ĐÃ VERIFY**: `gateway-auth/src/infrastructure/security/strategy/jwt.strategy.ts:30` khai báo `email: string` trong payload, `:41` `validate()` trả `email: payload.email` gốc. Verify JWT qua `ACCESS_TOKEN_SECRET` (HS256, `:21`). → §12 #7 RESOLVED.
4. **Fallback query theo userId**: nếu PreTicket đã claim (`userId` đã set), có thể query `WHERE userId = ?` thay vì emailHash. Nhưng emailHash an toàn hơn (xử lý case user đổi email — rare). MVP: query theo emailHash chính.

### 7.4. Edge case

- **User đổi email sau khi phát vé**: PreTicket vẫn binding với emailHash cũ. Nếu user đổi email ở user-community, query emailHash mới không match → không thấy PreTicket chưa claim. **Giải pháp MVP**: query theo CẢ `userId` OR `recipientEmailHash` (PRD Story 5 flow). Nhưng nếu PreTicket chưa claim (`userId = null` từ lúc phát), chỉ emailHash match được.
- **Email chưa verify**: MVP phát PreTicket cho mọi email admin nhập (kể cả chưa verify). v1.1 chỉ phát cho email đã verify (PRD S6.4).
- **2 user cùng email (không nên xảy ra)**: `User.emailHash @unique` đảm bảo 1 email = 1 user. Nếu race tạo user, DB reject.
- **User signup nhưng chưa verify SĐT** (content-service `registerTicket` gate — `ticket.service.ts:521-528`): lazy claim fail với `TICKET_PHONE_NOT_VERIFIED`. PreTicket vẫn unclaimed, user verify SĐT rồi retry `/tickets/me` → resolve thành công. ticket-mayo trả hint "Vui lòng xác thực SĐT để nhận vé".

---

## 8. Security & Restraints

### 8.1. Admin RBAC

- **Reuse pattern**: `@UseAuthGuard()` + `@RoleBaseAccessControl(AccessRole.Admin)` cho mọi `/ticket-mayo/admin/*` endpoint (bao gồm analytics A7-A9).
  - Bằng chứng: `user-community/.../admin.controller.ts:47-49`, `noti-analytics/.../adminAuth.decorator.ts`.
  - `AccessRole` enum: `Public | Admin | InternalService` (`noti-analytics/.../role.ts:1-5`).
- **Gateway proxy**: admin endpoint `/ticket-mayo/admin/*` đi qua gateway → gateway verify JWT + check role trước khi forward. ticket-mayo nhận request đã auth.

### 8.2. Chống lạm phát vé

- **Idempotency**: `idempotencyKey @unique` + `jobId @unique` (§6.2).
- **Quantity validation**: `quantityPerEmail > 0` (`@Min(1)`), `@Max(10)` (PRD §6.4).
- **maxQuantity cap (v1.1)**: query content-service `TicketType.quantity` + count PreTicket chưa claim → check trước khi phát, 422 nếu vượt.
- **Confirmation modal**: UI bắt buộc checkbox "Tôi xác nhận" trước khi "Phát vé" (PRD §6.5).
- **Frontend disable button**: ngay khi click, generate idempotencyKey, disable button + spinner.

### 8.3. Audit log mọi thao tác admin + claim

- **Bảng `DistributionAudit`** (§3.1): ghi mọi action `DISTRIBUTION_START`, `DISTRIBUTION_COMPLETE`, `PRETICKET_CLAIMED`, `EMAIL_RETRIED`, `EMAIL_BOUNCED`.
- **KHÔNG xóa audit**: retention = infinite (PRD §5.10).
- **PII concern**: `metadata` JSON chỉ chứa `emailHash` (KHÔNG plaintext email). `recipientEmail` plaintext chỉ lưu ở `PreTicket` table (cần mã hóa at-rest ở DB layer nếu yêu cầu compliance — open question §12 #8).
- **KHÔNG duplicate checkin audit**: checkin audit ở content-service `AuditLog` (ActionType.CHECK_IN — `checkin.service.ts:204`). ticket-mayo KHÔNG audit checkin.

### 8.4. Bảo mật emailHash

- `FIELD_ENCRYPTION_PEPPER` là secret — lưu trong secret manager (env var, KHÔNG commit).
- HMAC-SHA256 là one-way (không reverse) — safe để index.
- Key rotation: nếu rotate, hash cũ không match → cần re-hash tất cả PreTicket (migration). **MVP: không rotate**.

### 8.5. Service-to-service auth + CẢNH BÁO content-service blockers (QUAN TRỌNG)

- **ticket-mayo → content-service**: PHẢI dùng header `x-service-token: INTERNAL_SERVICE_TOKEN` thật — pattern `ServiceTokenGuard` (`content-service/.../internal.controller.ts:38`) + `x-service-token` ở `checkin.service.ts:270` + `ticket.service.ts:67`. Gateway → content-service cũng có thể forward user JWT nhưng cho service-to-service internal call (tạo Ticket lúc claim), ticket-mayo DÙNG `x-service-token` + `x-user-id` (userId đã resolve qua lookup, KHÔNG trust `x-user-id` từ client request gốc).
- **CẢNH BÁO (từ memory audit content-service 2026-08 — 4 blocker)**:
  1. **JWT/x-user-id auth bypass**: content-service có lỗ hổng auth bypass qua `x-user-id` header. → ticket-mayo KHÔNG forwarded `x-user-id` từ client gốc (chỉ từ gateway đã verify JWT, HOẶC ticket-mayo tự set `x-user-id` = userId đã resolve qua `lookup-by-emails`). KHÔNG trust `x-user-id` từ client header.
  2. **checkin totp fail-open**: content-service checkin TOTP có fail-open. → KHÔNG ảnh hưởng ticket-mayo (KHÔNG gọi checkin), nhưng cần biết khi proxy attendance stats.
  3. **PrismaService global**: content-service dùng PrismaService global (anti-pattern). → KHÔNG liên quan ticket-mayo nhưng note để audit cross-service.
  4. **matching no leader lock**: content-service matching không có leader lock. → KHÔNG liên quan ticket-mayo.
- **Đề xuất**: chờ content-service fix 4 blocker trước khi ticket-mayo go-live tích hợp; hoặc ticket-mayo whitelist internal endpoint content-service + dùng mTLS thêm lớp bảo vệ.

### 8.6. Claim token security

- **Unguessable**: `claimToken = UUID v4 + crypto.randomBytes(32).toString('hex')` (~104 ký tự, 256-bit entropy).
- **Single-use-ish**: sau khi claim, `contentServiceTicketId != null` → request thứ 2 return "đã nhận" (KHÔNG tạo trùng).
- **Rate-limit**: IP throttle 10 req/phút/IP cho `/claim/:token` (chống brute-force).
- **KHÔNG leak tồn tại**: request token không tồn tại → return 404 generic "link không hợp lệ hoặc đã hết hạn" (KHÔNG leak email/preTicketId).
- **MVP không hết hạn**. v1.1: 90 ngày.

### 8.7. Validate input

- `emails`: `@IsArray() @ArrayMinSize(1) @ArrayMaxSize(15000)` + each `@IsEmail()` (normalize lowercase/trim trước dedupe — bỏ duplicate theo emailHash).
- `quantityPerEmail`: `@IsInt() @Min(1) @Max(10)`.
- `ticketTypeId`: `@IsUUID('4')` + check tồn tại ở content-service (proxy GET) + `isActive` (nếu content-service có).
- `eventId`: `@IsUUID('4')` + check tồn tại ở content-service.
- `idempotencyKey`: `@IsUUID('4')` (client-generated).

### 8.8. Không phát trùng type+email ngoài ý định

- **Snapshot approach** (PRD §5.5): `recipientSnapshot` lưu list email tại thời điểm confirm. Email signup sau KHÔNG nhận vé retroactively.
- **Concurrent distributions**: 2 admin cùng phát cho list email trùng nhau → 2 job riêng (2 jobId), email nhận 2 PreTicket. MVP: chấp nhận + cảnh báo UI "job A đang chạy". v1.1: Redis lock theo emailHash (chống phát trùng cùng email đang chạy).
- **PreTicket duplicate trong cùng job**: `claimToken @unique` + `recipientEmailHash` per-job unique (nếu cần — v1.1) đảm bảo không có 2 PreTicket cho cùng email trong cùng job.

### 8.9. Analytics endpoint RBAC + rate-limit

- A7-A9 (analytics): `@UseAuthGuard()` + `@RoleBaseAccessControl(AccessRole.Admin)` (giống §8.1).
- **Rate-limit**: 10 req/phút/admin cho analytics endpoints (chống over-query content-service).
- **Cache**: distribution stats (từ ticket-mayo DB) cache 5 phút (Redis). Attendance stats (proxy content-service) cache 1 phút (tránh spam content-service).
- **KHÔNG leak PII**: analytics response chỉ trả count/aggregate, KHÔNG trả list email (trừ A4/A8 `?includeFailed=true` cho admin).

---

## 9. Module/Folder Structure (full-stack repo: backend NestJS + frontend Vite/React)

### 9.1. Cấu trúc thư mục `ticket-mayo/` (full-stack: backend + frontend)

```
ticket-mayo/
├── package.json                      # backend NestJS
├── tsconfig.json
├── nest-cli.json
├── .env.example
├── prisma/
│   └── schema.prisma              # schema §3.1 (DistributionJob, PreTicket, DistributionAudit)
├── frontend/                        # ⭐ FULL-STACK: frontend riêng (Vite + React + TS)
│   ├── package.json               # riêng (Vite, React, react-router, không phụ thuộc backend)
│   ├── vite.config.ts
│   ├── tsconfig.json
│   ├── .env.example                # VITE_GATEWAY_AUTH_URL, VITE_TICKET_API_BASE
│   ├── index.html
│   └── src/
│       ├── main.tsx                # bootstrap React
│       ├── App.tsx                 # router (admin + portal + claim, route guard riêng)
│       ├── api/
│       │   ├── gateway-auth.client.ts   # gọi /auth/register + /auth/login (KHÔNG qua chat-app)
│       │   ├── ticket.client.ts         # gọi /ticket-mayo/* (Bearer JWT)
│       │   └── content-service.client.ts # frontend proxy qua ticket-mayo (KHÔNG gọi trực tiếp CS)
│       ├── admin/                  # ⭐ Admin distribution portal + analytics
│       │   ├── AdminLoginPage.tsx
│       │   ├── ImportEmailListPage.tsx        # paste/upload CSV, validate+dedupe
│       │   ├── SelectTicketTypeStep.tsx       # dropdown TicketType (fetch từ content-service qua ticket-mayo proxy)
│       │   ├── ConfirmDistributionStep.tsx
│       │   ├── DistributionProgressPage.tsx   # progress: sent/claimed/checked-in
│       │   ├── AnalyticsDashboardPage.tsx     # ⭐ NEW: stats overview (dist + attendance)
│       │   ├── DistributionDetailPage.tsx     # ⭐ NEW: per-job progress + cross-check content-service
│       │   └── AttendanceStatsPage.tsx        # ⭐ NEW: attendance by Event/TicketType/gate
│       ├── portal/                # ⭐ User portal "vé của tôi"
│       │   ├── UserSignupPage.tsx
│       │   ├── UserLoginPage.tsx
│       │   ├── MyTicketsPage.tsx             # list vé + QR (từ content-service) + status VALID/USED
│       │   └── TicketDetailPage.tsx          # QR lớn + trạng thái check-in
│       ├── claim/                  # ⭐ NEW: claim link flow
│       │   └── ClaimRedirectPage.tsx         # GET /claim/:token → redirect login hoặc /tickets/me
│       ├── components/            # shared UI (chỉ trong ticket-mayo, KHÔNG import từ chat-app)
│       └── routes/
│           └── ProtectedRoute.tsx  # guard riêng (check AccessRole.Admin cho /admin/*)
├── src/                            # backend NestJS
│   ├── main.ts                    # bootstrap NestJS
│   ├── app.module.ts              # root module
│   ├── config/
│   │   ├── config.module.ts
│   │   └── env.ts                 # env schema (class-validator)
│   ├── prisma/
│   │   ├── prisma.module.ts
│   │   └── prisma.service.ts
│   ├── common/
│   │   ├── enums/
│   │   │   ├── role.ts            # AccessRole (sync với 2 service kia)
│   │   │   ├── email-status.ts
│   │   │   └── distribution-status.ts
│   │   ├── decorators/
│   │   │   ├── admin-auth.decorator.ts
│   │   │   ├── rbac.decorator.ts
│   │   │   └── user.decorator.ts
│   │   ├── guards/
│   │   │   └── header-auth.guard.ts   # parse x-user-id / x-user-email từ gateway
│   │   ├── utils/
│   │   │   ├── email-hash.util.ts       # HMAC-SHA256 + normalize (CỐT LÕI §7)
│   │   │   └── claim-token.util.ts     # sinh claim token unguessable (§6.5)
│   │   └── constants/
│   │       └── kafka-topics.ts          # 'notification.send-ticket', 'mail-dead-letter'
│   ├── modules/
│   │   ├── distribution/                  # DistributionJob + PreTicket CRUD
│   │   │   ├── distribution.module.ts
│   │   │   ├── distribution.controller.ts # A3-A6 (admin distribute, status, history, retry)
│   │   │   ├── distribution.service.ts    # logic then chốt §6
│   │   │   ├── distribution.repository.ts
│   │   │   └── dtos/
│   │   │       ├── distribute-request.dto.ts   # idempotencyKey, emails[], ticketTypeId, eventId, quantityPerEmail
│   │   │       └── distribution-status.dto.ts
│   │   ├── claim/                          # ⭐ NEW: claim link + lazy resolve
│   │   │   ├── claim.module.ts
│   │   │   ├── claim.controller.ts         # U3 GET /claim/:token
│   │   │   ├── claim.service.ts            # lazy resolve §5.2 — resolve userId + tạo content-service Ticket
│   │   │   └── claim.repository.ts
│   │   ├── ticket-portal/                  # ⭐ ĐỔI TÊN từ ticket/ — proxy content-service
│   │   │   ├── ticket-portal.module.ts
│   │   │   ├── ticket-portal.controller.ts # U1-U2 (/tickets/me lazy claim + proxy, /tickets/:id QR)
│   │   │   ├── ticket-portal.service.ts    # proxy content-service + merge PreTicket
│   │   │   └── dtos/
│   │   │       └── get-ticket-response.dto.ts
│   │   ├── analytics/                      # ⭐ NEW: admin analytics dashboard
│   │   │   ├── analytics.module.ts
│   │   │   ├── analytics.controller.ts     # A7-A9 (overview, distribution detail, attendance)
│   │   │   ├── analytics.service.ts        # aggregate distribution (DB) + proxy content-service stats
│   │   │   ├── analytics.repository.ts     # count PreTicket/DistributionJob group-by
│   │   │   └── dtos/
│   │   │       ├── overview-stats.dto.ts
│   │   │       └── attendance-stats.dto.ts
│   │   ├── mail-dispatcher/                # Kafka producer
│   │   │   ├── mail-dispatcher.module.ts
│   │   │   ├── kafka-producer.adapter.ts   # copy từ noti-analytics, clientId='ticket-service'
│   │   │   └── mail-dispatcher.service.ts  # emit notification.send-ticket + rate-limit §6.3
│   │   ├── user-lookup/                     # gọi user-community (lookup-by-emails)
│   │   │   ├── user-lookup.module.ts
│   │   │   ├── user-lookup.service.ts
│   │   │   └── user-community.client.ts     # HTTP adapter + x-service-token header
│   │   ├── content-service-client/         # ⭐ NEW: REST internal client tới content-service
│   │   │   ├── content-service-client.module.ts
│   │   │   ├── content-service.client.ts    # POST /tickets/register, GET /tickets/my-tickets, GET /tickets/:id/qr, GET /event/:id/stats
│   │   │   └── dtos/
│   │   │       ├── create-ticket.dto.ts     # { ticketTypeId, quantity }
│   │   │       └── content-service-ticket.dto.ts
│   │   ├── audit/
│   │   │   ├── audit.module.ts
│   │   │   ├── audit.service.ts             # ghi DistributionAudit (distribution actions only)
│   │   │   └── audit.repository.ts
│   │   └── auth/                         # §5.4 ĐÃ CHỐT lựa chọn A (gateway forward header)
│   │       ├── auth.module.ts
│   │       └── header-auth.guard.ts         # parse x-user-id / x-user-email từ gateway
│   └── infrastructure/
│       └── driven-adapters/
│           └── http/
│               └── internal-http.adapter.ts  # reuse pattern GatewayService.requestJson, x-service-token
```

### 9.2. Dependencies ước tính (package.json)

```jsonc
{
  "dependencies": {
    "@nestjs/common": "^10.x",
    "@nestjs/core": "^10.x",
    "@nestjs/config": "^10.x",
    "@nestjs/platform-express": "^10.x",
    "@nestjs/swagger": "^7.x",
    "@nestjs/microservices": "^10.x",      // cho Kafka @EventPattern (consumer) nếu cần
    "@prisma/client": "^5.x",
    "prisma": "^5.x",
    "kafkajs": "^2.x",                      // Kafka producer
    "class-validator": "^0.14.x",
    "class-transformer": "^0.5.x",
    "uuid": "^9.x",                          // sinh jobId, idempotencyKey
    "dotenv": "^16.x"
  },
  "devDependencies": {
    "typescript": "^5.x",
    "ts-node": "^10.x",
    "nodemon": "^3.x",
    "jest": "^29.x",
    "@types/jest": "^29.x",
    "@types/uuid": "^9.x"
  }
}
```

> Lưu ý: KHÔNG cần `nodemailer` ở ticket-mayo backend (email gửi ở noti-analytics). KHÔNG cần `qrcode` (QR gen ở content-service — ticket-mayo chỉ forward `qrStaticUrl`). KHÔNG cần `passport-jwt`/`jsonwebtoken` (§5.4 chọn A — gateway forward header, KHÔNG verify JWT ở ticket-mayo).

**Frontend `frontend/package.json`** (riêng, Vite + React):
```jsonc
{
  "dependencies": {
    "react": "^18.x",
    "react-dom": "^18.x",
    "react-router-dom": "^6.x",
    "axios": "^1.x"               // HTTP client (gọi gateway-auth + ticket-mayo API)
  },
  "devDependencies": {
    "typescript": "^5.x",
    "vite": "^5.x",
    "@vitejs/plugin-react": "^4.x",
    "@types/react": "^18.x",
    "@types/react-dom": "^18.x"
  }
}
```

### 9.3. Cấu hình env (`.env.example`)

```bash
# Database
DATABASE_URL=postgresql://user:pass@localhost:5432/ticket_mayo

# Kafka
KAFKA_BROKER=localhost:9092

# Service-to-service
INTERNAL_SERVICE_TOKEN=<shared với content-service + user-community + gateway>
USER_COMMUNITY_BASE_URL=http://user-community-service:3000
CONTENT_SERVICE_BASE_URL=http://content-service:3000  # hoặc qua gateway

# Email binding (CỐT LÕI §7)
FIELD_ENCRYPTION_PEPPER=<same key as user-community for User.emailHash>

# Frontend (gateway URL cho user portal)
# VITE_GATEWAY_AUTH_URL, VITE_TICKET_API_BASE — ở frontend/.env.example

# Service
PORT=3005
SERVICE_NAME=ticket-service
```

**Frontend `frontend/.env.example`** (KHÔNG qua chat-app):
```bash
VITE_GATEWAY_AUTH_URL=https://gateway-auth.local       # /auth/register + /auth/login
VITE_TICKET_API_BASE=https://gateway.local/ticket-mayo # proxy qua gateway (Bearer JWT)
```

---

## 10. Scope MVP / v1.1 / Future

| Feature | Phase | Module PRD ref |
|---------|-------|----------------|
| List TicketType từ content-service (proxy read) | **MVP** | T1.2 |
| Tạo DistributionJob + N PreTicket (list email + quantityPerEmail) | **MVP** | A2.2-A2.6 |
| Snapshot recipient + resolve email→userId (lookup-by-emails) | **MVP** | B4.1, B4.2 |
| Sinh claim token unique (UUID + random 256-bit) | **MVP** | B4.4 |
| Idempotency batch (idempotencyKey + jobId) | **MVP** | B4.5 |
| Kafka emit `notification.send-ticket` (email claim link) + rate-limit producer | **MVP** | E3.3 |
| Claim endpoint `GET /claim/:token` + lazy resolve tại `/tickets/me` | **MVP** | B4.3, D5.1 |
| `GET /tickets/me` (lazy claim + proxy content-service `my-tickets`) | **MVP** | B4.3, D5.1 |
| `GET /tickets/:id` (proxy content-service QR) | **MVP** | D5.2 |
| Audit log (DistributionAudit: distribution_start, complete, preticket_claimed) | **MVP** | S6.1, S6.2 |
| Email template + `sendTicketMail()` (ở noti-analytics — claim link) | **MVP** | E3.1, E3.2 |
| TicketMailConsumer (noti-analytics, reuse OtpConsumer) | **MVP** | E3.3 |
| Distribution progress (status endpoint) | **MVP** | A2.7 |
| **Analytics overview (distribution + attendance aggregate)** | **MVP** | **NEW §4.1 A7** |
| **Distribution detail (per-job: sent/claimed/checked-in)** | **MVP** | **NEW §4.1 A8** |
| **Attendance proxy (content-service stats)** | **MVP** | **NEW §4.1 A9** |
| Claim token expiry (90 ngày) | v1.1 | §6.5 |
| maxQuantity enforcement (anti-inflation, query content-service) | v1.1 | T1.4, S6.3 |
| Distribution history (filter, paginate) | v1.1 | A2.8 |
| Retry failed emails (from DLQ) | v1.1 | A2.9, E3.5 |
| Cancel in-progress distribution | v1.1 | A2.10 |
| Event-driven pre-warm claim (gateway-auth `user-registered` → ticket-mayo consume) | v1.1 | §5.2 lựa chọn B |
| SMTP bulk rate-limit (50 email/s) | v1.1 | E3.4 |
| Email delivery/bounce webhook (SMTP) | v1.1 | §3.3 |
| In-app notification "new ticket" (FCM) | v1.1 | D5.3 |
| Email verification before issue PreTicket | v1.1 | S6.4 |
| CSV/Excel export distribution report | Future | A2.11 |
| PreTicket transfer (change email binding) | Future | B4.9 |
| Content-service stats stabilized (branch merge) | Future | §12 open #5 |

---

## 11. Danh sách màn hình cần design

> Tham chiếu PRD §6. Mỗi màn 2-3 dòng. TẤT CẢ màn nằm trong `ticket-mayo/frontend/` (KHÔNG trong chat-app).

| # | Màn hình | Mô tả ngắn | Vị trí file trong `ticket-mayo/frontend/` |
|---|----------|-----------|------------------------------------------|
| 1 | Admin Login | Form email+password → gọi gateway-auth `/auth/login` → JWT. Redirect admin portal. Route guard check `AccessRole.Admin` từ JWT (`/admin/*`). | `src/admin/AdminLoginPage.tsx` |
| 2 | Admin Import/Paste Email List | Textarea paste list email HOẶC upload CSV. Validate format + dedupe realtime, badge "X email hợp lệ / Y trùng loại bỏ". Preview list (first 50). Nút "Tiếp tục". | `src/admin/ImportEmailListPage.tsx` + `src/admin/EmailListPreview.tsx` |
| 3 | Admin Chọn loại vé + số lượng | Dropdown loại vé (active only — **fetch từ content-service qua ticket-mayo proxy A1**) + input số lượng vé/email (min 1, max 10) + mô tả loại đã chọn. Hiện TỔNG SỐ PRE-TICKET dự kiến = N email × qty. Nút "Tiếp tục". | `src/admin/SelectTicketTypeStep.tsx` |
| 4 | Admin Xác nhận + Preview | Summary card: số email nhận, loại vé, số vé/email, TỔNG SỐ VÉ (bold red). Preview 5 email đầu. Checkbox "Tôi xác nhận" + nút "Hủy" / "Phát vé" (disabled tới khi check, generate idempotencyKey + disable khi click). | `src/admin/ConfirmDistributionStep.tsx` |
| 5 | Admin Xem trạng thái Distribution | Progress bar + "Đã gửi: X/Y \| Đã nhận vé (claimed): Z \| Thất bại: W" (poll 5s). Danh sách email fail (expandable). Job ID copyable. Nút "VéAnalytics dashboard". | `src/admin/DistributionProgressPage.tsx` |
| **6** | **Admin Analytics Dashboard** ⭐ NEW | Stats overview: 2 card lớn (Distribution stats: tổng PreTicket/sent/claimed/unclaimed; Attendance stats: issued/checkedIn/attendanceRate). Filter theo Event, khoảng thời gian, TicketType. Chart line (timeline checkin — v1.1). Gọi A7. | `src/admin/AnalyticsDashboardPage.tsx` |
| **7** | **Admin Distribution Detail** ⭐ NEW | Per-job progress: sent/claimed/claimedAndCheckedIn (cross-check content-service). Bảng PreTicket (emailHash, claimed, contentServiceTicketId, content-service status). Filter claimed/unclaimed. Gọi A8. | `src/admin/DistributionDetailPage.tsx` |
| **8** | **Admin Attendance Stats** ⭐ NEW | Attendance theo Event/TicketType/gate: issued, checkedIn, attendanceRate (progress bar). Timeline checkin (content-service Redis zset — v1.1). Gọi A9. | `src/admin/AttendanceStatsPage.tsx` |
| 9 | User Signup | Form email+password+confirm → gọi gateway-auth `/auth/register`. Validate email format. Redirect login sau thành công. Hint: "Dùng email bạn nhận vé để thấy vé của mình". | `src/portal/UserSignupPage.tsx` |
| 10 | User Login | Form email+password → gọi gateway-auth `/auth/login` → JWT. Redirect "vé của tôi". | `src/portal/UserLoginPage.tsx` |
| 11 | User "Vé của tôi" | List cards vé (tên event, `ticketCode` rút gọn, badge trạng thái **VALID/USED/CANCELLED** từ content-service, ngày nhận). Sort createdAt desc. Empty state "Bạn chưa có vé nào — nếu bạn nhận email vé, hãy signup bằng đúng email đó". Click card → detail. | `src/portal/MyTicketsPage.tsx` |
| 12 | User Vé Detail | QR lớn (**signed QR từ content-service `qrStaticUrl`** — hiển thị offline), `ticketCode` copyable, mô tả, ngày phát, trạng thái check-in, gate check-in (nếu USED). Nút "Tải QR". | `src/portal/TicketDetailPage.tsx` |
| **13** | **Claim Link Redirect** ⭐ NEW | User click email claim link → `GET /claim/:token`. Nếu chưa login → redirect gateway-auth login → quay lại. Nếu đã login → lazy resolve PreTicket → tạo content-service Ticket → redirect "vé của tôi" với toast "Vé đã được nhận". | `src/claim/ClaimRedirectPage.tsx` |
| 14 | Email Template (gửi vé) | HTML: logo MAYogu + tên event/loại vé + **CLAIM LINK** (nút "Nhận vé" → `/claim/:token`). Footer: "Đăng nhập ticket-mayo portal bằng email [email] để xem vé". Responsive. i18n VI/EN. | Template nằm ở **noti-analytics-service** (KHÔNG phải ticket-mayo): `noti-analytics-service/src/application/utils/ticket-mail.template.ts` |

**Lưu ý cấu trúc `ticket-mayo/frontend`**: tạo 3 nhóm folder:
- `src/admin/` — admin distribution portal + analytics (8 màn MVP: login, import email, select type, confirm, progress, analytics dashboard, distribution detail, attendance stats).
- `src/portal/` — user portal (4 màn MVP: signup, login, my tickets, ticket detail).
- `src/claim/` — claim redirect (1 màn MVP: claim redirect).
- Frontend dùng route guard riêng (`src/routes/ProtectedRoute.tsx` — KHÔNG dùng của chat-app). Check `AccessRole.Admin` từ JWT cho `/admin/*`.
- Frontend gọi gateway-auth qua env `VITE_GATEWAY_AUTH_URL` (KHÔNG hardcode, KHÔNG qua chat-app).

---

## 12. Risks & Open Questions

### 12.1. Rủi ro kỹ thuật

| Rủi ro | Likelihood | Impact | Mitigation |
|--------|------------|--------|------------|
| `FIELD_ENCRYPTION_PEPPER` không khớp giữa ticket-mayo và user-community → user không thấy PreTicket | Low (đã verify env var) | Critical | ✅ Đã verify env var `FIELD_ENCRYPTION_PEPPER` + thuật toán (`crypto-gcm.util.ts:125-130`). Mitigation: deploy cùng value env, reuse hàm `generateBlindIndex`. Còn rủi ro vận hành (config sai value khi deploy) — checklist pre-flight phải verify hash match |
| Kafka message trùng (at-least-once) → user nhận 2 email | Low | Medium | Consumer idempotent: check `PreTicket.emailSentAt` (§6.2) |
| SMTP chết khi đang phát 15,000 PreTicket | Medium | High | Retry 3 + DLQ. v1.1: admin retry từ DLQ (§6.4) |
| DB performance khi createMany 15,000 PreTicket | Medium | Medium | Batch 1000/transaction (§6.3). Cần benchmark |
| Admin phát nhầm 15,000 PreTicket (wrong type) | Medium | High | Confirmation modal + (v1.1) cancel. Không có undo MVP |
| JWT `email` claim không phải plaintext (đã hash) → query emailHash fail | Low (đã verify) | Critical | ✅ Đã verify `jwt.strategy.ts:30,41` — `email` là plaintext trong JWT payload. Query path khả thi |
| Email signup sau khi phát vé — user tạo account bằng email mới KHÔNG nhận vé retroactively | Medium | Low | Snapshot approach (§3.2 + §8.8) — email phải có trong list lúc phát |
| `recipientEmail` plaintext leak trong DB ticket-mayo | Medium | High | Mã hóa at-rest (DB-level, PostgreSQL TDE) hoặc app-level AES. Open question #8 |
| ticket-mayo → user-community network failure khi resolve email→userId | Low | Medium | PreTicket.userId nullable — vẫn phát PreTicket, resolve lúc claim |
| **Lazy claim race**: 2 request `/tickets/me` cùng lúc cho cùng PreTicket → tạo 2 content-service Ticket | Low | High | `PreTicket.contentServiceTicketId @@unique` — 1 cái fail, re-read existing (§6.2) |
| **content-service `registerTicket` phone-verified gate** (`ticket.service.ts:521-528`) — user signup nhưng chưa verify SĐT → lazy claim fail | Medium | Medium | ticket-mayo handle `TICKET_PHONE_NOT_VERIFIED` → hint user verify SĐT; PreTicket vẫn unclaimed, retry `/tickets/me` sau khi verify |
| **content-service 4 blocker** (JWT/x-user-id auth bypass, checkin totp fail-open, PrismaService global, matching no leader lock) — ticket-mayo gọi content-service nội bộ | Medium | High | ticket-mayo dùng `x-service-token` thật + KHÔNG trust `x-user-id` từ client; chờ content-service fix trước go-live (§8.5) |
| **content-service stats endpoint chưa stable** (branch `feat/gate-assignments-checkin-stats` chưa merge) | Medium | Medium | ticket-mayo A9 proxy dùng endpoint tạm; open question §12 #5 — cần verify exact endpoint + field |

### 12.2. Open questions cần user chốt

1. **DB riêng hay share DB user-community?** 
   - Đề xuất: **DB riêng** `ticket_mayo` (DistributionJob/PreTicket/DistributionAudit). Ticket/Event ở content-service DB (KHÔNG share). user-community DB có User (KHÔNG share). Vấn đề: ticket-mayo KHÔNG query cross-DB — gọi HTTP (content-service + user-community lookup).
   - Ảnh hưởng: `PreTicket.contentServiceTicketId` + `DistributionJob.ticketTypeId/eventId` là tham chiếu logic (KHÔNG FK).

2. **ticket-mayo → user-community: gọi trực tiếp (x-service-token) hay qua gateway proxy?**
   - Đề xuất: **trực tiếp** (cùng VPC, `x-service-token` header) — ít hop, nhanh. Pattern đã có ở `gateway-auth/.../user.repository.adapter.ts`.
   - Nếu qua gateway, đồng nhất nhưng chậm hơn 1 hop.

3. ✅ **RESOLVED — JWT verify cho `/tickets/me`: chọn (A) gateway proxy + forward header.**
   - Gateway verify JWT, forward `x-user-email` (+ `x-user-id`) tới ticket-mayo. ticket-mayo KHÔNG cần `ACCESS_TOKEN_SECRET`.
   - Lưu ý PII: email plaintext trong header nội bộ — cần HTTPS nội bộ + giới hạn VPC.
   - Phụ thuộc: cần config gateway route `/ticket-mayo/*` (xem #10).

4. **Consumer idempotency: noti-analytics TicketMailConsumer cập nhật `PreTicket.emailSentAt` thế nào?**
   - Vấn đề: PreTicket nằm DB ticket-mayo, consumer nằm noti-analytics. Có 3 cách:
     - (a) Consumer gọi HTTP callback tới ticket-mayo sau khi gửi mail: `POST /ticket-mayo/internal/pre-tickets/:id/email-sent`.
     - (b) Share DB (KHÔNG — §12 #1 chọn DB riêng).
     - (c) Consumer chỉ gửi mail, không update — ticket-mayo poll Kafka `notification.ticket-email-status` (consumer emit event).
   - Đề xuất: **(a) HTTP callback** — đơn giản, ticket-mayo giữ ownership DB.

5. **content-service stats endpoint chính xác là gì? (cần đọc branch `feat/gate-assignments-checkin-stats`)** ⭐ NEW
   - Đã verify branch có: `GET /event/my-events/created/dashboard` (`event.controller.ts:200`), `GET /event/:id?includeStats=true` (`event.service.findOneWithStats:1076`), `GET /event/:id/registration-trend` (`:441`), `GET /internal/community/:communityId/stats-summary` (ServiceTokenGuard).
   - Cần confirm: (a) endpoint nào trả checkin count + attendance rate theo Event/TicketType/gate; (b) endpoint internal (ServiceTokenGuard) vs user-facing ( organizer); (c) field response chính xác; (d) branch có merge main không (diff rất lớn — có vẻ là branch tổng hợp).
   - Ảnh hưởng: A9 attendance proxy + A7 analytics overview. MVP có thể dùng `findOneWithStats` (includeStats=true) per-event + aggregate ticket-mayo side.

6. ✅ **RESOLVED — `FIELD_ENCRYPTION_PEPPER` env var name ở user-community.**
   - Đã verify code: `user-community-service/src/common/utils/crypto-gcm.util.ts`.
   - Blind index (emailHash) = `crypto.createHmac('sha256', getPepper()).update(text.toLowerCase().trim()).digest('hex')` (file `:125-130`).
   - `getPepper()` đọc `process.env.FIELD_ENCRYPTION_PEPPER` (file `:28-37`).
   - Kết luận: ticket-mayo share env `FIELD_ENCRYPTION_PEPPER` (cùng value) + reuse hàm `generateBlindIndex`. Pepper vĩnh viễn không đổi (file `:122-123`).

7. ✅ **RESOLVED — JWT `email` claim là plaintext.**
   - Đã verify: `gateway-auth-service/.../jwt.strategy.ts:30` khai báo `email: string`; `:41` `validate()` return `email: payload.email` (plaintext gốc).
   - `GET /tickets/me`: parse JWT lấy plaintext email → `generateBlindIndex(email)` → query `PreTicket.recipientEmailHash`. Không cần decrypt.

8. **`recipientEmail` plaintext có cần mã hóa at-rest?**
   - PRD §5.10 PII concern. User mã hóa email AES-256-GCM. ticket-mayo có cần làm tương tự không, hay chấp nhận plaintext trong DB riêng (hỗ trợ bởi emailHash cho query)?
   - Đề xuất: MVP lưu plaintext (cần gửi mail Kafka), v1.1 mã hóa AES-256-GCM + decrypt khi emit Kafka.

9. **Email chứa claim link hay QR? (đã chốt — claim link)** ⭐ UPDATED
   - **Đã chốt: CLAIM LINK** (KHÔNG phải QR). Lý do: content-service `Ticket.userId` BẮT BUỘC (`schema.prisma:487`) → chưa có userId lúc admin phát → chưa tạo content-service Ticket → chưa có QR. Email chỉ chứa claim link; QR chỉ có SAU khi user signup + claim resolve (lấy từ content-service `GET /tickets/my-tickets` tại `/tickets/me`).

10. **Gateway proxy route `/ticket-mayo/*` cần config thêm ở gateway-auth?**
    - PRD §1.2 #10 gợi ý. Cần confirm gateway-auth có cơ chế dynamic route (Consul) hay phải hardcode route trong code.

11. **ticket-mayo frontend framework: Vite + React hay Next.js?**
    - Đề xuất: **Vite + React + TypeScript** — nhất quán stack với chat-app (team quen), đủ cho portal nội bộ (KHÔNG cần SSR/SEO). Tách build/deploy độc lập.

12. **Claim detect mechanism: lazy (A) hay event-driven (B)? (đã chốt — lazy)** ⭐ NEW
    - **Đã chốt: LAZY (A)** — resolve tại `GET /tickets/me`. Lý do: đơn giản, không Kafka consumer mới, không race với user flow (user signup xong gọi `/tickets/me` ngay, event-driven consumer có thể chưa xử lý kịp). v1.1 có thể thêm (B) event-driven pre-warm để giảm latency lần đầu.

13. **ticket-mayo có cần cache content-service Ticket/QR không?** ⭐ NEW
   - Vấn đề: `/tickets/me` proxy content-service mỗi request — nếu content-service chậm, user portal chậm.
   - Đề xuất: cache `qrStaticUrl` + ticket status Redis 60s (key `preticket:${id}:ticket`). Invalidate khi content-service emit checkin event (nếu có) HOẶC TTL ngắn. MVP: KHÔNG cache (gọi content-service mỗi lần), v1.1 cache 60s.

14. **content-service `registerTicket` phone-verified gate — có cần internal endpoint bypass?** ⭐ NEW
   - Vấn đề: `ticket.service.ts:521-528` yêu cầu user verify SĐT trước khi `registerTicket`. Lazy claim fail nếu user chưa verify SĐT.
   - Option: (a) ticket-mayo hint user verify SĐT rồi retry; (b) content-service thêm endpoint internal tạo Ticket bypass phone-gate cho service-to-service (x-service-token).
   - Đề xuất: **(a) hint + retry** — đơn giản MVP. v1.1 cân nhắc (b) nếu UX quá tệ.

15. ~~CRUD TicketType riêng ở ticket-mayo~~ — **BỎ** (Quyết định 1: TicketType ở content-service, ticket-mayo chỉ proxy read).

---

## Phụ lục A: Tham chiếu code thật (evidence index)

### A.1. content-service (SOURCE OF TRUTH cho Ticket/TicketType/Event/check-in/QR/scanner/stats)

| Claim | File | Dòng |
|-------|------|-----|
| `Event` model (organizerId, communityId, title, startTime/endTime, address, city, maxParticipants, status, offlineCheckInEnabled, checkInSnapshotVersion, signingPublicKey/PrivateKeyEnc/KeyId) | `content-service/prisma/schema.prisma` | 281-340 |
| `Ticket` model (`ticketTypeId`, `userId` **BẮT BUỘC không nullable**, `ticketCode @unique`, `status` VALID/USED/CANCELLED, `purchasePrice`, `checkedInAt`, `checkedInBy`, `checkedInGateId`, `totpSecret`, `checkedInDeviceEventId`, `seatLabel`) | `content-service/prisma/schema.prisma` | 484-514 |
| `TicketType` model (eventId, name, typeCode, price, quantity, sold, maxTicketsPerUser, saleStartsAt/EndsAt, qrForegroundColor/BackgroundColor) | `content-service/prisma/schema.prisma` | 603-625 |
| `Gate` (eventId, name), `CheckinAssignment` (gateId, userId, eventId), `Seat` | `content-service/prisma/schema.prisma` | 516-650 |
| `OfflineCheckinRequest` (idempotency offline sync: userId, checkInRequestId, result Json) | `content-service/prisma/schema.prisma` | 543-555 |
| `AuditLog` generic (actorId, actionType, targetId, targetType, beforeData/afterData) — đã audit checkin ops | `content-service/prisma/schema.prisma` | 809-825 |
| Online check-in: `checkin()` — verifyScannedToken (Ed25519), first-wins UPDATE VALID→USED, bump snapshotVersion, Redis counters + timeline | `content-service/src/core/services/checkin.service.ts` | 42-237 |
| `verifyScannedToken` — verify QR sig Ed25519 (gọi `verifyTicket`), check `tid`/`eid` match (KHÔNG check ts/exp) | `content-service/src/core/services/checkin.service.ts` | 302-313 |
| First-wins atomic UPDATE: `ticketRepo.updateMany({ id, status: 'VALID' }, { status: 'USED', checkedInAt, checkedInBy, checkedInGateId })` | `content-service/src/core/services/checkin.service.ts` | 145-178 |
| Bump snapshotVersion (fire-and-forget): `ticketRepo.incrementSnapshotVersion(event.id)` | `content-service/src/core/services/checkin.service.ts` | 186-188 |
| Redis counters: `event:${eventId}:checkin:count` (incr) + `event:${eventId}:checkin:timeline` (zadd) | `content-service/src/core/services/checkin.service.ts` | 191-200 |
| Permission check: organizer bypass; else community member + EventMemberPermission CHECK_IN (x-service-token) | `content-service/src/core/services/checkin.service.ts` | 241-287 |
| Audit CHECK_IN / CHECK_IN_FAILED (content-service AuditLog) | `content-service/src/core/services/checkin.service.ts` | 202-222, 289-300 |
| Offline check-in service: `getVersion`, `getSnapshot`, `getDelta`, `syncCheckin` (batch first-wins, idempotent `OfflineCheckinRequest`) | `content-service/src/core/services/offline-checkin.service.ts` | 99-373 |
| `POST /tickets/check-in` (online — mobile app scanner) | `content-service/src/infrastructure/driving-adapters/http-rest/controllers/checkin.controller.ts` | 14-53 |
| `POST /tickets/check-in/sync` (offline batch sync, throttler 10/min/IP, max 200 records) | `content-service/.../controllers/offline-checkin.controller.ts` | 20-77 |
| `GET /events/:eventId/check-in-data/version|snapshot|delta` (snapshot freshness + ticket snapshot, gzip, 304) | `content-service/.../controllers/offline-checkin-snapshot.controller.ts` | 31-165 |
| Ed25519 signed QR (JWS compact EdDSA, per-event keypair, envelope-encrypted private key với `TICKET_SIGNING_MASTER_KEY`, `signTicket`/`verifyTicket`, KHÔNG ts/exp) | `content-service/src/core/helper/signing-key.helper.ts` | toàn file |
| `POST /tickets/register` (đăng ký vé miễn phí — tạo vé ngay, gate phone-verified) | `content-service/.../controllers/ticket.controller.ts` | 25-40 |
| `GET /tickets/my-tickets` (danh sách vé user + `qrStaticUrl` signed) | `content-service/.../controllers/ticket.controller.ts` | 42-61 |
| `GET /tickets/:id/qr?type=static\|dynamic` (signed QR token) | `content-service/.../controllers/ticket.controller.ts` | 63-74 |
| `registerTicket` — gate phone-verified (`isPhoneVerified`), validate event/ticketType, queue | `content-service/src/core/services/ticket.service.ts` | 517-555 |
| `getMyTickets` — trả `qrStaticUrl` (signed), `isCheckedIn`, status, event info | `content-service/src/core/services/ticket.service.ts` | 675-751 |
| `getQRCode` — `buildStaticToken`/`buildDynamicToken` (Ed25519 sign) | `content-service/src/core/services/ticket.service.ts` | 753-816 |
| Pattern "admin distribute by email" (`AdminKeyGuard`, `POST /gifts/admin/distribute-email`) — đã có ở content-service GiftController (gift campaign, KHÔNG dùng cho ticket-mayo nhưng là precedent) | `content-service/.../controllers/gift.controller.ts` | 49-68 |
| `ServiceTokenGuard` cho internal endpoints (`@UseGuards(ServiceTokenGuard)`, `@ApiSecurity('service-token')`) | `content-service/.../controllers/internal.controller.ts` | 38-39 |
| `GET /internal/community/:communityId/stats-summary` (ServiceTokenGuard) | `content-service/.../controllers/internal.controller.ts` | 96-103 |
| Branch `feat/gate-assignments-checkin-stats`: `GET /event/my-events/created/dashboard`, `GET /event/:id?includeStats=true` (`findOneWithStats`), `GET /event/:id/registration-trend` | branch `feat/gate-assignments-checkin-stats` — `event.controller.ts:200,318,441`; `event.service.ts:1076,1704` |
| Scanner Flutter (qr_scanner_screen, checkin widgets) | `mobile-app/lib/feature/screens/event/view/scan_ticket/` | — |

### A.2. user-community-service

| Claim | File | Dòng |
|-------|------|-----|
| User.email encrypted + emailHash blind index | `user-community-service/prisma/schema.prisma` | 14-68 (email:20, emailHash:21) |
| `GET /user-community/users` (Admin, paginated) — KHÔNG dùng để select recipients (flow mới: admin paste email list) | `user-community-service/.../user.controller.ts` | 174-190 |
| `POST /user-community/users/lookup-by-emails` (InternalService) — best-effort resolve email→userId (nullable) | `user-community-service/.../user.controller.ts` | 438-455 |
| `GetUserByEmailsResponseDto` = `[{id, email, displayName}]` | `user-community-service/.../getUserByEmails.dto.ts` | 13-22 |
| `History` model (generic audit) | `user-community-service/prisma/schema.prisma` | 344-354 |
| `FIELD_ENCRYPTION_PEPPER` env + `generateBlindIndex` (HMAC-SHA256, normalize lowercase/trim) | `user-community-service/src/common/utils/crypto-gcm.util.ts` | 28-37, 122-130 |

### A.3. gateway-auth-service

| Claim | File | Dòng |
|-------|------|-----|
| `POST /auth/login` (email+password → JWT) | `gateway-auth-service/.../auth.controller.ts` | 71-86 |
| `POST /auth/register` (gateway-auth — ticket-mayo user portal gọi để signup) | `gateway-auth-service/.../auth-register.service.ts` | — |
| JWT payload: `{sub, email, displayName, ...}` (email plaintext) | `gateway-auth-service/.../jwt.strategy.ts` | 26-48 |
| JWT verify qua `ACCESS_TOKEN_SECRET` (HS256) | `gateway-auth-service/.../jwt.strategy.ts` | 21 |
| Service-to-service header `x-service-token: INTERNAL_SERVICE_TOKEN` | `gateway-auth-service/.../user.repository.adapter.ts` | 30-38, 97-103 |
| Gateway throttler 3 tầng Redis | `gateway-auth-service/src/app.module.ts` | 68-93 |

### A.4. noti-analytics-service

| Claim | File | Dòng |
|-------|------|-----|
| Kafka producer `send(topic, message)` | `noti-analytics-service/.../KafkaProducerAdapter.ts` | 20-25 |
| OtpConsumer: retry 3, backoff 1s*attempt, DLQ `mail-dead-letter`, email validate + normalize | `noti-analytics-service/.../otpComsumer.kafka.ts` | 18-74 |
| MailService.sendOtpMail (nodemailer, SMTP env) | `noti-analytics-service/.../mail.service.ts` | 10-41 |

### A.5. Cross-service patterns + ticket-mayo hiện trạng

| Claim | File | Dòng |
|-------|------|-----|
| Admin RBAC: `@UseAuthGuard()` + `@RoleBaseAccessControl(AccessRole.Admin)` | `noti-analytics-service/.../admin.controller.ts` | 11-12 |
| Admin RBAC (user-community): cùng pattern `@UseAuthGuard()` + `@RoleBaseAccessControl(AccessRole.Admin)` | `user-community-service/.../admin.controller.ts` | 48-49 |
| `AccessRole` enum: Public, Admin, InternalService | `noti-analytics-service/src/common/enums/role.ts` | 1-5 |
| `RoleBaseAccessControl` decorator (định nghĩa) | `noti-analytics-service/src/decorator/rbac.decorator.ts` | 6-11 |
| `AuthGuard` parse RBAC metadata + check role | `noti-analytics-service/src/infrastructure/security/guard/auth.guard.ts` | 20-47 |
| `@User('id')` decorator pattern | `noti-analytics-service/src/decorator/user.decorator.ts` | 4-13 |
| ticket-mayo frontend stack: Vite + React + TypeScript (nhất quán với chat-app stack; KHÔNG đặt file trong chat-app — tách build/deploy độc lập) | `chat-app/package.json` (tham chiếu stack, KHÔNG import) | — |
| ticket-mayo hiện trạng: TRỐNG (chỉ .git) — sẽ chứa cả backend `src/` + `frontend/` + `prisma/` (full-stack tự chứa, KHÔNG đụng chat-app) | `c:\MAYogu_VIASG\ticket-mayo\` | ls |
