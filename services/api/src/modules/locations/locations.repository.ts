import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../core/database/database.service';
import { containsPattern } from '../../core/database/sql';
import { offsetOf } from '../../core/http/query';
import type { ListLocationsQuery, Location } from './locations.schemas';

const LOCATION_SELECT = `
  SELECT l.id, l.code, l.name, l.type, l.city,
         COALESCE(s.sku_count, 0)::int AS "skuCount",
         COALESCE(s.on_hand, 0)::int   AS "totalOnHand"
    FROM locations l
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS sku_count, SUM(b.on_hand) AS on_hand
        FROM inventory_balances b
       WHERE b.location_id = l.id
    ) s ON true`;

const LOCATION_FILTER = `
  WHERE ($1::text IS NULL OR l.code ILIKE $1 OR l.name ILIKE $1 OR l.city ILIKE $1)
    AND ($2::location_type IS NULL OR l.type = $2)`;

@Injectable()
export class LocationsRepository {
  constructor(private readonly db: DatabaseService) {}

  async list(q: ListLocationsQuery): Promise<{ rows: Location[]; total: number }> {
    const filter = [containsPattern(q.q), q.type ?? null];
    const [rows, count] = await Promise.all([
      this.db.query<Location>(
        `${LOCATION_SELECT} ${LOCATION_FILTER} ORDER BY ${q.sort}, l.id LIMIT $3 OFFSET $4`,
        [...filter, q.pageSize, offsetOf(q)],
      ),
      this.db.query<{ total: number }>(
        `SELECT COUNT(*)::int AS total FROM locations l ${LOCATION_FILTER}`,
        filter,
      ),
    ]);
    return { rows: rows.rows, total: count.rows[0].total };
  }

  async find(id: string): Promise<Location | null> {
    const { rows } = await this.db.query<Location>(`${LOCATION_SELECT} WHERE l.id = $1`, [id]);
    return rows[0] ?? null;
  }
}
