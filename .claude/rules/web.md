# Web app

Applies to any change under `apps/web/` (pages in `apps/web/src/app/`, copy in `apps/web/messages/en-AU.json`, brand in `packages/shared/src/brand/brand.config.ts`).

- All user-facing copy is Australian English. No hard-coded strings: use the translation layer.
- No claim of "official partner", "guaranteed entry" or any accreditation unless the API flags it for that race.
- Never compute a price in the browser. Show the totals and breakdown the API returns.
- Public pages are statically or incrementally generated. Keep client-side JavaScript small.
- Accessibility target is WCAG 2.2 AA: semantic HTML, keyboard access, visible focus, sufficient contrast.
- Brand name, colours and logo come from the single brand configuration file.
- Placeholder images only. Do not download photos.
