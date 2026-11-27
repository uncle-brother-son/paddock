import type {StructureBuilder, StructureResolver} from 'sanity/structure'
import {createElement, type ComponentProps} from 'react'
import {
  CalendarDays,
  CupSoda,
  FileText,
  Gift,
  IdCard,
  Info,
  LayoutList,
  ListFilter,
  Menu,
  Newspaper,
  Ruler,
  Settings,
  Shirt,
  ShoppingBag,
  SlidersHorizontal,
  Tags,
  Ticket,
  Waves,
} from 'lucide-react'

const VerticalWaves = (props: ComponentProps<typeof Waves>) =>
  createElement(Waves, {
    ...props,
    style: {...props.style, transform: 'rotate(90deg)'},
  })

/** The single documents: one of each, whose id is its type's name. */
const SINGLETONS = ['siteSettings', 'navigation', 'shopSettings', 'eventsSettings']

export const isSingleton = (type: string): boolean => SINGLETONS.includes(type)

const single = (S: StructureBuilder, type: string, title: string, icon: typeof Settings) =>
  S.listItem()
    .id(type)
    .title(title)
    .icon(icon)
    .child(S.document().schemaType(type).documentId(type).title(title))

export const structure: StructureResolver = (S) =>
  S.list()
    .title('Paddock')
    // WQ44 (Wayne, 24 Nov): what is sold first (sessions, memberships, passes, add-ons, the shop, events), then the
    // site's own pages and settings beneath the divider.
    .items([
      S.listItem()
        .title('Session Types')
        .icon(VerticalWaves)
        .child(S.documentTypeList('serviceType').title('Session Types')),
      // W81 (WQ84): the cards the site shows (website only) beside the plans and the passes they group.
      S.listItem()
        .title('Memberships')
        .icon(IdCard)
        .child(
          S.list()
            .title('Memberships')
            .items([
              S.listItem()
                .title('Membership Cards')
                .icon(LayoutList)
                .child(
                  S.documentTypeList('membershipCard')
                    .title('Membership Cards')
                    .defaultOrdering([{field: 'order', direction: 'asc'}]),
                ),
              S.listItem()
                .title('Membership Plans')
                .icon(IdCard)
                .child(S.documentTypeList('membershipPlan').title('Membership Plans')),
            ]),
        ),
      S.listItem()
        .title('Session Passes')
        .icon(Ticket)
        .child(
          S.list()
            .title('Session Passes')
            .items([
              S.listItem()
                .title('Session Pass Cards')
                .icon(LayoutList)
                .child(
                  S.documentTypeList('sessionPassCard')
                    .title('Session Pass Cards')
                    .defaultOrdering([{field: 'order', direction: 'asc'}]),
                ),
              S.listItem()
                .title('Session Pass Types')
                .icon(Ticket)
                .child(S.documentTypeList('sessionPassType').title('Session Pass Types')),
            ]),
        ),
      S.listItem()
        .title('Add-ons')
        .icon(CupSoda)
        .child(S.documentTypeList('addon').title('Add-ons')),
      S.listItem()
        .title('Shop')
        .icon(ShoppingBag)
        .child(
          S.list()
            .title('Shop')
            .items([
              S.listItem()
                .title('Products')
                .icon(Shirt)
                .child(S.documentTypeList('product').title('Products')),
              S.listItem()
                .title('Categories')
                .icon(ListFilter)
                .child(
                  S.documentTypeList('productCategory')
                    .title('Categories')
                    .defaultOrdering([{field: 'order', direction: 'asc'}]),
                ),
              S.listItem()
                .title('Product Families')
                .icon(Tags)
                .child(S.documentTypeList('productFamily').title('Product Families')),
              S.listItem()
                .title('Size Guides')
                .icon(Ruler)
                .child(S.documentTypeList('sizeGuide').title('Size Guides')),
              S.listItem()
                .title('Gift Card')
                .icon(Gift)
                .child(S.documentTypeList('giftCardType').title('Gift Card')),
            ]),
        ),
      S.listItem()
        .title('Events')
        .icon(CalendarDays)
        .child(S.documentTypeList('event').title('Events')),
      S.divider(),
      S.listItem()
        .title('Pages')
        .icon(FileText)
        .child(S.documentTypeList('contentPage').title('Pages')),
      S.listItem()
        .title('Info Pages')
        .icon(Info)
        .child(
          S.documentTypeList('infoPage')
            .title('Info Pages')
            .defaultOrdering([{field: 'menuOrder', direction: 'asc'}]),
        ),
      S.listItem()
        .title('Blog')
        .icon(Newspaper)
        .child(S.documentTypeList('blogPost').title('Blog')),
      S.listItem()
        .title('Settings')
        .icon(Settings)
        .child(
          S.list()
            .title('Settings')
            .items([
              single(S, 'siteSettings', 'Site Settings', SlidersHorizontal),
              single(S, 'navigation', 'Navigation', Menu),
              single(S, 'shopSettings', 'Shop Settings', ShoppingBag),
              single(S, 'eventsSettings', 'Events Settings', CalendarDays),
            ]),
        ),
    ])
