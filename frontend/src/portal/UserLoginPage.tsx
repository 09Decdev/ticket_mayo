import { FormEvent, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { setAuth } from '../api/storage';
import { ticketClient } from '../api/ticket.client';
import { Button } from '../components/Button';
import { IconTicket } from '../components/icons';

export function UserLoginPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!email || !password) {
      setError('Vui lòng nhập email và mật khẩu.');
      return;
    }
    setLoading(true);
    try {
      const res = await ticketClient.login({ email: email.toLowerCase().trim(), password });
      setAuth(res.accessToken, undefined, res.user);
      const next = params.get('next');
      navigate(next || '/portal/tickets', { replace: true });
    } catch (e: any) {
      setError(e?.message || 'Đăng nhập thất bại.');
      setLoading(false);
    }
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-brand">
          <div className="brand-mark">
            <IconTicket width={20} height={20} />
          </div>
          <strong>ticket-mayo</strong>
        </div>
        <h2>Đăng nhập</h2>
        <p className="auth-sub">Xem vé và mã QR check-in của bạn.</p>
        {error && <div className="error-box">{error}</div>}
        <form onSubmit={onSubmit}>
          <div className="form-field">
            <label htmlFor="li-email">Email</label>
            <input
              id="li-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div className="form-field">
            <label htmlFor="li-pw">Mật khẩu</label>
            <input
              id="li-pw"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          <Button type="submit" loading={loading} style={{ width: '100%', justifyContent: 'center' }}>
            Đăng nhập
          </Button>
        </form>
        <div className="auth-alt">
          Chưa có tài khoản? <Link to="/portal/signup">Tạo tài khoản</Link>
        </div>
      </div>
    </div>
  );
}