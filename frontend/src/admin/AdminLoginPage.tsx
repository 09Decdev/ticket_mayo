import { FormEvent, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { setAuth } from '../api/storage';
import { ticketClient } from '../api/ticket.client';
import { Button } from '../components/Button';
import { IconTicket } from '../components/icons';

export function AdminLoginPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (params.get('error') === 'no_admin') {
      setError('Tài khoản không có quyền Admin.');
    }
  }, [params]);

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
      if (res.user.role !== 'ADMIN') {
        setError('Tài khoản không có quyền Admin.');
        setLoading(false);
        return;
      }
      setAuth(res.accessToken, undefined, res.user);
      navigate('/admin/distribute/emails', { replace: true });
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
        <h2>Đăng nhập Admin</h2>
        <p className="auth-sub">Quản lý phát vé, check-in và thống kê sự kiện.</p>
        {error && <div className="error-box">{error}</div>}
        <form onSubmit={onSubmit}>
          <div className="form-field">
            <label htmlFor="admin-email">Email</label>
            <input
              id="admin-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div className="form-field">
            <label htmlFor="admin-pw">Mật khẩu</label>
            <input
              id="admin-pw"
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
          Đăng nhập bằng tài khoản Admin của đơn vị phát hành.
        </div>
      </div>
    </div>
  );
}