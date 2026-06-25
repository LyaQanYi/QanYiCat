// Vite supports `import x from './foo.cjs?raw'` to embed file contents as a
// string. This shim makes TypeScript accept the syntax.
declare module '*?raw' {
  const content: string;
  export default content;
}
