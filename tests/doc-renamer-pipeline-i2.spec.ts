/**
 * E2E test for I2: Vision fallback only when OCR is weak.
 *
 * Digraph steps in order: entry -> text -> ocr -> vision -> outcome.
 * A scanned PDF whose OCR confidence is below the threshold must be planned
 * from a vision-model call over page images; a PDF with a usable text layer
 * must be planned from its text alone, with no image sent to the model.
 */
import {
  Session,
  entry,
  text,
  ocr,
  vision,
  outcome,
} from "./doc-renamer-pipeline-harness.ts";

flow("doc-renamer-pipeline I2: vision fallback only when OCR is weak", async () => {
  const s = new Session();
  await entry(s);
  await text(s);
  await ocr(s);
  await vision(s);
  await outcome(s);
});
