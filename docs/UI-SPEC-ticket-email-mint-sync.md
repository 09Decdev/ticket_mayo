# UI-SPEC: Ticket Email Eager-Mint & Sync — Giao diện Admin Portal + End-user

**Version**: 0.1 (Draft — chờ vòng phản biện)
**Date**: 2026-08-27
**Author**: UX Architect / UI Designer (autobuild)
**Nguồn_input**:
- `docs/PRD-ticket-email-mint-sync.md` (Approved v1.1 — Story E/H/F/G, §5, §7.4, §7.5)
- `docs/PLAN-ticket-email-mint-sync.md` (T5 getStatus, T7 backfill report, T8 admin UI)
- `docs/WORKFLOW-ticket-email-mint-sync.md` (state machines §1, WF1-R1/R2, F-04/F-05/F-06/F-08, WF3 C3, WF4)
- Khảo sát frontend thật (danh sách file ở §1)

**Scope**: 5 nhóm màn hình — KHÔNG phải redesign. Mọi màn tái dùng component/class CSS hiện có, chỉ thêm phần tử mới nơi dữ liệu mới xuất hiện.

**Non-goals (không làm)**: mobile app/scanner, đổi flow check-in, dashboard content-service, hiển thị plaintext email (không có dữ liệu — PRD §7.5/Q6), refund/hủy vé, tự retry email gửi fail (chỉ nút gửi lại thủ công theo F-06).

---

## 1. Nền tảng khảo sát frontend (spec bám theo cái đã có)

| Khía cạnh | Hiện trạng (cite file) | Quyết định cho UI-SPEC |
|---|---|---|
| Stack | React + Vite + TS, react-router (`frontend/src/App.tsx`) | Không thêm thư viện mới |
| Style | **CSS global 1 file** `frontend/src/styles.css` (KHÔNG Tailwind/CSS-module), biến `:root` (`--primary`, `--ok`, `--danger`, `--warn`…), class `.card .table .badge .progress .btn .row .muted .empty .error-box .tag-list .hint .mono` | Chỉ thêm class badge mới (`badge-linked`, `badge-expired`, `badge-minting`) + tái dùng toàn bộ còn lại |
| Component dùng chung | `frontend/src/components/Card.tsx`, `Button.tsx`, `Badge.tsx` (StatusBadge), `Spinner.tsx`, `Layout.tsx` (AdminLayout sidebar) | Tái dùng nguyên vẹn; mở rộng `Badge.tsx` thêm PreTicketBadge |
| Error pattern | **KHÔNG có toast** — mọi page dùng `<div className="error-box">` inline (`DistributionDetailPage.tsx:48`, `ConfirmDistributionStep.tsx:50`) | Giữ error-box inline; KHÔNG bịa toast |
| Empty pattern | `<div className="empty">` (`DistributionsListPage.tsx:42`, `MyTicketsPage.tsx:55`) | Giữ |
| Loading pattern | `<Spinner />` / `<Spinner large />` (`DistributionDetailPage.tsx:47`) | Giữ |
| Polling pattern | `DistributionDetailPage.tsx:21-45`: poll `/status` 2.5s khi job PENDING/RUNNING, cleanup timer | Tái dùng, mở rộng điều kiện poll (xem Màn 1) |
| Badge helper | `frontend/src/common/format.ts` `statusBadgeClass()` — chỉ 3 TicketStatus | Thêm `preTicketBadgeClass()` cho 7 trạng thái mới |
| API client | `frontend/src/api/ticket.client.ts` (axios + unwrap + toApiError), types ở `api/types.ts` | Thêm type mới vào `types.ts`, method mới vào client |
| Claim-link web hiện tại | Route `/c/:token` + `/claim/:token` → `claim/AppDownloadPage.tsx` (chỉ hiện "Vé của bạn đang trong ứng dụng" + nút tải app). `claim/ClaimRedirectPage.tsx` TỒN TẠI nhưng **KHÔNG được mount** trong `App.tsx` | Màn 3 (E1 landing) thay thế nội dung AppDownloadPage — xem §4 |

**Response shape thật hiện tại (đối chiếu code, không đoán):**

- `GET /admin/distributions/:id/status?includeFailed=true` (`distribution.controller.ts:41-46` → `distribution.service.ts:176-184`) trả `{ job, preTickets? }` với `job` = raw Prisma `DistributionJob` (`total, sent, failed, status: PENDING|RUNNING|COMPLETED|FAILED, idempotencyKey, createdAt, eventName, ticketTypeName`…), `preTickets[]` = `{ id, recipientEmailHash, claimToken, status: PENDING|CLAIMING|CLAIMED|EXPIRED, contentTicketId?, contentTicketCode?, createdAt, claimedAt? }`.
- `api/types.ts:2-3`: `DistributionStatus = 'PENDING'|'RUNNING'|'COMPLETED'|'FAILED'`, `PreTicketStatus = 'PENDING'|'CLAIMED'|'EXPIRED'` — **cả 2 type này phải mở rộng** (§7).
- `TicketType.quota` trong `api/types.ts:32` thực chất là **remaining** (`event.service.ts:151-158`: `quota: t.remaining` map từ content `sold/quantity`) → Màn 5 dùng `quota` làm "còn lại" hiển thị trực tiếp, không cần API mới.
- `GET /tickets/me` trả `{ tickets, claimedTickets }`; `MyTicketsPage.tsx:40-54` đã có banner "Đã tự động gắn N vé" — tái dùng cho sync (Màn 4).

---

## 2. Hệ thống trạng thái hiển thị (chuẩn hóa toàn UI)

### 2.1. DistributionJob badge (mở rộng từ `statusCls()` trong `DistributionsListPage.tsx:9-13`)

| Trạng thái job | Class CSS | Màu ngữ nghĩa | Nhãn hiển thị |
|---|---|---|---|
| PENDING / RUNNING | `badge badge-progress` (hiện có) | xanh dương | RUNNING — kèm sub-label bước đang chạy: "Đang tạo vé" (MINTING) hoặc "Đang gửi email" |
| COMPLETED | `badge badge-valid` (hiện có) | xanh lá | HOÀN TẤT |
| FAILED | `badge badge-cancelled` (hiện có) | đỏ | THẤT BẠI |
| **PARTIALLY_MINTED** (mới) | `badge badge-used` (tái dùng warn) | vàng | TẠO VÉ MỘT PHẦN — cần thao tác (Màn 1.4) |

### 2.2. PreTicket badge — mở rộng `Badge.tsx` thành component `PreTicketBadge`

Enum mới (WORKFLOW §1.1): `PENDING | MINTING | MINTED | LINKED | CLAIMING | CLAIMED | EXPIRED`.

| Trạng thái | Class CSS | Nhãn tiếng Việt (admin) | Ý nghĩa hiển thị |
|---|---|---|---|
| PENDING | `badge badge-progress` | CHỜ TẠO VÉ | chưa mint (chờ retry / LAZY cũ) |
| MINTING | `badge badge-minting` (mới — nền `#e7f0ff` + viền animate pulse) | ĐANG TẠO VÉ | in-flight; > 10 phút = stuck (WORKFLOW quy ước) |
| MINTED | `badge badge-valid` | ĐÃ TẠO VÉ | vé tồn tại, chưa gắn user (email-only) |
| LINKED | `badge badge-linked` (mới — tái dụng biến `--ok-bg` nhưng viền đậm + dấu ✓ user) | ĐÃ GẮN TÀI KHOẢN | vé + userId |
| CLAIMING | `badge badge-progress` | ĐANG NHẬN (cũ) | legacy in-flight |
| CLAIMED | `badge badge-valid` (hiện có, giữ nhãn) | ĐÃ NHẬN | legacy terminal |
| EXPIRED | `badge badge-expired` (mới — tái dùng `--danger-bg` nhạt, chữ `--muted`) | HẾT LƯỢT | terminal backfill |

CSS mới thêm vào `styles.css` (chỉ 3 class, theo đúng pattern badge hiện có dòng 232-259):

```css
.badge-minting { background: #e7f0ff; color: var(--primary); border-color: #c5d8fb; }
.badge-linked  { background: var(--ok-bg); color: var(--ok); border-color: var(--ok); }
.badge-expired { background: #f1f2f4; color: var(--muted); border-color: var(--border); }
```

### 2.3. Nguyên tắc chạy song song LAZY/EAGER trong UI

- Job LAZY (cũ) KHÔNG có mint counts → panel mint (Màn 1.2) **render điều kiện**: chỉ hiện khi `job.minted !== undefined` (field mới của T5). Không có field → giữ layout cũ (claimed/pending) nguyên vẹn.
- Đề xuất (đánh dấu **UI-P1** cho backend T5): getStatus thêm `job.mintMode: 'LAZY' | 'EAGER'` để job detail hiển thị chip "Chế độ: EAGER" — tránh admin nhầm lần phát cũ/mới. Nếu backend không thêm được, UI fallback theoRule "có mint counts = EAGER".
- **F-08 (bắt buộc)**: màn claim-link xử lý ĐỦ 7 trạng thái PreTicket bất kể flag đang LAZY hay EAGER — state machine là nguồn sự thật, flag chỉ chọn chiến lược mint. Nếu không, rollback flag → 500 hàng loạt (WORKFLOW §7.2).

---

## 3. MÀN 1 — Admin: Job detail (T8 + WF1 recovery)

File sửa: `frontend/src/admin/DistributionDetailPage.tsx`. Route hiện có `/admin/distributions/:jobId`.

### 3.1. Wireframe — trạng thái đang chạy (EAGER)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Phát vé: Sự kiện X — Vé VIP                    [Chế độ: EAGER]  [← Danh sách]│
├──────────────────────────────────────────────────────────────────────────────┤
│ Card "Trạng thái đợt phát"                                                    │
│                                                                              │
│  [RUNNING · Đang tạo vé]              Tạo: 27/08/2026, 10:32                 │
│                                                                              │
│  ① Tạo vé (mint)          ████████████░░░░░░░░░░   812 / 1.000  (81%)        │
│  ② Gửi email              ░░░░░░░░░░░░░░░░░░░░░░     0 / 1.000  (0%)         │
│     └ Email chỉ bắt đầu sau khi vé tạo xong (mỗi chunk)                      │
│                                                                              │
│  Đã tạo vé: 812 · Kèm tài khoản: 530 · Chờ tạo tài khoản: 282 · Lỗi: 0      │
└──────────────────────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────────────────────┐
│ Card "Chi tiết vé (PreTicket)"                    [Lọc trạng thái ▼] [Tìm mã]│
│                                                                              │
│  Mã claim        Trạng thái        Tài khoản   Đã gửi email   Tạo vé lúc     │
│  ────────────────────────────────────────────────────────────────────────────│
│  a1b2c3d4e5f6…  [ĐANG TẠO VÉ]      —           —              —              │
│  9f8e7d6c5b4a…  [ĐÃ TẠO VÉ]        —           ⏳ chưa gửi     10:32:11      │
│  7a6b5c4d3e2f…  [ĐÃ GẮN TÀI KHOẢN] ✓ có        ✓ 10:32:15     10:32:11      │
│  …                                                                           │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 3.2. Panel mint counts (chỉ EAGER — Story H / PLAN T5)

| UI element | API field (getStatus mới) | Ghi chú |
|---|---|---|
| "Đã tạo vé: N" | `job.minted` | = MINTED + LINKED (đếm từ PreTicket, PLAN T5 mục 3) |
| "Kèm tài khoản: N" | `job.mintedWithUser` | PreTicket có `recipientUserId` |
| "Chờ tạo tài khoản: N" | `job.mintedEmailOnly` | MINTED, chưa LINKED — copy admin thân thiện, không nói "email-only" |
| "Lỗi: N" | `job.mintFailed` | kèm link anchor "xem chi tiết" → filter bảng PreTicket status=PENDING trong job PARTIALLY_MINTED |
| Thanh ① "Tạo vé" | `job.minted / job.total` | mới — `.progress` hiện có |
| Thanh ② "Gửi email" | `job.sent / job.total` | chính là progress `sent/total` hiện có (`DistributionDetailPage.tsx:52`), giữ |
| Sub-label RUNNING | `job.status` + tồn tại PreTicket MINTING → "Đang tạo vé"; chỉ MINTED → "Đang gửi email" | — |

Polling: giữ pattern 2.5s hiện có, mở rộng điều kiện dừng — poll tiếp khi `status ∈ {PENDING, RUNNING}` HOẶC có PreTicket `MINTING` tuổi < 10 phút. Job PARTIALLY_MINTED dừng poll (đã terminal — chờ action admin).

### 3.3. Bảng PreTicket mở rộng (thay bảng 4 cột hiện có dòng 82-106)

Cột mới map field:

| Cột | API field (PreTicketView mở rộng) | Empty/loading |
|---|---|---|
| Mã claim | `claimToken.slice(0,16)…` (hiện có) | — |
| Trạng thái | `status` → `PreTicketBadge` (§2.2) | — |
| Tài khoản | `recipientUserId ? '✓ có' : '—'` (field mới T4) | null → "—" |
| Đã gửi email | `emailSentAt` (field mới F-05) → "✓ HH:mm" / "chưa gửi" | null → "chưa gửi" |
| Ghi chú lỗi | `mintReason` (đề xuất UI-P2: reason per PreTicket khi fail) | — |
| Tạo vé lúc | `mintedAt` (đề xuất UI-P2; fallback `contentTicketId != null` → dùng `updatedAt`) | — |

KHÔNG có cột email/emailHash hiển thị — đối chiếu người nhận chỉ qua mã claim (PRD Story H AC3, PLAN T8 mục 3).

### 3.4. Trạng thái PARTIALLY_MINTED — action "Thử lại phần lỗi" (F-04 / WF1-R2)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Card "Trạng thái đợt phát"                                                    │
│                                                                              │
│  [TẠO VÉ MỘT PHẦN]  ⚠ 120/1.000 vé chưa tạo được do lỗi hệ thống.           │
│     880 vé đã tạo và gửi email bình thường.                                  │
│                                                                              │
│  Đã tạo vé: 880 · Kèm tài khoản: 530 · Chờ tạo tài khoản: 350 · Lỗi: 120    │
│                                                                              │
│  [Thử lại 120 vé lỗi]   ← nút `btn`, chỉ mint + email CHO 120 vé PENDING,    │
│                          KHÔNG đụng 880 vé đã thành công                     │
└──────────────────────────────────────────────────────────────────────────────┘
```

- Nút "Thử lại N vé lỗi": `POST /admin/distributions/:id/retry` (**endpoint mới — UI-P3**, chốt ở T5; body rỗng, server tự lấy PreTicket PENDING của job — guard WF1-R2). Sau click: spinner trong nút (pattern `Button loading` hiện có) → quay lại polling ①.
- **KHÔNG** có nút "phát lại cả job" — retry bằng idempotencyKey là no-op, key mới = email đôi (F-04). Copy hint dưới nút: "Chỉ xử lý lại các vé lỗi. Người đã nhận vé sẽ không nhận thêm email."
- Xác nhận: KHÔNG cần modal (hành động idempotent, an toàn) — nhưng disabled khi `mintFailed === 0`.

### 3.5. Trạng thái FAILED do hết quota (Story F) — lỗi thân thiện

Hiện tại error API hiện raw qua `e?.message`. Với quota (TICKET_SOLD_OUT → ConflictException từ T5 mục 4), message server đã có dạng tiếng Việt chứa remaining/requested. UI bắt `code === 'TICKET_SOLD_OUT'`:

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  [THẤT BẠI]                                                                   │
│  ⚠ Không phát được: loại vé chỉ còn 10 vé, đợt này cần 15.                  │
│     Chưa gửi email nào, chưa tạo vé nào. Thu gọn danh sách hoặc chọn loại   │
│     vé khác rồi phát lại.                                                    │
│      → link: [Sửa đợt phát] (về bước 3 chọn loại vé, giữ draft)              │
└──────────────────────────────────────────────────────────────────────────────┘
```

- Format từ field lỗi: `remaining`, `requested` (per PLAN T5 AC "message chứa remaining=10"). Frontend render template — KHÔNG dump raw message/stack.
- Job FAILED lý do khác (content 5xx): error-box "Lỗi hệ thống khi tạo vé, chưa gửi email nào. Thử lại sau hoặc liên hệ kỹ thuật." + mã lỗi (`code`) dạng mono nhỏ để báo kỹ thuật.

### 3.6. Trạng thái COMPLETED + email fail (F-06) — KHÔNG đánh dấu job FAILED

Điều kiện: `job.status === 'COMPLETED' && job.sent === 0 && job.minted > 0` (hoặc audit EMAIL_ALL_FAILED):

```
│  [HOÀN TẤT]  ✔ 1.000 vé đã tạo thành công.                                  │
│  ⚠ Nhưng gửi email thất bại toàn bộ (lỗi hệ thống email).                    │
│     Vé vẫn thuộc về người nhận — chỉ cần gửi lại email.                      │
│     [Gửi lại email cho 1.000 người]                                          │
```

- Nút: `POST /admin/distributions/:id/resend-emails` (**endpoint mới — UI-P4**, chỉ PreTicket MINTED/LINKED với `emailSentAt = null` hoặc email-failed — guard F-05 chống email đôi).
- Trường hợp `sent > 0 && failed > 0`: giữ dòng tổng hiện có ("Đã gửi x/y · Lỗi email: z") + link nhỏ "Gửi lại z email lỗi" cùng endpoint.

### 3.7. Job list (DistributionsListPage) — thay đổi tối thiểu

- Cột "Trạng thái" thêm case PARTIALLY_MINTED → `badge-used` + nhãn "TẠO VÉ MỘT PHẦN" (hàng này click vào detail để retry).
- Thêm 1 cột "Đã tạo vé" (`minted/total`) SAU cột "Đã gửi" — chỉ khi field tồn tại (LAZY job cũ hiện "—"). KHÔNG thêm cột mintWithUser/EmailOnly vào list (thừa — thuộc detail).

---

## 4. MÀN 2 — Admin: Backfill report (T7 / WF4)

Màn MỚI. Đề xuất route `/admin/backfill` + link sidebar "Backfill vé cũ" (chỉ hiện khi `DISTRIBUTION_MINT_MODE=EAGER` — cần endpoint trạng thái; nếu không có, hiện luôn — chạy dry-run vô hại).

File mới: `frontend/src/admin/BackfillReportPage.tsx`. Endpoint mới (**UI-P5**, từ T7 script → cần expose API): `GET /admin/backfill/dry-run` và `POST /admin/backfill/run`.

### 4.1. Wireframe — dry-run

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Backfill vé cũ — Xem trước (dry-run)                                         │
│ (Chưa thay đổi gì. Bấm "Chạy thật" mới mint vé.)                             │
├──────────────────────────────────────────────────────────────────────────────┤
│ Card "Tổng quan"                                                              │
│                                                                              │
│  Loại vé            Chờ mint   Còn lại   Sẽ mint   Sẽ hết lượt               │
│  ────────────────────────────────────────────────────────────────────────────│
│  Vé VIP ngày 1           30         10        10          20  ⚠             │
│  Vé thường ngày 1       120        200       120           0                │
│  ────────────────────────────────────────────────────────────────────────────│
│  TỔNG                   150        210       130          20                │
│                                                                              │
│  ⚠ Có 20 vé không đủ lượt phát. Nếu chạy thật, 20 vé này sẽ bị đánh dấu     │
│    "Hết lượt" (EXPIRED) vĩnh viễn và KHÔNG thể hồi sinh — phải liên hệ       │
│    từng người nhận để phát lại bằng đợt phát mới.                            │
│                                                                              │
│  [Chạy thật backfill]  (disabled đến khi tick xác nhận bên dưới)             │
│  ☐ Tôi hiểu 20 vé sẽ bị đánh dấu "Hết lượt" và đã sẵn sàng liên hệ           │
│    những người nhận này.                                                     │
└──────────────────────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────────────────────┐
│ Card "20 vé sẽ bị hết lượt" (chỉ hiện khi willExpire > 0)                    │
│                                                                              │
│  Mã claim        Loại vé           Đợt phát gốc           Ngày phát          │
│  a1b2c3d4…       Vé VIP ngày 1     Job 20260820-abc       20/08/2026         │
│  … (pagination 20/page — pattern list hiện có)                               │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 4.2. Map field dry-run (shape đề xuất cho T7 expose)

| UI element | API field đề xuất | Ghi chú |
|---|---|---|
| Bảng theo loại vé | `report.items[]: { ticketTypeId, ticketTypeName, pending, remaining, willMint, willExpire }` | willMint = min(pending, remaining); willExpire = max(0, pending − remaining) |
| Dòng TỔNG | `report.totals: { pending, willMint, willExpire }` | — |
| Danh sách sẽ EXPIRED | `report.expiringPreTickets[]: { id, claimToken, ticketTypeName, jobId, createdAt }` | KHÔNG có email (chỉ hash tồn tại ở DB) — cột "Mã claim" là handle đối chiếu duy nhất |
| Guard confirm | client-side checkbox + gọi run với `{ confirmed: true }` | server vẫn guard riêng (T7 `--confirm`) |

### 4.3. Wireframe — đang chạy / xong

```
│  Đang chạy: [███░░░░░░░░] 60/130 vé                          (poll 2.5s)     │
│  Đã tạo: 60 · Kèm tài khoản: 22 · Chờ tài khoản: 38                         │
│  ── xong ──                                                                   │
│  ✔ Backfill hoàn tất: 130 vé tạo mới, 20 vé hết lượt.                        │
│    [Xem 20 vé hết lượt]  [Xem lịch phát vé]                                  │
│  (chạy lại: chỉ còn đếm technical-fail — idempotent, báo số 0 nếu sạch)      │
```

- Loading: Spinner + poll progress (`runStatus.minted / runStatus.total`).
- Error giữa chừng: error-box "Backfill dừng ở vé thứ N (lỗi hệ thống). Các vé đã tạo vẫn an toàn. Bấm 'Tiếp tục backfill' — chỉ xử lý phần còn lại." + nút retry cùng endpoint (idempotent WF4 §6.2).
- Empty state: "Không có vé cũ cần xử lý. Mọi vé đều đã được tạo sẵn." (khi totals.pending = 0).

---

## 5. MÀN 3 — End-user: Claim-link landing (E1) — 3 trạng thái chính + 3 trạng thái biên

File sửa: `frontend/src/claim/AppDownloadPage.tsx` (đang là nội dung duy nhất của `/c/:token` và `/claim/:token`). Giữ tông màn standalone nền tối hiện có (`#12101c`), KHÔNG nhét vào layout admin.

**Nguyên tắc copy (PRD Story E + Q5)**: không dùng từ "mint", "claim", "PreTicket", "token". Người thường chỉ biết: "vé của tôi", "xem vé", "tạo tài khoản".

Cấu trúc chung: trang landing gọi `GET /claim/:token` TRƯỚC (endpoint hiện có — mở rộng response per UI-P6), rồi rẽ nhánh theo status. Nút "Tải ứng dụng" hiện có giữ lại ở mọi nhánh (link phụ, vì web hiện là fallback cho app).

### 5.1. (a) Đã có tài khoản + vé đã tạo → XEM VÉ NGAY

```
┌────────────────────────────────────────────┐
│                                            │
│        🎟  Vé của bạn đã sẵn sàng          │
│                                            │
│   Bạn có vé cho sự kiện này.               │
│   Đang mở danh sách vé…                    │
│   (tự chuyển sau 1-2 giây → "Vé của tôi")  │
│                                            │
│   [Xem vé của tôi]      [Tải ứng dụng]     │
└────────────────────────────────────────────┘
```

- Điều kiện: PreTicket MINTED/LINKED + user đã login + emailHash khớp → server trả `{ ok: true, ticketId? }` (dạng hiện có của ClaimResult) → redirect `/portal/tickets/:ticketId` hoặc `/portal/tickets`.
- Nếu sync chưa kịp (MINTED + email-only): server chạy sync rồi trả (WF3 C3 nhánh 1) — UI không cần biết, chỉ redirect. Sync fail vẫn redirect (WF3 5.2 — không hard-error).
- Loading: Spinner (pattern hiện có). Auto-redirect sau response — KHÔNG đếm giây ở client.

### 5.2. (b) Chưa có tài khoản, vé đã tạo (email-only) → "TẠO TÀI KHOẢN ĐỂ XEM VÉ"

```
┌────────────────────────────────────────────┐
│                                            │
│        🎟  Bạn có vé đang chờ              │
│                                            │
│   Vé đã được cấp cho email của bạn.        │
│   Tạo tài khoản với đúng email này để      │
│   xem vé và mã QR check-in.                │
│                                            │
│   [Tạo tài khoản để xem vé]                │
│                                            │
│   Đã có tài khoản? Đăng nhập               │
│                                            │
│   ────────────── hoặc ──────────────       │
│   [Tải ứng dụng]                           │
└────────────────────────────────────────────┘
```

- Điều kiện: server trả `{ needsAuth: true }` (giữ nguyên contract hiện có `claim.service.ts` — không leak email).
- Nút chính → `/portal/signup?next=/portal/tickets`. Sau register: banner + vé xuất hiện (Màn 4). Copy signup hiện có đã đúng ("Dùng đúng email đã nhận vé. Vé sẽ tự động gắn vào tài khoản." — `UserSignupPage.tsx:51-53`), giữ nguyên.
- Nhánh "đã login nhưng email KHÔNG khớp": cũng `needsAuth` (WF3 C3 — không leak) → hiện màn này với thêm dòng nhỏ: "Bạn đang đăng nhập bằng email khác. Để xem vé, dùng tài khoản khớp email nhận được." — phân biệt bằng JWT email client-side, KHÔNG dựa server.

### 5.3. (c) Mode LAZY (cũ) → flow hiện tại GIỮ NGUYÊN

- PreTicket PENDING → server lazy-mint như hiện tại (WF3 C3-PENDING legacy). Client: giữ nguyên logic `resolveClaim` hiện có trong `ClaimRedirectPage.tsx` (nội dung logic đó được hợp nhất vào màn landing mới — file này hiện không được route nên không phá gì).
- Kết quả `ok + ticketId` → redirect chi tiết vé — giống 5.1.

### 5.4. Trạng thái biên (bắt buộc theo WF3 C3 — chống 500 khi rollback flag, F-08)

| PreTicket status | UI hiển thị |
|---|---|
| MINTING | "Hệ thống đang xử lý vé của bạn. Thử lại sau ít phút." + nút [Thử lại] (reload page). Copy từ WF3 C3 — thường < 1 phút. |
| EXPIRED (backfill hết quota) | "Vé này đã hết hạn do hết lượt phát. Vui lòng liên hệ ban tổ chức." — KHÔNG hứa vé, KHÔNG gợi tạo tài khoản (tạo rồi cũng không có vé — tránh phản cảm). Kèm nút [Tải ứng dụng] phụ. |
| Token không tồn tại | 404 generic giữ nguyên — trang "Liên kết không hợp lệ hoặc đã hết hạn." |
| CLAIMED (legacy, cùng user) | redirect xem vé như 5.1 (dùng `alreadyClaimed` hiện có). |

### 5.5. Map field claim response (đề xuất mở rộng ClaimResult — UI-P6)

| Nhánh UI | API field | Trạng thái hiện có/chưa có |
|---|---|---|
| Xem vé ngay | `{ ok: true, ticketId? }` | hiện có (`api/types.ts:104-112`) |
| Tạo tài khoản | `{ needsAuth: true }` | hiện có |
| Đang xử lý (MINTING) | `{ processing: true }` | **mới** |
| Hết lượt (EXPIRED) | `{ expired: true }` | **mới** |
| Lỗi khác | `{ ok: false, message }` | hiện có |

---

## 6. MÀN 4 — End-user: "Vé của tôi" lần đầu sau sync (Story C/D)

File: `frontend/src/portal/MyTicketsPage.tsx`. Thay đổi NHỎ — nền đã đúng.

### 6.1. Wireframe — empty-state ngắn rồi vé xuất hiện

```
── Lần đầu sau register (sync nền chạy trong cùng request) ──────────────────

Trường hợp 1 — sync kịp (per PRD target ≤ 2s, listMyTickets sync TRƯỚC list):
│  Vé của tôi                                                                  │
│  ✔ Đã tự động gắn 3 vé vào tài khoản của bạn.        ← banner hiện có :40   │
│  ┌ Bảng vé (3 dòng) — render ngay, không nhấp nháy ─┘                       │

Trường hợp 2 — sync fail (content timeout, fail-soft WF2):
│  Vé của tôi                                                                  │
│  Bạn chưa có vé. Nếu vừa tạo tài khoản sau khi nhận email mời,              │
│  vé có thể đang được đồng bộ — [Làm mới] trong giây lát.                    │
│  (Nếu vẫn không thấy sau 1 phút: kiểm tra tài khoản của bạn đăng ký         │
│   bằng ĐÚNG email đã nhận vé.)                                              │
│                                       [Làm mới]  ← reload data, KHÔNG F5    │
```

- Banner "Đã tự động gắn N vé": giữ nguyên component/inline-style hiện có (`MyTicketsPage.tsx:40-54`), source `claimedTickets` từ `GET /tickets/me` (semantics đổi sang linked-count — WORKFLOW WF2) + location state từ register (hiện có).
- Empty-state mới: copy ở trên thay cho copy hiện có khi `claimedTickets === 0 && tickets.length === 0` **và** user vừa register/login trong session (đo bằng location state / sessionStorage flag set lúc auth). User cũ truy cập bình thường → giữ empty hiện có ("Bạn chưa có vé. Nếu đã nhận email mời…" — vẫn đúng).
- Nút [Làm mới]: re-gọi `getMyTickets()` (không reload trang) — request kế tự retry sync (WF2 fail-soft). Loading: Spinner inline.
- Loading đầu trang: `<Spinner large />` hiện có — giữ. KHÔNG thêm skeleton (ngoài scope, không có pattern skeleton trong codebase).

### 6.2. Map field

| UI element | API field | Ghi chú |
|---|---|---|
| Banner gắn vé | `claimedTickets` (`GET /tickets/me` + register/login response) | hiện có |
| Bảng vé | `tickets[]` (`TicketView` hiện có) | hiện có — không đổi cột |
| Empty-state + nút Làm mới | client-side only (không API mới) | — |

---

## 7. MÀN 5 — Admin: Distribute wizard — hiển thị remaining + cảnh báo vượt (Story F pre-check)

Files sửa: `frontend/src/admin/SelectTicketTypeStep.tsx` (bước 3) + `ConfirmDistributionStep.tsx` (bước 4). KHÔNG thêm bước wizard.

Dữ liệu: `ticketClient.listTicketTypes()` đã trả `quota` = **remaining thực tế** (map từ content, §1) — không cần API mới cho hiển thị.

### 7.1. Wireframe — bước 3 (chọn loại vé)

```
│  Loại vé *                                                                   │
│  ┌────────────────────────────────────────────┐                             │
│  │ — Chọn loại vé —                           │                             │
│  │ Vé VIP · 200.000đ · còn 10 vé   ⚠ ít      │ ← option text thêm "còn N"  │
│  │ Vé thường · miễn phí · còn 200 vé          │                             │
│  └────────────────────────────────────────────┘                             │
│  Còn lại: 10 vé                                                             │
│                                                                              │
│  Số vé mỗi email *                                                           │
│  [ 2 ]                                                                      │
│  Tổng vé sẽ tạo: 30 (15 email × 2)                                          │
│  ⚠ Vượt số vé còn lại: cần 30 nhưng chỉ còn 10. Đợt phát sẽ BỊ TỪ CHỐI.    │
│    Giảm số lượng, bỏ bớt email, hoặc chọn loại vé khác.                     │
│  (cảnh báo vàng `.hint` đậm — KHÔNG disable nút Tiếp theo: admin có thể     │
│   quay lại sửa; server vẫn là guard cuối)                                    │
```

### 7.2. Wireframe — bước 4 (xác nhận)

```
│  Card "Tóm tắt"                                                              │
│  …(bảng hiện có)…                                                            │
│  Số người nhận           15                                                  │
│  Vé mỗi email            2                                                   │
│  Tổng vé sẽ tạo          30                                                  │
│  Loại vé còn lại         10   ⚠ VƯỢT 20 VÉ                                   │
└──────────────────────────────────────────────────────────────────────────────┘
│  ⚠ Chỉ còn 10 vé nhưng đợt này cần 30. Nếu vẫn tiếp tục, toàn bộ đợt sẽ     │
│    bị từ chối và KHÔNG có email nào được gửi.                                │
│  [Quay lại]  [Phát vé (30)]  ← nút chính disabled khi total > remaining      │
```

Quyết định khác nhau 2 bước (điểm tranh luận — xem cuối doc): bước 3 chỉ cảnh báo, bước 4 **disable nút Phát** khi vượt (fallback được: remaining có thể stale — thêm link nhỏ "Vẫn phát (bỏ qua cảnh báo)" KHÔNG đưa vào; admin phải sửa input. Nếu remaining stale thấp hơn thật, admin reload trang để lấy số mới).

### 7.3. Map field

| UI element | API field | Ghi chú |
|---|---|---|
| "còn N vé" trong option + dòng "Còn lại" | `TicketType.quota` (= content remaining) | hiện có — chỉ thêm hiển thị |
| Cảnh báo vượt | client tính `emails.length × quantity > quota` | — |
| Dòng "Loại vé còn lại" ở bước 4 | `draft` + re-fetch `listTicketTypes` khi vào bước 4 (để remaining tươi nhất có thể) | — |
| Lỗi 409 từ server khi tạo | `e.code === 'TICKET_SOLD_OUT'` → error-box template §3.5 | T5 đảm bảo code |

Loading/error từng màn đều theo pattern hiện có (Spinner + error-box); mọi màn KHÔNG có plaintext email.

---

## 8. Bảng tổng hợp API field mới ↔ UI (đối chiếu PLAN T5 + WORKFLOW)

| Field mới | Nguồn spec | Dùng ở màn | UI-P |
|---|---|---|---|
| `job.minted / mintedWithUser / mintedEmailOnly / mintFailed` | PLAN T5 mục 3, Story H | 1 | — (đã trong plan) |
| `job.status` += `PARTIALLY_MINTED` | WORKFLOW §1.2 | 1, 1.4, 3.7 | — |
| `job.mintMode: 'LAZY'\|'EAGER'` | **đề xuất mới** | 1 chip | UI-P1 |
| `PreTicketView.status` += `MINTING/MINTED/LINKED` | T4 + WORKFLOW §1.1 | 1, 3 | — |
| `PreTicketView.recipientUserId` | T4 | 1 cột Tài khoản | — |
| `PreTicketView.emailSentAt` | F-05 / WF1-R1 | 1 cột Đã gửi email | — |
| `PreTicketView.mintReason / mintedAt` | **đề xuất mới** (reason per R6, mintedAt hiển thị) | 1 | UI-P2 |
| `POST /admin/distributions/:id/retry` (per-PreTicket fail) | WF1-R2, F-04 | 1.4 | UI-P3 |
| `POST /admin/distributions/:id/resend-emails` | F-06 | 1.6 | UI-P4 |
| `GET /admin/backfill/dry-run` + `POST /admin/backfill/run` | T7 (script → expose API) | 2 | UI-P5 |
| `ClaimResult` += `processing / expired` | WF3 C3 | 3 | UI-P6 |

Type mở rộng `api/types.ts`: `DistributionStatus` += `'PARTIALLY_MINTED'`; `PreTicketStatus` = 7 giá trị; thêm `BackfillDryRunResp`, `BackfillRunResp`.

---

## 9. Checklist empty/loading/error từng màn

| Màn | Loading | Empty | Error |
|---|---|---|---|
| 1 Job detail | Spinner + poll 2.5s (mở rộng điều kiện) | "Không có PreTicket." (hiện có) | error-box; quota → template §3.5; raw dump = cấm |
| 2 Backfill | Spinner + poll progress | "Không có vé cũ cần xử lý" | error-box + nút "Tiếp tục backfill" (idempotent) |
| 3 Claim landing | Spinner lớn (standalone tối) | — (mọi token đều có nhánh) | 404 generic; EXPIRED/MINTING copy §5.4 |
| 4 Vé của tôi | `<Spinner large />` | empty-state mới (§6.1) + [Làm mới] | error-box hiện có |
| 5 Wizard 3/4 | Spinner (list types) | — | error-box; vượt quota → cảnh báo in-form + disable ở bước 4 |

---

## 10. Thứ tự implement đề xuất (cho Frontend Developer — T8)

1. `types.ts` mở rộng enum + field mới (chờ T5/T4 response thật).
2. `styles.css` +3 class badge; `Badge.tsx` thêm `PreTicketBadge`; `format.ts` thêm `preTicketBadgeClass()`.
3. Màn 1 (job detail) — core của T8.
4. Màn 5 (wizard cảnh báo quota) — thuần client, không phụ thuộc backend mới.
5. Màn 4 (empty-state + Làm mới) — thuần client.
6. Màn 3 (claim landing) — phụ thuộc UI-P6 (T6).
7. Màn 2 (backfill) — phụ thuộc UI-P5 (T7) — sau cùng.

---

## Vòng phản biện 1 (UX Architect ↔ DESIGN / THREAT-MODEL)

Đối tượng: `docs/DESIGN-ticket-email-mint-sync.md` (Backend), `docs/THREAT-MODEL-ticket-email-mint-sync.md` (Security). Tiêu chí phản biện UX: yêu cầu backend/security **không được gãy workflow admin/end-user thật**. Mỗi finding tự đánh giá [ALIVE/DEAD] + kịch bản user.

### UX-REB-01 [ALIVE] — MEDIUM — C-2 link MỌI EVENT: "Vé của tôi" tràn vé không giải thích

- Cite: `DESIGN.md:302-314` (D-L1 scope mọi event + tự ghi nhận risk "admin phát nhầm email sẽ link hết về A"); PRD Story B (onboarding).
- Kịch bản thật: tổ chức đã chạy nhiều đợt test/probe (rc-*, probe-*) trên môi trường dùng email nhân viên thật. User tạo tài khoản lần đầu → sync link TOÀN BỘ vé mọi event → mở "Vé của tôi" thấy 5 vé từ 4 event (kể cả event test) hiện ra **im lặng**. Banner hiện có chỉ nói "Đã tự động gắn N vé" (`MyTicketsPage.tsx:40-54`) — không biết vé nào MỚI, đến từ đâu. Đây là moment onboarding quan trọng nhất (Story B) — moment đầu tiên mở app mà thấy vé rác mang tên event test = mất niềm tin ngay.
- Đánh giá contract `{linked: N, ticketIds}` (`DESIGN.md:296-299`): **ĐỦ cho UI** — N cho banner/số; `ticketIds` match với `tickets[].id` (TicketView trả `event.name`) cho phép đánh dấu "MỚI" đúng N dòng. KHÔNG cần backend thêm gì.
- Bổ sung spec (xem khối "Bổ sung" cuối vòng): banner số N + badge "MỚI" trên vé match ticketIds trong session đầu + KHÔNG đổi sort mặc định. Phần dữ liệu rác test-event là việc dọn dữ liệu/PM — UI không cứu được.

### UX-REB-02 [ALIVE] — HIGH — `@ArrayMaxSize(1000)` + `@Max(10)`: chặn ở bước 4 thay vì bước 2 = gãy workflow distribute thật

- Cite: `THREAT-MODEL.md` §3.6 (dòng 172-175: `distribute-request.dto.ts:16-18` hiện KHÔNG cap; đề xuất `@ArrayMaxSize(1000)` recipients + `@Max(10)` quantity); `frontend/src/admin/ImportEmailListPage.tsx:59-88` (textarea paste tự do — parse + đếm hợp lệ/trùng, **KHÔNG có cap client, KHÔNG có CSV upload**).
- Kịch bản thật: admin paste 2.300 email nhân viên (đúng use-case của ticket-mayo — phát vé nội bộ tổ chức). Bước 2/3/4 đều pass client → submit → 400 validation → error-box ở bước 4, admin mất orientations, không biết phải chia từ đâu. Đây là **regression UX so với hiện tại** (hiện không cap — 2.300 email chạy được).
- Phản biện THREAT: cap đúng nhưng thiếu UI-flow chia. Chốt bổ sung: bước 2 hiển thị "Hợp lệ: 2.300 / tối đa 1.000 mỗi đợt" + disable nút "Tiếp theo" kèm hint chia đợt (vd "Chia thành 3 đợt: 1.000 + 1.000 + 300"). **TỪ CHỐI auto-chunk client** (3 job = 3 dòng lịch sử + 3 đợt email admin không kiểm soát ranh giới). Lưu ý: chunk ≤1000 nội bộ của mint (`DESIGN.md:261`) là tầng service → KHÔNG đụng UX, không nhầm.
- `@Max(10)` quantity: thêm max + hint ở `SelectTicketTypeStep` — đồng ý số 10.

### UX-REB-03 [ALIVE] — MEDIUM — Claim-link EAGER = bearer-token trỏ vé thật: UI giảm thiệt hại lộ link, KHÔNG thêm ma sát

- Cite: `THREAT-MODEL.md` §3.7.1 (dòng 181: token lộ một mình KHÔNG đủ xem vé — phải login + emailHash khớp).
- [DEAD nửa phải] Yêu cầu "landing yêu cầu đăng nhập trước khi hiện vé chi tiết": **đã thỏa** — mọi nhánh xem vé đều qua JWT + emailHash match (`claim.service.ts:42-48`); landing chỉ hiện dòng trạng thái + CTA, KHÔNG hiện ticketCode/QR/email đầy đủ trước login. Không cần thêm bước.
- [ALIVE nửa trái] Case không-phải-tấn công nhưng thật nhất: **forward link**. A nhận email, forward cho B (đồng nghiệp đi thay). B click → "Tạo tài khoản" → dùng email CỦA B → không thấy vé → tưởng lừa → ticket. Copy §5.2 cần thêm 1 dòng: "Link này gắn với email người nhận — người khác mở sẽ không xem được vé." (xem khối Bổ sung).
- [TỪ CHỐI] thêm OTP/xác minh email trước xem vé: login emailHash khớp đã đủ (THREAT tự chứng minh), thêm lớp = gãy conversion onboarding Story B.

### UX-REB-04 [ALIVE] — HIGH — UI-P1..P6: Backend DESIGN không định nghĩa endpoint cho 3/6 đề xuất — màn hình treo

- Cite: `DESIGN.md:381` (nói "Admin action Retry (UI job list)" nhưng KHÔNG có endpoint HTTP); `DESIGN.md` trade-off #9 (dòng 684): "TỪ CHỐI backfill qua HTTP admin API — script ops"; §4.6 có emailSentAt nhưng KHÔNG có resend-emails endpoint; response claim mới (UI-P6) không được spec shape.
- Xét từng UI-P (chuẩn bị fallback nếu bị cắt):

| UI-P | Backend hiện có? | Fallback nếu bị cắt | Verdict UX |
|---|---|---|---|
| P1 `mintMode` | KHÔNG | heuristic "có mint counts = EAGER" (đã ghi §2.3) | Chấp nhận cắt — đủ dùng |
| P2 `mintReason/mintedAt` | KHÔNG | mintedAt ← `contentTicketId != null`; bỏ cột Ghi chú lỗi, xem lỗi qua filter status=PENDING | Chấp nhận cắt |
| P3 `POST /retry` | KHÔNG | **KHÔNG có fallback UI** — admin phải CLI → Màn 1.4 (PARTIALLY_MINTED) chết | **KHÔNG chấp nhận cắt** — WF1-R2/F-04 bắt buộc; đòi endpoint hoặc Backend công nhận CLI-only + UI hiển thị hướng dẫn lệnh |
| P4 `resend-emails` | KHÔNG | Không có đường nào (retry idempotencyKey = no-op per F-04) | **Đòi endpoint** — F-06 làm case này phổ biến hơn LAZY |
| P5 `backfill/*` | BỊ TỪ CHỐI (trade-off #9) | Màn 2 chuyển thành **report-import**: UI render JSON output script (upload/dán), chạy thật = CLI với `--confirm` guard sẵn có | Fallback khả thi — vẫn giá trị (đọc/lọc 20 vé EXPIRED cần pagination), mất nút confirm UI |
| P6 `ClaimResult` processing/expired | KHÔNG (shape chưa spec) | Không fallback — thiếu = 500 hàng loạt khi rollback flag (F-08) | **Bắt buộc chốt shape** — không phải optional |

- `syncPending` (đề xuất cũ của tôi ở §6): **TỰ RÚT** — heuristic sessionStorage ĐỦ TỐT để ship: worst-case sai = copy "đang đồng bộ + Làm mới" hiện oan vài chục giây trong session đầu, không break gì (copy cũ "kiểm tra đúng email" vẫn ở dòng 2). Bỏ yêu cầu backend.

### UX-REB-05 (tự review a) [ALIVE → CHỐT] — disable vs warning khi total > remaining

- Cite: `DESIGN.md:507` (§7.2 — "remaining có thể stale — pre-check không phải guard cuối"); `DESIGN.md:253` (mint tx là guard cuối).
- **CHỐT: disable + auto re-fetch khi vào bước 4 + nút "Làm mới số còn lại" trong cảnh báo** (khắc phục stale bằng 1 click lấy số mới — nếu refresh xong vẫn vượt thì đúng là vượt). KHÔNG warning-only: admin bấm Phát với stale-pass → pre-check backend có thể cũng stale-pass → mint tx 409 → **job FAILED rác trong lịch sử** (PreTicket đã tạo ở E1.5) → admin phải dọn + hiểu PARTIALLY/FAILED. Disable rẻ hơn nhiều so với chi phí mental của job rác.

### UX-REB-06 (tự review b) [CHỐT] — AppDownloadPage vs ClaimRedirectPage

- Cite: `App.tsx:26-28` — `/c/:token` + `/claim/:token` CÙNG trỏ `AppDownloadPage`; comment dòng 26 ghi chủ đích "app đã cài tự mở & claim; chưa cài về trang tải app" (universal-link; mobile app intercept trước khi web render — web là fallback).
- **CHỐT: giữ 2 route → 1 màn, sửa nội dung AppDownloadPage thành E1 landing (§5); KHÔNG mount ClaimRedirectPage.** Lý do: 1 điểm sửa duy nhất; 2 route khác behavior cho cùng token = hỗn loạn deep-link + QA; logic `resolveClaim` (đang nằm trong ClaimRedirectPage.tsx mồ côi) được di chuyển vào landing mới — không mất code.

### UX-REB-07 [DEAD — đồng ý, không phản bác] — THREAT 4.2 (xóa plaintext email khỏi log + Kafka payload)

Không đụng giao diện nào; Kafka bỏ trường `email` chỉ làm metadata an toàn hơn. Đồng ý chặn merge.

### UX-REB-08 [ALIVE] — MEDIUM — Rate-limit internal mint/link có thể đánh trúng giờ cao điểm check-in

- Cite: `THREAT-MODEL.md` §5 hàng 3 (dòng 242-244: "BẮT BUỘC rate limit nội bộ" cho mint + link).
- Kịch bản thật: sáng ngày sự kiện, hàng nghìn user mở app/login cùng lúc → mỗi login trigger sync link-by-email (WF2) → nếu rate-limit chặt (chống spam-loop) → sync fail-soft `linked=0` → **vé không gắn đúng lúc cần nhất**, user thấy "Bạn chưa có vé" ngay trước cửa. UI copy "Làm mới" (Màn 4) sẽ hứa suông.
- Đề xuất: rate-limit phải theo CALLER với burst đủ cao (mục đích chống spam/loop bất thường, không chống tải thật), hoặc sync cho list-my-tickets được miễn rate-limit. Cần Backend công bố con số trước khi UI cam kết copy "vé sẽ xuất hiện trong giây lát".

### Bổ sung spec từ vòng 1 (ghi đè/điều chỉnh vào các mục gốc, KHÔNG sửa nội dung mục gốc)

1. **Màn 4 (§6)**: banner "Đã tự động gắn N vé" giữ + vé có `id ∈ claimedTicketIds` (C-2 `ticketIds`, `DESIGN.md:296`) hiện chấm "MỚI" trong session đầu sau register/login; KHÔNG đổi sort. Nếu backend chỉ trả N (không ids): bỏ badge "MỚI", giữ banner — vẫn đạt.
2. **Màn 5 bước 2 (§7)**: thêm dòng đếm "Hợp lệ: X / tối đa 1.000 mỗi đợt" khi `X > 1000` + disable "Tiếp theo" + hint chia đợt; `SelectTicketTypeStep` thêm max=10 cho quantity kèm hint. (Áp dụng khi THREAT §3.6 được duyệt.)
3. **Màn 3 nhánh (b) (§5.2)**: thêm dòng phụ dưới CTA: "Link này gắn với email người nhận — người khác mở sẽ không xem được vé."
4. **Màn 1.4/1.6 + Màn 2**: nếu Backend cắt P3/P4/P5 → fallback theo bảng UX-REB-04 (P5 = report-import màn, P3/P4 = hiển thị hướng dẫn CLI trong card thay nút — copy: "Liên hệ kỹ thuật chạy lệnh phục hồi" + mã job mono để copy).

---

## Vòng phản biện 2 — Phán quyết & Spec chốt

Đối tượng phán quyết: Vòng phản biện 1 của `DESIGN-ticket-email-mint-sync.md` (RB-1..RB-5, TRB-3/TRB-4) và `THREAT-MODEL-ticket-email-mint-sync.md` (VB1-4, VB1-7, VB1-9). Luật: không sửa vòng 1, không sửa mục gốc — mọi thay đổi ghi ở "Spec chốt cập nhật" dưới đây.

### Bảng phán quyết

| Finding (nguồn) | Phán quyết UX | Hành động spec |
|---|---|---|
| TM-4/VB1-9 — cap `@ArrayMaxSize(1000)` + `@Max(10)` (Backend chốt số, RB-1) | **ĐỒNG Ý cap** — điều kiện của tôi: phải chặn từ bước 2 wizard, không để 400 nổ ở bước 4 | Copy + wireframe mới cho bước 2 (Spec chốt #2) |
| TM-5 — warning khi emailHash đã có PreTicket PENDING/MINTING của job khác (không block) | **ĐỒNG Ý hiển thị** — warning đúng chỗ là sau submit, trên job detail | Đề xuất UI-P8: `job.warnings` hiển thị `.warn-box` (class đã có — `ImportEmailListPage.tsx:78`) |
| RB-2 UI-P1 — `mintMode` là cột snapshot tại distribute, không phải flag runtime | **ĐỒNG Ý — tốt hơn heuristic** của tôi (job cũ trước migration không có cột → heuristic "có mint counts = EAGER" thành fallback phụ) | Chip "Chế độ: EAGER/LAZY" đọc `job.mintMode` |
| RB-2 UI-P2 — field đổi tên: `lastMintError` (clear khi retry thành công) + `mintedAt` | **ĐỒNG Ý** — clear-on-retry đúng hành vi admin mong đợi (cột lỗi sạch sau khi sửa) | Map §3.3 cập nhật tên field |
| RB-2 UI-P3 — `POST /retry`, guard chỉ job PARTIALLY_MINTED/FAILED + PreTicket PENDING | **ĐỒNG Ý** — khớp WF1-R2, UI giữ nút "Thử lại N vé lỗi" (§3.4) | Không đổi |
| RB-2 UI-P4 — resend guard `emailSentAt IS NULL` (bản hẹp, bỏ emailFailedAt) | **ĐỒNG Ý — bản hẹp ĐỦ cho cả 2 case**: email gửi OK → có emailSentAt → không gửi lại; email fail → NULL → nằm trong resend. Case §3.6 "Gửi lại z email lỗi" hoạt động đúng, không cần cột mới | Không đổi |
| RB-2 UI-P5 — dry-run GIỮ, `POST run` CẮT (CLI canonical) + TRB-4 (poll progress chết theo) | **ĐỒNG Ý cả hai** — đúng fallback tôi chuẩn bị; poll progress là phần tử chết, cắt luôn | Màn 2 chuyển thành dry-run + report-import (Spec chốt #4) |
| RB-2 UI-P6 — `{processing, expired}` chốt tên field | **ĐỒNG Ý** | Không đổi (§5.5) |
| RB-3 — syncPending: heuristic client là đủ; VB1-7 lưu ý flag phải boolean, không đút email vào sessionStorage | **ĐỒNG Ý** — ghi thêm ràng buộc implement vào spec | Spec chốt #3 |
| TRB-3 — content-client hiện ép mọi lỗi thành 502; `code TICKET_SOLD_OUT` chỉ tới frontend SAU khi T5 pass-through land | **ĐỒNG Ý — đây là điều kiện tiên quyết** của template §3.5. Trước khi T5 land, frontend nhận 502 → hiện error-box generic (không remaining). Không assume field có sẵn | Thứ tự implement cập nhật (Spec chốt #6) |
| VB1-4 — scope mọi event + `{linked, ticketIds}` được GIỮ (PM quyết) | **CHẤP NHẬN** — UI gánh bằng thiết kế: banner số N + badge "Mới" trên đúng vé vừa link, giải thích moment "sao tự nhiên có vé" | Spec chốt #1 + đề xuất UI-P7 |
| UX-REB-05(a) — disable nút Phát khi total > remaining + nút "Làm mới số còn lại" | **[CHỐT CUỐI] — không đổi**: disable + auto re-fetch bước 4 + nút "Làm mới số còn lại" trong cảnh báo | Đã ghi §7.2 + vòng 1 |
| UX-REB-06(b) — sửa trực tiếp AppDownloadPage (2 route → 1 màn), KHÔNG mount ClaimRedirectPage | **[CHỐT CUỐI] — không đổi** | Đã ghi §5 + vòng 1 |

### Spec chốt cập nhật (thay đổi so với spec gốc — ưu tiên cao nhất xếp trên)

**1. Màn 4 — banner "N vé mới" + badge "Mới" (khắc phục VB1-4/UX-REB-01)**

Banner giữ nguyên copy hiện có ("Đã tự động gắn N vé vào tài khoản của bạn"). Badge "Mới" gắn thêm:

```
│  Vé của tôi                                                                  │
│  ✔ Đã tự động gắn 3 vé vào tài khoản của bạn.                                │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │ Mã vé      Loại vé     Sự kiện        Trạng thái                      │ │
│  │ TC-8x2f…   VIP         Sự kiện X      Còn hiệu lực          [Mới]    │ │
│  │ TC-9f1a…   Thường      Sự kiện Y      Còn hiệu lực          [Mới]    │ │
│  │ TC-2c7b…   VIP         Sự kiện X      Còn hiệu lực                   │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
```

- **Nguồn dữ liệu — đề xuất UI-P7**: `AuthResponse` + `GET /tickets/me` thêm `claimedTicketIds?: string[]` (ticket-mayo forward từ `ticketIds` của C-2). Fallback nếu bị cắt: chỉ banner số N (đã đạt Story B tối thiểu), bỏ badge.
- **Khi nào ẩn badge**: badge là **ephemeral trong session trang hiện tại** — biến mất khi user rời trang hoặc reload; KHÔNG persist (không localStorage/sessionStorage cho badge — tránh "Mới" cũ chồng chất các lần sau). KHÔNG ẩn khi click xem chi tiết vé (nhất quán trong session). Lý do: badge chỉ trả lời câu hỏi "sao tự nhiên có vé này?" tại moment onboarding; sau đó là nhiễu.
- CSS: tái dùng `<span className="tag">Mới</span>` (class `.tag` đã có trong styles.css) — không thêm class mới.
- Ràng buộc từ VB1-7: mọi flag client (badge, heuristic just-authed) là boolean/state component — KHÔNG đút email/PII vào sessionStorage.

**2. Màn 5 bước 2 — copy cap 1.000 (chặn từ bước nhập, không đợi 400 ở bước 4)**

Khi `parsed.valid.length > 1000` — disable nút "Tiếp theo" + warn-box (class `.warn-box` đã có):

```
│  Hợp lệ: 2.300 · Không hợp lệ: 4 · Trùng lặp bỏ: 12                        │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ ⚠ Danh sách quá dài                                                 │   │
│  │ Mỗi đợt phát tối đa 1.000 email. Danh sách của bạn có 2.300 email   │   │
│  │ hợp lệ. Hãy chia thành 3 đợt (1.000 + 1.000 + 300) và phát lần      │   │
│  │ lượt, chọn lại cùng loại vé cho mỗi đợt.                            │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  [Quay lại]   [Tiếp theo: chọn loại vé]  ← DISABLED                        │
```

- Số đợt gợi ý = `ceil(valid / 1000)`, tự tính client-side.
- Khi `≤ 1000`: dòng hint hiện có thêm câu "Mỗi đợt tối đa 1.000 email." (admin biết luật TRƯỚC khi paste).
- `SelectTicketTypeStep`: input quantity thêm `max={10}` + hint "Tối đa 10 vé mỗi email". KHÔNG auto-chunk — chia đợt là quyết định admin (ranh giới email do admin kiểm soát).

**3. Màn 4 — empty-state sync-fail: copy TIẾN TRIỂN theo số lần Làm mới (không hứa suông khi sync thật fail — gắn với UX-REB-08)**

- Lần vào đầu (heuristic just-authed + 0 vé): "Bạn chưa có vé. Nếu vừa tạo tài khoản sau khi nhận email mời, vé có thể đang được đồng bộ — bấm Làm mới trong giây lát." + nút [Làm mới].
- Sau ≥ 2 lần [Làm mới] vẫn 0 vé (đếm bằng state component): ĐỔI copy → "Chưa tìm thấy vé nào. Kiểm tra lại bạn đăng ký bằng ĐÚNG email đã nhận vé, hoặc liên hệ ban tổ chức." (bỏ cụm "đang đồng bộ" — đúng lúc này khả năng sync thật sự fail cao: rate-limit giờ cao điểm, pepper drift; hứa tiếp = mất niềm tin).
- Nút [Làm mới] giữ: mỗi click re-gọi `getMyTickets()` = tự trigger sync lại (WF2), có loading inline, không giới hạn số lần.

**4. Màn 2 — Backfill chuyển thành "dry-run + report-import" (P5-run cắt, dry-run giữ, poll cắt theo TRB-4)**

- Phần A "Xem trước": gọi `GET /admin/backfill/dry-run` (được giữ) → render đúng bảng §4.1. KHÔNG poll, KHÔNG nút "Chạy thật", KHÔNG checkbox confirm.
- Phần B "Kết quả chạy": khối dán JSON output report của script CLI (B4: minted/mintedWithUser/mintedEmailOnly/expired/skipped + danh sách EXPIRED) → render cùng bảng shape §4.1/§4.3. Đây là màn đọc/lọc (phân trang 20 vé hết lượt) — giá trị chính còn nguyên.
- Thay nút chạy: khối hướng dẫn mono: `npm run backfill:pending -- --confirm` + cảnh báo "Lệnh này mint vé thật và đánh dấu vé hết lượt vĩnh viễn — xem trước ở trên trước khi chạy."

**5. Màn 1 — cập nhật tên field (theo RB-2)**

- §3.3 cột "Ghi chú lỗi" đọc `lastMintError` (tên mới, thay `mintReason`); tự sạch khi retry thành công.
- §2.3 chip "Chế độ" đọc `job.mintMode` (cột snapshot); heuristic "có mint counts" chỉ còn fallback cho job tạo trước migration.
- Sau submit: nếu `job.warnings` tồn tại (TM-5) → `.warn-box` trên detail: "⚠ Một số email trong đợt này đang có vé chờ xử lý từ đợt phát khác — kiểm tra để tránh phát trùng." (đề xuất UI-P8).

**6. Thứ tự implement cập nhật (TRB-3)**

Template quota §3.5 (bắt `code === 'TICKET_SOLD_OUT'`) **phụ thuộc T5 pass-through land trước**. Trước đó mọi lỗi content đến frontend dưới 502 → màn 5/1 hiện error-box generic "Lỗi hệ thống khi tạo vé, chưa gửi email nào. Thử lại sau." Frontend KHÔNG hard-code parse remaining từ chuỗi message — chỉ đọc field `code`/`remaining`/`requested` có sẵn trong body lỗi.

### Đề xuất endpoint/field mở mới phát sinh vòng 2

| ID | Nội dung | Phán quyết cần |
|---|---|---|
| UI-P7 | `claimedTicketIds?: string[]` trên AuthResponse + GET /tickets/me (forward từ C-2 `ticketIds`) | Backend confirm ở vòng hội tụ; fallback đã rõ (chỉ banner số) |
| UI-P8 | `job.warnings?: string[]` (TM-5 duplicate-emailHash warning) | Backend confirm; fallback = không hiển thị (không phá gì) |
