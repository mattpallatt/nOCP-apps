// Stand-in for @zaiusinc/app-sdk's `logger` — every ported file's SDK
// logger import becomes this, unchanged otherwise. Kept as its own module
// (rather than inlining console.* at each call site) to minimize
// transcription risk in the dense ported files (cma.ts, transferEngine.ts).
export const logger = {
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  info: console.info.bind(console),
};
