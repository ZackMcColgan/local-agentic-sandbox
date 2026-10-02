# Workspace Rules: UI Engineering & Visual Design Standards

## 1. Mandatory Visual Inspection Rule (Non-Negotiable)
Any time you create, modify, refactor, or adjust any frontend UI component, styling, layout, or design asset (React components, Tailwind/CSS styles, themes, templates, navigation, typography, or forms):
1. **Never guess or assume what CSS/HTML changes look like.**
2. **Capture Rendered Screenshots**: Run the automated visual test suite (`npm run test:ui` / `node scripts/test-ui-render.js` or headless browser capture).
3. **Actually Look at the Rendered UI**: Use `view_file` to visually inspect the resulting image files across both **Desktop** and **Mobile** viewports in both **Daytime (Light Mode)** and **Dark Mode**.
4. **Iterate and Refine**: Critically review visual hierarchy, contrast, whitespace, alignment, and responsiveness. Fix any visual flaws, re-capture, and re-verify before finalizing or reporting to the user.

---

## 2. Expert Frontend Engineer & UI Designer Principles

### A. Daytime / Light Mode Purity
- **No Grayscale Washes**: Light mode must use crisp, pure, bright white (`#ffffff` / `bg-white`) backgrounds for cards, headers, inputs, and pages. Never use dull, muddy gray fills (`bg-slate-100`, `bg-slate-200`) as full page or card backgrounds.
- **High-Contrast Readability**: Body text must use deep, high-contrast dark tones (`text-slate-900`, `text-slate-800`), and secondary text must stay easily readable (`text-slate-600` / `text-slate-700`).
- **Clean Borders & Subtle Elevation**: Differentiate surfaces with crisp borders (`border-slate-200`, `border-slate-100`) and subtle shadows (`shadow-sm`, `shadow-md`), not muddy background fills.
- **Accents**: Use soft, clean, tinted glass or gentle pastels (e.g. `bg-blue-50/90 border-blue-200 text-blue-950` for user bubbles) that complement the emerald security aesthetic.

### B. Dark Mode Elegance
- **Deep Contrast**: Dark mode should use rich dark zinc/slate surfaces (`bg-zinc-950`, `bg-black`, `bg-zinc-900`) with emerald (`#10b981`), sky (`#38bdf8`), and cyan accents.
- **Subtle Glass Elevation**: Use translucent borders (`border-zinc-800`, `border-white/10`) and glass backdrops (`backdrop-blur-md`).
- **Synchronous Hydration**: Ensure theme hydration runs synchronously before the browser paints to prevent flashes of unstyled content or hybrid light/dark state.

### C. Mobile Viewport & Responsive Engineering
- **Dynamic Viewport Units**: Use `100dvh` flex column layouts with `min-h-0` flex children. Never leave empty black voids or scroll locks below the chat input.
- **Docked Input Bars**: Pinned input bars must support mobile safe-area insets (`pb-[calc(0.75rem+env(safe-area-inset-bottom))]`).
- **Zero Horizontal Overflow**: Every element must fit within narrow mobile viewports (`320px` to `390px`) without horizontal clipping or swiping.
- **Adaptive Header Layout**: On mobile viewports (`< 640px`), condense text branding to icon-only logos and use compact control chips so navigation tabs, model dropdowns, and theme toggles fit with comfortable margins.
- **Touch-Friendly Controls**: Ensure buttons and interactive pills support smooth touch momentum scrolling (`-webkit-overflow-scrolling: touch`) and hide scrollbars (`scrollbar-width: none`).

---

## 3. Deployment Verification Checklist
Before declaring any UI task complete:
- [ ] Per-change test verification: Root `npm run test:gate` passes (<90s budget, change-aware selection, zero-coverage-is-an-error). Full suite runs in CI + overnight.
- [ ] Code passes typechecking and production build (`npm run build` exits code 0).
- [ ] Automated visual test run (`npm run test:ui`).
- [ ] All 4 visual permutations inspected with `view_file` (Desktop Light, Mobile Light, Desktop Dark, Mobile Dark).
- [ ] Container deployed and verified on localhost and LAN endpoints (`:3001` and `:80`).
