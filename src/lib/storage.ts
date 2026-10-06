const playerIntentKey = "buzzin-player-intent";

export interface PlayerIntent {
  code: string;
  nickname: string;
}

export function hostTokenKey(code: string): string {
  return `buzzin-host-${code}`;
}

export function playerTokenKey(code: string): string {
  return `buzzin-player-${code}`;
}

export function getHostToken(code: string): string | null {
  return window.localStorage.getItem(hostTokenKey(code));
}

export function saveHostToken(code: string, token: string): void {
  window.localStorage.setItem(hostTokenKey(code), token);
}

export function getPlayerToken(code: string): string | null {
  return window.localStorage.getItem(playerTokenKey(code));
}

export function savePlayerToken(code: string, token: string): void {
  window.localStorage.setItem(playerTokenKey(code), token);
}

export function savePlayerIntent(intent: PlayerIntent): void {
  window.sessionStorage.setItem(playerIntentKey, JSON.stringify(intent));
  window.localStorage.setItem("buzzin-last-player-intent", JSON.stringify(intent));
}

export function getPlayerIntent(code?: string): PlayerIntent | null {
  const candidates = [
    window.sessionStorage.getItem(playerIntentKey),
    window.localStorage.getItem("buzzin-last-player-intent"),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const intent = JSON.parse(candidate) as PlayerIntent;
      if (intent && typeof intent.code === "string" && typeof intent.nickname === "string" && (!code || intent.code === code)) {
        return intent;
      }
    } catch {
      // A stale browser value should never stop a player from joining again.
    }
  }
  return null;
}

export function clearPlayerIntent(): void {
  window.sessionStorage.removeItem(playerIntentKey);
}
