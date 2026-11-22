import type { Scenario } from './harness'

/**
 * W59 (W35 audit row 14, W45 audit row 23): the every-scenario sweeps (w05c, w05d) run one test per family instead of
 * one test for every scenario, so no single test sits near its time limit (w05c's was 300 s, and timed out on a slow
 * Mac on battery). A family is the scenarios whose names share their first word (`q25-…`, `w17-…`, `addon-…`), in the
 * order `scenarios` has them, cut into parts of at most `size` so the largest family is no slower than the rest.
 * Every scenario is in exactly one part (the sweeps check it).
 */
export function scenarioFamilies(list: readonly Scenario[], size = 40): Array<[string, Scenario[]]> {
  const byWord = new Map<string, Scenario[]>()
  for (const scenario of list) {
    const word = scenario.name.split('-')[0] ?? scenario.name
    byWord.set(word, [...(byWord.get(word) ?? []), scenario])
  }
  const parts: Array<[string, Scenario[]]> = []
  for (const [word, family] of byWord) {
    const count = Math.ceil(family.length / size)
    for (let index = 0; index < count; index += 1) {
      parts.push([count === 1 ? word : `${word} (${index + 1} of ${count})`, family.slice(index * size, (index + 1) * size)])
    }
  }
  return parts
}
