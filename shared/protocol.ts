export type RuleSet = "prelim" | "playoff";

export const PRELIM_SCORE_VALUES = [-1, 1] as const;
export const PLAYOFF_SCORE_VALUES = [-2, -1, 3, 4, 5, 6, 1] as const;

export type PlayerStatus = "ready" | "buzzed" | "locked";

export interface PlayerView {
  id: string;
  nickname: string;
  score?: number;
  connected: boolean;
  teamId?: string;
  status: PlayerStatus;
}

export interface BuzzView {
  playerId: string;
  acceptedAt: number;
  sequence: number;
}

export interface TeamView {
  id: string;
  name: string;
}

export interface TimerView {
  durationMs: number;
  remainingMs: number;
  running: boolean;
  startedAt: number | null;
}

export interface RoomSettings {
  oneBuzzOnly: boolean;
  manualLock: boolean;
  allowNewPlayers: boolean;
  showBuzzList: boolean;
  showPlayerPoints: boolean;
  showTimer: boolean;
  playBuzzSound: boolean;
}

export interface RoomView {
  code: string;
  ruleSet: RuleSet;
  players: PlayerView[];
  buzzes: BuzzView[];
  settings: RoomSettings;
  automaticBuzzLock: boolean;
  effectiveLocked: boolean;
  teams: TeamView[];
  timer: TimerView;
  createdAt: number;
  ended: boolean;
}

export interface Viewer {
  role: "host" | "player";
  playerId?: string;
}

export type HostAction =
  | { action: "clearBuzzers" }
  | { action: "toggleLock" }
  | { action: "score"; playerId: string; delta: number }
  | { action: "removePlayer"; playerId: string }
  | { action: "renamePlayer"; playerId: string; nickname: string }
  | { action: "setSettings"; settings: Partial<Pick<RoomSettings, "oneBuzzOnly" | "allowNewPlayers" | "showBuzzList" | "showPlayerPoints" | "showTimer" | "playBuzzSound">> }
  | { action: "removeAllPlayers" }
  | { action: "removeAllPoints" }
  | { action: "addTeam"; name: string }
  | { action: "renameTeam"; teamId: string; name: string }
  | { action: "deleteTeam"; teamId: string }
  | { action: "assignTeam"; playerId: string; teamId: string | null }
  | { action: "timer"; command: "start" | "pause" | "reset" | "set"; durationMs?: number }
  | { action: "endGame" };

export type ClientMessage =
  | { type: "createRoom"; ruleSet: RuleSet }
  | { type: "join"; code: string; nickname: string; sessionToken?: string }
  | { type: "hostConnect"; code: string; hostToken: string }
  | { type: "buzz" }
  | { type: "hostAction"; action: HostAction }
  | { type: "ping"; at: number };

export type ServerMessage =
  | { type: "created"; code: string; hostToken: string; room: RoomView }
  | { type: "joined"; role: Viewer["role"]; playerId?: string; sessionToken?: string; room: RoomView }
  | { type: "state"; room: RoomView; viewer: Viewer }
  | { type: "error"; code: string; message: string; fatal?: boolean }
  | { type: "pong"; at: number; serverTime: number };

export function isRuleSet(value: unknown): value is RuleSet {
  return value === "prelim" || value === "playoff";
}

export function scoreValuesForRuleSet(ruleSet: RuleSet): readonly number[] {
  return ruleSet === "playoff" ? PLAYOFF_SCORE_VALUES : PRELIM_SCORE_VALUES;
}

export function formatTimer(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
