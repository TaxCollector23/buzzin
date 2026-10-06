import http, { type IncomingMessage, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket, type VerifyClientCallbackSync } from "ws";
import { RoomManager, type SocketConnection } from "./room.js";

const MAX_PAYLOAD = 8 * 1024;

export const roomManager = new RoomManager();

function allowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  const configured = (process.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (configured.length > 0) return configured.includes(origin);
  return (
    origin.startsWith("http://localhost") ||
    origin.startsWith("http://127.0.0.1") ||
    origin === "https://rangan.xyz" ||
    origin === "https://www.rangan.xyz" ||
    origin.endsWith(".vercel.app")
  );
}

function requestIp(request: IncomingMessage): string {
  const forwarded = request.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) return forwarded.split(",")[0].trim();
  return request.socket.remoteAddress ?? "unknown";
}

function makeConnection(ws: WebSocket, request: IncomingMessage): SocketConnection {
  const connection: SocketConnection = {
    id: randomUUID(),
    ip: requestIp(request),
    role: null,
    playerId: null,
    roomCode: null,
    isOpen: () => ws.readyState === WebSocket.OPEN,
    send: (message) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    },
    close: (code, reason) => {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CLOSING) ws.close(code, reason);
    },
  };
  return connection;
}

export function createBuzzInHttpServer(): Server {
  const server = http.createServer((request, response) => {
    if (request.url === "/health" || request.url === "/api/health") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ ok: true, service: "buzzin" }));
      return;
    }
    response.writeHead(426, { "content-type": "text/plain; charset=utf-8" });
    response.end("BuzzIn WebSocket endpoint.\n");
  });

  const verifyClient: VerifyClientCallbackSync = (info) => allowedOrigin(info.req.headers.origin);
  const websocketServer = new WebSocketServer({
    server,
    path: "/api/ws",
    maxPayload: MAX_PAYLOAD,
    clientTracking: true,
    perMessageDeflate: false,
    verifyClient,
  });

  websocketServer.on("connection", (ws, request) => {
    const connection = makeConnection(ws, request);
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        connection.send({ type: "error", code: "invalid_message", message: "Binary messages are not supported." });
        return;
      }
      const text = data.toString();
      if (Buffer.byteLength(text, "utf8") > MAX_PAYLOAD) {
        connection.send({ type: "error", code: "message_too_large", message: "That message is too large." });
        return;
      }
      try {
        roomManager.handle(connection, JSON.parse(text));
      } catch {
        connection.send({ type: "error", code: "invalid_message", message: "That message could not be understood." });
      }
    });
    ws.on("close", () => roomManager.detach(connection));
    ws.on("error", () => roomManager.detach(connection));
  });

  return server;
}
