import type { ReactNode } from 'react'

/** For the Brand stories: the same content twice, in Light and in Dark, each on its own Surface/Primary. */
export function BothModes({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col">
      {(['light', 'dark'] as const).map((mode) => (
        <section key={mode} data-theme={mode} aria-label={mode === 'light' ? 'Light' : 'Dark'} className="flex flex-col gap-32 bg-surface-primary p-32">
          <h2 className="text-label-10 text-text-muted-primary">{mode === 'light' ? 'Light' : 'Dark'}</h2>
          {children}
        </section>
      ))}
    </div>
  )
}

/** One drawing beside its Figma name. */
export function Named({ name, children }: { name: string; children: ReactNode }) {
  return (
    <li className="flex items-center gap-24">
      <span className="flex min-w-0 flex-1 items-center">{children}</span>
      <span className="w-160 shrink-0 text-copy-12 text-text-muted-primary">{name}</span>
    </li>
  )
}
