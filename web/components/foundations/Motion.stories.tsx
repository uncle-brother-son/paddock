import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { motion, MotionConfig } from 'framer-motion'
import { useState } from 'react'

import { DURATION_LONG, DURATION_SHORT, EASE_SMOOTH, EASE_SMOOTH_BEZIER } from '@/lib/motion/tokens'

import { VariableValue } from './measured'

const meta = {
  title: 'Foundations/Motion',
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

/** How many moments of the curve are plotted: Motion's own function (lib/motion/tokens.ts), asked at each. */
const PLOTTED = 100

/** The curve on the plot: time left to right, progress bottom to top, each out of 100. */
const plotted = Array.from({ length: PLOTTED + 1 }, (_, index) => index / PLOTTED)
  .map((progress) => `${Number((progress * 100).toFixed(2))},${Number((100 - EASE_SMOOTH(progress) * 100).toFixed(2))}`)
  .join(' ')

/** The bezier's four numbers, as words: the same four the stylesheet's token holds. */
const NUMBERS = EASE_SMOOTH_BEZIER.join(', ')

/** The two durations, as Motion has them (seconds) and under the names the stylesheet gives them. */
const durations = [
  { name: 'Short', seconds: DURATION_SHORT, variable: '--duration-short', utility: 'duration-short' },
  { name: 'Long', seconds: DURATION_LONG, variable: '--duration-long', utility: 'duration-long' },
] as const

/**
 * The smooth curve, plotted: time runs left to right, progress bottom to top. It is the one bezier Wayne chose
 * (WQ88, which replaces the spring of WQ55 and WQ56): off at once and fast, then a long, soft settling, no bounce.
 */
export const Curve: Story = {
  render: () => (
    <figure className="flex flex-col gap-12">
      <svg
        viewBox="-4 -4 108 108"
        role="img"
        aria-label={`The smooth curve: a bezier with the numbers ${NUMBERS}`}
        className="size-240 text-text-primary"
      >
        <path d="M 0 0 V 100 H 100" fill="none" stroke="currentColor" strokeWidth="0.5" opacity="0.4" />
        <path d="M 0 100 L 100 0" fill="none" stroke="currentColor" strokeWidth="0.5" strokeDasharray="2 2" opacity="0.4" />
        <polyline points={plotted} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      </svg>
      {/* The text styles are trimmed to their capitals (W71a), so two lines stacked need a gap of their own. */}
      <figcaption className="flex flex-col gap-6">
        <span className="block text-bold-14">ease-smooth</span>
        <span className="block text-copy-12">
          One bezier, with the numbers {NUMBERS}: the same for Motion and for CSS
        </span>
        <span className="block text-copy-12 break-all">
          CSS --ease-smooth: <VariableValue name="--ease-smooth" />
        </span>
      </figcaption>
    </figure>
  ),
}

/**
 * A box that moves and fades when its button is pressed, once with Motion (the constants in lib/motion/tokens.ts)
 * and once with a CSS transition (the variables in app/globals.css): the two move together.
 */
function Mover({ name, seconds, variable, utility }: (typeof durations)[number]) {
  const [moved, setMoved] = useState(false)

  return (
    <li className="flex flex-col gap-8">
      <p className="text-copy-12">
        <span className="text-bold-14">{name}</span> · Motion: {seconds} s · CSS {variable}: <VariableValue name={variable} />
      </p>
      <div className="bg-surface-card">
        <motion.div
          className="size-40 rounded-s bg-surface-secondary"
          animate={{ x: moved ? '500%' : '0%', opacity: moved ? 1 : 0.4 }}
          transition={{ duration: seconds, ease: EASE_SMOOTH }}
        />
      </div>
      <div className="bg-surface-card">
        <div
          className={`size-40 rounded-s bg-surface-secondary transition ${utility} ease-smooth`}
          style={{ translate: moved ? '500% 0' : '0 0', opacity: moved ? 1 : 0.4 }}
        />
      </div>
      <button type="button" onClick={() => setMoved((now) => !now)} className="self-start rounded-s bg-surface-secondary px-16 py-8 text-label-12 text-text-secondary">
        Play {name.toLowerCase()}
      </button>
    </li>
  )
}

/** Both durations, each demonstrated with a box: the top one moved by Motion, the one under it by CSS. */
export const Durations: Story = {
  render: () => (
    <ul className="flex flex-col gap-32">
      {durations.map((duration) => (
        <Mover key={duration.name} {...duration} />
      ))}
    </ul>
  ),
}

/**
 * The same, as a visitor with reduced motion on gets it from Motion: the box goes straight to its place and only
 * the fade is left. (For that visitor the site also never starts the smooth scroll, and CSS transitions are switched
 * off; the second box here still follows this computer's own setting.)
 */
export const ReducedMotion: Story = {
  render: () => (
    <MotionConfig reducedMotion="always">
      <ul className="flex flex-col gap-32">
        {durations.map((duration) => (
          <Mover key={duration.name} {...duration} />
        ))}
      </ul>
    </MotionConfig>
  ),
}
