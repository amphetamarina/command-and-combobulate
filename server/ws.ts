import { type IncomingMessage, type Server } from "node:http";
import { WebSocketServer } from "ws";
import type { TermClient, TerminalManager } from "./terminals.ts";
import type { Broadcaster } from "./live.ts";

export type WsDeps = {
  terminals: TerminalManager;
  live: Broadcaster;
};

// A control message a terminal client may send: `i` is input text, `r` is a
// [cols, rows] resize.
function parseTermMessage(raw: unknown): { i?: string; r?: [number, number] } | null {
  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

// Wire the WebSocket upgrade routes onto the HTTP server: /live streams world
// and agent deltas, /term streams raw PTY bytes, and /termview streams the
// resolved screen grid. /term and /termview share the same input handling.
export function attachWsRoutes(httpServer: Server, deps: WsDeps): void {
  const { terminals, live } = deps;
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/live") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        live.add(ws);
        console.log("[ws] client connected");
        // Snapshot the current world to the new client so it is in sync without
        // waiting for the next change (otherwise islands appear only on reload).
        live.snapshotTo(ws);
        ws.on("close", () => {
          live.remove(ws);
          console.log("[ws] client disconnected");
        });
      });
      return;
    }

    if (url.pathname === "/term" || url.pathname === "/termview") {
      const view = url.pathname === "/termview";
      const id = url.searchParams.get("id") ?? "";
      const term = terminals.get(id);
      if (!term) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        const client: TermClient = {
          send: (data) => {
            if (ws.readyState === ws.OPEN) ws.send(data);
          },
        };
        if (view) term.attachView(client);
        else term.attach(client);
        ws.on("message", (raw) => {
          const msg = parseTermMessage(raw);
          if (!msg) {
            term.write(raw.toString());
            return;
          }
          if (typeof msg.i === "string") term.write(msg.i);
          else if (Array.isArray(msg.r)) term.resize(msg.r[0], msg.r[1]);
        });
        ws.on("close", () => (view ? term.detachView(client) : term.detach(client)));
      });
      return;
    }

    socket.destroy();
  });
}
