'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const state = { csrf: null, fleet: null };
  const fmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
  const money = new Intl.NumberFormat(undefined, {
    style: 'currency', currency: 'USD', maximumFractionDigits: 4
  });
  const MONEY_LABEL = 'OpenRouter-equivalent estimate';

  async function api(route, options) {
    const config = Object.assign({ credentials: 'same-origin', headers: {} }, options || {});
    if (config.body && typeof config.body !== 'string') {
      config.headers['content-type'] = 'application/json';
      config.body = JSON.stringify(config.body);
    }
    if (config.method && config.method !== 'GET' && state.csrf) config.headers['x-csrf-token'] = state.csrf;
    const response = await fetch(route, config);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(body.error || 'Request failed'), { status: response.status });
    return body;
  }

  function setStatus(message) { $('status').textContent = message || ''; }

  /** Never show unknown/partial as a guessed exact $0 bill. */
  function formatEstimate(bucket) {
    const cost = bucket && bucket.openrouterEquivalent;
    if (!cost) return 'unknown';
    if (cost.status === 'unknown' || cost.amount == null) return 'unknown';
    const amount = money.format(cost.amount);
    if (cost.status === 'partial') return amount + ' (partial)';
    return amount;
  }

  function tokenPart(bucket, key) {
    const t = (bucket && bucket.tokens) || {};
    return fmt.format(Number(t[key] || 0));
  }

  function cell(row, label, content) {
    const td = document.createElement('td'); td.dataset.label = label;
    if (content instanceof Node) td.append(content); else td.textContent = content;
    row.append(td); return td;
  }

  function statusText(device) {
    if (device.revokedAt) return { text: 'Revoked', className: 'revoked' };
    if (device.online) return { text: 'Live · seen within 5 minutes', className: 'online' };
    if (!device.lastSeenAt) return { text: 'Offline · no usage received yet', className: 'offline' };
    return { text: 'Offline · last seen ' + new Date(device.lastSeenAt).toLocaleString(), className: 'offline' };
  }

  function reportingText(bucket) {
    if (bucket && bucket.reporting && bucket.reporting.label) return bucket.reporting.label;
    return 'task counters';
  }

  function evidenceText(bucket) {
    const evidence = bucket && bucket.evidence;
    if (!evidence) return 'unknown';
    const missing = evidence.unknownTokenCategories && evidence.unknownTokenCategories.length
      ? ` · unknown: ${evidence.unknownTokenCategories.join(', ')}`
      : '';
    return `${evidence.tokenDetail} counters · ${evidence.modelIdentity} model${missing}`;
  }

  function renderReporting(fleet) {
    const list = $('reporting-list');
    list.replaceChildren();
    const surfaces = fleet.reportingSurfaces || {};
    const rows = [
      ['Cursor', surfaces.cursor && surfaces.cursor.uploadedRows
        ? surfaces.cursor.uploadedRows
        : 'task counters',
        'Device-uploaded rows only. Provider-accounted usage is not claimed without server-side reconciliation.'],
      ['Claude / Codex / Gemini', 'task counters',
        'Account-window figures are separate from task rows and never mixed into per-task totals.'],
      ['Grok', surfaces.grok && surfaces.grok.counters ? surfaces.grok.counters : 'local',
        'Local session counters only; no provider usage export is claimed.']
    ];
    for (const [title, label, note] of rows) {
      const item = document.createElement('li');
      const strong = document.createElement('strong'); strong.textContent = title + ': ';
      const lab = document.createElement('span'); lab.className = 'reporting-label'; lab.textContent = label;
      const muted = document.createElement('span'); muted.className = 'subtle'; muted.textContent = note;
      item.append(strong, lab, muted);
      list.append(item);
    }
  }

  function render() {
    const fleet = state.fleet;
    const total = fleet.total;
    $('range-label').textContent = `Since ${fleet.since} · ${fmt.format(fleet.totalEvents)} usage events`;
    $('total-cost').textContent = formatEstimate(total);
    $('tokens-in').textContent = tokenPart(total, 'in');
    $('tokens-out').textContent = tokenPart(total, 'out');
    $('cache-read').textContent = tokenPart(total, 'cache_read');
    $('cache-write').textContent = tokenPart(total, 'cache_write');
    const cost = total.openrouterEquivalent || {};
    const moneyLabel = fleet.moneyLabel || (cost.label) || MONEY_LABEL;
    $('money-caption').textContent = moneyLabel
      + ' from token buckets · catalogue estimate only, not an invoice';
    $('pricing-status').textContent = (cost.status || 'unknown') + ' · ' + moneyLabel;
    const version = (fleet.pricing && fleet.pricing.version)
      || cost.version
      || 'unknown catalogue';
    $('catalogue-version').textContent = 'Pricing catalogue version: ' + version
      + (fleet.pricing && fleet.pricing.asOf ? ' · as of ' + fleet.pricing.asOf : '');
    const warning = $('pricing-warning');
    if (cost.status && cost.status !== 'priced') {
      const models = cost.unpricedModels && cost.unpricedModels.length
        ? ` Unpriced models: ${cost.unpricedModels.join(', ')}.`
        : '';
      const missing = total.evidence && total.evidence.unknownTokenCategories.length
        ? ` Unknown token categories: ${total.evidence.unknownTokenCategories.join(', ')}.`
        : '';
      warning.textContent = `The ${moneyLabel} is ${cost.status}; only known token buckets are shown.${missing}${models}`
        + ' Missing model identity or token buckets stay unknown or partial — never a guessed exact amount.';
      warning.hidden = false;
    } else warning.hidden = true;

    renderReporting(fleet);

    const deviceSelect = $('device-filter');
    const selectedDevice = deviceSelect.value;
    while (deviceSelect.options.length > 1) deviceSelect.remove(1);
    for (const device of fleet.devices) {
      const option = document.createElement('option'); option.value = device.id;
      option.textContent = `${device.label} · ${device.id.slice(0, 8)}`; deviceSelect.append(option);
    }
    deviceSelect.value = selectedDevice;
    const toolSelect = $('tool-filter');
    const selectedTool = toolSelect.value;
    const tools = Object.keys(fleet.byHarness || {}).sort();
    while (toolSelect.options.length > 1) toolSelect.remove(1);
    for (const tool of tools) {
      const option = document.createElement('option'); option.value = tool; option.textContent = tool;
      toolSelect.append(option);
    }
    toolSelect.value = selectedTool;

    const deviceRows = $('device-rows'); deviceRows.replaceChildren();
    for (const device of fleet.devices) {
      const row = document.createElement('tr');
      const identity = document.createElement('span');
      const name = document.createElement('span'); name.className = 'device-name'; name.textContent = device.label;
      const id = document.createElement('span'); id.className = 'device-id';
      id.textContent = `${device.platform} · ${device.id}`;
      identity.append(name, id); cell(row, 'Device', identity);
      const presence = statusText(device); const presenceNode = document.createElement('span');
      presenceNode.className = presence.className; presenceNode.textContent = presence.text;
      cell(row, 'Status', presenceNode);
      const bucket = fleet.byDevice[device.id];
      cell(row, 'Input', bucket ? tokenPart(bucket, 'in') : '—');
      cell(row, 'Output', bucket ? tokenPart(bucket, 'out') : '—');
      cell(row, 'Cache read', bucket ? tokenPart(bucket, 'cache_read') : '—');
      cell(row, 'Cache write', bucket ? tokenPart(bucket, 'cache_write') : '—');
      cell(row, MONEY_LABEL, bucket ? formatEstimate(bucket) : '—');
      const actions = document.createElement('span'); actions.className = 'row-actions';
      const view = document.createElement('button'); view.type = 'button'; view.className = 'secondary';
      view.textContent = 'View usage'; view.addEventListener('click', async () => {
        $('device-filter').value = device.id;
        try { await loadFleet(); } catch (_) { setStatus('Usage could not be loaded.'); }
      });
      actions.append(view); cell(row, 'Details', actions);
      deviceRows.append(row);
    }
    $('devices-empty').hidden = fleet.devices.length !== 0;

    const toolRows = $('tool-rows'); toolRows.replaceChildren();
    for (const [tool, bucket] of Object.entries(fleet.byHarness || {}).sort(([a], [b]) => a.localeCompare(b))) {
      const row = document.createElement('tr');
      cell(row, 'Tool', tool);
      cell(row, 'Reporting', reportingText(bucket));
      cell(row, 'Calls', fmt.format(bucket.calls));
      cell(row, 'Input', tokenPart(bucket, 'in'));
      cell(row, 'Output', tokenPart(bucket, 'out'));
      cell(row, 'Cache read', tokenPart(bucket, 'cache_read'));
      cell(row, 'Cache write', tokenPart(bucket, 'cache_write'));
      cell(row, 'Evidence', evidenceText(bucket));
      cell(row, MONEY_LABEL, formatEstimate(bucket));
      toolRows.append(row);
    }
    $('tools-empty').hidden = toolRows.children.length !== 0;

    const modelRows = $('model-rows'); modelRows.replaceChildren();
    for (const [model, bucket] of Object.entries(fleet.byModel || {}).sort(([a], [b]) => a.localeCompare(b))) {
      const row = document.createElement('tr');
      cell(row, 'Model', model);
      cell(row, 'Calls', fmt.format(bucket.calls));
      cell(row, 'Input', tokenPart(bucket, 'in'));
      cell(row, 'Output', tokenPart(bucket, 'out'));
      cell(row, 'Cache read', tokenPart(bucket, 'cache_read'));
      cell(row, 'Cache write', tokenPart(bucket, 'cache_write'));
      cell(row, 'Evidence', evidenceText(bucket));
      cell(row, MONEY_LABEL, formatEstimate(bucket));
      cell(row, 'Sources', (bucket.sources || []).join(', ') || '—');
      modelRows.append(row);
    }
    $('models-empty').hidden = modelRows.children.length !== 0;
  }

  async function loadFleet() {
    setStatus('Loading company usage…');
    const query = new URLSearchParams({ days: $('days').value });
    if ($('device-filter').value) query.set('device', $('device-filter').value);
    if ($('tool-filter').value) query.set('tool', $('tool-filter').value);
    state.fleet = await api('/api/v1/fleet?' + query.toString());
    render();
    const limited = state.fleet.limits && (
      state.fleet.limits.devicesTruncated
      || state.fleet.limits.toolsTruncated
      || state.fleet.limits.modelsTruncated
    );
    setStatus('Server data refreshed at ' + new Date().toLocaleTimeString() + '; computers may upload later.'
      + (limited ? ' The breakdown reached its safety limit; narrow the filters for complete rows.' : ''));
  }

  async function showDashboard(session) {
    state.csrf = session.csrfToken;
    $('manager-label').textContent = `${session.manager.companyName} · ${session.manager.email}`;
    $('login-view').hidden = true; $('dashboard-view').hidden = false;
    try { await loadFleet(); }
    catch (_) { setStatus('Usage could not be loaded. Try again.'); }
  }

  async function preloginCsrf() {
    const result = await api('/api/v1/manager/csrf');
    state.csrf = result.csrfToken;
  }

  $('login-form').addEventListener('submit', async (event) => {
    event.preventDefault(); $('login-error').textContent = '';
    let session;
    try {
      await preloginCsrf();
      session = await api('/api/v1/manager/login', { method: 'POST', body: {
        email: $('email').value, password: $('password').value
      } });
    } catch (err) {
      $('password').value = '';
      $('login-error').textContent = err && err.status === 401
        ? 'Email or password is incorrect.'
        : 'Sign in could not be completed. Try again.';
      return;
    }
    $('password').value = '';
    await showDashboard(session);
  });
  $('filters').addEventListener('submit', async (event) => {
    event.preventDefault(); try { await loadFleet(); } catch (_) { setStatus('Usage could not be loaded. Try again.'); }
  });
  $('logout').addEventListener('click', async () => {
    try { await api('/api/v1/manager/logout', { method: 'POST', body: {} }); }
    catch (_) { setStatus('Sign out could not be completed. Try again.'); return; }
    state.csrf = null; state.fleet = null;
    $('dashboard-view').hidden = true; $('login-view').hidden = false; $('email').focus();
  });

  api('/api/v1/manager/session').then(showDashboard).catch(async () => {
    $('dashboard-view').hidden = true; $('login-view').hidden = false;
    try { await preloginCsrf(); } catch (_) { $('login-error').textContent = 'The dashboard is unavailable. Try again later.'; }
  });
})();
