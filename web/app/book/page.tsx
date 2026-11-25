import Home, { generateMetadata as homeMetadata } from '../page'

// /book (W77; WQ64): the home page with the Book panel open over it. The panel is the frame's
// (components/frame/FramePanelsHost.tsx), which opens it because this is the address; closing it leaves the visitor
// on /. A link to /book inside the site never comes here: it opens the panel over the page the visitor is on
// (components/ui/SiteLink.tsx). This is where a link from outside lands (an email, a new tab).
//
// The page is the home page itself, with the home page's own metadata: its canonical address is /
// (docs/build-standards.md, section 2: the booking panel over a page is canonical to the page underneath).

export const generateMetadata = homeMetadata

export default Home
