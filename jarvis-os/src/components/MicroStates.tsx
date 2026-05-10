import { type ReactNode } from 'react';

interface SkeletonProps {
  width?: string;
  height?: string;
  borderRadius?: string;
  style?: React.CSSProperties;
}

export function Skeleton({ width = '100%', height = '16px', borderRadius = '4px', style }: SkeletonProps) {
  return (
    <div
      className="skeleton"
      style={{ width, height, borderRadius, ...style }}
    />
  );
}

export function SkeletonCard({ lines = 3 }: { lines?: number }) {
  return (
    <div className="panel" style={{ padding: '20px' }}>
      <Skeleton width="60%" height="18px" style={{ marginBottom: '16px' }} />
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton
          key={i}
          width={`${70 + Math.random() * 30}%`}
          height="14px"
          style={{ marginBottom: '10px' }}
        />
      ))}
      <Skeleton width="40%" height="14px" style={{ marginTop: '8px' }} />
    </div>
  );
}

export function SkeletonTable({ rows = 5, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div className="panel">
      <div style={{ display: 'flex', gap: '8px', padding: '12px', borderBottom: '1px solid var(--border-color)' }}>
        {Array.from({ length: cols }).map((_, i) => (
          <Skeleton key={i} width={`${100 / cols}%`} height="14px" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} style={{ display: 'flex', gap: '8px', padding: '10px 12px', borderBottom: '1px solid var(--border-color)' }}>
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton key={c} width={`${80 / cols}%`} height="12px" />
          ))}
        </div>
      ))}
    </div>
  );
}

interface EmptyStateProps {
  icon?: string;
  title: string;
  description?: string;
  action?: ReactNode;
}

export function EmptyState({ icon = '📭', title, description, action }: EmptyStateProps) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      padding: '48px 24px', textAlign: 'center', color: 'var(--text-tertiary)',
      border: '1px dashed var(--border-color)', borderRadius: '8px', margin: '16px 0',
    }}>
      <div style={{ fontSize: '2.5rem', marginBottom: '12px' }}>{icon}</div>
      <div style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '6px', color: 'var(--text-primary)' }}>
        {title}
      </div>
      {description && (
        <div style={{ fontSize: '0.85rem', maxWidth: '400px', lineHeight: 1.5 }}>
          {description}
        </div>
      )}
      {action && <div style={{ marginTop: '16px' }}>{action}</div>}
    </div>
  );
}

interface ErrorStateProps {
  message?: string;
  onRetry?: () => void;
  compact?: boolean;
}

export function ErrorState({ message = 'Error al cargar datos', onRetry, compact }: ErrorStateProps) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      padding: compact ? '16px' : '48px 24px', textAlign: 'center',
      border: '1px solid var(--accent-red)', borderRadius: '8px', margin: '16px 0',
      backgroundColor: 'rgba(255, 51, 51, 0.05)',
    }}>
      <div style={{ fontSize: '1.5rem', marginBottom: '8px' }}>⚠️</div>
      <div style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--accent-red)', marginBottom: '4px' }}>
        {message}
      </div>
      {onRetry && (
        <button
          onClick={onRetry}
          className="btn-ghost"
          style={{
            marginTop: '12px', padding: '6px 16px',
            border: '1px solid var(--accent-red)', borderRadius: '4px',
            backgroundColor: 'transparent', color: 'var(--accent-red)',
            cursor: 'pointer', fontWeight: 600, fontFamily: 'var(--font-mono)', fontSize: '0.8rem',
          }}
        >
          REINTENTAR
        </button>
      )}
    </div>
  );
}

export function Badge({ label, variant = 'default' }: { label: string; variant?: 'success' | 'warning' | 'error' | 'info' | 'default' }) {
  const colors: Record<string, { bg: string; text: string; border: string }> = {
    success: { bg: 'rgba(0,255,0,0.1)', text: 'var(--accent-green)', border: 'var(--accent-green)' },
    warning: { bg: 'rgba(255,193,7,0.1)', text: '#ffc107', border: '#ffc107' },
    error: { bg: 'rgba(255,51,51,0.1)', text: 'var(--accent-red)', border: 'var(--accent-red)' },
    info: { bg: 'rgba(41,98,255,0.1)', text: '#2962ff', border: '#2962ff' },
    default: { bg: 'rgba(255,255,255,0.05)', text: 'var(--text-secondary)', border: 'var(--border-color)' },
  };
  const c = colors[variant] || colors.default;
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', fontSize: '0.7rem', fontWeight: 600,
      fontFamily: 'var(--font-mono)', borderRadius: '3px',
      backgroundColor: c.bg, color: c.text, border: `1px solid ${c.border}`,
    }}>
      {label}
    </span>
  );
}
