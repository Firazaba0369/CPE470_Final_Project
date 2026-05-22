const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const PUBLIC_DIR = path.join(__dirname, "public");

const choices = ["rock", "scissors", "paper", "rock", "scissors"];
const winsNeeded = 3;

let state = createInitialState();

function createInitialState() {
  return {
    connected: false,
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
    choices,
    winsNeeded,
    totalRounds: choices.length,
  };
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

  if (!state.waitingForArduino) {
    return { ok: false, error: "Round is not waiting for Arduino yet." };
  }

  const webChoice = choices[state.roundIndex];
  state.currentWebChoice = webChoice;
  state.lastWebChoice = webChoice;
  state.lastUserChoice = userChoice;

  if (userChoice === webChoice) {
    state.ties += 1;
    state.lastResult = "tie";
    state.waitingForArduino = true;
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
  state.waitingForArduino = false;

  if (state.userWins >= winsNeeded) {
    state.gameOver = true;
    state.message = "You won the game.";
  } else if (state.webWins >= winsNeeded) {
    state.gameOver = true;
    state.message = "I won the game.";
  } else if (state.roundIndex >= choices.length) {
    state.gameOver = true;
    state.message =
      state.userWins > state.webWins ? "You won the game." : "I won the game.";
  }

  return { ok: true, state: publicState() };
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
      state.connected = true;
      state.message = "Connected to web app.";
      console.log("Arduino connected to web app");
      sendJson(res, 200, publicState());
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/start") {
      state = createInitialState();
      state.connected = true;
      state.started = true;
      state.currentWebChoice = choices[0];
      state.message = "Game started.";
      sendJson(res, 200, publicState());
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/round-ready") {
      if (!state.started || state.gameOver) {
        sendJson(res, 409, { error: "Game is not active.", state: publicState() });
        return;
      }

      state.currentWebChoice = choices[state.roundIndex];
      state.waitingForArduino = true;
      state.message = "Waiting for Arduino choice.";
      sendJson(res, 200, publicState());
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/choice") {
      const body = await readJson(req);
      const choice = normalizeChoice(body.choice);

      if (!choice) {
        sendJson(res, 400, { error: "Choice must be rock, paper, or scissors." });
        return;
      }

      const result = advanceGameWithChoice(choice);
      sendJson(res, result.ok ? 200 : 409, result.ok ? result.state : result);
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

server.listen(PORT, HOST, () => {
  console.log(`RPS web app running at http://${HOST}:${PORT}`);
});
