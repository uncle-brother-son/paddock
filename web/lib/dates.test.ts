import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { dayLine, inLondon, MONTHS, WEEKDAYS, whenLine } from './dates'

// Brief W78a, item 3 (WQ69): bookings and events everywhere read "08:00 - Thursday 12 November": 24-hour time, a
// space, a hyphen, a space, the day of the week, the day, the month; no year, no "th"; in UK time. One formatter,
// and no other date formatting in the site.

describe('WQ69: when a booking or an event is', () => {
  it('reads "08:00 - Thursday 12 November"', () => {
    expect(whenLine('2026-11-12T08:00:00+00:00')).toBe('08:00 - Thursday 12 November')
    expect(whenLine('2026-10-27T16:00:00+00:00')).toBe('16:00 - Tuesday 27 October')
  })

  it('never a year, never "th", and the hyphen is a plain one with a space each side', () => {
    const days = Array.from({ length: 31 }, (_, index) => whenLine(`2027-01-${String(index + 1).padStart(2, '0')}T09:05:00+00:00`))
    for (const [index, line] of days.entries()) {
      expect(line).toMatch(new RegExp(`^09:05 - [A-Z][a-z]+day ${index + 1} January$`))
      expect(line).not.toMatch(/\d{4}|\d(st|nd|rd|th)\b|[—–]/)
    }
    expect([days[0], days[1], days[2], days[10], days[21], days[30]]).toEqual(['09:05 - Friday 1 January', '09:05 - Saturday 2 January', '09:05 - Sunday 3 January', '09:05 - Monday 11 January', '09:05 - Friday 22 January', '09:05 - Sunday 31 January'])
  })

  it('24-hour, with both digits of the hour and the minute; midnight is 00:00 of the day it begins', () => {
    expect(whenLine('2026-12-05T07:05:00+00:00')).toBe('07:05 - Saturday 5 December')
    expect(whenLine('2026-12-31T00:00:00+00:00')).toBe('00:00 - Thursday 31 December')
    expect(whenLine('2026-12-31T23:59:00+00:00')).toBe('23:59 - Thursday 31 December')
  })

  it('is UK time, whatever offset the moment is written with', () => {
    // 18:00 in London on 2 July 2027 (summer time), written four ways.
    const sixInLondon = ['2027-07-02T18:00:00+01:00', '2027-07-02T17:00:00Z', '2027-07-03T02:00:00+09:00', '2027-07-02T10:00:00-07:00']
    expect(sixInLondon.map(whenLine)).toEqual(Array(4).fill('18:00 - Friday 2 July'))
    // Half past midnight in London in summer is still the day before in UTC.
    expect(whenLine('2027-07-31T23:30:00Z')).toBe('00:30 - Sunday 1 August')
  })

  it('every month and every day of the week by its full name', () => {
    expect(Array.from({ length: 12 }, (_, month) => whenLine(`2027-${String(month + 1).padStart(2, '0')}-15T12:00:00Z`).split(' ').at(-1))).toEqual([...MONTHS])
    // 4 to 10 January 2027 is a Monday to a Sunday.
    expect(Array.from({ length: 7 }, (_, day) => whenLine(`2027-01-${String(day + 4).padStart(2, '0')}T12:00:00Z`).split(' ')[2])).toEqual([...WEEKDAYS.slice(1), WEEKDAYS[0]])
  })

  it('something that is no moment writes nothing', () => {
    expect([whenLine('soon'), whenLine(''), inLondon('2026-13-45T99:00:00Z')]).toEqual(['', '', null])
  })
})

describe('WQ69: across the clock change', () => {
  it('the clocks go forward (29 March 2026, 01:00 becomes 02:00): the hour that is skipped is never written', () => {
    expect(whenLine('2026-03-29T00:59:00Z')).toBe('00:59 - Sunday 29 March')
    expect(whenLine('2026-03-29T01:00:00Z')).toBe('02:00 - Sunday 29 March')
    expect(whenLine('2026-03-29T01:30:00Z')).toBe('02:30 - Sunday 29 March')
    // The same clock time each side of it: 10:00 on the Saturday is GMT, 10:00 on the Sunday is summer time.
    expect([whenLine('2026-03-28T10:00:00+00:00'), whenLine('2026-03-29T10:00:00+01:00')]).toEqual(['10:00 - Saturday 28 March', '10:00 - Sunday 29 March'])
    // Just before midnight on the Saturday is still the Saturday; an hour of real time later is 00:59, not 01:59.
    expect([whenLine('2026-03-28T23:59:00Z'), whenLine('2026-03-29T22:59:00Z'), whenLine('2026-03-29T23:00:00Z')]).toEqual(['23:59 - Saturday 28 March', '23:59 - Sunday 29 March', '00:00 - Monday 30 March'])
  })

  it('the clocks go back (25 October 2026, 02:00 becomes 01:00): the hour that comes twice is written the same both times', () => {
    expect(whenLine('2026-10-25T00:30:00Z')).toBe('01:30 - Sunday 25 October')
    expect(whenLine('2026-10-25T01:30:00Z')).toBe('01:30 - Sunday 25 October')
    expect(whenLine('2026-10-25T02:00:00Z')).toBe('02:00 - Sunday 25 October')
    expect([whenLine('2026-10-24T10:00:00+01:00'), whenLine('2026-10-25T10:00:00+00:00')]).toEqual(['10:00 - Saturday 24 October', '10:00 - Sunday 25 October'])
    // Midnight into the Sunday is summer time (23:00 UTC on the Saturday); midnight out of it is GMT.
    expect([whenLine('2026-10-24T23:00:00Z'), whenLine('2026-10-25T23:59:00Z'), whenLine('2026-10-26T00:00:00Z')]).toEqual(['00:00 - Sunday 25 October', '23:59 - Sunday 25 October', '00:00 - Monday 26 October'])
  })

  it('the next two years\' changes too (28 March and 31 October 2027)', () => {
    expect([whenLine('2027-03-27T10:00:00+00:00'), whenLine('2027-03-28T10:00:00+01:00'), whenLine('2027-03-28T01:00:00Z')]).toEqual(['10:00 - Saturday 27 March', '10:00 - Sunday 28 March', '02:00 - Sunday 28 March'])
    expect([whenLine('2027-10-31T10:00:00+00:00'), whenLine('2027-10-31T00:30:00Z'), whenLine('2027-10-31T01:30:00Z')]).toEqual(['10:00 - Sunday 31 October', '01:30 - Sunday 31 October', '01:30 - Sunday 31 October'])
  })
})

describe('WQ69: a day with no time', () => {
  it('is the same without its time: "Thursday 12 November"', () => {
    expect(dayLine('2026-11-12')).toBe('Thursday 12 November')
    expect([dayLine('2026-12-01'), dayLine('2026-12-22'), dayLine('2027-01-03'), dayLine('2026-12-11')]).toEqual(['Tuesday 1 December', 'Tuesday 22 December', 'Sunday 3 January', 'Friday 11 December'])
  })

  it('a London day is a date and nothing else: the days of a clock change are named as any other', () => {
    expect([dayLine('2026-03-29'), dayLine('2026-10-25'), dayLine('2028-02-29')]).toEqual(['Sunday 29 March', 'Sunday 25 October', 'Tuesday 29 February'])
    // A day and a moment on that London day agree, each side of both changes.
    for (const [day, moment] of [['2026-03-29', '2026-03-29T00:30:00Z'], ['2026-03-29', '2026-03-29T22:30:00Z'], ['2026-10-25', '2026-10-24T23:30:00Z'], ['2026-10-25', '2026-10-25T23:30:00Z']] as const) {
      expect(whenLine(moment).split(' - ')[1]).toBe(dayLine(day))
    }
  })

  it('something that is no day writes nothing', () => {
    expect([dayLine(''), dayLine('12 November'), dayLine('2026-11-12T08:00:00Z'), dayLine('2026-13-40')]).toEqual(['', '', '', ''])
  })
})

describe('WQ69: one formatter, and no other date formatting in the site', () => {
  const WEB = path.resolve(__dirname, '..')
  const read = (file: string) => readFileSync(path.join(WEB, file), 'utf8')

  function sourceFilesUnder(dir: string): string[] {
    return readdirSync(path.join(WEB, dir)).flatMap((name) => {
      const file = `${dir}/${name}`
      if (statSync(path.join(WEB, file)).isDirectory()) return name === 'api' ? [] : sourceFilesUnder(file)
      return /\.(ts|tsx)$/.test(name) && !/\.(test|stories)\.tsx?$/.test(name) ? [file] : []
    })
  }
  const files = ['app', 'components', 'lib'].flatMap(sourceFilesUnder)

  it('nothing but lib/dates.ts asks the runtime to write a date, but for the two that write none for a visitor to read as one', () => {
    expect(files.length).toBeGreaterThan(60)
    const asking = files.filter((file) => /Intl\.DateTimeFormat|toLocale(Date|Time)?String\(/.test(read(file))).sort()
    // lib/frame/content.ts: the footer's year alone. lib/shop/cards.ts and lib/book/book.ts: today's London date as
    // "2026-11-12", for comparing and for asking the Worker, never drawn.
    expect(asking).toEqual(['lib/book/book.ts', 'lib/dates.ts', 'lib/frame/content.ts', 'lib/shop/cards.ts'])
  })

  it('the names of the days and the months are written in one place (and the calendar\'s seven columns, Monday first, in its own)', () => {
    const naming = files.filter((file) => /['"]Wednesday['"]|['"]September['"]/.test(read(file))).sort()
    expect(naming).toEqual(['lib/book/book.ts', 'lib/dates.ts'])
    expect(read('lib/book/book.ts').match(/['"]Wednesday['"]/g)).toHaveLength(1)
  })

  it('a card, the Event page and the Book panel\'s summary all write a start with it, and the panel\'s heading a day', () => {
    const event = read('lib/events/event.ts')
    expect(event.match(/when: whenLine\(/g)).toHaveLength(2)
    expect(read('lib/book/book.ts')).toContain('when: whenLine(session.startsAt),')
    expect(read('components/book/BookSessions.tsx')).toContain('{dayLine(day)}</h2>')
    // The forms it replaces are gone: a short month, a "th", a year after a start.
    for (const file of files) expect([file, /eventDateLine|eventCardDate|dayHeading|ordinal\(/.test(read(file))]).toEqual([file, false])
  })
})
