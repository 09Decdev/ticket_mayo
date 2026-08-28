import { FormEvent, useEffect, useState } from 'react';
import { ticketClient } from '../api/ticket.client';
import type { Event } from '../api/types';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { Spinner } from '../components/Spinner';
import { formatDateTime } from '../common/format';

export function EventsPage() {
  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [venue, setVenue] = useState('');
  const [startAt, setStartAt] = useState('');
  const [endAt, setEndAt] = useState('');
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setEvents(await ticketClient.listEvents());
    } catch (e: any) {
      setError(e?.message || 'Không tải được sự kiện.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await ticketClient.createEvent({
        name: name.trim(),
        venue: venue.trim() || undefined,
        startAt: startAt ? new Date(startAt).toISOString() : undefined,
        endAt: endAt ? new Date(endAt).toISOString() : undefined,
      });
      setName('');
      setVenue('');
      setStartAt('');
      setEndAt('');
      await load();
    } catch (e: any) {
      setError(e?.message || 'Tạo sự kiện thất bại.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <h1 className="page-title">Sự kiện</h1>
      <p className="page-sub">Tạo và quản lý các sự kiện phát vé.</p>
      {error && <div className="error-box">{error}</div>}
      <Card title="Tạo sự kiện">
        <form onSubmit={onCreate}>
          <div className="form-field">
            <label htmlFor="ev-name">Tên sự kiện</label>
            <input id="ev-name" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="form-field">
            <label htmlFor="ev-venue">Địa điểm</label>
            <input id="ev-venue" value={venue} onChange={(e) => setVenue(e.target.value)} />
          </div>
          <div className="row">
            <div className="form-field" style={{ flex: 1 }}>
              <label htmlFor="ev-start">Bắt đầu</label>
              <input
                id="ev-start"
                type="datetime-local"
                value={startAt}
                onChange={(e) => setStartAt(e.target.value)}
              />
            </div>
            <div className="form-field" style={{ flex: 1 }}>
              <label htmlFor="ev-end">Kết thúc</label>
              <input
                id="ev-end"
                type="datetime-local"
                value={endAt}
                onChange={(e) => setEndAt(e.target.value)}
              />
            </div>
          </div>
          <Button type="submit" loading={saving}>
            Tạo sự kiện
          </Button>
        </form>
      </Card>
      <Card title="Danh sách sự kiện">
        {loading ? (
          <Spinner />
        ) : events.length === 0 ? (
          <div className="empty">Chưa có sự kiện. Tạo sự kiện đầu tiên bằng form bên trên.</div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Tên</th>
                  <th>Địa điểm</th>
                  <th>Bắt đầu</th>
                  <th>Kết thúc</th>
                </tr>
              </thead>
              <tbody>
                {events.map((ev) => (
                  <tr key={ev.id}>
                    <td>{ev.name}</td>
                    <td>{ev.venue || '—'}</td>
                    <td>{formatDateTime(ev.startAt)}</td>
                    <td>{formatDateTime(ev.endAt)}</td>
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
