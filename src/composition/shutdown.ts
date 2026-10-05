import type { Server } from "node:http";
import type { RootAssembly } from "./root.js";

/** One shutdown path for signals, server errors and explicit shutdown. */
export function createShutdown(server: Server, assembly: RootAssembly): () => Promise<void> {
  let closing: Promise<void> | undefined;
  return () => {
    if (closing) return closing;
    closing = Promise.resolve().then(async () => {
      const disposing = assembly.dispose(); // Reject new tasks/control before closing sockets.
      const stopped = new Promise<void>((resolve, reject) => {
        server.close((error?: Error) => {
          if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") reject(error);
          else resolve();
        });
      });
      // Upgraded WebSockets are not closed by server.close()/closeAllConnections().
      const errors: unknown[] = [];
      try {
        for (const session of assembly.desktop?.list() ?? []) assembly.desktop?.disconnect(session.sessionId);
      } catch (error) { errors.push(error); }
      server.closeAllConnections();
      for (const result of await Promise.allSettled([disposing, stopped])) {
        if (result.status === "rejected") errors.push(result.reason);
      }
      if (errors.length) throw new AggregateError(errors, "Dashboard 关闭失败");
    });
    return closing;
  };
}
