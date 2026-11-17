import { HealthPage } from './pages/HealthPage';

/** Layout shell: header + current page. Navigation between pages is added on Day 2. */
export function App() {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-3">
          <h1 className="text-lg font-semibold">RetailPulse</h1>
          <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
            Synthetic demo data
          </span>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-4 py-8">
        <HealthPage />
      </main>
    </div>
  );
}
