/**
 * Maps a file path to a Monaco language id.
 *
 * Only ids that Monaco actually ships are used; anything unknown falls back to
 * `plaintext` so the editor still opens the file instead of erroring.
 */

const EXTENSION_LANGUAGES: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "json",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  htm: "html",
  vue: "html",
  svelte: "html",
  md: "markdown",
  markdown: "markdown",
  rs: "rust",
  py: "python",
  go: "go",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  rb: "ruby",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  yaml: "yaml",
  yml: "yaml",
  xml: "xml",
  svg: "xml",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  lua: "lua",
  r: "r",
  pl: "perl",
  m: "objective-c",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
  // Monaco ships no TOML grammar; INI is close enough to keep keys and
  // strings readable rather than falling back to unhighlighted plaintext.
  toml: "ini",
  tex: "plaintext",
  txt: "plaintext",
  log: "plaintext",
};

/** Files whose language is determined by the whole name, not an extension. */
const FILENAME_LANGUAGES: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "plaintext",
  ".gitignore": "plaintext",
  ".env": "ini",
  ".bashrc": "shell",
  ".zshrc": "shell",
};

export function languageForPath(path: string): string {
  const name = (path.split("/").pop() ?? path).toLowerCase();

  const byName = FILENAME_LANGUAGES[name];
  if (byName) return byName;

  // "Dockerfile.prod" and friends still read as Dockerfiles.
  if (name.startsWith("dockerfile")) return "dockerfile";

  // A leading dot is part of the name (".env"), not an extension separator,
  // so only split on dots that appear after the first character.
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "plaintext";

  const extension = name.slice(dot + 1);
  return EXTENSION_LANGUAGES[extension] ?? "plaintext";
}
