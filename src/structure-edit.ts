export type EditRange = { start: number; end: number; replacement: string };
export function codepointOffset(value: string, utf16Offset: number): number {
  return Array.from(value.slice(0, utf16Offset)).length;
}
/** Derive edits from the concrete DOM selection, never from a whole-string diff. */
export function inputRange(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  inputType: string,
  data: string | null,
): EditRange | null {
  let start = codepointOffset(value, selectionStart),
    end = codepointOffset(value, selectionEnd);
  const chars = Array.from(value);
  if (inputType === 'insertLineBreak' || inputType === 'insertParagraph')
    return { start, end, replacement: '\n' };
  // Autocorrection's hidden replacement range is not reliably exposed by textarea DOM APIs.
  if (inputType === 'insertReplacementText' && start === end) return null;
  if (inputType.startsWith('insert') && data !== null) return { start, end, replacement: data };
  if (inputType.startsWith('delete')) {
    if (start === end) {
      if (inputType === 'deleteContentBackward') start = Math.max(0, start - 1);
      else if (inputType === 'deleteContentForward') end = Math.min(chars.length, end + 1);
      else if (inputType === 'deleteWordBackward') {
        while (start > 0 && /\s/u.test(chars[start - 1])) start--;
        while (start > 0 && !/\s/u.test(chars[start - 1])) start--;
      } else if (inputType === 'deleteWordForward') {
        while (end < chars.length && /\s/u.test(chars[end])) end++;
        while (end < chars.length && !/\s/u.test(chars[end])) end++;
      } else if (inputType === 'deleteSoftLineBackward' || inputType === 'deleteHardLineBackward') {
        while (start > 0 && chars[start - 1] !== '\n') start--;
      } else if (inputType === 'deleteSoftLineForward' || inputType === 'deleteHardLineForward') {
        while (end < chars.length && chars[end] !== '\n') end++;
      } else return null;
    }
    return { start, end, replacement: '' };
  }
  return null;
}
export const replacedValue = (before: string, range: EditRange) => {
  const chars = Array.from(before);
  return chars.slice(0, range.start).join('') + range.replacement + chars.slice(range.end).join('');
};
