import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ticketClient } from '../api/ticket.client';
import type {
  ApiError,
  Event,
  MergeApplyResult,
  MergePlanReport,
  MergeRollbackResult,
  MergeTicketOverrides,
  MergeTypeStat,
} from '../api/types';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { Spinner } from '../components/Spinner';

/**
 * "Gộp loại vé" — tab QUẢN LÝ cạnh "Loại vé".
 * Flow: chọn sự kiện → xem list loại vé + DANH SÁCH VÉ ĐÃ MUA (kèm userId người
 * mua) per type → chọn survivor (radio, losers mặc định = tất cả còn lại) →
 * overrides → Dry-run (nút "Xem báo cáo gộp") → Apply với confirm gõ MERGE →
 * hiện contentAuditId + repointAuditId + hướng dẫn rollback (form ROLLBACK).
 * Mọi số liệu đọc từ GET /admin/ticket-merge/plan (content + local repoint).
 */
export function MergeTicketTypesPage() {
  const [events, setEvents] = useState<Event[]>([]);
  const [eventsLoaded, setEventsLoaded] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const eventId = searchParams.get('eventId') ?? '';

  const [base, setBase] = useState<MergePlanReport | null>(null);
  const [plan, setPlan] = useState<MergePlanReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [planning, setPlanning] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const [survivorId, setSurvivorId] = useState('');
  const [loserIds, setLoserIds] = useState<string[]>([]);

  const [ovName, setOvName] = useState('');
  const [ovPrice, setOvPrice] = useState('');
  const [ovQty, setOvQty] = useState('');
  const [ovMax, setOvMax] = useState('');
  const [ovEmail, setOvEmail] = useState<'' | 'true' | 'false'>('');
  const [includeTerminal, setIncludeTerminal] = useState(false);
  const [confirmText, setConfirmText] = useState('');

  const [applyResult, setApplyResult] = useState<MergeApplyResult | null>(null);

  const [rbAudit, setRbAudit] = useState('');
  const [rbRepoint, setRbRepoint] = useState('');
  const [rbConfirm, setRbConfirm] = useState('');
  const [rolling, setRolling] = useState(false);
  const [rbResult, setRbResult] = useState<MergeRollbackResult | null>(null);

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

  // Đổi event → reset mọi selection + load report nền (chưa chọn survivor).
  useEffect(() => {
    setSurvivorId('');
    setLoserIds([]);
    setPlan(null);
    setApplyResult(null);
    setError(null);
    if (!eventId) {
      setBase(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    (async () => {
      try {
        const r = await ticketClient.mergePlan({ eventId });
        setBase(r);
      } catch (e: any) {
        setError(e?.code ? e : { message: e?.message || 'Không tải được báo cáo loại vé.' });
        setBase(null);
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);

  const types: MergeTypeStat[] = base?.content.types ?? [];

  function onEventChange(id: string) {
    const next = new URLSearchParams(searchParams);
    if (id) next.set('eventId', id);
    else next.delete('eventId');
    setSearchParams(next);
  }

  function chooseSurvivor(id: string) {
    setSurvivorId(id);
    // Mặc định losers = TẤT CẢ type còn lại của event.
    setLoserIds(types.filter((t) => t.id !== id).map((t) => t.id));
    setPlan(null);
    setError(null);
  }

  function toggleLoser(id: string) {
    setLoserIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
    setPlan(null);
  }

  function buildOverrides(): MergeTicketOverrides | undefined {
    const o: MergeTicketOverrides = {};
    if (ovName.trim()) o.name = ovName.trim();
    if (ovPrice.trim()) o.price = Number(ovPrice);
    if (ovQty.trim()) o.quantity = Number(ovQty);
    if (ovMax.trim()) o.maxTicketsPerUser = Number(ovMax);
    if (ovEmail) o.emailDistribution = ovEmail === 'true';
    return Object.keys(o).length ? o : undefined;
  }

  async function onDryRun() {
    if (!eventId || !survivorId || loserIds.length === 0) return;
    setPlanning(true);
    setError(null);
    setPlan(null);
    try {
      const r = await ticketClient.mergePlan({ eventId, survivorId, loserIds });
      setPlan(r);
    } catch (e: any) {
      setError(e?.code ? e : { message: e?.message || 'Dry-run thất bại.' });
    } finally {
      setPlanning(false);
    }
  }

  async function onApply() {
    if (!plan?.content.mergeTarget?.ok || confirmText !== 'MERGE') return;
    setApplying(true);
    setError(null);
    try {
      const res = await ticketClient.mergeTicketTypes({
        eventId,
        survivorId,
        loserIds,
        overrides: buildOverrides(),
        includeTerminal,
        confirm: 'MERGE',
      });
      setApplyResult(res);
      // Nạp lại report nền — loser đã biến mất khỏi event.
      setPlan(null);
      setSurvivorId('');
      setLoserIds([]);
      setConfirmText('');
      try {
        setBase(await ticketClient.mergePlan({ eventId }));
      } catch {
        /* reload nền fail-soft — kết quả merge đã hiển thị */
      }
    } catch (e: any) {
      setError(e?.code ? e : { message: e?.message || 'Merge thất bại.' });
      setPlan(null); // force dry-run lại để xem blocker mới
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
      const res = await ticketClient.mergeRollback({
        contentAuditId: rbAudit.trim(),
        repointAuditId: rbRepoint.trim() || undefined,
        confirm: 'ROLLBACK',
      });
      setRbResult(res);
      setRbConfirm('');
      try {
        setBase(await ticketClient.mergePlan({ eventId }));
      } catch {
        /* ignore */
      }
    } catch (e: any) {
      setError(e?.code ? e : { message: e?.message || 'Rollback thất bại.' });
    } finally {
      setRolling(false);
    }
  }

  const mt = plan?.content.mergeTarget ?? null;
  const local = plan?.local ?? null;
  const localOk = local && !('error' in local) ? local : null;
  const selectedEvent = events.find((ev) => ev.id === eventId) ?? null;
  const proj = mt?.projection ?? null;
  const defaultQty = proj ? String(proj.quantity) : '';

  return (
    <div>
      <h1 className="page-title">Gộp loại vé</h1>
      <p className="page-sub">
        Gộp nhiều loại vé (kể cả đã có người mua) về MỘT loại vé đích cùng sự kiện. Vé,
        reservation, ghế và chiến dịch quà sẽ trỏ về loại đích; loại bị gộp sẽ xóa. Có
        rollback theo auditId.
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
              ⚠ Lokan repoint CHƯA tự undo được (audit={error.repointAuditId}) — liên hệ
              kỹ sư chạy rollback thủ công trước khi retry.
            </div>
          ) : null}
        </div>
      )}

      <div className="context-bar">
        <div className="form-field">
          <label htmlFor="mg-event">Sự kiện</label>
          <select id="mg-event" value={eventId} onChange={(e) => onEventChange(e.target.value)}>
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
      ) : types.length === 0 ? (
        <div className="empty">Sự kiện này chưa có loại vé nào.</div>
      ) : (
        <>
          <Card title="1. Chọn loại vé đích và các loại bị gộp">
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Đích</th>
                    <th>Gộp vào đích</th>
                    <th>Tên</th>
                    <th>Giá</th>
                    <th>Tổng / Đã phát</th>
                    <th>Vé đã mua (kèm userId)</th>
                    <th>Khác</th>
                  </tr>
                </thead>
                <tbody>
                  {types.map((t) => (
                    <tr key={t.id}>
                      <td>
                        <input
                          type="radio"
                          name="survivor"
                          checked={survivorId === t.id}
                          onChange={() => chooseSurvivor(t.id)}
                          aria-label={`Chọn ${t.name} làm loại vé đích`}
                        />
                      </td>
                      <td>
                        <input
                          type="checkbox"
                          disabled={!survivorId || survivorId === t.id}
                          checked={loserIds.includes(t.id)}
                          onChange={() => toggleLoser(t.id)}
                          aria-label={`Gộp ${t.name}`}
                        />
                      </td>
                      <td>
                        {t.name}
                        {t.emailDistribution ? (
                          <span className="hint"> · phát email</span>
                        ) : null}
                      </td>
                      <td>{t.price}</td>
                      <td>
                        {t.quantity} / {t.sold}
                      </td>
                      <td>
                        <details>
                          <summary className="btn btn-link" style={{ cursor: 'pointer' }}>
                            {t.tickets.total} vé
                          </summary>
                          {t.tickets.buyers.length === 0 ? (
                            <div className="hint">chưa có vé</div>
                          ) : (
                            <table className="table">
                              <thead>
                                <tr>
                                  <th>Mã vé</th>
                                  <th>userId người mua</th>
                                  <th>Trạng thái</th>
                                  <th>Giá mua</th>
                                  <th>Mộc thời gian</th>
                                </tr>
                              </thead>
                              <tbody>
                                {t.tickets.buyers.map((b) => (
                                  <tr key={b.ticketId}>
                                    <td className="mono">{b.ticketCode}</td>
                                    <td className="mono">{b.userId ?? '(chưa claim)'}</td>
                                    <td>
                                      <span className={`badge badge-${b.status.toLowerCase()}`}>
                                        {b.status}
                                      </span>
                                    </td>
                                    <td>{b.purchasePrice}</td>
                                    <td>{b.createdAt.slice(0, 19).replace('T', ' ')}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                          {t.tickets.buyersTruncated ? (
                            <div className="hint">
                              (hiển thị 500 vé đầu — còn {t.tickets.total - t.tickets.buyers.length} vé không liệt kê)
                            </div>
                          ) : null}
                        </details>
                      </td>
                      <td className="hint">
                        {t.reservations.byStatus.PENDING
                          ? `${t.reservations.byStatus.PENDING} reservation chờ `
                          : ''}
                        {t.seats ? `${t.seats} ghế ` : ''}
                        {t.giftCampaigns ? `${t.giftCampaigns} chiến dịch quà` : ''}
                        {!(t.reservations.byStatus.PENDING || t.seats || t.giftCampaigns)
                          ? '—'
                          : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <Card title="2. Overrides cho loại vé đích sau merge (tùy chọn)">
            <div className="form-grid">
              <div className="form-field">
                <label htmlFor="mg-ov-name">Tên mới</label>
                <input
                  id="mg-ov-name"
                  value={ovName}
                  onChange={(e) => setOvName(e.target.value)}
                  placeholder={survivorId ? types.find((t) => t.id === survivorId)?.name ?? '' : '(giữ tên survivor)'}
                />
              </div>
              <div className="form-field">
                <label htmlFor="mg-ov-price">Giá mới (VND)</label>
                <input
                  id="mg-ov-price"
                  type="number"
                  min="0"
                  value={ovPrice}
                  onChange={(e) => setOvPrice(e.target.value)}
                  placeholder="(giữ giá survivor — chỉ áp dụng vé mới)"
                />
              </div>
              <div className="form-field">
                <label htmlFor="mg-ov-qty">Tổng số lượng</label>
                <input
                  id="mg-ov-qty"
                  type="number"
                  min="0"
                  value={ovQty}
                  onChange={(e) => setOvQty(e.target.value)}
                  placeholder={defaultQty || '(mặc định = tổng cộng dồn)'}
                />
              </div>
              <div className="form-field">
                <label htmlFor="mg-ov-max">Hạn mức / user</label>
                <input
                  id="mg-ov-max"
                  type="number"
                  min="1"
                  value={ovMax}
                  onChange={(e) => setOvMax(e.target.value)}
                  placeholder="(giữ hạn mức survivor)"
                />
              </div>
              <div className="form-field">
                <label htmlFor="mg-ov-email">Phát email sau merge</label>
                <select id="mg-ov-email" value={ovEmail} onChange={(e) => setOvEmail(e.target.value as any)}>
                  <option value="">(giữ giá trị survivor)</option>
                  <option value="true">Bật</option>
                  <option value="false">Tắt</option>
                </select>
              </div>
              <div className="form-field">
                <label htmlFor="mg-include-terminal">PreTicket lịch sử (DB công cụ vé)</label>
                <label className="check-label" htmlFor="mg-include-terminal">
                  <input
                    id="mg-include-terminal"
                    type="checkbox"
                    checked={includeTerminal}
                    onChange={(e) => setIncludeTerminal(e.target.checked)}
                  />{' '}
                  Gộp cả vé lịch sử (MINTED/LINKED/CLAIMED/EXPIRED) + job đã xong
                </label>
              </div>
            </div>
            <div className="form-actions">
              <Button
                variant="secondary"
                onClick={onDryRun}
                loading={planning}
                disabled={!eventId || !survivorId || loserIds.length === 0}
              >
                Xem báo cáo gộp (dry-run)
              </Button>
            </div>
          </Card>

          {(planning || plan) && (
            <Card title="3. Báo cáo dry-run">
              {planning ? (
                <Spinner />
              ) : !mt ? (
                <div className="empty">Chưa có báo cáo — bấm "Xem báo cáo gộp".</div>
              ) : (
                <div>
                  {mt.blockers.length > 0 && (
                    <div className="error-box" role="alert">
                      <strong>Blocker (không thể gộp):</strong>
                      <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                        {mt.blockers.map((b, i) => (
                          <li key={i}>{b}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {mt.shapeErrors.length > 0 && (
                    <div className="error-box" role="alert">
                      <strong>Lỗi input:</strong>
                      <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                        {mt.shapeErrors.map((b, i) => (
                          <li key={i}>{b}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {mt.warnings.length > 0 && (
                    <div style={{ background: '#fff8e1', padding: 12, borderRadius: 6, margin: '8px 0' }}>
                      <strong>Cảnh báo:</strong>
                      <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                        {mt.warnings.map((w, i) => (
                          <li key={i}>{w}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {localOk && (
                    <div className="hint" style={{ margin: '8px 0' }}>
                      DB công cụ vé: {localOk.counts.live.total} PreTicket đang chờ +{' '}
                      {localOk.counts.terminal.total} lịch sử + {localOk.counts.liveJobs.length} job
                      đang chạy sẽ trỏ về loại đích.
                      {localOk.alreadyRepointed ? ' (không còn row nào trỏ loại bị gộp.)' : ''}
                    </div>
                  )}
                  {proj && (
                    <div className="table-wrap">
                      <table className="table">
                        <thead>
                          <tr>
                            <th>Chỉ số</th>
                            <th>Trước</th>
                            <th>Sau merge</th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr>
                            <td>Tên loại đích</td>
                            <td>{types.find((t) => t.id === mt.survivorId)?.name ?? '—'}</td>
                            <td>{proj.name}</td>
                          </tr>
                          <tr>
                            <td>Giá</td>
                            <td>{types.find((t) => t.id === mt.survivorId)?.price ?? '—'}</td>
                            <td>{proj.price}</td>
                          </tr>
                          <tr>
                            <td>Số lượng</td>
                            <td>{types.find((t) => t.id === mt.survivorId)?.quantity ?? '—'}</td>
                            <td>{proj.quantity}</td>
                          </tr>
                          <tr>
                            <td>Đã phát (sold)</td>
                            <td>{types.find((t) => t.id === mt.survivorId)?.sold ?? '—'}</td>
                            <td>{proj.sold}</td>
                          </tr>
                          <tr>
                            <td>Hạn mức / user</td>
                            <td>{types.find((t) => t.id === mt.survivorId)?.maxTicketsPerUser ?? '—'}</td>
                            <td>{proj.maxTicketsPerUser}</td>
                          </tr>
                          <tr>
                            <td>Sức chứa event</td>
                            <td>{mt.maxParticipantsBefore ?? '—'}</td>
                            <td>{mt.maxParticipantsAfter ?? '—'}</td>
                          </tr>
                          <tr>
                            <td>Re-point</td>
                            <td>—</td>
                            <td>
                              {mt.movedCounts.tickets} vé · {mt.movedCounts.reservations} reservation ·{' '}
                              {mt.movedCounts.seats} ghế · {mt.movedCounts.giftCampaigns} chiến dịch quà
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  )}
                  <div className="form-field" style={{ marginTop: 12 }}>
                    <label htmlFor="mg-confirm">
                      Gõ <strong>MERGE</strong> để xác nhận thực thi ({loserIds.length} loại → 1)
                    </label>
                    <input
                      id="mg-confirm"
                      value={confirmText}
                      onChange={(e) => setConfirmText(e.target.value)}
                      placeholder="MERGE"
                    />
                  </div>
                  <div className="form-actions">
                    <Button
                      variant="danger"
                      loading={applying}
                      disabled={!mt.ok || confirmText !== 'MERGE'}
                      onClick={onApply}
                    >
                      Apply merge
                    </Button>
                  </div>
                </div>
              )}
            </Card>
          )}

          {applyResult && (
            <Card title="Merge hoàn tất">
              {applyResult.status === 'merged' && applyResult.content ? (
                <div>
                  <p>
                    Đã gộp {applyResult.content.mergedLosers.length} loại vé về{' '}
                    <strong>{(applyResult.content.survivor as any)?.name}</strong>. Di chuyển:{' '}
                    {applyResult.content.moved.tickets} vé, {applyResult.content.moved.reservations}{' '}
                    reservation, {applyResult.content.moved.seats} ghế,{' '}
                    {applyResult.content.moved.giftCampaigns} chiến dịch quà.
                    {applyResult.content.soldReconcile.drift
                      ? ` ⚠ sold counter ${applyResult.content.soldReconcile.counter} lệch COUNT thực ${applyResult.content.soldReconcile.dbCount} (không chặn merge).`
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
                          <td className="mono">{applyResult.local.repointAuditId}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                  <p className="hint">
                    Muốn hoàn tác: điền 2 id vào form Rollback bên dưới (nút "Điền từ kết quả merge").
                  </p>
                  <div className="form-actions">
                    <Button
                      variant="secondary"
                      onClick={() => {
                        if (!applyResult.content) return;
                        setRbAudit(applyResult.content.auditId);
                        setRbRepoint(applyResult.local.repointAuditId);
                      }}
                    >
                      Điền từ kết quả merge
                    </Button>
                  </div>
                </div>
              ) : (
                <div>
                  <p>
                    ⚠ {applyResult.note ??
                      'Content trả lỗi nhưng merge có thể ĐÃ commit (loser không còn). Liên hệ kỹ sư xác nhận auditId trước khi rollback/retry.'}
                  </p>
                  <div className="table-wrap">
                    <table className="table">
                      <tbody>
                        <tr>
                          <th>repointAuditId (DB công cụ vé)</th>
                          <td className="mono">{applyResult.local.repointAuditId}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </Card>
          )}

          <Card title="Rollback merge (nếu cần hoàn tác)">
            <p className="card-sub">
              Rollback tạo lại đúng các loại vé đã gộp (giữ nguyên id, số lượng, giá cũ) và trỏ
              vé/reservation/ghế về lại. Chỉ rollback được loại vé đích chưa bị gộp tiếp.
            </p>
            <div className="form-grid">
              <div className="form-field">
                <label htmlFor="rb-audit">contentAuditId</label>
                <input id="rb-audit" className="mono" value={rbAudit} onChange={(e) => setRbAudit(e.target.value)} />
              </div>
              <div className="form-field">
                <label htmlFor="rb-repoint">repointAuditId (tùy chọn)</label>
                <input
                  id="rb-repoint"
                  className="mono"
                  value={rbRepoint}
                  onChange={(e) => setRbRepoint(e.target.value)}
                />
              </div>
            </div>
            <div className="form-field">
              <label htmlFor="rb-confirm">
                Gõ <strong>ROLLBACK</strong> để xác nhận
              </label>
              <input id="rb-confirm" value={rbConfirm} onChange={(e) => setRbConfirm(e.target.value)} />
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
                Đã rollback merge {rbResult.content?.auditId ?? rbAudit}: khôi phục{' '}
                {rbResult.content?.restored.tickets ?? '?'} vé,{' '}
                {rbResult.content?.restored.reservations ?? '?'} reservation về{' '}
                {(rbResult.content?.restoredLosers ?? []).length} loại vé.{' '}
                {rbResult.local
                  ? `DB công cụ vé: ${rbResult.local.movedPreTickets} PreTicket + ${rbResult.local.movedJobs} job đã về loại cũ.`
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
