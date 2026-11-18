import { Empty, Loading } from './components/Status';
import { AuthProvider, useAuth, useUser } from './lib/auth';
import { ROLE_LABEL } from './lib/permissions';
import { href, type Route, useRoute } from './lib/router';
import { AlertsPage } from './pages/AlertsPage';
import { AnomaliesPage } from './pages/AnomaliesPage';
import { AnomalyDetailPage } from './pages/AnomalyDetailPage';
import { ClassificationPage } from './pages/ClassificationPage';
import { HealthPage } from './pages/HealthPage';
import { PurchaseOrderDetailPage } from './pages/PurchaseOrderDetailPage';
import { PurchaseOrdersPage } from './pages/PurchaseOrdersPage';
import { RecommendationDetailPage } from './pages/RecommendationDetailPage';
import { ReplenishmentPage } from './pages/ReplenishmentPage';
import { LoginPage } from './pages/LoginPage';
import { OverviewPage } from './pages/OverviewPage';
import { ProductDetailPage } from './pages/ProductDetailPage';
import { ProductsPage } from './pages/ProductsPage';
import { StockPage } from './pages/StockPage';
import { SupplierDetailPage, SuppliersPage } from './pages/SuppliersPage';
import { TransferDetailPage } from './pages/TransferDetailPage';
import { TransfersPage } from './pages/TransfersPage';

const NAV: { label: string; to: string; active: (r: Route) => boolean }[] = [
  { label: 'Overview', to: href.overview(), active: (r) => r.name === 'overview' },
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
  {
    label: 'Replenishment',
    to: href.replenishment(),
    active: (r) => r.name === 'replenishment' || r.name === 'recommendation',
  },
  { label: 'ABC/XYZ', to: href.classification(), active: (r) => r.name === 'classification' },
  {
    label: 'Suppliers',
    to: href.suppliers(),
    active: (r) => r.name === 'suppliers' || r.name === 'supplier',
  },
  {
    label: 'Purchase orders',
    to: href.purchaseOrders(),
    active: (r) => r.name === 'purchaseOrders' || r.name === 'purchaseOrder',
  },
  { label: 'Alerts', to: href.alerts(), active: (r) => r.name === 'alerts' },
  {
    label: 'Unusual activity',
    to: href.anomalies(),
    active: (r) => r.name === 'anomalies' || r.name === 'anomaly',
  },
  { label: 'Health', to: href.health(), active: (r) => r.name === 'health' },
];

function Page({ route }: { route: Route }) {
  switch (route.name) {
    case 'overview':
      return <OverviewPage />;
    case 'products':
      return <ProductsPage />;
    case 'product':
      return <ProductDetailPage key={route.id} id={route.id} />;
    case 'stock':
      return <StockPage locationId={route.locationId} />;
    case 'alerts':
      return <AlertsPage />;
    case 'anomalies':
      return <AnomaliesPage />;
    case 'classification':
      return <ClassificationPage />;
    case 'suppliers':
      return <SuppliersPage />;
    case 'supplier':
      return <SupplierDetailPage key={route.id} id={route.id} />;
    case 'anomaly':
      return <AnomalyDetailPage key={route.id} id={route.id} />;
    case 'replenishment':
      return <ReplenishmentPage />;
    case 'recommendation':
      return <RecommendationDetailPage key={route.id} id={route.id} />;
    case 'purchaseOrders':
      return <PurchaseOrdersPage />;
    case 'purchaseOrder':
      return <PurchaseOrderDetailPage key={route.id} id={route.id} />;
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
              <nav aria-label="Main" className="flex flex-wrap gap-1">
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
