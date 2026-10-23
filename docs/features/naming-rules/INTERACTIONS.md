# INTERACTIONS: naming-rules

Each outcome is a plan row `docnamer plan` does not produce today. Nothing here is applied to disk.

## I1: issued contract named after the customer
- Outcome: planning `20260217 - Contract - Based Platform - Crowdbuilding (draft).pdf` proposes a name that contains the date, `contract`, `Crowdbuilding`, a subject, and `draft`, and does not contain `Saulx`.
```dot
digraph I1 {
  entry [label="plan a Saulx-issued Crowdbuilding draft contract"];
  step [label="give way from issuer Saulx to customer; append draft"];
  outcome [label="name has Crowdbuilding and draft, not Saulx"];
  entry -> step -> outcome;
}
```

## I2: invoice versions stay distinct
- Outcome: planning `20260006 Crowdbuilding February v3.pdf` and `20260006 Crowdbuilding V4.pdf` together proposes two invoice names that print `v3` and `V4`, and neither name is the other plus only ` (2)`.
```dot
digraph I2 {
  entry [label="plan the v3 and V4 Crowdbuilding invoices together"];
  step [label="print each version field from the old filename"];
  outcome [label="two names, v3 and V4, not one name plus (2)"];
  entry -> step -> outcome;
}
```

## I3: passport named in English with the holder
- Outcome: planning `passport-jacqui-with-stamps.pdf` proposes a name of the form `{date} Jacqui passport` plus the extension, and the name does not contain `REISEPASS`.
```dot
digraph I3 {
  entry [label="plan passport-jacqui-with-stamps.pdf"];
  step [label="classify as passport; holder from the filename"];
  outcome [label="{date} Jacqui passport, not REISEPASS"];
  entry -> step -> outcome;
}
```

## I4: government letter uses a short agency
- Outcome: planning `Authority-Jac-EEAVISA.pdf` proposes `{date} Jac {kind} {short agency}` and the name does not contain `Immigration And Naturalisation Service` or `Ministry Of Justice And Security`.
```dot
digraph I4 {
  entry [label="plan Authority-Jac-EEAVISA.pdf"];
  step [label="person Jac, kind, agency shortened"];
  outcome [label="short agency, person printed, full ministry absent"];
  entry -> step -> outcome;
}
```

## I5: photo title stays short
- Outcome: planning a photo that is not a readable document proposes a filename of at most 100 characters whose title is about six words, not a paragraph.
```dot
digraph I5 {
  entry [label="plan a photo that is not a readable document"];
  step [label="short title, hard max 100 characters"];
  outcome [label="proposed name is at most 100 characters and not a paragraph"];
  entry -> step -> outcome;
}
```

## I6: screenshot of a document keeps that type
- Outcome: planning a screenshot whose page is a readable invoice proposes an invoice name from the invoice template, not a photo title and not type `other`.
```dot
digraph I6 {
  entry [label="plan a screenshot of a readable invoice"];
  step [label="classify as the document on the page"];
  outcome [label="invoice template, not a photo title"];
  entry -> step -> outcome;
}
```

## I7: Finder collision suffix is not a version
- Outcome: planning a file whose old name ends in ` (2)` and states no version proposes a name with no version field; a second file that renders that same name still receives a Finder ` (2)` collision suffix.
```dot
digraph I7 {
  entry [label="plan a file named with Finder (2) and no version"];
  step [label="do not read (2) as a version field"];
  outcome [label="no version printed; a true clash still gets (2)"];
  entry -> step -> outcome;
}
```
