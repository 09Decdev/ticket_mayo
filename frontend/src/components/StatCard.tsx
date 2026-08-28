import type { ReactNode } from 'react';

type Accent = 'blue' | 'green' | 'red' | 'amber' | 'violet';

const accentCls: Record<Accent, string> = {
  blue: 'stat-blue',
  green: 'stat-green',
  red: 'stat-red',
  amber: 'stat-amber',
  violet: 'stat-violet',
};

interface StatCardProps {
  label: string;
  value: ReactNode;
  icon?: ReactNode;
  accent?: Accent;
  sub?: ReactNode;
  unit?: string;
}

export function StatCard({ label, value, icon, accent = 'blue', sub, unit }: StatCardProps) {
  return (
    <div className={`stat ${accentCls[accent]}`}>
      <div className="stat-head">
        <div className="label">{label}</div>
        {icon && <div className="stat-icon">{icon}</div>}
      </div>
      <div className="value">
        {value}
        {unit != null && <span className="unit">{unit}</span>}
      </div>
      {sub != null && <div className="sub">{sub}</div>}
    </div>
  );
}