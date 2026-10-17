// `flow` is installed by tests/run-e2e.ts on globalThis before spec files load.
declare global {
  function flow(name: string, fn: unknown): Promise<void>;
}

export {};
