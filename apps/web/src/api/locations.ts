import { getJson, type Page, qs } from './client';

export type LocationType = 'STORE' | 'DISTRIBUTION_CENTER';

export interface Location {
  id: string;
  code: string;
  name: string;
  type: LocationType;
  city: string;
  /** null when the signed-in user may not see this location's stock. */
  skuCount: number | null;
  totalOnHand: number | null;
}

/** The demo network is small (≤ 13 locations), so one page of 100 covers it. */
export const listLocations = () => getJson<Page<Location>>(`/locations${qs({ pageSize: 100 })}`);
