import { FormEvent, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDistributionDraft } from './DistributionDraftContext';
import { ticketClient } from '../api/ticket.client';
import type { Event } from '../api/types';
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

export function SelectEventStep() {
  const navigate = useNavigate();
  const { draft, setDraft } = useDistributionDraft();
  const [query, setQuery] = useState('');
  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>(draft.eventId ?? '');

  useEffect(() => {
    loadEvents('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadEvents(q: string) {
    setLoading(true);
    setError(null);
    try {
      setEvents(await ticketClient.listEvents(q || undefined));
    } catch (e: any) {
      setError(e?.message || 'Không tải được sự kiện.');
    } finally {
      setLoading(false);
    }
  }

  function onSearch(e: FormEvent) {
    e.preventDefault();
    loadEvents(query.trim());
  }

  function onNext(e: FormEvent) {
    e.preventDefault();
    const ev = events.find((x) => x.id === selected);
    if (!ev) {
      setError('Vui lòng chọn sự kiện.');
      return;
    }
    setDraft({
      eventId: ev.id,
      eventName: ev.name,
      ticketTypeId: undefined,
      ticketTypeName: undefined,
      quantity: 1,
    });
    navigate('/admin/distribute/emails', { replace: false });
  }

  return (
    <div>
      <Stepper steps={STEPS} current={0} />
      <div
        className="layout-header"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <h1 className="page-title" style={{ margin: 0 }}>
          Phát vé — Bước 1: Chọn sự kiện
        </h1>
        <Button type="button" onClick={onNext} disabled={!selected}>
          Tiếp theo: danh sách email
        </Button>
      </div>
      {error && <div className="error-box">{error}</div>}
      <Card>
        <form onSubmit={onSearch}>
          <div className="form-field">
            <label htmlFor="ev-search">Tìm sự kiện</label>
            <div className="row" style={{ gap: 8 }}>
              <input
                id="ev-search"
                type="search"
                placeholder="Gõ tên sự kiện…"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setError(null);
                }}
                style={{ flex: 1 }}
              />
              <Button type="submit" variant="secondary">
                Tìm
              </Button>
            </div>
          </div>
        </form>
        {loading ? (
          <Spinner />
        ) : (
          <div>
            {events.length === 0 && <div className="muted">(không có sự kiện nào)</div>}
            {events.map((ev) => {
              const isSelected = selected === ev.id;
              return (
                <label
                  key={ev.id}
                  className="row"
                  style={{
                    display: 'flex',
                    gap: 8,
                    alignItems: 'flex-start',
                    padding: 10,
                    border: `1px solid ${isSelected ? '#3370ff' : '#e0e0e0'}`,
                    background: isSelected ? '#e8f1ff' : '#fff',
                    borderRadius: 8,
                    marginBottom: 6,
                    cursor: 'pointer',
                  }}
                >
                  <input
                    type="radio"
                    name="event"
                    value={ev.id}
                    checked={isSelected}
                    onChange={() => setSelected(ev.id)}
                    style={{ marginTop: 3 }}
                  />
                  <div>
                    <div>
                      <strong>{ev.name}</strong>
                    </div>
                    {ev.venue && <div className="muted small">{ev.venue}</div>}
                    {ev.startAt && (
                      <div className="muted small">
                        {new Date(ev.startAt).toLocaleString('vi-VN')}
                      </div>
                    )}
                  </div>
                </label>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}