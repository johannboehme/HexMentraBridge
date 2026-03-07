export function formatAgo(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}

export function isNoReply(text: string): boolean {
  const t = text.trim();
  return !t || /^NO[_]?R?E?P?L?Y?$/i.test(t) || t.startsWith('NO_REPLY') || t.startsWith('NO_RE');
}
