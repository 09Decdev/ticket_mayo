import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { decodeJwt, getJwt, isAdmin, isJwtExpired } from '../api/storage';

interface Props {
  admin?: boolean;
  loginPath?: string;
}

export function ProtectedRoute({ admin = false, loginPath = '/admin/login' }: Props) {
  const location = useLocation();
  const token = getJwt();
  const payload = token ? decodeJwt(token) : null;

  if (!token || !payload || isJwtExpired(payload)) {
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`${loginPath}?next=${next}`} replace />;
  }

  if (admin && !isAdmin(payload)) {
    return <Navigate to="/admin/login?error=no_admin" replace />;
  }

  return <Outlet />;
}