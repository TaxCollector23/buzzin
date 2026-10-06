import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { ClientMessage, HostAction, PlayerView, RoomView, RuleSet, ServerMessage } from "../shared/protocol";
import { formatTimer, scoreValuesForRuleSet } from "../shared/protocol";
import { useRoomSocket } from "./lib/socket";
import {
  clearPlayerIntent,
  getHostToken,
  getPlayerIntent,
  getPlayerToken,
  saveHostToken,
  savePlayerIntent,
  savePlayerToken,
  type PlayerIntent,
} from "./lib/storage";

type Route =
  | { kind: "home" }
  | { kind: "join" }
  | { kind: "create" }
  | { kind: "host"; code: string }
  | { kind: "play"; code: string };

const BASE_PATH = import.meta.env.BASE_URL.replace(/\/$/, "");

function parseRoute(): Route {
  const path = window.location.pathname.replace(/\/$/, "") || "/";
  const segments = path.split("/").filter(Boolean);
  const baseSegment = BASE_PATH.replace(/^\//, "");
  const routeSegments = segments[0] === baseSegment ? segments.slice(1) : segments;
  if (routeSegments[0] === "join") return { kind: "join" };
  if (routeSegments[0] === "create") return { kind: "create" };
  if (routeSegments[0] === "host" && routeSegments[1]) return { kind: "host", code: routeSegments[1] };
  if (routeSegments[0] === "play" && routeSegments[1]) return { kind: "play", code: routeSegments[1] };
  return { kind: "home" };
}

function appUrl(path: string): string {
  return `${BASE_PATH}${path.startsWith("/") ? path : `/${path}`}` || "/";
}

function go(path: string): void {
  window.history.pushState({}, "", appUrl(path));
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function validCode(code: string): boolean {
  return /^\d{6}$/.test(code);
}

function cleanNickname(value: string): string {
  return value.normalize("NFKC").replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, 32);
}

function Brand({ subtitle = false }: { subtitle?: boolean }) {
  return (
    <header className="brand-block">
      <button className="brand-button" onClick={() => go("/")} aria-label="BuzzIn.live home">
        Buzz<span className="brand-italic">In</span>.live
      </button>
      {subtitle && <p className="brand-subtitle">The simple online buzzer system!</p>}
    </header>
  );
}

function PageFrame({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <main className={`page-frame ${className}`}>{children}</main>;
}

function InlineError({ message }: { message: string | null | undefined }) {
  return message ? <p className="inline-error" role="alert">{message}</p> : null;
}

function StatusLine({ status }: { status: "connecting" | "connected" | "disconnected" }) {
  const label = status === "connected" ? "Connected" : status === "connecting" ? "Connecting…" : "Waiting for connection…";
  return <p className={`connection-line connection-${status}`}>{label}</p>;
}

function HomePage() {
  return (
    <PageFrame className="home-page">
      <Brand subtitle />
      <section className="home-actions" aria-label="Game actions">
        <button className="home-button home-button-primary" onClick={() => go("/join")}>JOIN</button>
        <button className="home-button home-button-secondary" onClick={() => go("/create")}>HOST</button>
      </section>
    </PageFrame>
  );
}

function JoinPage() {
  const [code, setCode] = useState("");
  const [nickname, setNickname] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedCode = code.replace(/\D/g, "").slice(0, 6);
    const normalizedNickname = cleanNickname(nickname);
    if (!validCode(normalizedCode)) {
      setError("Game codes are six digits.");
      return;
    }
    if (!normalizedNickname) {
      setError("Please enter a nickname.");
      return;
    }
    const intent: PlayerIntent = { code: normalizedCode, nickname: normalizedNickname };
    savePlayerIntent(intent);
    go(`/play/${normalizedCode}`);
  };

  return (
    <PageFrame className="form-page">
      <Brand />
      <form className="join-form" onSubmit={submit}>
        <label htmlFor="game-code">Game Code:</label>
        <input
          id="game-code"
          value={code}
          onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          aria-describedby={error ? "join-error" : undefined}
        />
        <label htmlFor="nickname">Your Nickname:</label>
        <input
          id="nickname"
          value={nickname}
          onChange={(event) => setNickname(event.target.value.slice(0, 32))}
          autoComplete="nickname"
          maxLength={32}
        />
        <InlineError message={error} />
        <button className="btn btn-primary join-submit" type="submit">Join!</button>
      </form>
    </PageFrame>
  );
}

function CreatePage() {
  const [creating, setCreating] = useState<RuleSet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingRuleSet, setPendingRuleSet] = useState<RuleSet | null>(null);
  const { status, lastMessage, send } = useRoomSocket(null);

  useEffect(() => {
    if (status === "connected" && pendingRuleSet) {
      send({ type: "createRoom", ruleSet: pendingRuleSet });
      setPendingRuleSet(null);
    }
  }, [pendingRuleSet, send, status]);

  useEffect(() => {
    if (!lastMessage) return;
    if (lastMessage.type === "created") {
      saveHostToken(lastMessage.code, lastMessage.hostToken);
      go(`/host/${lastMessage.code}`);
    }
    if (lastMessage.type === "error") {
      setError(lastMessage.message);
      setCreating(null);
    }
  }, [lastMessage]);

  const choose = (ruleSet: RuleSet) => {
    setError(null);
    setCreating(ruleSet);
    setPendingRuleSet(ruleSet);
  };

  return (
    <PageFrame className="create-page">
      <Brand />
      <section className="choice-panel" aria-labelledby="choose-rules">
        <h1 id="choose-rules">Choose Game Rules</h1>
        <button className="choice-button choice-button-primary" disabled={creating !== null} onClick={() => choose("playoff")}>
          {creating === "playoff" ? "Creating…" : "Playoff Rules"}
        </button>
        <button className="choice-button choice-button-secondary" disabled={creating !== null} onClick={() => choose("prelim")}>
          {creating === "prelim" ? "Creating…" : "Prelim Rules"}
        </button>
        <InlineError message={error} />
        <StatusLine status={status} />
      </section>
    </PageFrame>
  );
}

function useRoomState(
  handshake: ClientMessage | null,
): {
  room: RoomView | null;
  viewer: { role: "host" | "player"; playerId?: string } | null;
  status: "connecting" | "connected" | "disconnected";
  error: string | null;
  lastMessage: ServerMessage | null;
  send: (message: ClientMessage) => void;
} {
  const [room, setRoom] = useState<RoomView | null>(null);
  const [viewer, setViewer] = useState<{ role: "host" | "player"; playerId?: string } | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const onMessage = useCallback((message: ServerMessage) => {
    if (message.type === "joined") {
      setRoom(message.room);
      setViewer({ role: message.role, playerId: message.playerId });
      if (message.sessionToken) savePlayerToken(message.room.code, message.sessionToken);
    } else if (message.type === "state") {
      setRoom(message.room);
      setViewer(message.viewer);
    } else if (message.type === "error") {
      setServerError(message.message);
    }
  }, []);
  const socket = useRoomSocket(handshake, onMessage);
  return { ...socket, room, viewer, error: socket.error ?? serverError };
}

function PlayerPage({ code }: { code: string }) {
  const intent = useMemo(() => getPlayerIntent(code), [code]);
  const sessionToken = useMemo(() => getPlayerToken(code) ?? undefined, [code]);
  const handshake = useMemo<ClientMessage | null>(() => {
    if (!intent) return null;
    return { type: "join", code, nickname: intent.nickname, ...(sessionToken ? { sessionToken } : {}) };
  }, [code, intent, sessionToken]);
  const { room, viewer, status: connectionStatus, error, lastMessage, send } = useRoomState(handshake);
  const [soundOn, setSoundOn] = useState(true);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const lastBuzzSequence = useRef(0);

  useEffect(() => {
    if (lastMessage?.type === "error" && lastMessage.fatal) setFatalError(lastMessage.message);
  }, [lastMessage]);

  useEffect(() => {
    if (!room || !soundOn || !room.settings.playBuzzSound) return;
    const latest = room.buzzes[room.buzzes.length - 1];
    if (!latest || latest.sequence <= lastBuzzSequence.current) return;
    lastBuzzSequence.current = latest.sequence;
    try {
      const AudioContextClass = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextClass) return;
      const context = new AudioContextClass();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.value = 660;
      oscillator.type = "square";
      gain.gain.setValueAtTime(0.04, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.18);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + 0.18);
      window.setTimeout(() => void context.close(), 300);
    } catch {
      // Audio is optional; browser autoplay policy must never break buzzing.
    }
  }, [room, soundOn]);

  const player = room && viewer?.playerId ? room.players.find((candidate) => candidate.id === viewer.playerId) : undefined;
  const buzz = useCallback(() => {
    if (player?.status === "ready") send({ type: "buzz" });
  }, [player?.status, send]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.repeat || !player || player.status !== "ready") return;
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, button")) return;
      event.preventDefault();
      buzz();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [buzz, player]);

  if (!validCode(code) || !intent) {
    return (
      <PageFrame className="form-page missing-page">
        <Brand />
        <p className="simple-message">Enter a game code and nickname to join a game.</p>
        <button className="btn btn-primary" onClick={() => go("/join")}>Join a Game</button>
      </PageFrame>
    );
  }

  if (fatalError && !room) {
    return (
      <PageFrame className="form-page missing-page">
        <Brand />
        <InlineError message={fatalError} />
        <button className="btn btn-primary" onClick={() => go("/join")}>Back to Join</button>
      </PageFrame>
    );
  }

  const buzzerStatus = player?.status ?? "locked";
  const buzzerLabel = buzzerStatus === "buzzed" ? "BUZZED" : buzzerStatus === "locked" ? "LOCKED" : "BUZZ";

  return (
    <PageFrame className="player-page">
      <Brand />
      <section className="player-heading">
        <p>Game Code: <strong>{code}</strong></p>
        <p>You: <strong>{intent.nickname}</strong></p>
        <label className="sound-toggle">
          Sound:
          <input type="checkbox" checked={soundOn} onChange={(event) => setSoundOn(event.target.checked)} />
        </label>
        <p className="space-note">Spacebar also works as buzzer button!</p>
        <StatusLine status={connectionStatus} />
        <InlineError message={error} />
      </section>
      <section className="player-layout">
        <button
          className={`buzzer buzzer-${buzzerStatus}`}
          onClick={buzz}
          disabled={buzzerStatus !== "ready" || !room}
          aria-label={`${buzzerLabel}. ${buzzerStatus === "ready" ? "Press to buzz" : "Buzzer unavailable"}`}
        >
          {buzzerLabel}
        </button>
        {room && room.settings.showBuzzList !== false && (
          <aside className="buzz-list" aria-live="polite">
            <h2>Buzzes:</h2>
            {room.buzzes.length === 0 ? <p className="empty-list">No buzzes yet.</p> : (
              <ol>
                {room.buzzes.map((buzzItem) => {
                  const buzzPlayer = room.players.find((candidate) => candidate.id === buzzItem.playerId);
                  return <li key={`${buzzItem.playerId}-${buzzItem.sequence}`}>{buzzPlayer?.nickname ?? "Player"}</li>;
                })}
              </ol>
            )}
          </aside>
        )}
      </section>
    </PageFrame>
  );
}

function HostPage({ code }: { code: string }) {
  const hostToken = useMemo(() => getHostToken(code), [code]);
  const handshake = useMemo<ClientMessage | null>(() => hostToken ? { type: "hostConnect", code, hostToken } : null, [code, hostToken]);
  const { room, status, error, lastMessage, send } = useRoomState(handshake);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [clock, setClock] = useState(() => Date.now());

  useEffect(() => {
    if (lastMessage?.type === "error" && lastMessage.fatal) setFatalError(lastMessage.message);
  }, [lastMessage]);

  useEffect(() => {
    if (!room?.timer.running) return;
    const timer = window.setInterval(() => setClock(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [room?.timer.running]);

  const sendAction = useCallback((action: HostAction) => send({ type: "hostAction", action }), [send]);
  const clearBuzzers = useCallback(() => sendAction({ action: "clearBuzzers" }), [sendAction]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.repeat) return;
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, button")) return;
      event.preventDefault();
      clearBuzzers();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [clearBuzzers]);

  if (!hostToken || !validCode(code)) {
    return (
      <PageFrame className="form-page missing-page">
        <Brand />
        <InlineError message="Host session not found." />
        <button className="btn btn-primary" onClick={() => go("/create")}>Create a Game</button>
      </PageFrame>
    );
  }

  if (fatalError && !room) {
    return (
      <PageFrame className="form-page missing-page">
        <Brand />
        <InlineError message={fatalError} />
        <button className="btn btn-primary" onClick={() => go("/create")}>Create a Game</button>
      </PageFrame>
    );
  }

  const remainingMs = room?.timer.running && room.timer.startedAt
    ? Math.max(0, room.timer.remainingMs - (clock - room.timer.startedAt))
    : room?.timer.remainingMs ?? 0;
  const buzzedIds = new Set(room?.buzzes.map((buzz) => buzz.playerId) ?? []);
  const buzzedPlayers = room?.buzzes
    .map((buzz) => room.players.find((player) => player.id === buzz.playerId))
    .filter((player): player is PlayerView => Boolean(player)) ?? [];
  const waitingPlayers = room?.players.filter((player) => !buzzedIds.has(player.id)) ?? [];

  return (
    <PageFrame className="host-page">
      <Brand />
      <section className="host-heading">
        <p className="game-code">Game Code: <strong>{code}</strong></p>
        <div className="host-heading-buttons">
          <button className="btn btn-outline" onClick={() => setSettingsOpen(true)}>Settings ⚙</button>
          <button className="btn btn-outline" onClick={() => setHelpOpen(true)}>How To Info ?</button>
        </div>
        <p className="host-mode">{room?.ruleSet === "playoff" ? "Playoff Rules" : "Prelim Rules"}</p>
        <StatusLine status={status} />
        <InlineError message={error} />
      </section>

      <section className="host-controls" aria-label="Host controls">
        <div className="timer-box">
          <span className="timer-label">Timer:</span>
          <strong>{formatTimer(remainingMs)}</strong>
          <div className="timer-buttons">
            <button className="small-control" onClick={() => sendAction({ action: "timer", command: "start" })}>Start</button>
            <button className="small-control" onClick={() => sendAction({ action: "timer", command: "pause" })}>Pause</button>
            <button className="small-control" onClick={() => sendAction({ action: "timer", command: "reset" })}>Reset</button>
          </div>
        </div>
        <div className="host-action-row">
          <button className="btn btn-danger" onClick={clearBuzzers}>Clear Buzzers</button>
          <button className={`btn ${room?.settings.manualLock ? "btn-warning" : "btn-warning"}`} onClick={() => sendAction({ action: "toggleLock" })}>
            Toggle Lock {room?.settings.manualLock ? "🔓" : "🔒"}
          </button>
        </div>
        <p className="host-space-note">Spacebar also resets buzzers!</p>
      </section>

      <section className="players-section" aria-labelledby="players-title">
        <h1 id="players-title">Players:</h1>
        <p className="player-limit">Player Limit: 200</p>
        <div className="player-group">
          <h2>Buzzed Players:</h2>
          {buzzedPlayers.length === 0 ? <p className="empty-list">No buzzed players.</p> : buzzedPlayers.map((player, index) => (
            <HostPlayerRow key={player.id} player={player} index={index + 1} room={room} sendAction={sendAction} />
          ))}
        </div>
        <div className="player-group">
          <h2>Not Buzzed Players:</h2>
          {waitingPlayers.length === 0 ? <p className="empty-list">No players waiting.</p> : waitingPlayers.map((player) => (
            <HostPlayerRow key={player.id} player={player} room={room} sendAction={sendAction} />
          ))}
        </div>
        <TeamsSection room={room} sendAction={sendAction} />
      </section>

      {settingsOpen && <SettingsOverlay room={room} close={() => setSettingsOpen(false)} sendAction={sendAction} />}
      {helpOpen && <HelpOverlay close={() => setHelpOpen(false)} />}
    </PageFrame>
  );
}

function HostPlayerRow({
  player,
  index,
  room,
  sendAction,
}: {
  player: PlayerView;
  index?: number;
  room: RoomView | null;
  sendAction: (action: HostAction) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [nickname, setNickname] = useState(player.nickname);
  const scores = room ? scoreValuesForRuleSet(room.ruleSet) : [];
  const saveName = () => {
    const next = cleanNickname(nickname);
    if (next) sendAction({ action: "renamePlayer", playerId: player.id, nickname: next });
    setEditing(false);
  };
  return (
    <div className={`host-player-row ${!player.connected ? "player-disconnected" : ""}`}>
      <div className="player-row-heading">
        {index ? <span className="buzz-order">{index}.</span> : null}
        {editing ? (
          <input className="inline-name-input" value={nickname} onChange={(event) => setNickname(event.target.value)} maxLength={32} autoFocus />
        ) : (
          <span className="player-name">{player.nickname}</span>
        )}
        {!player.connected && <span className="disconnected-label">(Disconnected)</span>}
        {editing ? <button className="text-control" onClick={saveName}>Save</button> : <button className="text-control" onClick={() => setEditing(true)}>Rename</button>}
        <button className="text-control text-control-danger" onClick={() => sendAction({ action: "removePlayer", playerId: player.id })}>Remove</button>
      </div>
      <div className="score-row">
        <span className="score-label">Score: <strong>{player.score ?? 0}</strong></span>
        {scores.map((delta) => (
          <button key={delta} className="score-button" onClick={() => sendAction({ action: "score", playerId: player.id, delta })}>
            {delta > 0 ? `+${delta}` : delta}
          </button>
        ))}
        <label className="team-select-label">
          Team:
          <select value={player.teamId ?? ""} onChange={(event) => sendAction({ action: "assignTeam", playerId: player.id, teamId: event.target.value || null })}>
            <option value="">None</option>
            {room?.teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}
          </select>
        </label>
      </div>
    </div>
  );
}

function TeamsSection({ room, sendAction }: { room: RoomView | null; sendAction: (action: HostAction) => void }) {
  const [name, setName] = useState("");
  const add = () => {
    const next = cleanNickname(name).slice(0, 24);
    if (!next) return;
    sendAction({ action: "addTeam", name: next });
    setName("");
  };
  return (
    <div className="teams-section">
      <h1>Teams:</h1>
      {room?.teams.length ? (
        <ol className="teams-list">
          {room.teams.map((team) => <TeamRow key={team.id} team={team} sendAction={sendAction} />)}
        </ol>
      ) : <p className="empty-list">No teams added.</p>}
      <div className="add-team-row">
        <input aria-label="New team name" placeholder="Team name" value={name} onChange={(event) => setName(event.target.value)} maxLength={24} />
        <button className="btn btn-outline" onClick={add}>Add Team</button>
      </div>
    </div>
  );
}

function TeamRow({ team, sendAction }: { team: { id: string; name: string }; sendAction: (action: HostAction) => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(team.name);
  return (
    <li className="team-row">
      {editing ? <input value={name} onChange={(event) => setName(event.target.value)} maxLength={24} autoFocus /> : <span>{team.name}</span>}
      {editing ? (
        <button className="text-control" onClick={() => { const next = cleanNickname(name); if (next) sendAction({ action: "renameTeam", teamId: team.id, name: next }); setEditing(false); }}>Save</button>
      ) : <button className="text-control" onClick={() => setEditing(true)}>Rename</button>}
      <button className="text-control text-control-danger" onClick={() => sendAction({ action: "deleteTeam", teamId: team.id })}>Delete</button>
    </li>
  );
}

function SettingsOverlay({ room, close, sendAction }: { room: RoomView | null; close: () => void; sendAction: (action: HostAction) => void }) {
  if (!room) return null;
  const toggle = (key: "oneBuzzOnly" | "allowNewPlayers" | "showBuzzList" | "showPlayerPoints" | "showTimer" | "playBuzzSound") => {
    sendAction({ action: "setSettings", settings: { [key]: !room.settings[key] } });
  };
  return (
    <div className="overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <section className="settings-panel" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <h1 id="settings-title">Settings</h1>
        <button className="btn btn-danger settings-close" onClick={close}>Close</button>
        <div className="settings-group">
          <label><input type="checkbox" checked={room.settings.oneBuzzOnly} onChange={() => toggle("oneBuzzOnly")} /> One Buzz Only</label>
          <label><input type="checkbox" checked={room.settings.allowNewPlayers} onChange={() => toggle("allowNewPlayers")} /> Allow New Players To Join</label>
          <label><input type="checkbox" checked={room.settings.showBuzzList} onChange={() => toggle("showBuzzList")} /> Show Buzz List on Player Devices</label>
          <label><input type="checkbox" checked={room.settings.showPlayerPoints} onChange={() => toggle("showPlayerPoints")} /> Show Player Points on Player Devices</label>
          <label><input type="checkbox" checked={room.settings.showTimer} onChange={() => toggle("showTimer")} /> Show Timer on Player Devices</label>
          <label><input type="checkbox" checked={room.settings.playBuzzSound} onChange={() => toggle("playBuzzSound")} /> Play Buzz Sound</label>
        </div>
        <div className="settings-group settings-actions">
          <h2>Game data</h2>
          <button className="btn btn-outline" onClick={() => sendAction({ action: "removeAllPlayers" })}>Remove All Players</button>
          <button className="btn btn-outline" onClick={() => sendAction({ action: "removeAllPoints" })}>Remove All Points</button>
          <button className="btn btn-outline" onClick={() => {
            const value = window.prompt("Timer duration in seconds", String(Math.round(room.timer.durationMs / 1000)));
            const seconds = value ? Number(value) : NaN;
            if (Number.isFinite(seconds)) sendAction({ action: "timer", command: "set", durationMs: seconds * 1000 });
          }}>Set Timer Duration</button>
        </div>
        <p className="settings-note">One Buzz Only keeps the first accepted buzz locked until the host clears buzzers.</p>
      </section>
    </div>
  );
}

function HelpOverlay({ close }: { close: () => void }) {
  return (
    <div className="overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <section className="help-panel" role="dialog" aria-modal="true" aria-labelledby="help-title">
        <h1 id="help-title">How To Info</h1>
        <button className="btn btn-danger settings-close" onClick={close}>Close</button>
        <p>Players enter the six-digit game code, choose a nickname, and press the green buzzer. Spacebar works too.</p>
        <p>With One Buzz Only on, the first accepted buzz turns everyone else yellow until you press Clear Buzzers.</p>
        <p>Use Toggle Lock when you need to pause buzzing without changing the current buzz list.</p>
      </section>
    </div>
  );
}

export default function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute());
  useEffect(() => {
    const onPopState = () => setRoute(parseRoute());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  switch (route.kind) {
    case "join":
      return <JoinPage />;
    case "create":
      return <CreatePage />;
    case "host":
      return <HostPage code={route.code} />;
    case "play":
      return <PlayerPage code={route.code} />;
    default:
      return <HomePage />;
  }
}
