import type { Segment } from './domain';

export type TextLocation = { start: number; end: number; text: string };

export function SearchMark({ text, location }: { text: string; location?: TextLocation }) {
  if (
    !location ||
    location.text !== text ||
    location.start < 0 ||
    location.end > text.length ||
    location.end <= location.start
  )
    return text;
  return (
    <>
      {text.slice(0, location.start)}
      <mark className="search-location-mark" id="search-location-mark">
        {text.slice(location.start, location.end)}
      </mark>
      {text.slice(location.end)}
    </>
  );
}

export function characterLocation(segment: Segment, ids?: string[]): TextLocation | undefined {
  if (!ids?.length) return;
  const wanted = new Set(ids);
  const visible = segment.chars.filter((char) => !char.deleted);
  const start = visible.findIndex((char) => wanted.has(char.id));
  const end = start + wanted.size;
  if (
    start < 0 ||
    end > visible.length ||
    visible.slice(start, end).some((char) => !wanted.has(char.id))
  )
    return;
  const before = visible
    .slice(0, start)
    .map((char) => char.value)
    .join('');
  const match = visible
    .slice(start, end)
    .map((char) => char.value)
    .join('');
  if (!segment.text.startsWith(before + match)) return;
  return { start: before.length, end: before.length + match.length, text: segment.text };
}
