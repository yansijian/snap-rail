/**
 * Bitmap imports resolve to their URL (inlined or emitted by the bundler),
 * so their default export is a plain string.
 */
declare module '*.jpg' {
  const src: string
  export default src
}

declare module '*.png' {
  const src: string
  export default src
}
