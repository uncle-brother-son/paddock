import { describe, expect, it } from 'vitest'
import {
  checkAlt,
  checkButtonText,
  checkLinkPart,
  checkLinkSet,
  checkMediaPicture,
  checkMediaVideo,
  checkPoster,
  checkRowCells,
  checkTime,
  checkValidityPlaceholder,
  checkVideoDescription,
} from '../../../studio/lib/checks'

// Brief W72: what the Studio refuses (studio/lib/checks.ts). The slugs' own test is lib/routes/reserved-slugs.test.ts.

const picture = { asset: { _ref: 'image-a-1x1-jpg' } }

describe('pictures and videos', () => {
  it('alt text: required once there is a picture, unless it is decorative', () => {
    expect(checkAlt(undefined, undefined)).toBe(true)
    expect(checkAlt(undefined, {})).toBe(true)
    expect(checkAlt(undefined, picture)).toContain('Describe the picture')
    expect(checkAlt('  ', picture)).toContain('Describe the picture')
    expect(checkAlt('A sauna', picture)).toBe(true)
    expect(checkAlt(undefined, { ...picture, decorative: true })).toBe(true)
  })

  it('an image needs its picture; a video needs an MP4, a poster and a description', () => {
    expect(checkMediaPicture(undefined, 'image')).toBe('Add a picture.')
    expect(checkMediaPicture(undefined, undefined)).toBe('Add a picture.')
    expect(checkMediaPicture(picture, 'image')).toBe(true)
    expect(checkMediaPicture(undefined, 'video')).toBe(true)
    expect(checkMediaVideo(undefined, 'image')).toBe(true)
    expect(checkMediaVideo(undefined, 'video')).toBe('Upload an MP4 file.')
    expect(checkMediaVideo({ asset: { _ref: 'file-a-mov' } }, 'video')).toContain('not an MP4')
    expect(checkMediaVideo({ asset: { _ref: 'file-a-mp4' } }, 'video')).toBe(true)
    expect(checkPoster(undefined, 'video')).toContain('before the video plays')
    expect(checkPoster(picture, 'video')).toBe(true)
    expect(checkPoster(undefined, 'image')).toBe(true)
    expect(checkVideoDescription(' ', 'video')).toContain('what the video shows')
    expect(checkVideoDescription('Steam', 'video')).toBe(true)
    expect(checkVideoDescription(undefined, 'image')).toBe(true)
  })
})

describe('links and buttons', () => {
  it('a link goes somewhere, and has the part its destination needs', () => {
    expect(checkLinkSet(undefined)).toBe('Choose where the link goes.')
    expect(checkLinkSet({ destination: 'shop' })).toBe(true)
    expect(checkLinkPart('page', undefined, { destination: 'page' })).toBe('Choose the page.')
    expect(checkLinkPart('page', { _ref: 'x' }, { destination: 'page' })).toBe(true)
    expect(checkLinkPart('event', undefined, { destination: 'event' })).toBe('Choose the event.')
    expect(checkLinkPart('external', ' ', { destination: 'external' })).toBe('Type the address.')
    expect(checkLinkPart('external', 'https://example.com', { destination: 'external' })).toBe(true)
    expect(checkLinkPart('page', undefined, { destination: 'shop' })).toBe(true)
    expect(checkLinkPart('page', undefined, undefined)).toBe(true)
  })

  it('a button that shows has words', () => {
    expect(checkButtonText(undefined, true)).toContain('Type the words')
    expect(checkButtonText('Book', true)).toBe(true)
    expect(checkButtonText(undefined, false)).toBe(true)
  })
})

describe('the rest', () => {
  it("a size guide's row has one cell per column", () => {
    expect(checkRowCells(['S', '100'], ['Size', 'Chest'])).toBe(true)
    expect(checkRowCells(['S'], ['Size', 'Chest'])).toBe('This row has 1 of 2 cells.')
    expect(checkRowCells(undefined, ['Size'])).toBe('This row has 0 of 1 cells.')
  })

  it.each(['00:00', '09:30', '23:59'])('%s is a time', (time) => {
    expect(checkTime(time)).toBe(true)
  })

  it.each(['9:30', '24:00', '09:60', '9am'])('%s is not a 24-hour time', (time) => {
    expect(checkTime(time)).toContain('24-hour')
  })

  it('the gift card terms hold {validity}, whole', () => {
    const terms = (...texts: string[]) => [{ children: texts.map((text) => ({ text })) }]
    expect(checkValidityPlaceholder(undefined)).toBe(true)
    expect(checkValidityPlaceholder(terms('Valid for {validity}.'))).toBe(true)
    expect(checkValidityPlaceholder(terms('Valid for a year.'))).toContain('{validity}')
    expect(checkValidityPlaceholder(terms('Valid for {vali', 'dity}.'))).toContain('{validity}')
  })
})
