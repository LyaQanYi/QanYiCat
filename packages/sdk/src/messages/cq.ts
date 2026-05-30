/** Minimal CQ-code helpers for SDK consumers who prefer string mode. */
export function escapeCq(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/\[/g, '&#91;').replace(/\]/g, '&#93;');
}

export function unescapeCq(s: string): string {
  return s.replace(/&#93;/g, ']').replace(/&#91;/g, '[').replace(/&amp;/g, '&');
}
