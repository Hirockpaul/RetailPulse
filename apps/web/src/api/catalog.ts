import { getJson, type Page, qs } from './client';

export interface ProductSummary {
  id: string;
  sku: string;
  name: string;
  categoryId: string;
  categoryName: string;
  unitPrice: string;
  packSize: number;
  isActive: boolean;
  totalOnHand: number;
  totalAvailable: number;
}

export interface ProductDetail extends ProductSummary {
  primarySupplier: {
    id: string;
    code: string;
    name: string;
    leadTimeDays: number;
    minOrderQty: number;
    unitCost: string;
  } | null;
}

export interface Category {
  id: string;
  name: string;
  productCount: number;
}

export type ProductSort =
  | 'sku:asc'
  | 'sku:desc'
  | 'name:asc'
  | 'name:desc'
  | 'price:asc'
  | 'price:desc'
  | 'available:asc'
  | 'available:desc';

export interface ListProductsParams {
  q?: string;
  categoryId?: string;
  sort?: ProductSort;
  page?: number;
  pageSize?: number;
}

export const listProducts = (p: ListProductsParams) =>
  getJson<Page<ProductSummary>>(`/products${qs({ ...p })}`);

export const getProduct = (id: string) => getJson<ProductDetail>(`/products/${id}`);

export const listCategories = () => getJson<{ data: Category[] }>('/categories');
