import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ticketClient } from '../api/ticket.client';
import { clearAuth } from '../api/storage';
import type { TicketView } from '../api/types';
import { StatusBadge } from '../components/Badge';
import { Spinner } from '../components/Spinner';
import { IconCheck, IconQr, IconTicket } from '../components/icons';
import { shortCode } from '../common/format';

export function MyTicketsPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const [tickets, setTickets] = useState<TicketView[]>([]);
  const [claimedInfo, setClaimedInfo] = useState<number>(
    () => (location.state as { claimedTickets?: number } | null)?.claimedTickets ?? 0,
  );
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setRefreshing(true);
    setError(null);
    try {
      const res = await ticketClient.getMyTickets();
      setTickets(res.tickets || []);
      const newly = Number(res.claimedTickets) || 0;
      if (newly > 0) setClaimedInfo((v) => v + newly);
    } catch (e: any) {
      setError(e?.message || 'Không tải được vé.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  if (loading) return <Spinner large />;

  return (
    <div>
      <div className="portal-header">
        <div className="brand">
          <IconTicket width={20} height={20} />
          <strong>ticket-mayo</strong>
        </div>
        <Link
          to="/portal/login"
          className="btn btn-secondary"
          onClick={() => {
            clearAuth();
            navigate('/portal/login', { replace: true });
          }}
        >
          Đăng xuất
        </Link>
      </div>
      <div className="portal-body">
        <h1 className="page-title">Vé của tôi</h1>
        {error && <div className="error-box">{error}</div>}
        {claimedInfo > 0 && (
          <div className="ok-box">
            <IconCheck width={16} height={16} style={{ marginTop: 2, flexShrink: 0 }} />
            <span>
              Đã tự động gắn <strong>{claimedInfo}</strong> vé vào tài khoản của bạn.
            </span>
          </div>
        )}
        {tickets.length === 0 ? (
          <div className="empty">
            <div className="empty-icon">
              <IconQr width={24} height={24} />
            </div>
            <div className="empty-title">Bạn chưa có vé</div>
            <div>
              Nếu đã nhận email mời, hãy{' '}
              <Link to="/portal/signup">tạo tài khoản</Link> với đúng email đó. Vé có thể đang
              được đồng bộ — bấm Làm mới trong giây lát.
            </div>
            <div className="empty-actions">
              <button type="button" className="btn btn-secondary" onClick={() => void load()}>
                {refreshing ? 'Đang tải…' : 'Làm mới'}
              </button>
            </div>
          </div>
        ) : (
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Mã vé</th>
                    <th>Sự kiện</th>
                    <th>Loại vé</th>
                    <th>Trạng thái</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {tickets.map((t) => (
                    <tr key={t.id}>
                      <td className="mono">{shortCode(t.ticketCode)}</td>
                      <td>{t.event.name}</td>
                      <td>{t.ticketType.name}</td>
                      <td>
                        <StatusBadge status={t.status} />
                      </td>
                      <td>
                        <Link
                          to={`/portal/tickets/${encodeURIComponent(t.id)}`}
                          className="btn btn-link"
                          style={{ padding: '4px 10px' }}
                        >
                          Xem QR
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {refreshing && (
              <div style={{ display: 'flex', justifyContent: 'center', padding: 8 }}>
                <Spinner />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}