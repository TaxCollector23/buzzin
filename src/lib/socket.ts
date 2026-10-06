import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientMessage, ServerMessage } from "../../shared/protocol";

export type SocketStatus = "connecting" | "connected" | "disconnected";

function websocketUrl(): string {
  const configured = import.meta.env.VITE_BUZZIN_WS_URL?.trim();
  if (configured) return configured;
  if (window.location.hostname === "rangan.xyz" || window.location.hostname === "www.rangan.xyz") {
    return "wss://buzzin-nine.vercel.app/api/ws";
  }
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  return `${protocol}://${window.location.host}/api/ws`;
}

export function useRoomSocket(
  handshake: ClientMessage | null,
  onMessage?: (message: ServerMessage) => void,
): {
  status: SocketStatus;
  lastMessage: ServerMessage | null;
  error: string | null;
  send: (message: ClientMessage) => void;
} {
  const [status, setStatus] = useState<SocketStatus>("connecting");
  const [lastMessage, setLastMessage] = useState<ServerMessage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const handshakeRef = useRef<ClientMessage | null>(handshake);
  const messageHandlerRef = useRef(onMessage);
  const reconnectRef = useRef<number | null>(null);
  const disposedRef = useRef(false);
  const delayRef = useRef(750);

  handshakeRef.current = handshake;
  messageHandlerRef.current = onMessage;

  useEffect(() => {
    disposedRef.current = false;
    let active = true;
    let socket: WebSocket | null = null;

    const connect = () => {
      if (disposedRef.current || !active) return;
      setStatus("connecting");
      const currentSocket = new WebSocket(websocketUrl());
      socket = currentSocket;
      socketRef.current = currentSocket;
      currentSocket.onopen = () => {
        if (!active || disposedRef.current || socketRef.current !== currentSocket) return;
        delayRef.current = 750;
        setStatus("connected");
        setError(null);
        const initial = handshakeRef.current;
        if (initial) currentSocket.send(JSON.stringify(initial));
      };
      currentSocket.onmessage = (event) => {
        if (!active || socketRef.current !== currentSocket) return;
        try {
          const message = JSON.parse(String(event.data)) as ServerMessage;
          if (message.type === "error") setError(message.message);
          if (message.type === "joined" && message.sessionToken && message.room.code) {
            if (handshakeRef.current?.type === "join") {
              handshakeRef.current = { ...handshakeRef.current, sessionToken: message.sessionToken };
            }
          }
          setLastMessage(message);
          messageHandlerRef.current?.(message);
        } catch {
          setError("Connection returned an invalid message.");
        }
      };
      currentSocket.onerror = () => {
        if (active && socketRef.current === currentSocket) setError("Connection lost.");
      };
      currentSocket.onclose = () => {
        if (!active || socketRef.current !== currentSocket) return;
        socketRef.current = null;
        if (disposedRef.current) return;
        setStatus("disconnected");
        const delay = delayRef.current + Math.round(Math.random() * 250);
        delayRef.current = Math.min(delayRef.current * 2, 10_000);
        reconnectRef.current = window.setTimeout(connect, delay);
      };
    };

    connect();
    return () => {
      active = false;
      disposedRef.current = true;
      if (reconnectRef.current) window.clearTimeout(reconnectRef.current);
      socket?.close();
      socketRef.current = null;
    };
  }, []);

  const send = useCallback((message: ClientMessage) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setError("Waiting for connection…");
      return;
    }
    socket.send(JSON.stringify(message));
  }, []);

  return { status, lastMessage, error, send };
}
