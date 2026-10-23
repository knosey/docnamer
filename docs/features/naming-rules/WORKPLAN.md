# WORKPLAN: naming-rules

## Global Constraints
- `self` includes Knosey, Once, Saulx, and the alias Saulx B.V. An invoice or contract whose issuer or issuing party is self is named after the customer, never after us.
- Version (`v3`, `V4`), status (`draft`) and a person token (`Jac`, `Jacqui`, `TM`) are their own fields. A Finder collision suffix ` (2)` is not a version and is never copied into a version field.
- Passport template is `{date} {holder} passport`. The type word is the English word `passport`, not a foreign word printed on the page such as `REISEPASS`.
- A government letter uses `{date} {person} {kind} {agency}`. `agency` is a short name (IND), never the full ministry title (Immigration And Naturalisation Service, Ministry Of Justice And Security).
- A photo or other non-document gets a short clear title of about six words, and the proposed filename is at most 100 characters. A screenshot of a readable document is classified and named as that document's type, not as a photo.
- `defaults.max_name_length` stays 120. Document names shorten to 120 by cutting subject and number first; date, the named party, type word, version, status and person stay whole when they fit.
- A contract uses `{date} contract {customer} {subject}`. Draft and version, when present, are appended. The customer is the other party, with the same issuer-to-customer give-way as an invoice.
- `date_format` stays `YYYY-MM-DD` and `date_order` stays day-first. Apply, undo, and the review TUI layout do not change.

## Setup
- `true`

## T1: roster for self, passport, contract, government and photo
`self` becomes `["Knosey", "Once", "Saulx", "Saulx B.V."]`. `max_name_length` stays 120. Add type `passport` with template `{date} {holder} passport` and fields `date` (date, required) and `holder` (text, not required). Add type `photo` with template `{title}`, field `title` (text, not required), and a describe that says a picture that is not a readable document, about six words. Rewrite `government_letter` to template `{date} {person} {kind} {agency}` with fields `date`, `person` (text), `kind` (text), `agency` (entity, required). Rewrite `contract` to template `{date} contract {customer} {subject} {status} {version}` with `date`, `customer` (entity, required, `counterparty` `issuer`), `issuer` (entity, not required), `subject` (text), `status` (text), `version` (text). Append optional `version` (text) to `invoice` and print it as `{date} {issuer} invoice {number} {version}`. Update `tests/self.test.ts` so its roster assertions match that self list and invoice template. The test calls `validate` then `buildName`: a contract whose `customer` is Saulx and whose `issuer` is Crowdbuilding renders Crowdbuilding, `draft` when status is draft, and not Saulx.
- Covers: R1, R3, R4, R6, R7, I1
- Depends on: none
- Files:
  - Modify: [docnamer.json](../../../docnamer.json#L5-L156)
  - Modify: [self.test.ts](../../../tests/self.test.ts#L50-L53)
  - Test: [naming-rules-roster.test.ts](../../../tests/naming-rules-roster.test.ts)
- Interfaces:
  - Consumes: `validate(a: Analysis, content: Content, config: Config): Checked`; `giveWay` via `preferCounterparty` when a field spec sets `counterparty`
  - Produces: `BUILTIN_CONFIG.self` equals `['Knosey', 'Once', 'Saulx', 'Saulx B.V.']`; `BUILTIN_CONFIG.defaults.max_name_length` stays `120`; passport template `{date} {holder} passport`; government_letter template `{date} {person} {kind} {agency}`; contract template `{date} contract {customer} {subject} {status} {version}`
- done_when: `bun test tests/naming-rules-roster.test.ts`
- Reference: `python3 -c "print('Knosey|Once|Saulx|Saulx B.V.|120|{date} {holder} passport|{date} {person} {kind} {agency}|{date} contract {customer} {subject} {status} {version}')"`
<!-- record:T1 -->
**done** · run `ship-feature-c8c792`
- Commits: none — HEAD stayed at `4e02aad`
- Landed: [docnamer.json](../../../docnamer.json), [tests/self.test.ts](../../../tests/self.test.ts)
- Gates: envelope ✓ · touches_only ✓ · lands ✓ · done_when ✓ · reference_decides ✓
- Tests: task-test#0 done
- Summary: Shipped roster now includes Saulx and Saulx B.V., plus passport, photo, rewritten contract and government_letter, and optional invoice version. bun test tests/naming-rules-roster.test.ts exited 0 (1 pass).
<!-- /record:T1 -->

## T2: print filename tokens, shorten, and cap photo names
`tokensFromName` reads the basename only. `version` is the first `[vV]` plus digits bounded by non-alphanumerics, casing kept (`v3`, `V4`). A parenthetical ` (digits)` immediately before the extension is never a version. `status` is `draft` when that word is present, else null. `person` is `Jacqui`, `Jac` or `TM` when that token appears, case-insensitive, else null. `buildName` takes `file.name` when present and, for an empty `version`, `status` or `person` field, fills from `tokensFromName`. When type is `passport` and `holder` is empty, `holder` becomes that person. When rendering `agency`, `Immigration And Naturalisation Service` becomes `IND`; any other agency longer than one word keeps its first word. Before the length clamp, drop words from the end of `subject`, then drop `number`, until `base + ext` fits; only then slice. Cap is 100 for types `photo` and `other`, otherwise `max_name_length` (120). A true clash still appends ` (n)`. `commands.ts` passes the planned path as `file.name`; `review.ts` passes the filename it is about to replace.
- Covers: R2, R5, R6, I2, I3, I4, I5, I7
- Depends on: T1
- Files:
  - Modify: [name.ts](../../../src/name.ts#L29-L63)
  - Modify: [commands.ts](../../../src/commands.ts#L155-L155)
  - Modify: [review.ts](../../../src/review.ts#L80-L80)
  - Test: [naming-rules-name.test.ts](../../../tests/naming-rules-name.test.ts)
- Interfaces:
  - Consumes: `BUILTIN_CONFIG` templates from T1; `renderTemplate(t: string, fields: Record<string, string>): string`; `sanitise(s: string): string`
  - Produces: `tokensFromName(fileName: string): { version: string | null; status: string | null; person: string | null }`; `buildName(checked: Checked, config: Config, file: { dir: string; ext: string; name?: string }, planned: Set<string>): Promise<string>`
- done_when: `bun test tests/naming-rules-name.test.ts`
- Reference: `python3 -c "print('v3|V4|draft|Jacqui|Jac|IND|100|120|(2)')"`
<!-- record:T2 -->
**hole** · run `ship-feature-c8c792`
- Commits: none — HEAD stayed at `4e02aad`
- Landed: [src/commands.ts](../../../src/commands.ts), [src/name.ts](../../../src/name.ts), [src/review.ts](../../../src/review.ts)
- Gates: envelope ✓ · touches_only ✓ · lands ✓ · done_when ✗
- Tests: task-test#1 done
- Summary: done_when — exit 1 — output tail: … [+24 earlier line(s)] 7 pass 1 fail 31 expect() calls Ran 8 tests across 1 file. [110.00ms] files named: tests/naming-rules-name.test.ts
<!-- /record:T2 -->

## T3: prompt copies silent filename tokens and keeps document screenshots
Export the existing `buildPrompt`. It still quotes `fileName` and still requires verbatim page evidence, and it also tells the model: copy version, status and person from the old filename when the page is silent; never treat Finder ` (2)` as a version; the passport type word is the English word `passport`, never `REISEPASS`, and holder comes from the filename when the page is silent; agency is a short name, and Immigration And Naturalisation Service is `IND`, never the full ministry title; a photo title is about six words; a screenshot of a readable document uses that document's type, not `photo` and not `other`. Include the `tokensFromName` result in the prompt so a dropped token is still visible to the model. The test asserts those instructions on the returned string and does not call a model.
- Covers: R2, R3, R4, R5, I3, I4, I6
- Depends on: T2
- Files:
  - Modify: [analyse.ts](../../../src/analyse.ts#L152-L173)
  - Test: [naming-rules-prompt.test.ts](../../../tests/naming-rules-prompt.test.ts)
- Interfaces:
  - Consumes: `tokensFromName(fileName: string): { version: string | null; status: string | null; person: string | null }`
  - Produces: `buildPrompt(content: Content, fileName: string, config: Config): string`
- done_when: `bun test tests/naming-rules-prompt.test.ts`
- Reference: `python3 -c "print('passport|IND|about six words|not a photo|(2)')"`
<!-- record:T3 -->
**done** · run `ship-feature-c8c792`
- Commits: none — HEAD stayed at `4e02aad`
- Landed: [src/analyse.ts](../../../src/analyse.ts)
- Gates: envelope ✓ · touches_only ✓ · lands ✓ · done_when ✓ · reference_decides ✓
- Tests: task-test#2 done
- Summary: Exported buildPrompt and added silent-filename token, passport, IND, photo-length, and screenshot-type instructions. bun test tests/naming-rules-prompt.test.ts passed (1 pass, 0 fail).
<!-- /record:T3 -->
<!-- record:run -->
**failed** · run `ship-feature-c8c792`
- Tasks: T1 done · T2 hole · T3 done
- Commits: none — HEAD stayed at `4e02aad`
- Detail: verify: exit 1 — output tail: … [+25441 earlier chars] tatuses in the plan file [93.45ms] (pass) T3 review() and the CLI wiring > the CLI accepts the row on Enter and the prompt names Enter as accept [93.82ms] analysing the documents in /var/folders/z8/pztf_rjx3y55l7hhjw7krf280000gn/T/docnamer-review-0816508e-c8b0-477b-b0e4-913657a4368b ✓ ▰▰▰▰▰▰▰▰▰▰ 100% planned 1 document(s) OLD NEW TYPE FLAGS ──… [+3816 chars]
<!-- /record:run -->
