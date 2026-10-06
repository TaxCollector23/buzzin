import { describe, expect, it } from "vitest";
import type { ServerMessage } from "../shared/protocol";
import { RoomManager, type SocketConnection } from "./room";

function fakeConnection(ip = "127.0.0.1") {
  const messages: ServerMessage[] = [];
  let open = true;
  const connection: SocketConnection = {
    id: crypto.randomUUID(),
    ip,
    role: null,
    playerId: null,
    roomCode: null,
    isOpen: () => open,
    send: (message) => messages.push(message),
    close: () => { open = false; },
  };
  return { connection, messages };
}

function createRoom(manager: RoomManager, ruleSet: "prelim" | "playoff") {
  const host = fakeConnection();
  manager.handle(host.connection, { type: "createRoom", ruleSet });
  const created = host.messages.find((message) => message.type === "created");
  if (!created || created.type !== "created") throw new Error("room was not created");
  return { host, code: created.code, token: created.hostToken };
}

function joinRoom(manager: RoomManager, code: string, nickname: string) {
  const player = fakeConnection();
  manager.handle(player.connection, { type: "join", code, nickname });
  const joined = player.messages.find((message) => message.type === "joined");
  if (!joined || joined.type !== "joined" || !joined.playerId || !joined.sessionToken) throw new Error("player was not joined");
  return { player, id: joined.playerId, token: joined.sessionToken };
}

describe("RoomManager", () => {
  it("creates unique six-digit prelim and playoff rooms with one buzz enabled", () => {
    const manager = new RoomManager();
    const prelim = createRoom(manager, "prelim");
    const playoff = createRoom(manager, "playoff");
    expect(prelim.code).toMatch(/^\d{6}$/);
    expect(playoff.code).toMatch(/^\d{6}$/);
    expect(prelim.code).not.toBe(playoff.code);
    expect(manager.getRoom(prelim.code)?.settings.oneBuzzOnly).toBe(true);
    expect(manager.getRoom(playoff.code)?.ruleSet).toBe("playoff");
    manager.stop();
  });

  it("accepts only the first buzz when one buzz only is on, then clears atomically", () => {
    const manager = new RoomManager();
    const { code, host } = createRoom(manager, "playoff");
    const first = joinRoom(manager, code, "Rangan");
    const second = joinRoom(manager, code, "Manit");

    manager.handle(first.player.connection, { type: "buzz" });
    manager.handle(second.player.connection, { type: "buzz" });

    const state = manager.getRoom(code);
    expect(state?.buzzes).toHaveLength(1);
    expect(state?.buzzes[0].playerId).toBe(first.id);
    expect(state?.players.find((player) => player.id === first.id)?.status).toBe("buzzed");
    expect(state?.players.find((player) => player.id === second.id)?.status).toBe("locked");

    manager.handle(host.connection, { type: "hostAction", action: { action: "clearBuzzers" } });
    const cleared = manager.getRoom(code);
    expect(cleared?.buzzes).toHaveLength(0);
    expect(cleared?.automaticBuzzLock).toBe(false);
    expect(cleared?.players.every((player) => player.status === "ready")).toBe(true);
    manager.stop();
  });

  it("uses the correct scoring buttons and rejects player authorization", () => {
    const manager = new RoomManager();
    const prelim = createRoom(manager, "prelim");
    const prelimPlayer = joinRoom(manager, prelim.code, "Alice");
    manager.handle(prelim.host.connection, { type: "hostAction", action: { action: "score", playerId: prelimPlayer.id, delta: 1 } });
    manager.handle(prelim.host.connection, { type: "hostAction", action: { action: "score", playerId: prelimPlayer.id, delta: 3 } });
    expect(manager.getRoom(prelim.code)?.players[0].score).toBe(1);

    const playoff = createRoom(manager, "playoff");
    const playoffPlayer = joinRoom(manager, playoff.code, "Bob");
    for (const delta of [-2, -1, 3, 4, 5, 6, 1]) {
      manager.handle(playoff.host.connection, { type: "hostAction", action: { action: "score", playerId: playoffPlayer.id, delta } });
    }
    expect(manager.getRoom(playoff.code)?.players[0].score).toBe(16);
    manager.handle(playoffPlayer.player.connection, { type: "hostAction", action: { action: "clearBuzzers" } });
    expect(playoffPlayer.player.messages.some((message) => message.type === "error" && message.code === "not_authorized")).toBe(true);
    manager.stop();
  });

  it("restores the same player identity with a session token", () => {
    const manager = new RoomManager();
    const { code } = createRoom(manager, "prelim");
    const original = joinRoom(manager, code, "Rangan");
    original.player.connection.close();
    manager.detach(original.player.connection);
    const reconnect = fakeConnection();
    manager.handle(reconnect.connection, { type: "join", code, nickname: "Rangan", sessionToken: original.token });
    const joined = reconnect.messages.find((message) => message.type === "joined");
    expect(joined?.type).toBe("joined");
    expect(joined && joined.type === "joined" ? joined.playerId : undefined).toBe(original.id);
    manager.stop();
  });
});
