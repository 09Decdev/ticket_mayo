# DESIGN: Ticket Email Eager-Mint & Sync (ticket-mayo x content-service)

**Version**: 1.0
**Date**: 2026-08-27
**Author**: Backend Architect
**Status**: Chờ phản biện
**Implements**: `docs/PRD-ticket-email-mint-sync.md` (v1.1 approved) + `docs/WORKFLOW-ticket-email-mint-sync.md` (Workflow Architect)
**Repos**: `c:\MAYogu_VIASG\ticket-mayo` (orchestrator + email + portal), `c:\MAYogu_VIASG\content-service` (nguồn sự thật Event/TicketType/Ticket/check-in)

> Quy ước cite: `file.ext:dòng` là vị trí đã đọc và verify trong research này. Mọi claim về code hiện tại đều có cite. Decision ID (D-xx) dùng cho vòng phản biện tham chiếu.

---

## Mục lục

- [0. Tóm tắt quyết định](#0-tóm-tắt-quyết-định)
- [1. Migration 2 repo](#1-migration-2-repo)
- [2. Mint API contract (C-1)](#2-mint-api-contract-c-1)
- [3. Link-by-email contract (C-2)](#3-link-by-email-contract-c-2)
- [4. distribute() EAGER + giải T5](#4-distribute-eager--giải-t5)
- [5. Sync flow + short-circuit + race](#5-sync-flow--short-circuit--race)
- [6. Backfill script (T7)](#6-backfill-script-t7)
- [7. Error translation quota (T5)](#7-error-translation-quota-t5)
- [8. Backward-compat + deploy order + smoke test](#8-backward-compat--deploy-order--smoke-test)- [9. TicketType.sold trong EAGER + nơi đọc sold](#9-tickettypesold-trong-eager--nơi-đọc-sold)
- [10. Xác nhận giả định hash/pepper](#10-xác-nhận-giả-định-hashpepper)
- [11. Đối chiếu findings Workflow Architect (F-01..F-11, RB3, C-1/C-2, PARTIALLY_MINTED)](#11-đối-chiếu-findings-workflow-architect-f-01f-11-rb3-c-1c-2-partially_minted)
- [12. Trade-off tổng hợp đã cân nhắc và từ chối](#12-trade-off-tổng-hợp-đã-cân-nhắc-và-từ-chối)
- [Giữ chỗ cho vòng phản biện](#giữ-chỗ-cho-vòng-phản-biện)

---

## 0. Tóm tắt quyết định

| # | Quyết định | ID |
|---|---|---|
| 1 | Mint API mới chạy **toàn batch trong 1 tx duy nhất** với `SELECT ... FOR UPDATE` trên TicketType + check `sold + N ≤ quantity` + increment cùng tx. Không copy pattern check-then-act hiện tại. | D-M1 |
| 2 | Idempotency content-side qua **cột `preTicketId String? @unique` trên Ticket** (at-most-1 Ticket per preTicketId), không dùng bảng mapping riêng. Retry toàn batch: recipient đã mint trả về ticket cũ `alreadyMinted: true`, không tăng sold. | D-M2 |
| 3 | PreTicket tạo **TRƯỚC** khi mint (giữ vị trí hiện tại trong tx), nhưng PENDING→MINTING lock xảy ra trước HTTP call. Orphan T5 xử bằng **resume + idempotency content** (C-1), KHÔNG cleanup-on-retry. | D-T5 |
| 4 | Link-by-email scope = **mọi Ticket email-only trùng hash, mọi event** — quyết định của PM đã ghi trong PRD, design này hiện thực hóa. Race 2 request đồng thời: single `UPDATE ... WHERE userId IS NULL` — PG tự tuần tự hóa. | D-L1 |
| 5 | Sync triggers idempotent + short-circuit qua **PreTicket MINTED-unlinked tồn tại** (không cần cột riêng). Race login-vs-distribute: lock MINTING + idempotency content + link guard `userId IS NULL` bảo vệ cả 2 chiều. | D-S1 |
| 6 | Backfill: dry-run + `--confirm` + EXPIRED terminal + audit `BACKFILL_QUOTA_EXCEEDED` per vé + report tổng kết. | D-B1 |
| 7 | Quota error từ content: **HTTP 409 + code TICKET_SOLD_OUT + message chứa `remaining=`/`yêu cầu=`** theo format hiện có của `issueTickets` — ticket-mayo bắt và chuyển thành 4xx sạch cho admin. | D-Q1 |
| 8 | Deploy: content-service TRƯỚC (migration + API mới vô hại với ticket-mayo cũ), ticket-mayo SAU (migration enum + code, flag LAZY default), smoke EAGER per-environment, backfill cuối. | D-D1 |
| 9 | EAGER tăng sold **ngay trong mint tx** (cùng lúc tạo Ticket) — không có trạng thái "minted-but-not-sold". | D-S2 |
| 10 | Content chỉ nhận `emailHash` (HMAC-SHA256, pepper ở ticket-mayo `FIELD_ENCRYPTION_PEPPER`). Content KHÔNG có pepper, KHÔNG bao giờ thấy plaintext email. | D-H1 |
| 11 | **CHẤP THUẬN toàn bộ findings F-01..F-11 + RB3 của Workflow Architect** — chi tiết đối chiếu từng cái ở mục 11, trong đó F-01 (mint tx row-lock), F-02 (resume), F-03 (LINKED), F-04 (retry per-PreTicket), F-05 (emailSentAt) thay đổi thiết kế gốc của tôi, ghi nhận thay đổi tương ứng. | D-WF |

---

## 1. Migration 2 repo

### 1.1. Content-service: `Ticket.userId` nullable + `recipientEmailHash` + `preTicketId` + index

**Phương án chốt** (migration mới, expand-only — không đụng dữ liệu hiện có):

```prisma
// content-service/prisma/schema.prisma — model Ticket (hiện tại dòng 484-514)
model Ticket {
  id                 String       @id @default(uuid())
  ticketTypeId       String
  userId             String?      // ← ĐỔI: String → String? (dòng 487 hiện non-null)
  recipientEmailHash String?      // ← MỚI: HMAC-SHA256 blind index (hex 64 chars), NULL cho vé purchase-path
  preTicketId        String?      // ← MỚI: idempotency key mint — at-most-1 Ticket per preTicketId
  ticketCode         String       @unique
  // ... (các cột còn lại giữ nguyên)
  @@index([userId])
  @@index([checkedInGateId])
  @@index([recipientEmailHash])   // ← MỚI
  // preTicketId @unique — khai báo @unique tại cột
}
```

SQL tương ứng (Prisma migrate sẽ sinh; ghi lại tay cho downgrade script):

```sql
-- UPGRADE
ALTER TABLE "Ticket" ALTER COLUMN "userId" DROP NOT NULL;
ALTER TABLE "Ticket" ADD COLUMN "recipientEmailHash" TEXT;
ALTER TABLE "Ticket" ADD COLUMN "preTicketId" TEXT;
CREATE UNIQUE INDEX "Ticket_preTicketId_key" ON "Ticket"("preTicketId");
CREATE INDEX "Ticket_recipientEmailHash_key" ON "Ticket"("recipientEmailHash");
```

Vì sao KHÔNG dùng partial index `WHERE userId IS NULL` (Workflow doc §1.3 để ngỏ): Postgres hỗ trợ, nhưng (a) Prisma `@@index` không diễn đạt được WHERE clause — phải viết SQL tay trong migration, dễ drift với schema.prisma; (b) index thường vẫn phục vụ tốt lookup theo hash vì selectivity cao (64-char hex gần unique); (c) giữ schema thuần Prisma dễ bảo trì hơn tiết kiệm dung lượng index không đáng kể ở quy mô hiện tại. Trade-off ghi nhận ở mục 12.

**Lý do**:
- `userId String?` (D2 đã chốt): cho phép mint email-only khi email chưa có PortalUser. Dòng hiện tại `userId String` (schema.prisma:487) là ràng buộc cứng khiến API mint mới không thể tồn tại.
- `recipientEmailHash`: khóa lookup cho link-by-email. Không lưu plaintext email (D3) — content không cần biết email thật, chỉ cần hash để match.
- `preTicketId @unique`: đây là **cơ chế idempotency thực thụ** chống double-mint khi retry sau network fail. Chi tiết cơ chế ở mục 2.4. Mẫu tham khảo có sẵn trong repo: `OfflineCheckinRequest @@unique([userId, checkInRequestId])` (schema.prisma:546-555) — exact-replay trả kết quả đã lưu.
- Chiều data: mọi vé purchase-path hiện có giữ `recipientEmailHash = NULL, preTicketId = NULL` — không backfill gì, mọi query hiện có theo userId không đổi kết quả (về sau các query tổng hợp cần NULL-guard — xem mục 9 và PRD §6.3).

**Script downgrade content-service** (viết tay, kèm migration, rehearsal trên DB test trước khi chạy prod — WORKFLOW §8.2 RB3):

```sql
-- DOWNGRADE (chỉ chạy sau khi đã xử lý vé userId IS NULL theo RB3)
-- BƯỚC 0 (bắt buộc): phân loại vé unlinked
--   a) userId NULL + status = 'USED'  → KHÔNG delete. Gán placeholder userId.
--   b) userId NULL + status = 'VALID' → mặc định gán placeholder 'ROLLBACK-UNLINKED' (option an toàn);
--      option delete + sold -= 1 từng vé CHỈ khi admin duyệt từng vé (xem mục 11 RB3).
UPDATE "Ticket" SET "userId" = 'ROLLBACK-UNLINKED'
  WHERE "userId" IS NULL;  -- sau khi admin đã chọn option cho từng nhóm
-- BƯỚC 1: dọn index + cột mới
DROP INDEX IF EXISTS "Ticket_recipientEmailHash_key";
DROP INDEX IF EXISTS "Ticket_preTicketId_key";
ALTER TABLE "Ticket" DROP COLUMN IF EXISTS "recipientEmailHash";
ALTER TABLE "Ticket" DROP COLUMN IF EXISTS "preTicketId";
-- BƯỚC 2: hoàn lại NOT NULL
ALTER TABLE "Ticket" ALTER COLUMN "userId" SET NOT NULL;
```

**Trade-off đã cân nhắc và từ chối**:
- *Từ chối*: giữ `userId` non-null + tạo bảng `TicketOwnership` tách riêng — tăng 1 join cho mọi read path hiện có (`findByUserId` listMyTickets, `getTicket` ownership...), phức tạp hóa toàn bộ layer repo vì một use case. Nullable cột đơn giản hơn và Prisma/SQL xử lý ổn.
- *Từ chối*: bảng mapping `PreTicketTicketMapping(preTicketId, ticketId)` riêng — thêm 1 bảng + 1 join cho mọi mint/link/audit; cột unique trên chính Ticket đạt cùng bất biến với chi phí thấp hơn. Bảng riêng chỉ thắng khi Ticket không được phép mang cột orchestration — không phải ràng buộc của hệ thống này.
- *Từ chối*: partial index `WHERE userId IS NULL` — lý do ở trên.

### 1.2. Ticket-mayo: PreTicket enum mới + `recipientUserId` + `emailSentAt`; DistributionJob enum thêm `PARTIALLY_MINTED`

**Phương án chốt** (migration mới, đi sau migration content trên cùng release train):

```prisma
// ticket-mayo/prisma/schema.prisma
enum PreTicketStatus {
  PENDING
  MINTING    // ← MỚI: đã lock, đang gọi content mint
  MINTED     // ← MỚI: mint xong, đã có contentTicketId
  LINKED     // ← MỚI: email-only đã link userId qua sync (terminal cho vòng phát hành)
  CLAIMING
  CLAIMED
  EXPIRED
}

enum DistributionStatus {
  PENDING
  RUNNING
  COMPLETED
  FAILED
  PARTIALLY_MINTED  // ← MỚI: một phần PreTicket MINTED, một phần còn PENDING sau retry
}

model PreTicket {
  // ... các cột hiện có (schema.prisma:70-89)
  recipientUserId   String?   // ← MỚI: PortalUser.id resolve được tại distribute (E1.4) hoặc sync
  emailSentAt       DateTime? // ← MỚI (F-05): dấu "email đã đi" per-PreTicket — chống gửi đôi khi resume
}
```

```sql
-- UPGRADE (Postgres enum + cột)
ALTER TYPE "PreTicketStatus" ADD VALUE 'MINTING';
ALTER TYPE "PreTicketStatus" ADD VALUE 'MINTED';
ALTER TYPE "PreTicketStatus" ADD VALUE 'LINKED';
ALTER TYPE "DistributionStatus" ADD VALUE 'PARTIALLY_MINTED';
ALTER TABLE "PreTicket" ADD COLUMN "recipientUserId" TEXT;
ALTER TABLE "PreTicket" ADD COLUMN "emailSentAt" TIMESTAMP(3);
-- Index phục vụ sync short-circuit: "còn PreTicket MINTED-unlinked cho hash này không?"
CREATE INDEX "PreTicket_sync_sc_idx" ON "PreTicket"("recipientEmailHash", "status");
-- Index phục vụ backfill: lấy PENDING theo ticketTypeId theo createdAt ASC
CREATE INDEX "PreTicket_backfill_idx" ON "PreTicket"("ticketTypeId", "status", "createdAt");
```

Lưu ý Postgres: `ALTER TYPE ... ADD VALUE` không chạy được trong tx có dữ liệu dùng type đó ở cùng tx mới hơn — Prisma migrate sinh mỗi ADD VALUE riêng; deploy notes cần đánh dấu. Practice an toàn: mỗi ADD VALUE một migration con hoặc dùng `COMMIT` trước khi dùng giá trị mới (PG13+ cho phép ADD VALUE trong tx nhưng vẫn không được dùng giá trị mới ngay trong tx đó).

**Script downgrade ticket-mayo**:

```sql
-- DOWNGRADE
DROP INDEX IF EXISTS "PreTicket_sync_sc_idx";
DROP INDEX IF EXISTS "PreTicket_backfill_idx";
ALTER TABLE "PreTicket" DROP COLUMN IF EXISTS "recipientUserId";
ALTER TABLE "PreTicket" DROP COLUMN IF EXISTS "emailSentAt";
-- Enum: Postgres KHÔNG hỗ trợ REMOVE VALUE. 2 option:
--   a) Để nguyên giá trị thừa (an toàn — enum cũ bỏ qua value không dùng; code cũ đọc
--      status MINTING/MINTED/LINKED sẽ không hiểu → đã xử lý ở claim-path, xem mục 8)
--   b) Thay cả type: ALTER TABLE "PreTicket" ALTER COLUMN "status" TYPE "PreTicketStatus_old"
--      USING status::text::PreTicketStatus_old — cần tạo type mới trước, rewrite toàn bộ table.
--      Chỉ làm khi buộc (ví dụ data lớn có status mới cần convert về CLAIMED).
```

**Lý do**:
- Enum states mới là điều kiện sống còn của eager flow: không có MINTING thì không lock chống concurrent-mint; không có MINTED thì không phân biệt "đã mint chờ link" với "chưa mint"; không có LINKED thì short-circuit sync không bao giờ true (Workflow F-03 — chi tiết mục 5).
- `recipientUserId` ghi tại distribute (E1.4) cho email trùng PortalUser — nhờ đó sync-flow không phải query lại; và là điều kiện short-circuit "đã resolve xong" cho PreTicket có user.
- `emailSentAt` (F-05): `dispatchBatch` hiện tại chỉ đếm dispatched/failed ở mức job (`distribution.service.ts:140-148`), không biết email nào đã đi — resume job sẽ gửi đôi.
- `PARTIALLY_MINTED` (Workflow §1.2): cần trạng thái admin-actionable "retry phần fail" riêng, khác FAILED toàn bộ (xem mục 4.5).

**Trade-off đã cân nhắc và từ chối**:
- *Từ chối*: tính `emailSentAt` gián tiếp từ `DistributionAudit` (tồn tại schema.prisma:91-100) — query phức tạp, ràng buộc vào việc audit luôn ghi, và audit ghi sau email đi (có cửa sổ crash giữa "email đi" và "audit ghi xong" → vẫn gửi đôi). Cột trực tiếp trên PreTicket là nguồn sự thật duy nhất, set ngay sau SMTP ack.
- *Từ chối*: bảng `EmailLog` riêng — over-engineering cho nhu cầu "biết email nào đã đi"; nếu sau cần content/subject/bounce tracking thì thêm bảng sau.
- *Từ chối*: dùng `claimedAt` + status làm dấu email — semantics lẫn lộn (claimedAt là dấu claim, không phải dấu email), sẽ sai khi EAGER không có claim.

### 1.3. Thứ tự migration giữa 2 repo

Content-service trước, ticket-mayo sau — chi tiết deploy order và lý do ở mục 8. Migration content_pivot `20260826112000` của ticket-mayo (chưa chạy trên DB — PRD evidence #9) là migration pivot schema cũ, chạy trước phần lớn trong pre-flight D1.1.

---

## 2. Mint API contract (C-1)

### 2.1. Endpoint + guard

```
POST /content-service/internal/distribution/mint
Header: x-service-token: <INTERNAL_SERVICE_TOKEN>
```

- Controller đặt cùng `InternalDistributionController` hiện có — toàn controller đã `@UseGuards(ServiceTokenGuard)` (`internal-distribution.controller.ts:33-35`), endpoint mới tự hưởng guard, không thêm surface auth mới.
- KHÔNG nhận bất kỳ user identity nào từ client. `userId` trong payload (nếu có) là dữ liệu nghiệp vụ do ticket-mayo (service đã xác thực bằng x-service-token) cung cấp, không phải delegated identity. Nguyên tắc: content-service có blocker audit JWT/x-user-id bypass — mint API theo cùng nguyên tắc internal-only đã chuẩn hóa.

### 2.2. DTO

```ts
// content-service/src/infrastructure/driving-adapters/http-rest/dts/req/internal-distribution.dto.ts
export class InternalMintTicketsDto {
  @IsString() @IsNotEmpty() eventId: string;
  @IsString() @IsNotEmpty() ticketTypeId: string;
  @IsString() @IsOptional() idempotencyKey?: string;  // = jobId ticket-mayo, chỉ để audit/log
  @ArrayMaxSize(1000) @ValidateNested({ each: true })
  recipients: MintRecipientDto[];
}

export class MintRecipientDto {
  @IsString() @IsNotEmpty() preTicketId: string;   // idempotency domain key
  @IsString() @IsHex() @Length(64, 64) emailHash: string;  // HMAC-SHA256 hex
  @IsString() @IsOptional() userId?: string | null; // PortalUser.id nếu email đã có tài khoản
}
```

Đối chiếu DTO hiện tại: `InternalIssueTicketsDto` (internal-distribution.dto.ts:18-42) có `userId @IsString() @IsNotEmpty()` (dòng 33-35) — bắt buộc non-empty, không mint email-only được. Mint DTO mới tách bạch: userId là optional per-recipient.

### 2.3. Response

```ts
// 200 OK
{
  results: Array<{
    preTicketId: string;
    ticketId: string;       // trừ khi mục error
    ticketCode: string;     // trừ khi mục error
    alreadyMinted: boolean; // true nếu Ticket với preTicketId này đã tồn tại (retry hit)
    error?: 'EMAIL_HASH_INVALID';  // chỉ khi validation từng dòng fail — batch còn lại vẫn mint
  }>;
  soldAfter: number;  // TicketType.sold sau batch — để ticket-mayo đối chiếu reconciliation
}
```

### 2.4. Cơ chế idempotency chống double-mint khi retry sau network fail

**Đây là trái tim của contract.** Kịch bản nguy hiểm: content commit mint xong → response mất trên mạng → ticket-mayo tưởng fail → retry → không có idempotency thì mint đôi.

**Phương án chốt**: `Ticket.preTicketId @unique` — bên trong mint tx, trước khi createMany:

1. `SELECT ... FROM "Ticket" WHERE "preTicketId" IN (batch) FOR UPDATE` — khoá các dòng (nếu có) đang map preTicketId này.
2. Nhóm recipients: (i) đã có Ticket (`alreadyMinted`), (ii) mint mới.
3. Với nhóm mint mới: `UPDATE "TicketType" SET sold = sold + :N WHERE id = :id AND sold + :N <= quantity` — **0 row affected = quota fail → rollback toàn tx → 409** (cùng tx, row-lock TicketType tự nhiên có nhờ UPDATE).
4. `nextTicketCodes` sequence + createMany Ticket mới với preTicketId/emailHash/userId per recipient.
5. Commit. Retry sau đó: bước 1 bắt lại toàn bộ như `alreadyMinted` → trả ticket cũ, sold không tăng lần 2.

**Lý do chọn unique-column thay vì idempotency-table riêng**: cùng bất biến "at-most-1 Ticket per preTicketId" nhưng không thêm bảng/join; unique constraint là network-fail-safe tuyệt đối (ngay cả khi application logic lỗi, DB constraint chặn dòng thứ 2). Trùng triết lý `OfflineCheckinRequest` (schema.prisma:546-555) — exact-replay no-op.

**Xử lý batch chứa một phần đã mint (retry partial)**: không cần trường hợp đặc biệt — mọi recipient mang preTicketId đã có Ticket được trả về như `alreadyMinted: true` kèm ticketId cũ; recipients mới mint bình thường. Quota check chỉ tính nhóm mint mới. Đây chính là cơ chế WF1-R1 resume dựa vào (Workflow F-02: "idempotency-hit với job RUNNING là dead-end" — được hóa giải vì re-gọi mint với cùng danh sách preTicketId là an toàn tuyệt đối).

**Batch > 1000**: client-side chunking — ticket-mayo chia recipients thành chunk ≤ 1000, gọi mint tuần tự từng chunk, gộp kết quả (mỗi chunk 1 tx; nếu chunk k fail quota thì chunk k..end không gọi — phản hồi per-chunk tổng hợp). Không làm server-side chunking để giữ tx nhỏ (1000 insert + 1 update + bảo trì index < 2s trên PG mặc định).

**Trade-off đã cân nhắc và từ chối**:
- *Từ chối*: idempotencyKey duy nhất cho toàn batch (không per-recipient) — một jobId replay khi job đã PARTIALLY_MINTED sẽ không phân biệt được recipient nào đã mint; per-preTicketId là granularity đúng của bất biến nghiệp vụ.
- *Từ chối*: bảng `MintRequest` idempotency-table — thêm indirection; unique column đạt cùng đảm bảo.
- *Từ chối*: check-then-act như `issueTickets` hiện tại (`internal-ticket-distribution.service.ts:166-191` check ngoài tx, `registerTicketsWithTx` ticket.repository.adapter.ts:250-287 tăng sold trong tx nhưng không re-check) — đây chính là F-01 Critical; mint API mới không được lặp pattern này.

### 2.5. Error codes

| HTTP | Code | Khi nào | Caller xử |
|---|---|---|---|
| 400 | VALIDATION_ERROR | DTO sai, emailHash không hex64, recipients rỗng | Fix caller; không retry cùng payload |
| 404 | TICKET_TYPE_NOT_FOUND | ticketTypeId không thuộc eventId | Thông báo admin; không retry |
| 409 | TICKET_SOLD_OUT | `sold + N > quantity` trong tx (row-locked) | Thông báo admin kèm remaining/requested từ message; WF1-F2 |
| 409 | TICKET_QUOTA_EXCEEDED | quantity ≤ 0 | Thông báo admin; không retry |
| 500/503 | — | Lỗi hệ thống | Retry idempotent theo WF1-F1 |

Message format 409 giữ nguyên pattern `issueTickets` hiện có: `Hết vé hoặc vượt quota: remaining=X, yêu cầu=Y.` (internal-ticket-distribution.service.ts:187) — ticket-mayo đã parse được pattern này để hiển thị admin.

### 2.6. Audit + logging content-side

- Log mỗi mint call: jobId (idempotencyKey), ticketTypeId, số recipients mint mới / alreadyMinted, sold trước/sau. KHÔNG log plaintext email — payload chỉ có hash (đã là dạng an toàn).
- Không thêm audit-table content-side: `sold` và `Ticket` rows chính là record; ticket-mayo `DistributionAudit` (schema.prisma:91-100) là audit orchestration.

---

## 3. Link-by-email contract (C-2)

### 3.1. Endpoint + DTO + response

```
POST /content-service/internal/distribution/link-by-email
Header: x-service-token
{ "emailHash": "<hex64>", "userId": "<PortalUser.id>" }

→ 200 { "linked": N, "ticketIds": ["..."] }   // N ≥ 0; N=0 idempotent hợp lệ
```

Trả thêm `ticketIds` (không bắt buộc tiêu thụ) để ticket-mayo đối chiếu và cho QA verify — chi phí thấp (RETURNING id), giá trị debug cao. Workflow doc C-2 chỉ định `{linked: N}`; thêm ticketIds là extend tương thích (thêm field, không đổi semantics).

### 3.2. Scope: mọi Ticket email-only của hash, MỌI EVENT

**Phương án chốt**: scope toàn hệ thống — `UPDATE ticket SET userId = :userId WHERE recipientEmailHash = :emailHash AND userId IS NULL` không lọc eventId.

**Lý do**: (1) Đây là ngữ nghĩa "tài khoản này sở hữu mọi vé gửi tới email của tôi" — đúng kỳ vọng người dùng khi họ đăng ký sau khi nhận nhiều đợt vé khác nhau; (2) hash là khóa định danh vững (HMAC với pepper chung lifecycle); (3) giới hạn theo event bắt buộc thêm tham số + logic "event nào tính, event nào không" không có tiêu chí nghiệp vụ rõ.

**Race 2 request đồng thời (cùng hash, khác userId — vd 2 tài khoản cùng email không thể xảy ra vì PortalUser.emailHash @unique schema.prisma:41)**: khác hash thì đụng dòng khác; cùng hash phải cùng userId (vì PortalUser unique) → 2 request chỉ có thể cùng target → single UPDATE với guard `userId IS NULL` — PostgreSQL tuần tự hóa trên cùng dòng (row lock), request sau update 0 dòng, trả linked=0. Không duplicate, không lỗi.

**Response**: `{linked: N, ticketIds}` — caller dùng N cho response field `claimedTickets` (giữ tên field register/login hiện có); ticketIds chỉ để log/audit.

> **Deviation T6 (chốt sau implement)**: `syncTicketsByEmail` trả về `updateMany.count` (số PreTicket ticket-mayo mark LINKED), KHÔNG phải N của content. Lý do: (1) con số user quan tâm là "bao nhiêu vé của TÔI vừa được nhận" = số PreTicket mark LINKED; content N có thể gồm vé từ nguồn khác (không có PreTicket tương ứng); (2) crash giữa S3-S4 (content đã link, ticket-mayo chưa mark) → trigger kế tự hoàn tất bằng updateMany, và count phản ánh đúng số PreTicket được đánh dấu ở lần chạy đó. Log đối chiếu: audit PRETICKET_SYNCED ghi cả `linked` (updateMany.count) và `contentLinked` (N của content) để reconciliation.

**Trade-off đã cân nhắc và từ chối**:
- *Từ chối*: trả về danh sách Ticket full object — over-fetch; ticket-mayo không cần (list-my-tickets sẽ query getUserTickets ngay sau).
- *Từ chối*: giới hạn scope theo eventId — tạo ngã rẽ nghiệp vụ không rõ ràng; nếu sau này cần "chỉ link vé event X" thì thêm optional param eventId, không phá compat.
- Ghi nhận risk: toàn hệ thống nghĩa là admin phát nhầm email (ví dụ email của user A nhập vào đợt phát cho sự kiện khác) sẽ link hết về A khi A sync. Đây là hành vi đúng của "email là identity" — muốn khác phải đổi ở tầng nhập liệu admin (dedupe/cảnh báo), không phải tầng link.

---

## 4. distribute() EAGER + giải T5

### 4.1. Flow mới đầy đủ (flag EAGER)

```
E1.1 IDEMPOTENCY CHECK — giữ nguyên (distribution.service.ts:32-40)
    + MỚI: job RUNNING → RESUME (không phải no-op) — xem 4.4
E1.2 RESOLVE TT + PRE-CHECK QUOTA (fail nhanh, không tạo gì)
E1.3 NORMALIZE + DEDUPE — giữ nguyên (distribution.service.ts:186-198)
E1.4 RESOLVE userId TỪNG EMAIL — MỚI: portalUser.findMany({ emailHash IN })
    (cùng DB ticket-mayo, không HTTP — PortalUser model schema.prisma:38-49)
E1.5 TX: tạo Job(RUNNING) + createMany PreTicket(PENDING, kèm recipientUserId)
    — giữ nguyên cấu trúc tx hiện tại (distribution.service.ts:69-96)
E1.6 LOCK: updateMany PENDING→MINTING (batch, guard status='PENDING')
    — tái dùng pattern CLAIMING lock (ticket.service.ts:54-58)
E1.7 MINT: POST /internal/distribution/mint (chunk ≤ 1000)
    ├─ 200 → E1.8
    ├─ timeout → retry 1 lần (backoff 5s) → vẫn fail → rollback MINTING→PENDING + job FAILED/PARTIALLY_MINTED
    ├─ 409 TICKET_SOLD_OUT → rollback MINTING→PENDING, job FAILED (reason quota), 0 email
    ├─ per-recipient error → PreTicket lỗi rollback PENDING, PreTicket ok → MINTED, job PARTIALLY_MINTED
    └─ 5xx khác → như timeout path
E1.8 UPDATE PreTicket → MINTED (contentTicketId, contentTicketCode) — per-recipient updateMany guard status='MINTING'
E1.9 EMAIL: dispatchBatch CHỈ cho PreTicket MINTED; set emailSentAt sau mỗi email ack
E1.10 FINALIZE JOB: sent/failed + status COMPLETED / PARTIALLY_MINTED / FAILED theo bảng WF §1.2
```

### 4.2. GIẢI QUYẾT T5 — phân tích 3 phương án, chốt phương án (b) cải tiến

Bối cảnh rủi ro (T5/PLAN): code hiện tại tạo PreTicket PENDING **trước** khi có vé thật (LAZY design). Khi EAGER mint fail và admin distribute lại → PreTicket mới tạo → mint → có thể vượt quota thật (double ticket với số PreTicket mồ côi).

**Phương án (a) — Chặn/kiểm quota trước khi tạo PreTicket**: thêm pre-check `tt.sold + seeds.length > tt.quantity` tại E1.2 → từ chối tạo job.
- Ưu: fail nhanh, admin thấy lỗi trước khi tạo bất kỳ dòng nào.
- Nhược: **check-then-act lần nữa** — pre-check đọc `sold` có thể stale (2 admin đồng thời đều pass pre-check rồi cùng mint → một bên 409 ở mint tx). Pre-check không thể là guard cuối; nó chỉ giảm tỷ lệ job dở dang. Vẫn cần xử lý 409 ở E1.7 như thường.

**Phương án (b) — Chỉ tạo PreTicket sau khi mint thành công**: đảo thứ tự — gọi mint trước (danh sách emailHash + userId), mint ok mới tạo PreTicket MINTED.
- Ưu: về lý thuyết không bao giờ có PreTicket mồ côi.
- Nhược NGHIÊM TRỌNG: **preTicketId là idempotency key của mint** (mục 2.4) — mint trước khi có PreTicket.id đồng nghĩa preTicketId phải là id "định trước" (client-generated UUID). Điều này phá cấu trúc hiện tại (`@default(uuid())` DB-side) và — quan trọng hơn — nếu mint thành công nhưng tx tạo PreTicket fail sau đó (hoặc crash), content đã có Ticket với preTicketId mà ticket-mayo KHÔNG có dòng PreTicket tương ứng → mất khả năng trace/reconciliation vĩnh viễn (Ticket mồ côi chiều ngược lại, khó phát hiện hơn). Và email claimToken chỉ sinh được khi có PreTicket → mint-before-create khiến claimToken-email coupling phức tạp.

**Phương án (c) — Cleanup orphan PreTicket khi retry**: tạo PreTicket như cũ; khi admin retry (job FAILED), trước khi mint lại, quét PreTicket PENDING của job cũ → EXPIRED.
- Ưu: đơn giản về mặt ý tưởng.
- Nhược: (1) auto-EXPIRED PreTicket mâu thuẫn với Q3 đã chốt (EXPIRED là quyết định backfill/admin, không phải auto-cleanup runtime); (2) nếu mint thực ra THÀNH CÔNG nhưng response mất (network fail) thì PreTicket bị đánh EXPIRED trong khi Ticket đã tồn tại ở content → bất biến 1-1 PreTicket↔Ticket bị phá mà không có detection; (3) force retry tạo job MỚI → mint lại với preTicketId MỚI → double-mint thật (đúng phân tích F-02).

**CHỐT: phương án (a) + (b)-lock cải tiến** — cụ thể:
1. **Pre-check quota tại E1.2** (fail nhanh, giảm job dở dang) — guard nghiệp vụ đầu.
2. **PreTicket vẫn tạo TRƯỚC mint** (trong tx E1.5) vì preTicketId cần tồn tại làm idempotency key — nhưng **lock MINTING trước HTTP** (E1.6) và **idempotency content theo preTicketId** (mục 2.4) khiến retry an toàn tuyệt đối: mint lại cùng preTicketId → `alreadyMinted: true` → không double.
3. **KHÔNG cleanup-on-retry**. Orphan PreTicket PENDING (job FAILED) được xử bằng: (i) WF1-R2 retry per-PreTicket (mint tiếp với cùng preTicketId), hoặc (ii) backfill WF4 (EXPIRED + audit khi hết quota). Không có con đường nào tự động EXPIRED PreTicket có thể đã mint.

Tóm lại T5 được hóa giải bởi **bất biến idempotency content-side**, không phải bởi thao tác dọn dẹp phía ticket-mayo. Lock MINTING chỉ chống concurrent-mint trong cùng process window; idempotency content là guard chống double-mint xuyên suốt crash/retry/replay.

### 4.3. Tại sao rollback MINTING→PENDING an toàn (PT-3) nhưng MINTING-stuck thì KHÔNG tự rollback

- **Caught-fail** (nhận response lỗi rõ ràng 4xx/5xx hoặc timeout đã retry): content ĐÃ rollback tx hoặc không commit → chắc chắn chưa mint → rollback MINTING→PENDING an toàn.
- **Crash giữa chừng** (process chết, không có catch): không biết content đã commit chưa → KHÔNG tự rollback về PENDING (sẽ mở đường mint lại với... chính preTicketId đó — may rằng idempotent — nhưng trạng thái PENDING làm admin/UI hiểu sai "chưa mint" trong khi Ticket có thể đã tồn tại). MINTING stuck > 10 phút = alert, chỉ thoát bằng WF1-R1 resume (re-gọi mint idempotent — Workflow §1.1 quy ước).

### 4.4. Resume job RUNNING (F-02) — thay đổi idempotency-hit hiện tại

Code hiện tại: idempotency-hit trả job cũ và bỏ qua (distribution.service.ts:36-39) — job crash giữa chừng kẹt vĩnh viễn. Thiết kế mới:
- Job status RUNNING + tồn tại PreTicket MINTING-stuck/PENDING → chạy tiếp: PreTicket MINTING → re-gọi mint (idempotent) → MINTED; PreTicket PENDING → E1.6-E1.8; email chỉ cho MINTED **chưa có emailSentAt** (F-05).
- Job COMPLETED/FAILED/PARTIALLY_MINTED → trả job cũ nguyên trạng (giữ behavior hiện tại).

### 4.5. Job PARTIALLY_MINTED + retry per-PreTicket (F-04)

- Finalize E1.10: 0 MINTED → FAILED; một phần MINTED → PARTIALLY_MINTED (enum mới mục 1.2); 100% MINTED → COMPLETED (email fail từng cái không làm job fail — đếm vào `failed` như hiện tại).
- Admin action "Retry phần fail" (UI job list): guard job PARTIALLY_MINTED → chạy E1.6-E1.9 chỉ cho PreTicket PENDING của job — **không phải** re-submit idempotencyKey (đó là no-op trả job cũ, F-04 đã chỉ ra).

### 4.6. emailSentAt (F-05)

- `dispatchBatch` hiện tại per-email try/catch trả `{dispatched, failed}` tổng (distribution.service.ts:140). Thiết kế: sau mỗi email ack thành công, `preTicket.update({ emailSentAt: new Date() })` per-PreTicket. Email fail: emailSentAt NULL — resume sẽ gửi lại (chấp nhận gửi lại email lỗi, không bao giờ bỏ sót).
- Trade-off từ chối: batch-update emailSentAt sau cả dispatchBatch — mất dấu nếu crash giữa batch.

**Trade-off tổng hợp mục 4 đã từ chối**: synctime flag đọc giữa chừng flow (đọc flag 1 lần ở entrance — WF5 §7.2); mint-song-song-async (queue/worker tách rời request admin — over-engineering giai đoạn này, giữ synchronous orchestration trong `distribute()` như hiện tại, ghi nhận con đường nâng cấp: BullMQ worker nếu batch lớn làm request admin timeout).

---

## 5. Sync flow + short-circuit + race

### 5.1. Sync flow chuẩn (WF2)

```
S1. TRIGGER: register | login | list-my-tickets (ticket-mayo, user đã xác thực)
S2. SHORT-CIRCUIT: preTicket.findFirst({
      where: { recipientEmailHash: emailHash, status: 'MINTED', recipientUserId: null }
    }) === null
    → BỎ QUA sync (0 HTTP call) — request gốc tiếp tục
S3. POST link-by-email (C-2)
    ├─ 200 {linked: N} → S4
    └─ timeout/5xx → S-FAIL: KHÔNG throw; claimedTickets=0; log warn
S4. MARK LINKED: preTicket.updateMany({
      where: { recipientEmailHash: emailHash, status: 'MINTED', recipientUserId: null },
      data: { status: 'LINKED', recipientUserId: userId }
    }) — kể cả khi N=0 (an toàn: mọi vé của hash giờ đều có userId hoặc không tồn tại)
S5. REQUEST GỐC TIẾP TỤC (listMyTickets → getUserTickets như hiện có)
```

Short-circuit query dùng index mới `PreTicket_sync_sc_idx (recipientEmailHash, status)` (mục 1.2) — sub-20ms kể cả khi bảng lớn.

### 5.2. Race: user login đúng lúc distribute đang MINTING

Kịch bản: admin phát cho email E; PreTicket E đang MINTING (đã lock, HTTP mint đang bay); user E login cùng lúc.

- Sync S2 không thấy MINTED (status MINTING) → short-circuit true → bỏ qua → PreTicket sẽ MINTED-unlinked → **trigger kế tiếp** (login sau/list) sẽ bắt và link. Không mất dữ liệu.
- Ngược lại nếu mint resolve được userId ngay ở E1.4 (user đã có PortalUser trước distribute) → Ticket mint kèm userId → không cần link → sync short-circuit tự nhiên (không có MINTED-unlinked).
- Trường hợp admin phát email E khi user E đang register (E1.4 query PortalUser không thấy vì tx user chưa commit): vé mint email-only → sync lần kế của user E link. Hai chiều đều khép kín.

### 5.3. Race: 2 trigger đồng thời cùng user

login + list-my-tickets cùng lúc: cả 2 thấy MINTED-unlinked (short-circuit false) → cả 2 gọi link-by-email → UPDATE row-guard tuần tự hóa → call sau linked=0 → cả 2 mark LINKED (updateMany guard status MINTED — call sau update 0 dòng, vô hại). Không duplicate, không lỗi. (Chi tiết C-2 race ở mục 3.2.)

### 5.4. Giai đoạn chuyển tiếp: chạy CẢ HAI path (F-09)

Khi flag EAGER nhưng vẫn còn PreTicket PENDING cũ (trước backfill): 3 điểm trigger phải chạy `resolvePendingPreTickets` cũ (ticket.service.ts:31-48 — mint-on-login cho PENDING cũ) **VÀ** sync link mới. Nếu thay hoàn toàn, PreTicket PENDING cũ không bao giờ được mint cho user đã đăng ký trước backfill. Điều kiện dừng path cũ: không còn PreTicket PENDING nào tồn tại (sau backfill) → xóa code path (PRD Story G).

### 5.5. Fail-soft bắt buộc

Sync KHÔNG BAO GIỜ làm fail request gốc (register/login/list) — timeout/5xx → claimedTickets=0, log warn, PreTicket vẫn MINTED-unlinked → trigger kế tự retry. Lý do: sync là best-effort enhancement; làm fail register vì content chết là hạ availability không chấp nhận được.

**Trade-off đã từ chối**: sync qua event/Kafka tách rời request (event-driven eventual consistency) — đúng hướng dài hạn nhưng đợi consumer tăng độ trễ "đăng ký xong thấy vé ngay" (PRD Story C yêu cầu same-request), thêm infra; giữ inline sync fail-soft.

---

## 6. Backfill script (T7)

### 6.1. Thiết kế

Script ops chạy 1 lần (`ticket-mayo/scripts/backfill-pending-pretickets.ts`, chạy bằng ts-node/tsx):

```
B0. PRECONDITIONS (fail-fast nếu thiếu):
    - CONTENT_SERVICE_BASE_URL + INTERNAL_SERVICE_TOKEN reachable (ping stats)
    - flag DISTRIBUTION_MINT_MODE === 'EAGER' (guard)
    - dry-run report đã xem + admin confirm
B1. DRY-RUN (default):
    - Đếm PreTicket PENDING GROUP BY ticketTypeId
    - Với mỗi ticketTypeId: query content getTicketType → remaining = quantity - sold
    - In kế hoạch: "Loại X: n PENDING, remaining r → mint min(n,r), EXPIRED (n-r) nếu n>r"
B2. --confirm (chạy thật):
    LOOP theo ticketTypeId (remaining riêng từng loại):
      B2.1. Lấy PreTicket PENDING của ticketTypeId ORDER BY createdAt ASC
      B2.2. Batch ≤ 500: resolve recipientUserId (PortalUser có thể đã register từ khi phát)
            → lock PENDING→MINTING → gọi C-1 mint (chunk ≤1000 nội bộ)
            ├─ ok → MINTED (E1.8 pattern)
            ├─ 409 SOLD_OUT → GOTO B3 cho phần còn lại của LOẠI này
            └─ timeout/5xx → rollback PENDING, skip item, tiếp tục batch sau
      B2.3. KHÔNG gửi email cho backfill (đã gửi email claim-link từ đợt phát gốc —
            claim link cũ vẫn hoạt động: claim path đọc PreTicket theo claimToken,
            thấy MINTED → redirect "Vé của tôi" — WORKFLOW WF3)
B3. HẾT QUOTA của một loại:
      - Mọi PreTicket PENDING còn lại của loại → status EXPIRED
      - Audit per PreTicket: action=BACKFILL_QUOTA_EXCEEDED,
        detail={preTicketId, emailHash, ticketTypeId, jobId gốc, remainingAtFail}
      - KHÔNG email thông báo người nhận (Q3: admin liên hệ thủ công)
B4. REPORT: tổng minted / mintedWithUser / mintedEmailOnly / expired / skipped(technical)
      + audit BACKFILL_SUMMARY
```

### 6.2. Idempotency chạy lại

- Chạy lại chỉ đụng PreTicket `status: 'PENDING'` (where clause loại MINTED/LINKED/CLAIMED/EXPIRED) → không mint trùng.
- Idempotency 2 tầng: local status + content C-1 theo preTicketId.
- **EXPIRED terminal**: chạy lại KHÔNG hồi sinh kể cả khi admin tăng quantity — muốn phát lại cho người đó → job phát hành MỚI (Q3 chốt).
- Technical-fail items stays PENDING → chạy lại tự nhặt.

### 6.3. Tại sao không gửi email trong backfill

Email claim-link đã gửi từ đợt phát gốc LAZY. Claim-link cũ theo claimToken (unique, không đổi) → click sẽ vào WF3 path MINTED → redirect xem vé. Gửi email mới = spam + tốn quota SMTP + nhầm lẫn người nhận. Ngoại lệ duy nhất: nếu sau này có PreTicket PENDING chưa từng có email (không có trong dữ liệu hiện tại — mọi PENDING đều đi qua dispatchBatch), thì cần gửi — guard bằng emailSentAt IS NULL.

**Trade-off đã từ chối**: backfill qua HTTP admin API (thay vì script trực tiếp DB) — thêm surface API dùng 1 lần; script ops ts-node gọi cùng service layer (Prisma + ContentClient) là đủ và dễ audit.

---

## 7. Error translation quota (T5)

### 7.1. Chuỗi dịch lỗi

```
content mint tx: UPDATE ... WHERE sold + N <= quantity → 0 row
  → BusinessException(TICKET_SOLD_OUT, 409,
      "Hết vé hoặc vượt quota: remaining=R, yêu cầu=N.")
  → [HTTP] ticket-mayo ContentClientService.request() !res.ok
  → BadGatewayException("content-service: Hết vé...")   // content-client.service.ts:43-53
  → distribute() catch → ServiceUnavailable/Conflict cho admin:
      4xx { status: 409, message: "Hết vé hoặc vượt quota: remaining=10, yêu cầu=15.",
            code: 'TICKET_SOLD_OUT', remaining: 10, requested: 15 }
```

Cải tiến nhỏ so với hiện tại: `ContentClientService` hiện gộp mọi !res.ok thành `BadGatewayException` (502) (content-client.service.ts:43-53) — kể cả khi content trả 409 nghiệp vụ. Thiết kế: mint path phân tích status content; 409 (và các 4xx nghiệp vụ) chuyển thành `ConflictException` (409) giữ nguyên message + parse `remaining=`/`yêu cầu=` thành field số. Nguyên tắc: **4xx nghiệp vụ từ nguồn sự thật KHÔNG BAO GIỜ thành 500/502 phía admin** — admin cần thấy remaining thật để quyết định giảm số lượng.

### 7.2. Pre-check E1.2 (fail nhanh trước khi tạo job)

`tt.sold + seeds.length > tt.quantity` (từ getTicketTypeWithEvent response — remaining có thể stale) → 4xx ngay kèm remaining/requested, không tạo job/PreTicket/mint/email. Guard cuối vẫn là mint tx (F-01/R9). Message format đồng nhất 7.1.

**Trade-off đã từ chối**: bắt mọi lỗi content thành "Phát vé thất bại, thử lại" chung chung — mất thông tin remaining; admin giảm số lượng phát là recovery path chính, cần số.

---

### 7.3. Hiện trạng getTicket ownership (liên quan mục 8-9)

`getTicket` hiện `ticket.userId !== userId` → FORBIDDEN (internal-ticket-distribution.service.ts:216-227). Khi userId nullable: `null !== 'xxx'` vẫn true → 403 — null-safe tự nhiên cho vé unlinked. KHÔNG CẦN đổi code. QA regression test bắt buộc (WORKFLOW TC-W6-xx).

---

## 8. Backward-compat 2 mode song song + deploy order + smoke test

### 8.1. Flag `DISTRIBUTION_MINT_MODE=LAZY|EAGER`

```ts
// ticket-mayo/src/config/env.ts — thêm
export enum DistributionMintMode { Lazy = 'lazy', Eager = 'eager' }
@IsEnum(DistributionMintMode)
DISTRIBUTION_MINT_MODE?: DistributionMintMode;  // default Lazy
```

- Đọc MỘT LẦN tại entrance mỗi flow (distribute/sync/claim) — request chạy trọn một mode, không đổi giữa chừng.
- Default LAZY tới khi smoke test EAGER qua (PRD §5.3).
- KHÔNG migration khi đổi flag — thuần hành vi.

### 8.2. Ma trận backward-compat

| Điểm | LAZY (cũ) | EAGER (mới) | Tương thích |
|---|---|---|---|
| distribute() | PENDING thẳng tới email (hiện có) | mint trước email (mục 4) | Cùng signature, khác nhánh nội bộ |
| register/login/list sync | `resolvePendingPreTickets` (mint-on-login) | sync link-by-email (mục 5) + resolvePendingPreTickets khi còn PENDING cũ (F-09) | Hai path song song giai đoạn chuyển tiếp |
| claim-click | mint-on-click PENDING→CLAIMING→CLAIMED | Xem vé/needsAuth theo state (MINTED/LINKED/EXPIRED...) — KHÔNG mint mới | Claim path LUÔN xử mọi status (state machine là nguồn sự thật — F-08) |
| Backfill script | guard flag EAGER — không chạy | chạy | — |

Điểm mấu chốt (F-08): claim path phải là **state-first** (switch theo PreTicket.status) chứ không phải mode-first — kể cả khi flag LAZY, PreTicket MINTED (từ EAGER-era) click claim phải redirect xem vé chứ không 500. State machine (mục 1.2) là nguồn sự thật xuyên suốt; flag chỉ chọn chiến lược mint khi TẠO dữ liệu mới.

### 8.3. Deploy order (2 phase)

```
PHASE 1 — CONTENT-SERVICE TRƯỚC:
  1. prisma migrate status (nợ migration phải clear trước — kể cả content_pivot
     20260826112000 của ticket-mayo trên DB tương ứng)
  2. Migration content (mục 1.1): userId nullable + recipientEmailHash + preTicketId + index
  3. Deploy code: mint API + link API + NULL-guard cho raw SQL nơi đọc userId/sold
     (findUserIdsByEventId, countAllUserTicketCounters — xem mục 9)
  4. ticket-mayo CŨ vẫn chạy: không gọi API mới → vô hại
  5. SMOKE TEST MINT (bắt buộc trước phase 2): tạo event+ticketType test quantity nhỏ →
     curl mint 2 vé (1 có userId, 1 không) → verify 2 Ticket + sold+2 + re-gọi cùng
     preTicketId → alreadyMinted=true, sold KHÔNG tăng → link-by-email → linked đúng
  6. SMOKE QUOTA: mint vượt remaining → 409 + remaining đúng. Dọn dữ liệu test.

PHASE 2 — TICKET-MAYO SAU:
  7. Migration ticket-mayo (mục 1.2): enum + recipientUserId + emailSentAt + index
  8. Deploy code mới, DISTRIBUTION_MINT_MODE=LAZY (default) → verify regression:
     phân phát LAZY cũ vẫn chạy end-to-end
  9. BẬT EAGER per-environment (env var) → smoke 1 đợt phát thật nhỏ (2-3 email nội bộ)
     → verify mint + email + admin UI status
  10. BACKFILL (WF4) sau khi EAGER ổn định vài ngày
  11. MONITORING: mint success rate, reconciliation sold↔MINTED, sync 5xx rate
```

Lý do content trước: migration content là expand-only (add nullable columns + index) — không phá flow cũ; API mới không ai gọi cho tới khi ticket-mayo mới deploy. Đảo thứ tự = ticket-mayo mới gọi API chưa tồn tại → 502.

### 8.4. Rollback

- **Hành vi** (nhanh nhất): flag → LAZY. Claim path state-first (8.2) xử lý vé MINTED đúng — không 500 (F-08 đã cover).
- **Code ticket-mayo**: revert branch — content API mới vô hại (không ai gọi); PreTicket MINTED/LINKED từ EAGER-era tương thích schema, vé vẫn hợp lệ.
- **Migration content (Q10 — chỉ khi buộc)**: script downgrade mục 1.1 + phân loại vé unlinked theo RB3 (USED không delete — gán placeholder; VALID mặc định placeholder, delete chỉ khi admin duyệt từng vé) + rehearsal trên DB test.

---

## 9. TicketType.sold trong EAGER + nơi đọc sold

### 9.1. Thời điểm tăng sold trong EAGER

**Chốt: tăng sold NGAY trong mint tx, cùng lúc createMany Ticket** (mục 2.4 bước 3). Không có trạng thái trung gian "minted-but-not-sold" — nếu tách (mint trước, tăng sold sau bằng job riêng) sẽ mở cửa sold-throttle mismatch: purchase path đọc sold để chặn bán (Redis stock mirror — cache.service.ts initStock/finalizeStock), mint-not-yet-sold khiến purchase bán vượt quota thật.

### 9.2. Đồng bộ Redis stock mirror

Purchase path content-service đọc tồn kho từ Redis (`cache.service.ts:250-378` — initStock hmset, LUA_FINALIZE_STOCK_SCRIPT sold += qty atomic). DB `sold` là nguồn sự thật nhưng Redis là cache nóng. Mint tx tăng sold DB → Redis mirror có thể stale → purchase path thấy "còn vé" trong khi quota thật hết.

**Giải pháp**: sau khi mint tx commit, content-side gọi `cacheService.initStock(ticketTypeId, quantity, soldMới, maxQuota)` (hoặc HINCRBY sold) để refresh mirror. Nếu Redis refresh fail: ghi log error + alert — purchase path có thể bán vượt trong cửa sổ stale (risk chấp nhận, đã có quota-guard cuối ở purchase tx tương tự mint tx). Ghi nhận: đây là điểm cần review thêm ở vòng phản biện — hiện `initStock` chỉ chạy khi cache miss (ticket.service.ts:823), cách gọi lại từ mint path cần xác nhận không phá TTL/logic hiện có.

### 9.3. Danh sách nơi đọc `sold` trong content-service (impact audit)

| Vị trí | Cách dùng | Impact EAGER |
|---|---|---|
| `internal-ticket-distribution.service.ts:185,187` | Quota check issueTickets (LAZY claim path) | Không đổi — mint API mới có check riêng trong tx |
| `internal-ticket-distribution.service.ts:366-367` | mapTicketType trả sold/remaining cho admin UI ticket-mayo | Số phản ánh mint EAGER — đúng ý đồ |
| `ticket.repository.adapter.ts:482,488` | Overview soldTickets/soldQuantity/soldPct | Đếm đủ — mint EAGER tăng đúng |
| `ticket-type.service.ts:114` | Thông tin loại vé (admin) | Đúng |
| `ticket-type.service.ts:205` | sold = userId ? userCount : tt.sold — check maxTicketsPerUser | Cần NULL-aware: vé unlinked không thuộc user nào — userCount theo userId cụ thể không đếm vé NULL → an toàn |
| `ticket-type.service.ts:357` | Sau update loại vé | Đúng |
| `ticket-type.service.ts:416-418` | Chặn delete ticketType khi sold > 0 | Mint EAGER tăng sold → chặn delete như purchase — đúng |
| `ticket-type.service.ts:486` | Validation | Đúng |
| `ticket.service.ts:102,162` | available = total - sold - reserved (từ Redis stock) | Đã xử ở 9.2 (đồng bộ mirror) |
| `ticket.service.ts:823` | initStock(type.id, quantity, type.sold, ...) — nạp cache từ DB sold | Sau mint, lần initStock kế (cache miss/TTL) sẽ nạp sold mới — tự đúng |
| `event.service.ts:264` | _totalRegistrations = Σ sold | Tăng đúng theo mint |
| `event.service.ts:2465` | sold trả về feed/detail | Tăng đúng |
| `event-analytics.service.ts:20-33` | Stock/percentage từ Redis stock | Qua 9.2 |
| `ticketType.respon.dto.ts:28-30` | soldOut = sold >= quantity | Đúng — mint EAGER có thể làm soldOut sớm hơn (trước khi ai claim) — đúng ngữ nghĩa eager |

### 9.4. Raw SQL NULL-guard (PRD §6.3)

Khi `userId` nullable, các raw SQL aggregation theo userId cần NULL-guard:

| Query | Vị trí | Hiện trạng | Hành động |
|---|---|---|---|
| `findUserIdsByEventId` | ticket.repository.adapter.ts:314-350 | UNION Ticket+Reservation KHÔNG IS NOT NULL | **Sửa**: thêm `WHERE userId IS NOT NULL` nhánh Ticket |
| `getTicketOwnerIds` | ticket.repository.adapter.ts:556-569 | ĐÃ có `IS NOT NULL` (dòng 565) | Giữ nguyên |
| `getTicketCountByEventIds` | adapter:383-409 | ARRAY_AGG(DISTINCT userId) | ARRAY_AGG bỏ NULL tự nhiên — verify bằng test |
| `countAllUserTicketCounters` | adapter:673-697 | GROUP BY userId UNION ALL Ticket VALID + Reservation PENDING | **Sửa**: thêm WHERE userId IS NOT NULL nhánh Ticket — tránh NULL-bucket đếm tổng vé unlinked như "1 user" |
| `findParticipatedEventIdsByUserAndCommunities` | adapter:353-379 | Theo userId cụ thể | An toàn — NULL không match |

---

### 9.5. Rà soát raw SQL bắt buộc trước merge

Ngoài các query mục 9.4, rà soát bắt buộc trước merge mọi raw SQL trong content-service có GROUP BY / DISTINCT / UNION trên `Ticket.userId`. Công cụ: grep `ticket.repository.adapter.ts` + toàn bộ adapter pattern `$queryRaw`/`$queryRawUnsafe` với chuỗi `"userId"`. Mỗi query sửa phải kèm test regression với fixture vé unlinked (WORKFLOW D2.2).

---

## 10. Xác nhận giả định hash/pepper

| Giả định | Xác nhận | Cite |
|---|---|---|
| emailHash = HMAC-SHA256(pepper, email.toLowerCase().trim()) hex | ĐÚNG | ticket-mayo `email-hash.util.ts:19-25` — createHmac('sha256', pepper).update(normalize).digest('hex') |
| Pepper là `FIELD_ENCRYPTION_PEPPER` của ticket-mayo, required ≥16 chars | ĐÚNG | env.ts:23-24 + email-hash.util.ts:20-23 |
| Normalize trùng user-community generateBlindIndex (toLowerCase().trim()) | ĐÚNG | email-hash.util.ts:5-10 chú thích match `crypto-gcm.util.ts:128` |
| PortalUser.emailHash unique | ĐÚNG | schema.prisma:41 |
| Content-service KHÔNG có pepper, KHÔNG bao giờ thấy plaintext email | ĐÚNG — thiết kế giữ nguyên | Mint payload chỉ chứa emailHash hex64 (mục 2.2); content không có biến pepper nào |
| Content chỉ nhận + lưu emailHash (không recompute, không verify pepper) | ĐÚNG | recipientEmailHash là opaque string cho content — chỉ dùng để WHERE match |
| Pepper drift giữa môi trường = hash mismatch = sync chết im lặng | RỦI RO ghi nhận (F-07) | Monitoring linked-count + pre-flight D1.2 verify env; đổi pepper = mọi hash cũ vô dụng — coi như incident |

Bất biến truyền hash: ticket-mayo là CƠ SỞ DUY NHẤT tính hash (cùng pepper với PortalUser emailHash) → gửi emailHash qua API → content lưu + match. Không bao giờ gửi plaintext email qua internal API mint (payload chỉ hash), không bao giờ log hash kèm email.

---

## 11. Đối chiếu findings Workflow Architect (F-01..F-11, RB3, C-1/C-2, PARTIALLY_MINTED)

| Finding | Đánh giá | Thiết kế phản hồi |
|---|---|---|
| **F-01 Critical** — issueTickets check-then-act ngoài tx (internal-ticket-distribution.service.ts:166-191); mint API phải check+increment cùng tx row-lock | **CHẤP NHẬN** — đã verify code đúng như finding | Mint tx: `UPDATE TicketType SET sold = sold + N WHERE id AND sold + N <= quantity` — 0-row = rollback toàn tx + 409 (mục 2.4 bước 3). KHÔNG copy pattern cũ. Note: không dùng SELECT FOR UPDATE riêng + UPDATE sau — dùng conditional UPDATE vừa lock vừa check trong 1 statement (ít round-trip, không cửa sổ giữa check và increment). |
| **F-02 Critical** — idempotency-hit job RUNNING là dead-end; cần resume | **CHẤP NHẬN** | Mục 4.4: RUNNING + PreTicket MINTING/PENDING → resume — re-gọi mint idempotent theo preTicketId; email chỉ cho chưa emailSentAt. |
| **F-03 High** — cần trạng thái LINKED cho short-circuit | **CHẤP NHẬN** | Mục 1.2: enum LINKED + transition PT-4; short-circuit query dựa MINTED-unlinked tồn tại (mục 5.1) — LINKED là terminal khi đã dọn sạch unlinked. |
| **F-04 High** — retry bằng idempotencyKey là no-op; retry thật = per-PreTicket | **CHẤP NHẬN** | Mục 4.5: action riêng "retry phần fail" cho job PARTIALLY_MINTED, chạy E1.6-E1.9 chỉ PreTicket PENDING của job. |
| **F-05 High** — thiếu dấu email đã gửi per-PreTicket | **CHẤP NHẬN** | Mục 1.2 + 4.6: cột `emailSentAt` set sau mỗi SMTP ack per-PreTicket. |
| **F-06 Medium** — mint xong SMTP chết toàn bộ → COMPLETED + audit EMAIL_ALL_FAILED | **CHẤP NHẬN** | Mục 4.1 E1.9/E1.10: mint thành công là điều kiện nghiệp vụ chính → COMPLETED + audit EMAIL_ALL_FAILED khi dispatched=0 && mọi vé MINTED. |
| **F-07 Medium** — pepper drift = sync chết im lặng | **CHẤP NHẬN** | Mục 10: pre-flight D1.2 verify pepper + monitoring linked-count (alert khi sync chạy mà linked=0 kéo dài). |
| **F-08 High** — rollback EAGER→LAZY claim path 500 nếu không xử MINTED | **CHẤP NHẬN** | Mục 8.2: claim path state-first — switch theo status xử MINTED/MINTING/LINKED/EXPIRED kể cả khi LAZY. |
| **F-09 High** — sync EAGER phải chạy CẢ resolvePendingPreTickets khi còn PENDING cũ | **CHẤP NHẬN** | Mục 5.4: song song 2 path tới khi backfill xong (0 PENDING tồn tại). |
| **F-10 High** — MINTING stuck không tự rollback; PT-3 an toàn NHỜ idempotency content | **CHẤP NHẬN** | Mục 4.3: phân biệt caught-fail (rollback an toàn) vs crash (stuck → resume). Toàn bộ dựa trên bất biến preTicketId unique (mục 2.4) — A2 của Workflow được hiện thực bằng cột unique. |
| **F-11 Medium** — vé email-only USED khi rollback migration không được delete | **CHẤP NHẬN** | Mục 1.1 downgrade: RB3 decision matrix — USED → placeholder (không delete); VALID → mặc định placeholder, delete chỉ khi admin duyệt từng vé. |
| **RB3** — downgrade phải phân loại vé unlinked | **CHẤP NHẬN** | Mục 1.1 script downgrade bước 0 + mục 8.4. |
| **C-1/C-2** | **CHẤP NHẬN, implement chi tiết** | C-1 → mục 2 (DTO, idempotency unique-column, chunking client-side ≤1000, error codes, audit). C-2 → mục 3 (thêm ticketIds field — extend tương thích). |
| **PARTIALLY_MINTED** (DistributionJob) | **CHẤP NHẬN** | Mục 1.2 enum + 4.5 retry per-PreTicket. |
| PT-1..PT-6 state machine | **CHẤP NHẬN toàn bộ** | Mục 1.2 (schema) + mục 4 (transitions) tuân theo đúng bảng PT. |

Không finding nào bị bác. Một điểm mở (không phải bác): C-2 thêm `ticketIds` — Workflow chỉ spec `{linked: N}`; thêm field là extend tương thích, ghi rõ cho vòng phản biện xem xét.

---

## 12. Trade-off tổng hợp đã cân nhắc và từ chối

| # | Phương án bị từ chối | Lý do từ chối | So với chốt |
|---|---|---|---|
| 1 | Bảng `TicketOwnership` tách thay userId nullable | Thêm join mọi read path; phức tạp repo layer | Nullable cột (D2) |
| 2 | Bảng mapping `PreTicketTicketMapping` | Thêm bảng + join; unique column đạt cùng bất biến | `Ticket.preTicketId @unique` |
| 3 | Partial index `WHERE userId IS NULL` | Prisma không diễn đạt được; drift schema; selectivity của hash cao | Index thường trên recipientEmailHash |
| 4 | idempotencyKey toàn batch (không per-recipient) | Không phân biệt recipient khi PARTIALLY_MINTED replay | preTicketId per-recipient |
| 5 | Mint-before-create PreTicket (T5 phương án b thuần) | preTicketId phải client-generated → mất DB-default + nguy cơ Ticket mồ côi chiều ngược lại khó trace | Create-then-lock-then-mint + idempotency content |
| 6 | Cleanup orphan PreTicket khi retry (T5 phương án c) | Mâu thuẫn Q3 (EXPIRED là quyết định admin/backfill); phá bất biến khi network-fail; force new-job → double-mint thật | Resume + retry per-PreTicket + backfill |
| 7 | Tính emailSentAt từ DistributionAudit | Cửa sổ crash giữa email-ack và audit-ghi; query phức tạp | Cột trực tiếp emailSentAt |
| 8 | Sync qua event/Kafka tách request | Độ trễ same-request; thêm infra | Inline sync fail-soft |
| 9 | Backfill qua HTTP admin API | Surface API dùng 1 lần; script gọi service layer đủ | Script ops ts-node |
| 10 | Server-side chunking mint >1000 | Tx lớn khóa TicketType lâu | Client-side chunk ≤1000 |
| 11 | Gộp mọi lỗi content thành 502 chung | Mất remaining cho admin recovery | Phân loại 4xx nghiệp vụ → 409 + remaining/requested |
| 12 | Bật EAGER ngay sau deploy (không giai đoạn LAZY) | Không có cửa sổ regression verify | Default LAZY + smoke + flip per-env |
| 13 | Mint async queue/worker tách request admin | Over-engineering giai đoạn này | Synchronous trong distribute(); ghi chú con đường BullMQ khi batch lớn |

---

## Vòng phản biện 1 (Backend Architect review THREAT-MODEL + UI-SPEC)

> Mỗi finding: trạng thái tự đánh giá ngay [ALIVE/DEAD] + cite. Không sửa mục thiết kế gốc trong vòng này — finding sống sẽ hội tụ ở vòng sau.

### RB-1. Đối chiếu THREAT-MODEL (Security Architect)

| # | Finding của Security | Trạng thái | Phản hồi Backend |
|---|---|---|---|
| TM-1 | A2/idempotency phải là **unique constraint DB thật**, không find-then-create (THREAT §3.1, §6.1-Q1) | [ALIVE — xác nhận DESIGN đã cover + bổ sung 2 điều kiện nghiệm thu] | `Ticket.preTicketId @unique` là DB constraint (mục 1), idempotency 5 bước là find-trước-create **trong tx** + bắt P2002. 2 khe được hỏi: (a) *batch chứa preTicketId trùng*: trong cùng tx xử lý tuần tự per-recipient thì dòng 2 thấy dòng 1 (same-tx visibility) → alreadyMinted; nhưng nếu ai tối ưu thành `createMany` thì P2002 nguyên batch → **bắt buộc de-dup preTicketId ở đầu handler** trước vào tx. (b) *2 request đua nhau cùng preTicketId*: thua cuộc ăn P2002 → catch → re-find → trả alreadyMinted. Cả 2 đưa vào contract test T3. |
| TM-2 | `===` không timing-safe (service-token.guard.ts:16 — đã verify tồn tại thật) | [ALIVE — CHẤP NHẬN vào scope, severity thực tế Minor] | Fix `crypto.timingSafeEqual` 3 dòng, rẻ — đưa vào checklist nghiệm thu mint API (bổ sung cho mục 2). Không chặn merge: token là chuỗi random ≥32 chars, chênh lệch so sánh chuỗi Node (~ns) nhỏ hơn nhiều so với network jitter của gọi ngoài — khai thác thực dụng khó. Nhưng vì guard là lớp DUY NHẤT của 2 API mới, làm luôn cùng release. |
| TM-3 | Plaintext email trong log: auth.service.ts:56,84; admin-bootstrap.service.ts:28,38 (THREAT §4.1) | [ALIVE — CHẤP NHẬN, đồng ý chặn merge] | Đã verify bằng grep: đúng 4 vị trí log `email=${...}`. Vi phạm trực tiếp PRD §8.6. Fix 1 dòng mỗi chỗ (đổi sang `emailHash=${user.emailHash}`). Thuộc scope backend ticket-mayo — thêm vào merge-gate checklist mục 8 của DESIGN ở vòng hội tụ. |
| TM-4 | Thiếu `@ArrayMaxSize` recipients + `@Max` quantity (distribute-request.dto.ts:11-18) | [ALIVE — CHẤP NHẬN] | Đã verify DTO hiện tại chỉ `@Min(1)`/`@IsArray`. Chốt số: `@ArrayMaxSize(1000)` recipients + `@Max(10)` quantity (= tối đa 10.000 PreTicket/job = 10 chunk mint — khớp giới hạn batch C-1). |
| TM-5 | Tầng 1 idempotency: key mới + cùng emailHash → PreTicket mới → double vé (THREAT §3.1) | [ALIVE một phần — chấp nhận cảnh báo (b), từ chối block cứng] | Warning khi submit job mới mà emailHash đã có PreTicket PENDING/MINTING của job khác: chấp nhận (query cùng DB ticket-mayo, rẻ, trước E1.5). KHÔNG block cứng: phát lại cho cùng email là use-case hợp lệ sau khi job trước FAILED rõ ràng. Reconciliation định kỳ (Ticket content vs PreTicket MINTED+CLAIMED) — ghi nhận là tác vụ ops, không phải code path phân phối. |
| TM-6 | Bỏ plaintext email khỏi Kafka payload (THREAT §3.7.3) | [ALIVE — đồng ý hướng đi, DEFER ra khỏi scope merge này] | Đây là hiện trạng mail-dispatcher từ thời LAZY, không phải surface mới của EAGER. Đồng ý bỏ trường `email` (chỉ giữ displayName + claimToken), nhưng phải đổi đồng bộ SMTP consumer dựng địa chỉ từ DB → follow-up task riêng, không chặn merge tính năng này. |
| TM-7 | Contract test x-user-id bị bỏ qua trên 2 route mới (THREAT §3.8) | [ALIVE — CHẤP NHẬN, rẻ] | Thêm 2 test vào T3: gọi mint/link với `x-user-id: victim` + không token → 401; với token + header → body không bị override. ServiceTokenGuard hiện chỉ đọc `x-service-token` (service-token.guard.ts:13) — giữ bất biến khi mount route. |
| TM-8 | RB3 placeholder per-row `ROLLBACK-UNLINKED-<uuid>` thay chuỗi cố định (THREAT §3.9) | [ALIVE — CHẤP NHẬN cải tiến] | Hợp lý: placeholder unique per-row chống code coi chuỗi chung là 1 user. Cập nhật downgrade script mục 1 ở vòng hội tụ. |

**Phản bác ngược THREAT-MODEL (finding của tôi trong doc Security):**

| # | Điểm | Severity | Lý do phản bác |
|---|---|---|---|
| TRB-1 | §5.9 "tắt CORS cho internal routes" như security control | Minor | CORS là cơ chế bảo vệ **browser**, không phải service-to-service. Caller của internal API là ticket-mayo (axios/node) — không gửi preflight, không tôn trọng CORS. Tắt/sửa CORS chỉ giảm noise + tấn công bề mặt Swagger, không phải control thật cho mint/link. Nên làm (hygiene) nhưng đừng đếm nó là mitigation của API mới. |
| TRB-2 | §2.1 DoS "khóa row TicketType làm nghẽn MỌI event khác dùng chung sequence `ticket_global_seq`" | Minor | `nextval` trên PostgreSQL sequence không chờ row-lock — mỗi call đọc counter chia sẻ cực nhanh, contention chỉ measurable ở hàng nghìn tx/giây. Row-lock TicketType (do UPDATE sold) là per-ticketType — KHÔNG chặn event khác. Kết luận (rate-limit nội bộ vẫn cần) đúng, nhưng cơ chế mô tả sai — đừng thiết kế mitigation theo mô hình sai. |

### RB-2. Đối chiếu UI-SPEC (UX Architect) — endpoint UI-P1..P6

| # | Đề xuất UX | Trạng thái | Chốt backend |
|---|---|---|---|
| UI-P1 | `job.mintMode: 'LAZY'\|'EAGER'` | [ALIVE — GIỮ] | Cột `mintMode` trên DistributionJob ghi **tại thời điểm distribute** (không phải flag runtime — flag đổi giữa chừng không làm đảo màu job cũ). Chính xác hơn heuristic "có mint counts" của UX. Gộp vào migration ticket-mayo + T5. |
| UI-P2 | `mintReason` / `mintedAt` per PreTicket | [ALIVE — GIỮ dạng gọn] | 2 cột nullable trên PreTicket: `mintedAt` (set khi chuyển MINTED), `lastMintError` (ghi khi fail, clear khi retry thành công) — vừa đủ cho 2 cột UI "Ghi chú lỗi"/"Tạo vé lúc", không cần bảng riêng. |
| UI-P3 | `POST /admin/distributions/:id/retry` | [ALIVE — GIỮ, gộp T5] | Chính là WF1-R2 retry per-PreTicket trong DESIGN mục 4, nâng thành admin endpoint. Guard: AdminGuard + chỉ job PARTIALLY_MINTED/FAILED + chỉ nhận PreTicket PENDING của job đó. Idempotent nhờ idempotency content theo preTicketId. |
| UI-P4 | `POST /admin/distributions/:id/resend-emails` | [ALIVE — GIỮ, gộp T5] | Guard chống email đôi (F-05): chỉ PreTicket MINTED/LINKED với `emailSentAt IS NULL`. Rèm điều kiện "email-failed" cần cột `emailFailedAt` hoặc tái dùng DistributionAudit — chốt ở vòng hội tụ, hiện chấp nhận bản `emailSentAt IS NULL`. |
| UI-P5 | `GET /admin/backfill/dry-run` + `POST /admin/backfill/run` | [DEAD một phần — CẮT run, GIỮ dry-run] | `GET dry-run`: GIỮ — read-only, expose cùng logic tính toán của script T7 (items/totals/expiringPreTickets), UI màn 2 có giá trị xem trước. `POST run`: **CẮT** — backfill mint hàng nghìn vé là long-running; qua HTTP admin sẽ ăn timeout proxy (node client của chính ticket-mayo đã 15s — content-client.service.ts), không có progress bền, mất log chuẩn của CLI. T7 script CLI giữ là run-path canonical. Nếu human muốn nút chạy: làm đúng dạng background job + poll ở lượt sau, không gộp. |
| UI-P6 | `ClaimResult += processing / expired` | [ALIVE — GIỮ, đã cover] | Khớp ma trận state-first mục 8 DESIGN (F-08). Chốt tên field: `{ processing: true }` cho MINTING, `{ expired: true }` cho EXPIRED — thêm vào claim response spec. |

**Đồng thuận khác với UI-SPEC:** empty-state + nút [Làm mới] (màn 4), cảnh báo remaining wizard (màn 5 — remaining luôn là snapshot, server 409 là guard cuối, hợp lý), badge/state hiển thị — không đụng backend.

**Phản bác UI-SPEC (finding của tôi):**

| # | Điểm | Severity | Lý do |
|---|---|---|---|
| TRB-3 | §3.5 UI bắt `code === 'TICKET_SOLD_OUT'` — thiếu điều kiện tiên quyết | Major (nếu bỏ sót thì UI-P chết khi ship) | Hiện tại content-client.service.ts:43-53 ép MỌI `!res.ok` thành `BadGatewayException` 502 — error code + remaining của content **không bao giờ tới frontend** trừ khi T5 thêm pass-through nghiệp vụ. Đây chính là mục 7 DESIGN; nhắc lại để UX không assume field `code` có sẵn. |
| TRB-4 | §4 đòi poll progress backfill `runStatus.minted/total` qua API | Minor (đã chết cùng UI-P5-run) | Nếu run bị cắt thì poll progress không còn đối tượng — dry-run không cần poll. Nhất quán cắt cả hai. |

### RB-3. Sync pending: sessionStorage client flag vs backend field

**Chốt: heuristic client ĐỦ — không thêm backend field `syncPending`.** Lý do: server không có cách trả "đang chờ sync" giá rẻ — để biết user có PreTicket MINTED-unlinked theo emailHash thì phải chạy đúng cái mà sync sẽ chạy (query + link-by-email). Nếu đã trả lời được câu hỏi đó thì cứ trả luôn kết quả sync — mà listMyTickets đã làm (sync fail-soft + banner `claimedTickets`). Field riêng chỉ có giá trị thông tin khi sync vừa fail — khi đó user cần hành động [Làm mới], copy empty-state của UX + heuristic "vừa auth trong session" đã dẫn đúng. Chi phí phương án backend: +1 HTTP call hoặc +1 query mỗi list-my-tickets cho mọi user mọi lần — không đáng.

### RB-4. Tự review 2 điểm tự flag (theo lệnh coordinator)

**(a) Sold/Redis mirror — KẾT LUẬN NÂNG CẤP: refresh mirror là BẮT BUỘC, không phải best-effort. Bỏ = Critical.**

Đã đọc code Redis stock thật (content-service):

- `initStock` chỉ chạy ở `onModuleInit` (ticket.service.ts:818-826) — nạp 1 lần khi boot, **không TTL trên key** `ticket_stock:{id}` (cache.service.ts:259-267 `hmset` không `EX`) → stale do mint kéo dài **vĩnh viễn** đến khi restart content-service, KHÔNG tự vá.
- LUA_RESERVE tính `available = total − sold − reserved` hoàn toàn từ Redis hash (cache.service.ts:222-229) — Redis sold thấp hơn DB sau mint (chưa refresh) → available **ảo cao hơn thật**.
- Purchase path ghi DB qua `registerTicketsWithTx` KHÔNG re-check quota trong tx (ticket.repository.adapter.ts:257-261 — increment thẳng, đúng F-01) → Redis là quota-guard duy nhất của purchase. Stale Redis = **bán vượt quota thật** qua purchase path ngay sau một đợt mint lớn.
- Hướng sửa chốt: sau khi mint tx commit, **re-seed absolute** từ DB: `SELECT sold FROM TicketType` → `initStock(ttId, quantity, soldMới, maxQuota)` — tự vá mọi dạng drift (kể cả race 2 mint chunk). KHÔNG dùng `HINCRBY sold` đơn thuần: nếu key chưa tồn tại (Redis vừa restart) HINCRBY tạo hash thiếu `total` → `available` âm → mọi reserve fail-closed — an toàn sai hướng (chặn bán oan), và vẫn không vá được total.

**(b) preTicketId trên bảng Ticket — GIỮ cột @unique; fallback nếu bị bác vòng hội tụ.**

Security §6.1-Q1 chấp nhận cả hai dạng (cột unique HOẶC bảng mapping) — không có phản bác trực tiếp. Giữ cột: ngữ nghĩa "vé sinh từ pre-ticket nào" thuộc domain issuance của chính bảng vé, 0 join. **Fallback đã rõ** (nếu vòng hội tụ vẫn bác về domain boundary): bảng content-side `TicketIssuanceMapping(ticketId @unique FK, preTicketId @unique, jobId, createdAt)` — Ticket giữ schema thuần, cái giá: +1 bảng, +1 SELECT per recipient trong idempotency-check, migration lớn hơn. Không đổi chốt trong vòng này theo luật.

### RB-5. Bảng chốt vòng 1

| Nhóm | Số lượng | Kết quả |
|---|---|---|
| Security findings chấp nhận vào scope backend | TM-2 (timing-safe), TM-3 (log email), TM-4 (array cap), TM-7 (test x-user-id), TM-8 (placeholder per-row) | 5 — thêm vào checklist nghiệm thu/merge-gate ở vòng hội tụ |
| Security findings chấp nhận một phần | TM-1 (2 điều kiện nghiệm thu de-dup + P2002), TM-5 (warning không block), TM-6 (defer Kafka payload) | 3 |
| UI-P giữ | UI-P1, UI-P2, UI-P3, UI-P4, UI-P6 (+ dry-run của UI-P5) | 5.5 — gộp T5/migration, không thêm task PLAN mới |
| UI-P cắt | UI-P5 `POST /admin/backfill/run` (+ poll progress kèm theo) | 0.5 — T7 script CLI là canonical |
| Phản bác ngược | TRB-1 (CORS không phải control thật), TRB-2 (sequence không khóa chéo event), TRB-3 (code TICKET_SOLD_OUT cần pass-through trước), TRB-4 (poll backfill chết cùng run) | 4 |
| Tự review | (a) mirror refresh BẮT BUỘC post-commit re-seed absolute — Critical nếu bỏ; (b) giữ preTicketId @unique + fallback mapping-table | 2 |

---

## Vòng phản biện 2 — Phán quyết & Thiết kế chốt

> Verdict cuối cho mỗi finding sống từ vòng 1. [CONFIRMED] = phải làm + điều kiện nghiệm thu; [WITHDRAWN] = bác có lý do; [DEFERRED] = debt có tracking. Mục "Thiết kế chốt cập nhật" liệt kê điểm thay đổi so với thiết kế gốc — không sửa mục gốc ở vòng này.

### VB2-A. Bảng phán quyết

| # | Finding | Verdict | Phán quyết + điều kiện nghiệm thu |
|---|---|---|---|
| VB1-1 | Purchase path increment vô điều kiện + Redis stale → có cần conditional UPDATE trong purchase tx? | **[CONFIRMED phần re-seed; WITHDRAWN phần sửa purchase tx]** | **Chỉ re-seed absolute post-commit, KHÔNG sửa purchase tx trong scope này.** Lý do: (1) rủi ro thật của VB1-1 là *stale mirror do mint* — re-seed sau mint đóng đúng cửa đó; (2) conditional UPDATE trong `registerTicketsWithTx` (ticket.repository.adapter.ts:257-261) là code của purchase/reservation flow đang chạy prod — blast radius: mọi mua vé của content-service, cần re-test toàn bộ queue/reservation/finalize, không thuộc tính năng này; (3) chống sold-out race purchase-vs-purchase đã có Redis reserve LUA (available check) — DB conditional UPDATE là lớp 2 mà purchase hiện sống không có, thêm nó là việc của remediation F-01 riêng. **Nghiệm thu đóng cửa sổ stale:** test T3-M1 — mint N vé xong, ngay sau đó `HGET ticket_stock:{id} sold` == `SELECT sold` DB (đồng bộ < 1s); test T3-M2 — purchase-flow lấy available từ Redis sau mint lớn không thấy available ảo cao (mint 90/100 rồi purchase 11 vé → phải bị chặn ở 10). **Rủi ro còn lại (ghi nhận):** 2 mint chunk đồng thời chạy re-seed đọc DB cùng lúc — vô hại vì cả hai đều đọc sold đã commit (re-seed absolute idempotent, last-write-wins cùng giá trị); cửa sổ purchase ngay giữa commit-mint và re-seed (~< 1s) vẫn thấy available cũ — chấp nhận được vì mint thường chạy khi gate bán chưa mở; nếu tổ chức mint sau khi mở bán → ops rule "re-seed trước khi mở gate" (ghi vào runbook T7). |
| VB1-2 | `initStock` hmset `reserved:0` vô điều kiện — re-seed có phá reserved đang sống? | **[CONFIRMED — phát hiện đúng, đổi thiết kế re-seed]** | Reserved KHÔNG có nguồn sự thật DB trực tiếp: model `Reservation` (schema.prisma:466-482) có status/expiresAt nhưng Redis `reserved` là aggregation runtime của reservation PENDING chưa hết hạn, TTL 10 phút (reservation.constants.ts:9, cache.service.ts:234). Nếu re-seed dùng `initStock` nguyên bản → **đặt reserved=0 trong khi user đang giữ chỗ → available nở ra → oversell thật** (nghiêm trọng hơn cả stale sold). **Thiết kế re-seed chốt (thay cho "gọi initStock" ở RB-4a vòng 1):** hàm mới `refreshSoldFromDb(ticketTypeId, soldDb)`: đọc `reserved` hiện có từ Redis, rồi `HMSET ticket_stock:{id} sold=<soldDb>` **chỉ trường sold** — không đụng total/reserved/maxQuota. Nghiệm thu T3-M3: tạo reservation PENDING (reserved=5) → chạy re-seed → reserved vẫn 5, sold = DB; T3-M4: key chưa tồn tại (giả lập restart Redis) → re-seed phải tự fallback gọi `initStock` đầy đủ (đọc DB sold + quantity + maxQuota, reserved=0 đúng vì restart). |
| VB1-3 | Validate tồn tại preTicketId ở content? | **[WITHDRAWN phần validate tồn tại; CONFIRMED phần compensating control]** | Content KHÔNG validate preTicketId tồn tại ở ticket-mayo — giữ nguyên. Lý do: (1) content không có bảng PreTicket/PortalUser, FK chéo DB không tồn tại ở kiến trúc 2 DB; (2) thêm "validate bằng call-back ticket-mayo" tạo phụ thuộc vòng ngược (content → ticket-mayo) phá hướng depend một chiều hiện tại; (3) trust-boundary TB-2 đã được Security xác nhận là "token + network policy + reconciliation" — validate tồn tại không tăng bảo mật thật (kẻ có token vẫn mint preTicketId hợp lệ của job khác). **Giới hạn tin tưởng ghi rõ:** mọi preTicketId trong payload là lời xác nhận của caller; unique constraint chỉ bảo đảm "1 preTicketId ≤ 1 Ticket", KHÔNG bảo đảm tin đúng. **Compensating control (CONFIRMED, nâng lên bắt buộc):** (a) cột `Ticket.preTicketId` chính là audit-trail truy nguồn — mọi vé mint phải join được về PreTicket MINTED cùng (emailHash, userId); (b) job reconciliation hàng ngày (đã ở TM-5): Ticket có preTicketId mà không có PreTicket MINTED tương ứng → alert CRITICAL — phát hiện caller đúc vé giả dù không chặn trước; (c) log mint ghi preTicketId (đã trong C-1 audit spec). |
| VB1-4 | link-by-email scope mọi event + ticketIds | **[CONFIRMED — duy trì thiết kế]** | UX xác nhận cần `ticketIds` cho banner "N vé mới" (MyTicketsPage banner `claimedTickets` hiện có tái dùng). Rationale giữ scope toàn hệ thống: link theo email là quyền sở hữu email, không phụ thuộc event — chia event sẽ sinh câu hỏi "vé event B khi nào mới gắn?" không có câu trả lời tốt. Rủi ro admin phát nhầm email (đã ghi vòng 1) giảm bằng: warning TM-5 khi emailHash trùng job khác + UI confirm bước 4 hiển thị số người nhận. Phản ứng dữ liệu: `ticketIds` chỉ trả về phần tử VỪA link (guard `userId IS NULL` đảm bảo không trả vé link cũ) — không leak thêm. |
| VB1-5 | Backfill: CLI canonical + cắt POST run + giữ GET dry-run | **[CONFIRMED — chốt dứt, đồng ý]** | Đồng ý phương án UX fallback (import report từ CLI). Chốt cuối: T7 script CLI là run-path canonical (log chuẩn, --dry-run/--confirm, không ăn HTTP timeout); `GET /admin/backfill/dry-run` GIỮ làm đường xem trước read-only tái dùng logic tính toán; `POST /admin/backfill/run` + poll progress CẮT hẳn khỏi scope — nếu tương lai cần nút chạy thì làm background-job đúng nghĩa, RFC riêng. |
| TM-5/TM-6 | "Chấp nhận một phần" vòng 1 — chốt phần scope | **[CONFIRMED với ranh giới rõ]** | TM-5 trong scope: (1) warning khi tạo job mới mà emailHash đã có PreTicket PENDING/MINTING job khác (query ticket-mayo, trước E1.5) — làm cùng T5; (2) reconciliation job HÀNG NGÀY (cron ticket-mayo): đếm Ticket theo preTicketId vs PreTicket MINTED+CLAIMED, lệch → log CRITICAL + audit. NGOÀI scope: block cứng. TM-6 trong scope: KHÔNG làm gì — Kafka payload giữ nguyên (hiện trạng LAZY-era, consumer SMTP đang phụ thuộc); theo dõi như tech-debt riêng `DEBT-kafka-pii`. Lý do defer: đổi payload phải đổi đồng bộ consumer + tái tạo địa chỉ từ DB — chạm infra mail ngoài tính năng. |
| UX-REB-02 | ArrayMaxSize chặn ở bước 2 wizard, không để 400 lúc confirm | **[CONFIRMED — chốt chéo tham chiếu]** | Đồng ý. Phần việc chia: backend spec DTO chốt `@ArrayMaxSize(1000)` + `@Max(10)` (TM-4) là HỢP ĐỒNG cho frontend — UI-SPEC §2 wizard đọc đúng 2 số này hiển thị cap + disable + hint chia đợt ngay lúc paste (bước 2). Nghiệm thu chéo: T8 checklist có "paste 1001 email → thấy cảnh báo ở bước 2, KHÔNG phải lỗi 400 lúc confirm"; backend test T3 vẫn verify 400 khi DTO bị bypass trực tiếp (Postman) — 2 lớp độc lập. Không đổi gì thêm thiết kế backend ngoài 2 số đã chốt. |
| UX-REB-03 | Rate-limit link-by-email: con số cụ thể | **[CONFIRMED — công bố số]** | Chốt: **burst 30 req / 60s / per-service-token** trên route link-by-email (content-side, memory counter hoặc @nestjs/throttler theo caller token — chỉ 1 caller nên tương đương per-caller). Cơ sở: sync chạy tối đa 3 điểm WF2.2 (register/login/list) × 1 call mỗi điểm; 1 call = 1 emailHash; burst thật cao nhất = tấn công đăng nhập dồn dập (mỗi login thử sync) — 30/60s dư 10x trần tự nhiên. Backoff phía ticket-mayo: sync là fail-soft — nhận 429 → bỏ qua (không retry trong cùng request), lần sync kế (request sau) tự nhiên retry; KHÔNG exponential backoff riêng (không có loop retry). Nghiệm thu T3-L1: 31 call trong 60s → call 31 trả 429, ticket-mayo log warn "sync skipped rate-limit", register/login vẫn 2xx. |
| TRB-3 | content-client ép mọi lỗi thành 502 — cần pass-through | **[CONFIRMED — vào thiết kế chốt mục 7/T5]** | Đã là mục 7 DESIGN từ đầu; giờ chốt cụ thể cơ chế: `content-client.request()` parse JSON body lỗi, nếu có `code` (error-code.enum) → re-throw `HttpException` giữ status + code + message gốc thay vì `BadGatewayException` chung (content-client.service.ts:43-53). Whitelist pass-through: chỉ các code nghiệp vụ danh sách chốt (TICKET_SOLD_OUT + các 4xx nội bộ distribution) — 5xx vẫn BadGatewayException 502 (che error nội bộ content). Nghiệm thu T3-E1: mint khi quota thiếu → ticket-mayo distribute trả 409 + body `{ code: 'TICKET_SOLD_OUT', remaining, requested }` (không phải 502); T3-E2: content down → vẫn 502. Điều kiện cho UI-SPEC §3.5: field `code` có sau khi T5 land — UX đã được thông báo (TRB-3 vòng 1). |

### VB2-B. Thiết kế chốt cập nhật (delta so với thiết kế gốc)

| # | Điểm thay đổi | Mục gốc bị ảnh hưởng | Nội dung mới |
|---|---|---|---|
| Δ1 | Redis mirror refresh đổi từ "gọi initStock" sang `refreshSoldFromDb` chỉ-update trường `sold` | §9 (sold/Redis mirror) | Mint tx commit xong → `HMSET ticket_stock:{id} sold=<soldDb>` giữ nguyên total/reserved/maxQuota; fallback initStock đầy đủ nếu key chưa tồn tại. Đóng VB1-2 (reserved không có nguồn DB — Reservation chỉ là record nghiệp vụ, Redis reserved là runtime state TTL 10 phút). |
| Δ2 | Thêm bước de-dup preTicketId ở đầu mint handler (trước tx) | §2 (mint API) | Batch có 2 preTicketId trùng → 400 `DUPLICATE_PRETICKET_ID` ngay tại validation layer, không vào tx. Cùng rule: content KHÔNG validate tồn tại preTicketId (VB1-3 WITHDRAWN) — trust + compensating control (reconciliation + audit trail preTicketId trên Ticket). |
| Δ3 | Bổ sung checklist nghiệm thu mint API: timing-safe compare + test x-user-id bỏ qua | §2, §8 (deploy) | `crypto.timingSafeEqual` trong ServiceTokenGuard (content-service, service-token.guard.ts:16); 2 contract test x-user-id (TM-7). Làm cùng release mint API, không mở task riêng. |
| Δ4 | Merge-gate ticket-mayo thêm: xóa plaintext email 4 vị trí log + DTO cap 1000/10 | §8 (deploy/smoke) | auth.service.ts:56,84 + admin-bootstrap.service.ts:28,38 đổi sang emailHash; DistributeRequestDto thêm `@ArrayMaxSize(1000)` + `@Max(10)` (TM-3, TM-4). Blocker merge. |
| Δ5 | Thêm 2 endpoint admin: `POST /admin/distributions/:id/retry` + `POST /admin/distributions/:id/resend-emails`; 1 endpoint read `GET /admin/backfill/dry-run` | §4, §6, §8 | Retry = WF1-R2 (chỉ PreTicket PENDING của job PARTIALLY_MINTED/FAILED, AdminGuard); resend = chỉ MINTED/LINKED có emailSentAt IS NULL; dry-run = tái dùng logic tính T7. Tất cả gộp T5, không task mới. PostTicket thêm cột `mintedAt` + `lastMintError` (UI-P2). |
| Δ6 | PreTicket/migration ticket-mayo thêm cột `mintMode` ghi tại distribute + placeholder rollback per-row `ROLLBACK-UNLINKED-<uuid>` | §1 (migration) | mintMode snapshot vào job (UI-P1); downgrade script dùng placeholder unique per-row thay chuỗi cố định (TM-8). |
| Δ7 | Error-translation chốt cơ chế pass-through whitelist code nghiệp vụ, 5xx vẫn 502 | §7 | TRB-3. Frontend nhận được `code=TICKET_SOLD_OUT` + remaining sau T5 — điều kiện tiên quyết cho UI-SPEC §3.5. |
| Δ8 | Rate-limit link-by-email công bố 30/60s/throttler-per-token; sync fail-soft bỏ qua khi 429 | §3, §5 | UX-REB-03. Không retry loop, request kế tự retry. |
| Δ9 | Reconciliation hàng ngày (cron ticket-mayo): Ticket(content) theo preTicketId vs PreTicket MINTED+CLAIMED — lệch → CRITICAL | (mới — gắn T5) | TM-5 phần scope + compensating control VB1-3. Chỉ alert, không auto-fix. |
| Δ10 | Kafka payload giữ nguyên — tech-debt `DEBT-kafka-pii` có tracking, không chặn merge | — | TM-6 phần scope: ghi debt, không code. |

### VB2-C. Rủi ro còn lại (chấp nhận có ký)

1. **Cửa sổ ~<1s giữa mint-commit và refreshSoldFromDb**: purchase nhìn available cũ. Giảm thiểu: mint trước khi mở gate (ops rule runbook); mặc định admin mint xong mới bật bán.
2. **Conditional UPDATE purchase tx KHÔNG làm** (VB1-1 WITHDRAWN phần đó) — purchase-vs-purchase race DB-level vẫn tồn tại như hiện trạng của content-service; remediation F-01 là việc riêng, không thuê mượn scope này.
3. **Trust preTicketId hoàn toàn ở caller** — phát hiện sau-theo-fact qua reconciliation (tối thiểu 24h trễ), không chặn trước.
4. **Pepper không version** (Q2 human đã chốt) — mọi cố gắng rotation cần freeze mint+sync; giữ nguyên quyết định vòng trước.

---

## Vòng phản biện 3 — Final position

> Khép 2 xung đột còn mở với Security (đọc "## Vòng phản biện 2 — Phán quyết" THREAT-MODEL dòng 353-416). Không nhận finding mới.

### VB3-1. VB1-1 — reframe "conditional UPDATE = gate enable EAGER" → **[ACCEPT]**

Luận cứ blast-radius của tôi ở VB2-A dựa trên giả định thay đổi purchase chạy ngay trong merge. Reframe của Security làm giả định đó sụp: branch ship flag LAZY — không một hành vi purchase nào đổi cho tới khi guard + smoke xong rồi mới flip EAGER. Rủi ro còn lại của guard mới (bug chặn purchase hợp lệ) là **fail-closed** (0-row → throw → rollback) — hướng an toàn, bắt được bằng smoke staging. Drift vector (cửa sổ stale do EAGER bulk mint) do feature này tạo ra → gắn gate EAGER là đúng scope, không phải mượn remediation F-01 (race purchase-vs-purchase vốn tồn tại trước; guard này đóng cửa sổ **mint-vs-purchase**). Ba luận điểm kỹ của Security tôi không bác được: (a) TOCTOU commit→re-seed hiện chỉ che bằng ops rule — admin mint lại batch FAILED giữa lúc bán là kịch bản thật, runbook không phải đảm bảo hệ thống; (b) key không TTL → 1 re-seed fail = stale đến lúc restart — "BẮT BUỘC" phải operative; (c) reconciliation 24h phát hiện, không ngăn.

**Task mới T3b — điều kiện enable EAGER (không chặn merge LAZY):**
- Nội dung: thêm `AND sold + N <= quantity` vào UPDATE TicketType trong `registerTicketsWithTx` (ticket.repository.adapter.ts:257-261); 0-row → throw `QUOTA_EXCEEDED` → rollback tx + gọi `releaseStock` bồi hoàn Redis reserved.
- Kèm hardening Δ1: re-seed fail → retry backoff (3 lần: 1s/5s/25s) + CRITICAL alert, không âm thầm bỏ.
- Nghiệm thu: T3b-1 — sold = quantity−N, mua N+1 → reject, tx rollback, Redis reserved được release; T3b-2 — purchase hợp lệ dưới quota vẫn 2xx, hành vi không đổi; T3b-3 — trước flip, smoke purchase flow hiện trạng ở LAZY không đổi; T3b-4 — flip EAGER chỉ sau T3b-1..3 pass trên staging.
- Chỗ launch plan: chèn giữa T3 (mint API land, flag LAZY) và bước flip EAGER trong T8. Ghi rõ: "flip `DISTRIBUTION_MINT_MODE=EAGER` ⟂ điều kiện: T3b verified".
- Đóng rủi ro VB2-C #2 (cập nhật trạng thái tại vòng này, không sửa dòng gốc).

### VB3-2. VB1-3 — HMAC signature per-recipient tuple → **[ACCEPT]**

Giải đúng đúng lý do tôi WITHDRAWN round-trip: fabrication chết **tại boundary**, stateless, không đảo dependency, không availability coupling. Đánh giá 3 chi phí: (1) **key thứ 2**: marginal — cùng cơ chế quản lý INTERNAL_SERVICE_TOKEN hiện có, thêm 1 env ở 2 service + secrets checklist T8; (2) **rotation**: theo đúng pattern freeze đã chấp nhận cho pepper (Q2): freeze mint+sync → swap 2 bên → resume; không cần dual-key vì mint không chạy khi freeze; (3) **version skew**: không tồn tại — mint API là API mới, phía gửi chỉ có sau khi cả 2 ship; deploy order đã là content trước (content ship verify+reject thiếu sig) → ticket-mayo sau (ship sign) — expand tự nhiên, không cần compat pha cũ.

**Cập nhật mint contract (Δ11, nối tiếp VB2-B):**
- Field `signature` per recipient: `sig = HMAC-SHA256(MINT_SIGNING_KEY, canonical)`; `canonical = preTicketId + '.' + emailHash + '.' + (userId ?? '')` — delimiter `.` và userId-vắng-mặt = chuỗi rỗng, pin cứng tránh ambiguity.
- Content verify TRƯỚC tx, cùng lớp de-dup Δ2: thiếu sig / sig sai → 400 `INVALID_PRETICKET_SIGNATURE`, không vào tx.
- Env `MINT_SIGNING_KEY`: riêng, ≥32 chars, ≠ và không reuse INTERNAL_SERVICE_TOKEN; vào secrets checklist + gitleaks. Backfill CLI T7 đi qua cùng client ký (hoặc đọc cùng env) — không đường mint nào bỏ chữ ký.
- Rotation note (runbook T7/T8): pepper-freeze pattern — freeze mint+sync, swap 2 service, resume.
- Tầng phụ giữ nguyên: audit trail preTicketId (Δ2) + reconciliation hàng ngày (Δ9) — phòng bug trong chính logic sig + phát hiện dữ liệu lịch sử. Đóng rủi ro VB2-C #3.

---

## Thiết kế chốt hội tụ (Phase 2c)

> Hội tụ cuối sau Vòng phản biện 3 của cả 3 lens (DESIGN / THREAT-MODEL / UI-SPEC). Các vòng phía trên GIỮ NGUYÊN làm audit trail; khi nội dung mâu thuẫn, MỤC NÀY thắng. Plan thực thi: `docs/PLAN-ticket-email-mint-sync.md` (v1.1).

### 2c-1. Đối chiếu 3 docs — điểm chung chốt + xung đột đã giải

| Chủ đề | Chốt hội tụ | Trạng thái |
|---|---|---|
| **VB1-1** quota-guard mint-vs-purchase | **Đóng qua T3b** — conditional UPDATE `sold + N <= quantity` trong `registerTicketsWithTx` (ticket.repository.adapter.ts:250-287), 0-row → throw → rollback tx + releaseStock bồi hoàn Redis. Nghiệm thu T3b-1..4: (1) sold=quantity−N mua N+1 → reject + rollback + reserved release; (2) purchase hợp lệ dưới quota 2xx, hành vi không đổi; (3) smoke purchase flow LAZY không regression; (4) flip EAGER chỉ sau 1-3 PASS trên staging. Kèm Δ1 refreshSoldFromDb (chỉ HMSET `sold`, fallback initStock) + retry/alert T3-M5. | Giải — Vòng 3 cả 2 bên |

**Điều khoản bắt buộc (VB1-1):** conditional-update là **merge-gate để BẬT EAGER (T8), KHÔNG phải gate merge nhánh** — nhánh ship flag LAZY trước, không thay đổi hành vi purchase hợp lệ nào cho tới khi T3b + smoke test xong rồi mới flip EAGER. F-01 check-then-act còn lại trong LAZY path là **known-debt** có T3-M5/M6/M7 che (refresh retry + verify-script exit-code + reconciliation mirror-check ≤15 phút).

| Chủ đề | Chốt hội tụ | Trạng thái |
|---|---|---|
| **VB1-3** preTicketId fabrication | **HÒA GIẢI — build HMAC ngay theo Δ11:** `sig = HMAC-SHA256(MINT_SIGNING_KEY, preTicketId + '.' + emailHash + '.' + (userId ?? ''))`; ticket-mayo ký (T5 content-client, T7 CLI cùng client), content verify TRƯỚC tx (T3, cùng lớp de-dup Δ2) → 400 `INVALID_PRETICKET_SIGNATURE`, không vào tx. Security DEFERRED theo-đuổi sang Q4 human-review — **hai thứ tương thích: BUILD NGAY trong scope, human validate là MERGE-GATE** (không chặn build). Reconciliation giữ làm tầng phụ: T3-M8 self-verify per-run (đối chiếu preTicketId gửi vs ticketIds response trong RAM) + cron Δ9 lưới cuối. | Giải — DEFERRED sang Q4 chỉ là tầng duyệt |

**UX — mọi UX-REB đã chốt ở Vòng 2, không còn xung đột với DESIGN** (xác nhận nhanh):
- Wizard chặn ở **BƯỚC 2** (paste) với limit 1000 recipients / 10 vé-người + gợi ý chia đợt — 2 số là hợp đồng DTO từ TM-4/Δ4 (UX-REB-02).
- Claim-landing **3 nhánh** (đã-login email khớp → redirect / chưa login → prompt / PreTicket PENDING → lazy-mint transition) + **3 edge case** — khớp mô tả T6 của PLAN.
- Banner "N vé mới" cần scope **ALL-events** của link-by-email → **D-L1 GIỮ** (VB1-4 — Security Withdrawn vòng 2); `ticketIds` chỉ trả vé VỪA link (guard `userId IS NULL`), dùng server-side đếm banner.

### 2c-2. Merge-gates tổng hợp (từ cả 3 docs — định nghĩa DONE của plan)

| Gate | Nội dung nghiệm thu | Nguồn |
|---|---|---|
| TM-1 | `crypto.timingSafeEqual` thay `===` trong ServiceTokenGuard (content-service `src/interceptors/service-token.guard.ts:16`) + 2 contract test x-user-id bị bỏ qua | THREAT-MODEL §5 |
| TM-3 | Xóa plaintext email 4 vị trí log: `auth.service.ts:56,84` + `admin-bootstrap.service.ts:28,38` → emailHash/userId | THREAT-MODEL §4 |
| TM-4 | DTO limits `@ArrayMaxSize(1000)` + `@Max(10)` (ticket-mayo `distribute-request.dto.ts:16-18` + content internal-distribution DTO) | THREAT-MODEL §3.6 |
| T3-M5..M8 | Redis mirror + mint self-check: M5 refreshSoldFromDb retry+CRITICAL (kill Redis giữa mint run); M6 verify-script T7 exit-code != 0 khi lệch 1 vé; M7 mirror-check reconciliation ≤15 phút; M8 post-mint self-verify per-run lệch → PARTIALLY_MINTED + alert | THREAT-MODEL Vòng 3 |
| Q2 | Human duyệt PII emailHash (PRD §7.1) — model khác, trước merge content-service | THREAT-MODEL §6.2 |
| Q4 | Human duyệt threat-model mint/link (PRD §8.2-8.3), **gồm xác nhận HMAC Δ11** — model khác, trước merge | THREAT-MODEL §6.1 |
| (giữ) T9 | ASSURANCE PASS (e2e + contract snapshot + mutation ≥70% + gitleaks 2 repo clean) | PLAN |

### 2c-3. Câu hỏi ngỏ cuối — pepper versioning (F-07)

Không Δ nào xử lý versioning pepper. **Chốt: known-risk ĐƯỢC CHẤP NHẬN** — đổi pepper = freeze mint+sync toàn hệ (VB2-C.4, Q2 đã chốt không re-litigate) — với điều kiện monitoring bắt buộc (THREAT-MODEL §3.5):

1. Pepper trong secret manager, KHÔNG env-file commit (điều kiện Q2).
2. Metric linked-count drift cảnh báo (§3.5.1) + reconciliation Δ9 phát hiện vé sync-chết.
3. Pre-flight hash-sample đối chiếu 2 service trong deploy-gate (§3.5.3) — drift bắt TRƯỚC khi mở bán.
4. Runbook rotation mô tả cửa sổ freeze mint+sync (T10).

Nếu human-review Q2/Q4 đòi thêm `emailHashVersion` → mở task riêng sau initiative, không chặn scope này.

### 2c-4. Điều chỉnh Δ do hội tụ (đè lên VB2-B khi mâu thuẫn)

- **Δ9**: cadence chia 2 — mirror-check **≤15 phút** (T3-M7, đổi từ "hàng ngày") + orphan preTicketId check hàng ngày giữ làm lưới cuối; bổ sung T3-M8 per-run event-driven.
- **Δ5**: cột thuộc model **PreTicket** (`mintedAt`, `lastMintError`, `emailSentAt` — sửa tên "PostTicket" trong VB2-B) + DistributionJob `mintMode`; schema gom vào T4, endpoint vào T5, hiển thị T8.
- **Δ11**: build TRONG SCOPE (T3 verify + T5/T7 ký); Q4 human-review = merge-gate xác nhận, không phải điều kiện build.
- **Mới — T3b**: xem 2c-1; vào PLAN wave 3 (T3+T3b), là gate flip EAGER ở T8.
