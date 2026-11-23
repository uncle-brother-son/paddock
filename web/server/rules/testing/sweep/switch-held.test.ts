import { afterEach, describe, expect, it, vi } from 'vitest'
import { holdSwitch, pressSwitch, withSwitch } from './booking-presses'
import { postOrder, withCardMoves } from './order-presses'

// Brief W70a item 5 (W68a noticed 3): in a file that presses two things at once, the presses' put-back of ORDER_SWITCH
// ended in the wrong order and left every kind on for the tests after them, so a "kind off" test passed alone and
// failed (or passed for the wrong reason) in its whole file. Whatever order the presses end in, the switch must end as
// the test set it.

/** New Order's route, held until the test lets it answer. */
const route = vi.hoisted(() => ({ answers: [] as Array<() => void>, seen: [] as Array<string | undefined> }))
vi.mock('@/app/api/v1/staff/orders/route', () => ({
  POST: () =>
    new Promise<Response>((resolve) => {
      route.seen.push(process.env.ORDER_SWITCH)
      route.answers.push(() => resolve(new Response(JSON.stringify({ ok: true, data: {} }), { status: 200, headers: { 'content-type': 'application/json' } })))
    }),
}))

/** A press held open until `end`. */
function held(): { work: () => Promise<void>; end: () => void } {
  let end: () => void = () => {}
  const open = new Promise<void>((resolve) => {
    end = resolve
  })
  return { work: () => open, end: () => end() }
}

afterEach(() => {
  vi.unstubAllEnvs()
  pressSwitch.live = null
  route.answers.length = 0
  route.seen.length = 0
})

describe('W70a: ORDER_SWITCH is as the test set it once every press has ended, whatever order they end in', () => {
  const BEGINNINGS = ['', 'lapse_sweep', undefined] as const
  it.each(BEGINNINGS)('two presses, the first to begin the first to end (the leak): starting from %j', async (start) => {
    vi.stubEnv('ORDER_SWITCH', start as string)
    if (start === undefined) delete process.env.ORDER_SWITCH
    const [a, b] = [held(), held()]
    const first = withSwitch('a', a.work)
    const second = withSwitch('b', b.work)
    expect(process.env.ORDER_SWITCH).toBe('b')
    a.end()
    await first
    // The second is still pressing under its own.
    expect(process.env.ORDER_SWITCH).toBe('b')
    b.end()
    await second
    expect(process.env.ORDER_SWITCH).toBe(start)
  })

  it('one inside the other: the inner one puts the outer one back, as before', async () => {
    vi.stubEnv('ORDER_SWITCH', 'lapse_sweep')
    await withSwitch('outer', async () => {
      await withSwitch('inner', async () => {
        expect(process.env.ORDER_SWITCH).toBe('inner')
      })
      expect(process.env.ORDER_SWITCH).toBe('outer')
    })
    expect(process.env.ORDER_SWITCH).toBe('lapse_sweep')
  })

  it('three presses ending in every order', async () => {
    const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]
    for (const order of orders) {
      vi.stubEnv('ORDER_SWITCH', '')
      const putBack = ['a', 'b', 'c'].map((value) => holdSwitch(value))
      for (const at of order) putBack[at]?.()
      expect(process.env.ORDER_SWITCH, order.join()).toBe('')
      // Called twice, it does nothing more.
      vi.stubEnv('ORDER_SWITCH', 'later')
      for (const again of putBack) again()
      expect(process.env.ORDER_SWITCH, order.join()).toBe('later')
    }
  })

  it('a switch the test set between two presses is what the second puts back, whichever ends first', async () => {
    for (const firstToEnd of ['a', 'b']) {
      vi.stubEnv('ORDER_SWITCH', '')
      const endA = holdSwitch('a')
      vi.stubEnv('ORDER_SWITCH', 'lapse_sweep')
      const endB = holdSwitch('b')
      if (firstToEnd === 'a') {
        endA()
        // The second is still pressing under its own.
        expect(process.env.ORDER_SWITCH).toBe('b')
        endB()
      } else {
        endB()
        expect(process.env.ORDER_SWITCH).toBe('lapse_sweep')
        continue
      }
      expect(process.env.ORDER_SWITCH).toBe('lapse_sweep')
    }
  })

  it('a press that never ends leaves later ones alone: each puts back what it found', async () => {
    vi.stubEnv('ORDER_SWITCH', '')
    holdSwitch('never')
    vi.stubEnv('ORDER_SWITCH', 'lapse_sweep')
    await withSwitch('a', async () => undefined)
    expect(process.env.ORDER_SWITCH).toBe('lapse_sweep')
  })

  it("New Order's press and the card moves wrapper hold it the same way, and the live switch while the sweep presses", async () => {
    vi.stubEnv('ORDER_SWITCH', '')
    vi.stubEnv('STAFF_API_KEY', 'k')
    const first = postOrder({}, { orderSwitch: 'first' })
    const second = postOrder({}, { orderSwitch: 'second' })
    expect(route.seen).toEqual(['first', 'second'])
    route.answers[0]?.()
    await first
    expect(process.env.ORDER_SWITCH).toBe('second')
    route.answers[1]?.()
    await second
    expect(process.env.ORDER_SWITCH).toBe('')

    const [a, b] = [held(), held()]
    const moves = withCardMoves(a.work)
    expect(process.env.ORDER_SWITCH).toBe('card_moves')
    const press = withSwitch('b', b.work)
    a.end()
    await moves
    b.end()
    await press
    expect(process.env.ORDER_SWITCH).toBe('')

    pressSwitch.live = 'live'
    const c = held()
    const live = withSwitch('mine', c.work)
    expect(process.env.ORDER_SWITCH).toBe('live')
    c.end()
    await live
    expect(process.env.ORDER_SWITCH).toBe('')
  })
})
