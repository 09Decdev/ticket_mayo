import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ticketClient } from '../api/ticket.client';
import type { Event } from '../api/types';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { Spinner } from '../components/Spinner';

/** datetime-local value (local time, no Z) → ISO UTC cho API. */
function toIsoOrNull(v: string): string | undefined {
  return v ? new Date(v).toISOString() : undefined;
}

/** ISO (UTC) → datetime-local value để điền input (giữ local timezone). */
function isoToLocalInput(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Edit event (name/venue/thời gian/maxParticipants) — admin edit screen,
 * theo pattern EditTicketTypePage (EVENT-EDIT).
 * - maxParticipants bị ràng buộc >= số người đã đăng ký: server (content)
 *   validate lại ở service layer (không tin client) — 400
 *   EVENT_MAX_PARTICIPANTS_BELOW_REGISTERED kèm registeredCount. UI chỉ biết
 *   min chắc chắn khi nhận lỗi 400 (server re-read), trước đó disable theo
 *   validate client cơ bản (int >= 0, end > start).
 * - endTime <= startTime → 400 EVENT_TIME_INVALID.
 */
export function EditEventPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [initial, setInitial] = useState<Event | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [venue, setVenue] = useState('');
  const [startAt, setStartAt] = useState('');
  const [endAt, setEndAt] = useState('');
  const [maxParticipants, setMaxParticipants] = useState('');
  const [minCapacity, setMinCapacity] = useState(0);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    (async () => {
      try {
        const ev = await ticketClient.getEventForEdit(id);
        setInitial(ev);
        setName(ev.name ?? '');
        setVenue(ev.venue ?? '');
        setStartAt(isoToLocalInput(ev.startAt));
        setEndAt(isoToLocalInput(ev.endAt));
        setMaxParticipants(
          ev.maxParticipants == null ? '' : String(ev.maxParticipants),
        );
      } catch (e: any) {
        setError(e?.message || 'Không tải được sự kiện.');
      } finally {
        setLoading(false);
      }
    })();
  }, [id]);

  const parsedCapacity = Number(maxParticipants);
  const capacityInvalid = useMemo(
    () =>
      maxParticipants !== '' &&
      (!Number.isInteger(parsedCapacity) || parsedCapacity < minCapacity),
    [maxParticipants, parsedCapacity, minCapacity],
  );
  const nameInvalid = name.trim() === '';
  // Thời gian: nếu nhập cả 2 thì end phải sau start (client check; server
  // validate lại — merge partial với DB hiện tại).
  const timeInvalid = useMemo(() => {
    if (!startAt || !endAt) return false;
    return new Date(endAt).getTime() <= new Date(startAt).getTime();
  }, [startAt, endAt]);

  const formInvalid =
    nameInvalid ||
    capacityInvalid ||
    timeInvalid ||
    !id ||
    !initial ||
    (maxParticipants === '' && initial.maxParticipants != null);

  async function onSave(e: FormEvent) {
    e.preventDefault();
    if (!id || formInvalid) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const updated = await ticketClient.updateEvent(id, {
        name: name.trim(),
        venue: venue.trim() || undefined,
        startAt: toIsoOrNull(startAt),
        endAt: toIsoOrNull(endAt),
        maxParticipants: maxParticipants === '' ? undefined : parsedCapacity,
      });
      setInitial(updated);
      setMaxParticipants(
        updated.maxParticipants == null ? '' : String(updated.maxParticipants),
      );
      setNotice('Đã lưu thay đổi.');
    } catch (e: any) {
      // 400 EVENT_MAX_PARTICIPANTS_BELOW_REGISTERED: kèm registeredCount —
      // hiển thị rõ số người đã đăng ký làm min sức chứa.
      if (e?.code === 'EVENT_MAX_PARTICIPANTS_BELOW_REGISTERED') {
        const rc = typeof e.registeredCount === 'number' ? e.registeredCount : undefined;
        if (typeof rc === 'number') setMinCapacity(rc);
        setError(
          `Không thể đặt sức chứa thấp hơn số người đã đăng ký` +
            (rc != null ? ` (${rc} người)` : '') +
            `. ${e?.message ?? ''}`,
        );
      } else if (e?.code === 'EVENT_TIME_INVALID') {
        setError(
          `Thời gian không hợp lệ: giờ kết thúc phải sau giờ bắt đầu. ${e?.message ?? ''}`,
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
        <h1 className="page-title">Sửa sự kiện</h1>
        <Spinner />
      </div>
    );
  }

  return (
    <div>
      <h1 className="page-title">Sửa sự kiện</h1>
      <p className="page-sub">
        Sửa tên, địa điểm, thời gian và sức chứa. Sức chứa không được thấp hơn
        số người đã đăng ký — server kiểm tra lại và trả số hiện tại khi từ chối.
      </p>

      {error && <div className="error-box">{error}</div>}
      {notice && <div className="hint">{notice}</div>}

      {initial ? (
        <Card title={`Sự kiện: ${initial.name || '(chưa có tên)'}`}>
          <form onSubmit={onSave}>
            <div className="form-field">
              <label htmlFor="eev-name">Tên sự kiện</label>
              <input
                id="eev-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
              {nameInvalid && <div className="hint">Tên sự kiện không được để trống.</div>}
            </div>

            <div className="form-field">
              <label htmlFor="eev-venue">Địa điểm</label>
              <input
                id="eev-venue"
                value={venue}
                onChange={(e) => setVenue(e.target.value)}
              />
            </div>

            <div className="row">
              <div className="form-field" style={{ flex: 1 }}>
                <label htmlFor="eev-start">Bắt đầu</label>
                <input
                  id="eev-start"
                  type="datetime-local"
                  value={startAt}
                  onChange={(e) => setStartAt(e.target.value)}
                />
              </div>
              <div className="form-field" style={{ flex: 1 }}>
                <label htmlFor="eev-end">Kết thúc</label>
                <input
                  id="eev-end"
                  type="datetime-local"
                  value={endAt}
                  onChange={(e) => setEndAt(e.target.value)}
                />
              </div>
            </div>
            {timeInvalid && (
              <div className="error-box" style={{ marginTop: 8 }}>
                Giờ kết thúc phải sau giờ bắt đầu.
              </div>
            )}

            <div className="form-field">
              <label htmlFor="eev-capacity">Sức chứa (maxParticipants)</label>
              <input
                id="eev-capacity"
                type="number"
                min={minCapacity}
                step="1"
                value={maxParticipants}
                onChange={(e) => setMaxParticipants(e.target.value)}
              />
              <div className="hint">
                {minCapacity > 0
                  ? `Tối thiểu ${minCapacity} (số người đã đăng ký) — giảm xuống thấp hơn sẽ bị server từ chối kèm số đăng ký hiện tại.`
                  : 'Để trống nếu sự kiện không giới hạn sức chứa. Server kiểm tra giá trị này không được thấp hơn số người đã đăng ký.'}
              </div>
              {capacityInvalid && (
                <div className="error-box" style={{ marginTop: 8 }}>
                  Sức chứa không hợp lệ: phải là số nguyên &ge; {minCapacity}.
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
                onClick={() => navigate('/admin/events')}
              >
                Quay lại
              </Button>
            </div>
          </form>
        </Card>
      ) : (
        <Card title="Không tìm thấy sự kiện">
          <div className="empty">Không tải được sự kiện này.</div>
        </Card>
      )}
    </div>
  );
}
