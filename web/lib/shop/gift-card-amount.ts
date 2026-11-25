// W76a (Wayne, 25 Nov): the gift card's Other rule for the page, which asks it as the customer types. The rule is the
// Worker's, and the server asks it again when the basket is built. The one website file that may import it, and it may
// import nothing else from server code (SHOP_AMOUNT_FILE in scripts/check-fast-level.mjs).
export { checkOtherAmount, type OtherAmountAnswer, type OtherAmountFailure, type OtherAmountLimits } from '@/server/rules/shop/gift-card-amount'
