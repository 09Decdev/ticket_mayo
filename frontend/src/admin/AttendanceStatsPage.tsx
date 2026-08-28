import { useEffect, useState } from 'react';
import { ticketClient } from '../api/ticket.client';
import type { AttendanceStats, Event } from '../api/types';
import { Card } from '../components/Card';
import { Spinner } from '../components/Spinner';
import { StatCard } from '../components/StatCard';
import { IconCheckIn, IconTicket, IconUsers } from '../components/icons';

export function AttendanceStatsPage() {
  const [events, setEvents] = useState<Event[]>([]);
  const [eventId, setEventId] = useState('');
  const [stats, setStats] = useState<AttendanceStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    (async () => {
      try {
        setStats(await ticketClient.getAttendanceStats({ eventId }));
      } catch (e: any) {
        setError(e?.message || 'Không tải được attendance.');
      } finally {
        setLoading(false);
      }
    })();
  }, [eventId]);

  const rate = stats && stats.totalTickets > 0 ? Math.round((stats.checkedIn / stats.totalTickets) * 100) : 0;
  const maxGate = stats?.byGate?.length ? Math.max(...stats.byGate.map((g) => g.count), 1) : 1;

  return (
    <div>
      <h1 className="page-title">Attendance theo sự kiện</h1>
      <p className="page-sub">Tổng hợp lượt check-in và phân bổ theo gate.</p>
      {error && <div className="error-box">{error}</div>}

      <Card title="Chọn sự kiện">
        <div className="form-field" style={{ marginBottom: 0, maxWidth: 420 }}>
          <label htmlFor="att-event">Sự kiện</label>
          <select id="att-event" value={eventId} onChange={(e) => setEventId(e.target.value)}>
            {events.length === 0 && <option value="">(chưa có sự kiện)</option>}
            {events.map((ev) => (
              <option key={ev.id} value={ev.id}>
                {ev.name}
              </option>
            ))}
          </select>
        </div>
      </Card>

      {loading ? (
        <Spinner />
      ) : stats ? (
        <>
          <Card title={stats.eventName || 'Attendance'}>
            <div className="stat-grid">
              <StatCard
                label="Tổng vé"
                value={stats.totalTickets}
                icon={<IconTicket width={17} height={17} />}
                accent="blue"
                sub="Vé phát cho sự kiện"
              />
              <StatCard
                label="Đã check-in"
                value={stats.checkedIn}
                icon={<IconCheckIn width={17} height={17} />}
                accent="green"
                sub={stats.byGate.length > 0 ? `${stats.byGate.length} gate hoạt động` : 'Chưa có gate nào'}
              />
              <StatCard
                label="Tỉ lệ đi"
                value={rate}
                unit="%"
                icon={<IconUsers width={17} height={17} />}
                accent="violet"
                sub={`${stats.checkedIn} / ${stats.totalTickets} vé`}
              />
            </div>

            {stats.byGate && stats.byGate.length > 0 && (
              <div style={{ marginTop: 18 }}>
                <h3>Check-in theo gate</h3>
                <div className="bar-chart">
                  {stats.byGate.map((g, i) => {
                    const h = Math.max(6, Math.round((g.count / maxGate) * 84));
                    return (
                      <div className="bar-col" key={g.gateId || `gate-${i}`} title={`${g.gateId || '(no gate)'}: ${g.count}`}>
                        <div className="bar-count">{g.count}</div>
                        <div className="bar-fill" style={{ height: h }} />
                        <div className="bar-label">{g.gateId || '(no gate)'}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </Card>
        </>
      ) : null}
    </div>
  );
}