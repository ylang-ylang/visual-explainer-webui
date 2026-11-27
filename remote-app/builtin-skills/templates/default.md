---
title: Default Wiki & Component Diff
whenToUse: Default structure for multi-page explanations, architecture overviews, and proposing new ideas or component changes (L0 overview / impact map + L1 component drill-down & before/after diffs).
---

# Default Wiki & Component Diff Template

## 1. Role & Non-Conflict Boundary

- This template governs **multi-page structure**: what belongs on the parent page vs child pages, what to highlight, and what to omit.
- Upstream `SKILL.md` and `references/*` govern **single-page visual craft**: register styling (Blueprint / Instrument / Paper), `<ve-flow>` and SVG legibility, typography hierarchy, and checksheet QA.
- Treat them as complementary layers — follow upstream rendering rules on every page and use this template to partition content cleanly across pages.

## 2. Parent Page (`<topic>.html`, L0 Overview)

- Deliver a **one-screen mental model** (system map or impact map) plus key conclusions, ownership boundaries, and reading order. Keep L0 scannable — never cram deep implementation details or long prose into the parent page.
- **Idea, feature proposal, or refactor mode**:
  - Highlight impacted components directly on the overview map using distinct visual state badges: **New**, **Modified**, **Coupled**, and **Unchanged**.
  - State the change thesis, scope boundaries, and rollout order concisely.
  - Attach `data-ve-child="<component>"` to every changed or deep-dive component node.
- **Existing system or concept mode**:
  - Map the major subsystems, control/data flows, and trust or state boundaries.
  - Attach `data-ve-child="<component>"` to each major subsystem or mechanism that warrants a dedicated view.
- **Portal links**: never add custom fake-portal CSS on `data-ve-child` nodes. The WebUI viewer injects stacked badges, hover thumbnail popovers, and click navigation at view time.

## 3. Component Child Pages (`<topic>/<component>.html`, L1 Drill-Down)

- Publish each child page at `<parent-stem>/<component>.html` using the same scoped folder key. Keep each child strictly scoped to **one component** (add an L2 page `<parent-stem>/<component>/<subpart>.html` only when a sub-mechanism genuinely needs its own diagram).
- **In idea / feature / change-diff mode**, place the component's **change diff inside that component's child page**, directly answering *"what must change in this component to realize the idea?"*:
  - **Before → After structural diff**: data flow, state transitions, boundaries, or responsibilities added, changed, or removed.
  - **Concrete changes required**: interfaces/APIs, data schemas or storage files, state transitions, and config or contract updates.
  - **Impact, risks & verification**: upstream/downstream blast radius, edge cases, and concrete verification criteria.
- **In architecture / concept mode**, explain that component's internal mechanism, core invariants, data/control flow, and failure or edge modes.

## 4. What to Show vs What to Omit

- **Show**: component boundaries, flows with verb-labeled arrows, Before → After structural diffs, concrete change checklists, design trade-offs, and failure/risk boundaries.
- **Omit**: raw source file dumps or long config listings, repeating unchanged modules in detail, decorative filler KPIs or cards with no decision value, and stuffing every component diff onto the L0 overview page.
