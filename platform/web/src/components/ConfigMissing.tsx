export function ConfigMissing() {
  return (
    <div className="page">
      <div className="state state--error" role="alert">
        <p className="state__title">Skeuos is not configured</p>
        <p>
          Set <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> (copy <code>.env.example</code> to{' '}
          <code>.env.local</code>) and restart the dev server.
        </p>
      </div>
    </div>
  );
}
