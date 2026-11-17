import { Injectable, NotFoundException } from '@nestjs/common';
import type { Page } from '../../core/http/query';
import { CatalogRepository } from './catalog.repository';
import type { Category, ListProductsQuery, ProductDetail, ProductSummary } from './catalog.schemas';

@Injectable()
export class CatalogService {
  constructor(private readonly repo: CatalogRepository) {}

  async listProducts(query: ListProductsQuery): Promise<Page<ProductSummary>> {
    const { rows, total } = await this.repo.listProducts(query);
    return { data: rows, page: query.page, pageSize: query.pageSize, total };
  }

  async getProduct(id: string): Promise<ProductDetail> {
    const product = await this.repo.findProduct(id);
    if (!product) throw productNotFound();
    return product;
  }

  /** For other modules: 404 unless the product exists. */
  async assertProductExists(id: string): Promise<void> {
    if (!(await this.repo.productExists(id))) throw productNotFound();
  }

  async listCategories(): Promise<{ data: Category[] }> {
    return { data: await this.repo.listCategories() };
  }
}

function productNotFound() {
  return new NotFoundException({ code: 'NOT_FOUND', message: 'Product not found.' });
}
