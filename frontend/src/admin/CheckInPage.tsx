import { FormEvent, useState } from 'react';
import { ticketClient } from '../api/ticket.client';
import type { TicketView } from '../api/types';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { StatusBadge } from '../components/Badge';
import { IconCheck, IconCheckIn, IconInfo } from '../components/icons';
import { formatDateTime } from '../common/format';

export function CheckInPage() {
  const [ticketCode, setTicketCode] = useState('');
  const [gateId, setGateId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ ticket?: TicketView; already?: boolean; error?: string } | null>(null);

  async function onCheckIn(e: FormEvent) {
    e.preventDefault();
    if (!ticketCode.trim()) return;
    setSubmitting(true);
    setResult(null);
    try {
      const res = await ticketClient.checkIn({
        ticketCode: ticketCode.trim(),
        gateId: gateId.trim() || undefined,
      });
      setResult({ ticket: res.ticket, already: res.alreadyCheckedIn });
      setTicketCode('');
    } catch (err: any) {
      setResult({ error: err?.message || 'Check-in thất bại.' });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <h1 className="page-title">Check-in vé</h1>
      <p className="page-sub">Quét hoặc nhập mã vé để xác nhận khách vào cổng.</p>
      <Card>
        <form onSubmit={onCheckIn}>
          <div className="form-field">
            <label htmlFor="ci-code">Mã vé (ticket code)</label>
            <input
              id="ci-code"
              value={ticketCode}
              onChange={(e) => setTicketCode(e.target.value)}
              placeholder="VD: VIP-A1B2C3D4E5F6"
              autoFocus
              required
            />
          </div>
          <div className="form-field">
            <label htmlFor="ci-gate">Gate (tùy chọn)</label>
            <input id="ci-gate" value={gateId} onChange={(e) => setGateId(e.target.value)} placeholder="VD: gate-A" />
          </div>
          <Button type="submit" loading={submitting}>
            <IconCheckIn width={15} height={15} />
            Check-in
          </Button>
        </form>
      </Card>
      {result?.error && (
        <div className="error-box">
          <IconInfo width={16} height={16} style={{ marginTop: 2, flexShrink: 0 }} />
          {result.error}
        </div>
      )}
      {result?.already && !result.error && (
        <div className="warn-box">
          <IconInfo width={16} height={16} style={{ marginTop: 2, flexShrink: 0 }} />
          Vé đã check-in trước đó (idempotent).
        </div>
      )}
      {result?.ticket && !result.error && (
        <Card title="Vé đã check-in">
          <div className="ok-box" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <IconCheck width={16} height={16} style={{ flexShrink: 0 }} />
            <span>
              Check-in thành công lúc <strong>{formatDateTime(result.ticket.checkedInAt)}</strong>
            </span>
          </div>
          <div className="table-wrap">
            <table className="table">
              <tbody>
                <tr>
                  <th>Mã vé</th>
                  <td className="mono">{result.ticket.ticketCode}</td>
                </tr>
                <tr>
                  <th>Sự kiện</th>
                  <td>{result.ticket.event.name}</td>
                </tr>
                <tr>
                  <th>Loại vé</th>
                  <td>{result.ticket.ticketType.name}</td>
                </tr>
                <tr>
                  <th>Trạng thái</th>
                  <td>
                    <StatusBadge status={result.ticket.status} />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
