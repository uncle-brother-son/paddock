import type { ComponentPropsWithoutRef, ElementType, ReactNode } from 'react'

type GridProps<T extends ElementType> = {
  /** The element to render: `section`, `header`, `ul`... A `div` when left out. */
  as?: T
  className?: string
  children?: ReactNode
} & Omit<ComponentPropsWithoutRef<T>, 'as' | 'className' | 'children'>

/**
 * The page grid from Figma ("Spacing/Grid"): 6 columns below 768px and 24 from 768px, a 16px margin each side and
 * an 8px gutter (the `page-grid` utility in app/globals.css). Every module sits in one, and what is inside places
 * itself with Tailwind's column utilities: `col-span-6 md:col-span-12`, `md:col-start-13`.
 */
export function Grid<T extends ElementType = 'div'>({ as, className, children, ...rest }: GridProps<T>) {
  const Element: ElementType = as ?? 'div'
  return (
    <Element className={className ? `page-grid ${className}` : 'page-grid'} {...rest}>
      {children}
    </Element>
  )
}
