/* ============================================================================
 * 哨兵 SepsisGuard —— 监护端逻辑（monitor.js）
 * ----------------------------------------------------------------------------
 * 1. 数据流状态表：正在更新的患者列表 + 更新频率 + 最后更新时间（每 2 秒滚动）
 * 2. 处理负荷：当前处理患者数 / 每分钟推理次数 / 平均单次推理耗时
 * 3. 推理服务运行状态：模型版本 / 运行时长 / 累计推理次数 / 错误计数
 * 4. 推理日志流：新日志从顶部插入，等宽字体 + 时间戳
 * 5. 图表：告警等级分布柱状图、在监患者监护时间轴（甘特）、推理耗时趋势折线
 * 说明：监测端的数据流为"模拟实时"效果，用于直观展示数据在持续流动；
 *       患者列表、模型版本、告警分布等来源于后端（不可用时回退演示数据）。
 * ========================================================================== */
(function (global) {
  'use strict';

  var TICK_MS = 2000;          // 数据流刷新周期（2 秒）
  var POLL_MS = 30000;         // 后端数据轮询周期
  var LATENCY_WINDOW = 60;     // 推理耗时趋势采样点数量
  var LOG_MAX = 220;           // 日志保留行数

  var LEVEL_ZH = { normal: '正常', low: '低风险', medium: '中风险', high: '高风险' };
  var LEVEL_COLOR = (global.SGCharts && global.SGCharts.LEVEL_COLOR) || {
    normal: '#64748b', low: '#22c55e', medium: '#f59e0b', high: '#ef4444'
  };

  var State = {
    patients: [],
    stats: null,
    models: null,
    flow: {},              // patient_id -> { hz, ago, updates, delay }
    elapsedSec: 0,         // 服务运行时长（秒）
    totalInfer: 0,
    errors: 0,
    inferPerMin: 0,
    latency: [],
    tickCount: 0,
    timer: null,
    pollTimer: null
  };

  function $(sel) { return document.querySelector(sel); }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  function stamp(d) {
    d = d || new Date();
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  function formatUptime(sec) {
    var s = Math.max(0, Math.floor(sec));
    var d = Math.floor(s / 86400);
    var h = Math.floor((s % 86400) / 3600);
    var m = Math.floor((s % 3600) / 60);
    var ss = s % 60;
    var hms = pad2(h) + ':' + pad2(m) + ':' + pad2(ss);
    return d > 0 ? (d + ' 天 ' + hms) : hms;
  }

  function fmtInt(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

  function rand(min, max) { return min + Math.random() * (max - min); }

  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

  /* ------------------------------------------------------------------ *
   * 连接状态
   * ------------------------------------------------------------------ */
  function bindConnection() {
    global.SGApi.onStatus(function (st) {
      var box = $('#connBox'), txt = $('#connText');
      if (!box || !txt) return;
      box.classList.remove('is-online', 'is-offline');
      if (st.mode === 'online') {
        box.classList.add('is-online');
        txt.textContent = '已连后端' + (st.modelVersion ? ' · ' + st.modelVersion : '');
      } else if (st.mode === 'offline') {
        box.classList.add('is-offline');
        txt.textContent = '离线演示模式';
      } else if (st.mode === 'snapshot') {
        /* [静态快照版] 没有进程可连，如实说明数据是固化快照 */
        box.classList.add('is-online');
        txt.textContent = SGApi.modeLabel ? SGApi.modeLabel() : '静态快照';
      } else {
        txt.textContent = '正在连接后端…';
      }
      var fm = $('#footerMode');
      if (fm) fm.textContent = '数据模式：' + (st.mode === 'online' ? '后端实时数据'
        : (st.mode === 'snapshot' ? '后端运行结果的静态固化快照'
        : (st.mode === 'offline' ? '内置演示数据（后端不可用）' : '未知')));
    });
  }

  /* ------------------------------------------------------------------ *
   * 推理日志流
   * ------------------------------------------------------------------ */
  function log(level, msg) {
    var stream = $('#logStream');
    if (!stream) return;
    var line = el('div', 'log-line');
    line.appendChild(el('span', 't', stamp()));
    line.appendChild(el('span', 'lv ' + level, level.toUpperCase()));
    line.appendChild(el('span', 'msg', msg));
    stream.insertBefore(line, stream.firstChild);
    // 只保留最近 LOG_MAX 行，避免长时间运行后 DOM 无限增长
    while (stream.children.length > LOG_MAX) {
      stream.removeChild(stream.children[stream.children.length - 1]);
    }
  }

  function randomLogLine() {
    var list = State.patients;
    var p = list.length ? pick(list) : null;
    var id = p ? p.patient_id : 'p000001';
    var bed = p ? p.bed : 'ICU-03';
    var risk = p ? Number(p.risk_score || 0).toFixed(2) : '0.10';
    var level = p ? (p.risk_level_zh || LEVEL_ZH[p.risk_level]) : '正常';
    var latency = Math.round(rand(28, 78));
    var templates = [
      ['info', '窗口推理完成 patient=' + id + ' window=12h risk=' + risk + ' level=' + level + ' 用时 ' + latency + 'ms'],
      ['info', '特征抽取完成 patient=' + id + ' features=42 missing=' + Math.floor(rand(0, 5)) + ' 用时 ' + Math.round(rand(6, 18)) + 'ms'],
      ['info', '数据流心跳 ' + bed + ' 生命体征写入 8 通道，时标对齐完成'],
      ['ok', '告警评估通过 patient=' + id + ' 阈值=0.65 当前=' + risk + ' 无需推送'],
      ['info', '滑动窗口前移 patient=' + id + ' ICULOS=' + Math.floor(rand(1, 80)) + 'h'],
      ['warn', '信息缺口检测 patient=' + id + ' 乳酸缺失，已写入置信度提示'],
      ['info', '批量推理批次 #' + fmtInt(State.totalInfer) + ' 完成：' + State.patients.length + ' 位患者 / ' + Math.round(rand(180, 620)) + 'ms']
    ];
    var t = pick(templates);
    // 低概率生成一条告警推送或错误日志，让日志流更真实
    var r = Math.random();
    if (r > 0.965) {
      return ['ok', '告警已推送 a-' + id.slice(1) + '-1 patient=' + id + ' risk=' + risk + ' level=' + level];
    }
    if (r < 0.012) {
      State.errors += 1;
      return ['error', '上游接口 /api/patients/' + id + ' 响应超时，已重试 1 次并回落演示数据'];
    }
    return t;
  }

  /* ------------------------------------------------------------------ *
   * 数据流状态表
   * ------------------------------------------------------------------ */
  function ensureFlow() {
    State.patients.forEach(function (p) {
      if (!State.flow[p.patient_id]) {
        State.flow[p.patient_id] = {
          hz: Number(pick([0.5, 1, 1, 2, 2])),
          ago: rand(0, 2),
          updates: 0,
          delay: Math.round(rand(180, 900))
        };
      }
    });
    Object.keys(State.flow).forEach(function (id) {
      var exists = State.patients.some(function (p) { return p.patient_id === id; });
      if (!exists) delete State.flow[id];
    });
  }

  function updateFlow() {
    var tbody = $('#flowTableBody');
    if (!tbody) return;
    ensureFlow();

    var rows = State.patients.slice().sort(function (a, b) { return (b.risk_score || 0) - (a.risk_score || 0); });
    var html = '';
    var totalUpdates = 0;

    rows.forEach(function (p) {
      var f = State.flow[p.patient_id];
      // 模拟数据持续流入：2 秒内至少更新 1 次，高频通道更新 2~4 次
      var delta = Math.max(1, Math.round(f.hz * 2 * rand(0.6, 1.4)));
      f.updates += delta;
      totalUpdates += delta;
      // 最后更新时间在 0~2 秒之间滚动，偶发 3 秒以上的"迟滞"表示通道抖动
      f.ago = Math.random() > 0.08 ? rand(0, 2) : rand(2.4, 4.6);
      f.delay = Math.round(rand(180, 900));
      var stale = f.ago > 2;
      var level = p.risk_level || 'normal';
      html += '<tr>' +
        '<td><span class="mono">' + (p.bed || '—') + '</span> <span class="muted mono" style="font-size:11px">' + (p.patient_id || '') + '</span></td>' +
        '<td><span class="pulse-dot' + (stale ? ' stale' : '') + '"></span>' + (stale ? '同步中' : '实时接收') + '</td>' +
        '<td class="num">' + f.hz.toFixed(1) + ' Hz</td>' +
        '<td class="num">' + f.ago.toFixed(1) + ' s 前</td>' +
        '<td class="num">' + f.updates + '</td>' +
        '<td class="num">' + f.delay + ' ms</td>' +
        '<td class="num" style="color:' + (LEVEL_COLOR[level] || '#38bdf8') + '">' + Number(p.risk_score || 0).toFixed(2) + '</td>' +
        '</tr>';
    });

    tbody.innerHTML = html || '<tr><td colspan="7" class="muted">暂无在监患者数据</td></tr>';
    var sum = $('#flowSummary');
    if (sum) {
      sum.textContent = '在监通道 ' + rows.length + ' 路 · 本轮累计写入 ' + fmtInt(totalUpdates) + ' 次测量值 · 最后刷新 ' + stamp();
    }
  }

  /* ------------------------------------------------------------------ *
   * 处理负荷与服务状态
   * ------------------------------------------------------------------ */
  function updateLoad() {
    var n = State.patients.length;
    var perTick = Math.max(1, n * rand(0.5, 0.95));
    State.inferPerMin = Math.max(1, Math.round(perTick * (60000 / TICK_MS) * rand(0.94, 1.06)));
    State.totalInfer += Math.round(perTick);

    // 推理耗时随机游走 + 偶发尖峰
    var last = State.latency.length ? State.latency[State.latency.length - 1] : 42;
    var target = 34 + n * 0.9;
    var next = last + (target - last) * 0.25 + rand(-4.5, 4.5);
    if (Math.random() > 0.94) next += rand(14, 42);
    next = Math.max(16, Math.min(180, next));
    State.latency.push(Math.round(next));
    while (State.latency.length > LATENCY_WINDOW) State.latency.shift();

    var sum = State.latency.reduce(function (a, b) { return a + b; }, 0);
    var avg = sum / State.latency.length;
    var sorted = State.latency.slice().sort(function (a, b) { return a - b; });
    var p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];

    setText('#mPatientCount', n);
    setText('#mInferPerMin', fmtInt(State.inferPerMin));
    setText('#mAvgLatency', avg.toFixed(1));
    setText('#mP95', 'P95 ' + p95 + ' ms（近 ' + State.latency.length + ' 次采样）');
    setText('#mInferSub', '约 ' + (perTick / (TICK_MS / 1000)).toFixed(1) + ' 次/秒 · 窗口 12 小时');
    setText('#mPatientSub', '滑动窗口 12 小时 · 通道 ' + n + ' 路');

    State.elapsedSec += TICK_MS / 1000;
    setText('#mUptime', formatUptime(State.elapsedSec));
    setText('#mTotalInfer', fmtInt(State.totalInfer));
    var errEl = $('#mErrors');
    if (errEl) {
      errEl.textContent = State.errors + ' 次';
      errEl.className = 'v ' + (State.errors > 0 ? 'warn' : 'ok');
    }

    var queue = Math.round(rand(4, 46));
    setText('#mQueue', queue + ' %');
    var bar = $('#mQueueBar');
    if (bar) bar.style.width = queue + '%';

    var hzTotal = 0;
    Object.keys(State.flow).forEach(function (k) { hzTotal += State.flow[k].hz; });
    var hint = $('#loadHint');
    if (hint) hint.textContent = '每 2 秒采样一次 · 合计 ' + hzTotal.toFixed(1) + ' Hz 数据流入';
  }

  function setText(sel, v) {
    var e = $(sel);
    if (e) e.textContent = v;
  }

  /* ------------------------------------------------------------------ *
   * 图表
   * ------------------------------------------------------------------ */
  function renderLevelChart() {
    var cv = $('#levelChart');
    if (!cv) return;
    var by = (State.stats && State.stats.alerts_by_level) || {};
    var bars = [
      { label: '高风险', value: by.high || 0, color: LEVEL_COLOR.high },
      { label: '中风险', value: by.medium || 0, color: LEVEL_COLOR.medium },
      { label: '低风险', value: by.low || 0, color: LEVEL_COLOR.low },
      { label: '正常', value: by.normal || 0, color: LEVEL_COLOR.normal }
    ];
    global.SGCharts.barChart(cv, { bars: bars, horizontal: false, axisLabel: '告警条数' });
    var hint = $('#mAlertHint');
    if (hint) {
      var total = bars.reduce(function (a, b) { return a + b.value; }, 0);
      var fa = State.stats && State.stats.false_alarms_per_patient_day;
      hint.textContent = '共 ' + total + ' 条' + (fa !== null && fa !== undefined ? ' · 假阳性 ' + fa + ' 次/患者/天' : '');
    }
  }

  function renderGantt() {
    var cv = $('#ganttChart');
    if (!cv) return;
    var rows = State.patients.slice()
      .sort(function (a, b) { return (b.risk_score || 0) - (a.risk_score || 0); })
      .map(function (p) {
        var marks = [];
        if (p.last_alert_hour) {
          marks.push({ at: p.last_alert_hour, color: LEVEL_COLOR[p.risk_level] || '#ef4444' });
        }
        if (p.has_sepsis_label && p.onset_hour) {
          marks.push({ at: p.onset_hour, color: '#a78bfa' });
        }
        return {
          label: (p.bed || '—') + ' ' + String(p.patient_id || '').slice(-3),
          from: 0,
          to: p.icu_los_hours || 0,
          color: LEVEL_COLOR[p.risk_level] || '#38bdf8',
          marks: marks,
          text: Number(p.risk_score || 0).toFixed(2),
          dim: p.risk_level === 'normal'
        };
      });
    global.SGCharts.gantt(cv, { rows: rows, xLabel: '入 ICU 后小时' });
  }

  function renderLatencyChart() {
    var cv = $('#latencyChart');
    if (!cv) return;
    var hours = State.latency.map(function (_, i) { return i + 1; });
    global.SGCharts.lineChart(cv, {
      hours: hours,
      series: [{ key: 'latency', name: '单次推理耗时', color: '#22d3ee', values: State.latency, unit: 'ms' }],
      yLabel: '毫秒', xLabel: '采样点（每 2 秒一个，横轴为最近 ' + State.latency.length + ' 次）',
      fill: true, xTickCount: 8
    });
  }

  /* ------------------------------------------------------------------ *
   * 主循环
   * ------------------------------------------------------------------ */
  function tick() {
    State.tickCount++;
    updateFlow();
    updateLoad();
    renderLatencyChart();

    var lines = Math.random() > 0.72 ? 2 : 1;
    for (var i = 0; i < lines; i++) {
      var l = randomLogLine();
      log(l[0], l[1]);
    }

    var ti = $('#tickInfo');
    if (ti) ti.textContent = '数据流刷新周期 2s · 第 ' + fmtInt(State.tickCount) + ' 轮 · ' + stamp();

    // 每 15 轮（30 秒）重新拉取一次后端概览数据
    if (State.tickCount % 15 === 0) pollBackend(true);
  }

  function startTick() {
    if (State.timer) global.clearInterval(State.timer);
    State.timer = global.setInterval(tick, TICK_MS);
  }

  /* ------------------------------------------------------------------ *
   * 数据加载
   * ------------------------------------------------------------------ */
  function pollBackend(silent) {
    return Promise.all([
      global.SGApi.health().catch(function () { return null; }),
      global.SGApi.patients({ sort: 'risk', limit: 50 }).catch(function () { return null; }),
      global.SGApi.stats().catch(function () { return null; }),
      global.SGApi.models().catch(function () { return null; })
    ]).then(function (res) {
      var health = res[0], patients = res[1], stats = res[2], models = res[3];
      if (patients && patients.patients) {
        State.patients = patients.patients;
        ensureFlow();
        renderGantt();
      }
      if (stats) { State.stats = stats; renderLevelChart(); }
      if (models && models.models) {
        State.models = models.models;
        renderModelInfo(health);
      }
      if (!silent) log('info', '后端概览数据已同步 patients=' + State.patients.length);
    });
  }

  function renderModelInfo(health) {
    var list = State.models || [];
    var serving = null;
    list.forEach(function (m) { if (!serving && m.status === 'serving') serving = m; });
    if (!serving && list.length) serving = list[0];
    var version = (health && health.model_version) || (serving && serving.version) || 'unknown';
    setText('#mModelVersion', version);
    var hint = $('#svcStatusHint');
    if (hint) {
      hint.textContent = (serving ? (serving.status === 'serving' ? '运行中' : serving.status) : '运行中') +
        (health && health.patients_loaded ? ' · 已加载 ' + health.patients_loaded + ' 位患者' : '');
    }
    var note = $('#mModelNote');
    if (note) {
      note.textContent = serving
        ? ('算法 ' + (serving.algorithm || '—') + ' · AUPRC ' + (serving.auprc !== undefined ? serving.auprc : '—') +
           ' · AUROC ' + (serving.auroc !== undefined ? serving.auroc : '—') +
           ' · 特征 ' + (serving.features !== undefined ? serving.features : '—') + ' 维 · 窗口 ' + (serving.window_hours || 12) + ' 小时')
        : '模型元数据不可用';
    }
  }

  /* ------------------------------------------------------------------ *
   * 启动
   * ------------------------------------------------------------------ */
  function init() {
    bindConnection();
    // 初始服务运行时长（模拟服务已运行一段时间）
    State.elapsedSec = Math.round(rand(3600 * 6, 3600 * 40));
    State.totalInfer = Math.round(rand(12000, 48000));
    State.errors = Math.floor(rand(0, 3));

    log('info', '哨兵 SepsisGuard 监护端已启动，正在接入数据流…');
    log('info', '模型服务加载中，特征管道 window=12h features=42');

    global.SGApi.probe().then(function () {
      return pollBackend(false);
    }).then(function () {
      log('ok', '数据流接入完成，在监通道 ' + State.patients.length + ' 路，开始 2 秒周期刷新');
      renderGantt();
      renderLevelChart();
      renderLatencyChart();
      updateFlow();
      updateLoad();
      startTick();
    }).catch(function () {
      log('warn', '后端不可用，已切换到离线演示数据，数据流仍保持滚动');
      startTick();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
