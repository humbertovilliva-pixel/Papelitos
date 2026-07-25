"use strict";

const APP_VERSION = 3;
const STORAGE_KEY = "papelitos-state-v3";
const DEVICE_KEY = "papelitos-device-id";
const HOST_ROOM_KEY = "papelitos-host-room";
const ROUND_INFO = [
  { label: "Ronda 1", rule: "Habla libremente — sin decir la palabra ni ninguna parte de ella" },
  { label: "Ronda 2", rule: "Solo puedes decir UNA palabra" },
  { label: "Ronda 3", rule: "Solo mímica — sin hablar ni hacer ningún sonido" }
];
const COLORS = ["#2d6a4f", "#c0392b", "#1a5276", "#7d3c98", "#b7950b", "#117a65", "#884c3a", "#3f6b8a", "#6b7f35", "#955c88"];
const MEDALS = ["🥇", "🥈", "🥉", "4º", "5º", "6º", "7º", "8º", "9º", "10º"];

let timerHandle = null;
let roomPollHandle = null;
let joinPollHandle = null;
let heartbeatHandle = null;
let wakeLock = null;
let audioCtx = null;
let deferredInstallPrompt = null;
let swRegistration = null;
let toastTimer = null;

function uid(prefix = "id") {
  if (crypto.randomUUID) return `${prefix}-${crypto.randomUUID()}`;
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function blankPlayers(count = 4) {
  return Array.from({ length: count }, () => ({ id: uid("player"), name: "", words: [] }));
}

function initialState() {
  return {
    version: APP_VERSION,
    guestMode: false,
    screen: "config",
    teamMode: "random",
    joinCode: "",
    players: blankPlayers(4),
    manualTeams: [],
    selectedSwap: null,
    wordsPerPlayer: 5,
    turnTime: 60,
    allowPass: true,
    maxPasses: 3,
    localEntryIdx: 0,
    showBlank: false,
    teams: [],
    room: null,
    join: null,
    round: 1,
    allWords: [],
    bowl: [],
    scores: [],
    teamTurnIdx: 0,
    explainerPerTeam: [],
    currentWord: null,
    guessedThisTurn: [],
    passesUsed: 0,
    timeLeft: 0,
    timerEndAt: null,
    timeUpHandled: false,
    gamePhase: "turn-ready",
    bowlEmptiedThisTurn: false,
    busy: false,
    error: ""
  };
}

let G = initialState();

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function shuffle(items) {
  const result = items.slice();
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function col(index) { return COLORS[index % COLORS.length]; }
function scoreVal(index) { return Number.isFinite(G.scores[index]) ? G.scores[index] : 0; }
function clamp(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}
function getDeviceId() {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = uid("device");
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

function persist() {
  if (G.guestMode) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(G));
    if (G.room?.code && G.room?.adminToken) {
      localStorage.setItem(HOST_ROOM_KEY, JSON.stringify({ code: G.room.code, adminToken: G.room.adminToken }));
    }
  } catch (error) {
    console.warn("No se pudo guardar la partida", error);
  }
}

function restore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (saved?.version !== APP_VERSION) return;
    const base = initialState();
    G = { ...base, ...saved, guestMode: false, busy: false, error: "" };
    if (!Array.isArray(G.players) || G.players.length < 4) G.players = blankPlayers(4);
    if (!Array.isArray(G.teams)) G.teams = [];
    if (!Array.isArray(G.manualTeams)) G.manualTeams = [];
  } catch (error) {
    console.warn("No se pudo recuperar la partida", error);
  }
}

function clearSavedGame() {
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(HOST_ROOM_KEY);
}

function showToast(message, actionLabel = "", action = null) {
  const toast = document.getElementById("toast");
  if (!toast) return;
  clearTimeout(toastTimer);
  toast.innerHTML = `<span>${esc(message)}</span>${actionLabel ? `<button class="btn btn-sm" id="toast-action">${esc(actionLabel)}</button>` : ""}`;
  toast.hidden = false;
  if (actionLabel && action) {
    const button = document.getElementById("toast-action");
    if (button) button.onclick = action;
  }
  toastTimer = setTimeout(() => { toast.hidden = true; }, actionLabel ? 10000 : 3500);
}

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      method: options.method || "GET",
      headers: { "content-type": "application/json", ...(options.headers || {}) },
      body: options.body ? JSON.stringify(options.body) : undefined,
      cache: "no-store"
    });
  } catch (error) {
    throw new Error("No hay conexión con la sala. Revisa internet e inténtalo nuevamente.");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || "No se pudo completar la operación.");
    error.data = data;
    throw error;
  }
  return data;
}

function validatePlayers() {
  if (G.players.length < 4) return "Se necesitan al menos 4 jugadores.";
  if (G.players.length % 2 !== 0) return "El número de jugadores debe ser par.";
  const names = G.players.map((player) => player.name.trim());
  if (names.some((name) => !name)) return "Completa todos los nombres.";
  const normalized = names.map((name) => name.toLocaleLowerCase("es"));
  if (new Set(normalized).size !== normalized.length) return "No puede haber nombres repetidos.";
  return "";
}

function playerById(id) { return G.players.find((player) => player.id === id); }

function updateConfigValidationDom() {
  if (G.screen !== "config") return;
  const error = validatePlayers();
  const box = document.getElementById("config-validation");
  const button = document.getElementById("continue-config");
  if (box) {
    box.textContent = error;
    box.classList.toggle("hidden", !error);
  }
  if (button) button.disabled = Boolean(error);
}

function render() {
  const app = document.getElementById("app");
  if (!app) return;

  let html = "";
  if (G.screen === "config") html = screenConfig();
  else if (G.screen === "manual-teams") html = screenManualTeams();
  else if (G.screen === "entry-choice") html = screenEntryChoice();
  else if (G.screen === "local-entry") html = G.showBlank ? screenLocalBlank() : screenWordEntry("local");
  else if (G.screen === "random-preview") html = screenRandomPreview();
  else if (G.screen === "host-room") html = screenHostRoom();
  else if (G.screen === "room-entry") html = screenWordEntry("room");
  else if (G.screen === "join-lobby") html = screenJoinLobby();
  else if (G.screen === "join-entry") html = screenWordEntry("join");
  else if (G.screen === "join-done") html = screenJoinDone();
  else if (G.screen === "game") {
    if (G.gamePhase === "turn-ready") html = screenTurnReady();
    else if (G.gamePhase === "turn-active") html = screenTurnActive();
    else if (G.gamePhase === "turn-done") html = screenTurnDone();
    else if (G.gamePhase === "round-end") html = screenRoundEnd();
    else if (G.gamePhase === "game-over") html = screenGameOver();
  }

  app.innerHTML = html;
  postRender();
  persist();
}

function postRender() {
  if (["local-entry", "room-entry", "join-entry"].includes(G.screen) && !G.showBlank) {
    setTimeout(() => document.getElementById("word-0")?.focus(), 50);
  }
  if (G.screen === "host-room" && G.room?.joinUrl) drawQr(G.room.joinUrl);
}

function appHeading(backAction = "") {
  return `<div class="topbar mt8">
    <div><div class="title">📝 Papelitos</div></div>
    ${backAction ? `<button class="btn btn-ghost btn-sm" data-action="${backAction}">← Volver</button>` : ""}
  </div>`;
}

function screenConfig() {
  const validation = validatePlayers();
  const playerRows = G.players.map((player, index) => `
    <div class="player-input-row">
      <div class="player-number">${index + 1}</div>
      <input type="text" data-action="player-name" data-id="${esc(player.id)}" value="${esc(player.name)}" placeholder="Jugador ${index + 1}" autocomplete="off">
      <button class="btn-icon" data-action="remove-player" data-id="${esc(player.id)}" aria-label="Eliminar jugador" ${G.players.length <= 4 ? "disabled" : ""}>✕</button>
    </div>`).join("");

  return `<div>
    <div class="topbar mt16">
      <div>
        <div class="title">📝 Papelitos</div>
        <p class="text-sm text-muted mt4">Habla libre → una palabra → mímica</p>
      </div>
      <button class="btn btn-ghost btn-sm ${deferredInstallPrompt ? "" : "hidden"}" data-action="install-app">Instalar</button>
    </div>

    <div class="card-flat mt20">
      <span class="label">¿Ya existe una sala?</span>
      <div class="flex-center gap8 mt8">
        <input type="text" data-action="join-code-input" value="${esc(G.joinCode)}" placeholder="Código de 6 dígitos" inputmode="numeric" maxlength="6" autocomplete="one-time-code">
        <button class="btn btn-dark nowrap" data-action="join-by-code">Entrar</button>
      </div>
    </div>

    <div class="mt24">
      <span class="label">Cómo se forman los equipos</span>
      <div class="mode-tabs">
        <button class="btn ${G.teamMode === "manual" ? "btn-dark" : "btn-ghost"}" data-action="set-team-mode" data-mode="manual">✍️ Manual</button>
        <button class="btn ${G.teamMode === "random" ? "btn-dark" : "btn-ghost"}" data-action="set-team-mode" data-mode="random">🎲 Al azar</button>
      </div>
    </div>

    <div class="mt20">
      <div class="flex-between mb8">
        <div>
          <span class="label">Jugadores</span>
          <p class="text-sm text-muted mt4">Número par · mínimo 4 · máximo 20</p>
        </div>
        <button class="btn btn-ghost btn-sm" data-action="add-player" ${G.players.length >= 20 ? "disabled" : ""}>+ Jugador</button>
      </div>
      <div class="card player-list">${playerRows}</div>
      <p class="text-sm text-muted text-center mt8">${G.players.length} jugadores → ${G.players.length / 2} equipos de 2</p>
    </div>

    <div class="card mt16">
      <span class="label">Configuración</span>
      <div class="flex-between mt12"><span>Palabras por jugador</span><input type="number" data-action="words-per-player" value="${G.wordsPerPlayer}" min="1" max="20"></div>
      <div class="flex-between mt12"><span>Tiempo por turno</span><div class="flex-center gap6"><input type="number" data-action="turn-time" value="${G.turnTime}" min="15" max="300"><span class="text-sm text-muted">seg</span></div></div>
      <hr class="divider">
      <label class="flex-center gap8"><input type="checkbox" data-action="toggle-pass" ${G.allowPass ? "checked" : ""}><span>Permitir pasar palabras</span></label>
      ${G.allowPass ? `<div class="flex-between mt12"><span>Máximo de pases</span><input type="number" data-action="max-passes" value="${G.maxPasses}" min="1" max="20"></div>` : ""}
      <button class="btn btn-ghost btn-block mt12" data-action="test-sound">🔊 Probar alarma y vibración</button>
    </div>

    <div id="config-validation" class="card-flat warning mt12 text-sm ${validation ? "" : "hidden"}">${esc(validation)}</div>
    <button id="continue-config" class="btn btn-dark btn-block mt12" style="padding:15px" data-action="continue-config" ${validation ? "disabled" : ""}>Continuar →</button>
    ${localStorage.getItem(STORAGE_KEY) ? `<button class="btn btn-ghost btn-block mt8" data-action="reset-all">Borrar partida guardada</button>` : ""}
  </div>`;
}

function prepareManualTeams() {
  const currentIds = new Set(G.players.map((player) => player.id));
  const assigned = G.manualTeams.flatMap((team) => team.playerIds || []);
  const valid = G.manualTeams.length === G.players.length / 2 && assigned.length === G.players.length && new Set(assigned).size === G.players.length && assigned.every((id) => currentIds.has(id));
  if (valid) return;
  G.manualTeams = [];
  for (let index = 0; index < G.players.length; index += 2) {
    G.manualTeams.push({
      id: uid("team"),
      name: `Equipo ${index / 2 + 1}`,
      playerIds: [G.players[index].id, G.players[index + 1].id]
    });
  }
  G.selectedSwap = null;
}

function screenManualTeams() {
  const teams = G.manualTeams.map((team, teamIndex) => {
    const members = team.playerIds.map((playerId, memberIndex) => {
      const player = playerById(playerId);
      const selected = G.selectedSwap?.teamIndex === teamIndex && G.selectedSwap?.memberIndex === memberIndex;
      return `<button class="member-card ${selected ? "selected" : ""}" data-action="select-member" data-ti="${teamIndex}" data-mi="${memberIndex}">${esc(player?.name || "—")}</button>`;
    }).join("");
    return `<div class="card team-card mt10" style="border-left-color:${col(teamIndex)}">
      <input type="text" data-action="manual-team-name" data-ti="${teamIndex}" value="${esc(team.name)}" aria-label="Nombre del equipo ${teamIndex + 1}" style="font-weight:700">
      <div class="team-members">${members}</div>
    </div>`;
  }).join("");

  return `<div>
    ${appHeading("back-config")}
    <div class="mt20">
      <div class="subtitle">Forma las parejas</div>
      <p class="text-sm text-muted mt4">Toca un jugador y después otro para intercambiarlos.</p>
    </div>
    ${teams}
    <button class="btn btn-ghost btn-block mt12" data-action="shuffle-manual">🔀 Mezclar jugadores</button>
    <button class="btn btn-dark btn-block mt8" data-action="confirm-manual-teams">Continuar →</button>
  </div>`;
}

function screenEntryChoice() {
  return `<div>
    ${appHeading(G.teamMode === "manual" ? "back-manual-teams" : "back-config")}
    <div class="mt24">
      <div class="subtitle">¿Cómo escribirán los papelitos?</div>
      <p class="text-sm text-muted mt4">Los dos métodos terminan en el mismo bowl.</p>
    </div>
    <div class="entry-choice mt16">
      <button class="card card-clickable" data-action="choose-local">
        <div class="entry-icon">📱</div>
        <div>
          <div class="subtitle">Pasar este teléfono</div>
          <p class="text-sm text-muted mt4">Cada jugador escribe sus palabras y se lo pasa al siguiente.</p>
        </div>
      </button>
      <button class="card card-clickable" data-action="create-room" ${G.busy ? "disabled" : ""}>
        <div class="entry-icon">⚡</div>
        <div>
          <div class="subtitle">Crear sala rápida</div>
          <p class="text-sm text-muted mt4">Cada persona elige su tarjeta y manda sus palabras desde cualquier teléfono.</p>
        </div>
      </button>
    </div>
    ${G.busy ? `<div class="card-flat mt12 text-center"><div class="spinner"></div><p class="text-sm mt8">Creando sala…</p></div>` : ""}
    ${G.error ? `<div class="card-flat error mt12 text-sm">${esc(G.error)}</div>` : ""}
  </div>`;
}

function currentEntryContext(kind) {
  if (kind === "local") {
    return { player: G.players[G.localEntryIdx], teamLabel: "Entrada privada", countLabel: `${G.localEntryIdx + 1} / ${G.players.length}` };
  }
  if (kind === "room") {
    return { player: G.room?.activeClaim?.player, teamLabel: "Desde el teléfono principal", countLabel: `Sala ${G.room?.code || ""}` };
  }
  return { player: G.join?.activeClaim?.player, teamLabel: `Sala ${G.join?.code || ""}`, countLabel: "Entrada privada" };
}

function screenWordEntry(kind) {
  const context = currentEntryContext(kind);
  const player = context.player;
  if (!player) return `<div class="card error mt24">No se encontró el jugador.</div>`;
  const inputs = Array.from({ length: G.wordsPerPlayer }, (_, index) => `
    <input type="text" id="word-${index}" placeholder="Palabra ${index + 1}" autocomplete="off" autocorrect="off" spellcheck="false" autocapitalize="sentences" ${index ? "class=\"mt8\"" : ""}>`).join("");
  const backAction = kind === "local" ? "cancel-local-entry" : kind === "room" ? "release-room-entry" : "release-join-entry";
  const submitAction = kind === "local" ? "submit-local-words" : kind === "room" ? "submit-room-words" : "submit-join-words";

  return `<div>
    <div class="topbar mt16">
      <span class="label">${esc(context.teamLabel)} · ${esc(context.countLabel)}</span>
      ${kind !== "local" || G.localEntryIdx === 0 ? `<button class="btn btn-ghost btn-sm" data-action="${backAction}">Cancelar</button>` : ""}
    </div>
    <div class="mt20" style="border-left:4px solid var(--green);padding-left:14px">
      <div class="subtitle">Hola, ${esc(player.name)} 👋</div>
      <p class="text-sm text-muted mt4">Escribe tus ${G.wordsPerPlayer} palabras secretas. Solo tú las ves.</p>
    </div>
    <div class="card mt16">${inputs}</div>
    ${G.error ? `<div class="card-flat error mt10 text-sm">${esc(G.error)}</div>` : ""}
    <button class="btn btn-dark btn-block mt10" data-action="${submitAction}" ${G.busy ? "disabled" : ""}>${G.busy ? "Guardando…" : "Listo ✓"}</button>
  </div>`;
}

function screenLocalBlank() {
  const previous = G.players[G.localEntryIdx - 1];
  const next = G.players[G.localEntryIdx];
  if (!next) {
    return `<div style="min-height:88vh;min-height:88dvh;display:flex;flex-direction:column;justify-content:center;text-align:center">
      <div style="font-size:3.5rem">✅</div>
      <div class="subtitle mt8">¡Todos terminaron!</div>
      <div class="card mt20"><p>${G.players.length * G.wordsPerPlayer} palabras en el bowl</p></div>
      <button class="btn btn-dark btn-block mt12" data-action="finish-local-entry">Preparar el juego 🎉</button>
    </div>`;
  }
  return `<div style="min-height:88vh;min-height:88dvh;display:flex;flex-direction:column;justify-content:center;text-align:center">
    <div style="font-size:3.5rem">✅</div>
    <div class="subtitle mt8">¡Listo, ${esc(previous?.name || "")}!</div>
    <p class="text-muted mt4">Pásale el teléfono a la siguiente persona.</p>
    <div class="card mt24" style="text-align:left">
      <span class="label">Siguiente</span>
      <div class="subtitle mt4">${esc(next.name)}</div>
    </div>
    <button class="btn btn-dark btn-block mt12" data-action="next-local-player">Soy ${esc(next.name)} — continuar →</button>
  </div>`;
}

function screenRandomPreview() {
  const teams = G.teams.map((team, index) => `
    <div class="card team-card mt10" style="border-left-color:${col(index)}">
      <span class="label">${esc(team.name)}</span>
      <div class="team-members">
        ${team.players.map((player) => `<div class="member-card" style="cursor:default">${esc(player.name)}</div>`).join("")}
      </div>
    </div>`).join("");
  return `<div>
    ${appHeading("")}
    <div class="mt20">
      <div class="subtitle">🎲 Equipos sorteados</div>
      <p class="text-sm text-muted mt4">${G.players.length} jugadores · ${G.teams.length} equipos</p>
    </div>
    ${teams}
    <div class="action-grid mt16">
      <button class="btn btn-ghost" data-action="reshuffle-random">🔀 Otra vez</button>
      <button class="btn btn-dark" data-action="confirm-random">¡A jugar! →</button>
    </div>
  </div>`;
}

function roomPlayerCard(player, host = false) {
  const status = player.status || "available";
  const label = status === "ready" ? "✓ Listo" : status === "writing" ? "✎ Escribiendo…" : "Disponible";
  const action = status === "available" ? (host ? "host-claim-player" : "join-claim-player") : "";
  return `<div class="player-card ${status} ${action ? "available" : ""}" ${action ? `data-action="${action}" data-id="${esc(player.id)}" role="button" tabindex="0"` : ""}>
    <div class="player-name">${esc(player.name)}</div>
    <div class="flex-between gap6">
      <span class="status-pill">${label}</span>
      ${host && status === "writing" ? `<button class="btn btn-ghost btn-sm" data-action="host-unlock-player" data-id="${esc(player.id)}">Liberar</button>` : ""}
    </div>
  </div>`;
}

function screenHostRoom() {
  const data = G.room?.publicData;
  if (!data) {
    return `<div>${appHeading("leave-host-room")}<div class="card mt24 text-center"><div class="spinner"></div><p class="mt12">Preparando la sala…</p>${G.error ? `<p class="text-sm mt8" style="color:var(--red)">${esc(G.error)}</p>` : ""}</div></div>`;
  }
  const total = data.players.length;
  const ready = data.readyCount;
  const percent = Math.round((ready / total) * 100);
  return `<div>
    ${appHeading("leave-host-room")}
    <div class="card mt20 text-center">
      <span class="label">Código de sala</span>
      <div class="room-code mt4">${esc(data.code)}</div>
      <p class="text-sm text-muted mt4">Expira automáticamente en unas horas</p>
      <div id="qr-code" class="qr-wrap mt16"><span class="text-sm text-muted">Generando QR…</span></div>
      <div class="action-grid mt10">
        <button class="btn btn-ghost" data-action="copy-room-link">Copiar enlace</button>
        <button class="btn btn-dark" data-action="share-room">Compartir</button>
      </div>
    </div>

    <div class="card mt12">
      <div class="flex-between"><span class="label">Progreso</span><strong>${ready} de ${total}</strong></div>
      <div class="progress-track mt8"><div class="progress-fill" style="width:${percent}%"></div></div>
      <p class="text-sm text-muted mt8">Toca una tarjeta disponible para introducir esas palabras desde este teléfono.</p>
    </div>

    <div class="player-grid mt12">${data.players.map((player) => roomPlayerCard(player, true)).join("")}</div>
    ${G.error ? `<div class="card-flat error mt12 text-sm">${esc(G.error)}</div>` : ""}
    <button class="btn btn-dark btn-block mt16" data-action="close-room" ${ready !== total || G.busy ? "disabled" : ""}>${G.busy ? "Preparando…" : "Cerrar sala y preparar el juego →"}</button>
    <button class="btn btn-ghost btn-block mt8" data-action="refresh-host-room">Actualizar sala</button>
  </div>`;
}

function screenJoinLobby() {
  if (G.join?.loading) {
    return `<div>${appHeading("")}<div class="card mt24 text-center"><div class="spinner"></div><p class="mt12">Entrando a la sala ${esc(G.join.code)}…</p></div></div>`;
  }
  if (G.join?.error && !G.join?.data) {
    return `<div>${appHeading("")}<div class="card error mt24"><div class="subtitle">No se pudo abrir la sala</div><p class="text-sm mt8">${esc(G.join.error)}</p><button class="btn btn-dark btn-block mt16" data-action="retry-join-room">Intentar otra vez</button></div></div>`;
  }
  const data = G.join?.data;
  if (!data) return "";
  return `<div>
    ${appHeading("")}
    <div class="card mt20 text-center">
      <span class="label">Sala</span>
      <div class="room-code mt4">${esc(data.code)}</div>
      <div class="subtitle mt12">¿Quién eres?</div>
      <p class="text-sm text-muted mt4">Selecciona tu tarjeta para escribir tus ${data.wordsPerPlayer} palabras.</p>
    </div>
    ${data.closed ? `<div class="card-flat warning mt12">Esta sala ya se cerró y el juego comenzó.</div>` : `<div class="player-grid mt12">${data.players.map((player) => roomPlayerCard(player, false)).join("")}</div>`}
    ${G.join?.error ? `<div class="card-flat error mt12 text-sm">${esc(G.join.error)}</div>` : ""}
    <button class="btn btn-ghost btn-block mt16" data-action="refresh-join-room">Actualizar</button>
  </div>`;
}

function screenJoinDone() {
  const player = G.join?.lastPlayer;
  return `<div style="min-height:88vh;min-height:88dvh;display:flex;flex-direction:column;justify-content:center;text-align:center">
    <div style="font-size:4rem">🎉</div>
    <div class="title mt8">¡Papelitos enviados!</div>
    <p class="text-muted mt8">${esc(player?.name || "Tus palabras")} ya está en el bowl.</p>
    <div class="card success mt20"><p>Puedes cerrar esta página o pasarle el teléfono a otra persona.</p></div>
    <button class="btn btn-dark btn-block mt12" data-action="back-to-join-lobby">Ver la sala</button>
  </div>`;
}

function scoreWidget() {
  const rows = G.teams.map((team, index) => `<div class="score-row"><span>${esc(team.name)}</span><span class="score-num" style="color:${col(index)}">${scoreVal(index)}</span></div>`).join("");
  return `<div class="card mt8">${rows}</div>`;
}

function screenTurnReady() {
  const team = G.teams[G.teamTurnIdx];
  const explainerIndex = G.explainerPerTeam[G.teamTurnIdx] || 0;
  const explainer = team.players[explainerIndex];
  const others = team.players.filter((_, index) => index !== explainerIndex);
  const round = ROUND_INFO[G.round - 1];
  return `<div class="mt16">
    <div class="flex-between"><span class="round-badge">${round.label}</span><span class="text-sm text-muted">${G.bowl.length} en el bowl</span></div>
    <div class="card mt12 text-center" style="border-left:4px solid ${col(G.teamTurnIdx)};padding:24px 18px">
      <span class="label">Turno de</span>
      <div class="title mt4">${esc(team.name)}</div>
      <hr class="divider">
      <span class="label">Explica 🎤</span>
      <div class="subtitle mt4" style="color:${col(G.teamTurnIdx)}">${esc(explainer?.name || "")}</div>
      <div class="mt12"><span class="label">Adivina${others.length > 1 ? "n" : ""}</span><p class="mt4">${others.map((player) => esc(player.name)).join(", ")}</p></div>
    </div>
    <div class="card-flat mt10"><span class="label">Regla</span><p class="mt4">${round.rule}</p></div>
    <div class="mt16"><span class="label">Puntaje acumulado</span>${scoreWidget()}</div>
    <button class="btn btn-dark btn-block mt12" style="padding:16px" data-action="start-turn">¡Estamos listos! →</button>
    <button class="btn btn-ghost btn-block mt8" data-action="test-sound">🔊 Probar alarma</button>
  </div>`;
}

function screenTurnActive() {
  const round = ROUND_INFO[G.round - 1];
  const team = G.teams[G.teamTurnIdx];
  const passesLeft = G.maxPasses - G.passesUsed;
  const canPass = G.allowPass && passesLeft > 0;
  const tags = G.guessedThisTurn.map((word) => `<span class="word-tag tag-won">${esc(word)}</span>`).join("");
  return `<div style="padding-top:8px;text-align:center">
    <div class="flex-between"><span class="round-badge">${round.label}</span><span class="text-sm" style="font-weight:700;color:${col(G.teamTurnIdx)}">${esc(team.name)}</span></div>
    <div id="timer-display" class="timer-display ${G.timeLeft <= 10 ? "timer-urgent" : ""}">${G.timeLeft}</div>
    <div class="card" style="padding:24px 16px"><div class="big-word">${esc(G.currentWord || "…")}</div><p class="text-sm text-muted mt8">${round.rule}</p></div>
    <div class="action-grid mt10" style="grid-template-columns:${G.allowPass ? "1fr 1fr" : "1fr"}">
      <button class="btn btn-green" data-action="guess" style="padding:20px 10px">✅ Adivinada</button>
      ${G.allowPass ? `<button class="btn btn-ghost" data-action="pass" style="padding:20px 10px" ${canPass ? "" : "disabled"}>⏭ Pasar (${Math.max(0, passesLeft)})</button>` : ""}
    </div>
    ${G.guessedThisTurn.length ? `<div class="mt16" style="text-align:left"><span class="label">Adivinadas (${G.guessedThisTurn.length})</span><div class="mt4">${tags}</div></div>` : ""}
  </div>`;
}

function screenTurnDone() {
  const team = G.teams[G.teamTurnIdx];
  const earned = G.guessedThisTurn.length;
  const round = ROUND_INFO[G.round - 1];
  const tags = G.guessedThisTurn.map((word) => `<span class="word-tag tag-won">${esc(word)}</span>`).join("");
  const bowlMessage = G.bowlEmptiedThisTurn ? `¡El bowl quedó vacío! Fin de la ${round.label}.` : `${G.bowl.length} palabra${G.bowl.length === 1 ? "" : "s"} quedan en el bowl`;
  const nextLabel = G.bowlEmptiedThisTurn ? (G.round === 3 ? "Ver ganador 🏆" : `Resultados de la ${round.label} →`) : "Siguiente turno →";
  return `<div class="mt24 text-center">
    <div class="title">⏱️ ¡Tiempo!</div>
    <div class="card mt16"><div class="label">${esc(team.name)}</div><div class="subtitle mt4" style="color:${col(G.teamTurnIdx)}">+${earned} punto${earned === 1 ? "" : "s"}</div>${earned ? `<div class="mt12" style="text-align:left"><span class="label">Palabras adivinadas</span><div class="mt4">${tags}</div></div>` : `<p class="text-sm text-muted mt8">Sin palabras adivinadas</p>`}</div>
    <p class="text-sm text-muted mt8">${bowlMessage}</p>
    <div class="mt16" style="text-align:left"><span class="label">Puntaje acumulado</span>${scoreWidget()}</div>
    <button class="btn btn-dark btn-block mt12" data-action="next-after-turn">${nextLabel}</button>
  </div>`;
}

function rankedTeams() {
  return G.teams.map((team, index) => ({ name: team.name, score: scoreVal(index), index })).sort((a, b) => b.score - a.score);
}

function rankingRows() {
  return rankedTeams().map((team, index) => `<div class="score-row"><div>${MEDALS[index] || ""}&nbsp;<strong>${esc(team.name)}</strong></div><span class="score-num" style="color:${col(team.index)}">${team.score}</span></div>`).join("");
}

function screenRoundEnd() {
  const round = ROUND_INFO[G.round - 1];
  const next = ROUND_INFO[G.round];
  return `<div class="mt24 text-center">
    <div class="title">Fin de la ${round.label} 🎉</div>
    <div class="card mt16" style="text-align:left"><span class="label">Puntaje acumulado</span>${rankingRows()}</div>
    <div class="card-flat mt10" style="text-align:left"><span class="label">Siguiente: ${next.label}</span><p class="mt4">${next.rule}</p><p class="text-sm text-muted mt8">Las mismas ${G.allWords.length} palabras vuelven al bowl.</p></div>
    <button class="btn btn-dark btn-block mt12" data-action="next-round">Comenzar ${next.label} →</button>
  </div>`;
}

function screenGameOver() {
  const ranking = rankedTeams();
  const tie = ranking.length > 1 && ranking[0].score === ranking[1].score;
  return `<div class="mt24 text-center">
    <div style="font-size:4rem">🏆</div>
    <div class="title mt8">${tie ? "¡Empate épico!" : `¡Ganó ${esc(ranking[0]?.name || "")}!`}</div>
    <div class="card mt16" style="text-align:left"><span class="label">Resultados finales</span>${rankingRows()}</div>
    <button class="btn btn-dark btn-block mt16" data-action="restart-same-players">🔄 Otra partida con los mismos jugadores</button>
    <button class="btn btn-ghost btn-block mt8" data-action="reset-all">Nueva configuración</button>
  </div>`;
}

function collectWordInputs() {
  const words = [];
  for (let index = 0; index < G.wordsPerPlayer; index += 1) {
    const value = document.getElementById(`word-${index}`)?.value.trim() || "";
    if (!value) throw new Error(`Completa las ${G.wordsPerPlayer} palabras antes de continuar.`);
    words.push(value.slice(0, 80));
  }
  return words;
}

function beginLocalEntry() {
  G.players.forEach((player) => { player.words = []; });
  G.localEntryIdx = 0;
  G.showBlank = false;
  G.error = "";
  G.screen = "local-entry";
  render();
}

function buildManualTeams() {
  G.teams = G.manualTeams.map((team) => ({
    id: team.id,
    name: team.name.trim() || "Equipo",
    players: team.playerIds.map((id) => playerById(id)).filter(Boolean)
  }));
}

function buildRandomTeams() {
  const players = shuffle(G.players);
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  G.teams = [];
  for (let index = 0; index < players.length; index += 2) {
    const teamIndex = index / 2;
    G.teams.push({
      id: uid("team"),
      name: `Equipo ${letters[teamIndex] || teamIndex + 1}`,
      players: [players[index], players[index + 1]]
    });
  }
}

function prepareGameAfterWords() {
  if (G.teamMode === "random") {
    buildRandomTeams();
    G.screen = "random-preview";
    render();
  } else {
    buildManualTeams();
    startGame();
  }
}

function startGame() {
  G.allWords = G.players.flatMap((player) => player.words || []);
  if (!G.allWords.length) {
    showToast("No hay palabras para comenzar.");
    return;
  }
  G.round = 1;
  G.scores = G.teams.map(() => 0);
  G.teamTurnIdx = 0;
  G.explainerPerTeam = G.teams.map(() => 0);
  G.bowl = shuffle(G.allWords);
  G.currentWord = null;
  G.gamePhase = "turn-ready";
  G.screen = "game";
  G.room = null;
  stopRoomPolling();
  render();
}

async function createRoom() {
  G.busy = true;
  G.error = "";
  render();
  try {
    const result = await api("/api/rooms", {
      method: "POST",
      body: {
        players: G.players.map((player) => ({ id: player.id, name: player.name.trim() })),
        wordsPerPlayer: G.wordsPerPlayer,
        teamMode: G.teamMode,
        manualTeams: G.teamMode === "manual" ? G.manualTeams : []
      }
    });
    G.room = {
      code: result.code,
      adminToken: result.adminToken,
      joinUrl: `${location.origin}/?room=${encodeURIComponent(result.code)}`,
      publicData: null,
      activeClaim: null
    };
    G.busy = false;
    G.screen = "host-room";
    render();
    await refreshHostRoom();
    startRoomPolling();
  } catch (error) {
    G.busy = false;
    G.error = error.message;
    render();
  }
}

async function refreshHostRoom(silent = false) {
  if (!G.room?.code) return;
  try {
    const data = await api(`/api/rooms/${G.room.code}`);
    G.room.publicData = data;
    if (!silent) G.error = "";
    render();
  } catch (error) {
    if (!silent) {
      G.error = error.message;
      render();
    }
  }
}

function startRoomPolling() {
  stopRoomPolling();
  roomPollHandle = setInterval(() => {
    if (G.screen === "host-room" && !document.hidden) void refreshHostRoom(true);
  }, 2500);
}

function stopRoomPolling() {
  if (roomPollHandle) clearInterval(roomPollHandle);
  roomPollHandle = null;
}

async function hostClaimPlayer(playerId) {
  G.error = "";
  try {
    const result = await api(`/api/rooms/${G.room.code}/claim`, {
      method: "POST",
      body: { playerId, deviceId: getDeviceId() }
    });
    G.room.activeClaim = { player: result.player, claimToken: result.claimToken };
    G.screen = "room-entry";
    startHeartbeat("room");
    render();
  } catch (error) {
    G.error = error.message;
    await refreshHostRoom(true);
    render();
  }
}

async function submitRemoteWords(kind) {
  let words;
  try { words = collectWordInputs(); }
  catch (error) { G.error = error.message; render(); return; }
  const context = kind === "room" ? G.room : G.join;
  const claim = context?.activeClaim;
  if (!claim) return;
  G.busy = true;
  G.error = "";
  render();
  try {
    await api(`/api/rooms/${context.code}/submit`, {
      method: "POST",
      body: { playerId: claim.player.id, claimToken: claim.claimToken, words }
    });
    stopHeartbeat();
    if (kind === "room") {
      G.room.activeClaim = null;
      G.busy = false;
      G.screen = "host-room";
      await refreshHostRoom(true);
      startRoomPolling();
      render();
    } else {
      localStorage.removeItem(`papelitos-claim-${context.code}`);
      G.join.lastPlayer = claim.player;
      G.join.activeClaim = null;
      G.busy = false;
      G.screen = "join-done";
      render();
    }
  } catch (error) {
    G.busy = false;
    G.error = error.message;
    render();
  }
}

async function releaseRemoteClaim(kind) {
  const context = kind === "room" ? G.room : G.join;
  const claim = context?.activeClaim;
  stopHeartbeat();
  if (claim) {
    try {
      await api(`/api/rooms/${context.code}/release`, {
        method: "POST",
        body: { playerId: claim.player.id, claimToken: claim.claimToken }
      });
    } catch (error) {
      console.warn(error);
    }
  }
  context.activeClaim = null;
  G.error = "";
  if (kind === "room") {
    G.screen = "host-room";
    await refreshHostRoom(true);
    startRoomPolling();
  } else {
    localStorage.removeItem(`papelitos-claim-${context.code}`);
    G.screen = "join-lobby";
    await refreshJoinRoom(true);
  }
  render();
}

async function unlockHostPlayer(playerId) {
  try {
    await api(`/api/rooms/${G.room.code}/unlock`, {
      method: "POST",
      body: { playerId, adminToken: G.room.adminToken }
    });
    await refreshHostRoom(true);
  } catch (error) {
    G.error = error.message;
    render();
  }
}

async function closeRoomAndPrepare() {
  G.busy = true;
  G.error = "";
  render();
  try {
    const result = await api(`/api/rooms/${G.room.code}/close`, {
      method: "POST",
      body: { adminToken: G.room.adminToken }
    });
    const byPlayer = new Map(result.submissions.map((submission) => [submission.playerId, submission.words]));
    G.players.forEach((player) => { player.words = byPlayer.get(player.id) || []; });
    G.busy = false;
    localStorage.removeItem(HOST_ROOM_KEY);
    prepareGameAfterWords();
  } catch (error) {
    G.busy = false;
    G.error = error.message;
    render();
  }
}

async function loadJoinRoom(code, allowResume = true) {
  G.guestMode = true;
  G.join = G.join || { code, data: null, activeClaim: null, lastPlayer: null };
  G.join.code = code;
  G.join.loading = true;
  G.join.error = "";
  G.screen = "join-lobby";
  render();
  try {
    const data = await api(`/api/rooms/${code}`);
    G.wordsPerPlayer = data.wordsPerPlayer;
    G.join.data = data;
    G.join.loading = false;
    if (allowResume) {
      const savedClaim = JSON.parse(localStorage.getItem(`papelitos-claim-${code}`) || "null");
      const publicPlayer = savedClaim && data.players.find((player) => player.id === savedClaim.player?.id);
      if (savedClaim?.claimToken && publicPlayer?.status === "writing") {
        G.join.activeClaim = savedClaim;
        G.screen = "join-entry";
        startHeartbeat("join");
      }
    }
    render();
    startJoinPolling();
  } catch (error) {
    G.join.loading = false;
    G.join.error = error.message;
    render();
  }
}

async function refreshJoinRoom(silent = false) {
  if (!G.join?.code) return;
  try {
    G.join.data = await api(`/api/rooms/${G.join.code}`);
    if (!silent) G.join.error = "";
    render();
  } catch (error) {
    if (!silent) {
      G.join.error = error.message;
      render();
    }
  }
}

function startJoinPolling() {
  stopJoinPolling();
  joinPollHandle = setInterval(() => {
    if (G.screen === "join-lobby" && !document.hidden) void refreshJoinRoom(true);
  }, 3000);
}

function stopJoinPolling() {
  if (joinPollHandle) clearInterval(joinPollHandle);
  joinPollHandle = null;
}

async function joinClaimPlayer(playerId) {
  G.join.error = "";
  try {
    const result = await api(`/api/rooms/${G.join.code}/claim`, {
      method: "POST",
      body: { playerId, deviceId: getDeviceId() }
    });
    G.join.activeClaim = { player: result.player, claimToken: result.claimToken };
    localStorage.setItem(`papelitos-claim-${G.join.code}`, JSON.stringify(G.join.activeClaim));
    G.screen = "join-entry";
    stopJoinPolling();
    startHeartbeat("join");
    render();
  } catch (error) {
    G.join.error = error.message;
    await refreshJoinRoom(true);
    render();
  }
}

function startHeartbeat(kind) {
  stopHeartbeat();
  heartbeatHandle = setInterval(async () => {
    const context = kind === "room" ? G.room : G.join;
    const claim = context?.activeClaim;
    if (!claim) return;
    try {
      await api(`/api/rooms/${context.code}/heartbeat`, {
        method: "POST",
        body: { playerId: claim.player.id, claimToken: claim.claimToken }
      });
    } catch (error) {
      console.warn("No se pudo renovar la tarjeta", error);
    }
  }, 120000);
}

function stopHeartbeat() {
  if (heartbeatHandle) clearInterval(heartbeatHandle);
  heartbeatHandle = null;
}

function drawQr(text) {
  const element = document.getElementById("qr-code");
  if (!element || !text) return;
  element.innerHTML = "";
  try {
    if (window.QRCode) {
      new window.QRCode(element, { text, width: 190, height: 190, colorDark: "#1c1a16", colorLight: "#ffffff", correctLevel: window.QRCode.CorrectLevel.M });
    } else {
      element.innerHTML = `<p class="text-sm text-muted">QR no disponible. Usa el código ${esc(G.room?.code || "")}.</p>`;
    }
  } catch (error) {
    element.innerHTML = `<p class="text-sm text-muted">QR no disponible. Usa el código ${esc(G.room?.code || "")}.</p>`;
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    showToast("Enlace copiado.");
  } catch (error) {
    const input = document.createElement("textarea");
    input.value = text;
    document.body.appendChild(input);
    input.select();
    document.execCommand("copy");
    input.remove();
    showToast("Enlace copiado.");
  }
}

async function shareRoom() {
  const url = G.room?.joinUrl;
  if (!url) return;
  if (navigator.share) {
    try { await navigator.share({ title: "Papelitos", text: `Únete a la sala ${G.room.code}`, url }); }
    catch (error) { if (error.name !== "AbortError") await copyText(url); }
  } else await copyText(url);
}

function ensureAudio() {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return null;
    if (!audioCtx) audioCtx = new AudioContextClass();
    if (audioCtx.state === "suspended") void audioCtx.resume();
    return audioCtx;
  } catch (error) {
    return null;
  }
}

function playBuzzer() {
  const context = ensureAudio();
  if (context) {
    const now = context.currentTime;
    [[520, 0, .2], [400, .24, .2], [280, .48, .65]].forEach(([frequency, offset, duration]) => {
      try {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.type = "sawtooth";
        oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(.26, now + offset);
        gain.gain.exponentialRampToValueAtTime(.001, now + offset + duration);
        oscillator.start(now + offset);
        oscillator.stop(now + offset + duration + .05);
      } catch (error) { console.warn(error); }
    });
  }
  if (navigator.vibrate) navigator.vibrate([250, 100, 250, 100, 650]);
}

async function requestWakeLock() {
  if (!("wakeLock" in navigator) || document.hidden || G.gamePhase !== "turn-active") return;
  try {
    if (wakeLock && !wakeLock.released) return;
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => { wakeLock = null; });
  } catch (error) {
    console.warn("Wake Lock no disponible", error);
  }
}

async function releaseWakeLock() {
  try { await wakeLock?.release(); }
  catch (error) { console.warn(error); }
  wakeLock = null;
}

function updateTimer() {
  if (G.gamePhase !== "turn-active" || !G.timerEndAt || G.timeUpHandled) return;
  const remaining = Math.max(0, Math.ceil((G.timerEndAt - Date.now()) / 1000));
  if (remaining !== G.timeLeft) {
    G.timeLeft = remaining;
    const element = document.getElementById("timer-display");
    if (element) {
      element.textContent = String(remaining);
      element.classList.toggle("timer-urgent", remaining <= 10);
    }
    persist();
  }
  if (remaining <= 0) timeUp();
}

function startTimerLoop() {
  if (timerHandle) clearInterval(timerHandle);
  timerHandle = setInterval(updateTimer, 200);
  updateTimer();
}

function stopTimerLoop() {
  if (timerHandle) clearInterval(timerHandle);
  timerHandle = null;
}

function startTurn() {
  if (!G.bowl.length) { endRound(); return; }
  ensureAudio();
  G.guessedThisTurn = [];
  G.passesUsed = 0;
  G.bowlEmptiedThisTurn = false;
  G.timeLeft = G.turnTime;
  G.timerEndAt = Date.now() + G.turnTime * 1000;
  G.timeUpHandled = false;
  G.currentWord = G.bowl.shift();
  G.gamePhase = "turn-active";
  render();
  startTimerLoop();
  void requestWakeLock();
}

function timeUp() {
  if (G.timeUpHandled || G.gamePhase !== "turn-active") return;
  G.timeUpHandled = true;
  stopTimerLoop();
  void releaseWakeLock();
  playBuzzer();
  if (G.currentWord) G.bowl.push(G.currentWord);
  G.currentWord = null;
  G.timerEndAt = null;
  G.timeLeft = 0;
  G.gamePhase = "turn-done";
  render();
}

function onGuess() {
  if (!G.currentWord || G.gamePhase !== "turn-active") return;
  G.guessedThisTurn.push(G.currentWord);
  G.scores[G.teamTurnIdx] += 1;
  G.currentWord = null;
  if (!G.bowl.length) {
    stopTimerLoop();
    void releaseWakeLock();
    G.timerEndAt = null;
    G.bowlEmptiedThisTurn = true;
    G.gamePhase = "turn-done";
    render();
    return;
  }
  G.currentWord = G.bowl.shift();
  render();
}

function onPass() {
  if (!G.currentWord || !G.allowPass || G.passesUsed >= G.maxPasses || G.gamePhase !== "turn-active") return;
  G.passesUsed += 1;
  const position = G.bowl.length ? 1 + Math.floor(Math.random() * G.bowl.length) : 0;
  G.bowl.splice(Math.min(position, G.bowl.length), 0, G.currentWord);
  G.currentWord = G.bowl.shift();
  render();
}

function advanceTeam() {
  const team = G.teams[G.teamTurnIdx];
  G.explainerPerTeam[G.teamTurnIdx] = (G.explainerPerTeam[G.teamTurnIdx] + 1) % team.players.length;
  G.teamTurnIdx = (G.teamTurnIdx + 1) % G.teams.length;
}

function nextAfterTurn() {
  if (G.bowlEmptiedThisTurn) { endRound(); return; }
  advanceTeam();
  G.gamePhase = "turn-ready";
  render();
}

function endRound() {
  G.gamePhase = G.round === 3 ? "game-over" : "round-end";
  render();
}

function nextRound() {
  G.round += 1;
  G.bowl = shuffle(G.allWords);
  advanceTeam();
  G.gamePhase = "turn-ready";
  render();
}

function restartSamePlayers() {
  G.players.forEach((player) => { player.words = []; });
  G.allWords = [];
  G.bowl = [];
  G.scores = [];
  G.round = 1;
  G.gamePhase = "turn-ready";
  G.currentWord = null;
  G.room = null;
  G.screen = G.teamMode === "manual" ? "entry-choice" : "entry-choice";
  render();
}

function resetAll() {
  stopTimerLoop();
  stopRoomPolling();
  stopJoinPolling();
  stopHeartbeat();
  void releaseWakeLock();
  clearSavedGame();
  const query = new URLSearchParams(location.search);
  if (query.has("room")) history.replaceState({}, "", location.pathname);
  G = initialState();
  render();
}

async function installApp() {
  if (!deferredInstallPrompt) {
    showToast("Usa el menú del navegador y selecciona “Instalar aplicación”.");
    return;
  }
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  render();
}

function registerPwa() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("/sw.js").then((registration) => {
    swRegistration = registration;
    if (registration.waiting) promptAppUpdate();
    registration.addEventListener("updatefound", () => {
      const worker = registration.installing;
      worker?.addEventListener("statechange", () => {
        if (worker.state === "installed" && navigator.serviceWorker.controller) promptAppUpdate();
      });
    });
  }).catch((error) => console.warn("Service worker", error));
  navigator.serviceWorker.addEventListener("controllerchange", () => location.reload());
}

function promptAppUpdate() {
  showToast("Hay una nueva versión de Papelitos.", "Actualizar", () => swRegistration?.waiting?.postMessage({ type: "SKIP_WAITING" }));
}

function handleClick(event) {
  let element = event.target;
  const app = document.getElementById("app");
  while (element && element !== app && !element.dataset?.action) element = element.parentElement;
  const action = element?.dataset?.action;
  if (!action || element.disabled) return;
  const id = element.dataset.id;
  const teamIndex = Number.parseInt(element.dataset.ti, 10);
  const memberIndex = Number.parseInt(element.dataset.mi, 10);

  if (action === "install-app") void installApp();
  else if (action === "join-by-code") {
    const code = String(G.joinCode || "").replace(/\D/g, "").slice(0, 6);
    if (!/^\d{6}$/.test(code)) { showToast("Introduce un código de sala de 6 dígitos."); return; }
    location.href = `/?room=${encodeURIComponent(code)}`;
  }
  else if (action === "set-team-mode") { G.teamMode = element.dataset.mode; G.manualTeams = []; render(); }
  else if (action === "add-player") { if (G.players.length < 20) G.players.push({ id: uid("player"), name: "", words: [] }); render(); }
  else if (action === "remove-player") { if (G.players.length > 4) G.players = G.players.filter((player) => player.id !== id); render(); }
  else if (action === "continue-config") {
    const error = validatePlayers();
    if (error) { showToast(error); return; }
    G.players.forEach((player) => { player.name = player.name.trim(); });
    if (G.teamMode === "manual") { prepareManualTeams(); G.screen = "manual-teams"; }
    else G.screen = "entry-choice";
    render();
  }
  else if (action === "back-config") { G.screen = "config"; render(); }
  else if (action === "back-manual-teams") { G.screen = "manual-teams"; render(); }
  else if (action === "select-member") {
    if (!G.selectedSwap) G.selectedSwap = { teamIndex, memberIndex };
    else {
      const first = G.selectedSwap;
      const firstId = G.manualTeams[first.teamIndex].playerIds[first.memberIndex];
      G.manualTeams[first.teamIndex].playerIds[first.memberIndex] = G.manualTeams[teamIndex].playerIds[memberIndex];
      G.manualTeams[teamIndex].playerIds[memberIndex] = firstId;
      G.selectedSwap = null;
    }
    render();
  }
  else if (action === "shuffle-manual") {
    const mixed = shuffle(G.players.map((player) => player.id));
    G.manualTeams.forEach((team, index) => { team.playerIds = [mixed[index * 2], mixed[index * 2 + 1]]; });
    G.selectedSwap = null;
    render();
  }
  else if (action === "confirm-manual-teams") { G.screen = "entry-choice"; render(); }
  else if (action === "choose-local") beginLocalEntry();
  else if (action === "create-room") void createRoom();
  else if (action === "submit-local-words") {
    try {
      G.players[G.localEntryIdx].words = collectWordInputs();
      G.localEntryIdx += 1;
      G.showBlank = true;
      G.error = "";
      render();
    } catch (error) { G.error = error.message; render(); }
  }
  else if (action === "next-local-player") { G.showBlank = false; render(); }
  else if (action === "finish-local-entry") prepareGameAfterWords();
  else if (action === "cancel-local-entry") { G.screen = "entry-choice"; render(); }
  else if (action === "reshuffle-random") { buildRandomTeams(); render(); }
  else if (action === "confirm-random") startGame();
  else if (action === "host-claim-player") void hostClaimPlayer(id);
  else if (action === "host-unlock-player") { event.stopPropagation(); void unlockHostPlayer(id); }
  else if (action === "submit-room-words") void submitRemoteWords("room");
  else if (action === "release-room-entry") void releaseRemoteClaim("room");
  else if (action === "close-room") void closeRoomAndPrepare();
  else if (action === "refresh-host-room") void refreshHostRoom();
  else if (action === "copy-room-link") void copyText(G.room.joinUrl);
  else if (action === "share-room") void shareRoom();
  else if (action === "leave-host-room") {
    stopRoomPolling();
    G.room = null;
    localStorage.removeItem(HOST_ROOM_KEY);
    G.screen = "entry-choice";
    render();
  }
  else if (action === "join-claim-player") void joinClaimPlayer(id);
  else if (action === "submit-join-words") void submitRemoteWords("join");
  else if (action === "release-join-entry") void releaseRemoteClaim("join");
  else if (action === "refresh-join-room") void refreshJoinRoom();
  else if (action === "retry-join-room") void loadJoinRoom(G.join.code, false);
  else if (action === "back-to-join-lobby") { G.screen = "join-lobby"; void refreshJoinRoom(true); startJoinPolling(); render(); }
  else if (action === "test-sound") { ensureAudio(); playBuzzer(); showToast("Alarma probada."); }
  else if (action === "start-turn") startTurn();
  else if (action === "guess") onGuess();
  else if (action === "pass") onPass();
  else if (action === "next-after-turn") nextAfterTurn();
  else if (action === "next-round") nextRound();
  else if (action === "restart-same-players") restartSamePlayers();
  else if (action === "reset-all") resetAll();
}

function handleInput(event) {
  const element = event.target;
  const action = element.dataset?.action;
  if (!action) return;
  if (action === "player-name") {
    const player = playerById(element.dataset.id);
    if (player) player.name = element.value;
    updateConfigValidationDom();
  } else if (action === "join-code-input") {
    G.joinCode = element.value.replace(/\D/g, "").slice(0, 6);
    if (element.value !== G.joinCode) element.value = G.joinCode;
  } else if (action === "manual-team-name") {
    const index = Number.parseInt(element.dataset.ti, 10);
    if (G.manualTeams[index]) G.manualTeams[index].name = element.value;
  } else if (action === "words-per-player") G.wordsPerPlayer = clamp(element.value, 1, 20, 5);
  else if (action === "turn-time") G.turnTime = clamp(element.value, 15, 300, 60);
  else if (action === "max-passes") G.maxPasses = clamp(element.value, 1, 20, 3);
  persist();
}

function handleChange(event) {
  const element = event.target;
  if (element.dataset?.action === "toggle-pass") {
    G.allowPass = element.checked;
    render();
  }
}

function boot() {
  document.getElementById("app")?.addEventListener("click", handleClick);
  document.getElementById("app")?.addEventListener("input", handleInput);
  document.getElementById("app")?.addEventListener("change", handleChange);

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    render();
  });
  window.addEventListener("appinstalled", () => { deferredInstallPrompt = null; showToast("Papelitos quedó instalado."); render(); });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      updateTimer();
      if (G.gamePhase === "turn-active") void requestWakeLock();
      if (G.screen === "host-room") void refreshHostRoom(true);
      if (G.screen === "join-lobby") void refreshJoinRoom(true);
    }
  });
  window.addEventListener("focus", updateTimer);
  window.addEventListener("online", () => showToast("Conexión recuperada."));
  window.addEventListener("offline", () => showToast("Sin internet. La partida local sigue funcionando."));

  const code = new URLSearchParams(location.search).get("room");
  if (code && /^\d{6}$/.test(code)) {
    G = initialState();
    G.guestMode = true;
    void loadJoinRoom(code);
  } else {
    restore();
    render();
    if (G.screen === "host-room" && G.room?.code) {
      void refreshHostRoom(true);
      startRoomPolling();
    }
    if (G.screen === "game" && G.gamePhase === "turn-active") {
      render();
      startTimerLoop();
      void requestWakeLock();
    }
  }
  registerPwa();
}

document.addEventListener("DOMContentLoaded", boot);
