// Synthetic demo data for RetailPulse. ALL DATA IS FICTIONAL.
//
// Deterministic: a fixed RNG seed produces the same catalog and quantities on every run
// (UUIDs differ). Safe to re-run: does nothing if products already exist.
//
// Usage: npm run db:seed                         seed an empty database
//        npm run db:seed -- --reset              wipe catalog/inventory, then seed
//        npm run db:seed -- --reset --products=500
//
// Opening stock is written as RECEIPT ledger rows, so balances are traceable from day one.
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const rootEnv = resolve(here, '../../../.env');
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const args = process.argv.slice(2);
const reset = args.includes('--reset');
const productCount = Number(args.find((a) => a.startsWith('--products='))?.split('=')[1] ?? 200);

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set (copy .env.example to .env).');
  process.exit(1);
}
if (!Number.isInteger(productCount) || productCount < 1 || productCount > 5000) {
  console.error('--products must be an integer between 1 and 5000.');
  process.exit(1);
}
if (reset && process.env.NODE_ENV === 'production') {
  console.error('Refusing to --reset when NODE_ENV=production.');
  process.exit(1);
}

// ------------------------------------------------------------ deterministic RNG (mulberry32)
let state = 20260101;
function rand() {
  state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const int = (min, max) => min + Math.floor(rand() * (max - min + 1));
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ------------------------------------------------------------ fictional reference data
const SUPPLIERS = [
  { code: 'SUP-HARBOR', name: 'Harbor Provisions (synthetic)', leadTime: [3, 7] },
  { code: 'SUP-SUMMIT', name: 'Summit Household Supply (synthetic)', leadTime: [5, 14] },
  { code: 'SUP-GREEN', name: 'Greenfield Fresh (synthetic)', leadTime: [1, 3] },
];

const CATEGORIES = [
  {
    name: 'Beverages',
    supplier: 'SUP-HARBOR',
    price: 2.5,
    packs: [6, 12, 24],
    items: ['Sparkling Water', 'Orange Juice', 'Cold Brew Coffee', 'Green Tea', 'Lemonade', 'Cola'],
  },
  {
    name: 'Snacks',
    supplier: 'SUP-HARBOR',
    price: 3,
    packs: [6, 12],
    items: ['Sea Salt Crisps', 'Trail Mix', 'Granola Bar', 'Pretzels', 'Popcorn', 'Rice Crackers'],
  },
  {
    name: 'Dairy',
    supplier: 'SUP-GREEN',
    price: 3.2,
    packs: [4, 6, 12],
    items: ['Whole Milk', 'Greek Yogurt', 'Cheddar Cheese', 'Butter', 'Oat Milk', 'Cottage Cheese'],
  },
  {
    name: 'Bakery',
    supplier: 'SUP-GREEN',
    price: 3.5,
    packs: [4, 6],
    items: ['Sourdough Loaf', 'Bagels', 'Croissants', 'Whole Wheat Bread', 'Muffins', 'Tortillas'],
  },
  {
    name: 'Household',
    supplier: 'SUP-SUMMIT',
    price: 5,
    packs: [4, 6, 12],
    items: [
      'Dish Soap',
      'Paper Towels',
      'Laundry Detergent',
      'Trash Bags',
      'Sponges',
      'Glass Cleaner',
    ],
  },
  {
    name: 'Personal Care',
    supplier: 'SUP-SUMMIT',
    price: 4.5,
    packs: [6, 12],
    items: ['Shampoo', 'Toothpaste', 'Hand Soap', 'Body Lotion', 'Deodorant', 'Lip Balm'],
  },
  {
    name: 'Frozen',
    supplier: 'SUP-HARBOR',
    price: 5.5,
    packs: [6, 12],
    items: [
      'Frozen Peas',
      'Ice Cream',
      'Frozen Pizza',
      'Fish Fillets',
      'Berry Mix',
      'Veggie Burgers',
    ],
  },
  {
    name: 'Produce',
    supplier: 'SUP-GREEN',
    price: 1.8,
    packs: [1, 6, 12],
    items: ['Bananas', 'Apples', 'Carrots', 'Spinach', 'Tomatoes', 'Avocados'],
  },
];
const BRANDS = ['Brightfield', 'Oakmere', 'Sunvale', 'Copperleaf', 'Northbay'];
const SIZES = [
  { label: 'Small', factor: 0.7 },
  { label: 'Regular', factor: 1 },
  { label: 'Large', factor: 1.5 },
  { label: 'Family', factor: 2.2 },
];

const LOCATIONS = [
  { code: 'STR-01', name: 'Riverside Store', type: 'STORE', city: 'Port Alder' },
  { code: 'STR-02', name: 'Hillcrest Store', type: 'STORE', city: 'Brookhaven' },
  { code: 'STR-03', name: 'Lakeview Store', type: 'STORE', city: 'Elm City' },
  { code: 'STR-04', name: 'Old Town Store', type: 'STORE', city: 'Port Alder' },
  { code: 'STR-05', name: 'Meadowbrook Store', type: 'STORE', city: 'Fairmont' },
  {
    code: 'DC-NORTH',
    name: 'North Distribution Centre',
    type: 'DISTRIBUTION_CENTER',
    city: 'Brookhaven',
  },
  {
    code: 'DC-SOUTH',
    name: 'South Distribution Centre',
    type: 'DISTRIBUTION_CENTER',
    city: 'Fairmont',
  },
];

// ------------------------------------------------------------ build the dataset in memory
const combos = [];
for (const cat of CATEGORIES)
  for (const item of cat.items)
    for (const brand of BRANDS) for (const size of SIZES) combos.push({ cat, item, brand, size });
if (productCount > combos.length) {
  console.error(`At most ${combos.length} distinct synthetic products can be generated.`);
  process.exit(1);
}

const products = shuffle(combos)
  .slice(0, productCount)
  .map((c, i) => ({
    sku: `RP-${String(i + 1).padStart(5, '0')}`,
    name: `${c.brand} ${c.item} — ${c.size.label}`,
    category: c.cat.name,
    unitPrice: (c.cat.price * c.size.factor * (0.85 + rand() * 0.3)).toFixed(2),
    packSize: pick(c.cat.packs),
    primarySupplier: c.cat.supplier,
  }));

// ------------------------------------------------------------ write
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

try {
  await client.query('BEGIN');

  if (reset) {
    // TRUNCATE bypasses the row-level append-only trigger by design: dev reset only.
    await client.query(`TRUNCATE idempotency_keys, reservations, sales_order_lines, sales_orders,
                        inventory_ledger, inventory_balances, supplier_products,
                        products, categories, suppliers, locations RESTART IDENTITY CASCADE`);
  } else {
    const { rows } = await client.query('SELECT COUNT(*)::int AS n FROM products');
    if (rows[0].n > 0) {
      console.log(`Already seeded (${rows[0].n} products). Use --reset to recreate.`);
      await client.query('ROLLBACK');
      process.exit(0);
    }
  }

  const ids = async (sql, params, key) =>
    new Map((await client.query(sql, params)).rows.map((r) => [r[key], r.id]));

  const categoryIds = await ids(
    `INSERT INTO categories (name) SELECT unnest($1::text[]) RETURNING id, name::text`,
    [CATEGORIES.map((c) => c.name)],
    'name',
  );
  const supplierIds = await ids(
    `INSERT INTO suppliers (code, name) SELECT * FROM unnest($1::text[], $2::text[])
     RETURNING id, code::text`,
    [SUPPLIERS.map((s) => s.code), SUPPLIERS.map((s) => s.name)],
    'code',
  );
  const locationIds = await ids(
    `INSERT INTO locations (code, name, type, city)
     SELECT * FROM unnest($1::text[], $2::text[], $3::location_type[], $4::text[])
     RETURNING id, code::text`,
    ['code', 'name', 'type', 'city'].map((k) => LOCATIONS.map((l) => l[k])),
    'code',
  );
  const productIds = await ids(
    `INSERT INTO products (sku, name, category_id, unit_price, pack_size)
     SELECT * FROM unnest($1::text[], $2::text[], $3::uuid[], $4::numeric[], $5::int[])
     RETURNING id, sku::text`,
    [
      products.map((p) => p.sku),
      products.map((p) => p.name),
      products.map((p) => categoryIds.get(p.category)),
      products.map((p) => p.unitPrice),
      products.map((p) => p.packSize),
    ],
    'sku',
  );

  // Supplier terms: one primary supplier per product, ~30% also have a slower backup supplier.
  const sp = [];
  for (const p of products) {
    const primary = SUPPLIERS.find((s) => s.code === p.primarySupplier);
    const terms = (s, slower) => ({
      supplierId: supplierIds.get(s.code),
      productId: productIds.get(p.sku),
      leadTime: int(s.leadTime[0], s.leadTime[1]) + (slower ? int(2, 5) : 0),
      moq: p.packSize * int(2, 10),
      unitCost: (Number(p.unitPrice) * (0.55 + rand() * 0.15)).toFixed(2),
      isPrimary: !slower,
    });
    sp.push(terms(primary, false));
    if (rand() < 0.3) sp.push(terms(pick(SUPPLIERS.filter((s) => s !== primary)), true));
  }
  await client.query(
    `INSERT INTO supplier_products
       (supplier_id, product_id, lead_time_days, min_order_qty, unit_cost, is_primary)
     SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::int[], $4::int[], $5::numeric[], $6::bool[])`,
    ['supplierId', 'productId', 'leadTime', 'moq', 'unitCost', 'isPrimary'].map((k) =>
      sp.map((r) => r[k]),
    ),
  );

  // Opening stock. Stores: 0–80 units (~10% start empty to demo low stock). DCs: 100–600.
  const receipts = { productId: [], locationId: [], qty: [] };
  const empty = { productId: [], locationId: [] };
  for (const p of products) {
    for (const l of LOCATIONS) {
      const qty = l.type === 'STORE' ? (rand() < 0.1 ? 0 : int(1, 80)) : int(100, 600);
      const target = qty > 0 ? receipts : empty;
      target.productId.push(productIds.get(p.sku));
      target.locationId.push(locationIds.get(l.code));
      if (qty > 0) receipts.qty.push(qty);
    }
  }
  await client.query(
    `INSERT INTO inventory_balances (product_id, location_id)
     SELECT * FROM unnest($1::uuid[], $2::uuid[])`,
    [empty.productId, empty.locationId],
  );
  await client.query(
    `INSERT INTO inventory_ledger
       (product_id, location_id, movement_type, on_hand_delta, reason, reference_type, reference_id)
     SELECT p, l, 'RECEIPT', q, 'Opening stock (synthetic seed)', 'SEED', 'seed-v1'
       FROM unnest($1::uuid[], $2::uuid[], $3::int[]) AS t(p, l, q)`,
    [receipts.productId, receipts.locationId, receipts.qty],
  );

  await client.query('COMMIT');
  console.log(
    `Seeded synthetic data: ${CATEGORIES.length} categories, ${SUPPLIERS.length} suppliers, ` +
      `${LOCATIONS.length} locations, ${products.length} products, ${sp.length} supplier terms, ` +
      `${receipts.qty.length} opening-stock receipts.`,
  );
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(`Seed failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
