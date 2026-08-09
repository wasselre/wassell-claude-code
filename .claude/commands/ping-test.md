---
description: One-shot smoke-test command used by the Presentations daemon to verify sentinel parsing end-to-end. Prints a synthetic progress sentinel and a fake success result sentinel, no external I/O.
argument-hint: (ignored — any input works)
---

You are being invoked by the Presentations daemon as a quick plumbing test. Do NOT call any tools, MCPs, or subagents. Just print exactly these two lines, separated by a blank line, and then stop. No commentary before or after.

Line 1 (progress sentinel):

```
###PRESENTATION-PROGRESS###{"stage":"ping","message_ar":"اختبار الاتصال","message_en":"Ping test running"}
```

Line 2 (result sentinel — the FINAL line of your output, nothing after):

```
###PRESENTATION-RESULT###{"ok":true,"drive_folder_url":null,"drive_deck_url":"https://example.com/fake-deck.pptx","drive_sheet_url":null,"warnings":["This is a synthetic smoke test — not a real deck"]}
```

Print each sentinel on its own line without a code fence, without backticks, without any prefix or suffix. The daemon regexes on the `###PRESENTATION-*###` prefix — any character before the prefix on the same line breaks parsing.

User input received (ignore): $ARGUMENTS
