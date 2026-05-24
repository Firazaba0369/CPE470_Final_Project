const http = require("http");
const fs = require("fs");
const path = require("path");

let SerialPort;
let ReadlineParser;

try {
  ({ SerialPort, ReadlineParser } = require("serialport"));
} catch (error) {
  SerialPort = null;
  ReadlineParser = null;
}

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const PUBLIC_DIR = path.join(__dirname, "public");
const { Server: SocketServer } = require("socket.io");

const winsNeeded = 3;
const totalRoundsAllowed = 5;
const serialBaudRate = 921600;
const serialBootDelayMs = 2500;

let serialPort = null;
let serialPath = process.env.ARDUINO_PORT || null;

// Serial image buffering (collected from Arduino between IMAGE_START / IMAGE_END)
let serialImageCollecting = false;
let serialImageBuffer = "";

let state = createInitialState();

function createInitialState() {
  return {
    connected: false,
    serialConnected: false,
    serialPath,
    started: false,
    gameOver: false,
    roundIndex: 0,
    userWins: 0,
    webWins: 0,
    ties: 0,
    waitingForArduino: false,
    currentWebChoice: null,
    lastWebChoice: null,
    lastUserChoice: null,
    lastResult: null,
    message: "Ready",
  };
}

function publicState() {
  return {
    ...state,
    serialConnected: Boolean(serialPort && serialPort.isOpen),
    serialPath,
    winsNeeded,
    totalRounds: totalRoundsAllowed,
  };
}

function updateSerialConnection(isConnected) {
  state.connected = isConnected;
  state.serialConnected = isConnected;
  state.serialPath = serialPath;
}

function normalizeChoice(choice) {
  if (typeof choice !== "string") return null;
  const normalized = choice.trim().toLowerCase();
  return ["rock", "paper", "scissors"].includes(normalized) ? normalized : null;
}

function userBeatsWeb(userChoice, webChoice) {
  return (
    (userChoice === "rock" && webChoice === "scissors") ||
    (userChoice === "paper" && webChoice === "rock") ||
    (userChoice === "scissors" && webChoice === "paper")
  );
}

function advanceGameWithChoice(userChoice) {
  if (!state.started || state.gameOver) {
    return { ok: false, error: "Game is not accepting choices." };
  }

  // Generate the computer's choice right when the hardware data arrives
  const possibleChoices = ["rock", "paper", "scissors"];
  const webChoice =
    possibleChoices[Math.floor(Math.random() * possibleChoices.length)];

  state.currentWebChoice = webChoice;
  state.lastWebChoice = webChoice;
  state.lastUserChoice = userChoice;

  if (userChoice === webChoice) {
    state.ties += 1;
    state.lastResult = "tie";
    state.message = "Tie. Same choice stays up.";
    return { ok: true, state: publicState() };
  }

  if (userBeatsWeb(userChoice, webChoice)) {
    state.userWins += 1;
    state.lastResult = "user";
    state.message = "You won that round.";
  } else {
    state.webWins += 1;
    state.lastResult = "web";
    state.message = "I won that round.";
  }

  state.roundIndex += 1;

  if (state.userWins >= winsNeeded) {
    state.gameOver = true;
    state.message = "You won the game.";
  } else if (state.webWins >= winsNeeded) {
    state.gameOver = true;
    state.message = "I won the game.";
  } else if (state.roundIndex >= totalRoundsAllowed) {
    state.gameOver = true;
    state.message =
      state.userWins > state.webWins ? "You won the game." : "I won the game.";
  }

  return { ok: true, state: publicState() };
}

async function findArduinoPortPath() {
  if (!SerialPort) {
    return null;
  }

  if (serialPath) {
    return serialPath;
  }

  const ports = await SerialPort.list();
  const likelyPort = ports.find((port) => {
    const text = [
      port.path,
      port.manufacturer,
      port.friendlyName,
      port.pnpId,
      port.vendorId,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    return (
      text.includes("arduino") ||
      text.includes("nano") ||
      text.includes("mbed") ||
      text.includes("usbmodem")
    );
  });

  return likelyPort ? likelyPort.path : null;
}

async function ensureSerialConnected() {
  if (!SerialPort) {
    console.warn(
      "serialport package is not installed. Run npm install in web-app.",
    );
    return false;
  }

  if (serialPort && serialPort.isOpen) {
    return true;
  }

  const portPath = await findArduinoPortPath();
  if (!portPath) {
    console.warn(
      "No Arduino serial port found. Set ARDUINO_PORT=/dev/tty... if needed.",
    );
    return false;
  }

  serialPath = portPath;
  serialPort = new SerialPort({
    path: serialPath,
    baudRate: serialBaudRate,
  });
  let opened = false;

  const parser = serialPort.pipe(new ReadlineParser({ delimiter: "\n" }));

  serialPort.on("open", () => {
    opened = true;
    updateSerialConnection(true);
    console.log(`Arduino serial connected on ${serialPath}`);
  });

  serialPort.on("close", () => {
    updateSerialConnection(false);
    console.log("Arduino serial disconnected");
  });

  serialPort.on("error", (error) => {
    updateSerialConnection(false);
    console.warn(`Arduino serial error: ${error.message}`);
  });

  parser.on("data", handleSerialLine);

  await new Promise((resolve) => {
    serialPort.once("open", resolve);
    serialPort.once("error", resolve);
  });

  if (opened) {
    await new Promise((resolve) => setTimeout(resolve, serialBootDelayMs));
  }

  return Boolean(serialPort && serialPort.isOpen);
}

function writeSerialLine(line) {
  if (!serialPort || !serialPort.isOpen) {
    return;
  }

  serialPort.write(`${line}\n`);
}

function handleSerialLine(rawLine) {
  // rawLine comes from ReadlineParser (delimiter '\n') and may not include terminating newline
  if (!rawLine) return;
  // preserve original raw content for image collection (avoid trimming inside image)
  const raw = typeof rawLine === "string" ? rawLine : String(rawLine);
  const trimmed = raw.trim();

  console.log(`[arduino] ${trimmed}`);

  // handle PGM image markers
  if (trimmed === "IMAGE_START") {
    serialImageCollecting = true;
    serialImageBuffer = "";
    return;
  }

  if (trimmed === "IMAGE_END") {
    serialImageCollecting = false;
    // emit image to connected socket.io clients
    try {
      io && io.emit && io.emit("serial-image", { pgm: serialImageBuffer });
    } catch (err) {
      console.warn("Failed to emit serial-image", err);
    }
    serialImageBuffer = "";
    return;
  }

  if (serialImageCollecting) {
    // append the raw line (without losing whitespace) and restore newline
    serialImageBuffer += raw.replace(new RegExp("\\r?\\n$"), "") + "\n";
    return;
  }

  if (!trimmed) {
    return;
  }

  if (trimmed === "Connected to web app") {
    updateSerialConnection(true);
    return;
  }

  if (!trimmed.startsWith("CHOICE:")) {
    return;
  }

  const choice = normalizeChoice(trimmed.slice("CHOICE:".length));
  if (!choice) {
    console.warn(`Ignored invalid Arduino choice: ${trimmed}`);
    return;
  }

  const result = advanceGameWithChoice(choice);
  if (!result.ok) {
    console.warn(`Ignored Arduino choice: ${result.error}`);
  }
}
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function contentTypeFor(filePath) {
  const extension = path.extname(filePath);
  switch (extension) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, requestedPath));

  if (requestedPath === "/index.html") {
    state = createInitialState();
  }

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    res.writeHead(200, { "Content-Type": contentTypeFor(filePath) });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (req.method === "GET" && url.pathname === "/api/state") {
      sendJson(res, 200, publicState());
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/connect") {
      const serialReady = await ensureSerialConnected();
      state.connected = serialReady;
      state.message = serialReady
        ? "Connected to web app."
        : "Web app ready. Arduino serial not connected.";
      writeSerialLine("START");
      sendJson(res, 200, publicState());
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/start") {
      state = createInitialState();
      const serialReady = await ensureSerialConnected();
      state.connected = serialReady;
      updateSerialConnection(serialReady);
      state.started = true;
      state.currentWebChoice = null;
      state.message = "Game started.";
      writeSerialLine("START");
      sendJson(res, 200, publicState());
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/serial/ports") {
      if (!SerialPort) {
        sendJson(res, 200, {
          available: false,
          ports: [],
          message: "Run npm install in web-app to enable serial support.",
        });
        return;
      }

      sendJson(res, 200, {
        available: true,
        ports: await SerialPort.list(),
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/round-ready") {
      if (!state.started || state.gameOver) {
        sendJson(res, 409, {
          error: "Game is not active.",
          state: publicState(),
        });
        return;
      }

      state.currentWebChoice = null;
      state.waitingForArduino = true;
      state.message = "Waiting for Arduino choice.";
      sendJson(res, 200, publicState());
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/choice") {
      const body = await readJson(req);
      const choice = normalizeChoice(body.choice);

      if (!choice) {
        sendJson(res, 400, {
          error: "Choice must be rock, paper, or scissors.",
        });
        return;
      }

      const result = advanceGameWithChoice(choice);
      sendJson(res, result.ok ? 200 : 409, result.ok ? result.state : result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/debug/send-pgm") {
      // small 8x8 test PGM (P2) — simple gradient
      const w = 8,
        h = 8,
        max = 255;
      const pixels = [];
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          pixels.push(Math.round(((x + y) / (w + h - 2)) * max));
        }
      }
      const header = `P2\n${w} ${h}\n${max}\n`;
      const body = pixels.join(" ");
      const pgm = header + body + "\n";
      try {
        io && io.emit && io.emit("serial-image", { pgm });
      } catch (err) {
        console.warn("emit test pgm failed", err);
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      sendJson(res, 404, { error: "API route not found." });
      return;
    }

    serveStatic(req, res);
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

const io = new SocketServer(server);

// Emit connection events for debugging
io.on("connection", (socket) => {
  console.log("socket.io client connected");
  socket.on("disconnect", () => console.log("socket.io client disconnected"));
});

server.listen(PORT, HOST, () => {
  console.log(`RPS web app running at http://${HOST}:${PORT}`);
});
