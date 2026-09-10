import { useEffect, useState } from 'react';
import { ticketClient } from '../api/ticket.client';
import { Spinner } from '../components/Spinner';
import { IconTicket } from '../components/icons';
import { formatDateTime, formatApiError } from '../common/format';

interface Props {
  jobId: string;
  claimToken: string;
  onClose: () => void;
}

interface SentEmailData {
  sentAt: string | null;
  text: string;
  html: string;
  attachments?: { ticketId: string; filename: string }[];
}

/**
 * Xem lại NỘI DUNG EMAIL ĐÃ THỰC GỬI cho 1 vé (bản render final lưu ở bảng
 * SentEmail). HTML hiển thị trong iframe sandbox (không script) — đúng những
 * gì người nhận thấy; có tab xem bản plain-text + tải lại từng PDF vé đính
 * kèm (đọc từ bucket email/, chỉ đúng ticket có trong email đó).
 */
export function SentEmailModal({ jobId, claimToken, onClose }: Props) {
  const [data, setData] = useState<SentEmailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'html' | 'text'>('html');
  const [downloading, setDownloading] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    ticketClient
      .getSentEmail(jobId, claimToken)
      .then((d: SentEmailData) => {
        if (active) setData(d);
      })
      .catch((e) => {
        if (active) setError(formatApiError(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [jobId, claimToken]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function onDownloadPdf(ticketId: string, filename: string) {
    setDownloading(ticketId);
    setDownloadError(null);
    try {
      const blob = await ticketClient.downloadSentEmailPdf(jobId, claimToken, ticketId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setDownloadError(formatApiError(e));
    } finally {
      setDownloading(null);
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#fff',
          borderRadius: 10,
          width: 'min(860px, 100%)',
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div
          className="row"
          style={{
            padding: '12px 16px',
            borderBottom: '1px solid #e5e5e5',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 8,
            flexWrap: 'wrap',
          }}
        >
          <div>
            <strong>Email đã gửi</strong>
            <div className="muted small" style={{ fontWeight: 400 }}>
              Mã claim: <span className="mono">{claimToken.slice(0, 16)}…</span>
              {data?.sentAt ? ` · Gửi lúc ${formatDateTime(data.sentAt)}` : ''}
            </div>
          </div>
          <div className="row" style={{ gap: 8 }}>
            {data && (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setMode((m) => (m === 'html' ? 'text' : 'html'))}
              >
                {mode === 'html' ? 'Xem bản text' : 'Xem bản HTML'}
              </button>
            )}
            <button type="button" className="btn" onClick={onClose}>
              Đóng
            </button>
          </div>
        </div>
        {data && data.attachments && data.attachments.length > 0 && (
          <div
            className="row"
            style={{
              padding: '8px 16px',
              borderBottom: '1px solid #e5e5e5',
              gap: 8,
              flexWrap: 'wrap',
              alignItems: 'center',
              background: '#fafafa',
            }}
          >
            <span className="muted small">PDF đính kèm:</span>
            {data.attachments.map((a) => (
              <button
                key={a.ticketId}
                type="button"
                className="btn btn-secondary"
                style={{ padding: '2px 10px', fontSize: 12 }}
                disabled={downloading === a.ticketId}
                onClick={() => onDownloadPdf(a.ticketId, a.filename)}
              >
                <IconTicket width={12} height={12} style={{ verticalAlign: -1, marginRight: 4 }} />
                {downloading === a.ticketId ? 'Đang tải…' : a.filename}
              </button>
            ))}
            {downloadError && <span className="text-danger small">{downloadError}</span>}
          </div>
        )}
        <div style={{ padding: 16, overflow: 'auto', flex: 1 }}>
          {loading ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: 32 }}>
              <Spinner />
            </div>
          ) : error ? (
            <div className="error-box">{error}</div>
          ) : data && mode === 'html' ? (
            <iframe
              title="email-preview"
              sandbox=""
              srcDoc={data.html}
              style={{ width: '100%', height: '68vh', border: '1px solid #e5e5e5', borderRadius: 8 }}
            />
          ) : data ? (
            <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 13 }}>
              {data.text}
            </pre>
          ) : null}
        </div>
      </div>
    </div>
  );
}
