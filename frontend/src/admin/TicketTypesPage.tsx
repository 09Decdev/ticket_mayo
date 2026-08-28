import { FormEvent, useEffect, useState } from 'react';
import { ticketClient } from '../api/ticket.client';
import type { Event, TicketType } from '../api/types';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { Spinner } from '../components/Spinner';

export function TicketTypesPage() {
  const [events, setEvents] = useState<Event[]>([]);
  const [eventId, setEventId] = useState('');
  const [types, setTypes] = useState<TicketType[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [quota, setQuota] = useState('100');
  const [codePrefix, setCodePrefix] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const evs = await ticketClient.listEvents();
        setEvents(evs);
        if (evs.length > 0) setEventId(evs[0].id);
      } catch (e: any) {
        setError(e?.message || 'Không tải được sự kiện.');
      }
    })();
  }, []);

  useEffect(() => {
    if (!eventId) return;
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
    setSaving(true);
    setError(null);
    try {
      await ticketClient.createTicketType({
        eventId,
        name: name.trim(),
        price: price ? Number(price) : undefined,
        quota: Number(quota) || 0,
        codePrefix: codePrefix.trim() || undefined,
      });
      setName('');
      setPrice('');
      setQuota('100');
      setCodePrefix('');
      setTypes(await ticketClient.listTicketTypes(eventId));
    } catch (e: any) {
      setError(e?.message || 'Tạo loại vé thất bại.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <h1 className="page-title">Loại vé</h1>
      <p className="page-sub">Định nghĩa loại vé, giá và hạn mức cho từng sự kiện.</p>
      {error && <div className="error-box">{error}</div>}
      <Card title="Chọn sự kiện">
        <div className="form-field">
          <label htmlFor="tt-event">Sự kiện</label>
          <select id="tt-event" value={eventId} onChange={(e) => setEventId(e.target.value)}>
            {events.length === 0 && <option value="">(chưa có sự kiện)</option>}
            {events.map((ev) => (
              <option key={ev.id} value={ev.id}>
                {ev.name}
              </option>
            ))}
          </select>
        </div>
      </Card>
      <Card title="Tạo loại vé">
        <form onSubmit={onCreate}>
          <div className="form-field">
            <label htmlFor="tt-name">Tên loại vé</label>
            <input id="tt-name" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="row">
            <div className="form-field" style={{ flex: 1 }}>
              <label htmlFor="tt-price">Giá (VND, tùy chọn)</label>
              <input
                id="tt-price"
                type="number"
                min="0"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
              />
            </div>
            <div className="form-field" style={{ flex: 1 }}>
              <label htmlFor="tt-quota">Số lượng tối đa</label>
              <input
                id="tt-quota"
                type="number"
                min="0"
                value={quota}
                onChange={(e) => setQuota(e.target.value)}
              />
            </div>
          </div>
          <div className="form-field">
            <label htmlFor="tt-prefix">Tiền tố mã vé (ví dụ: VIP)</label>
            <input id="tt-prefix" value={codePrefix} onChange={(e) => setCodePrefix(e.target.value)} />
            <div className="hint">Mã vé sinh ra: &lt;prefix&gt;-&lt;random hex&gt;</div>
          </div>
          <Button type="submit" loading={saving} disabled={!eventId}>
            Tạo loại vé
          </Button>
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
                  <th>Tiền tố</th>
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
                    <td className="mono">{t.codePrefix || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
