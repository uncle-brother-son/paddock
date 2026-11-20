export interface ProductRow {
  id: string
  sanity_product_id: string | null
  name: string
  thumbnail_url: string | null
  category: string | null
  base_price: string
  member_price: string | null
  sale_price: string | null
  fulfillment_method: string | null
  stripe_product_id: string | null
  stripe_price_id_base: string | null
  stripe_price_id_member: string | null
  stripe_price_id_sale: string | null
  active: boolean | null
  created_at: string
  updated_at: string
}

export interface ProductVariantRow {
  id: string
  product_id: string
  sku: string | null
  size: string | null
  stock_quantity: number
  price_override: string | null
  stripe_price_id: string | null
  created_at: string
  updated_at: string
}

export interface ProductWithVariants extends ProductRow {
  variants: ProductVariantRow[]
}

export default async function getProducts(): Promise<ProductWithVariants[]> {
  const [products, variants] = await Promise.all([
    paddockData.query<ProductRow>('SELECT * FROM products ORDER BY category, name'),
    paddockData.query<ProductVariantRow>('SELECT * FROM product_variants ORDER BY size'),
  ])

  return products.data.map((p) => ({
    ...p,
    variants: variants.data.filter((v) => v.product_id === p.id),
  }))
}
