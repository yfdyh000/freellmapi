// Cross-platform single-instance lock.
//
// Electron's requestSingleInstanceLock sits on OS-managed resources (named
// pipe / AF_UNIX socket) that the kernel releases automatically when the
// process dies — crashed or not, there is no stale lock to clean up. A fixed
// loopback port mirrors that: whoever binds it first is the running instance,
// the kernel frees it on process death, and two instances racing at startup
// are resolved atomically by the OS accept queue. No lock files, no PID
// probing, no FFI.
import net from "node:net";
import { Utils } from "electrobun/bun";

// Deliberately distinct from the server port (31415) so a user-configured
// server port never collides with this lock. Collision with an unrelated
// program is unlikely for a high port; the message names it for diagnosis.
const SINGLE_INSTANCE_PORT = 31417;

export function acquireSingleInstance(): Promise<void> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();

    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        console.log(`[desktop/eb] another instance holds port ${SINGLE_INSTANCE_PORT} — quitting`);
        void Utils.showMessageBox({
          type: "warning",
          title: "FreeLLMAPI",
          message: "FreeLLMAPI is already running",
          detail:
            `Another instance is already running (port ${SINGLE_INSTANCE_PORT} ` +
            "is in use). This instance will now quit.",
          buttons: ["OK"],
          defaultId: 0,
        }).then(() => process.exit(0));
        return; // never resolve — the process exits from the dialog
      }
      // Anything else (unlikely): degrade to running without a lock rather
      // than refusing to start. The server port scan would still let two
      // instances coexist, but a lock failure must not brick the app.
      console.warn(`[desktop/eb] single-instance lock unavailable (${err.code ?? err.message}) — continuing`);
      resolve();
    });

    server.once("listening", () => {
      console.log(`[desktop/eb] single-instance lock acquired on 127.0.0.1:${SINGLE_INSTANCE_PORT}`);
      resolve();
    });

    server.listen(SINGLE_INSTANCE_PORT, "127.0.0.1");
  });
}