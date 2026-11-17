import { Controller, Get, Param, Query } from '@nestjs/common';
import { idParamSchema } from '../../core/http/query';
import { ZodValidationPipe } from '../../core/http/zod-validation.pipe';
import { type ListProductsQuery, listProductsQuerySchema } from './catalog.schemas';
import { CatalogService } from './catalog.service';

@Controller()
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('products')
  listProducts(@Query(new ZodValidationPipe(listProductsQuerySchema)) query: ListProductsQuery) {
    return this.catalog.listProducts(query);
  }

  @Get('products/:id')
  getProduct(@Param(new ZodValidationPipe(idParamSchema)) { id }: { id: string }) {
    return this.catalog.getProduct(id);
  }

  @Get('categories')
  listCategories() {
    return this.catalog.listCategories();
  }
}
