/** Bundler asset modules; the renderer resolves these to emitted files. */
declare module '*.jpg' {
  const src: string
  export default src
}

declare module '*.png' {
  const src: string
  export default src
}
