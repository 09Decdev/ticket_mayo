import { IconQr } from '../components/icons';

const DOWNLOAD_URL = (import.meta.env.VITE_APP_DOWNLOAD_URL as string | undefined) || '';

/**
 * Fallback web khi user chưa cài app. Universal link /c/<token>:
 *  - app đã cài → OS mở app, app tự claim bằng token (B1-safe, không web).
 *  - chưa cài   → browser load trang này → chỉ thứ/link tải app.
 * Token không dùng ở web fallback.
 */
export function AppDownloadPage() {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background:
          'radial-gradient(700px 360px at 50% -10%, rgba(99, 102, 241, 0.25), transparent 60%), #12101c',
        color: '#fff',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif',
        padding: 16,
      }}
    >
      <div
        style={{
          background: 'rgba(31, 28, 46, 0.9)',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 20,
          padding: '40px 32px',
          maxWidth: 420,
          textAlign: 'center',
          boxShadow: '0 24px 64px rgba(0,0,0,0.45)',
        }}
      >
        <div
          style={{
            width: 56,
            height: 56,
            margin: '0 auto 18px',
            borderRadius: 16,
            background: 'linear-gradient(135deg, #6366f1, #4338ca)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 8px 24px rgba(99, 102, 241, 0.45)',
          }}
        >
          <IconQr width={28} height={28} />
        </div>
        <h1 style={{ margin: '0 0 8px', fontSize: 21, fontWeight: 700 }}>Vé của bạn đang trong ứng dụng</h1>
        <p style={{ margin: '0 0 24px', color: '#a9a4c0', fontSize: 14, lineHeight: 1.6 }}>
          Tải ứng dụng để xem vé và mã QR check-in.
        </p>
        {DOWNLOAD_URL ? (
          <a
            href={DOWNLOAD_URL}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'inline-block',
              padding: '14px 36px',
              background: '#10b981',
              color: '#fff',
              borderRadius: 10,
              fontWeight: 650,
              textDecoration: 'none',
              fontSize: 15,
              boxShadow: '0 6px 20px rgba(16, 185, 129, 0.35)',
            }}
          >
            Tải ứng dụng
          </a>
        ) : (
          <p style={{ color: '#ffb4a1', fontSize: 13 }}>Chưa cấu hình link tải app (VITE_APP_DOWNLOAD_URL).</p>
        )}
      </div>
    </div>
  );
}