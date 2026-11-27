import type { SectionSettings } from '@/lib/modules/section'

import { ModuleSection } from './ModuleSection'

/**
 * SectionSpacer (W80; Figma "SectionSpacer", 1648:14936): empty space between two sections, 120px from 768px and
 * 80px below. It holds nothing, so it is no section of the page's outline and is not read out. With a theme it is
 * that theme's Surface/Primary, so a run of modules on one colour is not broken by it.
 */
export function SectionSpacer({ theme, sectionId }: Partial<SectionSettings>) {
  return <ModuleSection as="div" module="section-spacer" theme={theme ?? null} sectionId={sectionId ?? null} aria-hidden="true" className="h-80 md:h-120" />
}
