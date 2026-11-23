# Report design contract

This document is the operational design contract for `report/`. It turns the
project-local Apple design skill into a repeatable workflow for this static SPA.
The skill remains the source of design principles; this document defines how the
repository applies them.

## Sources of truth

- **Principles**: `.claude/skills/apple-design/SKILL.md` (pinned by
  `skills-lock.json`; do not edit either skill copy).
- **Design tokens**: `report/css/tokens.css`.
- **Accessibility overrides**: `report/css/motion.css`.
- **Data schema**: `docs/log-format.md`.
- **Pricing behavior**: `docs/pricing.md`.

## What counts as a visual change

Treat any change to these paths as visual:

- `report/index.html`
- `report/css/**`
- `report/assets/**`
- `report/js/render.js`, `charts.js`, `daily-chart.js`, `theme.js`,
  `log-table.js`
- visual portions of `main.js`, `pricing.js`, `github.js`, `api.js`

Changes to the hook, `api/`, tests, or documentation alone do not require the
visual workflow. If a change touches both visual and non-visual code, use the
visual workflow.

## Before coding

1. Read this contract and the Apple design skill. Cite the relevant skill
   sections instead of restating them.
2. Record a four-line design intent in the task or PR:
   - Human need served: safety, understanding, achievement, or joy.
   - States affected: desktop/mobile, dark/light, reduced motion/transparency/
     contrast, empty/filtered/priced/modal.
   - Existing tokens or primitives reused; any new token justified for both
     themes.
   - Accessibility behavior: focus, touch, canvas name, `[hidden]`.
3. Inspect existing tokens and motion rules before inventing values.

## While coding

- **Tokens first.** No raw colors, type sizes, or new palette values outside
  `report/css/tokens.css`. Use `--space-*`, `--radius-*`, `--dur-*`, `--ease-*`,
  and `--text-*`.
- **Motion ships with accessibility.** A component with movement or translucency
  must include its `prefers-reduced-motion`, `prefers-reduced-transparency`, and
  `prefers-contrast` behavior in the same change.
- **Touch.** Interactive controls are at least 44 px tall under
  `(max-width: 760px), (pointer: coarse)`.
- **Focus.** Keyboard focus is visible. Dialogs trap focus, close on Escape, and
  restore focus to the opener.
- **Canvas.** Every chart canvas has `role="img"` and a non-empty accessible
  name, either static or assigned by the render code.
- **Breakpoint.** `760` is the only mobile breakpoint. JavaScript uses
  `MOBILE_BREAKPOINT`; CSS media queries must match it.
- **States.** New UI states need a fixture or assertion in `tests/visual.mjs`.
- **Icons.** Use the `ICONS` set in `report/js/config.js`; do not add one-off SVG
  markup with a different stroke language.

## After coding

```bash
node tests/design-check.mjs --static
node tests/visual.mjs
bash tests/run.sh
```

Review the screenshots in `tests/artifacts/visual/` for the affected states. Both
commands are advisory by default: they report problems but do not block commits
or merges.

## Definition of done

- Design intent recorded.
- Existing tokens and helpers reused; new tokens documented for both themes.
- No raw color or type-size literals outside `tokens.css`.
- Reduced-motion, reduced-transparency, and contrast behavior present.
- 44 px touch targets, visible focus, dialog focus restoration verified.
- Canvas accessible names verified.
- Static check clean; visual artifacts reviewed.
- No edits to the pinned Apple skill.
- Exceptions recorded in `tests/design-baseline.json` with a reason and expiry.

## Session contract

The project SessionStart hook extracts this block, so it must stay short.

<!-- design-contract:start -->
DESIGN CONTRACT (report/):
- Before visual work, read docs/design.md and .claude/skills/apple-design/SKILL.md; never edit the skill.
- Tokens only: no raw colors or type sizes outside report/css/tokens.css.
- Ship reduced-motion, reduced-transparency, contrast, 44px touch, focus, and canvas aria with the component.
- Breakpoint 760 only (JS: MOBILE_BREAKPOINT).
- Run `node tests/design-check.mjs --static`; visual changes also run `node tests/visual.mjs`.
- Exceptions live in tests/design-baseline.json with reason and expiry.
<!-- design-contract:end -->

## Exceptions

Known, intentional exceptions live in `tests/design-baseline.json`. Each entry
needs a rule, file, normalized match, count, reason, and expiry. Expired entries
are reported. Do not use the baseline to silence a new problem; fix it or
document an explicit exception.
