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

## What this pass did NOT redesign

Being explicit rather than silently claiming blanket coverage — see the Final Report's honest
per-page scoring. Untouched at the content/structure level (they already used the shared
component system correctly and had no concrete defect found in the audit): CRM's own board/table
view, Reports' chart components, the Integration Builder's step-by-step wizard content, Agent
detail tabs, and Platform Admin's specific widgets. All of these already inherit every token,
color, spacing, radius, and status-badge change made in this pass automatically (that's the
point of a token-driven system) — they were not rebuilt because the audit found no concrete,
fixable defect in them worth the risk of a broader rewrite in a UI-only phase.
