---
name: PDF text-layer anchor search
description: How server-side PDF text extraction works here and pitfalls found while building anchor-based placement
---

- `pdfjs-dist/legacy/build/pdf.mjs` works server-side under Node 20 via dynamic import (no worker needed); pass `isEvalSupported: false`. pdf-lib cannot extract text — pdfjs is the extraction tool, pdf-lib the stamping tool.
- Anchors drawn with pdf-lib `opacity: 0` are still present in the text layer and match normally — invisible anchor text is a valid caller technique.
- Text runs can split an anchor string: group items by rounded baseline y, sort by x, concatenate, and map match index back to the containing run for position.
- **Why:** anchor matching against single items misses split runs; per-line concatenation was needed for reliable matches.
- Annotation coordinate convention (authoritative in `PdfService.stampSignedPdf`): xPos/yPos are page-normalized with yPos = top edge measured from the top; box bottom-left in points bx,by with height h ⇒ `yPos = 1 - (by + h) / pageHeight`.
- The dev workflow does NOT hot-reload server route changes — restart the workflow before curl-testing new server code, or you'll test stale behavior.
