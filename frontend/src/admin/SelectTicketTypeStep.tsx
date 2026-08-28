import { FormEvent, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDistributionDraft } from './DistributionDraftContext';
import { ticketClient } from '../api/ticket.client';
import type { TicketType } from '../api/types';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { Spinner } from '../components/Spinner';
import { Stepper } from '../components/Stepper';

const STEPS = [
  { label: 'Sự kiện' },
  { label: 'Email' },
  { label: 'Loại vé' },
  { label: 'Xác nhận' },
];

export function SelectTicketTypeStep() {
  const navigate = useNavigate();
  const { draft, setDraft } = useDistributionDraft();
  const [types, setTypes] = useState<TicketType[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const eventId = draft.eventId || '';
  const ticketTypeId = draft.ticketTypeId || '';
  const quantity = draft.quantity;

  useEffect(() => {
    if (!draft.eventId) {
      navigate('/admin/distribute/event', { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!eventId) {
      setTypes([]);
      setLoading(false);
      return;
    }
    setLoading(true);
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

  function pickType(id: string) {
    const t = types.find((x) => x.id === id);
    setDraft({ ticketTypeId: id, ticketTypeName: t?.name, ticketTypeRemaining: t?.remaining });
  }

  function onNext(e: FormEvent) {
    e.preventDefault();
    if (!draft.eventId) {
      navigate('/admin/distribute/event', { replace: true });
      return;
    }
    if (draft.emails.length === 0) {
      navigate('/admin/distribute/emails', { replace: true });
      return;
    }
    if (!ticketTypeId) {
      setError('Vui lòng chọn loại vé.');
      return;
    }
    if (!quantity || quantity < 1) {
      setError('Số lượng mỗi email phải ≥ 1.');
      return;
    }
    navigate('/admin/distribute/confirm', { replace: false });
  }

  return (
    <div>
      <Stepper steps={STEPS} current={2} />
      <h1 className="page-title">Phát vé — Bước 3: Chọn loại vé &amp; số lượng</h1>
      {error && <div className="error-box">{error}</div>}
      <Card>
        <form onSubmit={onNext}>
          <div className="form-field">
            <label>Sự kiện</label>
            <div className="muted">
              {draft.eventName || '—'}{' '}
              <button
                type="button"
                style={{
                  border: 'none',
                  background: 'none',
                  color: '#3370ff',
                  cursor: 'pointer',
                  textDecoration: 'underline',
                  padding: 0,
                }}
                onClick={() => navigate('/admin/distribute/event')}
              >
                Đổi sự kiện
              </button>
            </div>
          </div>
          <div className="form-field">
            <label htmlFor="st-type">Loại vé</label>
            {loading ? (
              <Spinner />
            ) : (
              <>
                <select
                  id="st-type"
                  value={ticketTypeId}
                  onChange={(e) => pickType(e.target.value)}
                  required
                >
                  <option value="">— Chọn loại vé —</option>
                  {types.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                      {t.price != null ? ` · ${t.price}` : ''}
                      {t.remaining != null ? ` · Còn ${t.remaining}/` + (t.quantity ?? t.remaining) : ''}
                    </option>
                  ))}
                </select>
                {ticketTypeId && (
                  <div className="hint">
                    {draft.ticketTypeRemaining != null
                      ? `Loại vé này còn ${draft.ticketTypeRemaining} vé. `
                      : ''}
                    Tổng vé yêu cầu: <strong>{draft.emails.length * quantity}</strong>.{' '}
                    {draft.ticketTypeRemaining != null &&
                    draft.emails.length * quantity > draft.ticketTypeRemaining ? (
                      <strong className="text-danger">
                        Vượt quá số vé còn lại ({draft.ticketTypeRemaining}) — server sẽ từ chối khi phát.
                      </strong>
                    ) : (
                      'Lỗi vượt quota (nếu có) sẽ do server báo khi phát.'
                    )}
                  </div>
                )}
              </>
            )}
          </div>
          <div className="form-field">
            <label htmlFor="st-qty">Số vé mỗi email</label>
            <input
              id="st-qty"
              type="number"
              min="1"
              max="10"
              value={quantity}
              onChange={(e) => setDraft({ quantity: Math.max(1, Number(e.target.value) || 1) })}
            />
            <div className="hint">
              Tối đa 10 vé mỗi email. Tổng vé sẽ tạo:{' '}
              <strong>{draft.emails.length * quantity}</strong> ({draft.emails.length} email × {quantity})
            </div>
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <Button variant="secondary" type="button" onClick={() => navigate('/admin/distribute/emails')}>
              Quay lại
            </Button>
            <Button type="submit" disabled={!ticketTypeId}>
              Tiếp theo: xác nhận
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}