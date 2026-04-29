export type GhRef = { owner: string; repo: string; number: number };

const MARKER_RE = /^<!-- gh-ref: ([^/\s]+)\/([^#\s]+)#(\d+) -->$/;

export function formatMarker(ref: GhRef): string {
  return `<!-- gh-ref: ${ref.owner}/${ref.repo}#${ref.number} -->`;
}

export function parseMarker(description: string): GhRef | null {
  const firstLine = description.split("\n").find((l) => l.trim().length > 0);
  if (!firstLine) return null;
  const m = firstLine.trim().match(MARKER_RE);
  if (!m) return null;
  const [, owner, repo, n] = m;
  const number = Number(n);
  if (!Number.isInteger(number) || number <= 0) return null;
  return { owner, repo, number };
}

export function hasMarker(description: string, marker: string): boolean {
  return description.includes(marker);
}
