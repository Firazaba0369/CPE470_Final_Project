const icons = {
  rock: "✊",
  paper: "✋",
  scissors: "✌",
};

const labels = {
  rock: "Rock",
  paper: "Paper",
  scissors: "Scissors",
};

// Small client-side state for UI timing. The actual game score and round
// winner live on the Node server so Arduino serial events can update them.
const state = {
  countdownTimer: null,
  nextRoundTimer: null,
  busy: false,
  lastResultKey: "",
};

const resultPauseMs = 1200;

const elements = {
  connectionStatus: document.querySelector("#connectionStatus"),
  playButton: document.querySelector("#playButton"),
  countdown: document.querySelector("#countdown"),
  webChoice: document.querySelector("#webChoice"),
  prompt: document.querySelector("#prompt"),
  userWins: document.querySelector("#userWins"),
  webWins: document.querySelector("#webWins"),
  rounds: document.querySelector("#rounds"),
  resultText: document.querySelector("#resultText"),
  simulateButtons: [...document.querySelectorAll("[data-choice]")],
  captureCanvas: document.querySelector("#captureCanvas"),
  userChoiceLabel: document.querySelector("#userChoiceLabel"),
};

// The Arduino sends the captured grayscale frame over serial. The server
// rebroadcasts it with Socket.IO so the browser can preview the image that was
// just classified.
if (typeof io !== "undefined") {
  try {
    const socket = io();
    socket.on("serial-image", (data) => {
      if (data && data.pgm) {
        displayPGM(data.pgm);
      }
    });
  } catch (err) {
    console.warn("socket.io init failed", err);
  }
}

// Thin wrapper around the Node API routes used by the game controls.
async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "Request failed");
  }

  return payload;
}

// Shows either the hidden state or a revealed rock/paper/scissors choice card.
function choiceMarkup(choice) {
  const icon = choice ? icons[choice] : "?";
  const label = choice ? labels[choice] : "Hidden";
  elements.webChoice.innerHTML = `
    <span class="choice-icon">${icon}</span>
    <span class="choice-label">${label}</span>
  `;
}

// Prevents overlapping automatic round transitions when a hardware result and
// polling update arrive close together.
function clearNextRoundTimer() {
  if (state.nextRoundTimer) {
    clearTimeout(state.nextRoundTimer);
    state.nextRoundTimer = null;
  }
}

// Renders compact round progress without revealing future Arduino/web choices.
function renderRoundDots(game) {
  const currentRound = game.gameOver
    ? game.roundIndex
    : Math.min(game.roundIndex + 1, game.totalRounds);

  const roundResults = Array.isArray(game.roundResults) ? game.roundResults : [];

  const dots = Array.from({ length: game.totalRounds })
    .map((_, index) => {
      const active = game.started && !game.gameOver && index === game.roundIndex;
      const done = index < game.roundIndex;
      const lost = done && roundResults[index] === "web";

      return `<span class="round-dot ${active ? "active" : ""} ${done ? "done" : ""} ${lost ? "lost" : ""}"></span>`;
    })
    .join("");

  elements.rounds.innerHTML = `
    <span class="round-label">Round ${currentRound} / ${game.totalRounds}</span>
    <div class="round-track">${dots}</div>
  `;
}

// Arduino image previews are sent as ASCII PGM text because it is easy to print
// over serial and easy for the browser to reconstruct into pixels.
function parsePGM(pgmText) {
  const lines = pgmText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

  if (lines.length < 4 || lines[0] !== "P2") {
    return null;
  }

  const [width, height] = lines[1].split(/\s+/).map(Number);
  const maxValue = Number(lines[2]);
  const pixels = lines
    .slice(3)
    .join(" ")
    .split(/\s+/)
    .map(Number)
    .filter((value) => Number.isFinite(value));

  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    !Number.isFinite(maxValue)
  ) {
    return null;
  }

  if (pixels.length < width * height) {
    return null;
  }

  return { width, height, maxValue, pixels };
}

function renderPGMToCanvas(canvas, pgm) {
  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }

  // Keep the backing canvas at the real image resolution, then scale it with
  // CSS so the low-resolution camera frame stays sharp instead of blurred.
  canvas.width = pgm.width;
  canvas.height = pgm.height;

  canvas.style.width = pgm.width * 3 + "px";
  canvas.style.height = pgm.height * 3 + "px";
  canvas.style.imageRendering = "pixelated";

  const imageData = context.createImageData(pgm.width, pgm.height);
  const data = imageData.data;

  for (let index = 0; index < pgm.width * pgm.height; index += 1) {
    const value = pgm.pixels[index] ?? 0;
    const shade =
      pgm.maxValue > 0 ? Math.round((value / pgm.maxValue) * 255) : 0;
    const offset = index * 4;
    data[offset] = shade;
    data[offset + 1] = shade;
    data[offset + 2] = shade;
    data[offset + 3] = 255;
  }

  context.putImageData(imageData, 0, 0);
}

// Converts the latest serial image into the preview canvas shown in the UI.
function displayPGM(pgmText) {
  const pgm = parsePGM(pgmText);
  if (!pgm) {
    console.error("Invalid PGM data received from serial.");
    return;
  }

  if (!elements.captureCanvas) {
    console.warn("Missing #captureCanvas element.");
    return;
  }

  renderPGMToCanvas(elements.captureCanvas, pgm);
}

// Central UI renderer. It reflects the server's game state but leaves timing
// details like countdowns and short result pauses to the browser.
function render(game) {
  elements.connectionStatus.textContent = game.connected
    ? "Arduino connected"
    : "Arduino offline";
  elements.connectionStatus.classList.toggle("connected", game.connected);
  elements.userWins.textContent = game.userWins;
  elements.webWins.textContent = game.webWins;
  elements.resultText.textContent = game.message;
  renderRoundDots(game);

  const waiting = game.started && game.waitingForArduino && !game.gameOver;
  elements.simulateButtons.forEach((button) => {
    button.disabled = !waiting || state.busy;
  });

  if (game.gameOver) {
    elements.playButton.textContent = "Play again";
    elements.playButton.disabled = false;
    elements.prompt.textContent = "Game over.";
    choiceMarkup(game.lastWebChoice || game.currentWebChoice);
    return;
  }

  if (!game.started) {
    elements.playButton.textContent = "Play game";
    elements.playButton.disabled = false;
    elements.prompt.textContent = "Click play when you're ready.";
    elements.countdown.textContent = "Ready?";
    choiceMarkup(null);
    return;
  }

  elements.playButton.textContent = waiting ? "Waiting" : "Play game";
  elements.playButton.disabled = true;
}

// Polling compares a compact signature of the last result so the page can react
// only when Node receives a new Arduino serial message.
function resultKeyFor(game) {
  return [
    game.roundIndex,
    game.userWins,
    game.webWins,
    game.ties,
    game.lastResult,
    game.lastUserChoice,
    game.lastWebChoice,
    game.waitingForArduino,
    game.gameOver,
  ].join("|");
}

// Starts a round from the user's perspective: prepare server state, hide the
// app's choice, count down, then wait for the Arduino button/camera result.
async function runCountdown(game) {
  state.busy = true;
  elements.playButton.disabled = true;
  elements.prompt.textContent = "Turn around and face the Arduino.";
  choiceMarkup(null);
  if (elements.userChoiceLabel)
    elements.userChoiceLabel.textContent = "Waiting";

  const readyState = await api("/api/round-ready", { method: "POST" });
  render(readyState);
  choiceMarkup(null);

  for (const value of ["3", "2", "1"]) {
    elements.countdown.textContent = value;
    await new Promise((resolve) => setTimeout(resolve, 760));
  }

  state.busy = false;
  render(readyState);
  elements.countdown.textContent = "Shoot";
  choiceMarkup(null); // Keep the web app's choice hidden until the Arduino button is pressed
  elements.prompt.textContent = "Show your hand and press the Arduino button.";
}

// Starts a fresh game and opens the Arduino serial connection through Node.
async function startGame() {
  try {
    clearNextRoundTimer();
    state.busy = true;
    render(await api("/api/connect", { method: "POST" }));
    const game = await api("/api/start", { method: "POST" });
    render(game);
    await runCountdown(game);
  } catch (error) {
    elements.resultText.textContent = error.message;
    state.busy = false;
  }
}

// Used by both automatic round advancement and the initial Play button.
async function nextRound() {
  try {
    clearNextRoundTimer();
    const game = await api("/api/state");
    if (!game.started || game.gameOver) {
      await startGame();
      return;
    }

    await runCountdown(game);
  } catch (error) {
    elements.resultText.textContent = error.message;
    state.busy = false;
  }
}

// Development fallback for testing without hardware; the real Arduino path
// reaches the same server logic through USB serial.
async function sendSimulatedChoice(choice) {
  try {
    clearNextRoundTimer();
    state.busy = true;
    const game = await api("/api/choice", {
      method: "POST",
      body: JSON.stringify({ choice }),
    });

    state.lastResultKey = resultKeyFor(game);
    render(game);
    choiceMarkup(game.lastWebChoice || game.currentWebChoice);

    if (!game.gameOver && game.lastResult === "tie") {
      state.busy = false;
      elements.prompt.textContent = "Tie. Same choice again.";
      state.nextRoundTimer = setTimeout(() => {
        nextRound();
      }, resultPauseMs);
      return;
    }

    state.busy = false;
    if (!game.gameOver) {
      elements.prompt.textContent = "Next round starting.";
      state.nextRoundTimer = setTimeout(() => {
        nextRound();
      }, resultPauseMs);
      return;
    }

    render(game);
  } catch (error) {
    elements.resultText.textContent = error.message;
    state.busy = false;
  }
}

// The browser polls because Arduino input arrives at Node independently of
// browser clicks. When a new serial result appears, the UI reveals choices,
// updates score, and schedules the next countdown.
async function pollState() {
  if (state.busy) {
    return;
  }

  try {
    const game = await api("/api/state");
    const key = resultKeyFor(game);

    if (key !== state.lastResultKey) {
      // Parse previous score totals from the key string
      const oldParts = state.lastResultKey
        ? state.lastResultKey.split("|")
        : [];
      const oldResultsCount =
        (parseInt(oldParts[1]) || 0) +
        (parseInt(oldParts[2]) || 0) +
        (parseInt(oldParts[3]) || 0);

      state.lastResultKey = key;
      render(game);

      // Calculate new score totals
      const newResultsCount =
        (game.userWins || 0) + (game.webWins || 0) + (game.ties || 0);

      // If the overall score/ties increased, a hardware result JUST arrived!
      if (newResultsCount > oldResultsCount) {
        if (game.lastWebChoice) {
          choiceMarkup(game.lastWebChoice); // Reveal the bot's choice!
        }
        if (game.lastUserChoice && elements.userChoiceLabel) {
          elements.userChoiceLabel.textContent =
            labels[game.lastUserChoice] || "Unknown"; // Reveal Arduino's prediction!
        }

        if (game.started && !game.gameOver) {
          elements.prompt.textContent =
            game.lastResult === "tie"
              ? "Tie. Restarting countdown..."
              : "Next round starting.";
          clearNextRoundTimer();
          state.nextRoundTimer = setTimeout(() => {
            nextRound();
          }, resultPauseMs);
        }
      }
    }
  } catch (error) {
    // Keep the UI usable if the server is briefly unavailable.
  }
}

elements.playButton.addEventListener("click", nextRound);
elements.simulateButtons.forEach((button) => {
  button.addEventListener("click", () =>
    sendSimulatedChoice(button.dataset.choice),
  );
});

api("/api/state")
  .then((game) => {
    state.lastResultKey = resultKeyFor(game);
    render(game);
  })
  .catch(() => {});

setInterval(pollState, 500);
