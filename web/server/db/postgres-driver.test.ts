import { describe, it, expect } from 'vitest'
import { parseDate, parseTimestamp, parseTimestamptz, serializeDateParam, serializeJsonParam } from './postgres-driver'

// The values below are what the staff app's Retool resource returned for the same columns
// (checked with `retool resource explore`), so ported code and shadowCompare see no difference.
describe('column parsers', () => {
  it('keeps a date as its text', () => {
    expect(parseDate('2026-11-04')).toBe('2026-11-04')
  })

  it('gives timestamptz as an ISO string with milliseconds', () => {
    expect(parseTimestamptz('2026-11-04 19:56:05.983123+00')).toBe('2026-11-04T19:56:05.983Z')
    expect(parseTimestamptz('2026-07-15 09:30:00+01')).toBe('2026-07-15T08:30:00.000Z')
  })

  it('reads a timestamp without a zone as UTC digits, as Retool does', () => {
    expect(parseTimestamp('2026-11-04 19:56:05.983')).toBe('2026-11-04T19:56:05.983Z')
    expect(parseTimestamp('2026-07-15 09:30:00')).toBe('2026-07-15T09:30:00.000Z')
  })

  it('keeps values with no ISO form as Postgres wrote them', () => {
    expect(parseTimestamptz('infinity')).toBe('infinity')
    expect(parseTimestamp('-infinity')).toBe('-infinity')
  })
})

describe('date parameters', () => {
  it('sends strings unchanged, so London wall-clock digits are never reinterpreted', () => {
    expect(serializeDateParam('2026-07-15 09:30:00')).toBe('2026-07-15 09:30:00')
    expect(serializeDateParam('2026-11-04')).toBe('2026-11-04')
  })

  it('sends a Date as its instant', () => {
    expect(serializeDateParam(new Date('2026-11-04T19:56:05.983Z'))).toBe('2026-11-04T19:56:05.983Z')
  })
})

describe('json parameters', () => {
  it('sends a string as it is, because it is already JSON text', () => {
    expect(serializeJsonParam('{"a":1}')).toBe('{"a":1}')
    expect(serializeJsonParam('not json')).toBe('not json')
  })

  it('encodes everything else', () => {
    expect(serializeJsonParam({ a: { b: [1, null] } })).toBe('{"a":{"b":[1,null]}}')
    expect(serializeJsonParam([1, { a: 2 }])).toBe('[1,{"a":2}]')
    expect(serializeJsonParam(5)).toBe('5')
    expect(serializeJsonParam(false)).toBe('false')
  })
})
