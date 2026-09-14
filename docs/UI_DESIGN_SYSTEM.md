# HyperCool Frost UI — Design System

The visual language for HyperCool's vanilla-JS frontend (`public/`). This documents what
actually ships in `public/styles/*.css` and the shared components in
`public/components/ui/index.js` — every value here is real and in production use, not aspirational.

## Philosophy

One consistent, premium-but-quiet SaaS look, Arabic-first (RTL by default, LTR fully supported),
built from CSS custom properties so a page never hardcodes a color, size, or spacing value.
Frost's own presence gets one small, deliberate visual signature (a soft pulsing accent dot next
to the chat controls) — never a mascot, never a sci-fi animation.

## Tokens (`public/styles/tokens.css`)

All tokens live on `:root`. Nothing below is duplicated in page-level CSS — every component
references these variables directly.

### Color
| Token | Use |
|---|---|
| `--ground` | Page background |
| `--surface` | Card/panel background |
| `--surface-2` | Secondary surface (hover states, subtle fills) |
| `--surface-3` | Elevated surface (a surface sitting visually above another surface) |
| `--surface-hover` | Row/item hover background |
| `--border` | Default border color |
| `--ink` | Primary text |
| `--ink-muted` | Secondary/muted text |
| `--accent` / `--accent-strong` / `--accent-soft` | Brand accent, its hover-strength variant, and its 8% tint for chips/backgrounds |
| `--accent-secondary` | Secondary brand accent (sparingly — teal) |
| `--on-accent` | Text/icon color on top of an accent-filled surface |
| `--dark-surface` | Dark surfaces (sidebar rail, toasts, dialog backdrop) |
| `--good` / `--good-soft` | Success status |
| `--warn` / `--warn-soft` | Warning status |
| `--critical` / `--critical-soft` | Danger/failure status |
| `--info` / `--info-soft` | Informational status (added — the one color the original palette was missing) |
| `--neutral-status` / `--neutral-status-soft` | Default/unclassified status |

**Rule**: never introduce a new hex color in a page-level stylesheet. If a page needs a new
semantic meaning, add a token here first.

### Typography
Arabic-first (IBM Plex Sans Arabic, self-hosted, CSP-safe, real Arabic glyphs — never a Latin
font with an RTL fallback). Named scale, each mapped onto a real pixel size:

| Token | Size | Maps to |
|---|---|---|
| `--text-page-title` | 28px | `<h1>` — one per page, set by the shared `header()` component |
| `--text-section-title` | 18px | `<h2>` and any `.section-title`/`.report-section-head` heading |
| `--text-card-title` | 15px | `<h3>` — a card or widget's own title |
| `--text-base` | 14px | Body copy |
| `--text-caption` | 12px | `<small>`, table captions, secondary metadata |
| `--text-metric` | 32px | A KPI's headline number (`.kpi-value`, `.text-metric`) |
| `--text-status-label` | 12px | Status badge text (`.pill`, `.badge`, `.text-status-label`) |

`h1`–`h4` and `small` reference these tokens directly in `base.css` — a page never sets its own
heading font-size. Utility classes `.text-metric` / `.text-status-label` / `.text-body` exist
for the few spots that need this scale outside a literal heading element.

### Spacing
Fixed scale, `--space-1` through `--space-12`: **4, 8, 12, 16, 20, 24, 32, 40, 48px.** Every
margin/padding/gap in the shared component CSS uses one of these — no arbitrary values (an
`18px` or `30px` margin should never appear in new CSS).

### Radius
| Token | Value | Use |
|---|---|---|
| `--radius-sm` | 9px | Buttons, inputs, small controls, chips |
| `--radius` | 12px | Cards, panels, standard dialogs |
| `--radius-lg` | 20px | Large panels / the mobile bottom-sheet sidebar |

### Shadows
Two, deliberately restrained: `--shadow` (a very soft `2px` ambient shadow for resting cards)
and `--shadow-overlay` (a heavier shadow for anything floating above the page — dialogs,
dropdowns, toasts). No page adds a third, heavier shadow — "premium SaaS," not "heavy dashboard."

## Sidebar (`public/index.html` nav + `public/components/layout/app-shell.js`)

Six semantic groups over the real route set (no invented pages):

- **Home** — Overview
- **AI & Operations** — Command Center, Agent Team, Automation (Workflows)
- **Business** — Customers & Sales (CRM), Calendar & Scheduling
- **Growth** — Content & Approvals, Weekly Report
- **Platform** — Integrations, Brand Memory (Company Brain), Connection & Control Center,
  Guided Setup, and — for an authorized Platform Admin only — HyperCool Platform / Integration
  Builder
- **Account & System** — Operations Log, Team Accounts, My Account

Group labels are plain `<span class="nav-group">` elements inserted before the first route of
each cluster — pure presentation, no change to any route, href, or id. A quick-jump icon rail
(`.sidebar-rail`) sits to the sidebar's own left edge with three broad zone icons; it is
independent of the six text groups and was left untouched in this pass to avoid touching the
route-order-sensitive `railGroupIndex()` logic.

## Page Header (`header()` in `public/components/ui/index.js`)

Every page gets exactly one, built once by `installShell()`: `<h1>` title +
description paragraph + a `.page-actions` slot on the trailing side for primary/secondary
buttons. A page never builds its own ad-hoc `<h1>`+description block.

## Cards, KPIs, Status

- `.panel` / `.card` / `.kpi-card` / `.stat` / `.report-section` share one visual treatment:
  `--surface` background, `--border`, `--radius`, `--shadow`, a subtle lift-on-hover.
- `.kpi-grid` / `.stats` / `.crm-stats` use `repeat(auto-fit, minmax(200px, 1fr))` (changed from a
  fixed 4-column grid) so 3, 4, 5, or more KPI cards always fill their row evenly — never one
  orphaned card alone on its own row.
- **Status badges** (`.pill` / `.badge`) are driven entirely by a `data-status="VALUE"` attribute
  mapped to the semantic color tokens (e.g. `COMPLETED`/`CONNECTED`/`WON` → good;
  `PENDING`/`DRAFT`/`NEEDS_SETUP` → warn; `FAILED`/`BLOCKED`/`REJECTED` → critical;
  `RUNNING`/`SCHEDULED` → accent). One selector list in `components.css` — a new status value is
  added there once, never restyled per page.

## Frost Command Center layout

Restructured in this pass from two independently-stacked two-column grids (which produced
uneven, disconnected column heights — the main chat column ending far above a tall side rail,
and vice versa on the row below) into **one** `.cmdc-layout` grid: a wide `.cmdc-main` column
(chat, then the Data & Context tabs, stacked) beside **one** persistent `.cmdc-side` rail
(Suggestions → Live Operations → System Map → Workflows → AI Usage, in that order). This is the
single largest layout change in this pass — see the Final Report for before/after detail.

## Empty / Loading / Error states

- `empty(title, description)` — icon + title + description + optional CTA. Used everywhere a
  list/table could be genuinely empty (never a blank page).
- `skeleton(label)` — a pulsing placeholder block, used consistently instead of a literal
  "Loading…" string.
- API failures render through the same `empty()` helper with the real error message — never a
  raw stack trace or technical error code shown to the user.

## Tables, Forms, Dialogs

Unified once in `components.css`: sticky header row, hover row highlight, a `.table-toolbar` /
`.table-footer` pattern (search + pagination), consistent input/select/textarea styling with a
visible focus ring, and one dialog/drawer treatment (`dialog.drawer` slides in from the trailing
edge; `.confirmation` is the small centered variant for a yes/no or short form).

## Phase UI-2 — deep route polish patterns

### Bounded scrollable lists (the "no 21,000px page" pattern)

The single most severe defect this pass found: CRM's quote list, B2B opportunity list, and hot
leads grid each rendered *every* matching record directly into page flow with no cap — on
realistic demo data this produced a genuine ~21,600px-tall page with badly uneven two-column
heights (`align-items:stretch` stretching an empty sibling column to match). The fix, applied
consistently: a `max-height` + `overflow:auto` + a small `padding-inline-end` (so the scrollbar
never overlaps content) on the list container itself — never touching how many records the
backend returns. This is the same pattern `.cmdc-ops-list` (Command Center) already used;
`.sales-quote-list`, `.sales-business-cards`, `#crm-lead-list`, and `#crm-hot-leads .grid` now
follow it too. **Rule**: any list rendered by mapping an array with no known small upper bound
must be capped this way — never left to grow the page unboundedly.

### Builder wizard — numbered steps and section breaks

The Integration Builder's steps 1-3 (Basic/Auth/Capabilities) intentionally share one scrollable
panel (the create call is atomic). Two fixes: the tab label now carries its number range
(`1-3. ...`) consistently with every other numbered tab, and `.builder-basic-panel h4` gets a
real top border + spacing before each sub-section (never before the first) — scoped to that one
panel only (`basicPanel.className='builder-basic-panel'`), so no other drawer's `<h4>` anywhere
in the app is affected.

### Platform Admin's quiet system-level accent

Platform Admin uses the exact same cards/tables/tokens as any tenant page — per spec, no
redesign, just a quiet signal that this is the operator surface. `#platform .pfcc-card` (the
Platform Command Center hero card) gets a 3px `--info` top border instead of the tenant
`--accent` purple, and `#platform .kpi-card .kpi-value` renders in `--info` too. Both rules are
scoped to `#platform` — zero effect on any tenant page, and the very same `.kpi-card`/`.pfcc-card`
markup a tenant page uses is untouched there.

### Custom file input control

The one native `<input type=file>` visible to a user (Command Center's chat attachment) used to
show the browser's own unlocalized "Choose File" button. Fixed with the standard accessible
pattern: the real `<input>` stays in the DOM, fully functional (`.files`, keyboard Tab stop,
screen-reader label) but visually hidden via `.file-input-native` (clip-based hiding, never
`display:none`, which would break keyboard/AT access); a `<label for="cmdc-attach-input">`
styled as a normal secondary button acts as the visible trigger (native label-click delegation,
no JS proxy click needed); a `change` listener writes the real selected filename into
`#cmdc-attach-status` (localized `commandCenter.chooseFile` / `commandCenter.noFileChosen`,
ar+en). Apply this exact pattern to any future visible file input — never leave one showing raw
browser chrome.

## Phase UI-3 — final consistency closure

### CRM semantic color cleanup — what was replaced, what was kept

Audited every hardcoded hex value inside `.sales-*` rules (~40 of them). Replaced ~25 that were
plain neutrals (backgrounds/borders/muted text with no semantic meaning of their own) with the
matching token (`--surface`, `--border`, `--ink-muted`, `--surface-2`, `--ink`, plus the named
type-scale tokens for font-sizes that were hardcoded px). **Deliberately kept** three
hue-carrying families that are real, useful information design, not leftover cruft: the blue
`#819fd0`/`#5b7caa`/`#e9f0f9` family (B2B opportunity cards), the gold `#ccb178`/`#b19459`/
`#f8edd4`/`#706141` family (quote cards), and the warm `#fffaf1` tint (hot-lead cards) — CRM uses
color to distinguish its own three card types at a glance, and flattening that to one accent
color would remove real information, not just tidy up CSS. Also fixed `.sales-empty-state`'s own
teal accent (`#6d95a8`/`#e9f1f6`), which was an unexplained deviation from the app-wide
`.empty` convention (`--accent` icon) — now matches it.

### Reports' real long list — corrected identification

Phase UI-2's audit assumed the long "success metrics" list was `.recommendation-list`; a deeper
DOM inspection this pass found the actual repeating container was `.risk-list` (27 `.pill`
badges across the page, spread over two `.risk-list` sections) — `.recommendation-list` was
already short (4 items). Both are now capped with the standard `.scroll-region` pattern (see
below); Reports' total page height dropped from 7,269px to 5,747px.

### The standard scroll-region pattern, named at last

Five separate call sites (`.cmdc-ops-list`, `.sales-quote-list`, `.sales-business-cards`,
`#crm-lead-list`, `#crm-hot-leads .grid`, `.risk-list`, `.recommendation-list`) now share the
exact same values (`max-height:640px` — or `900px` for the two densest CRM grids —
`overflow:auto`, `padding-inline-end:4px`), formally named and documented as `.scroll-region` in
`base.css`. New long lists should reuse these exact values even where composing the literal
class isn't practical (each existing call site is a single-purpose selector; retrofitting them
to literally share one class name would touch JS in three separate files for no visual gain).

### Raw enum leak fixed (Agent readiness blockers)

A real, concrete instance of "raw technical UI visible to an investor": an agent's readiness
blockers/warnings are internal reason codes (`AI_NOT_CONFIGURED`, `AGENT_DISABLED`,
`REQUIRED_TOOL_<status>:<slug>`) meant for logs — Control Center's "needs attention" panel, the
agent card grid, and the agent drawer's Overview tab all rendered them completely raw. Added
`BLOCKER_LABEL()` (`control-center.js`), which translates the three fixed codes into a real
sentence and reuses the existing `TOOL_STATUS_LABEL()` for the one dynamic pattern — a genuinely
unrecognized code still falls back to itself (honest, never hidden, never invented).

### Mobile overflow fixed (Command Center at ~390px)

Phase UI-1's own `.cmdc-layout` mobile breakpoint collapsed the two-column grid to a bare `1fr`
column — CSS Grid items default to `min-width:auto`, so a wide child (the Data & Context tab
bar, 6 tabs) forced the column, and the whole page, wider than the viewport. Fixed to
`minmax(0,1fr)`, matching the desktop rule's own `minmax(0,1.7fr)` — the tab bar now correctly
scrolls within its own bounds (it already had `overflow:auto`) instead of stretching the page.
**Rule**: any CSS Grid column that must shrink below its content's natural width needs an
explicit `minmax(0, ...)`, never a bare fraction — this is the single most common cause of
"page is 8px wider than the viewport" bugs in a grid-based layout.

## What remains unredesigned (honest, not silently dropped)

Agent Detail's tabbed drawer (Control Center → Agent Map → an agent's own name) already uses the
exact shared `tabs()` component correctly; it looks sparse mainly because a freshly-seeded agent
with no AI configured genuinely has little to show, not because of a layout defect — left alone
rather than manufacturing content to fill it (its one real gap, the raw blocker codes, is now
fixed — see above). The Integration Builder's Actions/Webhooks/Health/Versions/Review/Analytics
tabs (steps 4-9) were audited for gross defects in UI-2 but not given the same deep pass as step
1-3's panel; no concrete issue was found there, so none was manufactured.
