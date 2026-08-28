import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ticketClient } from '../api/ticket.client';
import type { DistributionStatusResp, PreTicketView } from '../api/types';
import { Card } from '../components/Card';
import { Spinner } from '../components/Spinner';
import { StatCard } from '../components/StatCard';
import { IconAlert, IconMail, IconTicket, IconUsers, IconZap } from '../components/icons';
import { formatDateTime, formatApiError, shortHash } from '../common/format';

const JOB_STATUS: Record<string, { cls: string; label: string }> = {
  COMPLETED: { cls: 'badge badge-valid', label: 'Hoàn tất' },
  FAILED: { cls: 'badge badge-cancelled', label: 'Thất bại' },
  PARTIALLY_MINTED: { cls: 'badge badge-used', label: 'Tạo vé một phần' },
  PENDING: { cls: 'badge badge-progress', label: 'Đang chờ' },
  RUNNING: { cls: 'badge badge-minting', label: 'Đang chạy' },
};

// Workflow: xác định bước đang chạy — có PreTicket MINTING → đang tạo vé.
function runningSubLabel(preTickets: PreTicketView[]): string {
  if (preTickets.some((p) => p.status === 'MINTING' || p.status === 'CLAIMING')) {
    return 'Đang tạo vé';
  }
  return 'Đang gửi email';
}

const PRETICKET_STATUS: Record<string, { cls: string; label: string }> = {
  PENDING: { cls: 'badge badge-progress', label: 'Chờ tạo vé' },
  MINTING: { cls: 'badge badge-minting', label: 'Đang tạo vé' },
  MINTED: { cls: 'badge badge-valid', label: 'Đã tạo vé' },
  LINKED: { cls: 'badge badge-linked', label: 'Đã gắn tài khoản' },
  CLAIMING: { cls: 'badge badge-progress', label: 'Đang nhận' },
  CLAIMED: { cls: 'badge badge-valid', label: 'Đã nhận' },
  EXPIRED: { cls: 'badge badge-expired', label: 'Hết lượt' },
};

function jobBadge(s: string) {
  const st = JOB_STATUS[s] ?? { cls: 'badge badge-progress', label: s };
  return <span className={st.cls}>{st.label}</span>;
}

function preTicketBadge(s: string) {
  const st = PRETICKET_STATUS[s] ?? { cls: 'badge badge-progress', label: s };
  return <span className={st.cls}>{st.label}</span>;
}

export function DistributionDetailPage() {
  const { jobId } = useParams();
  const [data, setData] = useState<DistributionStatusResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showFailed, setShowFailed] = useState(false);

  useEffect(() => {
    if (!jobId) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const res = await ticketClient.getDistributionStatus(jobId, true);
        if (!active) return;
        setData(res);
        setLoading(false);
        if (res.job.status === 'PENDING' || res.job.status === 'RUNNING') {
          timer = setTimeout(poll, 2500);
        }
      } catch (e: any) {
        if (!active) return;
        setError(formatApiError(e));
        setLoading(false);
      }
    };
    poll();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [jobId]);

  if (loading) return <Spinner large />;
  if (error) return <div className="error-box">{error}</div>;
  if (!data) return <div className="empty">Không có dữ liệu.</div>;

  const job = data.job;
  const mint = data.mint;
  const pct = job.total > 0 ? Math.min(100, Math.round((job.sent / job.total) * 100)) : 0;
  const preTickets = data.preTickets ?? [];
  const claimed = preTickets.filter((p) => p.status === 'CLAIMED').length;
  const pending = preTickets.filter((p) => p.status === 'PENDING').length;
  const failedPreTickets = preTickets.filter((p) => !!p.lastMintError);
  const canToggleFailed = preTickets.length > 0 && failedPreTickets.length > 0;
  const visiblePreTickets = showFailed ? failedPreTickets : preTickets;

  const mintPct =
    mint && job.total > 0 ? Math.min(100, Math.round((mint.minted / job.total) * 100)) : null;
  const isRunning = job.status === 'PENDING' || job.status === 'RUNNING';
  const sub = isRunning ? runningSubLabel(preTickets) : '';

  return (
    <div>
      <div className="layout-header">
        <h1 className="page-title" style={{ margin: 0 }}>
          Phát vé: {job.eventName} — {job.ticketTypeName}
        </h1>
        <Link to="/admin/distributions" className="btn btn-secondary">
          Danh sách
        </Link>
      </div>

      <Card>
        <div className="row" style={{ marginBottom: 10 }}>
          {jobBadge(job.status)}
          {sub && <span className="tag">{sub}</span>}
          {job.mintMode && (
            <span className={`tag`} title="Chế độ mint khi phát vé">
              <IconZap width={12} height={12} style={{ verticalAlign: -1, marginRight: 3 }} />
              {job.mintMode}
            </span>
          )}
          <span className="muted">Tạo: {formatDateTime(job.createdAt)}</span>
        </div>

        <div className="progress-label">
          <span>Gửi email</span>
          <span>{job.sent}/{job.total} · {pct}%</span>
        </div>
        <div className="progress" style={{ marginBottom: 12 }}>
          <span style={{ width: `${pct}%` }} />
        </div>
        <div className="muted small">
          Gửi {job.sent}/{job.total} · Claimed {claimed} · Pending {pending} · Failed {job.failed}
        </div>
      </Card>

      {mint && (
        <Card title="Kết quả mint vé (EAGER)">
          <div className="stat-grid">
            <StatCard
              label="Đã mint"
              value={mint.minted}
              icon={<IconTicket width={17} height={17} />}
              accent="blue"
              sub={`${mintPct ?? 0}% của tổng ${job.total}`}
            />
            <StatCard
              label="Mint có tài khoản"
              value={mint.mintedWithUser}
              icon={<IconUsers width={17} height={17} />}
              accent="green"
              sub="Vé đã gắn người nhận"
            />
            <StatCard
              label="Mint email-only"
              value={mint.mintedEmailOnly}
              icon={<IconMail width={17} height={17} />}
              accent="violet"
              sub="Chờ người nhận tạo tài khoản"
            />
            <StatCard
              label="Mint thất bại"
              value={mint.mintFailed}
              icon={<IconAlert width={17} height={17} />}
              accent="red"
              sub={mint.mintFailed > 0 ? 'Cần xử lý' : 'Không có lỗi'}
            />
          </div>
          {mintPct != null && (
            <div style={{ marginTop: 10 }}>
              <div className="progress-label">
                <span>Tiến độ tạo vé</span>
                <span>{mint.minted}/{job.total} · {mintPct}%</span>
              </div>
              <div className={`progress ${mint.mintFailed > 0 ? 'progress-amber' : 'progress-ok'}`}>
                <span style={{ width: `${mintPct}%` }} />
              </div>
            </div>
          )}
          {mint.mintFailed > 0 && (
            <div className="warn-box" style={{ marginBottom: 0, marginTop: 12 }}>
              Có {mint.mintFailed} vé mint thất bại — bật lọc &ldquo;Chỉ xem vé lỗi&rdquo; trong bảng bên
              dưới để xem lý do từng vé.
            </div>
          )}
        </Card>
      )}

      <Card title="Chi tiết PreTicket">
        {canToggleFailed && (
          <div className="row" style={{ marginBottom: 12 }}>
            <button
              type="button"
              className={showFailed ? 'btn btn-secondary' : 'btn'}
              onClick={() => setShowFailed((v) => !v)}
            >
              {showFailed ? 'Xem tất cả' : `Chỉ xem ${failedPreTickets.length} vé lỗi`}
            </button>
            {showFailed && (
              <span className="muted" style={{ fontSize: 12 }}>
                Chỉ hiển thị emailHash rút gọn — không có email gốc.
              </span>
            )}
          </div>
        )}
        {preTickets.length === 0 ? (
          <div className="empty">Không có PreTicket.</div>
        ) : visiblePreTickets.length === 0 ? (
          <div className="empty">Không có PreTicket lỗi.</div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Mã claim</th>
                  <th>Trạng thái</th>
                  <th>Đã tạo vé</th>
                  <th>EmailHash</th>
                  <th>Lý do mint lỗi</th>
                  <th>Claim lúc</th>
                </tr>
              </thead>
              <tbody>
                {visiblePreTickets.map((p: PreTicketView) => (
                  <tr key={p.id}>
                    <td className="mono">{p.claimToken.slice(0, 16)}…</td>
                    <td>{preTicketBadge(p.status)}</td>
                    <td>{p.ticketId || p.contentTicketCode ? '✓' : '—'}</td>
                    <td className="mono" title="emailHash rút gọn">{shortHash(p.recipientEmailHash)}</td>
                    <td>
                      {p.lastMintError ? (
                        <span className="mono" style={{ color: 'var(--danger)', fontSize: 12 }}>
                          {p.lastMintError}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>{formatDateTime(p.claimedAt)}</td>
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