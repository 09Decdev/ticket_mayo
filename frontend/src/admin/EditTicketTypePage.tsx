import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ticketClient } from '../api/ticket.client';
import type { TicketType } from '../api/types';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { Spinner } from '../components/Spinner';

/**
 * Edit ticket type (name + quantity + maxTicketsPerUser +
 * VÉ-MIỄN-PHÍ-MINH-CHỨNG proof fields) — admin edit screen.
 * - sold hiển thị read-only; client validate min quantity = sold.
 * - Server (content-service) validate lại quantity >= sold và requireProof
 *   cần mô tả nhiệm vụ ở service layer (không tin client).
 */
export function EditTicketTypePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [initial, setInitial] = useState<TicketType | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [quantity, setQuantity] = useState('');
  const [sold, setSold] = useState(0);
  const [saving, setSaving] = useState(false);

  // MAX-PER-USER: số vé tối đa mỗi người nhận — sửa được ở edit screen.
  const [maxTicketsPerUser, setMaxTicketsPerUser] = useState('');
  // VÉ-MIỄN-PHÍ-MINH-CHỨNG: flag yêu cầu minh chứng + mô tả nhiệm vụ cho AI.
  const [requireProof, setRequireProof] = useState(false);
  const [proofTaskDescription, setProofTaskDescription] = useState('');

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    (async () => {
      try {
        const tt = await ticketClient.getTicketTypeForEdit(id);
        setInitial(tt);
        setName(tt.name ?? '');
        setQuantity(String(tt.quantity ?? 0));
        setSold(tt.sold ?? 0);
        setMaxTicketsPerUser(tt.maxTicketsPerUser != null ? String(tt.maxTicketsPerUser) : '');
        setRequireProof(Boolean(tt.requireProof));
        setProofTaskDescription(tt.proofTaskDescription ?? '');
      } catch (e: any) {
        setError(e?.message || 'Không tải được loại vé.');
      } finally {
        setLoading(false);
      }
    })();
  }, [id]);

  const parsedQuantity = Number(quantity);
  const quantityInvalid = useMemo(
    () => quantity !== '' && (!Number.isInteger(parsedQuantity) || parsedQuantity < sold),
    [quantity, parsedQuantity, sold],
  );
  // MAX-PER-USER: phải là số nguyên >= 1 khi có nhập.
  const parsedMaxPerUser = maxTicketsPerUser === '' ? undefined : Number(maxTicketsPerUser);
  const maxPerUserInvalid =
    parsedMaxPerUser !== undefined &&
    (!Number.isInteger(parsedMaxPerUser) || parsedMaxPerUser < 1);
  const nameInvalid = name.trim() === '';
  // Bật requireProof → mô tả nhiệm vụ bắt buộc (server validate lại).
  const proofDescInvalid = requireProof && proofTaskDescription.trim() === '';
  const formInvalid =
    nameInvalid ||
    quantity === '' ||
    quantityInvalid ||
    maxPerUserInvalid ||
    proofDescInvalid ||
    !id ||
    !initial;

  async function onSave(e: FormEvent) {
    e.preventDefault();
    if (!id || formInvalid) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const updated = await ticketClient.updateTicketTypeBasic(id, {
        name: name.trim(),
        quantity: parsedQuantity,
        maxTicketsPerUser: parsedMaxPerUser,
        requireProof,
        proofTaskDescription: requireProof ? proofTaskDescription.trim() : '',
      });
      setInitial(updated);
      setSold(updated.sold ?? sold);
      setQuantity(String(updated.quantity ?? parsedQuantity));
      setMaxTicketsPerUser(
        updated.maxTicketsPerUser != null ? String(updated.maxTicketsPerUser) : '',
      );
      setRequireProof(Boolean(updated.requireProof));
      setProofTaskDescription(updated.proofTaskDescription ?? '');
      setNotice('Đã lưu thay đổi.');
    } catch (e: any) {
      // 400 TICKET_TYPE_QUANTITY_BELOW_SOLD: kèm sold — hiển thị rõ số vé đã bán.
      if (e?.code === 'TICKET_TYPE_QUANTITY_BELOW_SOLD') {
        const soldFromServer = typeof e.sold === 'number' ? e.sold : undefined;
        setSold(soldFromServer ?? sold);
        setError(
          `Không thể đặt số lượng thấp hơn số vé đã bán` +
            (soldFromServer != null ? ` (${soldFromServer} vé)` : '') +
            `. ${e?.message ?? ''}`,
        );
      } else {
        setError(e?.message || 'Lưu thất bại.');
      }
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div>
        <h1 className="page-title">Sửa loại vé</h1>
        <Spinner />
      </div>
    );
  }

  return (
    <div>
      <h1 className="page-title">Sửa loại vé</h1>
      <p className="page-sub">
        Chỉ được sửa tên, số lượng, số vé tối đa mỗi người nhận và yêu cầu minh
        chứng nhiệm vụ. Số vé đã bán là read-only — số lượng tối thiểu bằng số
        vé đã bán.
      </p>

      {error && <div className="error-box">{error}</div>}
      {notice && <div className="hint">{notice}</div>}

      {initial ? (
        <Card title={initial.eventId ? `Loại vé: ${initial.name || '(chưa có tên)'}` : 'Loại vé'}>
          <form onSubmit={onSave}>
            <div className="form-field">
              <label htmlFor="ett-name">Tên loại vé</label>
              <input
                id="ett-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
              {nameInvalid && (
                <div className="hint">Tên loại vé không được để trống.</div>
              )}
            </div>

            <div className="form-field">
              <label htmlFor="ett-sold">Đã bán (không thể sửa)</label>
              <input id="ett-sold" type="number" value={sold} disabled readOnly />
              <div className="hint">
                Số lượng phải &ge; số vé đã bán — không thể rút xuống thấp hơn số vé đã phát.
              </div>
            </div>

            <div className="form-field">
              <label htmlFor="ett-quantity">Số lượng (tổng)</label>
              <input
                id="ett-quantity"
                type="number"
                min={sold}
                step="1"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                required
              />
              <div className="hint">
                {sold > 0
                  ? `Tối thiểu ${sold} (đã bán ${sold} vé) — giảm dưới mức này sẽ bị từ chối.`
                  : 'Chưa bán vé nào — có thể đặt số lượng bất kỳ ≥ 0.'}
              </div>
              {quantityInvalid && (
                <div className="error-box" style={{ marginTop: 8 }}>
                  Số lượng không hợp lệ: phải là số nguyên ≥ {sold} (số vé đã bán).
                </div>
              )}
            </div>

            {/* MAX-PER-USER: sửa số vé tối đa mỗi người nhận (≥ 1). */}
            <div className="form-field">
              <label htmlFor="ett-maxper">Số vé tối đa mỗi người nhận</label>
              <input
                id="ett-maxper"
                type="number"
                min="1"
                step="1"
                value={maxTicketsPerUser}
                onChange={(e) => setMaxTicketsPerUser(e.target.value)}
              />
              <div className="hint">
                Mỗi người dùng chỉ được nhận tối đa số vé này của loại vé. Để trống
                = giữ nguyên giá trị hiện tại.
              </div>
              {maxPerUserInvalid && (
                <div className="error-box" style={{ marginTop: 8 }}>
                  Số vé tối đa mỗi người phải là số nguyên ≥ 1.
                </div>
              )}
            </div>

            <div className="form-field">
              <label htmlFor="ett-requireproof" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  id="ett-requireproof"
                  type="checkbox"
                  checked={requireProof}
                  onChange={(e) => setRequireProof(e.target.checked)}
                />
                Yêu cầu ảnh minh chứng nhiệm vụ (vé miễn phí)
              </label>
              <div className="hint">
                Người dùng phải gửi ảnh minh chứng làm nhiệm vụ vào bình luận của
                sự kiện trước khi được phát vé — AI kiểm tra ảnh theo mô tả nhiệm
                vụ bên dưới.
              </div>
            </div>

            {requireProof && (
              <div className="form-field">
                <label htmlFor="ett-prooftask">Mô tả nhiệm vụ (bắt buộc khi bật)</label>
                <textarea
                  id="ett-prooftask"
                  value={proofTaskDescription}
                  onChange={(e) => setProofTaskDescription(e.target.value)}
                  maxLength={1000}
                  rows={3}
                  placeholder="VD: Chụp ảnh chia sẻ bài viết sự kiện lên trang cá nhân (story Facebook)"
                  required
                />
                <div className="hint">
                  AI dùng mô tả này để phán đoán ảnh minh chứng trong bình luận có
                  hợp lệ không. Nên mô tả cụ thể hành động cần thấy trong ảnh.
                </div>
                {proofDescInvalid && (
                  <div className="error-box" style={{ marginTop: 8 }}>
                    Bật yêu cầu minh chứng thì phải nhập mô tả nhiệm vụ.
                  </div>
                )}
              </div>
            )}

            <div className="row">
              <Button type="submit" loading={saving} disabled={formInvalid}>
                Lưu thay đổi
              </Button>
              <Button
                variant="secondary"
                type="button"
                onClick={() =>
                  // PERSIST-EVENT: về danh sách kèm đúng sự kiện của loại vé này
                  // để không mất ngữ cảnh (màn danh sách đọc ?eventId= từ URL).
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
      ) : (
        <Card title="Không tìm thấy loại vé">
          <div className="empty">Không tải được loại vé này.</div>
        </Card>
      )}
    </div>
  );
}
