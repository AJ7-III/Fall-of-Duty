export const DEFAULT_USER_DISPLAY_NAME = "Player 1";
export const RIVAL_DISPLAY_NAME = "IPwndUrMom";

let userDisplayName = DEFAULT_USER_DISPLAY_NAME;

export function normalizeUserDisplayName(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ").slice(0, 24);
  return normalized || DEFAULT_USER_DISPLAY_NAME;
}

export function setUserDisplayName(value: string): string {
  userDisplayName = normalizeUserDisplayName(value);
  return userDisplayName;
}

export function getUserDisplayName(): string {
  return userDisplayName;
}
