import { createHash, randomBytes, randomUUID, timingSafeEqual, randomInt } from "node:crypto";
import type {
  BuzzView,
  ClientMessage,
  HostAction,
  PlayerStatus,
  PlayerView,
  RoomSettings,
  RoomView,
  RuleSet,
  ServerMessage,
  TeamView,
  TimerView,
  Viewer,
} from "../shared/protocol.js";
import { isRuleSet, scoreValuesForRuleSet } from "../shared/protocol.js";

const ROOM_EXPIRY_MS = 6 * 60 * 60 * 1000;
const MAX_PLAYERS = 200;
const MAX_TEAMS = 32;
const MAX_MESSAGE_RATE = 35;
const MAX_ROOM_CREATIONS_PER_HOUR = 12;
const MAX_NICKNAME_LENGTH = 32;
const MAX_TEAM_NAME_LENGTH = 24;

export interface SocketConnection {
  id: string;
  ip: string;
  role: Viewer["role"] | null;
  playerId: string | null;
  roomCode: string | null;
  isOpen(): boolean;
  send(message: ServerMessage): void;
  close(code?: number, reason?: string): void;
}

interface InternalPlayer {
  id: string;
  nickname: string;
  score: number;
  connected: boolean;
  teamId?: string;
  sessionHash: string;
}

interface InternalRoom {
  code: string;
  ruleSet: RuleSet;
  players: Map<string, InternalPlayer>;
  buzzes: BuzzView[];
  settings: RoomSettings;
  automaticBuzzLock: boolean;
  teams: Map<string, TeamView>;
  timer: TimerView;
  createdAt: number;
  lastActivity: number;
  sequence: number;
  ended: boolean;
  hostTokenHash: string;
  hostConnections: Set<SocketConnection>;
  playerConnections: Map<string, Set<SocketConnection>>;
}

interface RateState {
  startedAt: number;
  count: number;
}

interface CreateRateState {
  startedAt: number;
  count: number;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function tokenMatches(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashToken(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function makeToken(): string {
  return randomBytes(32).toString("base64url");
}

function cleanText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value
    .normalize("NFKC")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim();
  if (!cleaned) return null;
  return Array.from(cleaned).slice(0, maxLength).join("");
}

function isSixDigitCode(value: unknown): value is string {
  return typeof value === "string" && /^\d{6}$/.test(value);
}

function now(): number {
  return Date.now();
}

function defaultSettings(): RoomSettings {
  return {
    oneBuzzOnly: true,
    manualLock: false,
    allowNewPlayers: true,
    showBuzzList: true,
    showPlayerPoints: true,
    showTimer: true,
    playBuzzSound: true,
  };
}

function defaultTimer(): TimerView {
  return {
    durationMs: 10_000,
    remainingMs: 10_000,
    running: false,
    startedAt: null,
  };
}

function viewerFor(connection: SocketConnection): Viewer {
  return connection.role === "player" && connection.playerId
    ? { role: "player", playerId: connection.playerId }
    : { role: "host" };
}

export class RoomManager {
  private readonly rooms = new Map<string, InternalRoom>();
  private readonly messageRates = new Map<string, RateState>();
  private readonly createRates = new Map<string, CreateRateState>();
  private readonly cleanupTimer: NodeJS.Timeout;

  constructor() {
    this.cleanupTimer = setInterval(() => this.tick(), 1_000);
    this.cleanupTimer.unref?.();
  }

  stop(): void {
    clearInterval(this.cleanupTimer);
  }

  handle(connection: SocketConnection, input: unknown): void {
    if (!this.consumeMessageRate(connection)) {
      this.sendError(connection, "rate_limited", "Too many messages. Please wait a moment.");
      return;
    }

    if (!input || typeof input !== "object" || Array.isArray(input)) {
      this.sendError(connection, "invalid_message", "That message could not be understood.");
      return;
    }

    const message = input as Partial<ClientMessage> & { type?: unknown };
    switch (message.type) {
      case "createRoom":
        this.createRoom(connection, message.ruleSet);
        break;
      case "join":
        this.joinRoom(connection, message.code, message.nickname, message.sessionToken);
        break;
      case "hostConnect":
        this.connectHost(connection, message.code, message.hostToken);
        break;
      case "buzz":
        this.buzz(connection);
        break;
      case "hostAction":
        this.hostAction(connection, message.action);
        break;
      case "ping":
        if (typeof message.at === "number" && Number.isFinite(message.at)) {
          connection.send({ type: "pong", at: message.at, serverTime: now() });
        }
        break;
      default:
        this.sendError(connection, "invalid_message", "That message could not be understood.");
    }
  }

  detach(connection: SocketConnection): void {
    this.messageRates.delete(connection.id);
    const room = connection.roomCode ? this.rooms.get(connection.roomCode) : undefined;
    if (!room) return;

    room.hostConnections.delete(connection);
    if (connection.playerId) {
      const connections = room.playerConnections.get(connection.playerId);
      connections?.delete(connection);
      if (connections && connections.size === 0) room.playerConnections.delete(connection.playerId);
      const player = room.players.get(connection.playerId);
      if (player && !connections?.size) player.connected = false;
    }

    connection.roomCode = null;
    connection.playerId = null;
    connection.role = null;
    room.lastActivity = now();
    this.broadcast(room);
  }

  /** Used by focused unit tests without exposing mutable room state to callers. */
  getRoom(code: string): RoomView | null {
    const room = this.rooms.get(code);
    return room ? this.serializeRoom(room, { role: "host" }) : null;
  }

  private createRoom(connection: SocketConnection, ruleSet: unknown): void {
    if (!isRuleSet(ruleSet)) {
      this.sendError(connection, "invalid_rules", "Choose Playoff Rules or Prelim Rules.");
      return;
    }
    if (connection.roomCode) {
      this.sendError(connection, "already_connected", "This connection is already in a game.");
      return;
    }
    if (!this.consumeCreateRate(connection.ip)) {
      this.sendError(connection, "rate_limited", "Too many games created from this address.");
      return;
    }

    let code = "";
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const candidate = String(randomInt(100_000, 1_000_000));
      if (!this.rooms.has(candidate)) {
        code = candidate;
        break;
      }
    }
    if (!code) {
      this.sendError(connection, "room_unavailable", "Unable to create a game right now.");
      return;
    }

    const hostToken = makeToken();
    const createdAt = now();
    const room: InternalRoom = {
      code,
      ruleSet,
      players: new Map(),
      buzzes: [],
      settings: defaultSettings(),
      automaticBuzzLock: false,
      teams: new Map(),
      timer: defaultTimer(),
      createdAt,
      lastActivity: createdAt,
      sequence: 0,
      ended: false,
      hostTokenHash: hashToken(hostToken),
      hostConnections: new Set(),
      playerConnections: new Map(),
    };
    this.rooms.set(code, room);
    this.attachHost(connection, room);
    connection.send({
      type: "created",
      code,
      hostToken,
      room: this.serializeRoom(room, { role: "host" }),
    });
  }

  private joinRoom(connection: SocketConnection, rawCode: unknown, rawNickname: unknown, rawToken: unknown): void {
    if (!isSixDigitCode(rawCode)) {
      this.sendError(connection, "invalid_code", "Game codes are six digits.", true);
      return;
    }
    const room = this.rooms.get(rawCode);
    if (!room || room.ended) {
      this.sendError(connection, "game_not_found", "Game not found.", true);
      return;
    }
    const nickname = cleanText(rawNickname, MAX_NICKNAME_LENGTH);
    if (!nickname) {
      this.sendError(connection, "invalid_nickname", "Please enter a nickname.", true);
      return;
    }
    if (connection.roomCode) {
      this.sendError(connection, "already_connected", "This connection is already in a game.");
      return;
    }

    let player: InternalPlayer | undefined;
    let sessionToken: string | undefined;
    if (typeof rawToken === "string" && rawToken.length >= 16) {
      player = [...room.players.values()].find((candidate) => tokenMatches(rawToken, candidate.sessionHash));
      if (!player) {
        this.sendError(connection, "session_expired", "That player session is no longer valid.", true);
        return;
      }
    } else {
      if (!room.settings.allowNewPlayers) {
        this.sendError(connection, "joining_disabled", "This game is no longer accepting new players.", true);
        return;
      }
      if (room.players.size >= MAX_PLAYERS) {
        this.sendError(connection, "game_full", "This game has reached its player limit.", true);
        return;
      }
      sessionToken = makeToken();
      player = {
        id: randomUUID(),
        nickname,
        score: 0,
        connected: true,
        sessionHash: hashToken(sessionToken),
      };
      room.players.set(player.id, player);
      room.playerConnections.set(player.id, new Set());
    }

    player.nickname = nickname;
    player.connected = true;
    connection.roomCode = room.code;
    connection.role = "player";
    connection.playerId = player.id;
    const playerSockets = room.playerConnections.get(player.id) ?? new Set<SocketConnection>();
    playerSockets.add(connection);
    room.playerConnections.set(player.id, playerSockets);
    room.lastActivity = now();

    connection.send({
      type: "joined",
      role: "player",
      playerId: player.id,
      ...(sessionToken ? { sessionToken } : {}),
      room: this.serializeRoom(room, { role: "player", playerId: player.id }),
    });
    this.broadcast(room);
  }

  private connectHost(connection: SocketConnection, rawCode: unknown, rawToken: unknown): void {
    if (!isSixDigitCode(rawCode) || typeof rawToken !== "string" || rawToken.length < 16) {
      this.sendError(connection, "invalid_host_session", "Host session not found.", true);
      return;
    }
    const room = this.rooms.get(rawCode);
    if (!room || room.ended || !tokenMatches(rawToken, room.hostTokenHash)) {
      this.sendError(connection, "invalid_host_session", "Host session not found.", true);
      return;
    }
    if (connection.roomCode) {
      this.sendError(connection, "already_connected", "This connection is already in a game.");
      return;
    }
    this.attachHost(connection, room);
    connection.send({ type: "joined", role: "host", room: this.serializeRoom(room, { role: "host" }) });
    this.broadcast(room);
  }

  private attachHost(connection: SocketConnection, room: InternalRoom): void {
    connection.roomCode = room.code;
    connection.role = "host";
    connection.playerId = null;
    room.hostConnections.add(connection);
    room.lastActivity = now();
  }

  private buzz(connection: SocketConnection): void {
    if (connection.role !== "player" || !connection.roomCode || !connection.playerId) {
      this.sendError(connection, "not_a_player", "Only a joined player can buzz.");
      return;
    }
    const room = this.rooms.get(connection.roomCode);
    if (!room || room.ended) {
      this.sendError(connection, "game_not_found", "Game not found.", true);
      return;
    }
    const player = room.players.get(connection.playerId);
    if (!player) {
      this.sendError(connection, "player_removed", "You have been removed from this game.", true);
      return;
    }
    const alreadyBuzzed = room.buzzes.some((buzz) => buzz.playerId === player.id);
    if (alreadyBuzzed) {
      this.sendError(connection, "already_buzzed", "You have already buzzed this round.");
      return;
    }
    if (room.settings.manualLock) {
      this.sendError(connection, "game_locked", "This game is locked.");
      return;
    }
    if (room.settings.oneBuzzOnly && room.buzzes.length > 0) {
      this.sendError(connection, "game_locked", "Another player buzzed first.");
      return;
    }

    room.sequence += 1;
    room.buzzes.push({ playerId: player.id, acceptedAt: now(), sequence: room.sequence });
    room.automaticBuzzLock = room.settings.oneBuzzOnly;
    room.lastActivity = now();
    this.broadcast(room);
  }

  private hostAction(connection: SocketConnection, action: unknown): void {
    if (connection.role !== "host" || !connection.roomCode || !isHostAction(action)) {
      this.sendError(connection, "not_authorized", "Only the host can do that.");
      return;
    }
    const room = this.rooms.get(connection.roomCode);
    if (!room || room.ended) {
      this.sendError(connection, "game_not_found", "Game not found.", true);
      return;
    }

    switch (action.action) {
      case "clearBuzzers":
        room.buzzes = [];
        room.automaticBuzzLock = false;
        break;
      case "toggleLock":
        room.settings.manualLock = !room.settings.manualLock;
        break;
      case "score":
        this.applyScore(room, action.playerId, action.delta, connection);
        return;
      case "removePlayer":
        this.removePlayer(room, action.playerId);
        break;
      case "renamePlayer":
        this.renamePlayer(room, action.playerId, action.nickname, connection);
        return;
      case "setSettings":
        this.applySettings(room, action.settings, connection);
        return;
      case "removeAllPlayers":
        this.removeAllPlayers(room);
        break;
      case "removeAllPoints":
        for (const player of room.players.values()) player.score = 0;
        break;
      case "addTeam":
        this.addTeam(room, action.name, connection);
        return;
      case "renameTeam":
        this.renameTeam(room, action.teamId, action.name, connection);
        return;
      case "deleteTeam":
        room.teams.delete(action.teamId);
        for (const player of room.players.values()) {
          if (player.teamId === action.teamId) delete player.teamId;
        }
        break;
      case "assignTeam":
        if (!room.players.has(action.playerId) || (action.teamId !== null && !room.teams.has(action.teamId))) {
          this.sendError(connection, "invalid_team_assignment", "That team assignment is no longer available.");
          return;
        }
        const assignedPlayer = room.players.get(action.playerId);
        if (assignedPlayer) {
          if (action.teamId === null) delete assignedPlayer.teamId;
          else assignedPlayer.teamId = action.teamId;
        }
        break;
      case "timer":
        this.applyTimer(room, action.command, action.durationMs, connection);
        return;
      case "endGame":
        this.endGame(room);
        return;
    }

    room.lastActivity = now();
    this.broadcast(room);
  }

  private applyScore(room: InternalRoom, playerId: string, delta: number, connection: SocketConnection): void {
    if (!Number.isInteger(delta) || !scoreValuesForRuleSet(room.ruleSet).includes(delta)) {
      this.sendError(connection, "invalid_score", "That score button is not available for this game.");
      return;
    }
    const player = room.players.get(playerId);
    if (!player) {
      this.sendError(connection, "player_not_found", "Player not found.");
      return;
    }
    player.score += delta;
    room.lastActivity = now();
    this.broadcast(room);
  }

  private renamePlayer(room: InternalRoom, playerId: string, rawNickname: unknown, connection: SocketConnection): void {
    const player = room.players.get(playerId);
    const nickname = cleanText(rawNickname, MAX_NICKNAME_LENGTH);
    if (!player || !nickname) {
      this.sendError(connection, "invalid_nickname", "Enter a nickname before saving.");
      return;
    }
    player.nickname = nickname;
    room.lastActivity = now();
    this.broadcast(room);
  }

  private applySettings(room: InternalRoom, rawSettings: unknown, connection: SocketConnection): void {
    if (!rawSettings || typeof rawSettings !== "object" || Array.isArray(rawSettings)) {
      this.sendError(connection, "invalid_settings", "Those settings could not be saved.");
      return;
    }
    const settings = rawSettings as Record<string, unknown>;
    const booleanKeys = ["oneBuzzOnly", "allowNewPlayers", "showBuzzList", "showPlayerPoints", "showTimer", "playBuzzSound"] as const;
    for (const key of booleanKeys) {
      if (key in settings && typeof settings[key] !== "boolean") {
        this.sendError(connection, "invalid_settings", "Those settings could not be saved.");
        return;
      }
    }
    for (const key of booleanKeys) {
      if (typeof settings[key] === "boolean") room.settings[key] = settings[key] as boolean;
    }
    room.automaticBuzzLock = room.settings.oneBuzzOnly && room.buzzes.length > 0;
    room.lastActivity = now();
    this.broadcast(room);
  }

  private removePlayer(room: InternalRoom, playerId: string): void {
    room.players.delete(playerId);
    room.buzzes = room.buzzes.filter((buzz) => buzz.playerId !== playerId);
    room.playerConnections.get(playerId)?.forEach((connection) => {
      connection.close(4004, "Removed by host");
    });
    room.playerConnections.delete(playerId);
    room.automaticBuzzLock = room.settings.oneBuzzOnly && room.buzzes.length > 0;
  }

  private removeAllPlayers(room: InternalRoom): void {
    for (const connections of room.playerConnections.values()) {
      connections.forEach((connection) => connection.close(4004, "Removed by host"));
    }
    room.players.clear();
    room.playerConnections.clear();
    room.buzzes = [];
    room.automaticBuzzLock = false;
  }

  private addTeam(room: InternalRoom, rawName: unknown, connection: SocketConnection): void {
    const name = cleanText(rawName, MAX_TEAM_NAME_LENGTH);
    if (!name) {
      this.sendError(connection, "invalid_team", "Enter a team name first.");
      return;
    }
    if (room.teams.size >= MAX_TEAMS) {
      this.sendError(connection, "too_many_teams", "This game has reached its team limit.");
      return;
    }
    const team = { id: randomUUID(), name };
    room.teams.set(team.id, team);
    room.lastActivity = now();
    this.broadcast(room);
  }

  private renameTeam(room: InternalRoom, teamId: string, rawName: unknown, connection: SocketConnection): void {
    const name = cleanText(rawName, MAX_TEAM_NAME_LENGTH);
    const team = room.teams.get(teamId);
    if (!team || !name) {
      this.sendError(connection, "invalid_team", "Enter a team name first.");
      return;
    }
    team.name = name;
    room.lastActivity = now();
    this.broadcast(room);
  }

  private applyTimer(room: InternalRoom, command: "start" | "pause" | "reset" | "set", rawDuration: number | undefined, connection: SocketConnection): void {
    this.updateTimer(room);
    switch (command) {
      case "start":
        if (room.timer.remainingMs <= 0) room.timer.remainingMs = room.timer.durationMs;
        if (!room.timer.running) {
          room.timer.running = true;
          room.timer.startedAt = now();
        }
        break;
      case "pause":
        room.timer.remainingMs = this.remainingMs(room);
        room.timer.running = false;
        room.timer.startedAt = null;
        break;
      case "reset":
        room.timer.running = false;
        room.timer.startedAt = null;
        room.timer.remainingMs = room.timer.durationMs;
        break;
      case "set": {
        if (!Number.isFinite(rawDuration) || !rawDuration || rawDuration < 1_000 || rawDuration > 3_600_000) {
          this.sendError(connection, "invalid_timer", "Timer duration must be between 1 second and 60 minutes.");
          return;
        }
        const durationMs = Math.round(rawDuration);
        room.timer.durationMs = durationMs;
        room.timer.remainingMs = durationMs;
        room.timer.running = false;
        room.timer.startedAt = null;
        break;
      }
    }
    room.lastActivity = now();
    this.broadcast(room);
  }

  private endGame(room: InternalRoom): void {
    room.ended = true;
    const connections = this.connectionsFor(room);
    this.rooms.delete(room.code);
    for (const connection of connections) {
      connection.send({ type: "error", code: "game_ended", message: "This game has ended.", fatal: true });
      connection.close(4001, "Game ended");
    }
  }

  private broadcast(room: InternalRoom): void {
    for (const connection of this.connectionsFor(room)) {
      if (!connection.isOpen()) continue;
      connection.send({
        type: "state",
        room: this.serializeRoom(room, viewerFor(connection)),
        viewer: viewerFor(connection),
      });
    }
  }

  private connectionsFor(room: InternalRoom): Set<SocketConnection> {
    const connections = new Set<SocketConnection>(room.hostConnections);
    for (const playerConnections of room.playerConnections.values()) {
      for (const connection of playerConnections) connections.add(connection);
    }
    return connections;
  }

  private serializeRoom(room: InternalRoom, viewer: Viewer): RoomView {
    this.updateTimer(room);
    const buzzedIds = new Set(room.buzzes.map((buzz) => buzz.playerId));
    const effectiveLocked = room.settings.manualLock || room.automaticBuzzLock;
    const players: PlayerView[] = [...room.players.values()].map((player) => {
      let status: PlayerStatus = "ready";
      if (buzzedIds.has(player.id)) status = "buzzed";
      else if (effectiveLocked) status = "locked";
      return {
        id: player.id,
        nickname: player.nickname,
        ...(viewer.role === "host" || room.settings.showPlayerPoints ? { score: player.score } : {}),
        connected: player.connected,
        ...(player.teamId ? { teamId: player.teamId } : {}),
        status,
      };
    });
    const visibleTimer = viewer.role === "host" || room.settings.showTimer
      ? {
          ...room.timer,
          remainingMs: this.remainingMs(room),
          ...(room.timer.running ? { startedAt: now() } : {}),
        }
      : { ...room.timer, remainingMs: 0, running: false, startedAt: null };
    return {
      code: room.code,
      ruleSet: room.ruleSet,
      players,
      buzzes: viewer.role === "host" || room.settings.showBuzzList ? [...room.buzzes] : [],
      settings: { ...room.settings },
      automaticBuzzLock: room.automaticBuzzLock,
      effectiveLocked,
      teams: [...room.teams.values()].map((team) => ({ ...team })),
      timer: visibleTimer,
      createdAt: room.createdAt,
      ended: room.ended,
    };
  }

  private remainingMs(room: InternalRoom): number {
    if (!room.timer.running || !room.timer.startedAt) return Math.max(0, room.timer.remainingMs);
    return Math.max(0, room.timer.remainingMs - (now() - room.timer.startedAt));
  }

  private updateTimer(room: InternalRoom): void {
    if (!room.timer.running || !room.timer.startedAt) return;
    const remaining = this.remainingMs(room);
    if (remaining <= 0) {
      room.timer.remainingMs = 0;
      room.timer.running = false;
      room.timer.startedAt = null;
    }
  }

  private tick(): void {
    const current = now();
    for (const [code, room] of this.rooms) {
      if (room.ended || current - room.lastActivity > ROOM_EXPIRY_MS) {
        this.endGame(room);
        continue;
      }
      if (room.timer.running && room.timer.startedAt && this.remainingMs(room) <= 0) {
        this.updateTimer(room);
        this.broadcast(room);
      }
    }
    for (const [ip, state] of this.createRates) {
      if (current - state.startedAt >= 60 * 60 * 1000) this.createRates.delete(ip);
    }
  }

  private consumeMessageRate(connection: SocketConnection): boolean {
    const current = now();
    const state = this.messageRates.get(connection.id);
    if (!state || current - state.startedAt >= 1_000) {
      this.messageRates.set(connection.id, { startedAt: current, count: 1 });
      return true;
    }
    state.count += 1;
    return state.count <= MAX_MESSAGE_RATE;
  }

  private consumeCreateRate(ip: string): boolean {
    const current = now();
    const state = this.createRates.get(ip);
    if (!state || current - state.startedAt >= 60 * 60 * 1000) {
      this.createRates.set(ip, { startedAt: current, count: 1 });
      return true;
    }
    state.count += 1;
    return state.count <= MAX_ROOM_CREATIONS_PER_HOUR;
  }

  private sendError(connection: SocketConnection, code: string, message: string, fatal = false): void {
    if (connection.isOpen()) connection.send({ type: "error", code, message, ...(fatal ? { fatal: true } : {}) });
  }
}

function isHostAction(value: unknown): value is HostAction {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const action = (value as { action?: unknown }).action;
  return typeof action === "string";
}
