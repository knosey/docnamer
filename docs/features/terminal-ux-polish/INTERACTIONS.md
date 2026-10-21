# INTERACTIONS: terminal-ux-polish

## I1: version command leaves a clean terminal
- Outcome: `docnamer --version` run under zsh in a real pty prints the
  version line and the shell prompt returns on the next line with no stray
  `%` marker and the tty back in cooked mode.
```dot
digraph I1 {
  run_version -> capture_pty_frame;
  capture_pty_frame -> no_stray_percent;
  capture_pty_frame -> prompt_on_own_line;
}
```

## I2: review screen shows padded cards with a locked controls header
- Outcome: A captured review frame shows at least two document cards with
  visible padding between them, and the controls header (accept / edit /
  skip / quit plus position) is present even after scrolling down the list.
```dot
digraph I2 {
  open_review -> render_cards;
  render_cards -> two_cards_with_padding;
  render_cards -> scroll_down;
  scroll_down -> header_still_visible;
}
```

## I3: revisit and change an already-assessed document
- Outcome: The user accepts document 1 of several, navigates back to it,
  edits its proposed name, and the plan file on disk records the new name
  for that document while later documents keep their prior state.
```dot
digraph I3 {
  accept_doc1 -> navigate_back;
  navigate_back -> edit_name;
  edit_name -> plan_updated_for_doc1;
  plan_updated_for_doc1 -> later_docs_unchanged;
}
```

## I4: block progress bar next to the throbber during analysis
- Outcome: Captured frames of the analysis phase show a `▰`/`▱` block bar
  followed by a percentage beside the throbber, and the percentage increases
  monotonically as documents complete.
```dot
digraph I4 {
  start_analysis -> throbber_with_bar;
  throbber_with_bar -> capture_frames;
  capture_frames -> percentage_increases;
}
```

## I5: completion status uses the same block bar
- Outcome: When analysis (or review/apply) finishes, the completion line
  shows the full bar `▰▰▰▰▰▰▰▰▰▰ 100%` in the same format as the in-progress
  bars.
```dot
digraph I5 {
  analysis_completes -> completion_line;
  completion_line -> full_bar_100_percent;
}
```

## I6: ASCII and no-colour fallback
- Outcome: With `NO_COLOR=1` and stdout piped (not a tty), command output
  contains no ANSI escape sequences and no `▰`, `▱` or box-drawing
  characters; progress is shown with ASCII characters instead.
```dot
digraph I6 {
  run_with_no_color_piped -> capture_output;
  capture_output -> no_ansi_escapes;
  capture_output -> ascii_progress_shown;
}
```
