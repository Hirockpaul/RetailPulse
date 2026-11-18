import { Controller, Get, Header } from '@nestjs/common';
import { READ_ROLES, Roles } from '../auth/roles';
import { OPENAPI_DOCUMENT } from './openapi.document';
import { OPENAPI_PAGE } from './openapi.page';

/** Generated contract and dependency-free reader. Both intentionally require a signed-in user. */
@Roles(...READ_ROLES)
@Controller()
export class OpenApiController {
  @Get('openapi.json')
  document() {
    return OPENAPI_DOCUMENT;
  }

  @Get('docs')
  @Header('Content-Type', 'text/html; charset=utf-8')
  page() {
    return OPENAPI_PAGE;
  }
}
