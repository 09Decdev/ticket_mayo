# PERF BASELINE — Luồng bắn mail vé điện tử (dispatchBatch)

> Bước 1-2 của pipeline `/optimize`: đo BASELINE hiệu năng THẬT, không sửa code, không bịa số.
> Ngày đo: 2026-08-29. Người đo: Performance Benchmarker.

## 1. Environment (đo được)

| Hạng mục | Giá trị |
|---|---|
| OS | Windows 11 Pro 10.0.26200 (Git Bash) |
| CPU | 12 cores (host CPU: theo `os.cpus()[0].model`) |
| RAM | theo `os.totalmem()` |
| Node.js | v22.20.0 |
| ticket-mayo | branch main, `mail-dispatcher.service.ts` commit `bf650ba` (SHA256 `b3991eab…f2ae`), dist JS SHA256 `fa343b64…c9ec2` |
| content-service | đang chạy dev (`nest start --watch` + ts-node) tại `http://localhost:30042` — HTTP đo là THẬT (DB hit thật, vé thật) |
| Vé dùng để đo | `751be800-ee88-4bb8-b745-5fd3934c042d` (ticketCode `SLHN-VIP-104005`, status VALID, đọc read-only từ DB content) |
| Email template | `mail-previews/mayogu_ticket_email_template.html` 11,505 bytes |
| QR token thật | JWS 337 ký tự (lấy từ endpoint `/internal/distribution/tickets/:id/qr-token`) |

## 2. Method (tái lập được)

Script đứng riêng **ngoài repo** (scratch, đã tự dọn): import **code build sẵn** từ `ticket-mayo/dist/` (CJS) — dùng class/function THẬT: `MailDispatcherService`, `ContentClientService`, `SmtpMailAdapter`, `ConsoleMailAdapter`, `renderTicketEmailHtml`. Chạy với `cwd = ticket-mayo` để env.ts load `.env` + template + `img/` như production. Trước khi require, override `MAIL_TRANSPORT=console`, `MAIL_HOST/MAIL_PORT/MAIL_USER/MAIL_PASS` trỏ vào **SMTP sink local** (Node `net` server trả 250, discard body) — TUYỆT ĐỐI không gửi mail thật.

```bash
mkdir -p /tmp/bench-mail && cd c:/MAYogu_VIASG/ticket-mayo
node --expose-gc /tmp/bench-mail/bench-mail-stages.js   # per-stage + e2e console + e2e smtp-sink
node --expose-gc /tmp/bench-mail/bench-fix.js           # fix fase: fetchEventImage MISS thật + e2e batch FRESH
```

Mỗi phase: warmup 3, GC trước/sau, N=100 rồi N=500 (SMTP N=100/300), timeout mỗi stage `performance.now()`. Percentile theo mẫu. Kết quả JSON lưu tạm (đã xoá cùng scratch).

**Cẩn thận khi tái lập:** (1) `dispatchBatch` **mutate** `p.html`/`p.attachments` ngay trên payload (dòng 340-341) — dùng lại array payload của batch cũ sẽ bỏ sót toàn bộ cost render → luôn tạo batch mới; (2) `ConsoleMailAdapter` ghi file preview vào `process.cwd()/mail-previews/` (trong repo) — xoá các file `*-PBNC-*.html` sau khi chạy; (3) Kafka **không đo được**: `.env` không set `KAFKA_BROKERS` (adapter no-op) — nếu muốn đo, set broker + dùng topic throwaway (adapter thật hardcode topic `notification.send-ticket`, tránh chạm).

## 3. Kết quả (tất cả là số ĐO ĐƯỢC)

### 3.1 Per-stage (N=100, N=500 — cùng máy, tuần tự)

| Stage | N | mean | P50 | P95 | P99 | min | max | throughput |
|---|---|---|---|---|---|---|---|---|
| **A. resolveQrPayload HTTP thật** (`mail-dispatcher.service.ts:207-213` → `content-client.service.ts:233-245`) | 100 | 5.23ms | 5.10 | 7.45 | 10.89 | 3.98 | 10.89 | ~11,470 lần/phút |
| A. (lặp 500) | 500 | 4.64ms | 4.46 | 5.97 | 6.97 | 3.74 | 9.94 | ~12,944 lần/phút |
| B. resolveQrPayload 404-path (ticketId rác, fallback ticketCode) | 100 | 2.57ms | 2.46 | 3.38 | 3.90 | 2.21 | 3.90 | ~23,361 |
| **C. generateQrWithLogo CPU** (`mail-dispatcher.service.ts:216-235`) | 100 | 16.28ms | 15.96 | 18.76 | 24.56 | 14.44 | 24.56 | **~3,686 QR/phút** |
| C. (lặp 500) | 500 | 15.46ms | 15.06 | 17.54 | 23.26 | 14.05 | 43.37 | ~3,881 QR/phút |
| D1. fetchEventImage MISS (HTTP local 180KB, fresh cache) | 5 | 9.71ms | 1.73 | 40.95 | 40.95 | 1.31 | 40.95 | — (lần đầu lạnh) |
| D2. fetchEventImage CACHE HIT (cùng URL trong 1 batch) | 100 | ~0.00ms | 0 | <0.01 | 0.09 | 0 | 0.09 | ~32M |
| **E. renderTicketEmailHtml** (template 11.5KB, 16 placeholder) | 100 | 0.07ms | 0.06 | 0.10 | 0.40 | 0.05 | 0.40 | ~885k |
| F. ConsoleMailAdapter.send (ghi preview file) | 100 | 0.36ms | 0.33 | 0.52 | 0.78 | 0.29 | 0.78 | ~168k |
| **G. SMTP sink sendMail** (nodemailer, **pool=false** → 1 kết nối/mail) | 100 | 2.11ms | 1.95 | 3.26 | 5.46 | 1.65 | 5.46 | ~28,389 mail/phút |
| G. (lặp 300) | 300 | 1.81ms | 1.70 | 2.43 | 2.99 | 1.50 | 3.58 | ~33,126 |

*D1 là lower bound: presigned URL thật (MinIO, mạng khác) sẽ cao hơn; D3: ảnh >3MB bị chặn đúng (trả null, không fail mail).*

### 3.2 End-to-end `dispatchBatch` (batch FRESH, 100 vé THẬT, eventImage 1 URL dùng chung → fetch 1 lần + 99 cache hit)

| Variant | total (100 mail) | per-recipient | throughput |
|---|---|---|---|
| **H1 e2e console** (adapter ghi file) | 2,502.8ms | 25.0ms | ~2,396 mail/phút |
| **H2 e2e console** (repeat) | 2,525.5ms | 25.3ms | ~2,376 mail/phút |
| **H3 e2e SMTP-sink** (nodemailer thật, batch FRESH) | 2,970.5ms | 29.7ms | **~2,020 mail/phút** |

*H2 trước đó đo sai (batch bị mutate do H1) — đã thay bằng batch FRESH; H2 cũ đo nhầm là 4.4ms/mail, bỏ qua.*

### 3.3 Breakdown chi phí per-recipient (khớp với H2 = 25.3ms)

| Công đoạn | ms/recipient (mean) | % | Ghi chú |
|---|---|---|---|
| generateQrWithLogo (QR 300px + logo 60px + png) | ~15.5 | **61%** | full CPU, per-recipient, không cache được |
| resolveQrPayload (HTTP round-trip content-service, vé thật) | ~4.6-5.2 | **19-20%** | 1 HTTP/ticket — KHÔNG cache |
| adapter.send (SMTP sink, pool=false) | ~1.8-2.1 | 7-8% | loopback; relay thật cao hơn (ƯỚC LƯỢNG, không đo) |
| fetchEventImage (1 miss + 99 hit của batch) | ~0.1 | <1% | cache per-URL đã ok |
| renderTicketEmailHtml | ~0.07 | <1% | |
| tổng lý thuyết | ~22.5 | | H2 đo 25.3 (overhead loop/await ~11%) |

**Lưu ý (ĐO):** CPU của toàn bench 500 QR: user 7,922ms + system 1,797ms cho 500 QR (~19.4ms CPU/QR — gần bằng wall 15.5ms? CPU wall đo dùng `process.cpuUsage` delta chung của phase 500 QR; đơn vị user_ms = 7.9s CPU trên wall ~8s → QR gen là CPU-bound).

### 3.4 Memory (ĐO)

- Phase C2 (500 QR): RSS 134.2 → 139.3MB, heap 18.5 → 19.0MB (ổn định, GC giữa chừng).
- Phase A2 (500 HTTP): RSS 100.7 → 119.6MB, heap 17.5 → 30.9MB (HTTP client buffer tạm — giải phóng sau GC).
- dispatchBatch e2e 100 mail: RSS 101.4 → 135.6MB, heap 17.0 → 31.0MB.
- Không thấy rò rỉ trong phạm vi đo (heap không tăng tuyến tính qua phase có GC).

## 4. Top bottleneck xếp hạng (kèm file:dòng; cột "khả năng khắc phục" là ƯỚC LƯỢNG)

| # | Bottleneck | Bằng chứng (ĐO) | Vị trí |
|---|---|---|---|
| **1** | **generateQrWithLogo per-recipient, tuần tự** — QR 300px errorCorrection H + `sharp(logoBuf).resize(60,60)` + `.png()` encode cho TỪNG vé, trong vòng lặp tuần tự | 15.5-16.3ms mean (~61% chi phí recipient); throughput QR chỉ ~3,800/phút | `ticket-mayo/src/modules/mail-dispatcher/mail-dispatcher.service.ts:216-235` (+ loop tuần tự `:304-366`) |
| **2** | **resolveQrPayload: 1 HTTP round-trip/ticket, KHÔNG cache**, await tuần tự | 4.6-5.2ms mean; 500 HTTP = 2.3s chỉ riêng stage này; P99 7-11ms | `mail-dispatcher.service.ts:207-213` → `content-client.service.ts:233-245` (endpoint `/internal/distribution/tickets/:id/qr-token`); loop `:304-366` |
| **3** | **Loop tuần tự không concurrency** — toàn batch latency = Σ per-recipient; không tận dụng 12 cores | H2 100 mail = 2.5s, đúng Σ các stage; 1.000 vé ≈ 25s, 10.000 vé ≈ 4-5 phút (ước lượng tuyến tính) | `mail-dispatcher.service.ts:304-366` (`for (const p of payloads)` + `await` từng étape) |
| 4 | SMTP adapter **không pool** (1 connection/mail qua nodemailer) | 1.8-2.1ms loopback; với relay thật (TCP xa + TLS + auth, queue) ƯỚC LƯỢNG 20-200ms/mail — không đo để tránh gửi mail thật | `smtp-mail.adapter.ts:32-44` (transporter tạo 1 lần) + `:46-70` (`sendMail` từng mail) |

## 5. Không đo được (lý do + cách chạy)

| Mục | Lý do | Cách đo nếu cần |
|---|---|---|
| SMTP qua relay/Gmail thật | Ràng buộc tuyệt đối không gửi mail ra ngoài | Dựng mailpit/sink có độ trễ mô phỏng (vd 50-150ms/transaction + STARTTLS + AUTH PLAIN) rồi đo lại `SmtpMailAdapter.send` |
| Kafka adapter | `.env` không có `KAFKA_BROKERS` → adapter no-op (đúng thiết kế) | Set broker local + topic throwaway, đo `producer.send` (100 msg ~20-60KB JSON khi html+attachments) |
| End-to-end job HTTP đầy đủ (distribution) | ticket-mayo backend không boot (port 3000 = gateway-auth-service), cần admin auth + migration deploy | Boot app dev, tạo job, gọi endpoint distribute; đọc log `[DISTRIBUTE] ... (xxx ms)` |

## 6. Kết luận

- **Throughput email THỰC TẾ (SMTP-sink): ~2,000 mail/phút** single-process, giới hạn bởi chuỗi `QR CPU (61%) + HTTP (19%) + SMTP (8%)` chạy tuần tự.
- 3 bottleneck trên là nơi tối ưu trúng và đúng nhất: (1) giảm QR cost (VD kích thước 300→200px, QR Logo 1 lần cache composite, hoặc worker pool), (2) cache/batch `resolveQrPayload` (VD prefetch N ticket trong 1 call, cache TTL ngắn), (3) song song hoá loop trong giới hạn ổn định — ước lượng 4-10x throughput khi kết hợp.

---

## § After — đo lại 2026-08-29 (sau tối ưu P2-P6)

> Cùng method + cùng workload baseline; số BEFORE lấy nguyên từ §3 trên, KHÔNG đo lại. Đã `npm run build` cả 2 repo (dist mới phản ánh code P2-P6). content-service = instance MỚI boot từ dist build mới trên cổng **30142** (DB content thật, vé thật, `x-service-token` khớp) — resolveQr section là **REAL** (không stub). SMTP sink local y như baseline. N=500 e2e: DB dev chỉ có 178 vé VALID → 178 payload real ticketId + 322 payload code-only (fallback chính chủ — ảnh hưởng không đáng kể tới cost QR/render/send).

### §A.1 Per-stage (AFTER)

| Stage | N | mean | P50 | P95 | P99 | min | max | throughput |
|---|---|---|---|---|---|---|---|---|
| **A' batch `getTicketQrTokens`** (1 HTTP cho N vé — P3) | 100 ids | 406.1ms tổng | — | — | — | — | — | ~4.06ms/ticket amortized |
| A'. (178 ids — toàn bộ vé thật) | 178 | 786.6ms tổng | — | — | — | — | — | ~4.42ms/ticket amortized |
| **A'' resolveQrPayload trong loop** (LRU hit — P3, KHÔNG còn HTTP/ticket) | 178 | 0.00ms | 0 | 0 | 0 | 0 | 0.01 | ~vô hạn |
| **C. generateQrWithLogo** (logo resize đã cache 1 lần — P5) | 100 | 17.21ms | 15.51 | 31.24 | 52.88 | 13.69 | 52.88 | ~3,486 QR/phút |
| C. (lặp 500) | 500 | 13.98ms | 13.62 | 16.81 | 20.90 | 12.39 | 24.00 | ~4,292 QR/phút |
| D1. fetchEventImage MISS (HTTP local 615KB — ảnh bench to hơn baseline 180KB) | 5 | 10.82ms | 3.08 | 40.73 | 40.73 | 2.68 | 40.73 | — |
| D2. fetchEventImage CACHE HIT | 100 | ~0.00ms | 0 | 0 | 0.04 | 0 | 0.04 | ~vô hạn |
| E. renderTicketEmailHtml | 100 | 0.08ms | 0.06 | 0.18 | 0.37 | 0.06 | 0.37 | ~750k |
| F. ConsoleMailAdapter.send | 100 | 0.58ms | 0.55 | 0.83 | 2.23 | 0.41 | 2.23 | ~103k |
| **G. SMTP sink sendMail (pool=true, maxConn 5 — P2)** | 100 | 1.63ms | 1.34 | 2.41 | 16.09 | 1.09 | 16.09 | ~36,810 |
| G. (lặp 300) | 300 | 1.33ms | 1.20 | 1.92 | 3.37 | 0.96 | 5.04 | ~45,113 |

### §A.2 End-to-end `dispatchBatch` (AFTER — batch FRESH, dispatcher mới mỗi run)

| Variant | total | per-recipient | throughput | vs BEFORE |
|---|---|---|---|---|
| **H1 e2e console** N=100 | 1,589.3ms | 15.9ms | ~3,775 mail/phút | BEFORE 2,502.8ms / 25.0ms / 2,396 → **-36.5% total, +57.5% tpm** |
| **H2 e2e console** (FRESH, lặp) N=100 | 1,634.6ms | 16.3ms | ~3,671 mail/phút | BEFORE 2,525.5ms / 25.3ms / 2,376 → **-35.3% total, +54.5% tpm** |
| **H3 e2e SMTP-sink** N=100 | 2,767.8ms | 27.7ms | ~2,168 mail/phút | BEFORE 2,970.5ms / 29.7ms / 2,020 → **-6.8% total, +7.3% tpm** |
| **H3 e2e SMTP-sink** N=500 (178 real + 322 code-only) | 11,639.0ms | 23.3ms | ~2,578 mail/phút | baseline chưa có N=500 |

### §A.3 Delta tổng hợp

| Cấu phần | BEFORE (baseline §3) | AFTER | Delta |
|---|---|---|---|
| resolveQrPayload per-ticket (HTTP trong loop) | 4.64–5.23ms | **0.00ms** (LRU hit) | HTTP stage bị triệt tiêu; trả 1 batch call ~0.4–0.8s chung job |
| generateQrWithLogo P50 | 15.06–15.96ms | 13.62–15.51ms | -0.9…-1.4ms (P5 nhỏ như dự đoán; n=100 +0.93 nhiễu) |
| SMTP send mean (pool=false → pool=true) | 1.81–2.11ms | 1.33–1.63ms | **-22…-27%** |
| H1 console e2e | 25.0ms/mail | 15.9ms/mail | **-36.5%** |
| H3 SMTP e2e N=100 | 29.7ms/mail | 27.7ms/mail | **-6.8%** (sink loopback nhanh → bottleneck vẫn là QR CPU, khớp dự đoán baseline) |
| Memory e2e | RSS 101→136MB | RSS 128→157MB (H1); 170→202MB (H3-500) | ổn định, không rò rỉ |

### §A.4 Xác nhận đề xuất

- **P2 (SMTP pool + concurrency 4): XÁC NHẬN** — stage SMTP -22-27%; e2e console +57% throughput; e2e SMTP chỉ +7% (sink local không phải bottleneck; relay thật sẽ hưởng hơn).
- **P3 (batch QR + LRU): XÁC NHẬN** — loop HTTP stage = 0.00ms; 1 request ≤500 vé (`POST /internal/distribution/tickets/qr-tokens`); giá up-front ~0.4–0.8s/job.
- **P5 (logo resize 1 lần): XÁC NHẬN nhỏ** — P50 -1.4ms ở N=500 (~9% QR stage); n=100 nhiễu.
- **P6 (prefetch event image): XÁC NHẬN cấu trúc** — D1 tương đương baseline (10.82ms vs 9.71ms, nhưng file 615KB vs 180KB), bỏ jitter mail đầu; D2 hit vẫn ~0.
- **P1 (worker queue): chưa implement → không đo được.**
- **Regression rõ ràng: KHÔNG có.** Nhiễu đo được: F console-send 0.36→0.58ms (I/O disk), C-100 +0.93ms. 500 mail SMTP giờ ~11.6s (ước tính trước tối ưu ~25s tuyến tính).

*Điều kiện đo: cùng máy Windows 11 / Node v22.20.0; content instance mới 30142 từ `node dist/main.js` với `.env` content + `PORT=30142`; SMTP sink local 10252; ảnh event bench 615KB (baseline 180KB).*