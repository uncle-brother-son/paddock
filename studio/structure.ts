import type {StructureResolver} from 'sanity/structure'
import {createElement, type ComponentProps} from 'react'
import {CupSoda, House, IdCard, Info, Newspaper, ShoppingBag, Ticket, Waves} from 'lucide-react'

const VerticalWaves = (props: ComponentProps<typeof Waves>) =>
  createElement(Waves, {
    ...props,
    style: {...props.style, transform: 'rotate(90deg)'},
  })

export const structure: StructureResolver = (S) =>
  S.list()
    .title('Paddock')
    .items([
      S.listItem()
        .title('Session Types')
        .icon(VerticalWaves)
        .child(S.documentTypeList('serviceType').title('Session Types')),
      S.listItem()
        .title('Membership Plans')
        .icon(IdCard)
        .child(S.documentTypeList('membershipPlan').title('Membership Plans')),
      S.listItem()
        .title('Session Passes')
        .icon(Ticket)
        .child(S.documentTypeList('sessionPassType').title('Session Passes')),
      S.listItem()
        .title('Add-ons')
        .icon(CupSoda)
        .child(S.documentTypeList('addon').title('Add-ons')),
      S.listItem()
        .title('Products')
        .icon(ShoppingBag)
        .child(S.documentTypeList('product').title('Products')),
      S.divider(),
      S.listItem()
        .title('Website')
        .icon(House)
        .child(
          S.list()
            .title('Website')
            .items([
              S.listItem()
                .title('Homepage')
                .icon(House)
                .child(S.document().schemaType('page').documentId('homepage').title('Homepage')),
              S.listItem()
                .title('Blog')
                .icon(Newspaper)
                .child(S.documentTypeList('blogPost').title('Blog')),
              S.listItem()
                .title('Info')
                .icon(Info)
                .child(
                  S.documentTypeList('page')
                    .title('Info')
                    .filter('_type == "page" && !(_id in ["homepage", "drafts.homepage"])'),
                ),
            ]),
        ),
    ])