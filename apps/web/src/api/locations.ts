import { getJson, type Page, qs } from './client';

export type LocationType = 'STORE' | 'DISTRIBUTION_CENTER';

export interface Location {
  id: string;
  code: string;
  name: string;
  type: LocationType;
  city: string;
  skuCount: number;
  totalOnHand: number;
}

/** The demo network is small (≤ 13 locations), so one page of 100 covers it. */
export const listLocations = () => getJson<Page<Location>>(`/locations${qs({ pageSize: 100 })}`);
