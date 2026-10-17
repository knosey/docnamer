/**
 * Smoke test for the doc-renamer-pipeline harness: drives I1's digraph end to
 * end — entry -> read -> analyse -> name -> outcome — against the current tree.
 *
 * While the `docnamer` CLI is absent the run reports a machine-readable skip
 * rather than a false green; it turns into a real assertion as soon as the CLI
 * lands (T5).
 */
import {
  Session,
  entry,
  read,
  analyse,
  name,
  outcome,
} from "./doc-renamer-pipeline-harness.ts";

flow("doc-renamer-pipeline I1: plan a folder end to end", async () => {
  const s = new Session();
  await entry(s);
  await read(s);
  await analyse(s);
  await name(s);
  await outcome(s);
});
