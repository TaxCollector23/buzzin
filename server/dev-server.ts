import { createBuzzInHttpServer } from "./websocket-server";

const port = Number(process.env.PORT ?? 8787);
const server = createBuzzInHttpServer();

server.listen(port, "0.0.0.0", () => {
  console.log(`BuzzIn WebSocket server listening on http://localhost:${port}`);
});
