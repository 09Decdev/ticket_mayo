import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { QRCodeCanvas } from 'qrcode.react';
import { ticketClient } from '../api/ticket.client';
import type { TicketTypeAppearance } from '../api/types';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { Spinner } from '../components/Spinner';
import { formatDateTime } from '../common/format';

/**
 * TICKET-APPEARANCE — "Ảnh vé & màu QR" (backend-only fix cho app Flutter).
 * Admin chọn loại vé → thay ảnh riêng + màu QR, xem PREVIEW đúng tỷ lệ UI
 * app (thumbnail 77×77, mini QR 50×50, QR chi tiết 218×218 + logo 42×42,
 * banner 4096:2251) rồi bấm Lưu mới PATCH content-service.
 *
 * Flow ảnh: chọn file → upload ngay (lấy fileId + preview local object-URL)
 * → Lưu mới PATCH ticketImageFileId. Đổi ý → "Bỏ ảnh riêng" gửi null.
 * Presigned URL remote đi qua image-proxy (CORS SeaweedFS).
 */

const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** Sửa #RGB → #RRGGBB (QRCodeCanvas + input[type=color] cần 6 chữ số). */
function toHex6(hex: string): string {
  if (hex.length === 4) {
    return '#' + hex.slice(1).split('').map((c) => c + c).join('');
  }
  return hex;
}

const QR_DEMO_PAYLOAD = 'MAYO-DEMO|preview-appearance|do-not-scan';

export function TicketTypeAppearancePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [initial, setInitial] = useState<TicketTypeAppearance | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Form state — null = "reset về default".
  const [imageFileId, setImageFileId] = useState<string | null>(null);
  const [qrFg, setQrFg] = useState('#000000');
  const [qrBg, setQrBg] = useState('#ffffff');

  // Preview image sources (object URL cục bộ — không CORS).
  const [ownImageUrl, setOwnImageUrl] = useState<string | null>(null); // ảnh riêng (upload mới hoặc saved presigned proxied)
  const [eventImageUrl, setEventImageUrl] = useState<string | null>(null); // ảnh event (fallback preview)
  const [savedImageUrl, setSavedImageUrl] = useState<string | null>(null); // presigned proxied của ảnh ĐÃ LƯU

  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Tải dữ liệu hiện tại + resolve 2 ảnh qua image-proxy (blob → object URL).
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    const urls: string[] = [];
    setLoading(true);
    (async () => {
      try {
        const ap = await ticketClient.getTicketTypeAppearance(id);
        if (cancelled) return;
        setInitial(ap);
        setImageFileId(ap.ticketImageFileId ?? null);
        setQrFg(toHex6(ap.qrForegroundColor ?? '#000000'));
        setQrBg(toHex6(ap.qrBackgroundColor ?? '#ffffff'));
        const prox = async (url?: string | null): Promise<string | null> => {
          if (!url) return null;
          try {
            const blob = await ticketClient.getAppearanceImage(id, url);
            const u = URL.createObjectURL(blob);
            urls.push(u);
            return u;
          } catch {
            return null; // fail-soft → placeholder trong preview
          }
        };
        const [own, ev] = await Promise.all([
          prox(ap.ticketImageUrl),
          prox(ap.event?.eventImageUrl),
        ]);
        if (cancelled) return;
        setSavedImageUrl(own);
        setOwnImageUrl(own);
        setEventImageUrl(ev);
      } catch (e: any) {
        if (!cancelled) setError(e?.message || 'Không tải được cấu hình hiển thị vé.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [id]);

  // Preview dùng: ảnh riêng đang chọn (upload mới) > ảnh đã lưu > ảnh event.
  const previewImage = ownImageUrl ?? eventImageUrl;

  const fgInvalid = !HEX_RE.test(qrFg);
  const bgInvalid = !HEX_RE.test(qrBg);
  const formInvalid = fgInvalid || bgInvalid || !id || !initial;

  const dirty = useMemo(() => {
    if (!initial) return false;
    return (
      (imageFileId ?? null) !== (initial.ticketImageFileId ?? null) ||
      toHex6(qrFg) !== toHex6(initial.qrForegroundColor ?? '#000000') ||
      toHex6(qrBg) !== toHex6(initial.qrBackgroundColor ?? '#ffffff')
    );
  }, [initial, imageFileId, qrFg, qrBg]);

  // Chọn file → upload NGAY (lấy fileId + preview object-URL). Lưu riêng.
  async function onPickFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !id) return;
    if (!/^image\//.test(file.type)) {
      setError('Chỉ nhận file ảnh (PNG/JPG/WebP).');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError('Ảnh quá lớn (>10MB).');
      return;
    }
    setError(null);
    setNotice(null);
    setUploading(true);
    const localUrl = URL.createObjectURL(file);
    try {
      const up = await ticketClient.uploadTicketTypeImage(id, file);
      setImageFileId(up.fileId);
      setOwnImageUrl((prev) => {
        if (prev && prev !== savedImageUrl) URL.revokeObjectURL(prev);
        return localUrl;
      });
      setNotice(`Đã upload ảnh (${up.status}). Bấm "Lưu" để áp dụng cho loại vé.`);
    } catch (err: any) {
      URL.revokeObjectURL(localUrl);
      setError(err?.message || 'Upload ảnh thất bại.');
    } finally {
      setUploading(false);
    }
  }

  function onClearImage() {
    setImageFileId(null);
    setOwnImageUrl(savedImageUrl); // preview quay về ảnh đã lưu (nếu có)
    setNotice('Sẽ reset về ảnh mặc định của sự kiện sau khi Lưu.');
  }

  function onResetColors() {
    setQrFg('#000000');
    setQrBg('#ffffff');
  }

  async function onSave(e: FormEvent) {
    e.preventDefault();
    if (!id || formInvalid) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const updated = await ticketClient.updateTicketTypeAppearance(id, {
        ticketImageFileId: imageFileId,
        qrForegroundColor: qrFg.toLowerCase(),
        qrBackgroundColor: qrBg.toLowerCase(),
      });
      setInitial({
        ...updated,
        event: updated.event ?? initial?.event ?? null,
      });
      setImageFileId(updated.ticketImageFileId ?? null);
      setQrFg(toHex6(updated.qrForegroundColor ?? '#000000'));
      setQrBg(toHex6(updated.qrBackgroundColor ?? '#ffffff'));
      // Refresh preview ảnh đã lưu: PATCH trả presigned mới → proxy lại;
      // upload-service optimize async (PENDING) có khi chưa resolve được URL —
      // giữ nguyên object-URL local (cùng ảnh) thay vì mất preview.
      if (id && updated.ticketImageUrl) {
        try {
          const blob = await ticketClient.getAppearanceImage(id, updated.ticketImageUrl);
          const u = URL.createObjectURL(blob);
          setSavedImageUrl(u);
          setOwnImageUrl((prev) => {
            if (prev && prev !== savedImageUrl) URL.revokeObjectURL(prev);
            return u;
          });
        } catch {
          /* giữ preview local — ảnh đã lưu, chỉ chưa resolve URL */
        }
      } else if (!imageFileId) {
        setSavedImageUrl(null);
        setOwnImageUrl(null);
      }
      setNotice('Đã lưu cấu hình hiển thị vé.');
    } catch (err: any) {
      setError(err?.message || 'Lưu thất bại.');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div>
        <h1 className="page-title">Ảnh vé &amp; màu QR</h1>
        <Spinner />
      </div>
    );
  }

  const eventTitle = initial?.event?.title ?? '(sự kiện)';
  const eventNameFull = `${eventTitle} • ${initial?.name ?? ''}`;
  const typePart = initial?.name ?? '';
  const evAddr = initial?.event?.address ?? '';
  const evStart = initial?.event?.startTime ?? null;
  const serialDemo = `MAYO-${(initial?.name ?? 'TYPE').toUpperCase().replace(/\s+/g, '').slice(0, 6)}-0001`;

  return (
    <div>
      <h1 className="page-title">Ảnh vé &amp; màu QR</h1>
      <p className="page-sub">
        Mỗi loại vé có ảnh riêng + màu QR riêng — khách nhìn thumbnail biết ngay mình
        đang giữ loại nào và cần quét ở cổng nào. Preview bên dưới đúng tỷ lệ UI app
        Flutter (không sửa app — chỉ cần pull-refresh trong app).
      </p>

      {error && <div className="error-box">{error}</div>}
      {notice && <div className="hint">{notice}</div>}

      {initial ? (
        <div className="appearance-grid">
          {/* ─── Cột trái: form ─── */}
          <Card title={`Loại vé: ${initial.name || '(chưa có tên)'}`}>
            <form onSubmit={onSave}>
              <div className="form-field">
                <label>Sự kiện</label>
                <div className="hint" style={{ marginTop: 0 }}>
                  {eventTitle}
                  {evStart ? ` — ${formatDateTime(evStart)}` : ''}
                </div>
              </div>

              {/* Ảnh vé riêng */}
              <div className="form-field">
                <label>Ảnh riêng của loại vé</label>
                <div className="appearance-image-row">
                  <div className="appearance-thumb">
                    {previewImage ? (
                      <img src={previewImage} alt="Ảnh vé" />
                    ) : (
                      <span>no image</span>
                    )}
                  </div>
                  <div className="appearance-image-actions">
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/gif"
                      style={{ display: 'none' }}
                      onChange={onPickFile}
                    />
                    <Button
                      type="button"
                      variant="secondary"
                      loading={uploading}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      {uploading ? 'Đang upload…' : imageFileId ? 'Đổi ảnh' : 'Chọn ảnh'}
                    </Button>
                    {imageFileId && (
                      <Button type="button" variant="link" onClick={onClearImage}>
                        Bỏ ảnh riêng
                      </Button>
                    )}
                  </div>
                </div>
                <div className="hint">
                  Ảnh riêng thay cho ảnh sự kiện trên thumbnail &amp; banner vé.
                  Gợi ý: tỷ lệ ~1.82:1 (vd 1820×1000), chữ ngắn to rõ cổng/vùng
                  (VD: "CỔNG A • VIP") để nhận biết tức thì trên màn nhỏ.
                </div>
              </div>

              {/* Màu QR */}
              <div className="form-field">
                <label>Màu QR</label>
                <div className="appearance-color-row">
                  <div className="appearance-color-item">
                    <span className="appearance-color-label">Màu mã (tối)</span>
                    <div className="appearance-color-inputs">
                      <input
                        type="color"
                        value={toHex6(qrFg)}
                        onChange={(e) => setQrFg(e.target.value)}
                        aria-label="Chọn màu mã QR"
                      />
                      <input
                        value={qrFg}
                        onChange={(e) => setQrFg(e.target.value)}
                        placeholder="#000000"
                        spellCheck={false}
                        className={fgInvalid ? 'is-invalid' : ''}
                      />
                    </div>
                  </div>
                  <div className="appearance-color-item">
                    <span className="appearance-color-label">Màu nền (sáng)</span>
                    <div className="appearance-color-inputs">
                      <input
                        type="color"
                        value={toHex6(qrBg)}
                        onChange={(e) => setQrBg(e.target.value)}
                        aria-label="Chọn màu nền QR"
                      />
                      <input
                        value={qrBg}
                        onChange={(e) => setQrBg(e.target.value)}
                        placeholder="#ffffff"
                        spellCheck={false}
                        className={bgInvalid ? 'is-invalid' : ''}
                      />
                    </div>
                  </div>
                </div>
                {fgInvalid && (
                  <div className="hint" style={{ color: 'var(--danger)' }}>
                    Màu mã phải là hex #RGB hoặc #RRGGBB.
                  </div>
                )}
                {bgInvalid && (
                  <div className="hint" style={{ color: 'var(--danger)' }}>
                    Màu nền phải là hex #RGB hoặc #RRGGBB.
                  </div>
                )}
                <div className="hint">
                  So sánh độ tương phản: mã tối &amp; nền sáng (như đen/trắng) thì
                  máy quét đọc nhanh nhất.{' '}
                  <button
                    type="button"
                    className="btn btn-link"
                    onClick={onResetColors}
                    style={{ padding: 0 }}
                  >
                    Reset đen/trắng
                  </button>
                </div>
              </div>

              <div className="form-actions">
                <Button type="submit" loading={saving} disabled={formInvalid}>
                  Lưu thay đổi{dirty ? '' : ' (chưa có gì đổi)'}
                </Button>
                <Button
                  variant="secondary"
                  type="button"
                  onClick={() =>
                    navigate(
                      initial.eventId
                        ? `/admin/ticket-types?eventId=${encodeURIComponent(initial.eventId)}`
                        : '/admin/ticket-types',
                    )
                  }
                >
                  Quay lại
                </Button>
              </div>
            </form>
          </Card>

          {/* ─── Cột phải: preview đúng Flutter ─── */}
          <Card title="Preview — giống app">
            <p className="page-sub" style={{ margin: '0 0 12px' }}>
              Danh sách vé (trái) + vé chi tiết (phải) — đúng kích thước app Flutter.
            </p>
            <div className="tk-preview-bg">
              {/* Card trong danh sách — mimic my_event_ticket_card.dart */}
              <div className="tk-ticket-card">
                <div className="tk-thumb">
                  {previewImage ? <img src={previewImage} alt="thumb" /> : <span>no image</span>}
                </div>
                <div className="tk-t-body">
                  <div className="tk-t-info">
                    <div className="tk-t-name">
                      {eventTitle} <span className="tk-type-tag">• {typePart}</span>
                    </div>
                    <div className="tk-t-meta">
                      <div>{evAddr}</div>
                      <div>{formatDateTime(evStart)}</div>
                      <div>Vé: {serialDemo}</div>
                    </div>
                    <span className="tk-badge">Còn hiệu lực</span>
                  </div>
                  <div className="tk-t-qr">
                    <QRCodeCanvas
                      value={QR_DEMO_PAYLOAD}
                      size={48}
                      level="M"
                      fgColor={toHex6(qrFg)}
                      bgColor={toHex6(qrBg)}
                    />
                  </div>
                </div>
              </div>

              {/* Vé chi tiết — mimic ticket_qr_card.dart */}
              <div className="tk-d-card">
                <div className="tk-d-banner">
                  {previewImage ? <img src={previewImage} alt="banner" /> : <span>no image</span>}
                </div>
                <div className="tk-d-body">
                  <div className="tk-d-title">{eventTitle}</div>
                  <div className="tk-d-serial">Serial: {serialDemo}</div>
                  <div className="tk-d-qr-wrap">
                    <QRCodeCanvas
                      value={QR_DEMO_PAYLOAD}
                      size={200}
                      level="M"
                      fgColor={toHex6(qrFg)}
                      bgColor={toHex6(qrBg)}
                    />
                    <div className="tk-d-qr-logo">M</div>
                  </div>
                  <div className="tk-d-info">
                    <div>
                      <b>Địa điểm:</b> {evAddr || '—'}
                    </div>
                    <div>
                      <b>Thời gian:</b> {formatDateTime(evStart)}
                    </div>
                    <div>
                      <b>Loại vé:</b> {typePart}
                    </div>
                    <div>
                      <b>Tên hiển thị trong app:</b> {eventNameFull}
                    </div>
                    <div>
                      <b>Trạng thái:</b> Còn hiệu lực
                    </div>
                  </div>
                  <div className="tk-d-footer">
                    Xuất trình QR này cho nhân viên kiểm soát tại cổng tương ứng
                  </div>
                </div>
              </div>
            </div>
          </Card>
        </div>
      ) : (
        <Card title="Không tìm thấy loại vé">
          <div className="empty">Không tải được loại vé này.</div>
        </Card>
      )}
    </div>
  );
}
