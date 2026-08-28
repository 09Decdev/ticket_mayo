import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ticketClient } from '../api/ticket.client';
import type { DistributionJob } from '../api/types';
import { Card } from '../components/Card';
import { Spinner } from '../components/Spinner';
import { IconList, IconSend } from '../components/icons';
import { formatDateTime } from '../common/format';

const JOB_STATUS: Record<string, { cls: string; label: string }> = {
  COMPLETED: { cls: 'badge badge-valid', label: 'Hoàn tất' },
  FAILED: { cls: 'badge badge-cancelled', label: 'Thất bại' },
  PARTIALLY_MINTED: { cls: 'badge badge-used', label: 'Tạo vé một phần' },
  PENDING: { cls: 'badge badge-progress', label: 'Đang chờ' },
  RUNNING: { cls: 'badge badge-minting', label: 'Đang chạy' },
};

function jobBadge(s: string) {
  const st = JOB_STATUS[s] ?? { cls: 'badge badge-progress', label: s };
  return <span className={st.cls}>{st.label}</span>;
}

function MintChip({ mode }: { mode?: DistributionJob['mintMode'] }) {
  if (!mode) return null;
  return <span className="tag" title="Chế độ mint khi phát vé">{mode}</span>;
}

export function DistributionsListPage() {
  const navigate = useNavigate();
  const [jobs, setJobs] = useState<DistributionJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await ticketClient.listDistributions({ page: 1, limit: 50 });
        setJobs(res.data);
      } catch (e: any) {
        setError(e?.message || 'Không tải được danh sách.');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <div>
      <h1 className="page-title">Lịch phát vé</h1>
      <p className="page-sub">Theo dõi các đợt phát vé theo email. Bấm vào một dòng để xem chi tiết.</p>
      {error && <div className="error-box">{error}</div>}
      <Card>
        {loading ? (
          <Spinner />
        ) : jobs.length === 0 ? (
          <div className="empty">
            <div className="empty-icon">
              <IconList width={24} height={24} />
            </div>
            <div className="empty-title">Chưa phát vé nào</div>
            <div>Đợt phát đầu tiên sẽ xuất hiện ở đây.</div>
            <div className="empty-actions">
              <Link to="/admin/distribute" className="btn">
                <IconSend width={15} height={15} />
                Phát vé mới
              </Link>
            </div>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Thời gian</th>
                  <th>Sự kiện</th>
                  <th>Loại vé</th>
                  <th>Tiến độ</th>
                  <th>Trạng thái</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => {
                  const pct = j.total > 0 ? Math.round((j.sent / j.total) * 100) : 0;
                  return (
                    <tr
                      key={j.id}
                      style={{ cursor: 'pointer' }}
                      onClick={() => navigate(`/admin/distributions/${encodeURIComponent(j.id)}`)}
                    >
                      <td className="muted" style={{ fontSize: 12.5, whiteSpace: 'nowrap' }}>
                        {formatDateTime(j.createdAt)}
                      </td>
                      <td>
                        {j.eventName}
                        <div className="faint small">{j.ticketTypeName}</div>
                      </td>
                      <td>
                        <div className="row" style={{ gap: 6 }}>
                          {j.ticketTypeName}
                          <MintChip mode={j.mintMode} />
                        </div>
                      </td>
                      <td style={{ minWidth: 140 }}>
                        <div className="progress-label">
                          <span>{j.sent}/{j.total}</span>
                          <span>{pct}%</span>
                        </div>
                        <div className="progress progress-ok">
                          <span style={{ width: `${pct}%` }} />
                        </div>
                        {j.failed > 0 && (
                          <div className="muted small" style={{ marginTop: 3, color: 'var(--danger)' }}>
                            {j.failed} email lỗi
                          </div>
                        )}
                      </td>
                      <td>{jobBadge(j.status)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}