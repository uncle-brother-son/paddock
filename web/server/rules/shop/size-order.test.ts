import { describe, expect, it } from 'vitest'
import { inShopOrder } from './size-order'

// W74a: the one order sizes are shown in.
const ordered = (...sizes: Array<string | null>) => inShopOrder(sizes.map((size) => ({ size }))).map(({ size }) => size)

describe('sizes in shop order (W74a)', () => {
  it('the named sizes, XXS to XXXL, whatever order they come in', () => {
    expect(ordered('L', 'M', 'S', 'XL')).toEqual(['S', 'M', 'L', 'XL'])
    expect(ordered('XXXL', 'XL', 'XXS', 'L', 'XS', 'XXL', 'S', 'M')).toEqual(['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL'])
  })

  it('then numbers ascending (as numbers, not text), then anything else in the order created', () => {
    expect(ordered('10', '8', '9.5', '100')).toEqual(['8', '9.5', '10', '100'])
    expect(ordered('Tall', '10', 'M', 'Kids', '8', 'S', null)).toEqual(['S', 'M', '8', '10', 'Tall', 'Kids', null])
  })

  it('letter case and spaces at the ends do not count, and the size is shown as it was typed', () => {
    expect(ordered('xl', ' m ', 'S')).toEqual(['S', ' m ', 'xl'])
  })

  it('"One Size" alone', () => {
    expect(ordered('One Size')).toEqual(['One Size'])
    expect(ordered()).toEqual([])
  })

  it('two sizes at the same place keep the order created, and the list given is left as it was', () => {
    const given = [{ size: 'M', id: 1 }, { size: 'S', id: 2 }, { size: 'm', id: 3 }]
    expect(inShopOrder(given).map(({ id }) => id)).toEqual([2, 1, 3])
    expect(given.map(({ id }) => id)).toEqual([1, 2, 3])
  })
})
