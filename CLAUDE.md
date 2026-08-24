# CLAUDE.md

Project-specific instructions for Claude when working on Wafflepad.

## Skills

This project has custom skills for in-depth guidance:

| Skill | Description |
|-------|-------------|
| `/react` | React 19 best practices, hooks, state management and data fetching |
| `/tailwind` | Tailwind CSS v4 best practices, configuration and patterns |
| `/rust` | Tauri v2 and Rust backend patterns, commands, state, IPC and security |
| `/commit` | Run lint and build checks, then create a conventional commit |
| `/diff` | Review uncommitted changes for correctness, hazards and conventions |

Use these skills for detailed code examples and comprehensive guidance.

## Project Overview

Wafflepad is a macOS Launchpad alternative built with Tauri, React 19 and TypeScript. It provides a full-screen app launcher with vibrancy blur effect, drag-and-drop reordering and folder support.

## Tech Stack

- **Frontend**: React 19, TypeScript, Tailwind CSS v4, Vite 8
- **Drag & Drop**: Custom implementation (src/lib/helper-dnd) - center-crossing detection, direct DOM manipulation
- **Backend**: Rust, Tauri v2
- **Package Manager**: Bun
- **Icons**: NSWorkspace API (via Tauri)

## Project Structure

```
src/
├── components/     # React components
├── constants/      # Shared constants (grid geometry, drag-and-drop)
├── contexts/       # React contexts (config)
├── hooks/          # Custom React hooks (useApps, useDragGrid, etc.)
├── lib/helper-dnd/ # Custom drag-and-drop engine
├── types/          # TypeScript type definitions
├── utils/          # Utility functions
├── main.tsx        # App entry point
└── index.css       # Global styles (Tailwind)
src-tauri/          # Rust/Tauri backend
```

## Commands

```bash
bun install         # Install dependencies
bun tauri dev       # Development mode
bun tauri build     # Production build
bun lint            # Run ESLint
bun lint:fix        # Fix ESLint issues
```

## Code Conventions

- Use named exports for components: `export function ComponentName()`
- Custom hooks in `src/hooks/` with `use` prefix
- Types in `src/types/` with `.ts` extension
- Utilities in `src/utils/`
- Tailwind for all styling (no CSS modules)
- Prefer `function` declarations over arrow functions for components

## React 19

This project uses React 19. Key principles:

- **Memoization is manual and rare**: the React Compiler is not in the build (plain `@vitejs/plugin-react`, no `babel-plugin-react-compiler`), so a parent render re-renders its whole subtree. Don't add `React.memo`, `useMemo` or `useCallback` speculatively; reserve them for a measured cost. `eslint-plugin-react-hooks` enforces the compiler's rules of React regardless
- **New hooks**: `use()`, `useOptimistic()`, `useActionState()`, `useFormStatus()`
- **Actions**: Use `useTransition` or form `action` prop for async mutations
- **Simplified patterns**: `ref` as prop (no `forwardRef`), `<Context value="">` syntax
- **Local state first**: Only lift state or use context when truly needed
- **Avoid unnecessary `useEffect`**: Most things do NOT need `useEffect`. Before adding one, consider:
  - **Derived values**: Compute during render, not in an effect (`const x = items.filter(...)`)
  - **State from props**: Call `setState` during render — React bails out and retries synchronously, no flash. `useEffect` would commit a render with stale values first
  - **Resetting state on prop change**: Use `key` prop to remount instead of an effect
  - **One-time setup**: Use refs with guards, not effects
  - **Only use `useEffect` for**: subscriptions, DOM manipulation, timers, and external system sync

For detailed patterns and code examples, use the `/react` skill.

## Git Workflow

**NEVER auto-commit or push without explicit approval.**

For commit conventions and message format, use the `/commit` skill.

## Testing

When implementing new features:
1. Run `bun lint` to check for issues
2. Run `bun tauri dev` to test in development
3. Run `bun tauri build` to verify production build
