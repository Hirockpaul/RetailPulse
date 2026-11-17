import { Empty, Loading } from './components/Status';
import { AuthProvider, useAuth, useUser } from './lib/auth';
import { ROLE_LABEL } from './lib/permissions';
import { href, type Route, useRoute } from './lib/router';
import { HealthPage } from './pages/HealthPage';
import { LoginPage } from './pages/LoginPage';
import { ProductDetailPage } from './pages/ProductDetailPage';
import { ProductsPage } from './pages/ProductsPage';
import { StockPage } from './pages/StockPage';
import { TransferDetailPage } from './pages/TransferDetailPage';
import { TransfersPage } from './pages/TransfersPage';

const NAV: { label: string; to: string; active: (r: Route) => boolean }[] = [
  {
    label: 'Products',
    to: href.products(),
    active: (r) => r.name === 'products' || r.name === 'product',
  },
  { label: 'Stock', to: href.stock(), active: (r) => r.name === 'stock' },
  {
    label: 'Transfers',
    to: href.transfers(),
    active: (r) => r.name === 'transfers' || r.name === 'transfer',
  },
  { label: 'Health', to: href.health(), active: (r) => r.name === 'health' },
];

function Page({ route }: { route: Route }) {
  switch (route.name) {
    case 'products':
      return <ProductsPage />;
    case 'product':
      return <ProductDetailPage key={route.id} id={route.id} />;
    case 'stock':
      return <StockPage locationId={route.locationId} />;
    case 'transfers':
      return <TransfersPage />;
    case 'transfer':
      return <TransferDetailPage key={route.id} id={route.id} />;
    case 'health':
      return <HealthPage />;
    default:
      return <Empty>Page not found.</Empty>;
  }
}

function UserMenu() {
  const user = useUser();
  const { signOut } = useAuth();
  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="text-right">
        <span className="block font-medium leading-tight">{user.displayName}</span>
        <span className="block text-xs text-slate-500">{ROLE_LABEL[user.role]}</span>
      </span>
      <button
        type="button"
        onClick={signOut}
        className="rounded border px-3 py-1 hover:bg-slate-100 focus:outline-2 focus:outline-sky-500"
      >
        Sign out
      </button>
    </div>
  );
}

/** Layout shell. Shows the login screen until a session exists. */
function Shell() {
  const route = useRoute();
  const { state } = useAuth();
  const signedIn = state.status === 'authenticated';

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-6">
            <h1 className="text-lg font-semibold">RetailPulse</h1>
            {signedIn && (
              <nav aria-label="Main" className="flex gap-1">
                {NAV.map((item) => {
                  const active = item.active(route);
                  return (
                    <a
                      key={item.label}
                      href={item.to}
                      aria-current={active ? 'page' : undefined}
                      className={`rounded px-3 py-1.5 text-sm focus:outline-2 focus:outline-sky-500 ${
                        active ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-100'
                      }`}
                    >
                      {item.label}
                    </a>
                  );
                })}
              </nav>
            )}
          </div>
          <div className="flex items-center gap-4">
            <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
              Synthetic demo data
            </span>
            {signedIn && <UserMenu />}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8">
        {state.status === 'loading' && <Loading />}
        {state.status === 'anonymous' && <LoginPage />}
        {state.status === 'authenticated' && <Page route={route} />}
      </main>
    </div>
  );
}

export function App() {
  return (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  );
}
