import { Empty } from './components/Status';
import { href, type Route, useRoute } from './lib/router';
import { HealthPage } from './pages/HealthPage';
import { ProductDetailPage } from './pages/ProductDetailPage';
import { ProductsPage } from './pages/ProductsPage';
import { StockPage } from './pages/StockPage';

const NAV: { label: string; to: string; active: (r: Route) => boolean }[] = [
  {
    label: 'Products',
    to: href.products(),
    active: (r) => r.name === 'products' || r.name === 'product',
  },
  { label: 'Stock', to: href.stock(), active: (r) => r.name === 'stock' },
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
    case 'health':
      return <HealthPage />;
    default:
      return <Empty>Page not found.</Empty>;
  }
}

/** Layout shell: header, navigation, current page. */
export function App() {
  const route = useRoute();

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-6">
            <h1 className="text-lg font-semibold">RetailPulse</h1>
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
          </div>
          <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
            Synthetic demo data
          </span>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8">
        <Page route={route} />
      </main>
    </div>
  );
}
