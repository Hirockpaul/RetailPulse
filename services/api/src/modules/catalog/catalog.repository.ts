import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../core/database/database.service';
import { containsPattern } from '../../core/database/sql';
import { offsetOf } from '../../core/http/query';
import type { Category, ListProductsQuery, ProductDetail, ProductSummary } from './catalog.schemas';

const PRODUCT_COLUMNS = `
  p.id, p.sku, p.name,
  p.category_id  AS "categoryId",
  c.name         AS "categoryName",
  p.unit_price   AS "unitPrice",
  p.pack_size    AS "packSize",
  p.is_active    AS "isActive",
  COALESCE(s.on_hand, 0)::int   AS "totalOnHand",
  COALESCE(s.available, 0)::int AS "totalAvailable"`;

const PRODUCT_FROM = `
  FROM products p
  JOIN categories c ON c.id = p.category_id
  LEFT JOIN LATERAL (
    SELECT SUM(b.on_hand) AS on_hand, SUM(b.on_hand - b.reserved) AS available
      FROM inventory_balances b
     WHERE b.product_id = p.id
  ) s ON true`;

const PRODUCT_FILTER = `
  WHERE ($1::text IS NULL OR p.sku ILIKE $1 OR p.name ILIKE $1)
    AND ($2::uuid IS NULL OR p.category_id = $2)`;

@Injectable()
export class CatalogRepository {
  constructor(private readonly db: DatabaseService) {}

  async listProducts(q: ListProductsQuery): Promise<{ rows: ProductSummary[]; total: number }> {
    const filter = [containsPattern(q.q), q.categoryId ?? null];
    // q.sort is an allow-listed SQL expression produced by sortSchema, never raw input.
    const [rows, count] = await Promise.all([
      this.db.query<ProductSummary>(
        `SELECT ${PRODUCT_COLUMNS} ${PRODUCT_FROM} ${PRODUCT_FILTER}
         ORDER BY ${q.sort}, p.id
         LIMIT $3 OFFSET $4`,
        [...filter, q.pageSize, offsetOf(q)],
      ),
      this.db.query<{ total: number }>(
        `SELECT COUNT(*)::int AS total FROM products p ${PRODUCT_FILTER}`,
        filter,
      ),
    ]);
    return { rows: rows.rows, total: count.rows[0].total };
  }

  async findProduct(id: string): Promise<ProductDetail | null> {
    const { rows } = await this.db.query<ProductDetail>(
      `SELECT ${PRODUCT_COLUMNS},
              CASE WHEN sup.id IS NULL THEN NULL ELSE json_build_object(
                'id', sup.id, 'code', sup.code, 'name', sup.name,
                'leadTimeDays', sp.lead_time_days, 'minOrderQty', sp.min_order_qty,
                'unitCost', sp.unit_cost::text
              ) END AS "primarySupplier"
         ${PRODUCT_FROM}
         LEFT JOIN supplier_products sp ON sp.product_id = p.id AND sp.is_primary
         LEFT JOIN suppliers sup ON sup.id = sp.supplier_id
        WHERE p.id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  async productExists(id: string): Promise<boolean> {
    const { rowCount } = await this.db.query('SELECT 1 FROM products WHERE id = $1', [id]);
    return rowCount === 1;
  }

  async listCategories(): Promise<Category[]> {
    const { rows } = await this.db.query<Category>(
      `SELECT c.id, c.name, COUNT(p.id)::int AS "productCount"
         FROM categories c
         LEFT JOIN products p ON p.category_id = c.id
        GROUP BY c.id
        ORDER BY c.name`,
    );
    return rows;
  }
}
