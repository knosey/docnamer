// `flow` is installed by tests/preload.ts on globalThis before spec files load,
// which bunfig.toml applies as bun test's preload.
declare global {
  function flow(name: string, fn: unknown): Promise<void>
}

export {}
