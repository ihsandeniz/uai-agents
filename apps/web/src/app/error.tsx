'use client';

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
      <div
        style={{
          maxWidth: 440,
          textAlign: 'center',
          background: 'var(--card)',
          border: '1px solid var(--line-2)',
          borderRadius: 14,
          padding: '28px 24px',
        }}
      >
        <div style={{ fontSize: 28, marginBottom: 8 }}>⚠️</div>
        <h2 style={{ fontSize: 16, fontWeight: 650, marginBottom: 8 }}>Bir şeyler ters gitti</h2>
        <p style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 18, wordBreak: 'break-word' }}>
          {error.message || 'Beklenmeyen bir hata oluştu.'}
        </p>
        <button className="btn-primary" style={{ margin: '0 auto' }} onClick={() => reset()}>
          Tekrar dene
        </button>
      </div>
    </div>
  );
}
