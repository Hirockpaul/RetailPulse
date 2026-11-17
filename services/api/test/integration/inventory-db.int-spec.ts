/**
 * Database-level guarantees from migration 0002 (docs/ARCHITECTURE.md §3).
 * Each test runs in its own transaction and rolls back, except the concurrency test.
 */
import pg from 'pg';
import { prepareTestDatabase, releaseTestDatabase } from './test-db';

let url: string;
let db: pg.Client;
let productId: string;
let storeId: string;

const PG = { CHECK: '23514', UNIQUE: '23505', RESTRICT: '23001' };

beforeAll(async () => {
  url = await prepareTestDatabase();
  db = new pg.Client({ connectionString: url });
  await db.connect();
  const { rows } = await db.query(
    `SELECT p.id AS product_id, l.id AS location_id
       FROM products p, locations l
      WHERE p.sku = 'RP-00001' AND l.code = 'STR-01'`,
  );
  productId = rows[0].product_id;
  storeId = rows[0].location_id;
}, 60_000);

afterAll(async () => {
  await db?.end();
  await releaseTestDatabase();
});

beforeEach(() => db.query('BEGIN'));
afterEach(() => db.query('ROLLBACK'));

/** Put the test balance in a known state: on_hand = 10, reserved = 0 (via the ledger). */
async function setOnHandTo10() {
  const { rows } = await db.query(
    'SELECT on_hand FROM inventory_balances WHERE product_id = $1 AND location_id = $2',
    [productId, storeId],
  );
  const delta = 10 - (rows[0]?.on_hand ?? 0);
  if (delta !== 0) await move('ADJUSTMENT', delta, 0, 'test setup');
}

function move(type: string, onHandDelta: number, reservedDelta = 0, reason: string | null = null) {
  return db.query(
    `INSERT INTO inventory_ledger
       (product_id, location_id, movement_type, on_hand_delta, reserved_delta, reason)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING on_hand_after, reserved_after`,
    [productId, storeId, type, onHandDelta, reservedDelta, reason],
  );
}

async function balance() {
  const { rows } = await db.query(
    'SELECT on_hand, reserved FROM inventory_balances WHERE product_id = $1 AND location_id = $2',
    [productId, storeId],
  );
  return { onHand: rows[0].on_hand as number, reserved: rows[0].reserved as number };
}

describe('ledger drives balances', () => {
  it('receipt increases on-hand and records after-values', async () => {
    await setOnHandTo10();
    const { rows } = await move('RECEIPT', 5);
    expect(rows[0]).toEqual({ on_hand_after: 15, reserved_after: 0 });
    expect(await balance()).toEqual({ onHand: 15, reserved: 0 });
  });

  it('sale reduces on-hand', async () => {
    await setOnHandTo10();
    await move('SALE', -3);
    expect(await balance()).toEqual({ onHand: 7, reserved: 0 });
  });

  it('reservation reduces available without changing on-hand; release restores it', async () => {
    await setOnHandTo10();
    await move('RESERVATION', 0, 4);
    expect(await balance()).toEqual({ onHand: 10, reserved: 4 });
    await move('RESERVATION_RELEASE', 0, -4);
    expect(await balance()).toEqual({ onHand: 10, reserved: 0 });
  });

  it('creates the balance row on the first movement for a new product/location', async () => {
    const { rows } = await db.query(
      `INSERT INTO products (sku, name, category_id, unit_price)
       SELECT 'TEST-NEW-1', 'Test product', id, 1.00 FROM categories LIMIT 1 RETURNING id`,
    );
    await db.query(
      `INSERT INTO inventory_ledger (product_id, location_id, movement_type, on_hand_delta)
       VALUES ($1, $2, 'RECEIPT', 12)`,
      [rows[0].id, storeId],
    );
    const b = await db.query(
      'SELECT on_hand FROM inventory_balances WHERE product_id = $1 AND location_id = $2',
      [rows[0].id, storeId],
    );
    expect(b.rows[0].on_hand).toBe(12);
  });
});

describe('stock can never go negative or oversell', () => {
  it('rejects a sale larger than on-hand', async () => {
    await setOnHandTo10();
    await expect(move('SALE', -11)).rejects.toMatchObject({ code: PG.CHECK });
  });

  it('rejects a sale that would consume reserved units (available = on_hand - reserved)', async () => {
    await setOnHandTo10();
    await move('RESERVATION', 0, 8);
    await expect(move('SALE', -3)).rejects.toMatchObject({
      code: PG.CHECK,
      constraint: 'inventory_reserved_within_on_hand',
    });
  });

  it('rejects reserving more than on-hand', async () => {
    await setOnHandTo10();
    await expect(move('RESERVATION', 0, 11)).rejects.toMatchObject({ code: PG.CHECK });
  });
});

describe('movement types are direction-checked', () => {
  it.each([
    ['SALE', 5, 0],
    ['RECEIPT', -5, 0],
    ['TRANSFER_OUT', 5, 0],
    ['TRANSFER_IN', -5, 0],
    ['RESERVATION', -1, 1],
    ['RESERVATION_RELEASE', 0, 1],
  ])('rejects %s with on_hand_delta=%i reserved_delta=%i', async (type, oh, r) => {
    await setOnHandTo10();
    await expect(move(type, oh, r)).rejects.toMatchObject({
      code: PG.CHECK,
      constraint: 'ledger_delta_matches_type',
    });
  });

  it('requires a reason for adjustments', async () => {
    await expect(move('ADJUSTMENT', 1, 0, '  ')).rejects.toMatchObject({
      code: PG.CHECK,
      constraint: 'ledger_adjustment_needs_reason',
    });
  });
});

describe('no untraceable edits', () => {
  it('rejects a direct UPDATE of a balance', async () => {
    await expect(
      db.query('UPDATE inventory_balances SET on_hand = 999 WHERE product_id = $1', [productId]),
    ).rejects.toMatchObject({ code: PG.RESTRICT });
  });

  it('rejects a direct INSERT of a non-zero balance', async () => {
    const { rows } = await db.query(
      `INSERT INTO products (sku, name, category_id, unit_price)
       SELECT 'TEST-NEW-2', 'Test product', id, 1.00 FROM categories LIMIT 1 RETURNING id`,
    );
    await expect(
      db.query(
        'INSERT INTO inventory_balances (product_id, location_id, on_hand) VALUES ($1, $2, 5)',
        [rows[0].id, storeId],
      ),
    ).rejects.toMatchObject({ code: PG.RESTRICT });
  });

  it('rejects UPDATE of a ledger row', async () => {
    await expect(
      db.query('UPDATE inventory_ledger SET on_hand_delta = 1000 WHERE product_id = $1', [
        productId,
      ]),
    ).rejects.toMatchObject({ code: PG.RESTRICT });
  });

  it('rejects DELETE of a ledger row', async () => {
    await expect(
      db.query('DELETE FROM inventory_ledger WHERE product_id = $1', [productId]),
    ).rejects.toMatchObject({ code: PG.RESTRICT });
  });
});

describe('catalog constraints', () => {
  it('rejects a duplicate SKU, case-insensitively', async () => {
    await expect(
      db.query(
        `INSERT INTO products (sku, name, category_id, unit_price)
         SELECT 'rp-00001', 'Duplicate', id, 1.00 FROM categories LIMIT 1`,
      ),
    ).rejects.toMatchObject({ code: PG.UNIQUE });
  });

  it('rejects negative prices and zero pack sizes', async () => {
    await expect(
      db.query(
        `INSERT INTO products (sku, name, category_id, unit_price)
         SELECT 'TEST-NEG', 'Bad', id, -1 FROM categories LIMIT 1`,
      ),
    ).rejects.toMatchObject({ code: PG.CHECK });
  });

  it('allows only one primary supplier per product', async () => {
    await expect(
      db.query(
        `INSERT INTO supplier_products
           (supplier_id, product_id, lead_time_days, min_order_qty, unit_cost, is_primary)
         SELECT s.id, $1, 3, 10, 1.00, true
           FROM suppliers s
          WHERE NOT EXISTS (SELECT 1 FROM supplier_products sp
                             WHERE sp.supplier_id = s.id AND sp.product_id = $1)
          LIMIT 1`,
        [productId],
      ),
    ).rejects.toMatchObject({ code: PG.UNIQUE });
  });
});

describe('seeded data', () => {
  it('every balance equals the sum of its ledger entries', async () => {
    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS mismatches
         FROM inventory_balances b
         LEFT JOIN (SELECT product_id, location_id,
                           SUM(on_hand_delta) AS oh, SUM(reserved_delta) AS r
                      FROM inventory_ledger GROUP BY 1, 2) s USING (product_id, location_id)
        WHERE b.on_hand <> COALESCE(s.oh, 0) OR b.reserved <> COALESCE(s.r, 0)`,
    );
    expect(rows[0].mismatches).toBe(0);
  });
});

describe('concurrency', () => {
  // Runs outside the per-test transaction: two real sessions race for the same 10 units.
  beforeEach(() => db.query('ROLLBACK'));
  afterEach(() => db.query('BEGIN'));

  it('two concurrent sales of 6 units against 10 on hand: exactly one succeeds', async () => {
    await db.query('BEGIN');
    await setOnHandTo10();
    await db.query('COMMIT');

    const sell = async () => {
      const c = new pg.Client({ connectionString: url });
      await c.connect();
      try {
        await c.query('BEGIN');
        await c.query(
          `INSERT INTO inventory_ledger (product_id, location_id, movement_type, on_hand_delta)
           VALUES ($1, $2, 'SALE', -6)`,
          [productId, storeId],
        );
        await c.query('SELECT pg_sleep(0.05)'); // hold the row lock briefly
        await c.query('COMMIT');
        return 'ok';
      } catch {
        await c.query('ROLLBACK');
        return 'rejected';
      } finally {
        await c.end();
      }
    };

    const results = await Promise.all([sell(), sell()]);
    expect(results.sort()).toEqual(['ok', 'rejected']);
    expect(await balance()).toEqual({ onHand: 4, reserved: 0 });
  });
});
