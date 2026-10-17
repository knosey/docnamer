# INTERACTIONS: doc-renamer-apply

## I1: Apply accepted rows with backup
- Outcome: `docnamer apply <folder>` renames each accepted row in place to its new
  name, writes the type's Finder tag (and comment when enabled), records every
  change in `<folder>/.docnamer-undo-<timestamp>.json`, deletes the plan file, and
  skips-with-report any file whose size or mtime changed since planning.
```dot
digraph I1 {
  entry [label="docnamer apply <folder>"];
  check [label="verify size and mtime unchanged"];
  rename [label="rename in place; write tag and comment"];
  record [label="append undo record"];
  outcome [label="files renamed; undo file saved; plan deleted"];
  entry -> check -> rename -> record -> outcome;
}
```

## I2: Undo a run
- Outcome: `docnamer undo <folder>` restores every file renamed by the latest run
  to its original name (skipping and reporting any entry whose new name is missing
  or whose old name is occupied) and deletes that undo file.
```dot
digraph I2 {
  entry [label="docnamer undo <folder>"];
  load [label="load latest .docnamer-undo-<timestamp>.json"];
  restore [label="rename back in reverse order, no overwrites"];
  outcome [label="original names restored; undo file deleted"];
  entry -> load -> restore -> outcome;
}
```

## I3: Review and accept plan rows
- Outcome: `docnamer review <folder>` presents each plan row with old name, new
  name, type, flags, evidence and summary; accepting, editing, re-typing or
  skipping a row updates its status in the plan file, and "accept all unflagged"
  marks every flag-free row accepted while flagged rows stay pending.
```dot
digraph I3 {
  entry [label="docnamer review <folder>"];
  load [label="load .docnamer-plan.json, flagged rows first"];
  act [label="Enter accept | e edit | t change type | s skip | A accept unflagged"];
  outcome [label="row statuses updated in plan file"];
  entry -> load -> act -> outcome;
}
```

## I4: Score a test set with eval
- Outcome: `docnamer eval <testset>` runs Stages 1–4 against the test set without
  renaming anything and prints type accuracy, per-field exact match, full-name
  match, share of files needing vision, and time/cost per file, with each miss
  shown as expected vs got alongside its evidence.
```dot
digraph I4 {
  entry [label="docnamer eval <testset>"];
  run [label="Stages 1-4 per file, no renames"];
  score [label="compare against expected.yaml"];
  outcome [label="accuracy metrics and side-by-side misses printed"];
  entry -> run -> score -> outcome;
}
```
