// Private golf world server for live multiplayer tests: the drawvidverse
// worldserver (GAME_KEY=golf, in-memory store) on a port of its own, with its
// config copied into a fresh temp dir. The process is ts-node itself, so its
// PID is the server and stop() kills exactly that.
//
//   const srv = await startGolfServer({ env: { GOLF_TURN_TIMEOUT_MS: "5000" } });
//   ... new Bot(srv.url, "Dave") ...
//   await srv.stop();
//
// CLI (runs until Ctrl-C):  node test/mp/server.js [--port 7791] [--env K=V ...]
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { setTimeout, clearTimeout } = require("node:timers");

const WORLDSERVER =
  process.env.WORLDSERVER_DIR ||
  path.join(__dirname, "..", "..", "..", "drawvidverse", "worldserver");
const GOLF_CONFIG = path.join(WORLDSERVER, "..", "games", "golf.config.json");
// The user's dev servers (clubhouse, game http, default golf world).
const RESERVED_PORTS = new Set([3000, 7779, 7780]);

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function health(port) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: "/health", timeout: 500 },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

/**
 * env: extra server env (GOLF_TURN_TIMEOUT_MS, GOLF_SHOT_TIMEOUT_MS,
 * GOLF_FINISHED_LINGER_MS, LOG_LEVEL...). echo: mirror its log to stderr.
 * transpileOnly: skip ts-node's type check (seconds faster; tsc is run
 * separately as the worldserver's own check).
 */
async function startGolfServer({
  port,
  env = {},
  worldId,
  echo = false,
  transpileOnly = true,
  readyTimeoutMs = 60000,
  maxLogLines = 5000,
} = {}) {
  port = port ?? (await freePort());
  if (RESERVED_PORTS.has(port))
    throw new Error(`port ${port} belongs to the dev session`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "golf-mp-"));
  const cfgPath = path.join(dir, "golf.config.json");
  const cfg = JSON.parse(fs.readFileSync(GOLF_CONFIG, "utf8"));
  cfg.worldServer.port = port;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  const tsNode = require.resolve("ts-node/dist/bin.js", {
    paths: [WORLDSERVER],
  });
  const child = spawn(process.execPath, [tsNode, "src/index.ts"], {
    cwd: WORLDSERVER,
    env: {
      ...process.env,
      GAME_KEY: "golf",
      WORLD_ID: worldId ?? `mp-${port}-${Date.now()}`,
      WORLD_STORE_MODE: "memory",
      GAME_CONFIGS_DIR: dir,
      TS_NODE_TRANSPILE_ONLY: transpileOnly ? "true" : "false",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines = [];
  let exited = null;
  const onData = (buf) => {
    // eslint-disable-next-line no-control-regex
    const text = buf.toString().replace(/\x1b\[[0-9;]*m/g, "");
    if (echo) process.stderr.write(text);
    for (const l of text.split("\n")) if (l) lines.push(l);
    if (lines.length > maxLogLines) lines.splice(0, lines.length - maxLogLines);
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  const exitP = new Promise((r) =>
    child.on("exit", (code, signal) => r((exited = { code, signal }))),
  );
  // A crashed test run must not leave the server behind.
  const killOnExit = () => {
    try {
      process.kill(child.pid, "SIGKILL");
    } catch {
      // already gone
    }
  };
  process.on("exit", killOnExit);

  const removeConfig = () => {
    try {
      fs.unlinkSync(cfgPath);
      fs.rmdirSync(dir);
    } catch {
      // already removed
    }
  };
  const deadline = Date.now() + readyTimeoutMs;
  for (;;) {
    if (exited) {
      process.off("exit", killOnExit);
      removeConfig();
      throw new Error(
        `golf server exited during startup ${JSON.stringify(exited)}:\n${lines.slice(-40).join("\n")}`,
      );
    }
    if (
      lines.some((l) => l.includes("WebSocket server listening")) &&
      (await health(port))
    )
      break;
    if (Date.now() > deadline) {
      killOnExit();
      await exitP;
      process.off("exit", killOnExit);
      removeConfig();
      throw new Error(
        `golf server not ready after ${readyTimeoutMs} ms:\n${lines.slice(-40).join("\n")}`,
      );
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  return {
    port,
    url: `ws://127.0.0.1:${port}`,
    pid: child.pid,
    child,
    configDir: dir,
    log: () => lines.join("\n"),
    lines,
    get exited() {
      return exited;
    },
    async stop() {
      if (!exited) {
        child.kill("SIGTERM");
        const t = setTimeout(killOnExit, 5000);
        await exitP;
        clearTimeout(t);
      }
      process.off("exit", killOnExit);
      removeConfig();
    },
  };
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const portArg = argv.indexOf("--port");
  const env = {};
  argv.forEach((a, i) => {
    if (a === "--env") {
      const [k, ...v] = argv[i + 1].split("=");
      env[k] = v.join("=");
    }
  });
  startGolfServer({
    port: portArg >= 0 ? Number(argv[portArg + 1]) : undefined,
    env,
    echo: argv.includes("--echo"),
  }).then(
    (srv) => {
      console.log(`GOLF_SERVER ${srv.url} pid ${srv.pid}`);
      let stopping = false;
      const stop = () => {
        stopping = true;
        srv.stop().then(() => process.exit(0));
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      srv.child.on("exit", () => stopping || process.exit(1));
    },
    (e) => {
      console.error(e.message);
      process.exit(1);
    },
  );
}

module.exports = { startGolfServer, freePort };
