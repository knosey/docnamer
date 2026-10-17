# INTERACTIONS: doc-renamer

## I1: Plan a folder of documents without touching files
- Outcome: running `docnamer plan <folder>` on a folder of mixed documents writes
  `<folder>/.docnamer-plan.json` containing a row per file with old name, proposed
  new name, type, fields, evidence quotes, flags, size, mtime and status
  "pending", prints the old→new table with flagged rows first, and leaves every
  original file's name, size and mtime unchanged.
```dot
digraph I1 {
  entry [label="docnamer plan <folder>"];
  read [label="Stage 1: read each file, cheapest method first"];
  analyse [label="Stages 2-3: classify, extract, validate"];
  name [label="Stage 4: build unique safe name"];
  outcome [label=".docnamer-plan.json written; originals untouched"];
  entry -> read -> analyse -> name -> outcome;
}
```

## I2: Review and accept plan rows
- Outcome: `docnamer review <folder>` presents each plan row with old name, new
  name, type, flags and evidence; accepting, editing, re-typing or skipping a row
  updates its status in the plan file, and "accept all unflagged" marks every
  flag-free row accepted while flagged rows stay pending.
```dot
digraph I2 {
  entry [label="docnamer review <folder>"];
  load [label="load .docnamer-plan.json, flagged rows first"];
  act [label="Enter accept | e edit | t change type | s skip | A accept unflagged"];
  outcome [label="row statuses updated in plan file"];
  entry -> load -> act -> outcome;
}
```

## I3: Apply accepted rows with backup
- Outcome: `docnamer apply <folder>` renames each accepted row in place to its new
  name, writes the type's Finder tag (and comment when enabled), records every
  change in `<folder>/.docnamer-undo-<timestamp>.json`, deletes the plan file, and
  skips-with-report any file whose size or mtime changed since planning.
```dot
digraph I3 {
  entry [label="docnamer apply <folder>"];
  check [label="verify size and mtime unchanged"];
  rename [label="rename in place; write tag and comment"];
  record [label="append undo record"];
  outcome [label="files renamed; undo file saved; plan deleted"];
  entry -> check -> rename -> record -> outcome;
}
```

## I4: Undo a run
- Outcome: `docnamer undo <folder>` restores every file renamed by the latest run
  to its original name (skipping and reporting any entry whose new name is missing
  or whose old name is occupied) and deletes that undo file.
```dot
digraph I4 {
  entry [label="docnamer undo <folder>"];
  load [label="load latest .docnamer-undo-<timestamp>.json"];
  restore [label="rename back in reverse order, no overwrites"];
  outcome [label="original names restored; undo file deleted"];
  entry -> load -> restore -> outcome;
}
```

## I5: Vision fallback only when OCR is weak
- Outcome: for a scanned PDF whose OCR text is under the confidence threshold, the
  plan row is produced from a vision-model call over page images, while a PDF with
  a usable text layer is planned from text alone with no image sent to the model.
```dot
digraph I5 {
  entry [label="Stage 1 read of a PDF"];
  text [label="text layer usable?"];
  ocr [label="OCR pages; confidence >= threshold?"];
  vision [label="send page images to vision model"];
  outcome [label="content handed to Stage 2 via cheapest sufficient method"];
  entry -> text;
  text -> ocr [label="no"];
  text -> outcome [label="yes: text only"];
  ocr -> outcome [label="yes: OCR text only"];
  ocr -> vision [label="no"];
  vision -> outcome;
}
```

## I6: Collision-safe unique naming
- Outcome: when two documents in the same folder (or one document and an existing
  file) produce the same rendered name, the later plan row receives a Finder-style
  ` (2)` suffix, and no apply ever overwrites an existing file.
```dot
digraph I6 {
  entry [label="Stage 4 build name"];
  render [label="render template, drop empty parts, sanitise"];
  collide [label="name exists on disk or in plan?"];
  suffix [label="append \" (n)\" and re-check"];
  outcome [label="unique name recorded in plan row"];
  entry -> render -> collide;
  collide -> suffix [label="yes"];
  collide -> outcome [label="no"];
  suffix -> outcome;
}
```

## I7: Score a test set with eval
- Outcome: `docnamer eval <testset>` runs Stages 1–4 against the test set without
  renaming anything and prints type accuracy, per-field exact match, full-name
  match, share of files needing vision, and time/cost per file, with each miss
  shown as expected vs got alongside its evidence.
```dot
digraph I7 {
  entry [label="docnamer eval <testset>"];
  run [label="Stages 1-4 per file, no renames"];
  score [label="compare against expected.yaml"];
  outcome [label="accuracy metrics and side-by-side misses printed"];
  entry -> run -> score -> outcome;
}
```
