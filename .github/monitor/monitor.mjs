import fs from 'node:fs';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const PUBLIC_REPO = 'MrDou01/global-liquefaction-watch';
const PRIVATE_REPO = 'MrDou01/global-liquefaction-map';
const STATE_BRANCH = 'cloud-monitor-state';
const STATE_FILE = 'cloud-new-quakes.json';
const BASELINE = '2026-09-10T13:29:25.520Z';

export function mergeCatalog(previous, catalog, checked) {
  assert(Array.isArray(catalog.features) && catalog.features.length < 20000, 'Incomplete earthquake catalog');
  const baseline = previous?.baseline_utc ?? BASELINE;
  const events = structuredClone(previous?.events ?? {});
  for (const f of catalog.features) {
    const p = f.properties, c = f.geometry?.coordinates;
    assert(/^[a-zA-Z0-9_-]{1,80}$/.test(f.id) && Number.isFinite(p?.time) && Number.isFinite(p?.mag)
      && Number.isFinite(p?.updated) && c?.length >= 3 && c.every(Number.isFinite), 'Invalid event');
    assert(Math.abs(c[0]) <= 180 && Math.abs(c[1]) <= 90 && p.time <= Date.parse(checked), 'Invalid origin');
    // Earlier history is deliberately excluded, including catalog backfills.
    if (p.time < Date.parse(baseline)) continue;
    const old = events[f.id];
    if (p.mag < 6 && !old) continue;
    const revision = String(p.updated);
    events[f.id] = {
      ...old, first_seen_utc: old?.first_seen_utc ?? checked,
      last_seen_utc: checked, event_id: f.id, revision,
      origin_utc: new Date(p.time).toISOString(), magnitude: p.mag,
      magnitude_type: p.magType, coordinates: c, place: p.place,
      source: `https://earthquake.usgs.gov/earthquakes/eventpage/${f.id}`,
      eligible: p.mag >= 6,
      status: p.mag < 6 ? 'below_threshold_after_revision'
        : old?.dispatched_revision === revision ? 'private_task_dispatched_not_completed' : 'waiting_private_compute_configuration',
    };
  }
  return {schema_version: 1, baseline_utc: baseline, last_success_utc: checked,
    execution: 'GitHub-hosted scheduled monitor; not local computer', events,
    limitations: '30-minute polling may be delayed. A detection or dispatch is not a computed/published probability. Missing PGA or validated regional inputs must wait.'};
}

async function main() {
  assert(process.env.GITHUB_REPOSITORY === PUBLIC_REPO, 'Unexpected repository');
  const token = process.env.GITHUB_TOKEN;
  assert(token, 'Missing workflow token');
  async function api(repo, route, method = 'GET', body, auth = token) {
    const r = await fetch(`https://api.github.com/repos/${repo}${route}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: {Authorization: `Bearer ${auth}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json'},
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (r.status === 404 && method === 'GET') return null;
    assert(r.ok, `GitHub ${method} ${route}: HTTP ${r.status}`);
    return r.status === 204 ? null : r.json();
  }
  let branch = await api(PUBLIC_REPO, `/git/ref/heads/${STATE_BRANCH}`);
  if (!branch) {
    const repo = await api(PUBLIC_REPO, '');
    const head = await api(PUBLIC_REPO, `/git/ref/heads/${repo.default_branch}`);
    branch = await api(PUBLIC_REPO, '/git/refs', 'POST', {ref: `refs/heads/${STATE_BRANCH}`, sha: head.object.sha});
  }
  let stored = await api(PUBLIC_REPO, `/contents/${STATE_FILE}?ref=${STATE_BRANCH}`);
  const previous = stored ? JSON.parse(Buffer.from(stored.content, 'base64').toString()) : null;
  const checked = new Date().toISOString();
  const start = new Date(Math.max(Date.parse(BASELINE), Date.parse(previous?.last_success_utc ?? BASELINE) - 7 * 86400000));
  const url = 'https://earthquake.usgs.gov/fdsnws/event/1/query?' + new URLSearchParams({
    format: 'geojson', eventtype: 'earthquake', minmagnitude: '5.8', starttime: start.toISOString(), endtime: checked, orderby: 'time', limit: '20000',
  });
  const response = await fetch(url, {signal: AbortSignal.timeout(60000)});
  assert(response.ok, `USGS HTTP ${response.status}`);
  const catalog = response.status === 204 ? {features: []} : await response.json();
  const state = mergeCatalog(previous, catalog, checked);
  state.source_query = url;
  const pending = Object.values(state.events).filter(e => e.eligible && e.dispatched_revision !== e.revision);
  const ready = process.env.PRIVATE_COMPUTE_READY === 'true' && !!process.env.NEW_QUAKE_DISPATCH_TOKEN;
  state.private_compute_enabled = ready;
  async function save() {
    const r = await api(PUBLIC_REPO, `/contents/${STATE_FILE}`, 'PUT', {
      message: 'Update cloud earthquake monitoring state', branch: STATE_BRANCH,
      content: Buffer.from(JSON.stringify(state, null, 2) + '\n').toString('base64'),
      ...(stored ? {sha: stored.sha} : {}),
    });
    stored = r.content;
  }
  // Persist detection before dispatch so failed dispatches are safely retried.
  await save();
  if (ready) for (const event of pending.slice(0, 2)) {
    await api(PRIVATE_REPO, '/actions/workflows/new-earthquake.yml/dispatches', 'POST', {
      ref: 'main', inputs: {event_id: event.event_id, revision: event.revision},
    }, process.env.NEW_QUAKE_DISPATCH_TOKEN);
    event.dispatched_revision = event.revision;
    event.dispatched_utc = new Date().toISOString();
    event.status = 'private_task_dispatched_not_completed';
    await save();
  }
  const summary = `Cloud check: ${checked}\nEligible pending events: ${pending.length}\nPrivate compute enabled: ${ready}\nNo calculation/publication is implied by this monitoring run.\n`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
