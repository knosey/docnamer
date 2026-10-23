# BRIEF: naming-rules

Settled naming rules from the operator's plan table, applied when `docnamer plan`
proposes a filename. The old filename is already sent to the model. Code, not the
model, has the last word on who is named, which filename tokens are printed, and
how long the result may be.

This feature changes `docnamer.json` (self list, type templates and fields), the
Stage 2 prompt that reads version, status and person from the old filename when
the page does not state them, and Stage 4 in `src/name.ts` so those fields are
printed and Finder ` (2)` stays a collision suffix. It does not change apply,
undo, or the review TUI.

## Requirements

- R1: `self` in `docnamer.json` includes Knosey, Once, Saulx, and the alias Saulx B.V. An invoice or contract whose issuer or issuing party is self is named after the customer, never after us.
- R2: Version (`v3`, `V4`), status (`draft`) and a person token (`Jac`, `Jacqui`, `TM`) are their own fields. When the page does not state them and the old filename does, the plan prints them. A Finder collision suffix ` (2)` is not a version and is never copied into a version field.
- R3: Passport is its own type with template `{date} {holder} passport`. The type word is the English word `passport`, not a foreign word printed on the page such as `REISEPASS`.
- R4: A government letter uses `{date} {person} {kind} {agency}`. `agency` is a short name (IND), never the full ministry title (Immigration And Naturalisation Service, Ministry Of Justice And Security).
- R5: A photo or other non-document gets a short clear title of about six words, never a paragraph, and the proposed filename is at most 100 characters. A screenshot of a readable document is classified and named as that document's type, not as a photo.
- R6: `defaults.max_name_length` stays 120. The spec JSON example of 150 is not authority. Document names shorten to 120 by cutting subject and number first; date, the named party, type word, version, status and person stay whole when they fit.
- R7: A contract uses `{date} contract {customer} {subject}`. Draft and version, when present under R2, are appended. The customer is the other party, with the same issuer-to-customer give-way as an invoice (R1).

## Acceptance criteria

1. `20260217 - Contract - Based Platform - Crowdbuilding (draft).pdf` plans to a name that contains the date, `contract`, Crowdbuilding, the subject, and `draft`, and does not contain `Saulx`.
2. `20260006 Crowdbuilding February v3.pdf` and `20260006 Crowdbuilding V4.pdf` plan to two different invoice names that print `v3` and `V4`. They do not collapse to one invoice name distinguished only by ` (2)`.
3. `passport-jacqui-with-stamps.pdf` plans to `{date} Jacqui passport` plus the extension, not `2023-09-29 REISEPASS.pdf`.
4. `Authority-Jac-EEAVISA.pdf` plans to a government-letter name that prints Jac, a short kind, and a short agency, and does not contain `Immigration And Naturalisation Service` or `Ministry Of Justice And Security`.
5. A photo's proposed name is at most 100 characters and is a short title, not a paragraph. A screenshot of a readable invoice plans as an invoice.
6. A file whose only parenthetical is Finder ` (2)` does not gain a version field. Two real documents that still render the same name after R2 still receive ` (2)` as a collision suffix.
7. `docnamer.json` `max_name_length` remains 120.

## Components touched

- `docnamer.json` — self list, passport type, contract and government-letter templates and fields, photo title cap.
- Stage 2 analyse prompt — old filename already in the user message; instruct version, status and person as fields when the page is silent.
- `src/name.ts` — print those fields; do not treat ` (2)` as a version; enforce the 100-character cap on photo and non-document names and 120 on every other name.
- `src/config.ts` — only if the self list or a new field kind needs a type the loader does not already accept.

## Out of scope

- An employer's statement typed as a payslip. That misclassification is not fixed here.
- Changing `date_format` away from `YYYY-MM-DD`, or `date_order` away from day-first.
- Apply, undo, the review TUI, folder moves, and OCR rewriting.
- Re-asking who is self, what filename tokens are kept, the passport and government templates, the photo cap, or the contract template. Those decisions are settled.

## Approaches considered

- Put version, status and person only in the model prompt, and trust the template to print them. Rejected as the only control: Stage 4 must still print a filename token the page omitted, because a model that drops `v3` is the failure the plan table names.
- Treat Finder ` (2)` as a version so two files stay distinct. Rejected: it is a collision suffix, and the plan table forbids using it in place of `v3` / `V4`.
- Raise `max_name_length` to the spec example of 150 so long ministry names fit. Rejected: the operator cap stays 120, and agency names are shortened instead.
- Keep passport inside `other` or a generic id type. Rejected: the operator named a passport template, and `REISEPASS` is the failure that template prevents.

## Risks

- The short agency for a body that is not IND is not in the plan table. A new ministry could still be copied in full. We would know when a planned government-letter name contains a comma or exceeds a few words in the agency slot.
- Person tokens are short (`Jac`, `TM`). A vendor or subject that happens to match one could be printed as a person. We would know when a plan row's person field is not a name from the old filename's person slot.
- Photo "about six words" is a prompt instruction; only the 100-character cap is checkable in code. We would know when a photo plan row is under 100 characters but still a sentence.

## Decisions

- D1 (2026-10-23): Self is Knosey, Once, Saulx, and Saulx B.V. Issued invoices and contracts are named after the customer. Shapes R1 and R7.
- D2 (2026-10-23): Version, status and person are fields, taken from the old filename when the page is silent, and printed. Finder ` (2)` is a collision, not a version. Shapes R2.
- D3 (2026-10-23): Passport template is `{date} {holder} passport`. Government letters are `{date} {person} {kind} {agency}` with a short agency. Shapes R3 and R4.
- D4 (2026-10-23): Photos and other non-documents get a short title, about six words, hard max 100 characters. A screenshot of a readable document uses that document's type. Global `max_name_length` stays 120. Shapes R5 and R6.
- D5 (2026-10-23): Contract template is `{date} contract {customer} {subject}`, draft and version appended, same give-way as invoice. Employer's statement typed as payslip is out of scope. Shapes R7.
