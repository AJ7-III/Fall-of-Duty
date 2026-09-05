// Public-folder asset URLs that survive a non-root deploy (GitHub Pages
// serves the game from /<repo>/, so absolute "/models/..." paths would 404)
export function assetUrl(path: string): string {
  return `${import.meta.env.BASE_URL}${path.replace(/^\//, "")}`;
}
