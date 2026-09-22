import { FormEvent, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ticketClient } from '../api/ticket.client';
import type { Event, TicketType } from '../api/types';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { Spinner } from '../components/Spinner';

export function TicketTypesPage() {
  const [events, setEvents] = useState<Event[]>([]);
  const [eventsLoaded, setEventsLoaded] = useState(false);
  // PERSIST-EVENT: nguồn sự thật của sự kiện đang chọn là URL (?eventId=...),
  // không phải component state — để reload / back-forward / quay lại từ Edit
  // giữ đúng ngữ cảnh thay vì nhảy về sự kiện đầu.
  const [searchParams, setSearchParams] = useSearchParams();
  const eventId = searchParams.get('eventId') ?? '';
  const [types, setTypes] = useState<TicketType[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [quota, setQuota] = useState('100');
  // MAX-PER-USER: số vé tối đa mỗi người nhận — default 4 (mirror content).
  const [maxTicketsPerUser, setMaxTicketsPerUser] = useState('4');
  const [codePrefix, setCodePrefix] = useState('');
  const [emailDistribution, setEmailDistribution] = useState(false);
  // VÉ-MIỄN-PHÍ-MINH-CHỨNG: flag + mô tả nhiệm vụ lúc tạo loại vé (mirror
  // emailDistribution; sửa được ở EditTicketTypePage sau khi tạo).
  const [requireProof, setRequireProof] = useState(false);
  const [proofTaskDescription, setProofTaskDescription] = useState('');
  const [saving, setSaving] = useState(false);

  // DELETE-INTERNAL: nút Xóa mỗi dòng — confirm trước khi gọi, disable khi
  // sold > 0 (dùng sold hiển thị sẵn), lỗi 400 từ server hiển thị kèm sold.
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  // VÉ-PDF-ZIP: nút "Tải PDF" gói toàn bộ PDF đã archive của loại vé (server stream zip).
  const [zippingId, setZippingId] = useState<string | null>(null);

  // VÉ CỨNG: form tạo vé in (quantity) + nút tải zip vé in.
  const [printId, setPrintId] = useState<string | null>(null);
  const [printQty, setPrintQty] = useState('100');
  const [printingId, setPrintingId] = useState<string | null>(null);
  const [printZipId, setPrintZipId] = useState<string | null>(null);

  async function onDownloadPdfZip(t: TicketType) {
    setZippingId(t.id);
    setError(null);
    try {
      const blob = await ticketClient.downloadTicketTypePdfsZip(t.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${t.name}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Revoke trễ — Firefox/Chrome cần URL sống vài trăm ms sau click để bắt download.
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e: any) {
      // Body lỗi là Blob (responseType) → message JSON không đọc được, map theo status.
      if (e?.status === 404) setError(`Chưa có PDF nào được lưu cho loại vé "${t.name}".`);
      else if (e?.status === 503) setError('Server chưa cấu hình bucket S3 để lưu PDF vé.');
      else setError(e?.message || 'Tải zip PDF thất bại.');
    } finally {
      setZippingId(null);
    }
  }

  // VÉ CỨNG: tạo job mint vé in + render PDF (sync, có thể lâu — disable form).
  async function onCreatePrint(t: TicketType) {
    const qty = Number(printQty) || 0;
    if (!qty || qty < 1) return;
    setPrintingId(t.id);
    setError(null);
    try {
      const res = await ticketClient.createPrintDistribution({ ticketTypeId: t.id, quantity: qty });
      if (res.pdf && res.pdf.failed > 0) {
        setError(
          `Đã tạo ${res.pdf.uploaded} vé in nhưng ${res.pdf.failed} vé thiếu PDF — tải zip xem danh sách _THIEU_PDF.txt.`,
        );
      }
      setPrintId(null);
    } catch (e: any) {
      // 409 quota body có remaining/requested — hiển thị thân thiện.
      if (e?.status === 409 && typeof e.remaining === 'number') {
        setError(
          `Không đủ vé: còn ${e.remaining} vé, yêu cầu ${e.requested ?? qty}.`,
        );
      } else {
        setError(e?.message || 'Tạo vé in thất bại.');
      }
    } finally {
      setPrintingId(null);
    }
  }

  async function onDownloadPrintZip(t: TicketType) {
    setPrintZipId(t.id);
    setError(null);
    try {
      const blob = await ticketClient.downloadTicketTypePrintPdfsZip(t.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Ve in - ${t.name}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e: any) {
      if (e?.status === 404) setError(`Chưa có vé in nào cho loại vé "${t.name}".`);
      else if (e?.status === 503) setError('Server chưa cấu hình bucket S3 để lưu PDF vé in.');
      else setError(e?.message || 'Tải zip vé in thất bại.');
    } finally {
      setPrintZipId(null);
    }
  }

  useEffect(() => {
    (async () => {
      try {
        setEvents(await ticketClient.listEvents());
      } catch (e: any) {
        setError(e?.message || 'Không tải được sự kiện.');
      } finally {
        setEventsLoaded(true);
      }
    })();
  }, []);

  // PERSIST-EVENT: chuẩn hóa selection từ URL. Thiếu param hoặc param trỏ sự
  // kiện không còn tồn tại (đã bị xóa) → fallback về sự kiện đầu và ghi lại URL.
  // Dùng replace:true để không nhét URL tạm/rác vào lịch sử trình duyệt.
  useEffect(() => {
    if (!eventsLoaded) return;
    const current = searchParams.get('eventId') ?? '';
    if (events.length === 0) {
      if (current) {
        const next = new URLSearchParams(searchParams);
        next.delete('eventId');
        setSearchParams(next, { replace: true });
      }
      return;
    }
    const valid = events.some((ev) => ev.id === current);
    if (!valid) {
      const next = new URLSearchParams(searchParams);
      next.set('eventId', events[0].id);
      setSearchParams(next, { replace: true });
    }
  }, [eventsLoaded, events, searchParams, setSearchParams]);

  // Đổi select = hành động chủ động của user → push entry mới để nút Back của
  // trình duyệt quay lại được sự kiện trước đó.
  function onEventChange(id: string) {
    const next = new URLSearchParams(searchParams);
    if (id) next.set('eventId', id);
    else next.delete('eventId');
    setSearchParams(next);
  }

  useEffect(() => {
    if (!eventId) {
      setTypes([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    (async () => {
      try {
        setTypes(await ticketClient.listTicketTypes(eventId));
      } catch (e: any) {
        setError(e?.message || 'Không tải được loại vé.');
      } finally {
        setLoading(false);
      }
    })();
  }, [eventId]);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    if (!eventId || !name.trim()) return;
    // Bật requireProof → mô tả nhiệm vụ bắt buộc (content validate lại).
    if (requireProof && proofTaskDescription.trim() === '') return;
    setSaving(true);
    setError(null);
    try {
      await ticketClient.createTicketType({
        eventId,
        name: name.trim(),
        price: price ? Number(price) : undefined,
        quota: Number(quota) || 0,
        maxTicketsPerUser: Number(maxTicketsPerUser) || undefined,
        codePrefix: codePrefix.trim() || undefined,
        emailDistribution,
        requireProof,
        proofTaskDescription: requireProof ? proofTaskDescription.trim() : undefined,
      });
      setName('');
      setPrice('');
      setQuota('100');
      setMaxTicketsPerUser('4');
      setCodePrefix('');
      setEmailDistribution(false);
      setRequireProof(false);
      setProofTaskDescription('');
      setTypes(await ticketClient.listTicketTypes(eventId));
    } catch (e: any) {
      setError(e?.message || 'Tạo loại vé thất bại.');
    } finally {
      setSaving(false);
    }
  }

  async function onDelete(t: TicketType) {
    if (!eventId || deletingId) return;
    setDeletingId(t.id);
    setError(null);
    try {
      await ticketClient.deleteTicketType(t.id);
      setConfirmId(null);
      setTypes(await ticketClient.listTicketTypes(eventId));
    } catch (e: any) {
      // 400 TICKET_TYPE_HAS_SOLD_TICKETS: server chặn vì đã có vé được cấp —
      // kèm sold (re-read ở content, không tin client) → hiển thị rõ con số.
      if (e?.code === 'TICKET_TYPE_HAS_SOLD_TICKETS') {
        const soldFromServer = typeof e.sold === 'number' ? e.sold : (t.sold ?? 0);
        setConfirmId(null);
        setError(
          `Không thể xóa "${t.name}" vì đã có ${soldFromServer} vé được phát.` +
            (e?.message ? ` ${e.message}` : ''),
        );
      } else {
        setError(e?.message || 'Xóa loại vé thất bại.');
      }
    } finally {
      setDeletingId(null);
    }
  }

  function onDeleteConfirm(t: TicketType) {
    if (!eventId || deletingId) return;
    setConfirmId(t.id);
    setError(null);
  }

  function onDeleteCancel() {
    if (deletingId) return; // đang gọi API — không cho hủy giữa chừng.
    setConfirmId(null);
  }

  async function onDeleteConfirmed(t: TicketType) {
    await onDelete(t);
  }

  const selectedEvent = events.find((ev) => ev.id === eventId) ?? null;

  return (
    <div>
      <h1 className="page-title">Loại vé</h1>
      <p className="page-sub">Định nghĩa loại vé, giá và hạn mức cho từng sự kiện.</p>
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}

      {/* Bối cảnh sự kiện — selector gọn làm header, không còn card rời. */}
      <div className="context-bar">
        <div className="form-field">
          <label htmlFor="tt-event">Sự kiện</label>
          <select id="tt-event" value={eventId} onChange={(e) => onEventChange(e.target.value)}>
            {events.length === 0 && <option value="">(chưa có sự kiện)</option>}
            {events.map((ev) => (
              <option key={ev.id} value={ev.id}>
                {ev.name}
              </option>
            ))}
          </select>
        </div>
        <div className="context-meta" aria-live="polite">
          {selectedEvent ? (
            <>
              <span className="context-name">{selectedEvent.name}</span>
              <span>
                {loading ? 'Đang tải…' : `${types.length} loại vé`}
              </span>
            </>
          ) : (
            <span>Chưa chọn sự kiện.</span>
          )}
        </div>
      </div>

      {/* Form tạo loại vé — card chính có cấu trúc. */}
      <Card>
        <div className="card-head">
          <h3>Tạo loại vé</h3>
          <p className="card-sub">
            Thêm một loại vé mới cho {selectedEvent ? `sự kiện "${selectedEvent.name}"` : 'sự kiện đã chọn'}.
          </p>
        </div>
        <form onSubmit={onCreate}>
          <div className="form-field">
            <label htmlFor="tt-name">Tên loại vé</label>
            <input id="tt-name" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="form-grid">
            <div className="form-field">
              <label htmlFor="tt-price">Giá (VND, tùy chọn)</label>
              <input
                id="tt-price"
                type="number"
                min="0"
                inputMode="numeric"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
              />
            </div>
            <div className="form-field">
              <label htmlFor="tt-quota">Số lượng tối đa</label>
              <input
                id="tt-quota"
                type="number"
                min="0"
                inputMode="numeric"
                value={quota}
                onChange={(e) => setQuota(e.target.value)}
              />
            </div>
          </div>
          {/* MAX-PER-USER: số vé tối đa mỗi người dùng nhận được. */}
          <div className="form-field">
            <label htmlFor="tt-maxper">Số vé tối đa mỗi người nhận</label>
            <input
              id="tt-maxper"
              type="number"
              min="1"
              step="1"
              inputMode="numeric"
              value={maxTicketsPerUser}
              onChange={(e) => setMaxTicketsPerUser(e.target.value)}
              aria-describedby="tt-maxper-hint"
            />
            <div className="hint" id="tt-maxper-hint">
              Mỗi người dùng chỉ được nhận tối đa số vé này của loại vé (mặc định 4).
            </div>
          </div>
          <div className="form-field">
            <label htmlFor="tt-prefix">Tiền tố mã vé (ví dụ: VIP)</label>
            <input
              id="tt-prefix"
              value={codePrefix}
              onChange={(e) => setCodePrefix(e.target.value)}
              aria-describedby="tt-prefix-hint"
            />
            <div className="hint" id="tt-prefix-hint">
              Mã vé sinh ra: &lt;prefix&gt;-&lt;random hex&gt;
            </div>
          </div>
          <div className="check-row">
            <input
              id="tt-email-dist"
              type="checkbox"
              checked={emailDistribution}
              onChange={(e) => setEmailDistribution(e.target.checked)}
              aria-describedby="tt-email-dist-hint"
            />
            <div className="check-text">
              <label className="check-label" htmlFor="tt-email-dist">
                Phát vé qua email (ẩn khỏi đăng ký trong app mayogu)
              </label>
              <div className="hint" id="tt-email-dist-hint">
                Bật: loại vé này chỉ được phát qua email ở màn Phát vé. Tắt (mặc định): loại
                vé thường, hiển thị cho người dùng đăng ký.
              </div>
            </div>
          </div>
          {/* VÉ-MIỄN-PHÍ-MINH-CHỨNG: checkbox yêu cầu ảnh minh chứng nhiệm vụ. */}
          <div className="check-row">
            <input
              id="tt-requireproof"
              type="checkbox"
              checked={requireProof}
              onChange={(e) => setRequireProof(e.target.checked)}
              aria-describedby="tt-requireproof-hint"
            />
            <div className="check-text">
              <label className="check-label" htmlFor="tt-requireproof">
                Yêu cầu ảnh minh chứng nhiệm vụ (vé miễn phí)
              </label>
              <div className="hint" id="tt-requireproof-hint">
                Bật: người dùng phải gửi ảnh minh chứng làm nhiệm vụ vào bình luận
                của sự kiện — AI kiểm tra ảnh trước khi được phát vé. Chỉ nên dùng
                cho vé miễn phí (price = 0).
              </div>
            </div>
          </div>
          {requireProof && (
            <div className="form-field">
              <label htmlFor="tt-prooftask">Mô tả nhiệm vụ (bắt buộc khi bật)</label>
              <textarea
                id="tt-prooftask"
                value={proofTaskDescription}
                onChange={(e) => setProofTaskDescription(e.target.value)}
                maxLength={1000}
                rows={3}
                placeholder="VD: Chụp ảnh chia sẻ bài viết sự kiện lên trang cá nhân (story Facebook)"
                aria-describedby="tt-prooftask-hint"
              />
              <div className="hint" id="tt-prooftask-hint">
                AI dùng mô tả này để phán đoán ảnh minh chứng trong bình luận có
                hợp lệ không. Nên mô tả cụ thể hành động cần thấy trong ảnh.
              </div>
              {requireProof && proofTaskDescription.trim() === '' && (
                <div className="error-box" role="alert" style={{ marginTop: 8 }}>
                  Bật yêu cầu minh chứng thì phải nhập mô tả nhiệm vụ.
                </div>
              )}
            </div>
          )}
          <div className="form-actions">
            <Button
              type="submit"
              loading={saving}
              disabled={!eventId || (requireProof && proofTaskDescription.trim() === '')}
            >
              Tạo loại vé
            </Button>
          </div>
        </form>
      </Card>

      <Card title="Danh sách loại vé">
        {loading ? (
          <Spinner />
        ) : types.length === 0 ? (
          <div className="empty">Chưa có loại vé cho sự kiện này.</div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Tên</th>
                  <th>Giá</th>
                  <th>Tổng số</th>
                  <th>Đã phát</th>
                  <th>Còn lại</th>
                  <th>Max/người</th>
                  <th>Tiền tố</th>
                  <th>Phát email</th>
                  <th>Minh chứng</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {types.map((t) => (
                  <tr key={t.id}>
                    <td>{t.name}</td>
                    <td>{t.price != null ? String(t.price) : '—'}</td>
                    <td>{t.quantity ?? '—'}</td>
                    <td>{t.sold ?? '—'}</td>
                    <td>{t.remaining ?? t.quota}</td>
                    {/* MAX-PER-USER: cột số vé tối đa mỗi người nhận. */}
                    <td>{t.maxTicketsPerUser ?? '—'}</td>
                    <td className="mono">{t.codePrefix || '—'}</td>
                    <td>{t.emailDistribution ? 'Có' : '—'}</td>
                    <td>
                      {/* VÉ-MIỄN-PHÍ-MINH-CHỨNG: badge loại vé yêu cầu minh chứng. */}
                      {t.requireProof ? (
                        <span title={t.proofTaskDescription || ''}>Có</span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      {(t.sold ?? 0) > 0 && (
                        <button
                          type="button"
                          className="btn btn-link"
                          disabled={zippingId != null}
                          onClick={() => onDownloadPdfZip(t)}
                        >
                          {zippingId === t.id ? 'Đang gói…' : 'Tải PDF'}
                        </button>
                      )}
                      {/* VÉ CỨNG: 2 nút riêng — chỉ loại vé emailDistribution (gate
                          mint), không cho loại requireProof (mint chắc chắn fail). */}
                      {t.emailDistribution && !t.requireProof && (
                        <>
                          <button
                            type="button"
                            className="btn btn-link"
                            disabled={printingId != null}
                            onClick={() => setPrintId(printId === t.id ? null : t.id)}
                          >
                            Vé in
                          </button>
                          <button
                            type="button"
                            className="btn btn-link"
                            disabled={printZipId != null}
                            onClick={() => onDownloadPrintZip(t)}
                          >
                            {printZipId === t.id ? 'Đang gói…' : 'Tải vé in'}
                          </button>
                        </>
                      )}
                      <Link className="btn btn-link" to={`/admin/ticket-types/${t.id}/edit`}>
                        Sửa
                      </Link>
                      {/* TICKET-APPEARANCE: ảnh riêng + màu QR của loại vé (preview app). */}
                      <Link className="btn btn-link" to={`/admin/ticket-types/${t.id}/appearance`}>
                        Ảnh vé
                      </Link>
                      {(t.sold ?? 0) > 0 ? (
                        <span
                          className="btn btn-link is-disabled"
                          title={`không thể xóa vì đã có ${t.sold} vé được phát`}
                          style={{ cursor: 'not-allowed', opacity: 0.5 }}
                        >
                          Xóa
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-link"
                          disabled={deletingId === t.id}
                          onClick={() => onDeleteConfirm(t)}
                        >
                          {deletingId === t.id ? 'Đang xóa…' : 'Xóa'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {confirmId != null && (
        <Card title="Xác nhận xóa loại vé">
          {(() => {
            const t = types.find((x) => x.id === confirmId);
            if (!t) return null;
            return (
              <div>
                <p style={{ margin: '0 0 16px' }}>
                  Xóa loại vé <strong>{t.name}</strong>
                  {(t.sold ?? 0) > 0
                    ? ` — KHÔNG thể xóa vì đã có ${t.sold} vé được phát.`
                    : `? Hành động này không thể hoàn tác.`}
                </p>
                <div className="form-actions" style={{ borderTop: 'none', paddingTop: 0 }}>
                  {(t.sold ?? 0) > 0 ? (
                    <Button variant="secondary" type="button" onClick={onDeleteCancel}>
                      Đóng
                    </Button>
                  ) : (
                    <>
                      <Button variant="secondary" type="button" disabled={deletingId != null} onClick={onDeleteCancel}>
                        Hủy
                      </Button>
                      <Button
                        variant="danger"
                        type="button"
                        loading={deletingId === t.id}
                        disabled={deletingId != null}
                        onClick={() => onDeleteConfirmed(t)}
                      >
                        Xóa vĩnh viễn
                      </Button>
                    </>
                  )}
                </div>
              </div>
            );
          })()}
        </Card>
      )}

      {/* VÉ CỨNG: form nhập số lượng vé in khi bấm "Vé in" ở 1 dòng. */}
      {printId != null && (
        <Card title="Tạo vé in (vé cứng cho nhà tài trợ)">
          {(() => {
            const t = types.find((x) => x.id === printId);
            if (!t) return null;
            return (
              <div>
                <p style={{ margin: '0 0 16px' }}>
                  Mint <strong>{Number(printQty) || 0}</strong> vé <strong>{t.name}</strong> không
                  gắn người nhận — PDF in tên &quot;Vé nhà tài trợ&quot;, SĐT/email để trống, QR
                  thật quét được khi check-in. Tải zip ở nút &quot;Tải vé in&quot; sau khi tạo xong.
                </p>
                <div className="form-field">
                  <label htmlFor="tt-print-qty">Số lượng vé in (tối đa 5000/lần)</label>
                  <input
                    id="tt-print-qty"
                    type="number"
                    min="1"
                    max="5000"
                    step="1"
                    inputMode="numeric"
                    value={printQty}
                    onChange={(e) => setPrintQty(e.target.value)}
                    aria-describedby="tt-print-qty-hint"
                  />
                  <div className="hint" id="tt-print-qty-hint">
                    Vé trừ vào hạn mức loại vé (còn {t.remaining ?? '?'}). Lớn hơn 5000: tách nhiều lần.
                  </div>
                </div>
                <div className="form-actions" style={{ borderTop: 'none', paddingTop: 0 }}>
                  <Button variant="secondary" type="button" disabled={printingId != null} onClick={() => setPrintId(null)}>
                    Hủy
                  </Button>
                  <Button
                    type="button"
                    loading={printingId === t.id}
                    disabled={printingId != null || !(Number(printQty) >= 1)}
                    onClick={() => onCreatePrint(t)}
                  >
                    {printingId === t.id ? 'Đang mint + render PDF…' : 'Tạo vé in'}
                  </Button>
                </div>
              </div>
            );
          })()}
        </Card>
      )}
    </div>
  );
}
