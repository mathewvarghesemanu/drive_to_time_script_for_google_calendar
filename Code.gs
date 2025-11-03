/** ------------------------------------------------------------
 * Auto "Drive to ..." blocks before events with locations
 * - Polling-first (reliable) with optional event trigger
 * - Traffic-aware ETA (Distance Matrix, best_guess)
 * - Idempotent updates and safe deletes (only our helper events)
 *
 * SCRIPT PROPERTIES (Project Settings → Script properties):
 *   HOME_ADDRESS         -> "123 Main St, San Jose, CA"
 *   BUFFER_MINUTES       -> "10"
 *   WATCH_CALENDAR_ID    -> "primary" or calendar ID
 *   GOOGLE_MAPS_API_KEY  -> Distance Matrix API key (billing)
 *   SCAN_LOOKAHEAD_HOURS -> "48" (default 48h)
 *   LOG_LEVEL            -> "ERROR" | "WARN" | "INFO" | "DEBUG" (default INFO)
 *
 * Services:
 *   - Apps Script: Services (puzzle) → + → Calendar API (Advanced)
 *   - GCP Console: enable "Google Calendar API" + "Maps Distance Matrix API"
 * ------------------------------------------------------------ */

// ---------- Logging helpers ----------
const PROPS = PropertiesService.getScriptProperties();

const LOG_LEVELS = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };
function getLogLevel_() {
  const lvl = (PROPS.getProperty('LOG_LEVEL') || 'INFO').toUpperCase();
  return LOG_LEVELS[lvl] ?? LOG_LEVELS.INFO;
}
function mask_(s, keep = 4) {
  if (!s) return s;
  const str = String(s);
  return str.length <= keep ? '****' : `${str.slice(0, keep)}****`;
}
function nowIso_() { return new Date().toISOString(); }
function durMs_(t0) { return new Date().getTime() - t0; }
function slog_(level, msg, ctx) {
  const want = getLogLevel_();
  if (LOG_LEVELS[level] > want) return;
  const payload = ctx ? ` ${JSON.stringify(ctx)}` : '';
  const line = `[${nowIso_()}] [${level}] ${msg}${payload}`;
  if (level === 'ERROR') console.error(line);
  else if (level === 'WARN') console.warn(line);
  else console.log(line);
}
const logE = (m, c) => slog_('ERROR', m, c);
const logW = (m, c) => slog_('WARN',  m, c);
const logI = (m, c) => slog_('INFO',  m, c);
const logD = (m, c) => slog_('DEBUG', m, c);

// ---------- Utils ----------
function getProp_(key, fallback = '') {
  const v = PROPS.getProperty(key);
  return (v == null ? fallback : String(v)).trim();
}
function minutes_(n) { return n * 60 * 1000; }
function hours_(n)   { return n * 60 * 60 * 1000; }

// Run once if you get odd auth errors (forces scopes)
function authKickstart() {
  logI('authKickstart: requesting CalendarApp scope');
  CalendarApp.getDefaultCalendar();
  logI('authKickstart: done');
}

// ---------- Setup / Triggers ----------
function setup() {
  const t0 = new Date().getTime();
  logI('setup: starting');

  // Clean old triggers
  const old = ScriptApp.getProjectTriggers();
  old.forEach(t => ScriptApp.deleteTrigger(t));
  logI('setup: cleared existing triggers', { removed: old.length });

  const calId = getProp_('WATCH_CALENDAR_ID', 'primary');
  logI('setup: using calendar', { calendarId: calId });

  // Try to install event-updated trigger (optional, can fail)
  try {
    ScriptApp.newTrigger('onCalChange_')
      .forUserCalendar(calId)
      .onEventUpdated()
      .create();
    logI('setup: onEventUpdated trigger installed');
  } catch (e) {
    logW('setup: onEventUpdated not installed; using polling only', { reason: String(e && e.message) });
  }

  // Always install polling
  ScriptApp.newTrigger('scanUpcoming_').timeBased().everyMinutes(5).create();
  ScriptApp.newTrigger('scanUpcoming_').timeBased().everyHours(1).create();
  logI('setup: polling triggers installed', { everyMinutes: 5, everyHours: 1 });

  logI('setup: complete', { durationMs: durMs_(t0) });
}

function myFunction() { setup(); }

// ---------- Trigger handlers ----------
function onCalChange_(e) {
  const t0 = new Date().getTime();
  try {
    logI('onCalChange_: event', { hasEvent: !!e, calendarId: e?.calendarId, eventId: e?.id });
    if (!e || !e.calendarId || !e.id) return;
    handleEventById_(e.calendarId, e.id);
  } catch (err) {
    logE('onCalChange_: error', { error: String(err && err.message), stack: String(err && err.stack) });
  } finally {
    logD('onCalChange_: done', { durationMs: durMs_(t0) });
  }
}

function scanUpcoming_() {
  const calIds = getProp_('WATCH_CALENDAR_ID', 'primary')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  const lookaheadH = parseInt(getProp_('SCAN_LOOKAHEAD_HOURS', '48'), 10) || 48;
  const now = new Date();
  const maxT = new Date(now.getTime() + hours_(lookaheadH));

  for (const calId of calIds) {
    try {
      const resp = Calendar.Events.list(calId, {
        timeMin: now.toISOString(),
        timeMax: maxT.toISOString(),
        singleEvents: true,
        maxResults: 250,
        orderBy: 'startTime'
      });
      const items = resp.items || [];
      logI('scanUpcoming_: fetched events', { calendarId: calId, count: items.length });

      items.forEach(ev => {
        try { ensureDriveBlock_(calId, ev); }
        catch (e) { logW('scanUpcoming_: ensureDriveBlock error', { calendarId: calId, eventId: ev.id, error: String(e.message) }); }
      });
    } catch (e) {
      logE('scanUpcoming_: list failed', { calendarId: calId, error: String(e.message) });
    }
  }
}

// ---------- Core flow ----------
function handleEventById_(calId, eventId) {
  const t0 = new Date().getTime();
  logD('handleEventById_: fetching', { calendarId: calId, eventId });
  const ev = Calendar.Events.get(calId, eventId);
  if (!ev) {
    logW('handleEventById_: event not found', { eventId });
    return;
  }
  if (ev.status === 'cancelled') {
    logI('handleEventById_: event cancelled, removing drive block', { eventId });
    removeDriveBlockFor_(calId, eventId);
    return;
  }
  ensureDriveBlock_(calId, ev);
  logD('handleEventById_: done', { durationMs: durMs_(t0) });
}

function ensureDriveBlock_(calId, ev) {
  const t0 = new Date().getTime();
  const home = getProp_('HOME_ADDRESS');
  const apiKey = getProp_('GOOGLE_MAPS_API_KEY');
  const bufferMin = parseInt(getProp_('BUFFER_MINUTES', '10'), 10);

  logD('ensureDriveBlock_: start', {
    eventId: ev.id,
    summary: ev.summary,
    location: ev.location,
    home,
    bufferMin,
    apiKeyMasked: mask_(apiKey)
  });

  if (!home || !apiKey) {
    logW('ensureDriveBlock_: missing HOME_ADDRESS or GOOGLE_MAPS_API_KEY');
    return;
  }

  const start = ev.start?.dateTime ? new Date(ev.start.dateTime) : null;
  if (!start) {
    logD('ensureDriveBlock_: skipping all-day or no start-time event', { eventId: ev.id });
    return;
  }

  const loc = (ev.location || '').trim();
  if (!loc || /^https?:\/\//i.test(loc)) {
    logI('ensureDriveBlock_: no physical location -> remove prior drive block if any', { eventId: ev.id, location: ev.location });
    removeDriveBlockFor_(calId, ev.id);
    return;
  }

  // Compute drive window
  const bufferMs = minutes_(bufferMin);
  const driveEnd = new Date(start.getTime() - bufferMs);
  logD('ensureDriveBlock_: computing duration', { driveEnd: driveEnd.toISOString() });

  const durMs = getDrivingDurationMs_(home, loc, driveEnd);
  if (durMs == null) {
    logW('ensureDriveBlock_: duration unavailable, skipping', { eventId: ev.id, location: loc });
    return;
  }
  const driveStart = new Date(driveEnd.getTime() - durMs);
  if (driveStart >= driveEnd) {
    logW('ensureDriveBlock_: bad window (start >= end), skipping', { driveStart: driveStart.toISOString(), driveEnd: driveEnd.toISOString(), durMs });
    return;
  }

  const existing = findDriveBlockFor_(calId, ev.id, new Date(driveStart.getTime() - hours_(2)), start);
  const driveSummary = `Drive to ${shortPlace_(loc)}${ev.summary ? ` (${ev.summary})` : ''}`;
  const driveDesc = [
    `Auto-created for event ${ev.id}`,
    ev.htmlLink ? ev.htmlLink : '',
    `From: ${home}`,
    `To: ${loc}`
  ].filter(Boolean).join('\n');

  const payload = {
    summary: driveSummary,
    description: driveDesc,
    start: { dateTime: driveStart.toISOString() },
    end:   { dateTime: driveEnd.toISOString() },
    extendedProperties: { private: { driveForEventId: ev.id } }
  };

  if (existing) {
    const needUpdate =
      Math.abs(new Date(existing.start.dateTime).getTime() - driveStart.getTime()) > minutes_(2) ||
      Math.abs(new Date(existing.end.dateTime).getTime()   - driveEnd.getTime())   > minutes_(2) ||
      existing.summary !== driveSummary ||
      (existing.extendedProperties?.private?.driveForEventId) !== ev.id;

    if (needUpdate) {
      logI('ensureDriveBlock_: updating drive event', {
        eventId: ev.id,
        driveEventId: existing.id,
        old: { start: existing.start.dateTime, end: existing.end.dateTime, summary: existing.summary },
        new: { start: payload.start.dateTime, end: payload.end.dateTime, summary: payload.summary }
      });
      Calendar.Events.patch(payload, calId, existing.id);
    } else {
      logD('ensureDriveBlock_: drive event already up-to-date', { driveEventId: existing.id });
    }
  } else {
    const inserted = Calendar.Events.insert(payload, calId);
    logI('ensureDriveBlock_: created drive event', { eventId: ev.id, driveEventId: inserted.id, start: payload.start.dateTime, end: payload.end.dateTime });
  }

  logD('ensureDriveBlock_: done', { durationMs: durMs_(t0) });
}

// ---------- Distance Matrix ----------
/**
 * Traffic-aware driving duration (ms), with 1-hour cache.
 */
function getDrivingDurationMs_(origin, destination, driveEnd) {
  const t0 = new Date().getTime();
  const apiKey = getProp_('GOOGLE_MAPS_API_KEY');

  // --- CACHE LOOKUP ---
  const cache = CacheService.getScriptCache();
  // Cache key unique to route + hour of day (so rush hour patterns refresh each hour)
  const hourKey = new Date(driveEnd).getHours();
  const cacheKey = `durMs|${origin}|${destination}|${hourKey}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    logI('getDrivingDurationMs_: cache hit', { cacheKey, durationMs: cached });
    return parseInt(cached, 10);
  }

  // --- API CALLS ---
  const base = dmCall_({ origins: origin, destinations: destination, key: apiKey });
  const baseSec = readDmSeconds_(base);
  logD('getDrivingDurationMs_: base duration', { ok: !!baseSec, seconds: baseSec });
  if (!baseSec) return null;

  const tentativeDepart = new Date(driveEnd.getTime() - baseSec * 1000);
  const departEpoch = Math.floor(tentativeDepart.getTime() / 1000);

  const withTraffic = dmCall_({
    origins: origin,
    destinations: destination,
    mode: 'driving',
    departure_time: departEpoch,
    traffic_model: 'best_guess',
    key: apiKey
  });
  const trafficSec = readDmSeconds_(withTraffic, /*preferTraffic=*/true);

  const usedSec = trafficSec || baseSec;
  const durMs = usedSec * 1000;

  // --- CACHE STORE ---
  // Cache for 1 hour (3600 seconds)
  cache.put(cacheKey, String(durMs), 3600);
  logD('getDrivingDurationMs_: cached new value', { cacheKey, durationMs: durMs });

  logI('getDrivingDurationMs_: computed', {
    origin,
    destination,
    driveEnd: driveEnd.toISOString(),
    tentativeDepart: tentativeDepart.toISOString(),
    baseSec,
    trafficSec,
    usedSec,
    durationMs: durMs
  });
  logD('getDrivingDurationMs_: done', { durationMs: durMs_(t0) });
  return durMs;
}

function dmCall_(paramsObj) {
  const url = 'https://maps.googleapis.com/maps/api/distancematrix/json';
  const safeParams = Object.assign({}, paramsObj);
  if (safeParams.key) safeParams.key = mask_(safeParams.key);
  logD('dmCall_: request', safeParams);

  const q = Object.keys(paramsObj)
    .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(paramsObj[k]))
    .join('&');

  const res = UrlFetchApp.fetch(`${url}?${q}`, { muteHttpExceptions: true });
  let data;
  try {
    data = JSON.parse(res.getContentText());
  } catch (e) {
    logW('dmCall_: JSON parse error', { error: String(e && e.message) });
    return null;
  }

  if (data?.status !== 'OK') {
    logW('dmCall_: API status not OK', { status: data?.status, error_message: data?.error_message });
    return null;
  }
  // Don’t log full response (can be large); log essentials in readDmSeconds_
  return data;
}

function readDmSeconds_(data, preferTraffic) {
  if (!data) return null;
  const el = data?.rows?.[0]?.elements?.[0];
  if (!el || el.status !== 'OK') {
    logW('readDmSeconds_: element not OK', { elementStatus: el?.status });
    return null;
  }
  const traffic = el.duration_in_traffic?.value;
  const base = el.duration?.value;
  const picked = preferTraffic && traffic ? traffic : base || null;
  logD('readDmSeconds_: extracted seconds', { preferTraffic: !!preferTraffic, traffic, base, picked });
  return picked;
}

// ---------- Drive event discovery & cleanup ----------
function findDriveBlockFor_(calId, eventId, windowStart, windowEnd) {
  const t0 = new Date().getTime();
  const list = Calendar.Events.list(calId, {
    timeMin: (windowStart || new Date(Date.now() - hours_(24))).toISOString(),
    timeMax: (windowEnd   || new Date(Date.now() + hours_(168))).toISOString(),
    singleEvents: true,
    maxResults: 100,
    orderBy: 'startTime'
  });
  const items = list.items || [];
  let found = null;
  for (const it of items) {
    const priv = it.extendedProperties?.private || {};
    if (priv.driveForEventId === eventId) { found = it; break; }
  }
  logD('findDriveBlockFor_: scanned', { count: items.length, found: !!found, eventId });
  return found;
}

function removeDriveBlockFor_(calId, eventId) {
  const t0 = new Date().getTime();
  const dayBack = new Date(Date.now() - hours_(24));
  const weekFwd = new Date(Date.now() + hours_(168));
  const list = Calendar.Events.list(calId, {
    timeMin: dayBack.toISOString(),
    timeMax: weekFwd.toISOString(),
    singleEvents: true,
    maxResults: 250,
    orderBy: 'startTime'
  });

  let deleted = 0;
  (list.items || []).forEach(it => {
    const priv = it.extendedProperties?.private || {};
    const isDrive = it.summary?.startsWith('Drive to ');
    if (priv.driveForEventId === eventId && isDrive) {
      try {
        Calendar.Events.delete(calId, it.id);
        deleted++;
        logI('removeDriveBlockFor_: deleted drive event', { driveEventId: it.id, forEventId: eventId });
      } catch (e) {
        logW('removeDriveBlockFor_: delete failed', { driveEventId: it.id, error: String(e && e.message) });
      }
    }
  });

  logI('removeDriveBlockFor_: done', { forEventId: eventId, deleted, durationMs: durMs_(t0) });
}

// ---------- Misc ----------
function shortPlace_(loc) {
  const s = (loc || '').split(',')[0].trim();
  return s || loc || 'destination';
}

function scanNow() {
  console.log("Manual scanNow() invoked");
  scanUpcoming_();
}
