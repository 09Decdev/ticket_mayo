import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ticketClient } from '../api/ticket.client';
import type {
  ApiError,
  Event,
  SplitApplyResult,
  SplitPlanReport,
  SplitRollbackResult,
  SplitTypeSnap,
  TicketType,
} from '../api/types';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { Spinner } from '../components/Spinner';

/**
 * "Điều chuyển vé" — tab QUẢN LÝ cạnh "Gộp loại vé".
 * Form gọn: chọn nguồn/đích + SỐ VÉ CHUYỂN (moveCount) — UI tự tính
 * keepCount = eligibleCount - moveCount (eligible lấy từ plan dry-run).
 * 2 ô quantity nằm trong "Tùy chọn nâng cao" (mặc định đóng) — chỉ mở khi
 * cần giữ nguồn tiếp tục bán hoặc đích thiếu chỗ.
 * Flow: "Xem trước" (GET plan: movePreview vé MỚI NHẤT sẽ chuyển,
 * blockers/warnings, projection) → gõ SPLIT để apply → hiện
 * contentAuditId + repointAuditId + form rollback (gõ ROLLBACK).
 * Mọi số liệu đọc từ GET /admin/ticket-split/plan (content + local subset).
 */
export function SplitTicketTypesPage() {
  const [events, setEvents] = useState<Event[]>([]);
  const [eventsLoaded, setEventsLoaded] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const eventId = searchParams.get('eventId') ?? '';

  const [types, setTypes] = useState<TicketType[]>([]);
  const [loading, setLoading] = useState(true);
  const [planning, setPlanning] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const [sourceId, setSourceId] = useState('');
  const [targetId, setTargetId] = useState('');
  const [moveCount, setMoveCount] = useState('');
  const [srcQty, setSrcQty] = useState('');
  const [tgtQty, setTgtQty] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [confirmText, setConfirmText] = useState('');

  const [plan, setPlan] = useState<SplitPlanReport | null>(null);
  const [applyResult, setApplyResult] = useState<SplitApplyResult | null>(null);
  const [showAllMoved, setShowAllMoved] = useState(false);
  const [copyMsg, setCopyMsg] = useState<string | null>(null);

  const [rbAudit, setRbAudit] = useState('');
  const [rbRepoint, setRbRepoint] = useState('');
  const [rbConfirm, setRbConfirm] = useState('');
  const [rolling, setRolling] = useState(false);
  const [rbResult, setRbResult] = useState<SplitRollbackResult | null>(null);

  // eligibleCount thật của nguồn (từ plan dry-run gần nhất) — để quy đổi
  // "số vé chuyển" → keepCount = eligible - moveCount.
  const [eligibleSeen, setEligibleSeen] = useState<number | null>(null);

  useEffect(() => {
    (async () => {
      try {
        setEvents(await ticketClient.listEvents());
      } catch (e: any) {
        setError(e?.code ? e : { message: e?.message || 'Không tải được sự kiện.' });
      } finally {
        setEventsLoaded(true);
      }
    })();
  }, []);

  // Sự kiện chọn từ URL (?eventId=) — giống trang Loại vé.
  useEffect(() => {
    if (!eventsLoaded || events.length === 0) return;
    if (!events.some((ev) => ev.id === eventId)) {
      const next = new URLSearchParams(searchParams);
      next.set('eventId', events[0].id);
      setSearchParams(next, { replace: true });
    }
  }, [eventsLoaded, events, eventId, searchParams, setSearchParams]);

  // Đổi event → reset selection + load loại vé (nguồn sự thật content).
  useEffect(() => {
    setSourceId('');
    setTargetId('');
    setMoveCount('');
    setPlan(null);
    setApplyResult(null);
    setShowAllMoved(false);
    setCopyMsg(null);
    setEligibleSeen(null);
    setError(null);
    if (!eventId) {
      setTypes([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    (async () => {
      try {
        const list = await ticketClient.listTicketTypes(eventId);
        setTypes(list);
        // Mặc định tiện: nguồn = loại sold nhiều nhất, đích = loại khác đầu tiên.
        const sold = [...list].sort((a, b) => (b.sold ?? 0) - (a.sold ?? 0));
        if (sold[0]) setSourceId(sold[0].id);
        const other = list.find((t) => t.id !== sold[0]?.id);
        if (other) setTargetId(other.id);
      } catch (e: any) {
        setError(e?.code ? e : { message: e?.message || 'Không tải được loại vé.' });
        setTypes([]);
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);

  function onEventChange(id: string) {
    const next = new URLSearchParams(searchParams);
    if (id) next.set('eventId', id);
    else next.delete('eventId');
    setSearchParams(next);
  }

  function srcType(): TicketType | null {
    return types.find((t) => t.id === sourceId) ?? null;
  }
  function tgtType(): TicketType | null {
    return types.find((t) => t.id === targetId) ?? null;
  }

  // keepCount gửi backend từ "số vé chuyển": eligible thật (đã biết sau
  // dry-run) hoặc ước lượng sold của nguồn từ danh sách loại vé.
  function eligibleEstimate(): number {
    return eligibleSeen ?? srcType()?.sold ?? 0;
  }
  function keepFromMove(): number {
    return Math.max(eligibleEstimate() - Number(moveCount), 0);
  }
  // Quantity mặc định "dịch chỗ theo vé": nguồn −= số chuyển, ĐÍCH += số
  // chuyển → slot còn lại 2 loại giữ nguyên, tổng sức chứa event không đổi.
  // Override ở "Tùy chọn nâng cao" thắng nếu điền.
  function qtyParams(
    mv: number,
    snapSrc?: { quantity: number } | null,
    snapTgt?: { quantity: number } | null,
  ): { sourceQuantity?: number; targetQuantity?: number } {
    const s = snapSrc ?? srcType();
    const t = snapTgt ?? tgtType();
    return {
      sourceQuantity: srcQty.trim()
        ? Number(srcQty)
        : s?.quantity != null
          ? Math.max(s.quantity - mv, 0)
          : undefined,
      targetQuantity: tgtQty.trim()
        ? Number(tgtQty)
        : t?.quantity != null
          ? t.quantity + mv
          : undefined,
    };
  }

  async function onPreview() {
    if (!eventId || !sourceId || !targetId || moveCount === '') return;
    const mv = Number(moveCount);
    setPlanning(true);
    setError(null);
    setPlan(null);
    try {
      let keep = keepFromMove();
      const q1 = qtyParams(Math.min(mv, eligibleEstimate()));
      let r = await ticketClient.splitPlan({
        eventId,
        sourceId,
        targetId,
        keepCount: keep,
        ...q1,
      });
      // eligible thật khác ước lượng (vé CANCELLED/deleted) → chạy lại ĐÚNG
      // một lần với keep = eligible - move để preview khớp số chuyển nhập.
      const E = r.content?.source != null ? r.content.eligibleCount : null;
      if (E !== null) {
        setEligibleSeen(E);
        const keepTrue = Math.max(E - mv, 0);
        if (keepTrue !== keep) {
          keep = keepTrue;
          const q2 = qtyParams(Math.min(mv, E), r.content?.source ?? null, r.content?.target ?? null);
          r = await ticketClient.splitPlan({
            eventId,
            sourceId,
            targetId,
            keepCount: keep,
            ...q2,
          });
        }
      }
      setPlan(r);
    } catch (e: any) {
      setError(e?.code ? e : { message: e?.message || 'Xem trước thất bại.' });
    } finally {
      setPlanning(false);
    }
  }

  async function onApply() {
    if (!plan?.content?.ok || confirmText !== 'SPLIT') return;
    setApplying(true);
    setError(null);
    try {
      const mv = plan.content.moveCount;
      const keep = Math.max(plan.content.eligibleCount - mv, 0);
      const res = await ticketClient.splitTicketTypes({
        eventId,
        sourceId,
        targetId,
        keepCount: keep,
        ...qtyParams(mv, plan.content.source ?? null, plan.content.target ?? null),
        confirm: 'SPLIT',
      });
      setApplyResult(res);
      setPlan(null);
      setEligibleSeen(null); // số liệu cũ hết hạn — lần preview sau ước lượng lại
      setConfirmText('');
      setShowAllMoved(false);
      setCopyMsg(null);
      try {
        setTypes(await ticketClient.listTicketTypes(eventId));
      } catch {
        /* reload fail-soft — kết quả split đã hiển thị */
      }
    } catch (e: any) {
      setError(e?.code ? e : { message: e?.message || 'Split thất bại.' });
      setPlan(null); // force preview lại để xem blocker mới
    } finally {
      setApplying(false);
    }
  }

  async function onRollback() {
    if (!rbAudit.trim() || rbConfirm !== 'ROLLBACK') return;
    setRolling(true);
    setError(null);
    setRbResult(null);
    try {
      const res = await ticketClient.splitRollback({
        contentAuditId: rbAudit.trim(),
        repointAuditId: rbRepoint.trim() || undefined,
        confirm: 'ROLLBACK',
      });
      setRbResult(res);
      setRbConfirm('');
      try {
        setTypes(await ticketClient.listTicketTypes(eventId));
      } catch {
        /* ignore */
      }
    } catch (e: any) {
      setError(e?.code ? e : { message: e?.message || 'Rollback thất bại.' });
    } finally {
      setRolling(false);
    }
  }

  const c = plan?.content ?? null;
  const local = plan?.local ?? null;
  const localOk = local && !('error' in local) ? local : null;
  const selectedEvent = events.find((ev) => ev.id === eventId) ?? null;
  const srcSnap = c?.source ?? null;
  const tgtSnap = c?.target ?? null;
  const proj = c?.projection ?? null;
  const move = moveCount === '' ? NaN : Number(moveCount);
  const canPreview =
    !!eventId && !!sourceId && !!targetId && sourceId !== targetId && !Number.isNaN(move) && move > 0;

  function fmtSnap(t: SplitTypeSnap | TicketType | null): string {
    if (!t) return '—';
    const name = 'name' in t ? t.name : '';
    const qty = t.quantity ?? '—';
    const sold = t.sold ?? 0;
    return `${name} (SL ${qty} · đã bán ${sold})`;
  }

  function fmtDate(s: string): string {
    return s?.slice(0, 19)?.replace('T', ' ') ?? '';
  }

  // Danh sách vé đã chuyển (từ applyResult.moved — mọi đợt, không bị cap 500).
  const moved = applyResult?.moved ?? [];
  const movedUserIds = Array.from(
    new Set(moved.map((t) => t.userId).filter((u): u is string => !!u)),
  );
  const movedUnclaimed = moved.filter((t) => !t.userId).length;

  function sqlIn(values: string[]): string {
    return values.map((v) => `'${v.replace(/'/g, "''")}'`).join(', ');
  }
  async function copyMovedList(kind: 'userIds' | 'codes') {
    const values = kind === 'userIds' ? movedUserIds : moved.map((t) => t.ticketCode);
    try {
      await navigator.clipboard.writeText(sqlIn(values));
      setCopyMsg(
        `Đã copy ${values.length} ${kind === 'userIds' ? 'userId' : 'mã vé'} — dán vào chỗ "( ... )" trong câu SQL dưới.`,
      );
    } catch {
      setCopyMsg('Trình duyệt chặn clipboard — dùng nút "Tải CSV" rồi mở file.');
    }
    window.setTimeout(() => setCopyMsg(null), 6000);
  }
  function downloadMovedCsv() {
    const csv = [
      'ticketId,ticketCode,userId,status,createdAt',
      ...moved.map(
        (t) => `${t.ticketId},${t.ticketCode},${t.userId ?? ''},${t.status},${t.createdAt}`,
      ),
    ].join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'split-moved-tickets.csv';
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <div>
      <h1 className="page-title">Điều chuyển vé</h1>
      <p className="page-sub">
        Chuyển các vé ĐĂNG KÝ MỚI NHẤT từ một loại vé (nguồn) sang loại vé khác (đích) cùng sự
        kiện. Chỉ cần nhập <strong>số vé chuyển</strong> — số lượng nguồn tự trừ đi đúng số đó, số
        lượng đích tự cộng thêm (sức chứa event không đổi). Loại nguồn KHÔNG bị xóa (khác gộp vé).
        Có rollback theo auditId.
      </p>

      {error && (
        <div className="error-box" role="alert">
          <div>
            {error.message}
            {error.code ? ` [${error.code}]` : ''}
          </div>
          {error.blockers?.length ? (
            <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
              {error.blockers.map((b, i) => (
                <li key={i}>{b}</li>
              ))}
            </ul>
          ) : null}
          {error.localRepointRolledBack === false ? (
            <div style={{ marginTop: 6 }}>
              ⚠ Lokal repoint CHƯA tự undo được (audit={error.repointAuditId}) — liên hệ
              kỹ sư chạy rollback thủ công trước khi retry.
            </div>
          ) : null}
          {error.completedRounds?.length ? (
            <div style={{ marginTop: 6 }}>
              ⚠ {error.completedRounds.length} đợt ≤500 vé ĐÃ COMMIT trước khi lỗi —
              rollback TỪNG đợt theo thứ tự ngược (đợt cuối trước) rồi kiểm tra lại:
              {' '}
              {error.completedRounds
                .map((r) => `đợt ${r.round}: ${r.contentAuditId ?? '?'}`)
                .join(' · ')}
            </div>
          ) : null}
        </div>
      )}

      <div className="context-bar">
        <div className="form-field">
          <label htmlFor="sp-event">Sự kiện</label>
          <select id="sp-event" value={eventId} onChange={(e) => onEventChange(e.target.value)}>
            {events.length === 0 && <option value="">(chưa có sự kiện)</option>}
            {events.map((ev) => (
              <option key={ev.id} value={ev.id}>
                {ev.name}
              </option>
            ))}
          </select>
        </div>
        <div className="context-meta">
          {selectedEvent ? (
            <>
              <span className="context-name">{selectedEvent.name}</span>
              <span>{loading ? 'Đang tải…' : `${types.length} loại vé`}</span>
            </>
          ) : (
            <span>Chưa chọn sự kiện.</span>
          )}
        </div>
      </div>

      {loading ? (
        <Spinner />
      ) : types.length < 2 ? (
        <div className="empty">Cần ít nhất 2 loại vé trong sự kiện để điều chuyển.</div>
      ) : (
        <>
          <Card title="1. Chọn loại nguồn, loại đích và số vé chuyển">
            <div className="form-grid">
              <div className="form-field">
                <label htmlFor="sp-source">Loại vé NGUỒN (bị lấy vé đi)</label>
                <select
                  id="sp-source"
                  value={sourceId}
                  onChange={(e) => {
                    const sid = e.target.value;
                    setSourceId(sid);
                    // Đích cũ có thể trùng nguồn mới — select sẽ "ẩn" sự trùng này
                    // (HTML rơi về option đầu) trong khi state vẫn sai → khóa nút.
                    if (targetId === sid) {
                      setTargetId(types.find((t) => t.id !== sid)?.id ?? '');
                    }
                    setPlan(null);
                    setEligibleSeen(null);
                  }}
                >
                  {types.map((t) => (
                    <option key={t.id} value={t.id}>
                      {fmtSnap(t)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-field">
                <label htmlFor="sp-target">Loại vé ĐÍCH (nhận vé mới nhất)</label>
                <select
                  id="sp-target"
                  value={targetId}
                  onChange={(e) => {
                    setTargetId(e.target.value);
                    setPlan(null);
                  }}
                >
                  {types
                    .filter((t) => t.id !== sourceId)
                    .map((t) => (
                      <option key={t.id} value={t.id}>
                        {fmtSnap(t)}
                      </option>
                    ))}
                </select>
              </div>
              <div className="form-field">
                <label htmlFor="sp-move">Số vé chuyển</label>
                <input
                  id="sp-move"
                  type="number"
                  min="1"
                  value={moveCount}
                  onChange={(e) => {
                    setMoveCount(e.target.value);
                    setPlan(null);
                  }}
                  placeholder="vd 860"
                />
              </div>
            </div>
            {eligibleSeen !== null && !Number.isNaN(move) && (
              <p className="hint" style={{ margin: '6px 0 0' }}>
                Nguồn có <strong>{eligibleSeen}</strong> vé sống → sẽ giữ lại{' '}
                <strong>{Math.max(eligibleSeen - move, 0)}</strong> vé cũ nhất, chuyển{' '}
                <strong>{move}</strong> vé mới nhất
                {eligibleSeen - move < 0 ? ' — ⚠ vượt số vé sống của nguồn!' : ''}. Số lượng: nguồn{' '}
                <strong>−{move}</strong>, đích <strong>+{move}</strong>.
              </p>
            )}
            <div style={{ marginTop: 10 }}>
              <button
                type="button"
                className="link-ish"
                style={{ background: 'none', border: 'none', color: '#5b6c8f', cursor: 'pointer', padding: 0, font: 'inherit' }}
                onClick={() => setShowAdvanced((v) => !v)}
              >
                {showAdvanced ? '▾' : '▸'} Tùy chọn nâng cao (số lượng sau split — hiếm khi cần)
              </button>
            </div>
            {showAdvanced && (
              <div className="form-grid" style={{ marginTop: 8 }}>
                <div className="form-field">
                  <label htmlFor="sp-srcqty">Số lượng nguồn sau split</label>
                  <input
                    id="sp-srcqty"
                    type="number"
                    min="0"
                    value={srcQty}
                    onChange={(e) => setSrcQty(e.target.value)}
                    placeholder="(mặc định = SL nguồn − số vé chuyển)"
                  />
                </div>
                <div className="form-field">
                  <label htmlFor="sp-tgtqty">Số lượng đích sau split</label>
                  <input
                    id="sp-tgtqty"
                    type="number"
                    min="0"
                    value={tgtQty}
                    onChange={(e) => setTgtQty(e.target.value)}
                    placeholder="(mặc định = SL đích + số vé chuyển)"
                  />
                </div>
              </div>
            )}
            <div className="form-actions">
              <Button
                variant="secondary"
                onClick={onPreview}
                loading={planning}
                disabled={!canPreview}
              >
                Xem trước (dry-run)
              </Button>
            </div>
          </Card>

          {(planning || plan) && (
            <Card title="2. Báo cáo dry-run">
              {planning ? (
                <Spinner />
              ) : !c ? (
                <div className="empty">Chưa có báo cáo — bấm "Xem trước".</div>
              ) : (
                <div>
                  <p>
                    Sẽ chuyển <strong>{c.moveCount}</strong>/{c.eligibleCount} vé mới nhất từ{' '}
                    <strong>{fmtSnap(srcSnap)}</strong> sang{' '}
                    <strong>{fmtSnap(tgtSnap)}</strong>.
                    {c.moveCount !== move && !Number.isNaN(move) ? (
                      <span className="hint"> (⚠ khác số bạn nhập: {move})</span>
                    ) : null}
                  </p>

                  {c.blockers.length > 0 && (
                    <div className="error-box" role="alert">
                      <strong>Blocker (không thể split):</strong>
                      <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                        {c.blockers.map((b, i) => (
                          <li key={i}>{b}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {c.shapeErrors.length > 0 && (
                    <div className="error-box" role="alert">
                      <strong>Lỗi input:</strong>
                      <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                        {c.shapeErrors.map((b, i) => (
                          <li key={i}>{b}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {c.warnings.length > 0 && (
                    <div style={{ background: '#fff8e1', padding: 12, borderRadius: 6, margin: '8px 0' }}>
                      <strong>Cảnh báo:</strong>
                      <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                        {c.warnings.map((w, i) => (
                          <li key={i}>{w}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {localOk && (
                    <div className="hint" style={{ margin: '8px 0' }}>
                      DB công cụ vé: {localOk.affectedPreTickets} PreTicket đã mint trong tập chuyển
                      sẽ đổi snapshot hiển thị sang loại đích.
                      {localOk.note ? ` (${localOk.note})` : ''}
                    </div>
                  )}
                  {local && 'error' in local && (
                    <div className="hint" style={{ margin: '8px 0', color: '#b71c1c' }}>
                      ⚠ Báo cáo PreTicket lokal lỗi: {local.error}
                    </div>
                  )}

                  {proj && (
                    <div className="table-wrap">
                      <table className="table">
                        <thead>
                          <tr>
                            <th>Chỉ số</th>
                            <th>Trước</th>
                            <th>Sau split</th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr>
                            <td>Nguồn — số lượng</td>
                            <td>{srcSnap?.quantity ?? '—'}</td>
                            <td>{proj.sourceAfter.quantity}</td>
                          </tr>
                          <tr>
                            <td>Nguồn — đã bán (sold)</td>
                            <td>{srcSnap?.sold ?? '—'}</td>
                            <td>{proj.sourceAfter.sold}</td>
                          </tr>
                          <tr>
                            <td>Nguồn — còn lại</td>
                            <td>{srcSnap?.remaining ?? '—'}</td>
                            <td>{proj.sourceAfter.remaining}</td>
                          </tr>
                          <tr>
                            <td>Đích — số lượng</td>
                            <td>{tgtSnap?.quantity ?? '—'}</td>
                            <td>{proj.targetAfter.quantity}</td>
                          </tr>
                          <tr>
                            <td>Đích — đã bán (sold)</td>
                            <td>{tgtSnap?.sold ?? '—'}</td>
                            <td>{proj.targetAfter.sold}</td>
                          </tr>
                          <tr>
                            <td>Đích — còn lại</td>
                            <td>{tgtSnap?.remaining ?? '—'}</td>
                            <td>{proj.targetAfter.remaining}</td>
                          </tr>
                          <tr>
                            <td>Sức chứa event</td>
                            <td>{c.event.maxParticipantsBefore ?? '—'}</td>
                            <td>{proj.maxParticipantsAfter ?? '—'}</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  )}

                  {c.movePreview.length > 0 && (
                    <div className="table-wrap">
                      <table className="table">
                        <thead>
                          <tr>
                            <th>#</th>
                            <th>Mã vé</th>
                            <th>userId người mua</th>
                            <th>Trạng thái</th>
                            <th>Đăng ký lúc</th>
                            <th>Check-in</th>
                          </tr>
                        </thead>
                        <tbody>
                          {c.movePreview.map((t, i) => (
                            <tr key={t.ticketId}>
                              <td>{i + 1}</td>
                              <td className="mono">{t.ticketCode}</td>
                              <td className="mono">{t.userId ?? '(chưa claim)'}</td>
                              <td>
                                <span className={`badge badge-${t.status.toLowerCase()}`}>
                                  {t.status}
                                </span>
                              </td>
                              <td>{fmtDate(t.createdAt)}</td>
                              <td>{t.checkedInAt ? fmtDate(t.checkedInAt) : '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {c.movePreviewTruncated && (
                        <div className="hint" style={{ marginTop: 6 }}>
                          ⚠ Danh sách rút gọn 500/{c.moveCount} vé đầu. Khi Apply, hệ thống TỰ CHIA{' '}
                          {Math.ceil(c.moveCount / 500)} đợt ≤500 vé — mỗi đợt một auditId rollback
                          riêng.
                        </div>
                      )}
                    </div>
                  )}

                  <div className="form-field" style={{ marginTop: 12 }}>
                    <label htmlFor="sp-confirm">
                      Gõ <strong>SPLIT</strong> để xác nhận chuyển {c.moveCount} vé (giữ lại{' '}
                      {Math.max(c.eligibleCount - c.moveCount, 0)} vé cũ nhất ở nguồn)
                      {c.moveCount > 500
                        ? ` — tự chia ${Math.ceil(c.moveCount / 500)} đợt ≤500 vé`
                        : ''}
                    </label>
                    <input
                      id="sp-confirm"
                      value={confirmText}
                      onChange={(e) => setConfirmText(e.target.value)}
                      placeholder="SPLIT"
                    />
                  </div>
                  <div className="form-actions">
                    <Button
                      variant="danger"
                      loading={applying}
                      disabled={!c.ok || confirmText !== 'SPLIT'}
                      onClick={onApply}
                    >
                      Apply split
                    </Button>
                  </div>
                </div>
              )}
            </Card>
          )}

          {applyResult && (
            <Card title="Split hoàn tất">
              {applyResult.status === 'split-batched' ? (
                <div>
                  <p>
                    ✅ Đã chuyển {applyResult.totalMoved ?? '—'} vé theo {applyResult.rounds?.length ?? 0}{' '}
                    đợt (≤500 vé/đợt)
                    {applyResult.partial
                      ? ' — ⚠ DỪNG GIỮA CHỪNG: đợt cuối lỗi nhưng content báo ĐÃ commit, chưa rõ auditId — kiểm tra AuditLog TICKET_TYPE_SPLIT của event trước khi rollback/retry'
                      : ''}
                    .
                  </p>
                  {applyResult.note ? <p className="hint">⚠ {applyResult.note}</p> : null}
                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Đợt</th>
                          <th>Số vé</th>
                          <th>contentAuditId</th>
                          <th>repointAuditId</th>
                          <th></th>
                        </tr>
                      </thead>
                      <tbody>
                        {applyResult.rounds?.map((r) => (
                          <tr key={r.round}>
                            <td>{r.round}</td>
                            <td>{r.movedTickets ?? '?'}</td>
                            <td className="mono">{r.contentAuditId ?? '(chưa rõ)'}</td>
                            <td className="mono">{r.repointAuditId}</td>
                            <td>
                              {r.contentAuditId ? (
                                <button
                                  type="button"
                                  className="link-ish"
                                  style={{ background: 'none', border: 'none', color: '#5b6c8f', cursor: 'pointer', padding: 0, font: 'inherit' }}
                                  onClick={() => {
                                    setRbAudit(r.contentAuditId ?? '');
                                    setRbRepoint(r.repointAuditId);
                                  }}
                                >
                                  Điền để rollback
                                </button>
                              ) : null}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="hint">
                    Muốn hoàn tác: rollback <strong>từng đợt theo thứ tự ngược</strong> (đợt cuối
                    trước), mỗi đợt một cặp auditId ở bảng trên.
                  </p>
                </div>
              ) : applyResult.status === 'split' && applyResult.content ? (
                <div>
                  <p>
                    Đã chuyển {applyResult.content.moved.tickets} vé sang loại đích (
                    {applyResult.content.moved.seats} ghế kèm theo).
                    {applyResult.content.soldReconcile?.drift
                      ? ` ⚠ sold counter ${applyResult.content.soldReconcile.counter} lệch COUNT thực ${applyResult.content.soldReconcile.dbCount} (không chặn split).`
                      : ''}
                  </p>
                  {applyResult.content.warnings?.length ? (
                    <ul className="hint">
                      {applyResult.content.warnings.map((w, i) => (
                        <li key={i}>{w}</li>
                      ))}
                    </ul>
                  ) : null}
                  <div className="table-wrap">
                    <table className="table">
                      <tbody>
                        <tr>
                          <th>contentAuditId (rollback)</th>
                          <td className="mono">{applyResult.content.auditId}</td>
                        </tr>
                        <tr>
                          <th>repointAuditId (DB công cụ vé)</th>
                          <td className="mono">{applyResult.local?.repointAuditId}</td>
                        </tr>
                        <tr>
                          <th>PreTicket đã đổi snapshot</th>
                          <td>
                            {applyResult.local?.movedPreTickets ?? 0}/{applyResult.local?.movedIdsCount ?? 0}
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                  <p className="hint">
                    Muốn hoàn tác: điền 2 id vào form Rollback bên dưới (nút "Điền từ kết quả split").
                  </p>
                  <div className="form-actions">
                    <Button
                      variant="secondary"
                      onClick={() => {
                        if (!applyResult.content || !applyResult.local) return;
                        setRbAudit(applyResult.content.auditId);
                        setRbRepoint(applyResult.local.repointAuditId);
                      }}
                    >
                      Điền từ kết quả split
                    </Button>
                  </div>
                </div>
              ) : (
                <div>
                  <p>
                    ⚠ {applyResult.note ??
                      'Content trả lỗi nhưng split có thể ĐÃ commit (source.sold đã giảm). Liên hệ kỹ sư xác nhận auditId trước khi rollback/retry.'}
                  </p>
                  <div className="table-wrap">
                    <table className="table">
                      <tbody>
                        <tr>
                          <th>repointAuditId (DB công cụ vé)</th>
                          <td className="mono">{applyResult.local?.repointAuditId}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </Card>
          )}

          {moved.length > 0 && (
            <Card title="Danh sách vé đã chuyển — đối chiếu DB">
              <p className="card-sub">
                Toàn bộ <strong>{moved.length}</strong> vé đã đổi loại (gom từ mọi đợt, không bị
                cắt 500) — copy userId hoặc mã vé để SELECT thẳng vào DB content-service kiểm tra.
              </p>
              <p>
                <strong>{movedUserIds.length}</strong> userId khác nhau
                {movedUnclaimed > 0 ? (
                  <>
                    {' · '}
                    <strong>{movedUnclaimed}</strong> vé chưa claim (userId NULL)
                  </>
                ) : null}
              </p>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '8px 0' }}>
                <Button variant="secondary" onClick={() => copyMovedList('userIds')}>
                  Copy {movedUserIds.length} userId (dạng SQL IN)
                </Button>
                <Button variant="secondary" onClick={() => copyMovedList('codes')}>
                  Copy {moved.length} mã vé (dạng SQL IN)
                </Button>
                <Button variant="secondary" onClick={downloadMovedCsv}>
                  Tải CSV
                </Button>
              </div>
              {copyMsg && <p className="hint">{copyMsg}</p>}
              <div className="hint" style={{ marginBottom: 6 }}>
                Loại ĐÍCH phải chứa toàn bộ số vé này — id: <span className="mono">{targetId}</span>
                {tgtType()?.name ? ` (${tgtType()!.name})` : ''}
              </div>
              <pre
                style={{
                  background: '#f6f7fb',
                  border: '1px solid #e3e7f0',
                  borderRadius: 6,
                  padding: 10,
                  fontSize: 12,
                  overflowX: 'auto',
                }}
              >{`-- (1) Kiểm tra từng vé đã đổi loại — dán MÃ VÉ vừa copy vào IN:
SELECT "ticketCode", "userId", "ticketTypeId", status, "createdAt"
FROM "Ticket"
WHERE "ticketCode" IN ( ... );
--   ĐÚNG: ra ${moved.length} dòng và mọi "ticketTypeId" = ${targetId}

-- (2) Đếm vé đã đổi theo người dùng — dán USERID vừa copy vào IN:
SELECT "userId", COUNT(*) AS so_ve_da_doi
FROM "Ticket"
WHERE "userId" IN ( ... )
  AND "ticketTypeId" = '${targetId}'
GROUP BY "userId"
ORDER BY so_ve_da_doi DESC;`}</pre>
              <div
                className="table-wrap"
                style={{ maxHeight: showAllMoved ? 'none' : 360, overflow: 'auto' }}
              >
                <table className="table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Mã vé</th>
                      <th>userId</th>
                      <th>Trạng thái</th>
                      <th>Đăng ký lúc</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(showAllMoved ? moved : moved.slice(0, 50)).map((t, i) => (
                      <tr key={t.ticketId || `${t.ticketCode}-${i}`}>
                        <td>{i + 1}</td>
                        <td className="mono">{t.ticketCode}</td>
                        <td className="mono">{t.userId ?? '(chưa claim)'}</td>
                        <td>
                          <span className={`badge badge-${(t.status || '').toLowerCase()}`}>
                            {t.status}
                          </span>
                        </td>
                        <td>{fmtDate(t.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {moved.length > 50 && (
                <button
                  type="button"
                  className="link-ish"
                  style={{
                    background: 'none',
                    border: 'none',
                    color: '#5b6c8f',
                    cursor: 'pointer',
                    padding: 0,
                    font: 'inherit',
                    marginTop: 6,
                  }}
                  onClick={() => setShowAllMoved((v) => !v)}
                >
                  {showAllMoved ? '▴ Thu gọn (50 vé đầu)' : `▾ Hiện tất cả ${moved.length} vé`}
                </button>
              )}
            </Card>
          )}

          <Card title="Rollback split (nếu cần hoàn tác)">
            <p className="card-sub">
              Rollback trỏ đúng các vé đã chuyển về lại loại nguồn (theo manifest AuditLog) và khôi
              phục counter/số lượng cũ. Chỉ rollback được split chưa bị split/merge tiếp.
            </p>
            <div className="form-grid">
              <div className="form-field">
                <label htmlFor="sp-rb-audit">contentAuditId</label>
                <input
                  id="sp-rb-audit"
                  className="mono"
                  value={rbAudit}
                  onChange={(e) => setRbAudit(e.target.value)}
                />
              </div>
              <div className="form-field">
                <label htmlFor="sp-rb-repoint">repointAuditId (tùy chọn)</label>
                <input
                  id="sp-rb-repoint"
                  className="mono"
                  value={rbRepoint}
                  onChange={(e) => setRbRepoint(e.target.value)}
                />
              </div>
            </div>
            <div className="form-field">
              <label htmlFor="sp-rb-confirm">
                Gõ <strong>ROLLBACK</strong> để xác nhận
              </label>
              <input
                id="sp-rb-confirm"
                value={rbConfirm}
                onChange={(e) => setRbConfirm(e.target.value)}
              />
            </div>
            <div className="form-actions">
              <Button
                variant="danger"
                loading={rolling}
                disabled={!rbAudit.trim() || rbConfirm !== 'ROLLBACK'}
                onClick={onRollback}
              >
                Rollback
              </Button>
            </div>
            {rbResult && (
              <div className="hint" style={{ marginTop: 10 }}>
                Đã rollback split {rbResult.content?.auditId ?? rbAudit}: khôi phục{' '}
                {rbResult.content?.restored.tickets ?? '?'} vé về loại nguồn.
                {rbResult.local
                  ? ` DB công cụ vé: ${rbResult.local.movedPreTickets} PreTicket đã về snapshot cũ.`
                  : ''}
                {rbResult.warning ? ` ⚠ ${rbResult.warning}` : ''}
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
