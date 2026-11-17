import { z } from 'zod';
import { paginationSchema, searchSchema, sortSchema } from '../../core/http/query';

export const LOCATION_TYPES = ['STORE', 'DISTRIBUTION_CENTER'] as const;
export type LocationType = (typeof LOCATION_TYPES)[number];

// ----- requests

export const listLocationsQuerySchema = paginationSchema.extend({
  q: searchSchema,
  type: z.enum(LOCATION_TYPES).optional(),
  sort: sortSchema({ code: 'l.code', name: 'l.name', type: 'l.type' }, 'code:asc'),
});
export type ListLocationsQuery = z.output<typeof listLocationsQuerySchema>;

// ----- responses

export interface Location {
  id: string;
  code: string;
  name: string;
  type: LocationType;
  city: string;
  /** Number of products with a balance row at this location. */
  skuCount: number;
  totalOnHand: number;
}
