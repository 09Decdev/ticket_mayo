import { FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDistributionDraft } from './DistributionDraftContext';
import { ticketClient } from '../api/ticket.client';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { formatApiError } from '../common/format';
import { Stepper } from '../components/Stepper';
import { IconSend } from '../components/icons';

const STEPS = [
  { label: 'Sự kiện' },
  { label: 'Email' },
  { label: 'Loại vé' },
  { label: 'Xác nhận' },
];

export function ConfirmDistributionStep() {
  const navigate = useNavigate();
  const { draft, setDraft, clear } = useDistributionDraft();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const total = draft.emails.length * draft.quantity;

  async function onConfirm(e: FormEvent) {
    e.preventDefault();
    if (!draft.eventId) {
      navigate('/admin/distribute/event', { replace: true });
      return;
    }
    if (draft.emails.length === 0 || !draft.ticketTypeId) {
      navigate('/admin/distribute/emails', { replace: true });
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const idempotencyKey = `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const res = await ticketClient.createDistribution({
        ticketTypeId: draft.ticketTypeId,
        quantity: draft.quantity,
        recipients: draft.emails,
        idempotencyKey,
        btcUrl: draft.btcUrl?.trim() || undefined,
      });
      const jobId = res.job?.id;
      clear();
      navigate(jobId ? `/admin/distributions/${encodeURIComponent(jobId)}` : '/admin/distributions', {
        replace: true,
      });
    } catch (e: any) {
      // T8: lỗi quota 409 {code, remaining, requested} → message thân thiện,
      // KHÔNG hiển thị raw error stack.
      setError(formatApiError(e));
      setSubmitting(false);
    }
  }

  return (
    <div>
      <Stepper steps={STEPS} current={3} />
      <h1 className="page-title">Phát vé — Bước 4: Xác nhận</h1>
      {error && <div className="error-box">{error}</div>}
      <Card title="Tóm tắt">
        <table className="table">
          <tbody>
            <tr>
              <th>Sự kiện</th>
              <td>{draft.eventName || '—'}</td>
            </tr>
            <tr>
              <th>Loại vé</th>
              <td>{draft.ticketTypeName || '—'}</td>
            </tr>
            <tr>
              <th>Số người nhận</th>
              <td>{draft.emails.length}</td>
            </tr>
            <tr>
              <th>Vé mỗi email</th>
              <td>{draft.quantity}</td>
            </tr>
            <tr>
              <th>Tổng vé sẽ tạo</th>
              <td>
                <strong>{total}</strong>
              </td>
            </tr>
            {draft.ticketTypeRemaining != null && (
              <>
                <tr>
                  <th>Vé còn lại của loại vé</th>
                  <td>{draft.ticketTypeRemaining}</td>
                </tr>
                {total > draft.ticketTypeRemaining && (
                  <tr>
                    <th>Kiểm tra quota</th>
                    <td>
                      <span className="text-danger">
                        Vượt quá số vé còn lại — server sẽ trả lỗi 409 khi phát.
                      </span>
                    </td>
                  </tr>
                )}
              </>
            )}
          </tbody>
        </table>
      </Card>
      <Card title="Liên kết cập nhật của BTC (hiện trong email vé)">
        <div className="form-field">
          <label htmlFor="btc-url">Link Facebook/website của sự kiện</label>
          <input
            id="btc-url"
            type="url"
            placeholder="https://www.facebook.com/…"
            value={draft.btcUrl ?? ''}
            onChange={(e) => setDraft({ btcUrl: e.target.value })}
            style={{ width: '100%' }}
          />
          <div className="muted small" style={{ marginTop: 4 }}>
            Người nhận sẽ thấy link này trong email vé. Bỏ trống nếu không muốn hiện.
          </div>
        </div>
      </Card>
      <Card title="Danh sách người nhận">
        <div className="tag-list">
          {draft.emails.map((em) => (
            <span key={em} className="tag">
              {em}
            </span>
          ))}
        </div>
      </Card>
      <div className="row" style={{ marginTop: 12 }}>
        <Button variant="secondary" type="button" onClick={() => navigate('/admin/distribute/type')}>
          Quay lại
        </Button>
        <form onSubmit={onConfirm} style={{ display: 'inline' }}>
          <Button type="submit" loading={submitting} disabled={total === 0}>
            <IconSend width={15} height={15} />
            Phát vé ({total})
          </Button>
        </form>
      </div>
    </div>
  );
}
