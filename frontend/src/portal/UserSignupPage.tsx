import { FormEvent, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { setAuth } from '../api/storage';
import { ticketClient } from '../api/ticket.client';
import { Button } from '../components/Button';
import { IconTicket } from '../components/icons';

export function UserSignupPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!email || !password) {
      setError('Vui lòng nhập email và mật khẩu.');
      return;
    }
    if (password.length < 8) {
      setError('Mật khẩu tối thiểu 8 ký tự.');
      return;
    }
    setLoading(true);
    try {
      const res = await ticketClient.register({
        email: email.toLowerCase().trim(),
        password,
        displayName: displayName.trim() || undefined,
      });
      setAuth(res.accessToken, undefined, res.user);
      const next = params.get('next');
      navigate(next || '/portal/tickets', {
        replace: true,
        state: { claimedTickets: res.claimedTickets ?? 0 },
      });
    } catch (e: any) {
      setError(e?.message || 'Đăng ký thất bại.');
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
        <h2>Tạo tài khoản</h2>
        <p className="auth-sub">Dùng đúng email đã nhận vé — vé sẽ tự động gắn vào tài khoản.</p>
        {error && <div className="error-box">{error}</div>}
        <form onSubmit={onSubmit}>
          <div className="form-field">
            <label htmlFor="su-email">Email</label>
            <input
              id="su-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div className="form-field">
            <label htmlFor="su-pw">Mật khẩu (tối thiểu 8 ký tự)</label>
            <input
              id="su-pw"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          <div className="form-field">
            <label htmlFor="su-name">Tên hiển thị (tùy chọn)</label>
            <input id="su-name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </div>
          <Button type="submit" loading={loading} style={{ width: '100%', justifyContent: 'center' }}>
            Tạo tài khoản
          </Button>
        </form>
        <div className="auth-alt">
          Đã có tài khoản? <Link to="/portal/login">Đăng nhập</Link>
        </div>
      </div>
    </div>
  );
}