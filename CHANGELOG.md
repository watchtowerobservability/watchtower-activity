# Changelog

## 0.1.4 (2026-11-23)

- The npm package no longer ships source maps (`.map` files and their `sourceMappingURL` comments). They pointed at minified SDK internals and made up most of the download; your own app's source maps are unaffected.

## 0.1.3 (2026-11-23)

- Fix: the type declarations now resolve under `moduleResolution: "node16"` / `"nodenext"` (relative imports carry `.js`; before, every import from the package was TS2834/TS2835). The declaration build runs with NodeNext so this cannot regress.

## 0.1.2

- Sync with the monorepo: Hermetica write-up follow-ups and standalone builds in the public mirror.
