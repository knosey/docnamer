/**
 * E2E test for I2: review screen shows padded cards with a locked controls
 * header.
 *
 * Digraph steps in order:
 *   open_review -> render_cards -> review_frame_captured -> two_cards_with_padding
 *   render_cards -> scroll_down -> header_still_visible
 *
 * Outcome: a captured review frame shows at least two document cards with
 * visible padding between them, and the controls header (accept / edit / skip /
 * quit plus position) is present even after scrolling down the list.
 *
 * open_review starts `docnamer review` on a pty and waits for the header;
 * render_cards waits for the first card and captures the frame;
 * two_cards_with_padding asserts the padding between two cards; scroll_down
 * moves the cursor to the next document; header_still_visible asserts the
 * controls header survived the scroll.
 */
import {
  Session,
  open_review,
  render_cards,
  review_frame_captured,
  title_rule_fits_screen,
  two_cards_with_padding,
  scroll_down,
  header_still_visible,
  CONTROLS
} from "./terminal-ux-polish-harness.ts"
import { ANSI } from "./pty.ts"

flow("terminal-ux-polish I2: review shows padded cards with a locked controls header", async () => {
  const s = new Session()
  await open_review(s)
  await render_cards(s)
  await review_frame_captured(s)
  await title_rule_fits_screen(s)
  await two_cards_with_padding(s)
  await scroll_down(s)
  await header_still_visible(s)

  // The Outcome, asserted once over the frame the scroll left behind: two cards
  // with padding between them, and the controls header still on screen.
  if (!/\d+\/\d+/.test(s.reviewFrame) || !CONTROLS.test(s.reviewFrame.replace(ANSI, ""))) {
    throw new Error(
      `I2 outcome: the scrolled frame lost its cards or its controls header:\n${s.reviewFrame}`
    )
  }
})
