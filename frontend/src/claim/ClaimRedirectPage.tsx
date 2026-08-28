import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ticketClient } from '../api/ticket.client';
import { Spinner } from '../components/Spinner';
import { getJwt } from '../api/storage';

export function ClaimRedirectPage() {
  const { token } = useParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      navigate('/portal/tickets', { replace: true });
      return;
    }
    (async () => {
      const res = await ticketClient.resolveClaim(token);
      if (res.needsAuth) {
        navigate('/portal/signup', { replace: true });
        return;
      }
      // RB-2: thông báo trung thực theo trạng thái — KHÓI trước khi phân
      // tích ok/ticketId để các trạng thái này không bị nuốt.
      if (res.expired) {
        setNotice('Vé này đã hết hạn.');
        return;
      }
      if (res.processing) {
        // Mint/sync đang chạy (MINTING/CLAIMING) hoặc sync fail-soft chưa
        // link được vé — vào danh sách vé, KHÔNG vào detail (sẽ 404/502).
        setNotice('Vé đang được xử lý — hãy tải lại danh sách vé sau ít phút.');
        return;
      }
      if (res.ok) {
        if (res.ticketId) {
          navigate(`/portal/tickets/${encodeURIComponent(res.ticketId)}`, { replace: true });
        } else {
          navigate('/portal/tickets', { replace: true });
        }
        return;
      }
      if (!getJwt()) {
        navigate('/portal/signup', { replace: true });
        return;
      }
      setError(res.message || 'Không thể nhận vé (claim token không hợp lệ hoặc đã hết hạn).');
    })();
  }, [token, navigate]);

  if (error) return <div className="error-box">{error}</div>;
  // Thông báo trạng thái kèm đường về danh sách vé (trung thực, không chặn).
  if (notice) {
    return (
      <div className="notice-box">
        <p>{notice}</p>
        <button type="button" onClick={() => navigate('/portal/tickets')}>
          Xem danh sách vé
        </button>
      </div>
    );
  }
  return <Spinner large />;
}
