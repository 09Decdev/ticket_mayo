import { createContext, PropsWithChildren, useCallback, useContext, useEffect, useMemo, useState } from 'react';

export interface DistributionDraft {
  emails: string[];
  ticketTypeId?: string;
  ticketTypeName?: string;
  /** Snapshot số vé còn lại của loại vé đã chọn (content-service) — hiển thị ở bước xác nhận. */
  ticketTypeRemaining?: number;
  eventId?: string;
  eventName?: string;
  quantity: number;
}

const STORE_KEY = 'tm_distribution_draft';

const Ctx = createContext<{
  draft: DistributionDraft;
  setDraft: (patch: Partial<DistributionDraft>) => void;
  clear: () => void;
}>({
  draft: { emails: [], quantity: 1 },
  setDraft: () => {},
  clear: () => {},
});

function readStore(): DistributionDraft {
  try {
    const raw = sessionStorage.getItem(STORE_KEY);
    if (!raw) return { emails: [], quantity: 1 };
    const parsed = JSON.parse(raw) as DistributionDraft;
    if (!Array.isArray(parsed.emails)) parsed.emails = [];
    if (typeof parsed.quantity !== 'number' || parsed.quantity < 1) parsed.quantity = 1;
    return parsed;
  } catch {
    return { emails: [], quantity: 1 };
  }
}

export function DistributionDraftProvider({ children }: PropsWithChildren) {
  const [draft, setDraftState] = useState<DistributionDraft>(() => readStore());

  useEffect(() => {
    try {
      sessionStorage.setItem(STORE_KEY, JSON.stringify(draft));
    } catch {
      // ignore quota errors
    }
  }, [draft]);

  const setDraft = useCallback((patch: Partial<DistributionDraft>) => {
    setDraftState((prev) => ({ ...prev, ...patch }));
  }, []);

  const clear = useCallback(() => {
    setDraftState({ emails: [], quantity: 1 });
    try {
      sessionStorage.removeItem(STORE_KEY);
    } catch {
      // ignore
    }
  }, []);

  const value = useMemo(() => ({ draft, setDraft, clear }), [draft, setDraft, clear]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useDistributionDraft() {
  return useContext(Ctx);
}
