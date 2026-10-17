# INTERACTIONS: doc-renamer-pipeline

## I1: Plan a folder of documents without touching files
- Outcome: running `docnamer plan <folder>` on a folder of mixed documents writes
  `<folder>/.docnamer-plan.json` containing a row per file with old name, proposed
  new name, type, fields, evidence quotes, flags, summary, size, mtime and status
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

## I2: Vision fallback only when OCR is weak
- Outcome: for a scanned PDF whose OCR text is under the confidence threshold, the
  plan row is produced from a vision-model call over page images, while a PDF with
  a usable text layer is planned from text alone with no image sent to the model.
```dot
digraph I2 {
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

## I3: Collision-safe unique naming
- Outcome: when two documents in the same folder (or one document and an existing
  file) produce the same rendered name, the later plan row receives a Finder-style
  ` (2)` suffix, and no plan row ever proposes a name already occupied on disk.
```dot
digraph I3 {
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
