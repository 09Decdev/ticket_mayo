import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ticketClient } from '../api/ticket.client';
import type { TicketType } from '../api/types';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { Spinner } from '../components/Spinner';

/**
 * Edit ticket type (name + quantity ONLY) — admin edit screen.
 * - sold hiển thị read-only; client validate min quantity = sold.
 * - Server (content-service) validate lại quantity >= sold ở service layer
 *   (không tin client) — 400 TICKET_TYPE_QUANTITY_BELOW_SOLD kèm sold.
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
  const nameInvalid = name.trim() === '';
  const formInvalid =
    nameInvalid || quantity === '' || quantityInvalid || !id || !initial;

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
      });
      setInitial(updated);
      setSold(updated.sold ?? sold);
      setQuantity(String(updated.quantity ?? parsedQuantity));
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
        Chỉ được sửa tên và số lượng. Số vé đã bán là read-only — số lượng tối thiểu
        bằng số vé đã bán.
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
