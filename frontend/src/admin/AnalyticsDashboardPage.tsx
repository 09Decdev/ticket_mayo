import { useEffect, useState, type CSSProperties } from 'react';
import { ticketClient } from '../api/ticket.client';
import type { OverviewStats } from '../api/types';
import { Card } from '../components/Card';
import { Spinner } from '../components/Spinner';
import { StatCard } from '../components/StatCard';
import {
  IconAlert,
  IconCheckIn,
  IconMail,
  IconSend,
  IconTicket,
  IconUsers,
} from '../components/icons';

export function AnalyticsDashboardPage() {
  const [stats, setStats] = useState<OverviewStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        setStats(await ticketClient.getOverviewStats());
      } catch (e: any) {
        setError(e?.message || 'Không tải được thống kê.');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <Spinner large />;
  if (error) return <div className="error-box">{error}</div>;
  if (!stats) return <div className="empty">Không có dữ liệu.</div>;

  const rate = stats.totalTickets > 0 ? Math.round((stats.checkedIn / stats.totalTickets) * 100) : 0;
  const notChecked = Math.max(0, stats.totalTickets - stats.checkedIn);
  const claimRate =
    stats.totalPreTickets > 0
      ? Math.round((stats.claimed / stats.totalPreTickets) * 100)
      : 0;
  const unclaimed = Math.max(0, stats.totalPreTickets - stats.claimed - stats.pending);

  return (
    <div>
      <h1 className="page-title">Thống kê tổng quan</h1>
      <p className="page-sub">Tổng hợp toàn bộ đợt phát vé và lượt check-in.</p>

      <Card title="Phát vé">
        <div className="stat-grid">
          <StatCard
            label="Lần phát vé"
            value={stats.totalDistributions}
            icon={<IconSend width={17} height={17} />}
            accent="violet"
            sub="Tổng số đợt phát"
          />
          <StatCard
            label="Tổng PreTicket"
            value={stats.totalPreTickets}
            icon={<IconTicket width={17} height={17} />}
            accent="blue"
            sub="Vé cấp cho người nhận"
          />
          <StatCard
            label="Đã gửi mail"
            value={stats.sent}
            icon={<IconMail width={17} height={17} />}
            accent="green"
            sub="Email đã gửi thành công"
          />
          <StatCard
            label="Gửi thất bại"
            value={stats.failed}
            icon={<IconAlert width={17} height={17} />}
            accent="red"
            sub={stats.failed > 0 ? 'Kiểm tra chi tiết đợt phát' : 'Không có lỗi'}
          />
        </div>

        <div className="chart-grid" style={{ marginTop: 8 }}>
          <div>
            <h3>Tình trạng nhận vé</h3>
            <div className="row" style={{ gap: 20, alignItems: 'center' }}>
              <div
                className="donut"
                style={{ '--p': claimRate, '--c1': '#4f46e5' } as CSSProperties}
              >
                <div className="donut-inner">
                  <div className="donut-val">{claimRate}%</div>
                  <div className="donut-cap">đã nhận</div>
                </div>
              </div>
              <div className="chart-legend">
                <div className="legend-item">
                  <span className="legend-dot" style={{ background: '#4f46e5' }} />
                  <span className="legend-label">Đã claim</span>
                  <span className="legend-count">{stats.claimed}</span>
                </div>
                <div className="legend-item">
                  <span className="legend-dot" style={{ background: '#bfdbfe' }} />
                  <span className="legend-label">Chưa claim</span>
                  <span className="legend-count">{stats.pending}</span>
                </div>
                <div className="legend-item">
                  <span className="legend-dot" style={{ background: '#e5e9f0' }} />
                  <span className="legend-label">Còn lại</span>
                  <span className="legend-count">{unclaimed}</span>
                </div>
              </div>
            </div>
          </div>

          <div>
            <h3>Hiệu quả gửi mail</h3>
            <div className="stack-bar" style={{ margin: '10px 0 6px' }}>
              <span style={{ width: `${stats.totalPreTickets > 0 ? (stats.sent / stats.totalPreTickets) * 100 : 0}%`, background: '#10b981' }} />
              <span style={{ width: `${stats.totalPreTickets > 0 ? (stats.failed / stats.totalPreTickets) * 100 : 0}%`, background: '#f87171' }} />
            </div>
            <div className="chart-legend">
              <div className="legend-item">
                <span className="legend-dot" style={{ background: '#10b981' }} />
                <span className="legend-label">Đã gửi</span>
                <span className="legend-count">{stats.sent}</span>
              </div>
              <div className="legend-item">
                <span className="legend-dot" style={{ background: '#f87171' }} />
                <span className="legend-label">Thất bại</span>
                <span className="legend-count">{stats.failed}</span>
              </div>
            </div>
          </div>
        </div>
      </Card>

      <Card title="Check-in / Attendance">
        <div className="stat-grid">
          <StatCard
            label="Tổng vé"
            value={stats.totalTickets}
            icon={<IconTicket width={17} height={17} />}
            accent="blue"
            sub="Vé đã mint"
          />
          <StatCard
            label="Đã check-in"
            value={stats.checkedIn}
            icon={<IconCheckIn width={17} height={17} />}
            accent="green"
            sub={notChecked > 0 ? `Còn ${notChecked} vé chưa vào` : 'Toàn bộ đã vào sự kiện'}
          />
          <StatCard
            label="Tỉ lệ đi"
            value={rate}
            unit="%"
            icon={<IconUsers width={17} height={17} />}
            accent="violet"
            sub={`${stats.checkedIn} / ${stats.totalTickets} vé đã check-in`}
          />
        </div>

        <div className="chart-grid" style={{ marginTop: 8 }}>
          <div>
            <h3>Tỉ lệ check-in theo tổng vé</h3>
            <div className="row" style={{ gap: 20, alignItems: 'center' }}>
              <div
                className="donut"
                style={
                  {
                    '--p': rate,
                    '--c1': rate >= 65 ? '#059669' : rate >= 30 ? '#b45309' : '#dc2626',
                  } as CSSProperties
                }
              >
                <div className="donut-inner">
                  <div className="donut-val">{rate}%</div>
                  <div className="donut-cap">check-in</div>
                </div>
              </div>
              <div className="chart-legend">
                <div className="legend-item">
                  <span className="legend-dot" style={{ background: '#059669' }} />
                  <span className="legend-label">Đã check-in</span>
                  <span className="legend-count">{stats.checkedIn}</span>
                </div>
                <div className="legend-item">
                  <span className="legend-dot" style={{ background: '#e5e9f0' }} />
                  <span className="legend-label">Chưa check-in</span>
                  <span className="legend-count">{notChecked}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}