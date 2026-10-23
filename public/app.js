const $ = (id) => document.getElementById(id);
const modes = { fcfs: '先到先得', throttled: '限流去重', lottery: '窗口抽签', standby: '先售后候补' };
const groupNames = { crowd: '模拟群众', bot: '抢票程序', manual: '操作者', system: '系统' };
const defaults = {
  stock: 30, crowd: 120, bots: 12, countdown: 8, duration: 25,
  windowSeconds: 3, botInterval: 150, networkMs: 60, jitterMs: 40,
  seed: 42, holdSeconds: 6, botAccountsPerPerson: 2, serviceMs: 15,
  workers: 4, refundRate: 10, resaleDelay: 3, paymentDelayMs: 850,
  paymentAbandonRate: 4
};
const presets = {
  opening: {
    mode: 'fcfs', stock: 30, crowd: 120, bots: 12, botAccountsPerPerson: 2,
    countdown: 8, duration: 25, windowSeconds: 5, botInterval: 150,
    networkMs: 60, jitterMs: 40, serviceMs: 15, workers: 4,
    refundRate: 10, resaleDelay: 3, paymentDelayMs: 850,
    paymentAbandonRate: 4, holdSeconds: 6, seed: 42
  },
  duplicates: {
    mode: 'throttled', stock: 24, crowd: 90, bots: 18, botAccountsPerPerson: 3,
    countdown: 6, duration: 30, windowSeconds: 5, botInterval: 70,
    networkMs: 55, jitterMs: 45, serviceMs: 30, workers: 2,
    refundRate: 8, resaleDelay: 3, paymentDelayMs: 850,
    paymentAbandonRate: 4, holdSeconds: 6, seed: 42
  },
  standby: {
    mode: 'standby', stock: 18, crowd: 100, bots: 10, botAccountsPerPerson: 2,
    countdown: 7, duration: 40, windowSeconds: 5, botInterval: 150,
    networkMs: 60, jitterMs: 40, serviceMs: 15, workers: 4,
    refundRate: 25, resaleDelay: 3, paymentDelayMs: 850,
    paymentAbandonRate: 4, holdSeconds: 6, seed: 42
  }
};

let state = null;
let selectedMode = 'fcfs';
let serverOffset = 0;
let lastSnapshotAt = 0;
let requestSequence = 0;
let appliedSequence = 0;
let polling = false;
let actionBusy = false;
let manualBusy = false;
let toastTimer = null;
let eventKey = '';
let historyKey = '';
let mapKey = '';
let chartKey = '';
let waitlistKey = '';
let metricsKey = '';
let syncedRound = null;

const number = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const text = (value) => String(value === undefined || value === null ? '' : value);
const esc = (value) => text(value).replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));
const percent = (n, d) => d > 0 ? (n / d * 100).toFixed(1) + '%' : '—';
const sum = (items, field) => items.reduce((total, item) => total + number(item && item[field], 0), 0);
const count = (value) => number(value, 0).toLocaleString('zh-CN');
const ms = (value) => Number.isFinite(Number(value)) ? Number(value).toFixed(2) + ' ms' : '—';

function toast(message) {
  $('toast').textContent = text(message);
  $('toast').classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.remove('visible'), 3500);
}

function configFromForm() {
  const config = {};
  for (const [key, value] of new FormData($('settingsForm')).entries()) config[key] = Number(value);
  config.mode = selectedMode;
  return config;
}

function active() {
  return state && (state.status === 'countdown' || state.status === 'live');
}

function chooseMode(mode) {
  selectedMode = modes[mode] ? mode : 'fcfs';
  document.querySelectorAll('.mode').forEach((button) => {
    const selected = button.dataset.mode === selectedMode;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  updateRule();
}

function updateRule() {
  const mode = active() ? state.mode : selectedMode;
  const config = active() ? (state.config || defaults) : configFromForm();
  const notes = {
    fcfs: '↗ 先到先得：先进入服务队列的请求先启动业务处理；库存按实际处理时确定。占位后仍需确认。',
    throttled: '≋ 限流去重：对高频请求账号进行节流处置；账号会映射到共享购票人。',
    lottery: '⌘ 窗口抽签：在 ' + number(config.windowSeconds, defaults.windowSeconds) +
      ' 秒窗口登记，每个购票人只有一次有效资格，截止后随机排序。',
    standby: '↻ 先售后候补：可售库存先按队列售出，释放票按服务端登记生效顺序递补；重复登记不增加机会。'
  };
  $('ruleNote').textContent = notes[mode] || notes.fcfs;
}

async function post(path, body) {
  const sequence = ++requestSequence;
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error('服务返回了无法读取的结果。');
  }
  if (!response.ok) throw new Error(data.message || '请求未完成，请重试。');
  if (data.state) render(data.state, sequence);
  return data;
}

async function runAction(path, body) {
  if (actionBusy || manualBusy) return;
  actionBusy = true;
  refreshButtons();
  try {
    const result = await post(path, body);
    if (result.message) toast(result.message);
  } catch (error) {
    toast(error.message || '请求未完成，请重试。');
  } finally {
    actionBusy = false;
    refreshButtons();
  }
}

async function runManualAction(path) {
  if (actionBusy || manualBusy) return;
  manualBusy = true;
  refreshButtons();
  try {
    const result = await post(path);
    if (result.message) toast(result.message);
  } catch (error) {
    toast(error.message || '请求未完成，请重试。');
  } finally {
    manualBusy = false;
    refreshButtons();
  }
}

$('settingsForm').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!active() && $('settingsForm').reportValidity()) runAction('/api/start', configFromForm());
});
document.querySelectorAll('.mode').forEach((button) => button.addEventListener('click', () => {
  if (!active() && !actionBusy) chooseMode(button.dataset.mode);
}));
$('settingsForm').addEventListener('input', () => {
  updateRule();
  refreshIdleCounts();
});
$('resetBtn').addEventListener('click', () => runAction('/api/reset'));
$('queryBtn').addEventListener('click', () => runManualAction('/api/manual/query'));
$('claimBtn').addEventListener('click', () => runManualAction('/api/manual/claim'));
$('waitlistBtn').addEventListener('click', () => runManualAction('/api/manual/waitlist'));
$('confirmBtn').addEventListener('click', () => runManualAction('/api/manual/confirm'));
$('cancelBtn').addEventListener('click', () => runManualAction('/api/manual/cancel'));
$('refundBtn').addEventListener('click', () => runManualAction('/api/manual/refund'));

function loadValues(values, mode) {
  if (active() || actionBusy) return;
  Object.entries(values).forEach(([key, value]) => {
    if ($('settingsForm').elements[key]) $('settingsForm').elements[key].value = value;
  });
  chooseMode(mode);
  refreshIdleCounts();
  toast('场景参数已载入；人数和规则已变化，检查设置后再手动开始。');
}

document.querySelectorAll('[data-scenario]').forEach((button) => {
  button.addEventListener('click', () => {
    const preset = presets[button.dataset.scenario];
    if (preset) loadValues(preset, preset.mode);
  });
});
$('soloBtn').addEventListener('click', () => loadValues({
  stock: 8, crowd: 12, bots: 2, botAccountsPerPerson: 2,
  countdown: 8, duration: 25, windowSeconds: 5, workers: 4, serviceMs: 15
}, selectedMode));
$('exportBtn').addEventListener('click', () => {
  if (!state || !state.roundId) return toast('请先运行一场实验。');
  window.location.href = '/api/export';
});
$('helpBtn').addEventListener('click', () => $('helpDialog').showModal());
['closeHelp', 'understoodBtn'].forEach((id) =>
  $(id).addEventListener('click', () => $('helpDialog').close()));
$('helpDialog').addEventListener('click', (event) => {
  if (event.target !== $('helpDialog')) return;
  const rect = event.target.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right ||
      event.clientY < rect.top || event.clientY > rect.bottom) event.target.close();
});
$('logFilter').addEventListener('change', () => {
  eventKey = '';
  renderEvents();
});

function refreshIdleCounts() {
  const config = configFromForm();
  const botPeople = Math.ceil(number(config.bots, 0) / Math.max(1, number(config.botAccountsPerPerson, 2)));
  $('crowdCount').textContent = count(config.crowd) + ' 账号 · ' + count(config.crowd) + ' 人';
  $('botCount').textContent = count(config.bots) + ' 账号 · ' + count(botPeople) + ' 人';
  if (!state || state.status === 'idle') {
    $('available').textContent = count(config.stock);
    $('totalStock').textContent = count(config.stock);
  }
}

function refreshButtons() {
  if (!state) return;
  const running = active();
  const live = state.status === 'live';
  const manual = state.manual || {};
  const status = manual.refundedAt ? 'refunded' : (manual.status || 'idle');
  const refunded = status === 'refunded' || Boolean(manual.refundedAt);
  const held = status === 'held';
  const confirmed = status === 'confirmed';
  const waiting = status === 'waiting';
  const busy = actionBusy || manualBusy;

  $('startBtn').disabled = running || busy;
  $('startBtn').textContent = running ? '●  实验运行中…' : '▶  开始这场实验';
  $('resetBtn').disabled = busy || state.status === 'idle';
  $('soloBtn').disabled = running || busy;
  document.querySelectorAll('[data-scenario]').forEach((button) => button.disabled = running || busy);
  document.querySelectorAll('.mode').forEach((button) => button.disabled = running || busy);
  document.querySelectorAll('#settingsForm input').forEach((input) => input.disabled = running || busy);

  $('queryBtn').disabled = !live || busy;
  $('claimBtn').disabled = !live || busy || held || confirmed || refunded ||
    (state.mode === 'lottery' && waiting);
  $('claimBtn').innerHTML = state.mode === 'lottery' && waiting
    ? '已登记抽签 <span>✓</span>'
    : state.mode === 'lottery' && live
      ? '提交抢票 · 登记抽签 <span>↗</span>'
      : '提交抢票 <span>↗</span>';
  $('waitlistBtn').disabled = !live || state.mode !== 'standby' || busy ||
    waiting || held || confirmed || refunded;
  $('confirmBtn').disabled = !live || !held || busy;
  $('cancelBtn').disabled = !live || (!held && !waiting) || busy;
  $('refundBtn').disabled = !live || (!confirmed && !refunded) || refunded || busy;
  $('refundBtn').textContent = refunded ? '已退票' : '已付款退票';
  $('exportBtn').disabled = !state.roundId;
}

function displayIdentity(manual, actors) {
  const actor = actors.find((item) => item.group === 'manual');
  const personId = manual.personId || manual.id || (actor && actor.id) || 'person-you';
  const accountId = manual.accountId || (actor && actor.accountId) || 'manual-account';
  const deviceId = manual.deviceId || (actor && actor.deviceId) || 'manual-device';
  $('manualIdentity').innerHTML =
    '<span>虚构 person-id <b>' + esc(personId) + '</b></span>' +
    '<span>账号 <b>' + esc(accountId) + '</b></span>' +
    '<span>设备映射 <b>' + esc(deviceId) + '</b></span>';
}

function renderQuery(manual, currentAvailable) {
  const query = manual.query || null;
  if (!query || query.queriedAt === undefined || query.queriedAt === null) {
    $('manualQuery').textContent = '尚未查询余票。查询只记录当时快照，不会保留库存。当前可售 ' +
      count(currentAvailable) + ' 张。';
    return;
  }
  const parsed = typeof query.queriedAt === 'number' ? query.queriedAt : Date.parse(query.queriedAt);
  const time = Number.isFinite(parsed)
    ? new Date(parsed).toLocaleTimeString('zh-CN', { hour12: false }) : text(query.queriedAt);
  $('manualQuery').textContent = '查询于 ' + time + ' · 当时可售 ' +
    count(query.available) + ' 张；当前可售 ' + count(currentAvailable) + ' 张。快照不会保留库存。';
}

function metricRecord(source, fallbackValue, numerator, denominator, definition) {
  if (source && typeof source === 'object' && Object.prototype.hasOwnProperty.call(source, 'value')) {
    return {
      value: source.value,
      numerator: source.numerator,
      denominator: source.denominator,
      definition: source.definition || definition
    };
  }
  return { value: fallbackValue, numerator, denominator, definition };
}

function metricText(value, type) {
  if (value === null || value === undefined || value === '') return '—';
  if (type === 'multiple') return number(value, 0).toFixed(2) + '×';
  if (type === 'percent') return (number(value, 0) * 100).toFixed(1) + '%';
  if (type === 'ms') return ms(value);
  if (type === 'count') return count(value);
  return number(value, 0).toFixed(2);
}

function fraction(value) {
  if (value === null || value === undefined || value === '') return '—';
  return typeof value === 'number' ? count(value) : esc(value);
}

function renderMetrics(snapshot, groups, health, stock, config) {
  const metrics = snapshot.metrics || {};
  const allGroups = Object.values(groups);
  const queries = sum(allGroups, 'queries');
  const claims = sum(allGroups, 'requests');
  const accepted = sum(allGroups, 'accepted');
  const confirmed = number(stock.confirmed, 0);
  const crowdPeople = number(groups.crowd && groups.crowd.participants, 0);
  const botPeople = number(groups.bot && groups.bot.participants, 0);
  const crowdRate = crowdPeople > 0 ? number(groups.crowd && groups.crowd.confirmed, 0) / crowdPeople : 0;
  const botRate = botPeople > 0 ? number(groups.bot && groups.bot.confirmed, 0) / botPeople : 0;
  const botAdvantage = crowdPeople > 0 && botPeople > 0 && crowdRate > 0 ? botRate / crowdRate : null;
  const totalOps = number(health.totalOperations, queries + claims);
  const started = number(health.startedOperations, number(health.processed, 0));
  const totalQueue = number(health.totalQueueMs, 0);
  const totalProcessing = number(health.totalProcessingMs, 0);
  const totalLatency = number(health.totalLatencyMs, 0);
  const averageQueue = started > 0
    ? (health.averageQueueMs !== undefined && health.averageQueueMs !== null
      ? health.averageQueueMs : totalQueue / started)
    : null;
  const averageProcessing = totalOps > 0
    ? (health.averageProcessingMs !== undefined && health.averageProcessingMs !== null
      ? health.averageProcessingMs : totalProcessing / totalOps)
    : null;
  const averageLatency = totalOps > 0
    ? (health.averageLatencyMs !== undefined && health.averageLatencyMs !== null
      ? health.averageLatencyMs : totalLatency / totalOps)
    : null;
  const requestsMetric = metrics.requestsPerConfirmed;
  const cards = [
    ['queries', '查询余票次数', metricRecord(null, queries, queries, totalOps,
      '操作者显式查询次数；状态轮询不计入。'), 'count'],
    ['claims', '抢票提交数', metricRecord(null, claims, claims, totalOps,
      '所有参与者提交抢票操作的累计次数。'), 'count'],
    ['accepted', '受理占位 / 登记', metricRecord(null, accepted, accepted, claims || null,
      '受理并形成占位或登记的操作次数；不等同于最终确认票数。'), 'count'],
    ['requestsPerConfirmed', '每张确认票请求成本',
      metricRecord(requestsMetric, confirmed ? claims / confirmed : null,
        requestsMetric && requestsMetric.numerator !== undefined ? requestsMetric.numerator : claims,
        requestsMetric && requestsMetric.denominator !== undefined ? requestsMetric.denominator : confirmed,
        '抢票请求数除以确认出票数；反映仿真请求成本。'), 'number'],
    ['averageQueueMs', '平均排队时间', metricRecord(null, averageQueue,
      totalQueue, started || null, '服务队列中的平均等待时间。'), 'ms'],
    ['p95QueueMs', 'P95 排队时间', metricRecord(null, health.p95QueueMs,
      null, null, '排队等待时间的第 95 百分位；分位统计不按分子除以分母计算。'), 'ms'],
    ['averageLatencyMs', '平均模拟请求用时', metricRecord(null, averageLatency,
      totalLatency, totalOps || null, '模拟请求链路耗时；不代表真实网络性能。'), 'ms'],
    ['averageProcessingMs', '实际业务处理耗时',
      metricRecord(null, averageProcessing, totalProcessing, totalOps || null, '服务代码实际测得的业务处理时间，不含排队和模拟上行延迟。'), 'ms'],
    ['falsePositiveRate', '群众处置暴露率',
      metricRecord(metrics.falsePositiveRate, null, null, null,
        '已发起有效业务请求的群众中，受到慢处理或拒绝处置的人数比例代理；不表示精准识别率。'), 'percent'],
    ['botInterceptionRate', '程序拦截暴露率',
      metricRecord(metrics.botInterceptionRate, null, null, null,
        '已发起有效业务请求的程序独立购票人中，受到限流或风险处置的人数比例。'), 'percent'],
    ['interceptionRate', '整体处置暴露率',
      metricRecord(metrics.interceptionRate, null, null, null,
        '已发起有效业务请求的独立购票人中，受到限流或风险处置的人数比例。'), 'percent'],
    ['botAdvantage', '程序相对获票率', metricRecord(null, botAdvantage, null, null,
      '程序独立购票人获票率除以群众独立购票人获票率；任一组人数为零或群众获票率为零时不计算。'), 'multiple'],
    ['paymentTimeoutRate', '支付超时率',
      metricRecord(metrics.paymentTimeoutRate, null, null, null,
        '占位后未在付款时限内完成确认的比例；会受模拟弃付概率和排队影响。'), 'percent']
  ].map(([key, label, info, type]) => ({ key, label, info, type }));

  const channels = number(health.workers, number(snapshot.config && snapshot.config.workers, defaults.workers));
  $('queueCapacity').textContent = '当前队列深度 ' + count(health.queueDepth) +
    ' · 占用通道 ' + count(health.activeWorkers) + ' / ' + count(channels);
  const signature = JSON.stringify(cards.map((card) => [card.key, card.info]));
  if (signature === metricsKey) return;
  metricsKey = signature;
  $('metricsGrid').innerHTML = cards.map((card) =>
    '<article class="metric-card"><span>' + esc(card.label) +
    '</span><strong>' + esc(metricText(card.info.value, card.type)) +
    '</strong><small>' + (card.type === 'count' ? '累计计数' : card.type === 'multiple' ? '按独立购票人计算；群众获票率为零或人数为空时不计算' : card.key === 'p95QueueMs' ? '分位统计，不按比例计算' : '分子 ' + fraction(card.info.numerator) + ' / 分母 ' + (number(card.info.denominator, 0) > 0 ? fraction(card.info.denominator) : '—')) + '</small></article>'
  ).join('');
  $('metricDefinitions').innerHTML = cards.map((card) =>
    '<div class="definition-row"><b>' + esc(card.label) +
    '</b><span>' + esc(card.info.definition) +
    '</span><small>' + (card.type === 'count' ? '累计计数' : card.type === 'multiple' ? '按独立购票人计算；群众获票率为零或人数为空时不计算' : card.key === 'p95QueueMs' ?
    '分位统计，不按比例计算' : '分子 ' + fraction(card.info.numerator) + ' · 分母 ' +
    (number(card.info.denominator, 0) > 0 ? fraction(card.info.denominator) : '—')) +
    '</small></div>'
  ).join('');
}

function renderWaitlist(snapshot, manual) {
  const entries = Array.isArray(snapshot.waitlist && snapshot.waitlist.entries)
    ? snapshot.waitlist.entries.slice()
    : (snapshot.actors || []).filter((actor) => actor.status === 'waiting').map((actor) => ({
      personId: actor.personId || actor.id, rank: actor.waitlistRank || actor.rank,
      registeredAt: actor.registeredAt, group: actor.group, accountIds: actor.accountIds
    }));
  entries.sort((a, b) => number(a.rank, 999999) - number(b.rank, 999999));
  const waitlist = snapshot.waitlist || {};
  const size = number(waitlist.size, entries.length);
  const policy = waitlist.policy === 'server-registration-order'
    ? '服务端登记生效顺序'
    : (snapshot.mode === 'lottery' ? '窗口截止后随机排序' : '按服务端登记顺序');
  const signature = JSON.stringify([snapshot.mode, size, policy, entries, manual.waitlistRank, manual.rank]);
  if (signature === waitlistKey) return;
  waitlistKey = signature;
  $('waitlistPolicy').textContent = (snapshot.mode === 'lottery' ? '抽签资格 ' : '候补人数 ') +
    count(size) + ' · ' + policy;
  const rank = manual.status === 'waiting' ? (manual.waitlistRank || manual.rank) : null;
  const personal = rank ? '<p class="personal-rank">你的当前排序：第 ' + esc(rank) + ' 位</p>' : '';

  if (!entries.length) {
    const message = snapshot.mode === 'standby'
      ? '目前没有候补登记。先售后候补只在操作者明确登记后生效。'
      : snapshot.mode === 'lottery'
        ? '抽签资格和分配排序将在窗口内登记、窗口关闭后更新。'
        : '当前规则没有候补队列。';
    $('waitlistList').innerHTML = personal + '<div class="empty">' + message + '</div>';
    return;
  }

  $('waitlistList').innerHTML = personal + entries.slice(0, 30).map((entry, index) => {
    const place = entry.rank || index + 1;
    const actor = (snapshot.actors || []).find((item) => (item.personId || item.id) === entry.personId);
    const group = entry.group || (actor && actor.group) || 'crowd';
    const time = entry.registeredAt
      ? new Date(entry.registeredAt).toLocaleTimeString('zh-CN', { hour12: false }) : '时间未提供';
    const accountInfo = Array.isArray(entry.accountIds) ? ' · ' + entry.accountIds.length + ' 个关联账号' : '';
    return '<div class="waitlist-entry"><b>#' + esc(place) +
      '</b><span class="dot ' + esc(group) + '"></span><span class="waitlist-person">' +
      esc(entry.personId || '虚拟身份') + '<small>' + esc(groupNames[group] || '参与者') +
      accountInfo + '</small></span><time>' + esc(time) + '</time></div>';
  }).join('') + (entries.length > 30
    ? '<div class="waitlist-more">另有 ' + count(entries.length - 30) + ' 条登记</div>' : '');
}

function render(snapshot, sequence) {
  const time = number(snapshot.serverTime, 0);
  if (time && lastSnapshotAt && time < lastSnapshotAt) return;
  if (time === lastSnapshotAt && sequence < appliedSequence) return;
  if (time) lastSnapshotAt = time;
  appliedSequence = sequence;
  state = snapshot;
  serverOffset = time ? time - Date.now() : 0;
  $('connection').classList.remove('error');
  $('connection').innerHTML = '<i></i>本地服务已连接';

  const idle = snapshot.status === 'idle';
  const config = idle
    ? Object.assign({}, defaults, configFromForm())
    : Object.assign({}, defaults, snapshot.config || {});
  const groups = snapshot.groups || {};
  const crowd = groups.crowd || {};
  const bot = groups.bot || {};
  const manual = snapshot.manual || {};
  const health = snapshot.health || {};
  const inventory = snapshot.stock || {};
  const stock = {
    total: idle ? number(config.stock, defaults.stock) : number(inventory.total, config.stock),
    available: idle ? number(config.stock, defaults.stock) : number(inventory.available, config.stock),
    held: idle ? 0 : number(inventory.held, 0),
    confirmed: idle ? 0 : number(inventory.confirmed, 0),
    returned: idle ? 0 : number(inventory.returned, 0)
  };
  const actors = Array.isArray(snapshot.actors) ? snapshot.actors : [];

  if (snapshot.roundId && syncedRound !== snapshot.roundId) {
    syncedRound = snapshot.roundId;
    Object.entries(config).forEach(([key, value]) => {
      if ($('settingsForm').elements[key] && value !== undefined) $('settingsForm').elements[key].value = value;
    });
    if (modes[snapshot.mode]) chooseMode(snapshot.mode);
  }
  if (active() && selectedMode !== snapshot.mode) chooseMode(snapshot.mode);

  const labels = {
    idle: '等待开始',
    countdown: '即将开售',
    live: snapshot.mode === 'lottery' && snapshot.windowEndsAt &&
      time < snapshot.windowEndsAt ? '抽签登记中' : '正在售票',
    finished: '本轮已结束'
  };
  $('statusBadge').textContent = labels[snapshot.status] || '实验状态';
  $('statusBadge').classList.toggle('live', snapshot.status === 'live');
  $('available').textContent = count(stock.available);
  $('held').textContent = count(stock.held);
  $('confirmed').textContent = count(stock.confirmed);
  $('returned').textContent = count(stock.returned);
  $('totalStock').textContent = count(stock.total);

  const accounts = idle ? number(config.bots, 0) : number(bot.accounts, config.bots);
  const botPeople = idle ? Math.ceil(number(config.bots, 0) / Math.max(1, number(config.botAccountsPerPerson, 2)))
    : number(bot.participants, Math.ceil(config.bots / Math.max(1, config.botAccountsPerPerson)));
  const crowdPeople = idle ? number(config.crowd, 0) : number(crowd.participants, config.crowd);
  $('roundText').textContent = idle ? '选择规则，开启第一轮'
    : snapshot.roundId + ' · ' + (modes[snapshot.mode] || '实验规则') +
      ' · ' + count(config.stock) + ' 张票 / ' + count(crowdPeople + botPeople + 1) + ' 位独立购票人';

  [
    { key: 'crowd', data: crowd, people: crowdPeople, accountCount: idle ? crowdPeople : number(crowd.accounts, crowdPeople) },
    { key: 'bot', data: bot, people: botPeople, accountCount: accounts }
  ].forEach((item) => {
    const confirmedCount = number(item.data.confirmed, 0);
    $(item.key + 'Count').textContent = count(item.accountCount) + ' 账号 · ' + count(item.people) + ' 人';
    $(item.key + 'Wins').innerHTML = count(confirmedCount) + '<small>张已出票</small>';
    $(item.key + 'Rate').textContent = percent(confirmedCount, item.people);
    $(item.key + 'Requests').textContent = count(item.data.requests) + ' 次提交 / ' + count(item.data.queries) + ' 次查询';
    $(item.key + 'Bar').style.width = (item.people > 0
      ? Math.min(100, confirmedCount / item.people * 100) : 0) + '%';
    document.querySelector('.' + item.key + '-card').classList
      .toggle('active', snapshot.status === 'live');
    if (item.key === 'crowd') $('crowdHolds').textContent = count(item.data.held) + ' 人待确认';
    if (item.key === 'bot') $('botLimited').textContent = count(item.data.limited) + ' 次处置';
  });

  $('manualMessage').textContent = manual.message || '你和所有参与者使用同一库存与规则。';
  $('manualHint').textContent = manual.status === 'refunded'
    ? '已退票，本轮不能再次购票；回售批次请查看库存和现场事件。'
    : manual.status === 'confirmed'
    ? '订单已确认；如需退出，可使用一次已付款退票。'
    : manual.status === 'held'
      ? '你已获得占位，请在时限内确认订单或取消资格。'
      : snapshot.mode === 'standby'
        ? '先售后候补需要单独登记；候补不占库存，获得占位后请及时确认。'
        : snapshot.mode === 'lottery'
          ? '提交抢票会登记一个抽签资格；重复提交不会增加机会。'
          : '查询只显示当时快照，不预留库存；提交抢票不要求先查询。';

  displayIdentity(manual, actors);
  renderQuery(manual, stock.available);
  renderManualOrder(manual);
  renderWaitlist(snapshot, manual);
  drawMap(stock, actors);
  renderEvents();
  renderHistory();
  drawChart();
  renderMetrics(snapshot, groups, health, stock, config);
  updateRule();
  refreshButtons();
  tick();
}

function renderManualOrder(manual) {
  const status = manual.refundedAt ? 'refunded' : (manual.status || 'idle');
  const refunded = status === 'refunded' || Boolean(manual.refundedAt);
  const now = Date.now() + serverOffset;
  if (status === 'held') {
    const remaining = manual.expiresAt
      ? Math.max(0, (Number(manual.expiresAt) - now) / 1000).toFixed(1) : '—';
    $('manualOrder').textContent = '订单 ' + (manual.orderId || '已生成') +
      ' · 请在 ' + remaining + ' 秒内确认';
  } else if (status === 'confirmed') {
    $('manualOrder').textContent = '订单 ' + (manual.orderId || '已确认') + ' · 已出票';
  } else if (refunded) {
    $('manualOrder').textContent = '订单 ' + (manual.orderId || '已退票') + ' · 已退票';
  } else if (manual.status === 'waiting' && (manual.waitlistRank || manual.rank)) {
    $('manualOrder').textContent = '候补 / 抽签排序：第 ' + (manual.waitlistRank || manual.rank) + ' 位';
  } else {
    $('manualOrder').textContent = '';
  }
}

function tick() {
  if (!state) return;
  const config = state.status === 'idle'
    ? configFromForm() : Object.assign({}, defaults, state.config || {});
  const now = Date.now() + serverOffset;
  let left = 0;
  let label = '距离开售';
  if (state.status === 'idle') {
    left = number(config.countdown, 0);
  } else if (state.status === 'countdown') {
    left = Math.max(0, (number(state.saleAt, now) - now) / 1000);
  } else if (state.status === 'live') {
    const windowOpen = state.mode === 'lottery' && now < number(state.windowEndsAt, 0);
    left = Math.max(0, (number(windowOpen ? state.windowEndsAt : state.endsAt, now) - now) / 1000);
    label = windowOpen ? '抽签登记倒计时' : '本轮剩余时间';
  } else {
    label = '本轮已结束';
  }
  const seconds = Math.floor(left);
  $('timerLabel').textContent = label;
  $('timer').innerHTML = String(Math.floor(seconds / 60)).padStart(2, '0') + ':' +
    String(seconds % 60).padStart(2, '0') + '<span>.' + Math.floor(left * 10) % 10 + '</span>';
  if (state.manual) renderManualOrder(state.manual);
}

function drawMap(stock, actors) {
  const allocated = actors.filter((actor) =>
    actor.status === 'confirmed' || actor.status === 'held')
    .sort((a, b) => text(a.group).localeCompare(text(b.group)));
  const signature = JSON.stringify([stock, allocated]);
  if (signature === mapKey) return;
  mapKey = signature;
  const cells = allocated.map((actor) => {
    const status = actor.status === 'held' ? 'pending' : 'confirmed';
    const owner = actor.accountId || actor.deviceId || '';
    const title = (actor.personId || actor.id || '虚拟购票人') + ' · ' +
      (actor.status === 'held' ? '待确认' : '已出票') + (owner ? ' · 归属 ' + owner : '');
    return '<span class="ticket-cell ' + esc(actor.group || '') + ' ' + status +
      '" title="' + esc(title) + '"></span>';
  });
  for (let i = 0; i < stock.returned; i += 1) {
    cells.push('<span class="ticket-cell returned" title="退票待批次再售"></span>');
  }
  for (let i = 0; i < stock.available; i += 1) {
    cells.push('<span class="ticket-cell free" title="当前可售"></span>');
  }
  const occupied = allocated.length + stock.returned + stock.available;
  for (let i = occupied; i < stock.total; i += 1) {
    cells.push('<span class="ticket-cell free" title="库存状态待同步"></span>');
  }
  $('ticketMap').innerHTML = cells.slice(0, stock.total).join('');
}

function renderEvents() {
  if (!state) return;
  const filter = $('logFilter').value;
  const events = Array.isArray(state.events) ? state.events : [];
  const key = [state.roundId, events.length, events.at(-1) && events.at(-1).id, filter].join('|');
  if (key === eventKey) return;
  eventKey = key;
  const visible = events.filter((event) => filter === 'all' ||
    (filter === 'system' ? !event.group : event.group === filter)).slice(-70).reverse();
  $('eventLog').innerHTML = visible.length ? visible.map((event) => {
    const group = event.group || 'system';
    const time = Number.isFinite(Number(event.time))
      ? new Date(Number(event.time)).toLocaleTimeString('zh-CN', { hour12: false }) : '';
    return '<div class="event"><time>' + esc(time) + '</time><span class="event-group">' +
      '<i class="dot ' + esc(group) + '"></i>' + esc(groupNames[group] || groupNames.system) +
      '</span><span class="message">' + esc(event.message) + '</span></div>';
  }).join('') : '<div class="empty">暂无此类事件。操作发生后，这里会实时更新。</div>';
}

function renderHistory() {
  if (!state) return;
  const history = Array.isArray(state.history) ? state.history : [];
  const key = JSON.stringify(history);
  if (key === historyKey) return;
  historyKey = key;
  if (!history.length) {
    $('historyBody').innerHTML =
      '<tr><td colspan="9" class="empty">完整运行一轮后，可在这里对照结果；重置会保留已完成轮次。</td></tr>';
    return;
  }
  $('historyBody').innerHTML = history.map((round) => {
    const groups = round.groups || {};
    const crowd = groups.crowd || {};
    const bot = groups.bot || {};
    const manual = groups.manual || {};
    const config = Object.assign({}, defaults, round.config || {});
    const crowdPeople = number(crowd.participants, config.crowd);
    const botPeople = number(bot.participants, Math.ceil(config.bots / Math.max(1, config.botAccountsPerPerson)));
    const accounts = number(bot.accounts, config.bots);
    const metrics = round.metrics || {};
    const health = round.health || {};
    const requestMetric = metrics.requestsPerConfirmed;
    const confirmed = number(manual.confirmed, 0) + number(crowd.confirmed, 0) + number(bot.confirmed, 0);
    const cost = requestMetric && requestMetric.value !== undefined
      ? metricText(requestMetric.value, 'number')
      : (number(round.requests, 0) && confirmed > 0
        ? (number(round.requests, 0) / confirmed).toFixed(2) : '—');
    const queries = number(crowd.queries, 0) + number(bot.queries, 0) + number(manual.queries, 0);
    const crowdRate = round.crowdRate !== undefined
      ? (number(round.crowdRate, 0) * 100).toFixed(1) + '%' : percent(crowd.confirmed, crowdPeople);
    const botRate = round.botRate !== undefined
      ? (number(round.botRate, 0) * 100).toFixed(1) + '%' : percent(bot.confirmed, botPeople);
    const result = number(manual.refunds, 0) > 0 || manual.status === 'refunded' ? '已退票'
      : number(manual.confirmed, 0) > 0 ? '已获票' : '未获票';
    return '<tr><td><b>' + esc(round.roundId || '—') + '</b> · ' +
      esc(modes[round.mode] || round.mode || '—') + '</td><td>' + count(config.stock) +
      ' / ' + count(crowdPeople) + ' / ' + count(botPeople) + '</td><td>' +
      count(accounts) + '</td><td>' + crowdRate + '</td><td>' + botRate + '</td><td>' +
      cost + '</td><td>' + count(queries) + ' / ' + count(round.requests) +
      '</td><td>' + (Number.isFinite(Number(health.p95QueueMs)) ? ms(health.p95QueueMs) : '—') +
      '</td><td>' + result + '</td></tr>';
  }).join('');
}

function drawChart() {
  if (!state) return;
  const timeline = Array.isArray(state.timeline) ? state.timeline : [];
  const last = timeline.at(-1) || {};
  const key = [state.roundId, timeline.length, last.requests, last.t].join('|');
  if (key === chartKey) return;
  chartKey = key;
  const width = 650;
  const height = 170;
  const left = 30;
  const right = 12;
  const top = 12;
  const bottom = 25;
  const data = timeline.filter((item) => number(item.t, -1) >= 0);
  const maxY = Math.max(5, number(state.stock && state.stock.total, 30));
  const maxX = Math.max(5, number(data.at(-1) && data.at(-1).t, 0));
  const x = (time) => left + (width - left - right) * time / maxX;
  const y = (countValue) => height - bottom - (height - top - bottom) * countValue / maxY;
  let svg = '<svg viewBox="0 0 ' + width + ' ' + height +
    '" role="img" aria-label="各组当前有效确认出票数量随时间变化">';
  for (let i = 0; i <= 4; i += 1) {
    const value = maxY * i / 4;
    svg += '<line x1="' + left + '" y1="' + y(value) + '" x2="' + (width - right) +
      '" y2="' + y(value) + '" stroke="#edf1e9" stroke-dasharray="3 4"></line>' +
      '<text x="' + (left - 8) + '" y="' + (y(value) + 3) +
      '" text-anchor="end">' + Math.round(value) + '</text>';
  }
  for (let i = 0; i <= 4; i += 1) {
    const value = maxX * i / 4;
    svg += '<text x="' + x(value) + '" y="' + (height - 5) +
      '" text-anchor="middle">' + value.toFixed(0) + 's</text>';
  }
  [['crowd', '#7397c9'], ['bot', '#dc9a67'], ['manual', '#246c50']].forEach(([group, color]) => {
    const points = [x(0) + ',' + y(0)].concat(data.map((item) =>
      x(item.t) + ',' + y(item[group]))).join(' ');
    svg += '<polyline points="' + points + '" fill="none" stroke="' + color +
      '" stroke-width="2.3" stroke-linejoin="round"></polyline>';
  });
  if (!data.some((item) => number(item.crowd, 0) + number(item.bot, 0) +
      number(item.manual, 0) > 0)) {
    svg += '<text x="340" y="76" text-anchor="middle">出票后，曲线会在这里生长。</text>';
  }
  $('chart').innerHTML = svg + '</svg>';
}

async function poll() {
  if (polling) return;
  polling = true;
  const sequence = ++requestSequence;
  try {
    const response = await fetch('/api/state', { cache: 'no-store' });
    if (!response.ok) throw new Error();
    render(await response.json(), sequence);
  } catch {
    $('connection').classList.add('error');
    $('connection').innerHTML = '<i></i>服务未连接 · 正在重试';
  } finally {
    polling = false;
  }
}

chooseMode('fcfs');
refreshIdleCounts();
poll();
setInterval(poll, 350);
setInterval(tick, 100);
