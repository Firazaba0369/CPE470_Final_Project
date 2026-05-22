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
};

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

function choiceMarkup(choice) {
  const icon = choice ? icons[choice] : "?";
  const label = choice ? labels[choice] : "Hidden";
  elements.webChoice.innerHTML = `
    <span class="choice-icon">${icon}</span>
    <span class="choice-label">${label}</span>
  `;
}

function clearNextRoundTimer() {
  if (state.nextRoundTimer) {
    clearTimeout(state.nextRoundTimer);
    state.nextRoundTimer = null;
  }
}

function renderRoundDots(game) {
  const currentRound = Math.min(game.roundIndex + 1, game.totalRounds);
  const dots = game.choices
    .map((_, index) => {
      const active = game.started && !game.gameOver && index === game.roundIndex;
      const done = index < game.roundIndex;
      return `<span class="round-dot ${active ? "active" : ""} ${done ? "done" : ""}"></span>`;
    })
    .join("");

  elements.rounds.innerHTML = `
    <span class="round-label">Round ${currentRound} / ${game.totalRounds}</span>
    <div class="round-track">${dots}</div>
  `;
}

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

async function runCountdown(game) {
  state.busy = true;
  elements.playButton.disabled = true;
  elements.prompt.textContent = "Turn around and face the Arduino.";
  choiceMarkup(null);

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
  choiceMarkup(readyState.currentWebChoice);
  elements.prompt.textContent = "Show your hand and press the Arduino button.";
}

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

async function pollState() {
  if (state.busy) {
    return;
  }

  try {
    const game = await api("/api/state");
    const key = resultKeyFor(game);

    if (key !== state.lastResultKey) {
      state.lastResultKey = key;
      render(game);
      if (game.lastWebChoice && !game.waitingForArduino) {
        choiceMarkup(game.lastWebChoice);
      }

      if (
        game.started &&
        !game.gameOver &&
        !game.waitingForArduino &&
        game.lastResult
      ) {
        elements.prompt.textContent = "Next round starting.";
        clearNextRoundTimer();
        state.nextRoundTimer = setTimeout(() => {
          nextRound();
        }, resultPauseMs);
      }
    }
  } catch (error) {
    // Keep the UI usable if the server is briefly unavailable.
  }
}

elements.playButton.addEventListener("click", nextRound);
elements.simulateButtons.forEach((button) => {
  button.addEventListener("click", () => sendSimulatedChoice(button.dataset.choice));
});

api("/api/state")
  .then((game) => {
    state.lastResultKey = resultKeyFor(game);
    render(game);
  })
  .catch(() => {});

setInterval(pollState, 500);
