import { getStore } from "@netlify/blobs";
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

const store = getStore({ name: "papelitos-rooms", consistency: "strong" });
const ROOM_LIFETIME_MS = 12 * 60 * 60 * 1000;
const CLAIM_LIFETIME_MS = 10 * 60 * 1000;
const MAX_PLAYERS = 20;
const MAX_WORD_LENGTH = 80;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    }
  });
}

function cleanText(value, max = 60) {
  return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, max);
}

function token() {
  return randomBytes(24).toString("base64url");
}

function hash(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function safeHashEqual(value, expectedHash) {
  if (!value || !expectedHash) return false;
  const actual = Buffer.from(hash(value), "utf8");
  const expected = Buffer.from(expectedHash, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function roomKey(code) { return `rooms/${code}/room`; }
function playerKey(code, playerId) { return `rooms/${code}/players/${playerId}`; }

async function readRoom(code) {
  const entry = await store.getWithMetadata(roomKey(code), { type: "json", consistency: "strong" });
  if (!entry) return null;
  const room = entry.data;
  if (!room) return null;
  if (room.expiresAt <= Date.now()) {
    await Promise.all([
      store.delete(roomKey(code)),
      ...room.players.map((player) => store.delete(playerKey(code, player.id)))
    ]);
    return { expired: true, entry };
  }
  return { room, entry };
}

function publicStatus(state) {
  if (!state) return "available";
  if (state.status === "submitted") return "ready";
  if (state.status === "writing" && Number(state.claimExpiresAt) > Date.now()) return "writing";
  return "available";
}

async function publicRoom(room) {
  const stateEntries = await Promise.all(
    room.players.map((player) => store.get(playerKey(room.code, player.id), { type: "json", consistency: "strong" }))
  );
  const players = room.players.map((player, index) => ({
    id: player.id,
    name: player.name,
    status: publicStatus(stateEntries[index])
  }));
  return {
    code: room.code,
    createdAt: room.createdAt,
    expiresAt: room.expiresAt,
    closed: Boolean(room.closed),
    wordsPerPlayer: room.wordsPerPlayer,
    teamMode: room.teamMode,
    players,
    readyCount: players.filter((player) => player.status === "ready").length
  };
}

function validateCreate(body) {
  const players = Array.isArray(body?.players)
    ? body.players.map((player) => ({ id: cleanText(player?.id, 48), name: cleanText(player?.name, 40) }))
    : [];

  if (players.length < 4 || players.length > MAX_PLAYERS || players.length % 2 !== 0) {
    return { error: "La sala necesita un número par de jugadores, entre 4 y 20." };
  }
  if (players.some((player) => !/^[a-zA-Z0-9_-]{6,48}$/.test(player.id) || !player.name)) {
    return { error: "Hay jugadores con datos incompletos o inválidos." };
  }
  const ids = new Set(players.map((player) => player.id));
  const names = new Set(players.map((player) => player.name.toLocaleLowerCase("es")));
  if (ids.size !== players.length || names.size !== players.length) {
    return { error: "Los nombres de los jugadores no pueden repetirse." };
  }

  const wordsPerPlayer = Math.max(1, Math.min(20, Number.parseInt(body?.wordsPerPlayer, 10) || 5));
  const teamMode = body?.teamMode === "manual" ? "manual" : "random";
  let manualTeams = [];

  if (teamMode === "manual") {
    manualTeams = Array.isArray(body?.manualTeams)
      ? body.manualTeams.map((team, index) => ({
          id: cleanText(team?.id, 48) || `team-${index + 1}`,
          name: cleanText(team?.name, 40) || `Equipo ${index + 1}`,
          playerIds: Array.isArray(team?.playerIds) ? team.playerIds.map((id) => cleanText(id, 48)) : []
        }))
      : [];
    const assigned = manualTeams.flatMap((team) => team.playerIds);
    if (manualTeams.length !== players.length / 2 || manualTeams.some((team) => team.playerIds.length !== 2)) {
      return { error: "Los equipos manuales deben tener exactamente dos jugadores." };
    }
    if (new Set(assigned).size !== players.length || assigned.some((id) => !ids.has(id))) {
      return { error: "Cada jugador debe aparecer una sola vez en los equipos manuales." };
    }
  }

  return { players, wordsPerPlayer, teamMode, manualTeams };
}

async function createRoom(body) {
  const valid = validateCreate(body);
  if (valid.error) return json({ error: valid.error }, 400);

  const adminToken = token();
  const now = Date.now();
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const code = String(randomInt(100000, 1000000));
    const room = {
      code,
      createdAt: now,
      expiresAt: now + ROOM_LIFETIME_MS,
      closed: false,
      adminTokenHash: hash(adminToken),
      players: valid.players,
      wordsPerPlayer: valid.wordsPerPlayer,
      teamMode: valid.teamMode,
      manualTeams: valid.manualTeams
    };
    const result = await store.setJSON(roomKey(code), room, {
      onlyIfNew: true,
      metadata: { expiration: room.expiresAt }
    });
    if (result.modified) {
      return json({
        code,
        adminToken,
        expiresAt: room.expiresAt,
        joinPath: `/?room=${code}`
      }, 201);
    }
  }
  return json({ error: "No se pudo generar una sala. Inténtalo nuevamente." }, 503);
}

async function claimPlayer(room, playerId, body) {
  if (room.closed) return json({ error: "La sala ya está cerrada." }, 409);
  const player = room.players.find((item) => item.id === playerId);
  if (!player) return json({ error: "Jugador no encontrado." }, 404);
  const deviceId = cleanText(body?.deviceId, 80);
  if (!deviceId) return json({ error: "No se pudo identificar este dispositivo." }, 400);

  const key = playerKey(room.code, playerId);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = await store.getWithMetadata(key, { type: "json", consistency: "strong" });
    const state = current?.data;
    if (state?.status === "submitted") return json({ error: "Este jugador ya envió sus palabras." }, 409);
    if (state?.status === "writing" && state.claimExpiresAt > Date.now() && state.deviceId !== deviceId) {
      return json({ error: "Este jugador ya está escribiendo en otro teléfono." }, 409);
    }

    const claimToken = token();
    const next = {
      playerId,
      status: "writing",
      deviceId,
      claimTokenHash: hash(claimToken),
      claimExpiresAt: Date.now() + CLAIM_LIFETIME_MS,
      updatedAt: Date.now()
    };
    const result = await store.setJSON(key, next, current
      ? { onlyIfMatch: current.etag, metadata: { expiration: room.expiresAt } }
      : { onlyIfNew: true, metadata: { expiration: room.expiresAt } });
    if (result.modified) {
      return json({ player: { id: player.id, name: player.name }, claimToken, claimExpiresAt: next.claimExpiresAt });
    }
  }
  return json({ error: "La tarjeta cambió mientras la seleccionabas. Inténtalo otra vez." }, 409);
}

async function heartbeat(room, playerId, body) {
  const key = playerKey(room.code, playerId);
  const current = await store.getWithMetadata(key, { type: "json", consistency: "strong" });
  if (!current || current.data?.status !== "writing" || !safeHashEqual(body?.claimToken, current.data.claimTokenHash)) {
    return json({ error: "La reserva de este jugador ya no es válida." }, 409);
  }
  const next = { ...current.data, claimExpiresAt: Date.now() + CLAIM_LIFETIME_MS, updatedAt: Date.now() };
  const result = await store.setJSON(key, next, { onlyIfMatch: current.etag, metadata: { expiration: room.expiresAt } });
  if (!result.modified) return json({ error: "No se pudo renovar la reserva." }, 409);
  return json({ claimExpiresAt: next.claimExpiresAt });
}

async function releasePlayer(room, playerId, body) {
  const key = playerKey(room.code, playerId);
  const current = await store.getWithMetadata(key, { type: "json", consistency: "strong" });
  if (!current) return json({ ok: true });
  if (current.data?.status === "submitted") return json({ error: "Las palabras ya fueron enviadas." }, 409);
  if (!safeHashEqual(body?.claimToken, current.data?.claimTokenHash)) return json({ error: "Reserva inválida." }, 403);

  const result = await store.setJSON(key, {
    playerId,
    status: "available",
    updatedAt: Date.now()
  }, { onlyIfMatch: current.etag, metadata: { expiration: room.expiresAt } });
  if (!result.modified) return json({ error: "La tarjeta cambió. Actualiza la sala." }, 409);
  return json({ ok: true });
}

async function submitWords(room, playerId, body) {
  if (room.closed) return json({ error: "La sala ya está cerrada." }, 409);
  const player = room.players.find((item) => item.id === playerId);
  if (!player) return json({ error: "Jugador no encontrado." }, 404);
  const words = Array.isArray(body?.words) ? body.words.map((word) => cleanText(word, MAX_WORD_LENGTH)) : [];
  if (words.length !== room.wordsPerPlayer || words.some((word) => !word)) {
    return json({ error: `Debes completar exactamente ${room.wordsPerPlayer} palabras.` }, 400);
  }

  const key = playerKey(room.code, playerId);
  const current = await store.getWithMetadata(key, { type: "json", consistency: "strong" });
  if (current?.data?.status === "submitted") return json({ ok: true, count: current.data.words?.length || room.wordsPerPlayer });
  if (!current || current.data?.status !== "writing" || !safeHashEqual(body?.claimToken, current.data.claimTokenHash)) {
    return json({ error: "La reserva expiró. Vuelve a seleccionar tu nombre." }, 409);
  }

  const next = {
    playerId,
    status: "submitted",
    words,
    submittedAt: Date.now(),
    updatedAt: Date.now()
  };
  const result = await store.setJSON(key, next, { onlyIfMatch: current.etag, metadata: { expiration: room.expiresAt } });
  if (!result.modified) return json({ error: "No se pudieron guardar las palabras. Inténtalo nuevamente." }, 409);
  return json({ ok: true, count: words.length });
}

async function unlockPlayer(room, playerId, body) {
  if (!safeHashEqual(body?.adminToken, room.adminTokenHash)) return json({ error: "Acceso de anfitrión inválido." }, 403);
  const key = playerKey(room.code, playerId);
  const current = await store.getWithMetadata(key, { type: "json", consistency: "strong" });
  if (!current) return json({ ok: true });
  if (current.data?.status === "submitted") return json({ error: "Este jugador ya envió sus palabras." }, 409);
  const result = await store.setJSON(key, {
    playerId,
    status: "available",
    updatedAt: Date.now()
  }, { onlyIfMatch: current.etag, metadata: { expiration: room.expiresAt } });
  if (!result.modified) return json({ error: "El estado cambió. Actualiza la sala." }, 409);
  return json({ ok: true });
}

async function closeRoom(roomResult, body) {
  const { room, entry } = roomResult;
  if (!safeHashEqual(body?.adminToken, room.adminTokenHash)) return json({ error: "Acceso de anfitrión inválido." }, 403);

  const states = await Promise.all(
    room.players.map((player) => store.get(playerKey(room.code, player.id), { type: "json", consistency: "strong" }))
  );
  const missing = room.players.filter((player, index) => states[index]?.status !== "submitted").map((player) => player.name);
  if (missing.length) return json({ error: "Todavía faltan jugadores.", missing }, 409);

  if (!room.closed) {
    const closedRoom = { ...room, closed: true, closedAt: Date.now() };
    const result = await store.setJSON(roomKey(room.code), closedRoom, {
      onlyIfMatch: entry.etag,
      metadata: { expiration: room.expiresAt }
    });
    if (!result.modified) return json({ error: "La sala cambió. Actualiza e inténtalo nuevamente." }, 409);
  }

  return json({
    ok: true,
    teamMode: room.teamMode,
    manualTeams: room.manualTeams,
    submissions: room.players.map((player, index) => ({
      playerId: player.id,
      words: states[index].words
    }))
  });
}

export default async function handler(req) {
  try {
    if (req.method === "OPTIONS") return new Response(null, { status: 204 });
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const code = parts[2] || "";
    const action = parts[3] || "";
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};

    if (req.method === "POST" && !code) return createRoom(body);

    if (!/^\d{6}$/.test(code)) return json({ error: "Código de sala inválido." }, 400);
    const roomResult = await readRoom(code);
    if (!roomResult) return json({ error: "Sala no encontrada." }, 404);
    if (roomResult.expired) return json({ error: "Esta sala expiró." }, 410);

    if (req.method === "GET" && !action) return json(await publicRoom(roomResult.room));
    if (req.method !== "POST") return json({ error: "Método no permitido." }, 405);

    const resolvedPlayerId = cleanText(body.playerId, 48);
    if (action === "claim") return claimPlayer(roomResult.room, resolvedPlayerId, body);
    if (action === "heartbeat") return heartbeat(roomResult.room, resolvedPlayerId, body);
    if (action === "release") return releasePlayer(roomResult.room, resolvedPlayerId, body);
    if (action === "submit") return submitWords(roomResult.room, resolvedPlayerId, body);
    if (action === "unlock") return unlockPlayer(roomResult.room, resolvedPlayerId, body);
    if (action === "close") return closeRoom(roomResult, body);

    return json({ error: "Ruta no encontrada." }, 404);
  } catch (error) {
    console.error("Papelitos rooms error", error);
    return json({ error: "Ocurrió un error en la sala. Inténtalo nuevamente." }, 500);
  }
}

export const config = {
  path: ["/api/rooms", "/api/rooms/*"]
};
