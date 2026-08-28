import { FormEvent, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDistributionDraft } from './DistributionDraftContext';
import { EMAIL_REGEX, parseEmails } from '../common/email';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { Stepper } from '../components/Stepper';
import { IconUpload } from '../components/icons';

const STEPS = [
  { label: 'Sự kiện' },
  { label: 'Email' },
  { label: 'Loại vé' },
  { label: 'Xác nhận' },
];

export function ImportEmailListPage() {
  const navigate = useNavigate();
  const { draft, setDraft } = useDistributionDraft();
  const [raw, setRaw] = useState(draft.emails.join('\n'));
  const [error, setError] = useState<string | null>(null);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const parsed = parseEmails(raw);

  /**
   * Đọc file CSV: linh hoạt 3 dạng — cột "email" (có header), mỗi dòng 1 email,
   * hoặc các email cách nhau dấu phẩy/chấm phẩm. Gộp vào danh sách hiện tại;
   * parseEmails() lo hợp lệ/trùng khi render.
   *
   * Khi file có dòng tiêu đề (cột tên "email"/"e-mail"), CHỈ lấy đúng cột email
   * — STT/tên/SĐT không bị kéo theo. Khi không có tiêu đề, quét mọi cell có
   * dạng email; cell khác (dấu phẩy thừa, ký tự lạ…) rơi vào danh sách bỏ qua.
   */
  async function onImportCsv(file: File) {
    try {
      const text = await file.text();
      const lines = text
        .replace(new RegExp('^' + String.fromCharCode(0xfeff)), '')
        .split(/\r?\n/)
        .filter(Boolean);
      if (lines.length === 0) {
        setError('File CSV rỗng — không có email nào.');
        return;
      }
      const unquote = (c: string) => c.trim().replace(/^["']+|["']+$/g, '');
      const isEmailLike = (c: string) => EMAIL_REGEX.test(c.toLowerCase());
      const rows = lines.map((l) =>
        l
          .split(/[,;]/)
          .map(unquote)
          .filter(Boolean)
      );

      // Nhận diện dòng tiêu đề: có cột tên quen thuộc ("email"/"e-mail"/"tên"/"SĐT"…)
      // hoặc toàn cell không giống email. Tìm được cột "email" → chỉ đọc cột đó.
      const COL_NAMES = new Set([
        'email',
        'e-mail',
        'e mail',
        'mail',
        'stt',
        'số thứ tự',
        'họ tên',
        'hoten',
        'tên',
        'sđt',
        'số điện thoại',
        'phone',
      ]);
      const firstRow = rows[0] ?? [];
      const emailColIdx = firstRow.findIndex((c) => COL_NAMES.has(c.trim().toLowerCase()));
      const hasHeader = emailColIdx >= 0 || firstRow.every((c) => !isEmailLike(c));
      const body = hasHeader ? rows.slice(1) : rows;

      const emails = body
        .map((row) => {
          if (emailColIdx >= 0) {
            // Chỉ giữ cột email + mọi cell khác dạng email (vd nhiều email 1 cell).
            return row
              .map((c, i) => (i === emailColIdx || isEmailLike(c) ? c : ''))
              .filter(Boolean)
              .join('\n');
          }
          return row.join('\n');
        })
        .filter(Boolean)
        .join('\n');

      if (!emails) {
        setError(`File "${file.name}" không chứa email nào.`);
        setImportMsg(null);
        return;
      }
      const count = emails.split('\n').length;
      setRaw((prev) => (prev.trim() ? `${prev.trim()}\n${emails}` : emails));
      setError(null);
      setImportMsg(`Đã thêm ${count} email từ "${file.name}" — kiểm tra lại thống kê bên dưới.`);
    } catch (err) {
      setError(`Không đọc được file ${file.name}: ${(err as Error).message}`);
      setImportMsg(null);
    }
  }

  useEffect(() => {
    if (!draft.eventId) {
      navigate('/admin/distribute/event', { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onNext(e: FormEvent) {
    e.preventDefault();
    if (parsed.valid.length === 0) {
      setError('Không có email hợp lệ.');
      return;
    }
    setDraft({ emails: parsed.valid });
    navigate('/admin/distribute/type', { replace: false });
  }

  return (
    <div>
      <Stepper steps={STEPS} current={1} />
      <h1 className="page-title">Phát vé — Bước 2: Nhập danh sách email</h1>
      {draft.eventName && (
        <div className="muted" style={{ marginBottom: 8 }}>
          Sự kiện: <strong>{draft.eventName}</strong>{' '}
          <button
            type="button"
            style={{
              border: 'none',
              background: 'none',
              color: '#3370ff',
              cursor: 'pointer',
              textDecoration: 'underline',
              padding: 0,
            }}
            onClick={() => navigate('/admin/distribute/event')}
          >
            Đổi
          </button>
        </div>
      )}
      {error && <div className="error-box">{error}</div>}
      {importMsg && (
        <div className="muted" style={{ marginBottom: 8 }}>
          {importMsg}
        </div>
      )}
      <Card>
        <form onSubmit={onNext}>
          <div className="form-field">
            <label htmlFor="emails">Danh sách email người nhận</label>
            <textarea
              id="emails"
              placeholder={'nguoi1@example.com\nnguoi2@example.com'}
              value={raw}
              onChange={(e) => {
                setRaw(e.target.value);
                setError(null);
              }}
            />
            <div
              className="row"
              style={{
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: 8,
                flexWrap: 'wrap',
                marginBottom: 8,
              }}
            >
              <div className="hint" style={{ margin: 0 }}>
                Phân tách bằng dấu phẩy, chấm phẩm, hoặc xuống dòng. Mỗi dòng 1 email — hoặc
                import file .csv (có cột "email" cũng được).
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,text/csv"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = ''; // cho phép chọn lại cùng file
                  if (f) void onImportCsv(f);
                }}
              />
              <Button
                type="button"
                variant="secondary"
                onClick={() => fileInputRef.current?.click()}
              >
                <IconUpload width={15} height={15} />
                Import file CSV
              </Button>
            </div>
          </div>
          <div className="row">
            <span className="muted">Hợp lệ: <strong>{parsed.valid.length}</strong></span>
            <span className="muted">Không hợp lệ: <strong>{parsed.invalid.length}</strong></span>
            <span className="muted">Trùng lặp bỏ: <strong>{parsed.duplicatesDropped}</strong></span>
          </div>
          {parsed.invalid.length > 0 && (
            <div className="warn-box">Bỏ qua (không hợp lệ): {parsed.invalid.join(', ')}</div>
          )}
          <div className="row" style={{ marginTop: 12 }}>
            <Button variant="secondary" type="button" onClick={() => navigate('/admin/distribute/event')}>
              Quay lại
            </Button>
            <Button type="submit" disabled={parsed.valid.length === 0}>
              Tiếp theo: chọn loại vé
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}