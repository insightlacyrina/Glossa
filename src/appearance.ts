export type Appearance = 'light' | 'dark' | 'system';

const key = 'glossa:appearance';
const system = matchMedia('(prefers-color-scheme: dark)');

export function readAppearance(): Appearance {
  try {
    const saved = localStorage.getItem(key);
    if (saved === 'dark' || saved === 'system') return saved;
  } catch {
    // A restricted browser still has a usable default.
  }
  return 'light';
}

function apply(appearance: Appearance) {
  const dark = appearance === 'dark' || (appearance === 'system' && system.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  window.QuietPaperNative?.setAppTheme?.(dark);
}

export function startAppearance() {
  apply(readAppearance());
  system.addEventListener('change', () => apply(readAppearance()));
}

export function setAppearance(appearance: Appearance) {
  localStorage.setItem(key, appearance);
  apply(appearance);
}
