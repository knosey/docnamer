/** mac-ocr ships a prebuilt binary, and bun's `with { type: 'file' }` import of
 * it resolves to that binary's path at runtime — a module TypeScript cannot
 * look up on disk, so its shape is declared here. */
declare module '*/bin/mac-ocr' {
  const path: string
  export default path
}
