# PLAN: TICKET-TYPE-SPLIT — Điều chuyển bớt vé sang loại vé khác (giữ N vé cũ nhất)

**Status**: IMPLEMENTED (T1–T9 done — content-service spec 24/24, ticket_mayo 189/189, tsc + build OK; chờ smoke test §5.5 thật trước khi chạy 289→100)
**Date**: 2026-09-18
**Scope file này**: Thiết kế + task breakdown + runbook backup/rollback + smoke checklist.
**Kịch bản nghiệp vụ hiện tại**: 1 hạng vé miễn phí đã phát 289 vé → giữ lại **100 vé cũ nhất**, chuyển **189 vé mới nhất** sang hạng vé khác (cùng event). Implementation là API generic (source/target/keepCount), không hard-code 289/100/189.

---

## 0. Tổng quan

### 0.1. Mục tiêu

1. Admin chọn: event + loại vé nguồn (source) + loại vé đích (target, cùng event) + `keepCount` (số vé GIỮ LẠI).
2. Dry-run plan: liệt kê chính xác các vé sẽ bị chuyển (mới nhất trước — `createdAt DESC`), blockers, projection sold/quantity sau khi chuyển.
3. Apply: 1 transaction + advisory lock per event + **backup đầy đủ trong AuditLog manifest** (snapshot 2 loại vé + toàn bộ row của các vé bị chuyển).
4. Rollback 1 lệnh theo `auditId`: nghịch đảo chính xác các vé đã chuyển, khôi phục snapshot, idempotent-guard chống rollback 2 lần.
5. Redis stock/user-counter đồng bộ lại cho CẢ HAI loại vé sau apply và rollback.

### 0.2. Vì sao không dùng TICKET-TYPE-MERGE có sẵn

Merge (ticket-type-merge.service.ts) chuyển **TOÀN BỘ** vé loser → survivor rồi **XÓA loser**. Ở đây source **vẫn sống** (giữ 100 vé, tắt bán khi quantity=sold=100), chỉ chuyển **một TẬP CON** (189 vé mới nhất). Semantics khác ở: chọn subset, counter tăng/giảm 2 chiều, không xóa type nào.

### 0.3. Quyết định đã chốt

| # | Quyết định | Lý do |
|---|---|---|
| D1 | Tiêu chí chọn: `isDeleted=false AND status != 'CANCELLED'`, `ORDER BY createdAt DESC, id DESC`, lấy `eligible - keepCount` vé | "Lấy từ trên xuống" = user đăng ký mới nhất bị bốc trước; id làm tie-break ổn định |
| D2 | `keepCount` là input duy nhất; `moveCount = eligibleCount - keepCount` | Trùng mental model "giữ lại 100" |
| D3 | Selection + manifest **xây BÊN TRONG transaction** (sau advisory lock) — plan dry-run chỉ để validate/report | Chống race plan→apply (vé mới đăng ký giữa chừng) |
| D4 | Counter dùng **increment/decrement** (`sold: {decrement: moveCount}` / `{increment: moveCount}`), KHÔNG set tuyệt đối | Chống lost-update với register path chạy đồng thời (merge set tuyệt đối — accept risk đó; split làm kỹ hơn) |
| D5 | Source `quantity` mặc định hạ về = `keepCount` (289→100 → sold out type miễn phí); cho override `sourceQuantity` (>= sold sau chuyển). Target giữ nguyên quantity, cho override `targetQuantity` | "Chỉ muốn giữ 100 vé" |
| D6 | **KHÔNG** re-point Reservation / GiftCampaign (source không bị xóa, không vướng FK). **Có** re-point Seat theo vé chuyển (Seat.ticketId → vé nào thì seat theo vé đó) | Seat.ticketTypeId là liên kết hiển thị; FK Ticket.ticketTypeId là scope của move |
| D7 | Vé USED (đã check-in) vẫn chuyển được nhưng **warning** (không block) | QR payload {v,tid,eid} không nhúng ticketTypeId → check-in không phụ thuộc loại vé |
| D8 | Manifest lưu **TOÀN BỘ row Ticket** (mọi cột) của các vé bị chuyển — không chỉ id | User yêu cầu backup đầy đủ; phục hồi thủ công bằng SQL được cả khi logic rollback hỏng |
| D9 | Rollback chặn khi counter drift (vé mới đăng ký vào target / user tự hủy sau split) → 409 kèm hướng dẫn manual | "Phải thật kỹ" — thà chặn + làm tay còn hơn rollback nhầm |
| D10 | Bump `event.checkInSnapshotVersion + 1` trong tx (apply + rollback) | Thiết bị offline refresh snapshot (ticketType name per vé đổi) |
| D11 | KHÔNG cần DB migration (AuditLog generic, actionType là string) | Revert an toàn tuyệt đối ở tầng schema |
| D12 | `purchasePrice` của vé chuyển **giữ nguyên snapshot (=0 nếu vé free)** — không ép theo giá target | Giá là snapshot lúc phát; đổi sẽ sai sự thật lịch sử. Warning nếu price source ≠ target |
| D13 | Blocker: reservation PENDING/INITIATING trên **source** (chống finalize vào type đã sold-out sau split). Trên target KHÔNG block | Reservation trên target chỉ finalize bình thường (counter tăng dần vẫn khớp nhờ D4) |
| D14 | Deploy order: content-service TRƯỚC, ticket-mayo SAU (additive endpoint, tương thích 1 chiều) | Pattern deploy của merge |
| D15 (bổ sung, user yêu cầu) | UI chỉ nhập **số vé chuyển** (front tự quy đổi keepCount = eligible − move, eligible lấy từ dry-run + retry 1 lần). **Số lượng "dịch chỗ theo vé"**: front LUÔN gửi `sourceQuantity = SL nguồn − move` và `targetQuantity = SL đích + move` → slot còn lại mỗi loại giữ nguyên, tổng sức chứa event không đổi (6000→5140, 10000→10860 cho move=860). Override ở "Tùy chọn nâng cao" vẫn thắng. GET split-plan nhận thêm 2 query optional `sourceQuantity`/`targetQuantity` (content + mayo controller) — content-service coi 2 giá trị này là SL TUYỆT ĐỐI sau split (`sourceQuantityAfter`/`targetQuantityAfter`), validate ≥ soldAfter | User: "trừ 860 thì phải trừ cả 6000, bên 10000 cộng thêm 860" |
| D16 (bổ sung, user yêu cầu) | Apply **TỰ CHIA ĐỢT ≤500 vé** trong ticket-mayo khi moveCount > cap 500 (thay vì REFUSE 409 như trước). Mỗi đợt: plan(keepNow)→repoint lokal→content split, có auditId riêng; `contentAuditIds[]`/`repointAuditIds[]`/`rounds[]` trả về, status `split-batched`. Đợt giữa dùng quantity "dịch chỗ theo vé" (src=SL_hiện_tại−mv / tgt=SL_hiện_tại+mv); đợt CUỐI dùng override tuyệt đối DTO (hoặc mặc định backend nếu CLI không truyền → tương thích CLI cũ). Sai 4xx giữa batch → undo local đợt đó + ném `completedRounds[]` (các đợt đã commit) để admin rollback ngược từng đợt. Rollback vẫn theo TỪNG contentAuditId (content-service rollback mỗi split độc lập) | User: "phải chia chunk để tránh xử lý data nhiều" (demo 860 vé > cap 500) |
| D17 (bổ sung, user yêu cầu) | Apply trả thêm `moved[]` = TOÀN BỘ vé đã chuyển của MỌI đợt (`ticketId, ticketCode, userId, status, createdAt` — gom từ movePreview đầy đủ ≤500/đợt nên không bị cắt), có ở mọi nhánh trả về (`split`, `split-after-ambiguous-error`, `split-batched` ± partial). UI thêm card "Danh sách vé đã chuyển — đối chiếu DB": thống kê userId/unclaimed, nút copy danh sách dạng SQL IN, tải CSV, 2 câu SQL mẫu trên bảng `"Ticket"` (DB content-service, expecting `ticketTypeId` = loại đích) + bảng vé (50 đầu, toggle hiện tất cả) | User: "cần lấy toàn bộ userId đã đổi vé để select vào DB kiểm tra đã chuẩn chưa" |

### 0.4. Vẫn treo (không chặn review plan — chặn chạy thật)

| Mục | Owner | Cổng chặn |
|---|---|---|
| Q1 — Chọn target type cụ thể nào cho 289→100 (id + quantity đủ容纳 189?) | User | Trước khi bấm Apply thật |
| Q2 — Có vé nào trong 189 vé mới nhất đã check-in (USED) / có PreTicket email-mint trỏ về không | User (xem ở dry-run plan) | Trước khi Apply — chỉ để xác nhận warning |
| Q3 — Có cần email thông báo 189 user bị đổi loại vé không | User | Out of scope v1 (ghi NOTE ở runbook) |

---

## 1. Kiến trúc & luồng (content-service là nguồn sự thật)

```
ticket-mayo admin UI (SplitTicketTypesPage)
   │  JWT AdminAuthGuard
   ▼
ticket-mayo TicketSplitService  ──(local subset repoint PreTicket nếu có)──┐
   │  x-service-token                                                      │
   ▼                                                                       │
content-service InternalDistributionController                             │
   ├── GET  ticket-types/split-plan   (dry-run, không ghi)                 │
   ├── POST ticket-types/split        (tx + advisory lock + manifest)      │
   └── POST ticket-types/split/rollback (nghịch đảo theo auditId)          │
                                                                           │
content-service TicketTypeSplitService ── Prisma tx + CacheService ────────┘
```

---

## 2. Thiết kế chi tiết — content-service

### 2.1. Service mới: `src/core/services/ticket-type-split.service.ts`

Đặt cạnh `ticket-type-merge.service.ts`, tái dùng: `TicketTypeSnap` (export từ merge service), pattern advisory lock `pg_advisory_xact_lock(hashtext(eventId)::bigint) IS NULL AS locked`, pattern `syncRedisAfterMerge` (copy thành `syncRedisAfterSplit` cho 2 type còn sống), `reseedUserTicketCountersForType` (copy), `buildTypeStat` (report per-type cho UI).

#### 2.1.1. `plan(input)` — dry-run, KHÔNG ghi gì

Input: `{ eventId, sourceId, targetId, keepCount, sourceQuantity?, targetQuantity?, actorId? }`

Output:
- `source` / `target`: TypeStat (sold, quantity, remaining, tickets byStatus, buyers cap 500 như BUYER_CAP của merge)
- `eligibleCount` (vé sống: isDeleted=false, status != CANCELLED)
- `moveCount = eligibleCount - keepCount`
- `movePreview`: mảng `{ ticketId, ticketCode, userId, createdAt, status, checkedInAt }` — chính xác các vé SẼ bị chuyển (newest-first, cap 500 + `truncated` flag)
- `projection`: `{ sourceAfter: {quantity, sold}, targetAfter: {quantity, sold} }`
- `blockers[]` (→ 409 khi apply): reservation PENDING/INITIATING trên source; target cùng source; khác event; moveCount <= 0; target capacity thiếu (`targetBefore.sold + moveCount > targetQuantity`)
- `warnings[]`: vé USED trong tập chuyển; price source ≠ target; user vượt `target.maxTicketsPerUser` sau chuyển; requireProof/emailDistribution mismatch; sold-counter drift (predicate khớp merge: `status != CANCELLED AND isDeleted=false`)

#### 2.1.2. `apply(input)` — transaction thật

1. **Pre-tx analyze** (như merge): validate shape → 400 `TICKET_TYPE_SPLIT_INVALID_INPUT`; blockers → 409 `TICKET_TYPE_SPLIT_BLOCKED`.
2. **Trong `$transaction` (timeout 120s)**:
   a. `pg_advisory_xact_lock(hashtext(eventId)::bigint)` — serialize với mọi admin-op cùng event.
   b. **Re-check blocker in-tx**: `reservation.count({ ticketTypeId: sourceId, status: [INITIATING, PENDING] })` > 0 → throw 409 (race plan→apply).
   c. **Selection in-tx** (D3): `ticket.findMany({ where: { ticketTypeId: sourceId, isDeleted: false, status: { not: 'CANCELLED' } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: moveCount })` — lấy FULL row (mọi cột) cho manifest (D8). Nếu số row < moveCount → throw 409 (eligible đổi giữa chừng).
   d. `ticket.updateMany({ where: { id: { in: movedIds } }, data: { ticketTypeId: targetId } })`.
   e. `seat.findMany({ where: { ticketId: { in: movedIds } } })` → manifest + `seat.updateMany` trỏ target.
   f. Source: `sold: { decrement: moveCount }` + `quantity: sourceQuantityAfter` (D4/D5). Target: `sold: { increment: moveCount } }` (+ quantity nếu override).
   g. Recalc `event.maxParticipants = SUM(quantity)` mọi type của event → `event.update` (+ `checkInSnapshotVersion: { increment: 1 }` cùng lệnh update — D10).
   h. `auditLog.create` actionType **`TICKET_TYPE_SPLIT`**, targetType `TicketType`, targetId `sourceId`, beforeData = manifest (§2.2), afterData = counts + projection + maxParticipants. Trả `auditId`.
3. **Sau commit — Redis sync** (best-effort, log CRITICAL khi fail như merge):
   - `cache.syncStockAfterMerge(sourceId, sourceQuantityAfter, sourceSoldAfter, maxQuota)` — cập nhật total/sold, giữ reserved (method có sẵn, tên dùng chung — không cần method mới).
   - `cache.syncStockAfterMerge(targetId, ...)`.
   - `reseedUserTicketCountersForType(sourceId)` + `(targetId)` — SET lại `user_tickets:{u}:{type}` từ DB-truth.
   - KHÔNG `deleteTicketTypeCache` (cả 2 type còn sống — giữ gate status/queue pos).
4. Reconcile warning-only: COUNT vé sống mỗi type vs sold counter.

Trả về: `{ mode: 'apply', auditId, moved: {tickets, seats}, projection, warnings, redis, rollbackHint }`.

#### 2.1.3. `rollback(auditId, actorId?)` — nghịch đảo manifest

1. Tìm AuditLog `TICKET_TYPE_SPLIT` theo auditId → 404 `TICKET_TYPE_SPLIT_AUDIT_NOT_FOUND` nếu sai.
2. Marker check: đã có AuditLog `TICKET_TYPE_SPLIT_ROLLBACK` targetType `AuditLog` targetId = auditId → 409 `TICKET_TYPE_SPLIT_ROLLBACK_CONFLICT` (chống rollback 2 lần — pattern merge).
3. Parse manifest + shape check (version 1) → 409 nếu hỏng.
4. **State checks (D9 — chặt hơn merge)**:
   - source & target đều còn tồn tại.
   - Mọi vé trong manifest: `ticketTypeId ∈ { targetId (chưa rollback), sourceId (đã về) }` — trỏ type thứ 3 → 409.
   - **Counter drift check**: `source.sold === sourceBefore.sold - moveCount` AND `target.sold === targetBefore.sold + moveCount` — lệch (vé mới vào target / user hủy vé sau split) → 409 kèm thông điệp: "làm thủ công theo manifest §5.3 hoặc hủy/điều chỉnh vé gây drift trước".
   - Live reservation trên source vẫn là blocker (giống apply).
5. **Tx**: advisory lock → `ticket.updateMany({ where: { id: in manifestIds, ticketTypeId: targetId }, data: { ticketTypeId: sourceId } })` (idempotent — WHERE còn trỏ target) → seats về source → restore **full snapshot** source & target (từ `sourceBefore`/`targetBefore` — set tuyệt đối được vì đã qua drift check) → restore `maxParticipants` → `checkInSnapshotVersion +1` → tạo marker audit `TICKET_TYPE_SPLIT_ROLLBACK`.
6. Redis re-seed cả 2 type (pattern `syncRedisAfterMerge` rollback path).

### 2.2. Manifest (backup đầy đủ — beforeData của AuditLog)

```jsonc
{
  "version": 1,
  "eventId": "...",
  "sourceId": "...",
  "targetId": "...",
  "keepCount": 100,
  "moveCount": 189,
  "orderBy": "createdAt:desc,id:desc",
  "sourceBefore": TicketTypeSnap,      // đủ 15 field như merge snap()
  "targetBefore": TicketTypeSnap,
  "eventMaxParticipantsBefore": 1000,
  "eventCheckInSnapshotVersionBefore": 3,
  "moved": {
    "tickets": [ /* FULL Ticket row serialization: id, ticketTypeId, userId,
                    recipientEmailHash, preTicketId, ticketCode, createdAt,
                    status, isDeleted, purchasePrice, reservationId, imageUrl,
                    comingSoonImageUrl, campaignId, activeAt, checkedInAt,
                    checkedInBy, checkedInGateId, totpSecret,
                    checkedInDeviceEventId, seatLabel — 189 objects */ ],
    "seats": [ { "id": "...", "fromTypeId": "sourceId" } ]
  }
}
```

Decimal → string, Date → ISO (JSON-safe). ~189 row × 21 field ≈ vài trăm KB TEXT — PostgresAuditLog `beforeData String?` (TEXT) giữ được.

**Bảo vệ manifest**: KHÔNG được xóa/purge AuditLog `TICKET_TYPE_SPLIT` — đây là điều kiện sống của rollback (ghi vào runbook + comment trong service).

### 2.3. Endpoints — `internal-distribution.controller.ts`

Đặt **trước** `@Get('ticket-types/:id')` (giống merge-plan — tránh bị `:id` nuốt):

```
GET  ticket-types/split-plan     ?eventId&sourceId&targetId&keepCount[&sourceQuantity&targetQuantity]   → plan()   (D15: 2 param cuối optional)
POST ticket-types/split          body: InternalSplitTicketTypesDto      → apply()
POST ticket-types/split/rollback body: InternalSplitRollbackDto         → rollback()
```

DTO mới `dtos/request/internal-ticket-split.dto.ts`:
- `InternalSplitTicketTypesDto`: `eventId!`, `sourceId!`, `targetId!`, `keepCount!` (Int, Min 0), optional `sourceQuantity?` (Int, Min 0), `targetQuantity?`, `actorId?` (Length 1-64).
- `InternalSplitRollbackDto`: `auditId!`, `actorId?`.

Module: thêm `TicketTypeSplitService` vào providers của `ticket-distribution.module.ts`.

Error codes — `error-code.enum.ts` (thêm 4 dòng cạnh TICKET_TYPE_MERGE_*):
```
TICKET_TYPE_SPLIT_INVALID_INPUT / _BLOCKED / _AUDIT_NOT_FOUND / _ROLLBACK_CONFLICT
```

### 2.4. Semantics đã verify từ schema (không đoán)

- `Ticket.ticketTypeId` FK → `TicketType.id` (source không xóa nên không dính CASCADE).
- `Reservation.ticketTypeId` FK + partial unique `(userId, ticketTypeId) WHERE PENDING` — không đụng reservation.
- `Seat.ticketId @unique`, `Seat.ticketTypeId` nullable — re-point theo vé.
- QR Ed25519 ký `{v, tid, eid}` — không nhúng ticketTypeId → vé đã phát/đã in giữ nguyên hiệu lực.
- `purchasePrice` snapshot per vé — không đổi.
- Free-rule `countFreeTicketTypesByUserInEvent` (predicate VALID + isDeleted=false + price=0, DISTINCT ticketTypeId): sau split user có vé free ở target — chỉ chặn đăng ký free-type MỚI, không invalid vé hiện tại. Không cần xử lý.
- Redis keys: `ticket_stock:{id}` (syncStockAfterMerge cập nhật total/sold, GIỮ reserved — hợp vì blocker đã đảm bảo reserved=0 ở source; target giữ reserved hiện có), `user_tickets:{u}:{type}` (re-seed SET), gate/queue giữ nguyên.

---

## 3. Thiết kế chi tiết — ticket-mayo

### 3.1. `ContentClientService` — 3 method (timeout 120s cho apply/rollback, pass-through error whitelist như merge)

`getSplitPlan(params)`, `splitTicketTypes(body)`, `splitRollback(body)` — mirror `getMergePlan`/`mergeTicketTypes`/`mergeRollback` (content-client.service.ts:544-587).

### 3.2. Module mới `src/modules/ticket-split/` (mirror ticket-merge)

**PreTicket repoint subset**: PreTicket trỏ `ticketTypeId` string (snapshot hiển thị) + `contentTicketId`. Nếu trong 189 vé có vé từng mint qua email (`preTicketId != null`), cần update `PreTicket.ticketTypeId` theo `contentTicketId ∈ movedIds`. Runner merge-repoint repoint CẢ type — không dùng lại nguyên vẹn; viết helper nhỏ trong `ticket-split.service.ts`:

```ts
repointPreTicketsByTicketIds(prisma, movedIds: string[], targetId, targetName, dryRun)
```

- `updateMany({ where: { contentTicketId: { in: movedIds }, status: { in: LIVE } } })` (LIVE = PENDING/MINTING/LINKED/CLAIMING như runner) + manifest vào `DistributionAudit` (action `SPLIT_REPOINT`, có rollback bằng đếm ngược). Idempotent.
- Nếu dry-run plan cho thấy 0 PreTicket trong tập chuyển (kịch bản 289 vé đăng ký app — khả năng cao = 0) → bước này no-op, log "không có PreTicket affected".

**Thứ tự apply** (đối xứng merge, tinh chỉnh cho subset):
1. Local subset repoint (nếu có PreTicket affected) — audit riêng.
2. `content.splitTicketTypes(...)` — 4xx → undo local; 5xx/timeout → **probe**: gọi `split-plan` cùng tham số, `source.sold === keepCount` = đã commit (giữ local), chưa = undo local, probe fail = để nguyên + báo admin.
3. Rollback: content rollback TRƯỚC, undo local repoint sau (theo repointAuditId).

Controller `ticket-split.controller.ts`: `@Controller('admin/ticket-split')` + `AdminAuthGuard` — `GET plan`, `POST` (confirm "SPLIT"), `POST rollback`.

### 3.3. Frontend — `SplitTicketTypesPage.tsx` + route `/admin/split-ticket-types`

Mirror cấu trúc MergeTicketTypesPage.tsx: chọn event → 2 dropdown loại vé (source/target) + input `keepCount` → nút "Xem trước" (gọi plan: bảng vé sẽ chuyển newest-first, blockers đỏ / warnings vàng / projection) → confirm gõ "SPLIT" → kết quả (auditId, rollbackHint) + nút Rollback theo auditId. Thêm nav item "Điều chuyển vé" cạnh "Gộp loại vé".

---

## 4. Task list

Quy ước: mỗi task 1 producer + critic (Code Reviewer / Reality Checker). S < 2h, M 2-6h, L > 6h. **Chưa task nào được bắt đầu trước khi user approve plan này.**

| # | Repo | Task | Size |
|---|---|---|---|
| T1 | content-service | `error-code.enum.ts`: 4 code TICKET_TYPE_SPLIT_* | S |
| T2 | content-service | `ticket-type-split.service.ts`: plan/apply/rollback + manifest + redis sync + drift check | L |
| T3 | content-service | DTO `internal-ticket-split.dto.ts` + 3 endpoint controller + `ticket-distribution.module.ts` providers | M |
| T4 | content-service | Jest spec: selection order DESC, keepCount biên (0, =eligible, >eligible), blocker reservation, rollback drift 409, rollback idempotent, manifest round-trip | M |
| T5 | ticket_mayo | ContentClientService: 3 method | S |
| T6 | ticket_mayo | Module `ticket-split` (controller/service/DTOs + subset PreTicket repoint + probe) | L |
| T7 | ticket_mayo | Frontend SplitTicketTypesPage + route + nav | M |
| T8 | ticket_mayo | Jest spec orchestration (4xx undo, 5xx probe 3 nhánh) | M ✅ 18/18 |
| T9 | docs | Runbook §5 hoàn thiện + checklist smoke test | S ✅ |

**Trạng thái triển khai** (2026-09-18): T1–T9 hoàn tất. Verify: content-service `ticket-type-split.spec.ts` 24/24; ticket_mayo full jest 16 suite / 189 test PASS (trong đó `ticket-split.service.spec.ts` 18/18); `tsc --noEmit` OK cả 2 repo + frontend; `npm run build` (vite) OK.

**Test acceptance** (từ spec T4/T8 + smoke):
1. Seed: source 10 vé (createdAt spread), target quantity đủ → keep 3 → đúng 7 vé MỚI NHẤT chuyển, source sold 10→3, quantity→3, target sold +7.
2. Rollback ngay sau apply → state y nguyên từng field (so snapshot), Redis counter khớp.
3. Rollback lần 2 → 409. Đăng ký vé mới vào target rồi rollback → 409 drift.
4. PENDING reservation trên source → apply 409.
5. Vé đã check-in (USED) trong tập → apply OK + warning; check-in lại offline/online vẫn pass (không phụ thuộc type).

---

## 5. Runbook thực thi 289 → 100 (chỉ chạy sau khi mọi task xong + smoke test PASS)

### 5.1. Backup lạnh (bắt buộc trước Apply — belt-and-braces ngoài AuditLog manifest)

```bash
# Trên máy có quyền psql tới content-service DB (thay <src>/<tgt>/<evt> từ split-plan):
psql "$CONTENT_DB_URL" -c \
  "COPY (SELECT * FROM \"Ticket\" WHERE \"ticketTypeId\" IN ('<src>','<tgt>')) TO STDOUT WITH CSV HEADER" \
  > backup_ticket_split_$(date +%Y%m%d_%H%M%S).csv
psql "$CONTENT_DB_URL" -c \
  "COPY (SELECT * FROM \"TicketType\" WHERE \"eventId\" = '<evt>') TO STDOUT WITH CSV HEADER" \
  > backup_tickettype_$(date +%Y%m%d_%H%M%S).csv
psql "$CONTENT_DB_URL" -c \
  "COPY (SELECT * FROM \"Seat\" WHERE \"ticketTypeId\" IN ('<src>','<tgt>')) TO STDOUT WITH CSV HEADER" \
  >> backup_seat_$(date +%Y%m%d_%H%M%S).csv
# Ghi lại file vào chỗ an toàn + checksum sha256sum
```

Lưu file ít nhất 30 ngày. (AuditLog manifest là backup nóng cho rollback 1-lệnh; CSV là cứu tinh khi DB/log bị sự cố.)

### 5.2. Thứ tự thao tác trên UI admin

1. Chặn đăng ký mới tạm thời (đóng gate `ticket_gate_status:{source}` hoặc set saleEndsAt — xem plan output trước khi apply, đảm bảo không race).
2. Mở "Điều chuyển vé" → chọn event, source (hạng free 289 vé), target, keepCount = **100**.
3. "Xem trước": xác nhận (a) `eligibleCount = 289`, `moveCount = 189`; (b) review 189 vé trong movePreview — vé cũ nhất giữ lại; (c) blockers = 0; (d) đọc warnings (USED? PreTicket?).
4. Backup lạnh §5.1.
5. Confirm "SPLIT" → **lưu lại `auditId` + `repointAuditId` từ response** (ghi vào ticket nội bộ).
6. Verify sau apply: split-plan lại (source sold=100, quantity=100, remaining=0; target sold tăng 189); my-tickets của 1 user bị chuyển vẫn thấy vé; Redis `ticket_stock` 2 type khớp DB.
7. Quan sát 24h trước khi coi như ổn định. Nếu lỗi → §5.3.

### 5.3. Revert

- **Trong mọi trường hợp ưu tiên**: `POST admin/ticket-split/rollback { contentAuditId, repointAuditId }` — nghịch đảo tự động manifest (xác suất cao nhất thành công ngay sau apply, trước khi có hoạt động mới).
- Nếu rollback 409 drift: đọc message + manifest AuditLog (§2.2 có FULL row từng vé) → xử lý thủ công bằng SQL (WHERE id IN movedIds → set ticketTypeId lại source; set lại sold/quantity 2 type theo snapshot) — chạy trong tx + advisory lock, rồi bump lại snapshotVersion + gọi lại Redis sync (hoặc restart content để re-seed).
- Worst case: restore từ CSV §5.1 (chỉ đè các row theo id manifest, KHÔNG truncate bảng).

### 5.4. Sau khi ổn định

- Mở lại đăng ký nếu cần (source đã sold-out 100 — chính là mục đích).
- KHÔNG xóa AuditLog TICKET_TYPE_SPLIT / SPLIT_REPOINT DistributionAudit.
- NOTE (Q3): 189 user không được thông báo tự động v1 — nếu cần, export movePreview → gửi email thủ công (task tương lai).

### 5.5. Smoke checklist (chạy trên môi trường dev/staging TRƯỚC khi đụng production)

Mọi bước dùng UI "Điều chuyển vé" (`/admin/split-ticket-types`) hoặc API thẳng. Seed test event với 10 vé createdAt spread + 1 target đủ chỗ:

1. **Plan**: keepCount=3 → `eligibleCount=10`, `moveCount=7`, movePreview = 7 vé MỚI NHẤT (createdAt desc), projection source sold 10→3.
2. **Apply "SPLIT"**: response `status=split`, `auditId` + `local.repointAuditId` khác rỗng. DB: đúng 7 vé đổi `ticketTypeId`, source quantity/sold = 3, target sold +7, `event.maxParticipants` & `checkInSnapshotVersion` bump. Redis `ticket_stock:{src}`/`{tgt}` khớp DB.
3. **Rollback "ROLLBACK"** (điền 2 auditId từ kết quả) → state y nguyên từng field (so §5.1 CSV), Redis khớp.
4. **Rollback lần 2** → 409 `TICKET_TYPE_SPLIT_ROLLBACK_CONFLICT`.
5. **Drift**: apply lại → đăng ký 1 vé mới vào target → rollback → 409 drift (đúng hành vi D9).
6. **Blocker reservation**: tạo PENDING reservation trên source → apply → 409 `TICKET_TYPE_SPLIT_BLOCKED` (không vé nào đổi).
7. **Vé USED trong tập**: apply OK + warning; check-in vé đó (online) vẫn pass.
8. **Hạ tầng**: restart content-service sau apply → Redis re-seed từ DB-truth khớp (không lệch).
9. **UI**: nav "Điều chuyển vé" hiện cạnh "Gộp loại vé"; confirm sai chuỗi (gõ "MERGE") → nút Apply khóa/400.

PASS toàn bộ mới chạy §5.2 production.

---

## 6. Rủi ro & mitigation

| Rủi ro | Mitigation |
|---|---|
| Race đăng ký mới trong lúc apply | Blocker reservation + selection in-tx + advisory lock; runbook đóng gate trước |
| Lost-update counter với register đồng thời | D4 increment thay vì set tuyệt đối |
| Redis sync fail sau commit | Log CRITICAL + re-seed an toàn khi restart (stock key không TTL — pattern refreshSoldFromDb); runbook verify §5.2.6 |
| Rollback 2 lần | Marker audit (409) |
| Drift sau split khiến rollback chặn | Drift check 409 + manifest full-row cho restore tay + CSV lạnh |
| Manifest quá lớn | 189 vé × 21 field ~ vài trăm KB TEXT — ổn; nếu event nghìn vé thì cap + file phụ (không cần cho kịch bản này) |
| Offline check-in stale type name | D10 bump snapshotVersion → device tự refresh |

---

## 7. Cam kết revert-ability (tổng kết cho yêu cầu "lỡ thì còn revert được")

1. **Không migration schema** — deploy code additive, revert deploy = xóa code.
2. **AuditLog manifest full** (mọi cột 189 vé + snapshot 2 type + maxParticipants + snapshotVersion) — rollback 1 lệnh.
3. **CSV backup lạnh** trước apply.
4. **Rollback idempotent + drift-guard + marker** — không bao giờ rollback "nhầm" khi state đã đổi.
5. Redis luôn re-seed được từ DB-truth (DB là nguồn sự thật — nguyên tắc architecture).

---

## 8. Deploy & git

- Branch: `feature/ticket-type-split` ở cả 2 repo; deploy content-service trước, ticket-mayo sau.
- KHÔNG auto-commit (memory rule) — user tự review diff rồi commit; mọi lệnh git `git -C <repo>`.
- Endpoints internal cần `x-service-token` (ServiceTokenGuard); admin cần JWT ADMIN (AdminAuthGuard) — không expose publicly.
