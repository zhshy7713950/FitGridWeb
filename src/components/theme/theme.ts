export type Theme = "light" | "dark";

export const themeStorageKey = "fitgrid-theme";
export const themeColors = { light: "#F3F6FB", dark: "#0B0F14" } as const;
const themeChangeEvent = "fitgrid-theme-change";

// Runs in <head>, before page content can paint. Only fixed application values
// are interpolated; saved values are normalized rather than inserted into HTML.
export const themeInitializationScript = `(()=>{
  let theme="light";
  try{theme=localStorage.getItem("${themeStorageKey}")==="dark"?"dark":"light"}catch{}
  const root=document.documentElement;
  root.dataset.theme=theme;
  root.style.colorScheme=theme;
  for(const [name,content] of [["theme-color",theme==="dark"?"${themeColors.dark}":"${themeColors.light}"],["color-scheme",theme]]){
    let meta=document.querySelector('meta[name="'+name+'"]');
    if(!meta){meta=document.createElement("meta");meta.name=name;document.head.appendChild(meta)}
    meta.content=content;
  }
})()`;

export function getTheme(): Theme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

export function getServerTheme(): Theme {
  return "light";
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", themeColors[theme]);
  document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", theme);
  window.dispatchEvent(new Event(themeChangeEvent));
}

export function toggleTheme(): void {
  const theme = getTheme() === "light" ? "dark" : "light";
  applyTheme(theme);
  try {
    window.localStorage.setItem(themeStorageKey, theme);
  } catch {
    // The document remains the session's source of truth when storage is blocked.
  }
}

export function subscribeToTheme(onChange: () => void): () => void {
  function onStorage(event: StorageEvent) {
    if (event.key !== themeStorageKey && event.key !== null) return;
    if (event.storageArea) {
      try {
        if (event.storageArea !== window.localStorage) return;
      } catch {
        return;
      }
    }
    applyTheme(event.newValue === "dark" ? "dark" : "light");
  }
  window.addEventListener(themeChangeEvent, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(themeChangeEvent, onChange);
    window.removeEventListener("storage", onStorage);
  };
}
