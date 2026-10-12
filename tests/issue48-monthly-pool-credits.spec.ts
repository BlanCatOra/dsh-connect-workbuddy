/**
 * Issue #48: a monthly resource must report the CAPACITY POOL, not the cycle.
 *
 * ## The defect
 *
 * The upstream returns a monthly resource (`CapacityType === 4`) with two
 * capacity families:
 *
 *   CapacityRemain / CapacitySize / CapacityUsed          — the pool
 *   CycleCapacityRemain / CycleCapacitySize / CycleUsed   — the current cycle
 *
 * The parser read `CycleCapacityRemain` for monthly packages, so an account
 * whose cycle is spent but whose pool is not reported 0 credits. Measured on
 * three real global accounts (2026-10-12):
 *
 *   CapacityType=4  CapacityRemain=100  CycleCapacityRemain=0
 *   CycleCapacityUsed=100  CycleEndTime="2026-10-31 23:59:59"  Status=0
 *
 * A live package, with a pool holding 100 and a cycle that had not even ended
 * — reported by the plugin as "0 credit", while the WorkBuddy client showed
 * the account as healthy. The pool figure was also suppressed in the CN region
 * for accounts in the same state, so this is not a global-only defect.
 *
 * ## Why these tests exist at all
 *
 * `fetchCredits` had NO test exercising its field parsing — every existing
 * suite stubs the whole `fetchCredits` call, so any field-name mistake was
 * invisible. The cases below drive the REAL parser through a stubbed `fetch`
 * and assert the aggregated numbers, which is the layer that was missing.
 *
 * ## What is asserted, and what deliberately is not
 *
 * The rule is "the balance is the pool, for BOTH kinds", so:
 *
 * - a monthly resource reads `CapacityRemain`;
 * - `cycleRemain` is still carried, because "this cycle is spent" is a
 *   different question from "out of credit" — it is what makes `refreshAtMs`
 *   truthful;
 * - a gift (`CapacityType === 1`) keeps its old behaviour exactly.
 *
 * NOT asserted: that pool and cycle agree, or any specific relationship
 * between them. They genuinely disagree in production and the code must not
 * assume otherwise — that assumption is what produced the bug. The live
 * figures are replicated here as DATA precisely because a "sensible-looking"
 * fixture (pool == cycle) would have passed both the buggy and the fixed code.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkBuddyUpstreamClient } from '../src/upstream.ts'
import type { WorkBuddyCredential } from '../src/auth.ts'

function credential(): WorkBuddyCredential {
  return {
    accessToken: 'at',
    refreshToken: 'rt',
    expiresAtMs: 0,
    domain: 'www.workbuddy.ai',
    uid: 'u',
    source: 'desktop',
    filePath: '/tmp/workbuddy-desktop.info',
  }
}

/** Run the real `fetchCredits` against a stubbed billing response. */
async function creditsFor(accounts: readonly Record<string, unknown>[]) {
  vi.stubGlobal('fetch', async () => ({
    ok: true,
    status: 200,
    json: async () => ({ code: 0, msg: 'OK', data: { Response: { Data: { Accounts: accounts } } } }),
    text: async () => JSON.stringify({ code: 0, msg: 'OK', data: { Response: { Data: { Accounts: accounts } } } }),
  }) as unknown as Response)
  return new WorkBuddyUpstreamClient().fetchCredits(credential())
}

/**
 * The exact shape three real global accounts returned (2026-10-12), including
 * the fields the parser ignores — a fixture carrying only the interesting
 * fields would not prove the parser picks the RIGHT one out of a realistic row.
 */
function liveMonthlyRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    CapacityType: 4,
    PackageName: 'Free Plan Subscription',
    CapacityRemain: 100,
    CapacitySize: 100,
    CapacityUsed: 0,
    CycleCapacityRemain: 0,
    CycleCapacitySize: 100,
    CycleCapacityUsed: 100,
    CycleEndTime: '2026-10-31 23:59:59',
    ExpiredTime: '',
    Status: 0,
    ...overrides,
  }
}

describe('fetchCredits: the monthly resource reports the pool (issue #48)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reads CapacityRemain, not CycleCapacityRemain, on a spent-cycle live package', async () => {
    // THE regression. The live row: pool 100, cycle 0, cycle not ended.
    const credits = await creditsFor([liveMonthlyRow()])
    expect(credits.total).toBe(100)
    expect(credits.packages).toHaveLength(1)
    expect(credits.packages[0]?.remain).toBe(100)
  })

  it('carries the cycle figure separately, because it answers a different question', async () => {
    // `cycleRemain` must survive the fix: without it, "this cycle is spent,
    // it refills on the 31st" becomes indistinguishable from "you have credit".
    const credits = await creditsFor([liveMonthlyRow()])
    const pack = credits.packages[0]
    expect(pack?.cycleRemain).toBe(0)
    expect(pack?.refreshAtMs).toBeDefined()
  })

  it('sums the pool across several accounts in the reported state', async () => {
    // The reporter's two accounts, plus the third found on the verifying
    // machine: three rows of 100 pool / 0 cycle.
    const credits = await creditsFor([liveMonthlyRow(), liveMonthlyRow(), liveMonthlyRow()])
    expect(credits.total).toBe(300)
  })

  it('keeps reading the pool when the two figures agree', async () => {
    // The CN region's usual shape (pool == cycle == 500). This passes under
    // BOTH the old and the new code, and is here so the fix is not mistaken
    // for "CN started reading differently".
    const credits = await creditsFor([liveMonthlyRow({ CapacityRemain: 500, CapacitySize: 500, CycleCapacityRemain: 500, CycleCapacityUsed: 0 })])
    expect(credits.total).toBe(500)
  })

  it('does not lose an account whose cycle is spent but whose pool is full', async () => {
    // The bug reported this account as exhausted. It must not be dropped from
    // `packages` either: monthly resources are always kept, which is what lets
    // the card still offer the refresh point.
    const credits = await creditsFor([liveMonthlyRow()])
    expect(credits.packages[0]?.monthly).toBe(true)
    expect(credits.packages[0]?.packageName).toBe('Free Plan Subscription')
  })

  it('leaves the gift path (CapacityType 1) untouched', async () => {
    // Negative control: the fix touches the monthly branch only. A gift reads
    // CapacityRemain and is dropped when exhausted or expired, exactly as before.
    const live = await creditsFor([{ CapacityType: 1, PackageName: 'Bonus Pack', CapacityRemain: 40, CapacitySize: 250, ExpiredTime: '2126-01-01 00:00:00' }])
    expect(live.total).toBe(40)
    expect(live.packages[0]?.cycleRemain).toBeUndefined()

    const exhausted = await creditsFor([{ CapacityType: 1, PackageName: 'Bonus Pack', CapacityRemain: 0, CapacitySize: 250, ExpiredTime: '2126-01-01 00:00:00' }])
    expect(exhausted.total).toBe(0)
    expect(exhausted.packages).toEqual([])

    const expired = await creditsFor([{ CapacityType: 1, PackageName: 'Bonus Pack', CapacityRemain: 40, CapacitySize: 250, ExpiredTime: '2026-10-04 02:40:13' }])
    expect(expired.total).toBe(0)
    expect(expired.packages).toEqual([])
  })

  it('never lets a negative pool reach the total', async () => {
    const credits = await creditsFor([liveMonthlyRow({ CapacityRemain: -5 })])
    expect(credits.total).toBe(0)
    expect(credits.packages[0]?.remain).toBe(0)
  })

  it('mixes a monthly resource and a gift without double counting', async () => {
    // The reporter's account A shape: a monthly package plus a spent gift.
    const credits = await creditsFor([
      liveMonthlyRow(),
      { CapacityType: 1, PackageName: 'Bonus Pack', CapacityRemain: 0, CapacitySize: 250, ExpiredTime: '2026-10-04 02:40:13' },
    ])
    expect(credits.total).toBe(100)
    expect(credits.packages).toHaveLength(1)
  })
})
