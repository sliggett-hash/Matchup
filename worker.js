/*
  Match-Up Leaderboard Worker — V5
  Cloudflare Worker + D1

  Browser-submitted score numbers are NEVER trusted.
  The Worker recalculates the score from the attempt sequence and
  server-side run timing.

  Endpoints:
    POST /run
    POST /finish
    POST /submit
    GET  /leaderboard
*/

const TIME_ZONE = "America/Detroit";

const PAIRS = Object.freeze({
  A:"01",
  B:"02",
  C:"03",
  D:"04",
  E:"05",
  F:"06",
  G:"07",
  H:"08",
  I:"09",
  J:"10"
});

const BASE_CORRECT = 1000;
const STREAK_GROWTH = 1.50;
const WRONG_BASE_PENALTY = 2000;
const WRONG_PENALTY_GROWTH = 1.75;
const PERFECT_BONUS = 10000;
const SCORE_SCALE = 10;

const LIVE_TTL_MS = 30 * 60 * 1000;
const RUN_TTL_MS = 2 * 60 * 60 * 1000;
const MIN_LEADERBOARD_RUN_MS = 5000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if(request.method === "OPTIONS"){
      return corsResponse(null, 204, request, env);
    }

    try{
      assertAllowedOrigin(request, env);

      if(request.method === "POST" && url.pathname === "/run"){
        return corsResponse(
          await startRun(env),
          200,
          request,
          env
        );
      }

      if(request.method === "POST" && url.pathname === "/finish"){
        const body = await readJson(request);
        return corsResponse(
          await finishRun(env, body),
          200,
          request,
          env
        );
      }

      if(request.method === "POST" && url.pathname === "/submit"){
        const body = await readJson(request);
        return corsResponse(
          await submitScore(env, body),
          200,
          request,
          env
        );
      }

      if(request.method === "GET" && url.pathname === "/leaderboard"){
        return corsResponse(
          await getLeaderboard(env),
          200,
          request,
          env
        );
      }

      if(request.method === "GET" && url.pathname === "/health"){
        return corsResponse(
          { ok:true, version:"leaderboard-v5" },
          200,
          request,
          env
        );
      }

      return corsResponse(
        { error:"Not found." },
        404,
        request,
        env
      );
    }catch(error){
      console.error(error);

      const status =
        Number.isInteger(error.status)
          ? error.status
          : 500;

      return corsResponse(
        {
          error:
            status >= 500
              ? "Leaderboard server error."
              : error.message
        },
        status,
        request,
        env
      );
    }
  }
};

function httpError(status, message){
  const error = new Error(message);
  error.status = status;
  return error;
}

function allowedOrigin(env){
  return (
    env.ALLOWED_ORIGIN ||
    "https://sliggett-hash.github.io"
  );
}

function assertAllowedOrigin(request, env){
  const origin = request.headers.get("Origin");

  if(!origin){
    return;
  }

  const allowed = allowedOrigin(env);

  if(origin === allowed){
    return;
  }

  // Helpful for local teacher testing.
  if(
    origin.startsWith("http://localhost:") ||
    origin.startsWith("http://127.0.0.1:")
  ){
    return;
  }

  throw httpError(403, "Origin not allowed.");
}

function corsResponse(data, status, request, env){
  const origin = request.headers.get("Origin");
  const allowed = allowedOrigin(env);

  let responseOrigin = allowed;

  if(
    origin &&
    (
      origin === allowed ||
      origin.startsWith("http://localhost:") ||
      origin.startsWith("http://127.0.0.1:")
    )
  ){
    responseOrigin = origin;
  }

  const headers = new Headers({
    "Access-Control-Allow-Origin":responseOrigin,
    "Access-Control-Allow-Methods":"GET,POST,OPTIONS",
    "Access-Control-Allow-Headers":"Content-Type",
    "Cache-Control":"no-store",
    "Vary":"Origin"
  });

  if(status === 204){
    return new Response(null, { status, headers });
  }

  headers.set("Content-Type", "application/json; charset=utf-8");

  return new Response(
    JSON.stringify(data),
    { status, headers }
  );
}

async function readJson(request){
  try{
    return await request.json();
  }catch{
    throw httpError(400, "Invalid JSON.");
  }
}

function dayKey(nowMs = Date.now()){
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone:TIME_ZONE,
    year:"numeric",
    month:"2-digit",
    day:"2-digit"
  }).formatToParts(new Date(nowMs));

  const values = {};

  for(const part of parts){
    if(part.type !== "literal"){
      values[part.type] = part.value;
    }
  }

  return `${values.year}-${values.month}-${values.day}`;
}

function calculateAccuracy(matches, mistakes){
  const attempts = matches + mistakes;

  if(attempts === 0){
    return 100;
  }

  return (matches / attempts) * 100;
}

function accuracyMultiplier(accuracy){
  const a = accuracy / 100;
  return 1 + 2 * Math.pow(a, 10);
}

function speedMultiplier(elapsedMs){
  return 1 + 2 * Math.exp(-(elapsedMs / 1000) / 90);
}

function correctPointsFor(streak){
  const value =
    BASE_CORRECT *
    Math.pow(STREAK_GROWTH, streak - 1);

  return Math.round(value / 10) * 10;
}

function wrongPenaltyFor(mistakeNumber){
  const value =
    WRONG_BASE_PENALTY *
    Math.pow(
      WRONG_PENALTY_GROWTH,
      mistakeNumber - 1
    );

  return Math.round(value / 10) * 10;
}

function calculateRun(attempts, elapsedMs){
  if(!Array.isArray(attempts)){
    throw httpError(400, "Attempts are required.");
  }

  if(attempts.length < 10 || attempts.length > 100){
    throw httpError(400, "Invalid number of attempts.");
  }

  const matchedDefinitions = new Set();
  const matchedImages = new Set();

  let matches = 0;
  let mistakes = 0;
  let currentStreak = 0;
  let bestStreak = 0;
  let rawScore = 0;

  for(const attempt of attempts){
    if(
      !attempt ||
      typeof attempt.definition !== "string" ||
      typeof attempt.image !== "string"
    ){
      throw httpError(400, "Invalid attempt data.");
    }

    const definition = attempt.definition;
    const image = attempt.image;

    if(!(definition in PAIRS)){
      throw httpError(400, "Invalid definition.");
    }

    if(!Object.values(PAIRS).includes(image)){
      throw httpError(400, "Invalid image.");
    }

    // The real UI does not permit matched cards to be used again.
    if(
      matchedDefinitions.has(definition) ||
      matchedImages.has(image)
    ){
      throw httpError(
        400,
        "Attempt sequence is not valid."
      );
    }

    const correct = PAIRS[definition] === image;

    if(correct){
      matches += 1;
      currentStreak += 1;
      bestStreak = Math.max(
        bestStreak,
        currentStreak
      );

      rawScore +=
        correctPointsFor(currentStreak);

      matchedDefinitions.add(definition);
      matchedImages.add(image);
    }else{
      mistakes += 1;
      currentStreak = 0;

      rawScore = Math.max(
        0,
        rawScore - wrongPenaltyFor(mistakes)
      );
    }
  }

  if(
    matches !== 10 ||
    matchedDefinitions.size !== 10 ||
    matchedImages.size !== 10
  ){
    throw httpError(
      400,
      "A completed run must contain all 10 matches."
    );
  }

  const accuracy =
    calculateAccuracy(matches, mistakes);

  const accMultiplier =
    accuracyMultiplier(accuracy);

  const timeMultiplier =
    speedMultiplier(elapsedMs);

  const perfectBonus =
    mistakes === 0
      ? PERFECT_BONUS
      : 0;

  const score =
    Math.floor(
      Math.max(0, rawScore + perfectBonus) *
      accMultiplier *
      timeMultiplier *
      SCORE_SCALE
    );

  return {
    matches,
    mistakes,
    bestStreak,
    rawScore,
    accuracy,
    accuracyMultiplier:accMultiplier,
    speedMultiplier:timeMultiplier,
    score
  };
}

async function startRun(env){
  const now = Date.now();
  const runId = crypto.randomUUID();

  await env.DB.prepare(`
    INSERT INTO runs (
      id,
      started_at,
      completed,
      submitted
    )
    VALUES (?, ?, 0, 0)
  `)
    .bind(runId, now)
    .run();

  return {
    runId,
    startedAt:now
  };
}

async function finishRun(env, body){
  const runId =
    typeof body?.runId === "string"
      ? body.runId
      : "";

  if(!runId){
    throw httpError(400, "Run ID is required.");
  }

  const run = await env.DB.prepare(`
    SELECT *
    FROM runs
    WHERE id = ?
  `)
    .bind(runId)
    .first();

  if(!run){
    throw httpError(404, "Run not found.");
  }

  if(run.completed){
    return publicRunResult(run);
  }

  const now = Date.now();

  if(now - run.started_at > RUN_TTL_MS){
    throw httpError(
      400,
      "This run expired. Start a new game."
    );
  }

  const elapsedMs =
    Math.max(
      1,
      now - Number(run.started_at)
    );

  const result =
    calculateRun(body.attempts, elapsedMs);

  const leaderboardEligible =
    elapsedMs >= MIN_LEADERBOARD_RUN_MS
      ? 1
      : 0;

  await env.DB.prepare(`
    UPDATE runs
    SET
      finished_at = ?,
      elapsed_ms = ?,
      matches = ?,
      mistakes = ?,
      best_streak = ?,
      raw_score = ?,
      accuracy = ?,
      accuracy_multiplier = ?,
      speed_multiplier = ?,
      score = ?,
      leaderboard_eligible = ?,
      completed = 1
    WHERE id = ?
  `)
    .bind(
      now,
      elapsedMs,
      result.matches,
      result.mistakes,
      result.bestStreak,
      result.rawScore,
      result.accuracy,
      result.accuracyMultiplier,
      result.speedMultiplier,
      result.score,
      leaderboardEligible,
      runId
    )
    .run();

  return {
    runId,
    elapsedMs,
    ...result,
    leaderboardEligible:
      Boolean(leaderboardEligible)
  };
}

function publicRunResult(run){
  return {
    runId:run.id,
    elapsedMs:Number(run.elapsed_ms),
    matches:Number(run.matches),
    mistakes:Number(run.mistakes),
    bestStreak:Number(run.best_streak),
    rawScore:Number(run.raw_score),
    accuracy:Number(run.accuracy),
    accuracyMultiplier:
      Number(run.accuracy_multiplier),
    speedMultiplier:
      Number(run.speed_multiplier),
    score:Number(run.score),
    leaderboardEligible:
      Boolean(run.leaderboard_eligible)
  };
}

function cleanName(value){
  if(typeof value !== "string"){
    throw httpError(
      400,
      "A display name is required."
    );
  }

  const name =
    value
      .trim()
      .replace(/\s+/g, " ");

  if(name.length < 2 || name.length > 20){
    throw httpError(
      400,
      "Use first name + last initial, 20 characters maximum."
    );
  }

  if(!/^[A-Za-zÀ-ÖØ-öø-ÿ'’.\- ]+$/.test(name)){
    throw httpError(
      400,
      "Name contains unsupported characters."
    );
  }

  return name;
}

function betterThan(a, b){
  if(!b){
    return true;
  }

  if(Number(a.score) !== Number(b.score)){
    return Number(a.score) > Number(b.score);
  }

  if(Number(a.elapsed_ms) !== Number(b.elapsed_ms)){
    return Number(a.elapsed_ms) < Number(b.elapsed_ms);
  }

  if(Number(a.mistakes) !== Number(b.mistakes)){
    return Number(a.mistakes) < Number(b.mistakes);
  }

  return Number(a.submitted_at) < Number(b.submitted_at);
}

async function submitScore(env, body){
  const runId =
    typeof body?.runId === "string"
      ? body.runId
      : "";

  const displayName =
    cleanName(body?.displayName);

  if(!runId){
    throw httpError(400, "Run ID is required.");
  }

  const run = await env.DB.prepare(`
    SELECT *
    FROM runs
    WHERE id = ?
  `)
    .bind(runId)
    .first();

  if(!run){
    throw httpError(404, "Run not found.");
  }

  if(!run.completed){
    throw httpError(
      400,
      "The game is not finished."
    );
  }

  if(!run.leaderboard_eligible){
    throw httpError(
      400,
      "This run is not eligible for the leaderboard."
    );
  }

  if(run.submitted){
    throw httpError(
      409,
      "This run was already submitted."
    );
  }

  const now = Date.now();
  const expiresAt = now + LIVE_TTL_MS;
  const today = dayKey(now);

  await cleanup(env, now, today);

  const insert = await env.DB.prepare(`
    INSERT INTO scores (
      run_id,
      display_name,
      score,
      raw_score,
      mistakes,
      best_streak,
      accuracy,
      elapsed_ms,
      submitted_at,
      expires_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
    .bind(
      runId,
      displayName,
      Number(run.score),
      Number(run.raw_score),
      Number(run.mistakes),
      Number(run.best_streak),
      Number(run.accuracy),
      Number(run.elapsed_ms),
      now,
      expiresAt
    )
    .run();

  const scoreId =
    Number(insert.meta.last_row_id);

  const newScore = await env.DB.prepare(`
    SELECT *
    FROM scores
    WHERE id = ?
  `)
    .bind(scoreId)
    .first();

  await env.DB.prepare(`
    UPDATE runs
    SET submitted = 1
    WHERE id = ?
  `)
    .bind(runId)
    .run();

  // ----- Daily champion -----
  const championRow =
    await env.DB.prepare(`
      SELECT
        dc.score_id,
        s.*
      FROM daily_champions dc
      JOIN scores s
        ON s.id = dc.score_id
      WHERE dc.day_key = ?
    `)
      .bind(today)
      .first();

  let isDailyChampion = false;

  if(!championRow || betterThan(newScore, championRow)){
    if(championRow){
      // A dethroned champion gets a fresh 30-minute life.
      await env.DB.prepare(`
        UPDATE scores
        SET expires_at = ?
        WHERE id = ?
      `)
        .bind(
          now + LIVE_TTL_MS,
          Number(championRow.id)
        )
        .run();
    }

    await env.DB.prepare(`
      INSERT INTO daily_champions (
        day_key,
        score_id
      )
      VALUES (?, ?)
      ON CONFLICT(day_key)
      DO UPDATE SET
        score_id = excluded.score_id
    `)
      .bind(today, scoreId)
      .run();

    isDailyChampion = true;
  }

  // ----- Permanent all-time record -----
  const allTime =
    await env.DB.prepare(`
      SELECT *
      FROM all_time_record
      WHERE id = 1
    `)
      .first();

  const candidateForRecord = {
    ...newScore
  };

  let isAllTimeRecord = false;

  if(
    !allTime ||
    Number(candidateForRecord.score) > Number(allTime.score) ||
    (
      Number(candidateForRecord.score) === Number(allTime.score) &&
      Number(candidateForRecord.elapsed_ms) < Number(allTime.elapsed_ms)
    )
  ){
    await env.DB.prepare(`
      INSERT INTO all_time_record (
        id,
        display_name,
        score,
        raw_score,
        mistakes,
        best_streak,
        accuracy,
        elapsed_ms,
        achieved_at
      )
      VALUES (
        1, ?, ?, ?, ?, ?, ?, ?, ?
      )
      ON CONFLICT(id)
      DO UPDATE SET
        display_name = excluded.display_name,
        score = excluded.score,
        raw_score = excluded.raw_score,
        mistakes = excluded.mistakes,
        best_streak = excluded.best_streak,
        accuracy = excluded.accuracy,
        elapsed_ms = excluded.elapsed_ms,
        achieved_at = excluded.achieved_at
    `)
      .bind(
        displayName,
        Number(run.score),
        Number(run.raw_score),
        Number(run.mistakes),
        Number(run.best_streak),
        Number(run.accuracy),
        Number(run.elapsed_ms),
        now
      )
      .run();

    isAllTimeRecord = true;
  }

  const leaderboard =
    await getLeaderboard(env);

  const rankIndex =
    leaderboard.top10.findIndex(
      item => item.id === scoreId
    );

  return {
    ok:true,
    score:Number(run.score),
    isDailyChampion,
    isAllTimeRecord,
    rank:
      rankIndex >= 0
        ? rankIndex + 1
        : null
  };
}

async function cleanup(env, now = Date.now(), today = dayKey(now)){
  /*
    Yesterday's #1 must disappear at the end of the day even if it was
    posted less than 30 minutes before midnight.

    First mark old champions as expired, then remove their champion
    pointers. The normal expired-score cleanup below can then safely
    delete those score rows without violating the foreign-key relation.
  */
  await env.DB.prepare(`
    UPDATE scores
    SET expires_at = ?
    WHERE id IN (
      SELECT score_id
      FROM daily_champions
      WHERE day_key <> ?
    )
  `)
    .bind(now, today)
    .run();

  await env.DB.prepare(`
    DELETE FROM daily_champions
    WHERE day_key <> ?
  `)
    .bind(today)
    .run();

  const champion =
    await env.DB.prepare(`
      SELECT score_id
      FROM daily_champions
      WHERE day_key = ?
    `)
      .bind(today)
      .first();

  const championId =
    champion
      ? Number(champion.score_id)
      : -1;

  // All non-champion live scores expire after 30 minutes.
  await env.DB.prepare(`
    DELETE FROM scores
    WHERE expires_at <= ?
      AND id <> ?
  `)
    .bind(now, championId)
    .run();

  // Old unfinished/unused run records can disappear.
  await env.DB.prepare(`
    DELETE FROM runs
    WHERE started_at <= ?
      AND submitted = 0
  `)
    .bind(now - RUN_TTL_MS)
    .run();
}

function publicScore(row, isChampion = false){
  return {
    id:Number(row.id),
    displayName:row.display_name,
    score:Number(row.score),
    rawScore:Number(row.raw_score),
    mistakes:Number(row.mistakes),
    bestStreak:Number(row.best_streak),
    accuracy:Number(row.accuracy),
    elapsedMs:Number(row.elapsed_ms),
    submittedAt:Number(row.submitted_at),
    isChampion
  };
}

async function getLeaderboard(env){
  const now = Date.now();
  const today = dayKey(now);

  await cleanup(env, now, today);

  const champ = await env.DB.prepare(`
    SELECT
      s.*
    FROM daily_champions dc
    JOIN scores s
      ON s.id = dc.score_id
    WHERE dc.day_key = ?
  `)
    .bind(today)
    .first();

  const champId =
    champ
      ? Number(champ.id)
      : -1;

  const live = await env.DB.prepare(`
    SELECT *
    FROM scores
    WHERE expires_at > ?
      AND id <> ?
    ORDER BY
      score DESC,
      elapsed_ms ASC,
      mistakes ASC,
      submitted_at ASC
    LIMIT 9
  `)
    .bind(now, champId)
    .all();

  const top10 = [];

  if(champ){
    top10.push(
      publicScore(champ, true)
    );
  }

  for(const row of live.results || []){
    top10.push(
      publicScore(row, false)
    );
  }

  const allTime =
    await env.DB.prepare(`
      SELECT *
      FROM all_time_record
      WHERE id = 1
    `)
      .first();

  return {
    dayKey:today,
    allTime:
      allTime
        ? {
            displayName:allTime.display_name,
            score:Number(allTime.score),
            rawScore:Number(allTime.raw_score),
            mistakes:Number(allTime.mistakes),
            bestStreak:Number(allTime.best_streak),
            accuracy:Number(allTime.accuracy),
            elapsedMs:Number(allTime.elapsed_ms),
            achievedAt:Number(allTime.achieved_at)
          }
        : null,
    todayChampion:
      champ
        ? publicScore(champ, true)
        : null,
    top10
  };
}
