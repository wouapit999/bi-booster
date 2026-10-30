# BI Booster Design Direction

## Mood

An energetic campaign war room: decisive cobalt, warm signal orange, ink-dark navigation, and a crisp white working canvas. The data feels active and legible; AI appears as a practical tool, not a decorative persona.

## Palette

- Primary: `oklch(0.57 0.17 247)`
- Accent: `oklch(0.69 0.17 42)`
- Background: `oklch(0.985 0.006 250)`
- Surface: `oklch(1 0 0)`
- Ink: `oklch(0.19 0.025 255)`
- Muted: `oklch(0.47 0.025 255)`
- Navigation: `oklch(0.16 0.035 258)`

## Typography

Use a sturdy, compact system sans stack for clear dashboard reading. Use weight, size, and spacing for hierarchy rather than a display face. Use tabular numerals for metrics.

## Components

- Compact left navigation with clear active state and visible client context.
- White work surfaces with restrained borders and modest corner radius.
- Cobalt primary actions; orange reserved for growth signals and key highlights.
- Charts use labeled axes, legends, and summaries so color is never the sole carrier of meaning.
- Status chips pair concise text with color.

## Interaction

Use short state transitions only; respect `prefers-reduced-motion`. Preserve strong focus indicators, large enough targets, and semantic names for icon buttons.
