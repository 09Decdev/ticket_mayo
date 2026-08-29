# REVIEW (lens phản biện) — OPTIMIZE-ticket-email-pdf.md

**Ngày**: 2026-08-29
**Tác giả**: Code Reviewer (adversary lens, pipeline /optimize)
**Phạm vi**: BÁC/GIỮ từng đề xuất P0-P6 bằng bằng chứng đọc code thật. READ-ONLY — file đề xuất gốc không sửa.
**Phương pháp**: đọc trực tiếp toàn bộ file được cite (ticket-mayo, content-service, noti-analytics-service, deployment, node_modules/nodemailer v9.0.5) + grep toàn workspace.

---

## Tóm tắt verdict

| # | Đề xuất | Verdict |
|---|---|---|
| P0 | Cảnh báo Kafka `notification.send-ticket` không consumer | **GIỮ — XÁC NHẬN (còn nặng hơn mô tả)** |
| P1 | Dời dispatch ra worker queue | **GIỮ** (có 3 điều kiện) |
| P2 | SMTP pooling + concurrency | **GIỮ-CÓ-ĐIỀU-KIỆN** (lỗ hổng logic chính: pool đơn lẻ KHÔNG tăng concurrency) |
| P3 | Batch/cache QR token | **GIỮ** (1 chỗ mô tả sai nhẹ, không ảnh hưởng kết luận) |
| P4 | Cache PDF + font buffer | **GIỮ-CÓ-ĐIỀU-KIỆN** (vi phạm PRD D3 ở VALUE, không phải key; claim "Gmail pre-fetch" là tin đồn) |
| P5 | Cache logo resize 60x60 | **GIỮ** |
| P6 | Prefetch ảnh + headers PDF | **GIỮ** (vệ sinh, đúng mô tả) |

---

## P0 — Cảnh báo Kafka không consumer: GIỮ (XÁC NHẬN, nâng cấp)

**Bằng chứng consumer không tồn tại** (grep toàn workspace `notification.send-ticket`/`SendTicket`):
- Chỉ có producer: `ticket-mayo/src/modules/mail-dispatcher/kafka-producer.adapter.ts:68` (`topic: KafkaTopics.SendTicket`) + hằng số `ticket-mayo/src/common/constants/kafka-topics.ts:2`.
- `noti-analytics-service` có 25+ consumer (`@EventPattern`) nhưng chỉ `otpComsumer.kafka.ts:18` là `notification.send-otp` — KHÔNG có consumer nào đăng ký `notification.send-ticket`. Đúng như cảnh báo. `mail-dead-letter` cũng chỉ là producer-side (chưa thấy consumer — nên giữ trong danh sách check khi làm P1).

**Nâng cấp 1 — nguy cơ `console` im lặng còn nguy hiểm hơn kafka:**
- `ticket-mayo/src/config/env.ts:161`: `MAIL_TRANSPORT: process.env.MAIL_TRANSPORT ?? MailTransport.Console` — mặc định CHÍNH LÀ console.
- Grep toàn bộ `deployment/` (kể cả `.env.fullmerge`, `.env.admin`, `docker-compose*.yml`, `PLAN_INFISICAL_MIGRATION.md:1476` liệt kê MAIL_HOST/MAIL_PORT/...): **KHÔNG NƠI NÀO set MAIL_TRANSPORT**.
- Hệ quả: nếu prod không bơm biến này, mail "gửi" thành công qua `console-mail.adapter.ts:16-40` (ghi file preview + log) → `emailSentAt` được set (`distribution.service.ts:223-228`) → **user không nhận mail nhưng admin thấy đã gửi, không có cơ hội retry**. Kafka ít ra còn fail-loud (producer throw khi chưa connect → `failed++`).
- → P0 phải mở rộng: xác nhận env prod KHÔNG CHỈ trả lời "kafka hay smtp" mà phải **fail-start nếu missing** (giống pattern `MINT_SIGNING_KEY` fail-loud `content-client.service.ts:267-275`).

**Nâng cấp 2 — secret rò rỉ trong deployment repo (ngoài scope tối ưu nhưng chặn trước khi deploy):**
- `deployment/.env.fullmerge:347-348` chứa Gmail app password PLAINTEXT (`MAIL_USER="mayogu1310@gmail.com"`, `MAIL_PASS="yzrewxqpfmtzyrtd"`), `MAIL_FROM` kèm địa chỉ. File này trong git → credential lộ. Nên nhắc việc quản lý secret (đã có `PLAN_INFISICAL_MIGRATION.md`).

---

## P1 — Worker queue: GIỮ (3 điều kiện)

**Bằng chứng đúng — kết luận đứng vững:**
- `dispatchBatch` chạy đồng bộ trong request: `distribution.controller.ts:40-41` → `distribution.service.ts:216`; loop tuần tự `mail-dispatcher.service.ts:304-366` (`await this.adapter.send(p)` tại 356).
- Vết nứt trạng thái mô tả đúng: `emailSentAt` updateMany SAU toàn bộ loop (`distribution.service.ts:220-228`) → process chết giữa loop = mail đã đi nhưng chưa ack → resend gửi đôi. Guard resend đã đọc đúng: `distribution.service.ts:658-666` (`status MINTED/LINKED AND emailSentAt IS NULL`).
- `getStatus` độc lập (đọc DB, `distribution.service.ts:503-514`) → UI không vỡ khi job RUNNING lâu. Không cần migration (đúng — `emailSentAt` + `preTicket.status` đủ).
- F-05 per-email ack vẫn giữ được: worker chạy `dispatchBatch` + ack từng `claimToken` như hiện tại.

**Điều kiện:**
1. **Không loại được cửa sổ gửi đôi — chỉ thu hẹp.** Queue at-least-once vẫn có khe "SMTP gửi xong nhưng crash trước khi ack". Phải có **lease/lock per-job cho worker vs `resendEmails`**: `resendEmails` hiện KHÔNG có guard status/lease (`distribution.service.ts:654-735`), race gửi đôi với worker đang chạy TỒN TẠI SẴN hôm nay và P1 LÀM RỘNG cửa sổ (email tách hẳn khỏi request). Worker phải claim "đang gửi" trước khi xử lý, resend phải tôn trọng lease đó.
2. **"Giảm 90%+ về giây" cần cắt phạm vi**: mint vẫn đồng bộ trong request (`distribution.service.ts:171`), timeout content 15s/chunk (`content-client.service.ts` chunk 500) → batch lớn response vẫn mất ~15s × (N/500). Con số ổn cho "phút → phần mint còn lại", không phải "→ giây" tuyệt đối.
3. Admin UI contract: job RUNNING kéo dài sau khi response trả — đã được doc thừa nhận; chỉ cần giữ nguyên.

---

## P2 — SMTP pooling + concurrency: GIỮ-CÓ-ĐIỀU-KIỆN

**Bằng chứng đúng:**
- `smtp-mail.adapter.ts:35-43` tạo transport KHÔNG `pool` → nodemailer chọn `SMTPTransport` (`node_modules/nodemailer/lib/nodemailer.js:39`: `if (options.pool) → SMTPPool`), mỗi `sendMail` mở connection mới (không keep-alive). Số liệu source node_modules chính xác: default `maxConnections=5`, `maxMessages=100` (`smtp-pool/index.js:47-48`), `rateLimit`/`rateDelta` (delta 1000ms, limit 0=off) tại `smtp-pool/index.js:57-64`. Loop tuần tự thật: `mail-dispatcher.service.ts:304-366`.
- Cải thiện thực tế còn LỚN HƠN mô tả một chút: non-pool = mỗi mail trả TCP connect + TLS handshake (không chỉ RTT) → pool cắt cả khoản này.
- Rủi ro Gmail "chặn 24h": đúng bản chất provider rate-limit; doc đã xử đúng (bắt buộc `rateLimit/rateDelta` + xác nhận hạn mức account thật).

**ĐIỀU KIỆN BẮT BUỘC (lỗ hổng logic trong giải pháp lớp 1):**
- **`pool:true` một mình KHÔNG cho concurrency.** `dispatchBatch` `await this.adapter.send(p)` tuần tự tuyệt đối (mail-dispatcher.service.ts:304-366) — pool chỉ tái dùng connection idle, mỗi thời điểm vẫn 1 mail in-flight. Để đạt "concurrency 1→3-5" PHẢI đổi loop sang bounded-concurrency (`p-limit(3-5)` / `Promise.all` theo chunk) — tức lớp 2 của doc là PHẦN LÕI, không phải phương án thay thế. Không làm cả loop + pool thì impact "60-80%" không xảy ra. Doc đang đánh tráo: coi lớp 1 là đủ.
- Không áp dụng khi `MAIL_TRANSPORT=kafka` (adapter khác, `mail-dispatcher.module.ts:26`) — doc đã ngầm nêu qua phụ thuộc; nên ghi rõ P2 chỉ có nghĩa với SMTP.

---

## P3 — Batch/cache QR token: GIỮ (1 chỗ mô tả sai nhẹ)

**Bằng chứng đúng:**
- N+1 HTTP thật: `mail-dispatcher.service.ts:207-213` → `content-client.service.ts:233-245` → `GET /internal/distribution/tickets/:id/qr-token` (`internal-distribution.controller.ts:134-141`) — 1 round-trip/vé trong loop tuần tự.
- **Token có sẵn khi resend/job retry — câu hỏi "token lấy từ đâu" có lời giải từ code**: `ClaimMailPayload.ticketId` (`mail.adapter.ts:33`) được build ở CẢ hai path: `distribute()` (`distribution.service.ts:208`: `ticketId: src?.id ?? undefined`) và `resendEmails()` (`distribution.service.ts:716`) — cache key ticketId luôn có nguồn. Fallback `ticketCode/claimUrl` khi thiếu ticketId đã có (`mail-dispatcher.service.ts:212-213`).
- Cached token vẫn hợp lệ tới hết giờ event: verify chỉ kiểm sig + `tid` (`ticket.service.ts:923-926`), không check iat/exp-trong-token như credential xác nhận.
- Fail-soft giữ nguyên → risk thấp. Batch endpoint là feasible (internal, đã có `ServiceTokenGuard`).

**Sai nhẹ (không đổi kết luận):** "token tĩnh ... KHÔNG thay đổi giữa các lần lấy" — sai về bytes: `buildStaticToken` nhét `iat: Date.now()/1000` (`ticket.service.ts:981`) nên chuỗi token + chữ ký KHÁC NHAU mỗi lần gọi. Tính NGỮ NGHĨA tĩnh (claims giống nhau, valid tới exp) thì đúng → cache theo ticketId an toàn, chỉ cần sửa câu văn trong doc cho chính xác.

---

## P4 — Cache PDF + font buffer: GIỮ-CÓ-ĐIỀU-KIỆN (2 vấn đề bị bỏ qua)

**Bằng chứng đúng:**
- Render lại mỗi request: `ticket.controller.ts:80-116` → `ticket.service.ts:901-963` → `renderTicketPdf` (`ticket-pdf.service.ts:37-339`); `registerFont` + `fs.existsSync` từ disk MỖI render (`ticket-pdf.service.ts:72-77`) — đúng. PDF ~50-200KB, không cache headers (`ticket.controller.ts:110-115`).

**Điều kiện / lỗ hổng:**
1. **VI PHẠM PRD §7.1 D3 — không phải ở key, ở VALUE.** Cache key dùng hash của PII là "khô" — đúng. NHƯNG value là PDF chứa PLAINTEXT name/phone/email/bookedAt (bơm từ query `mail-dispatcher.service.ts:385-398` → in ra `ticket-pdf.service.ts:179-182`) + QR = chính static token (credential). Đặt value ở Redis/shared = content-service LƯU TRỮ PII, trái chữ "content KHÔNG lưu PII" của thiết kế hiện hành. Điều kiện: cache in-memory LRU nhỏ trong process content-service + TTL ngắn + ghi nhận lệch PRD trong hồ sơ security (giống cách `THREAT-MODEL-ticket-email-mint-sync.md` vận hành đánh đổi). KHÔNG cache Redis chung.
2. **Claim "Gmail/Outlook proxy pre-fetch link trong email" KHÔNG CÓ BẰNG CHỨNG.** Grep toàn bộ `ticket-mayo/docs/` (PRD, THREAT-MODEL, DESIGN, WORKFLOW): chỉ duy nhất file OPTIMIZE này nhắc tới — là tin đồn/truyền miệng. Impact 30-70% rẻ render là HƠI THỔI phía trên: phải đo bằng access-log (đếm request `:id/pdf` trùng ticket/24h) TRƯỚC khi claim — doc tự ghi "cần baseline xác nhận" nên chỉ giữ được phần đề xuất kỹ thuật, không giữ được con số.
3. **Key phải phủ MỌI input render, không chỉ PII**: ticketCode, seatLabel, event title/start/address, support email/phone, banner (đổi ảnh event giữa chừng → stale), thậm chí font file. Key `[ticketId + hash(PII)]` là thiếu.
4. Cache lookup PHẢI đặt SAU verify token + check status CANCELLED (`ticket.service.ts:915-926`) — vé bị hủy sau khi write cache không được serve từ cache.
- Phần font buffer: vô hại, đúng (pdfkit chấp nhận Buffer khi `src` là Uint8Array — đã dẫn từ `pdfkit.js:2794`); tiết kiệm fs-read mỗi render, parse fontkit vẫn mỗi document — đúng là cải thiện nhỏ.

---

## P5 — Cache logo resize 60x60: GIỮ

- Bằng chứng đúng: `sharp(logoBuf).resize(60,60).toBuffer()` trong `.composite()` mỗi mail (`mail-dispatcher.service.ts:226-234`); logo file đã cache disk (`getQrLogoBuf` 190-199) nhưng resize chưa. Logo là file tĩnh → resize 1 lần an toàn, không bug mid-batch (ý "logo bufer đổi mid-batch" trong doc tự bác bỏ đúng). Impact 1-3ms/mail — đã khiêm tốn, OK.

---

## P6 — Prefetch ảnh + nit response PDF: GIỮ

- Bằng chứng đúng: cache per-URL/batch (`mail-dispatcher.service.ts:300`), mail đầu phải chờ fetch thật (`fetchEventImage` tại 328 — presigned + timeout 10s); PDF thiếu `Cache-Control` (`ticket.controller.ts:110-115` chỉ Content-Type + Content-Disposition). Cả hai đúng là vệ sinh, impact negligible — giữ nguyên mức ưu tiên thấp.

---

## Các phản bác đã cân nhắc và không đứng vững

1. "Không có N+1 HTTP — content có thể gom" — SAI: mỗi vé 1 HTTP trong loop (`content-client.service.ts:233-245`), không có batch endpoint nào tồn tại (`internal-distribution.controller.ts` chỉ có `tickets/:id/qr-token` đơn lẻ).
2. "Loop không thật tuần tự" — SAI: `for (const p of payloads) { ... await this.adapter.send(p) }` (`mail-dispatcher.service.ts:304-356`).
3. "Nodemailer đã pool sẵn / default đã 5 connections" — SAI: default `maxConnections=5` chỉ áp dụng KHI `pool:true` (`nodemailer.js:39`, `smtp-pool/index.js:47`); hiện không pool → SMTPTransport mở connection mới mỗi mail.
4. "Token thay đổi nên cache QR không an toàn" — BÁC MẠNH: iat đổi nhưng verify chỉ sig+tid (`ticket.service.ts:923-926`), token cũ vẫn hợp lệ tới exp. Cache theo ticketId đúng.
5. "P0 Kafka là đồn — nhìn nhầm" — SAI: grep toàn workspace chỉ thấy producer (`kafka-producer.adapter.ts:68`) + docs; 25+ consumer của noti-analytics không có topic này.
6. "P4 không lưu PII vì key là hash" — BÁC MẠNH: hash chỉ bao phủ KEY, VALUE là PDF chứa plaintext PII + QR credential; nếu cache Redis là vi phạm D3.
7. "Prefetch ảnh event là tối ưu quan trọng" — BÁC (mức ưu tiên): fetch 1 lần/job đã có cache (`mail-dispatcher.service.ts:300`), chỉ là jitter mail đầu — đúng như doc xếp hạng S.

---

## Kết luận cho conduit

- **P0**: GIỮ — xác nhận không consumer `notification.send-ticket` toàn tọa độ; THÊM: deployment không set `MAIL_TRANSPORT` → default console = mail chết im lặng còn tệ hơn kafka; `deployment/.env.fullmerge:347-348` lộ Gmail password.
- **P1**: GIỮ — bằng chứng đúng; điều kiện: lease per-job chống race resend (cửa sổ gửi đôi chỉ thu hẹp, không hết), mint vẫn giữ request (con số "giây" cắt phạm vi).
- **P2**: GIỮ-CÓ-ĐIỀU-KIỆN — `pool:true` KHÔNG tự tăng concurrency khi loop vẫn await tuần tự; phải kèm p-limit trong `dispatchBatch`. Chỉ áp dụng SMTP.
- **P3**: GIỮ — ticketId có trong cả distribute và resend payload; token bản chất tĩnh (dù bytes đổi do iat) → cache an toàn.
- **P4**: GIỮ-CÓ-ĐIỀU-KIỆN — value PDF chứa PII → chỉ in-memory LRU + chấp thuận lệch PRD; claim "Gmail pre-fetch" là tin đồn, con số 30-70% phải chờ access-log; key phủ mọi input render; lookup sau verify token/status.
- **P5, P6**: GIỮ — nhỏ, đúng, không rủi ro.