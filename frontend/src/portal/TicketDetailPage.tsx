import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { QRCodeCanvas } from 'qrcode.react';
import { ticketClient } from '../api/ticket.client';
import type { TicketView } from '../api/types';
import { StatusBadge } from '../components/Badge';
import { Spinner } from '../components/Spinner';
import { IconArrowLeft, IconCopy, IconDownload, IconTicket } from '../components/icons';
import { copyText, formatDateTime } from '../common/format';
import { downloadTicketPdf } from '../common/ticketPdf';

export function TicketDetailPage() {
  const { id } = useParams();
  const [ticket, setTicket] = useState<TicketView | null>(null);
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const qrBoxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!id) return;
    (async () => {
      try {
        setTicket(await ticketClient.getTicket(id));
      } catch (e: any) {
        setError(e?.message || 'Không tải được vé.');
      } finally {
        setLoading(false);
      }
    })();
  }, [id]);

  const handleDownloadPdf = async () => {
    if (!ticket || pdfBusy) return;
    setPdfBusy(true);
    setError(null);
    try {
      let bannerBlob: Blob | null = null;
      if (ticket.bannerUrl) {
        try {
          bannerBlob = await ticketClient.getTicketImage(ticket.id);
        } catch {
          bannerBlob = null; // không có ảnh → PDF dùng gradient, vẫn tải được
        }
      }
      await downloadTicketPdf({
        ticket,
        qrCanvas: qrBoxRef.current?.querySelector('canvas') ?? null,
        bannerBlob,
      });
    } catch (e: any) {
      setError(e?.message || 'Không tạo được file PDF. Vui lòng thử lại.');
    } finally {
      setPdfBusy(false);
    }
  };

  if (loading) return <Spinner large />;

  return (
    <div>
      <div className="portal-header">
        <div className="brand">
          <IconTicket width={20} height={20} />
          <strong>ticket-mayo</strong>
        </div>
        <Link to="/portal/tickets" className="btn btn-secondary">
          <IconArrowLeft width={15} height={15} />
          Vé của tôi
        </Link>
      </div>
      <div className="portal-body">
        {error && <div className="error-box">{error}</div>}
        {!ticket ? (
          !error && <div className="empty">Không tìm thấy vé.</div>
        ) : (
          <>
            <h1 className="page-title">{ticket.event.name}</h1>
            <div className="ticket-card">
              <div className="ticket-card-head">
                <div style={{ minWidth: 0 }}>
                  <div className="muted small" style={{ marginBottom: 2 }}>
                    Vé · {ticket.ticketType.name}
                  </div>
                  <h2>{ticket.event.name}</h2>
                  <div style={{ marginTop: 8 }}>
                    <StatusBadge status={ticket.status} />
                  </div>
                </div>
                <div className="ticket-code">
                  <span className="mono">{ticket.ticketCode}</span>
                  <button
                    type="button"
                    className="btn-link"
                    style={{ border: 'none', background: 'none', cursor: 'pointer', display: 'inline-flex' }}
                    aria-label="Sao chép mã vé"
                    onClick={async () => {
                      const ok = await copyText(ticket.ticketCode);
                      if (ok) {
                        setCopied(true);
                        setTimeout(() => setCopied(false), 1500);
                      }
                    }}
                  >
                    <IconCopy width={14} height={14} />
                  </button>
                </div>
              </div>
              <div className="ticket-card-body">
                <div style={{ flex: 1, minWidth: 240 }}>
                  <table className="table" style={{ minWidth: 0 }}>
                    <tbody>
                      <tr>
                        <th style={{ width: 140 }}>Mã vé</th>
                        <td>
                          <span className="mono">{ticket.ticketCode}</span>
                          {copied && <span className="muted small" style={{ marginLeft: 8 }}>Đã sao chép</span>}
                        </td>
                      </tr>
                      <tr>
                        <th>Sự kiện</th>
                        <td>{ticket.event.name}</td>
                      </tr>
                      <tr>
                        <th>Loại vé</th>
                        <td>{ticket.ticketType.name}</td>
                      </tr>
                      <tr>
                        <th>Trạng thái</th>
                        <td>
                          <StatusBadge status={ticket.status} />
                        </td>
                      </tr>
                      <tr>
                        <th>Check-in lúc</th>
                        <td>{formatDateTime(ticket.checkedInAt)}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <div style={{ textAlign: 'center', margin: '0 auto' }}>
                  <div className="ticket-qr" ref={qrBoxRef}>
                    <QRCodeCanvas
                      value={ticket.qrPayload || ticket.ticketCode}
                      size={200}
                      level="M"
                    />
                  </div>
                  <div className="muted small" style={{ marginTop: 10 }}>
                    Đưa mã QR cho nhân viên check-in
                  </div>
                </div>
              </div>
              <div style={{ marginTop: 18, display: 'flex', gap: 10 }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={pdfBusy}
                  onClick={handleDownloadPdf}
                >
                  <IconDownload width={16} height={16} />
                  {pdfBusy ? 'Đang tạo PDF…' : 'Tải vé PDF'}
                </button>
                {pdfBusy && <Spinner />}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}