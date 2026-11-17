import { containsPattern } from '../database/sql';
import { paginationSchema, sortSchema } from './query';

describe('paginationSchema', () => {
  it('applies defaults and coerces strings', () => {
    expect(paginationSchema.parse({})).toEqual({ page: 1, pageSize: 25 });
    expect(paginationSchema.parse({ page: '3', pageSize: '50' })).toEqual({
      page: 3,
      pageSize: 50,
    });
  });

  it.each([{ pageSize: '101' }, { pageSize: '0' }, { page: '0' }, { page: '1.5' }])(
    'rejects out-of-range %o',
    (input) => expect(paginationSchema.safeParse(input).success).toBe(false),
  );
});

describe('sortSchema', () => {
  const sort = sortSchema({ sku: 'p.sku', price: 'p.unit_price' }, 'sku:asc');

  it('maps allowed fields to fixed SQL expressions', () => {
    expect(sort.parse(undefined)).toBe('p.sku ASC');
    expect(sort.parse('price:desc')).toBe('p.unit_price DESC');
    expect(sort.parse('price')).toBe('p.unit_price ASC');
  });

  it.each(['name:asc', 'price:sideways', 'p.sku; DROP TABLE products', ''])('rejects %p', (value) =>
    expect(sort.safeParse(value).success).toBe(false),
  );
});

describe('containsPattern', () => {
  it('wraps the term and escapes LIKE wildcards', () => {
    expect(containsPattern('milk')).toBe('%milk%');
    expect(containsPattern('50%_off\\')).toBe('%50\\%\\_off\\\\%');
    expect(containsPattern(undefined)).toBeNull();
  });
});
