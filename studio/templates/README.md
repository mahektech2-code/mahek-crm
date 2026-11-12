# Approved templates

One folder per approved template (`template.json`, `copy.json`, `background.png`, `preview.png`).
Templates are **data, not code**: adding a festival is a new folder here, with no code change. The
format is specified in `TEMPLATE_SPEC.md`; `npm run validate-templates` checks every folder.

**Draft `-contact` versions.** Folders named `<id>-contact` are DRAFT versions of the approved designs with one extra optional
field, `contact_phone` (a number typed by hand for one poster; never read from the CRM). They are validated and tested but are
not listed or usable until a named approver sets `status: "approved"` in a reviewed change. See `docs/advanced-personalization.md`.

**Provenance (read this before relying on the content):**

- The eight templates, their field boxes and their greeting wording come from the **approved
  prototype** (`docs/reference/approved-prototype.html`).
- `background.png` is the prototype's code-drawn artwork exported without any dynamic text. It is a
  **placeholder for the designer's real artwork** (decision D-6). Replacing a file with real art needs
  no code change.
- Hindi and Gujarati wording is **draft** and still needs native-reader approval (D-8, D-11).
- Greeting wording contains no digits (the TEMPLATE_SPEC guardrail). One sample line that named the
  year was reworded accordingly.
- `approval.approvedBy` names the prototype baseline, not a person: the named approver is decision D-21.
- `occasions.json` dates are **sample values**. Festival dates move every year; the owner of the
  calendar is decision D-15.
- Poster fonts are interim (see `assets/fonts/fonts.json`, decision D-7).
