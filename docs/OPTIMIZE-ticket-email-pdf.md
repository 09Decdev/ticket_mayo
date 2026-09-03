# OPTIMIZE — Ticket email + PDF (ticket-mayo / content-service)

**Dự thảo lens Code Reviewer + research** — pipeline /optimize MAYogu
**Ngày**: 2026-08-29 (research + đọc code)
**State**: DRAFT — chờ baseline đo generíc (agent baseline đang chạy song song). Mọi impact % mang ký hiệu **"cần baseline xác nhận"** đều chưa được đo, ước lượng theo cơ chế — KHÔNG phải số đo.

---

## 0. Tóm tắt điều hành

Code path hiện trạng (đã đọc trực tiếp):

| Bước | Chỗ | Vấn đề chính |
|---|---|---|
| `distribute()` — HTTP sync | `ticket-mayo/src/modules/distribution/distribution.service.ts:216` (controller `:40-41`) | `dispatchBatch` chạy đồng bộ trong 1 request HTTP → N trăm vé = request dài phút |
| Loop tuần tự per email | `mail-dispatcher/mail-dispatcher.service.ts:304-366` | concurrency = 1: QR + N+1 HTTP + fetch banner + SMTP nối đuôi |
| `resolveQrPayload` | `mail-dispatcher.service.ts:207-213` → `content-client.service.ts:233-245` | 1 HTTP round-trip/vé tới content (`GET /internal/distribution/tickets/:id/qr-token`) |
| `generateQrWithLogo` | `mail-dispatcher.service.ts:216-235` | `sharp(logoBuf).resize(60,60)` chạy MỖI mail (~229) |
| `fetchEventImage` | `mail-dispatcher.service.ts:243-287` | cache per-URL/batch (~300) — OK, không phải bottleneck |
| SMTP adapter | `mail-dispatcher/smtp-mail.adapter.ts:35-43` | nodemailer KHÔNG pool → 1 connection, tuần tự |
| Kafka adapter | `mail-dispatcher/kafka-producer.adapter.ts:63-78` | **KHÔNG có consumer nào consume `notification.send-ticket` trong toàn workspace** (chỉ grep thấy producer + docs) — MAIL_TRANSPORT=kafka hiện tại là bỏ mail vào topic không ai đọc |
| PDF render | `content-service/src/core/services/ticket-pdf.service.ts:37,72-77` | `registerFont` đọc 2 font file từ disk + parse lại MỖI render (pdfkit `registerFont` → `fontkit.create`); endpoint public `ticket.controller.ts:80-116` render lại mỗi lần bấm link |

**Phát hiện cảnh báo (P0, không phải tối ưu):** nếu prod đang cấu hình `MAIL_TRANSPORT=kafka`, mail vé đang KHÔNG được gửi (topic `notification.send-ticket` không có consumer trong `noti-analytics-service` — chỉ có `notification.send-otp`, xem `otpComsumer.kafka.ts:18`). Cần xác nhận env prod trước khi làm bất cứ điều gì khác.

---

## 1. Xếp hạng đề xuất (impact / effort)

| # | Đề xuất | Impact ước tính (chờ baseline) | Effort | Risk | Gốc hay vá |
|---|---|---|---|---|---|
| P1 | Dời dispatch khỏi HTTP request (worker queue / Kafka consumer) | Giảm ~90%+ thời gian giữ request distribute (phút → giây); email không phụ thuộc vòng đời HTTP | L | vừa | **Gốc** |
| P2 | SMTP pooling + concurrency có kiểm soát (pool:true, maxConnections, rateLimit) | Giảm ~60-80% wall-time mail job khi bounded bởi SMTP RTT (concurrency 1→3-5) | M | thấp-vừa | Gốc (tầng send) |
| P3 | Batch/cache QR token — diệt N+1 HTTP (`resolveQrPayload`) | Giảm N round-trip content (mỗi ~5-50ms) khỏi loop tuần tự | M | thấp | Vá gần gốc (triệt source N+1) |
| P4 | Cache PDF theo [ticketId + hash(PII)] + cache font buffer | Giảm render lặp phía content (re-click/pre-fetch) + bỏ fs-read font mỗi render | M | thấp | Vá (không chữa root bottleneck, root là SMTP/loop) |
| P5 | Cache logo resize 60x60 1 lần (QR) | Nhỏ: ~1-3ms/mail, không phải bottleneck | S | thấp | Vá |
| P6 | Prefetch ảnh event trước loop + đặt cache-control cho PDF | Nhỏ: bỏ jitter 1 fetch đầu loop; nit | S | thấp | Vá |

---

## 2. P1 — Dời dispatch ra worker queue (tách khỏi HTTP request)

**Mô tả**: `distribution.service.ts:216` `await this.mailDispatcher.dispatchBatch(payloads)` chạy trong request `POST /distribution/distribute` (`distribution.controller.ts:40-41`). `dispatchBatch` loop tuần tự toàn bộ (QR + HTTP + SMTP per mail) → batch N trăm vé giữ request N phút. Nguy cơ: LB/proxy timeout, process restart giữa chừng → email ĐÃ gửi nhưng `emailSentAt` chưa set (updateMany sau loop ~`distribution.service.ts:223-228`) → admin resend gửi đôi cho người đã nhận.

**Giải pháp (2 bước đi, không cần một lần)**
- Bước 1 (nhỏ): request `distribute()` chỉ persist job + PreTicket + mint (đã có, mint vẫn đồng bộ OK — chunk ≤500) rồi **enqueue** việc gửi email; trả ngay job RUNNING. Worker đọc `PreTicket WHERE jobId=... AND emailSentAt IS NULL` để gửi (idempotent sẵn — `emailSentAt` là guard chống gửi đôi, xem `distribution.service.ts:659-666`).
- Bước 2 (đúng kiến trúc đã vẽ trong DESIGN): consumer Kafka topic `notification.send-ticket`. **Lưu ý: hiện KHÔNG có consumer** — producer đã có (`kafka-producer.adapter.ts`), `noti-analytics-service` chỉ có consumer `notification.send-otp` (`otpComsumer.kafka.ts:18`). Cần viết consumer mới (noti-analytics hoặc worker riêng) kèm retry/DLQ (mẫu có sẵn ở `otpComsumer.kafka.ts:51-73`: retry 3 lần → DLQ `mail-dead-letter`).
- Khi dùng Kafka: vấn đề phụ — `kafka-producer.adapter.ts:74` `JSON.stringify(payload)` phình to vì `attachments` chứa `CidAttachment.content` là `Buffer` (trở thành object `{type:Buffer,data:[…]}`). Nên base64/compact hoặc chuyển producer sang gửi dạng job-ref (chỉ claimTokens) và consumer tự build payload.

**Impact**: "giảm ~90%+ thời gian request distribute + loại rủi ro trạng thái job khi request rớt (cần baseline xác nhận — đo T_http hiện tại với N=100/300/1000)". Concurrency của worker độc lập khỏi REST → mở đường cho P2/P3 điều chỉnh phía worker.

**Effort**: L (worker/consumer mới + thay đổi luồng distribute + theo dõi trạng thái job)
**Risk**: vừa — thay đổi contract hành vi hiển thị của admin (job RUNNING lâu hơn sau khi response trả về), cần đảm bảo UI đọc trạng thái qua `getStatus` (đã độc lập: `distribution.service.ts:503-514`, OK).
**Blast radius**: ticket-mayo (distribution + mail-dispatcher) + noti-analytics-service (consumer mới) + deployment topic/config.
**Phụ thuộc**: Kafka broker (đã có `KAFKA_BROKERS`) hoặc DB-only worker; không cần migration — `emailSentAt`/`preTicket.status` đã đủ.

**Nguồn**: mẫu consumer/retry/DLQ có sẵn ngay trong codebase `otpComsumer.kafka.ts:18-73` (đọc 2026-08-29); BullMQ rate-limit/worker docs — https://docs.bullmq.io/guide/rate-limiting (truy cập 2026-08-29): limiter `{max,duration}` global, job bị limit giữ state waiting, `worker.rateLimit()` để throttle động.

---

## 3. P2 — SMTP pooling + concurrency có kiểm soát

**Hiện trạng**: `smtp-mail.adapter.ts:35-43` tạo `createTransport` KHÔNG pool; `dispatchBatch` `await this.adapter.send(p)` tuần tự (`mail-dispatcher.service.ts:356`) → tại mọi thời điểm chỉ 1 SMTP transaction. Wall-time ≈ N × (QR + HTTP + SMTP RTT).

**Giải pháp (2 lớp, ưu tiên lớp 1)**
1. **Pool**: `pool: true, maxConnections: 3-5, maxMessages: 100` (mặc định nodemailer `maxConnections=5`, `maxMessages=100` — xác nhận từ source node_modules): nodemailer pool nội bộ cho phép nhiều connection song song trong khi `await sendMail` vẫn giữ backpressure tự nhiên (mail chỉ bị gọi tiếp khi 1 connection rảnh). Không cần p-limit ở client cho tầng SMTP.
2. Nếu không đổi pool: bọc `send` bằng p-limit(3-5) trong `dispatchBatch` — pattern chuẩn "bounded concurrency over await loop" (nguồn p-limit bên dưới).

**Thận trọng — đừng chỉ nhìn throughput**:
- **Gmail (smtp.gmail.com)**: giới hạn chính thức cho Workspace paid = 2000 tin/ngày/user, trial 500; vượt → "You have reached a limit for sending email", chặn tới 24h; spam → restriction vĩnh viễn (nguồn: Google Workspace sending limits, bên dưới). Số cho tài khoản @gmail.com miễn phí KHÔNG được Google công bố chính thức (con số ~500/ngày chỉ là cộng đồng — **chưa kiểm chứng nguồn chính thức, không đưa làm số liệu**). Hệ quả: batch > vài trăm vé/ngày qua Gmail relay là deliverability risk; grid phải có `rateLimit`/`rateDelta` (nodemailer hỗ trợ built-in, `smtp-pool/index.js:57-63`) + theo dõi bounce.
- **SES (đề xuất nếu trọng tải lớn)**: hạn mức chính thức — sandbox 200 tin/24h + 1 tin/s; hạn mức tính theo recipient (không theo message), riêng từng region, tăng qua Support case (nguồn: AWS SES docs bên dưới).
- Gmail API quota chỉ là tham chiếu cho hướng Gmail API nếu bỏ SMTP (không phải hướng chính).

**Impact**: "giảm ~60-80% wall-time mail job nếu phần lớn thời gian là SMTP RTT (concurrency 1→3-5); nếu bounded bởi N+1 HTTP (P3) hoặc Gmail rate-limit thì thấp hơn — cần baseline xác nhận (đo: thời gian gửi 100 mail MAIL_TRANSPORT=smtp hiện tại vs sau)". 
**Effort**: M đối với lựa chọn 1 (vài dòng adapter + +env), L nếu kéo theo P1.
**Risk**: thấp-vừa — đổi hành vi kết nối SMTP; cần giữ `emailSentAt` ghi sau khi `sendMail` resolve (đúng như code hiện tại, chỉ update sau khi OK -> không đổi logic).
**Blast radius**: ticket-mayo (smtp adapter) + env prod; không đụng content-service.
**Phụ thuộc**: không migration; cần quyết định relay (giữ Gmail vs SES vs SMTP relay Gmail) — xác nhận hạn mức account thật.

**Nguồn**:
- Nodemailer source (node_modules v9.0.5, đọc 2026-08-29): chọn transport theo `options.pool` — `lib/nodemailer.js:39`; default `maxConnections=5`, `maxMessages=100` — `lib/smtp-pool/index.js:47-48`; recycle connection khi `>= maxMessages` — `lib/smtp-pool/pool-resource.js:224`; `rateLimit`/`rateDelta` built-in (delta 1000ms, limit 0=off) — `lib/smtp-pool/index.js:57-63`.
- Trang docs nodemailer.com (fetch 2026-08-29): sitemap xác nhận tồn tại phần SMTP + trang Pooled transport (`/smtp/pooled`); subpage trả 404 tại thời điểm fetch — nội dung chi tiết không quote được, dùng source code làm tài liệu tham chiếu chính.
- Google Workspace Gmail sending limits — https://knowledge.workspace.google.com/admin/gmail/gmail-sending-limits-in-google-workspace (fetch 2026-08-29): 2000/ngày paid, 500/ngày trial, 10k tổng recipient/ngày (3k external), per-message 2000 recipient (500 external), qua SMTP POP/IMAP 100/message, quá -> "You have reached a limit", chặn tới 24h rolling, spam -> permanent.
- AWS SES sending quotas — https://docs.aws.amazon.com/ses/latest/dg/manage-sending-quotas.html (fetch 2026-08-29): quota 24h rolling + send rate/s; sandbox 200 tin/24h + 1 tin/s; quota tính theo recipient; per-region; max message 10MB; tăng qua Support.
- Gmail API quota (tham chiếu) — https://developers.google.com/gmail/api/v1/reference/quota (fetch 2026-08-29): 6000 units/min/user/project, send = 100 units → ~60 send/min/user; 1.2M units/min/project.
- p-limit bounded concurrency pattern — https://github.com/sindresorhus/p-limit (search metadata 2026-08-29; v7.3.0, Node 20+).

---

## 4. P3 — Batch/cache QR token (diệt N+1 HTTP trong loop)

**Hiện trạng**: mỗi email gọi `resolveQrPayload` (`mail-dispatcher.service.ts:207-213`) → `content.getTicketQrToken` (`content-client.service.ts:233-245`) → `GET /internal/distribution/tickets/:id/qr-token` — 1 HTTP round-trip/vé. Token là **static signed token** (exp = hết giờ event, self-verifying — comment `mail-dispatcher.service.ts:201-205`, `ticket.service.ts:880-894`) → KHÔNG thay đổi giữa các lần lấy của cùng ticket.

**Giải pháp (làm cả 2)**:
1. **Cache token theo ticketId** với TTL = thời gian còn lại tới event end (hoặc 24h an toàn): in-memory LRU trong ticket-mayo (job ngắn → đủ) hoặc Redis nếu nhiều instance. An toàn vì token tĩnh/self-verifying — cache miss fail-soft vẫn như cũ.
2. **Batch endpoint / trả kèm mint**: phát sinh kèm token trong response của `mintForDistribution` (đã chunk ≤500 — precedent có sẵn `content-client.service.ts:312-351`) để toàn bộ vé của job lấy được trong chính call mint; hoặc endpoint batch `qr-token?ids=…` ở content.

**Impact**: "giảm N round-trip (~5-50ms LAN tới content, cao hơn nếu cross-host qua API gateway) khỏi loop tuần tự — góp ~10-30% thời gian job khi loop slice; con số chính xác cần baseline xác nhận (đo latency `getTicketQrToken` trung bình)".
**Effort**: M (content API + client + cache).
**Risk**: thấp (fail-soft giữ nguyên; cache key ticketId tách bạch, không đụng PII).
**Blast radius**: ticket-mayo (content-client + mail-dispatcher) + content-service (internal endpoint) — internal endpoints có sẵn `ServiceTokenGuard`/`x-service-token`.
**Phụ thuộc**: không migration; nếu dùng Redis chung với hệ thống sẵn có.

**Nguồn**: cơ chế token tĩnh xác nhận trực tiếp từ code (comment service + hàm `buildStaticToken` `ticket.service.ts:969-…`); pattern chống N+1 HTTP: batching qua mint chunk là precedent nội bộ (`content-client.service.ts:312-351`); concurrency-limiting khi muốn bọc song song — https://github.com/sindresorhus/p-limit (2026-08-29).

---

## 5. P4 — Cache PDF + font buffer (content-service)

**Hiện trạng**: endpoint public `GET /content-service/tickets/:id/pdf?token=…` (`ticket.controller.ts:80-116`) → `ticket.service.ts:901-963` → `renderTicketPdf` (`ticket-pdf.service.ts:37-339`):
- `QRCode.toBuffer` mỗi render (~56-61);
- `registerFont` 2 font từ disk MỖI render (~72-77) — pdfkit `registerFont(name, src)` với src là path string → `fontkit.create(src)` mở + parse file (xác nhận từ source local `node_modules/pdfkit/js/pdfkit.js:2792,2877`);
- banner re-fetch presigned + `sharp` resize png mỗi render (~101-108, 929-948);
- trả `Buffer` hoàn chỉnh qua `res.send(buffer)` (không cache headers).

**Giải pháp**:
1. **Cache PDF theo key `[ticketId + sha256(name|phone|email|bookedAt normal)]`** — key khô (hash) nên không rò PII nếu cache ở Redis/shared; TTL ngắn (1-24h) bounded (VD LRU max N entry). Link trong email bị bấm nhiều lần + email client proxy pre-fetch (Gmail/Outlook quét link an toàn) → render lặp cùng nội dung. Hiệu quả cần xác nhận bằng access-log (đếm số request `:id/pdf` trùng ticket trong 24h) trước khi claim — ghi "cần baseline xác nhận".
2. **Font**: đọc 2 font Buffer 1 lần lúc khởi động + `registerFont(name, buffer)` (pdfkit chấp nhận Buffer/Uint8Array — `pdfkit.js:2794`) → bỏ fs.existsSync + disk read mỗi render; parse fontkit vẫn còn mỗi document (giới hạn thư viện) — đây là cải thiện nhỏ.
3. **Headers**: `Cache-Control: private, max-age=…` + `ETag` theo key — proxy không cache do token query nhưng browser/user có thể; streams/large buffer không phải vấn đề (A4 ~ 50-200KB).

**Lưu ý thiết kế (không phải bug)**: PII qua query là theo PRD §7.1 D3 (content KHÔNG lưu PII) — giữ nguyên; query string xuất hiện trong log/proxy là đánh đổi đã chấp nhận, ghi nhận trong hồ sơ security (đã có THREAT-MODEL).

**Impact**: "giảm ~30-70% số render PDF nếu tỷ lệ re-click/pre-fetch cao; không đụng throughput SMTP — role của nó là tiết kiệm CPU content + latency user; % chính xác cần baseline xác nhận (count distinct request/ticket/24h)".
**Effort**: M.
**Risk**: thấp — key hash có thể bỏ lỡ khi PII đổi (đúng — ticket cùng nội dung cũ vẫn valid vì cache theo key cũ cũng là nội dung cũ).
**Blast radius**: content-service (service + controller) — không đụng ticket-mayo.
**Phụ thuộc**: Redis sẵn có (hoặc in-memory cache module) — không migration code nếu chọn in-memory.

**Nguồn**:
- pdfkit v0.19.1 local — `js/pdfkit.js:2790-2796` (fontkit.create theo src: path → đọc file; Buffer/Uint8Array → dùng trực tiếp) và `js/pdfkit.js:2877` `registerFont(name, src)` (đọc trực tiếp 2026-08-29).
- Không tìm thấy benchmark định lượng công bố pdfkit vs pdf-lib vs pdfmake (đã search nhiều round 2026-08-29 — kết quả toàn tutorial định tính, không có số). Kết luận định tính: pdfkit streaming/ít memory nhất cho generation; pdfmake = pdfkit + layout engine (chậm hơn); pdf-lib mạnh về edit, in-memory nặng hơn — tham chiếu: https://pspdfkit.com/blog/2019/html-to-pdf-in-javascript/ (so sánh các thư viện HTML→PDF của vendor, 2026-08-29) và https://cloud.tencent.com/developer/article/2480530 (2026-08-29). **Khuyến nghị: KHÔNG đổi thư viện PDF** — bottleneck là loop/SMTP, không phải render; nếu cần thì tự benchmark `perf_hooks` (ngoài scope docs này).
- sharp performance page — https://sharp.pixelplumbing.com/performance (fetch 2026-08-29): thread pool libuv `UV_THREADPOOL_SIZE` default 4; caching libvips default ON.

---

## 6. P5 — Cache logo resize 60x60 (QR) — miếng vá nhỏ

**Hiện trạng**: `mail-dispatcher.service.ts:226-234` — mỗi email: `sharp(logoBuf).resize(60,60).toBuffer()` bên trong `.composite()` → decode + resize lại logo mỗi mail dù khác nhau DUY NHẤT ở payload QR (không dedupe được toàn bộ QR vì token khác nhau/vé — xác nhận: token tĩnh theo ticketId, mỗi vé 1 token).

**Giải pháp**: resize logo 1 lần (module-level hoặc đầu `dispatchBatch`), composite bằng Buffer đã resize. Thêm nữa: giảm `width: 300` → 150-200px nếu email render 1x (nhỏ hơn = ít pixel hơn để PNG-encode; xác nhận ảnh hưởng thị giác trước).

**Impact**: "nhỏ — ~1-3ms/mail CPU; KHÔNG phải bottleneck của job (xác nhận bằng phân tích: chi phí thống trị là SMTP RTT + N+1 HTTP). cần baseline xác nhận nếu muốn số".
**Effort**: S. **Risk**: thấp (có thể phá bug nếu logo bufer đổi mid-batch — logo là file tĩnh, an toàn).
**Blast radius**: ticket-mayo mail-dispatcher.
**Nguồn**: sharp `composite` input accepts Buffer — https://sharp.pixelplumbing.com/api-composite (fetch 2026-08-29); gravity default 'centre'.

---

## 7. P6 — Prefetch ảnh event trước loop + nit response PDF

**Hiện trạng**: `fetchEventImage` cache theo URL trong 1 batch (`mail-dispatcher.service.ts:247-286`, map tạo ở `:300`) → mỗi event fetch đúng 1 lần/job. **Xác nhận: KHÔNG phải bottleneck.**

**Cải thiện optional**:
1. Đầu `dispatchBatch` prefetch toàn bộ URL event unique (`Promise.all`) → bỏ jitter của mail đầu tiên (hiện mail đầu phải chờ fetch trước khi các mail sau dùng cache). Số liệu nhỏ.
2. PDF response: thêm `Cache-Control: private` + Content-Length (`ticket.controller.ts:110-115`) — miễn phí, giúp tránh user tải lặp.

**Impact**: negligible (cần baseline xác nhận); chủ yếu là vệ sinh.
**Effort**: S. **Risk**: thấp. **Blast radius**: ticket-mayo + content-service (controller).

---

## 8. Phân biệt "chữa đúng gốc" vs "miếng vá"

- **Gốc**: (1) `dispatchBatch` chạy trong HTTP request (P1) — nguồn gốc của mọi giới hạn; (2) tuần tự hoá 1-luồng tầng send (P2) — concurrency 1 với backpressure tự nhiên bị bỏ phí; (3) N+1 HTTP resolve token (P3) — round-trip tuần tự nối thêm latency.
- **Vá (vẫn đáng làm, chi phí thấp)**: P4 (cache PDF/font — tiết kiệm CPU content, không đụng bottleneck), P5 (logo resize — ~ms), P6 (prefetch/headers — vệ sinh).
- **KHÔNG nên làm**: đổi thư viện PDF sang pdf-lib/pdfmake (không có benchmark định lượng; bottleneck không nằm ở render); dedupe QR (không thể — token theo vé); lạm dụng concurrency lớn vào Gmail relay (rate-limit provider là rào chặn, không phải CPU).

## 9. Việc cần làm trước khi implement (đo baseline)

1. Xác nhận `MAIL_TRANSPORT`/`MAIL_HOST` prod (nghi vấn Kafka không consumer — mục 0).
2. Baseline (agent đo song song): T_HTTP `POST /distribute` với N=100/300/1000; phân rã: mint vs email loop; latency `getTicketQrToken`; SMTP RTT/mail; request count `:id/pdf`/ticket/24h.
3. Xác nhận hạn mức account SMTP thật (Gmail → nâng cấp Workspace hoặc SES; SES → thoát sandbox + tăng quota qua Support).

---

## 10. Nguồn research (truy cập 2026-08-29)

**Đã verify trực tiếp (fetch/đọc local)**:
- Google Workspace Gmail sending limits — https://knowledge.workspace.google.com/admin/gmail/gmail-sending-limits-in-google-workspace (fetch 2026-08-29)
- AWS SES sending quotas — https://docs.aws.amazon.com/ses/latest/dg/manage-sending-quotas.html (fetch 2026-08-29)
- Gmail API quota — https://developers.google.com/gmail/api/v1/reference/quota (fetch 2026-08-29)
- BullMQ rate limiting — https://docs.bullmq.io/guide/rate-limiting (fetch 2026-08-29)
- sharp composite — https://sharp.pixelplumbing.com/api-composite (fetch 2026-08-29)
- sharp performance — https://sharp.pixelplumbing.com/performance (fetch 2026-08-29)
- Nodemailer site sitemap — https://nodemailer.com/ (fetch 2026-08-29; subpage /smtp/pooled 404 tại thời điểm fetch → dùng source code npm làm tham chiếu chính)
- Nodemailer v9.0.5 source (local, ticket-mayo/node_modules): `lib/nodemailer.js:39`; `lib/smtp-pool/index.js:47-48,57-63`; `lib/smtp-pool/pool-resource.js:224`
- pdfkit v0.19.1 source (local, content-service/node_modules): `js/pdfkit.js:2790-2796,2877`
- Noti-analytics consumer hiện trạng (local, đọc 2026-08-29): `src/infrastructure/driven-adapters/messaging/consumer/otpComsumer.kafka.ts:18`

**Từ search, URL xác nhận tồn tại (chưa fetch nội dung)**:
- p-limit — https://github.com/sindresorhus/p-limit (search 2026-08-29; v7.3.0, Node 20+)
- PSPDFKit so sánh thư viện HTML→PDF — https://pspdfkit.com/blog/2019/html-to-pdf-in-javascript/ (search 2026-08-29)
- Tencent Cloud so sánh JS PDF libs — https://cloud.tencent.com/developer/article/2480530 (search 2026-08-29)
- Node.js stream backpressure — https://nodejs.org/download/release/v22.13.0/docs/api/stream.html (search 2026-08-29)

**Không đưa vào (chưa kiểm chứng)**: số "Gmail free ~500 tin/ngày"; số "SMTP relay Gmail 10.000 tin/ngày" (chỉ xuất hiện ở nguồn thứ cấp zhihu/CSDN); "SES default 14 tin/s + 50k/ngày" (không có trong trang AWS chính thức fetch được).

---

## 11. P7 (IMPLEMENTED 2026-08-29) — resize + nén ảnh event trước khi nhúng email

**Vấn đề (user report)**: ảnh trong email nặng mà không rõ nét; nghi ngờ base64.

**Chẩn đoán đúng gốc**:
- KHÔNG phải data-URI base64 trong HTML — là **inline attachment CID** (`src="cid:event-banner@ticket"`, chuẩn MIME). NodeMailer base64-encode mọi binary attachment vì SMTP chỉ truyền text (+33% byte) — nhưng đó là transfer-encoding bắt buộc của chuẩn, không phải thứ cần "sửa".
- Nặng: `fetchEventImage` nhúng **raw nguyên bản** từ presigned URL (cap cũ 3MB), không resize/nén; template hiển thị chỉ 600px.
- Không nét: ảnh gốc nhỏ bị upscale lên 600px (retina cần 1200px). **Resize KHÔNG làm nét hơn ảnh gốc** — chỉ chặn downscale + giảm nặng; ảnh gốc nhỏ thì phải đổi ảnh nguồn.
- PDF **không** nhúng raw: `ticket-pdf.service.ts:126` đã `sharp(data.backgroundBuffer)` → PDF không bị ảnh nặng.

**Giải pháp (chỉ ticket-mayo)**: `optimizeEventImage` chạy ngay trong `fetchEventImage` (mail-dispatcher.service.ts):
- `sharp().rotate()` (EXIF) → resize `width ≤ 1200` `withoutEnlargement` → flatten nền trắng (PNG alpha) → JPEG q80.
- Ảnh đã JPEG ≤ 256KB → nhúng nguyên bản (không phí CPU resize).
- Cache per-URL vốn có → toàn bộ batch cùng event chỉ optimize **1 lần**.
- Fail-soft: optimize lỗi / nén ra to hơn → giữ nguyên bản (KHÔNG fail gửi).

**Đo (jest, cùng workload, 2026-08-29, Node v22)**: 1 ảnh production-like 1664KB (2000×1250 JPEG q82 pixel nhiễu), N=100 vé cùng event.

| Metric | Trước (raw) | Sau (P7) | Delta |
|---|---|---|---|
| Banner/email | 1,664 KB | 409 KB | **−75.4%** |
| Tổng attachments+html N=100 | 167.4 MB | 41.9 MB | **−75.0% (−122.5 MB, ~1.2 MB/vé)** |
| dispatchBatch N=100 (không gồm QR gen) | — | **51 ms** (0.51 ms/vé) | optimize ảnh không phải bottleneck |

**Lưu ý đo trung thực**:
- `QRCode.toBuffer` trong jest-worker chậm bất thường (490 ms/cái so với 15.9 ms/QR đo trên node thật baseline) — **artifact môi trường jest, không thuộc P7** (P7 không đụng QR); wall 49 s với QR thật là hệ quả của nó, không dùng làm số bài toán.
- Ảnh thật (ảnh chụp, ít nhiễu hơn) ở 1200px q80 thường ~100-200KB → kích thước thực tế còn nhỏ hơn con số 409KB (nhiễu random nén rất kém).
- Boundary: ảnh JPEG nhỏ ≤256KB giữ nguyên; mọi format khác (PNG/WebP, dù nhỏ) đều re-encode → PNG. Lần sau nếu muốn tối ưu thêm: (a) nới `EVENT_IMAGE_OPTIMIZE_IF_BIGGER_THAN_BYTES`; (b) giảm hiển thị template xuống; (c) kiểm tra lại proxy presigned URL (debug ảnh mặc định — `fetchPresignedUrls` chưa xác định được tầng fail).

**Tests**: +3 unit test P7 (resize/JPEG, passthrough ảnh nhỏ, PNG alpha→flatten). Suite: **120/120 PASS**, `tsc --noEmit` sạch. Files: src/modules/mail-dispatcher/mail-dispatcher.service.ts (constants + `optimizeEventImage`), mail-dispatcher.service.spec.ts.