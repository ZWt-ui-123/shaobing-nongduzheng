/* ============================================================================
 * 哨兵 SepsisGuard —— 动态监护页脚本（live.js）
 * ----------------------------------------------------------------------------
 * 本页对应第三条数据通路：**连续仿真的动态后端**。
 *
 * 它要回答的问题是「数据持续流入时，系统怎么工作」：
 *   * 虚拟时间可以推进 / 暂停 / 快进，几秒钟就能走完数天病程；
 *   * 风险分数随病程连续演化，告警在真实时点被触发、被抑制；
 *   * 每位患者都有一份**自己的观察日志（时间线）**，按时间顺序累积。
 *
 * 评分、分级、抑制、时间线全部走与真实接入**完全相同**的后端代码，
 * 因此这里看到的行为就是接上真实后端后的行为。
 * ========================================================================== */
(function (global) {
  'use strict';

  var API_BASE = String(global.SEPSISGUARD_API || '').replace(/\/+$/, '');
  var Charts = global.SGCharts;

  var LEVEL_COLOR = (Charts && Charts.LEVEL_COLOR) || {
    normal: '#22c55e', low: '#38bdf8', medium: '#eab308', high: '#f97316',
    critical: '#ef4444'
  };
  var LEVEL_LABEL = { normal: '正常', low: '低风险', medium: '中风险', high: '高风险', critical: '极高风险' };

  /* 详情里默认展示的指标（按临床关注度排序） */
  var DETAIL_VARS = [
    'HR', 'O2Sat', 'Resp', 'Temp', 'SBP', 'MAP', 'Lactate', 'Creatinine',
    'WBC', 'Platelets', 'BUN', 'FiO2'
  ];
  var VAR_ZH = {
    HR: { name: '心率', unit: '次/分' }, O2Sat: { name: '血氧饱和度', unit: '%' },
    Resp: { name: '呼吸频率', unit: '次/分' }, Temp: { name: '体温', unit: '℃' },
    SBP: { name: '收缩压', unit: 'mmHg' }, MAP: { name: '平均动脉压', unit: 'mmHg' },
    DBP: { name: '舒张压', unit: 'mmHg' }, Lactate: { name: '乳酸', unit: 'mmol/L' },
    Creatinine: { name: '肌酐', unit: 'mg/dL' }, WBC: { name: '白细胞', unit: '10⁹/L' },
    Platelets: { name: '血小板', unit: '10⁹/L' }, BUN: { name: '尿素氮', unit: 'mg/dL' },
    FiO2: { name: '吸入氧浓度', unit: '' }
  };

  var State = {
    patients: [],
    scenarios: [],
    summary: null,
    selected: null,
    detail: null,
    playing: false,
    timer: null,
    view: 'all',
    query: '',
    sort: 'risk',
    lastAdvance: null,
    engineReady: false,
    replaying: false,
    maxHour: 0
  };

  /* ------------------------------------------------------------------ *
   * DOM 助手
   * ------------------------------------------------------------------ */
  function $(id) { return document.getElementById(id); }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  function fmt(value, digits) {
    if (value === null || value === undefined || value === '') return '—';
    var num = Number(value);
    if (!isFinite(num)) return '—';
    return num.toFixed(digits === undefined ? 0 : digits);
  }

  function pct(value, digits) {
    if (value === null || value === undefined) return '—';
    var num = Number(value);
    if (!isFinite(num)) return '—';
    return (num * 100).toFixed(digits === undefined ? 1 : digits) + '%';
  }

  function escapeHtml(text) {
    return String(text === null || text === undefined ? '' : text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function hourLabel(hour, withDays) {
    var h = Number(hour) || 0;
    if (!withDays) return '第 ' + h + ' 小时';
    return '第 ' + h + ' 小时（' + (h / 24).toFixed(1) + ' 天）';
  }

  /* ------------------------------------------------------------------ *
   * HTTP
   * ------------------------------------------------------------------ */
  /* ------------------------------------------------------------------ *
   * 数据访问：全部经 SGBridge
   * ------------------------------------------------------------------
   * 本页**不直接 fetch**。SGBridge 会自动判断当前该走后端服务还是浏览器
   * 内置仿真内核：
   *   * 后端可用 → 用后端的真实模型产物；
   *   * 后端不可用（例如直接双击打开本页）→ 用页面内置的仿真内核，
   *     功能完整、可交互、可视化，不显示"初始化失败"。
   * 唯一例外是「数据接入」里的真实系统对接，那确实需要一个服务进程。
   * ------------------------------------------------------------------ */
  function request(path, options) {
    return global.SGBridge.route(path, options);
  }

  function setConn(mode, text) {
    var box = $('connBox');
    if (!box) return;
    box.classList.remove('is-online', 'is-offline', 'is-error');
    if (mode) box.classList.add('is-' + mode);
    $('connText').textContent = text;
  }

  /**
   * 刷新"数据来源"徽标。
   *
   * 这一页的患者队列与病程**本来就是我们自己模拟的**，因此后端不在也照样能跑
   * （走浏览器内置仿真内核）。界面必须把"当前用的是哪条来源"说清楚，
   * 否则使用者会分不清"这是内置仿真"还是"这是接了真实后端的模型输出"。
   */
  function renderSourceBadge(payload) {
    var flag = $('flagSource');
    if (!flag) return;
    var bridge = global.SGBridge;
    var builtin = bridge && bridge.isBuiltin();
    var modelReady = payload && payload.model_ready;
    if (builtin) {
      flag.textContent = '数据来源：浏览器内置仿真';
      flag.style.color = '#fde047';
      flag.style.borderColor = 'rgba(234, 179, 8, 0.5)';
      flag.title = '患者队列与病程由页面自身生成，不依赖任何外部服务；' +
        '风险分数来自公开可核对的临床偏离度规则评分（非模型输出）';
    } else {
      flag.textContent = modelReady ? '数据来源：后端服务（LightGBM）' : '数据来源：后端服务（规则回退）';
      flag.style.color = '';
      flag.style.borderColor = '';
      flag.title = '已连接后端推理服务';
    }
  }

  /* ------------------------------------------------------------------ *
   * 引擎生命周期
   * ------------------------------------------------------------------ */
  function startEngine(restart) {
    var payload = {
      n_patients: Math.max(10, Math.min(1000, parseInt($('nPatients').value, 10) || 100)),
      scenario: $('scenarioSelect').value || 'icu',
      seed: restart ? Math.floor(Math.random() * 1e8) : 20260214,
      mix_scenarios: $('mixScenarios').checked,
      warmup_hours: 24
    };
    $('resetBtn').disabled = true;
    $('heroSentence').textContent = '正在启动动态监护引擎（' + payload.n_patients + ' 位患者）…';

    return request('/api/live/start', { method: 'POST', body: payload })
      .then(function (data) {
        $('resetBtn').disabled = false;
        State.engineReady = true;
        State.summary = data.summary || {};
        State.selected = null;
        State.detail = null;
        closeDrawer();
        $('flagModel').textContent = data.model_ready
          ? '模型：LightGBM（已加载）'
          : (data.source === 'builtin' ? '评分：内置临床规则' : '模型：临床规则回退');
        $('navModel').textContent = '模型：' + (data.model_ready ? 'LightGBM' : '内置规则');
        renderSourceBadge(data);
        setConn('online', data.source === 'builtin' ? '内置仿真运行中' : '引擎运行中');
        return refreshAll();
      })
      .catch(function (err) {
        $('resetBtn').disabled = false;
        State.engineReady = false;
        $('heroSentence').innerHTML =
          '<span class="hl-critical">引擎启动失败</span>：' + escapeHtml(err.message);
        setConn('error', '引擎不可用');
        throw err;
      });
  }

  function advance(hours) {
    if (!State.engineReady) return Promise.resolve();
    return request('/api/live/advance', { method: 'POST', body: { hours: hours, rescore: true } })
      .then(function (data) {
        State.lastAdvance = data;
        State.maxHour = data.max_hour;
        $('flagPerf').textContent = '推进耗时：' +
          fmt(data.advance_seconds, 3) + 's + 评分 ' + fmt(data.score_seconds, 3) + 's';
        $('tkThroughput').textContent = fmt(data.hours_per_second, 0);
        setConn('online', '推流中');
        return refreshAll();
      })
      .catch(function (err) {
        setConn('error', '推进失败');
        $('heroNote').textContent = '推进失败：' + err.message;
        pause();
      });
  }

  /**
   * 回放定位：移动时间游标（不生成新数据、不重新评分）。
   * @param {object} body {hour} | {rewind_hours} | {reset:true}
   */
  function seek(body) {
    if (!State.engineReady) return Promise.resolve();
    pause();
    return request('/api/live/seek', { method: 'POST', body: body })
      .then(function (data) {
        State.maxHour = data.max_hour;
        $('heroNote').textContent = data.note || '';
        return refreshAll();
      })
      .catch(function (err) {
        $('heroNote').textContent = '回放定位失败：' + err.message;
      });
  }

  function play() {
    if (!State.engineReady) {
      startEngine(false).then(function () { play(); });
      return;
    }
    State.playing = true;
    $('playBtn').innerHTML = '❚❚ 暂停推流';
    $('playBtn').classList.remove('is-primary');
    // 用 setTimeout 自定步而非 setInterval 定时：
    // 100 位患者推进 2 小时约需数秒（特征工程占绝大部分），若按固定间隔
    // 发请求，请求会排队堆积、界面延迟越来越大。自定步保证"上一次推进
    // 完成后才发下一次"，界面始终跟得上，并且真实反映引擎速度。
    tick();
  }

  function tick() {
    if (!State.playing) return;
    var speed = parseInt($('speedSelect').value, 10) || 2;
    advance(speed).then(function () {
      if (State.playing) State.timer = global.setTimeout(tick, 260);
    });
  }

  function pause() {
    State.playing = false;
    if (State.timer) { global.clearTimeout(State.timer); State.timer = null; }
    $('playBtn').innerHTML = '▶ 开始推流';
    $('playBtn').classList.add('is-primary');
  }

  function togglePlay() { if (State.playing) pause(); else play(); }

  /* ------------------------------------------------------------------ *
   * 汇总与态势
   * ------------------------------------------------------------------ */
  function refreshAll() {
    return Promise.all([loadPatients(), loadSummary()]).then(function () {
      renderAll();
    });
  }

  function loadPatients() {
    return request('/api/live/patients?limit=1000')
      .then(function (data) {
        State.patients = (data && data.patients) || [];
        State.currentHour = data.current_hour;
        State.maxHour = data.max_hour;
        State.replaying = !!data.replaying;
        State.modelReady = data.model_ready;
        renderReplayFlag();
        setConn('online', '引擎运行中');
      })
      .catch(function (err) {
        setConn('error', '读取患者失败');
        $('heroNote').textContent = '读取患者列表失败：' + err.message;
      });
  }

  /** 回放状态提示与控制按钮可用性。 */
  function renderReplayFlag() {
    var flag = $('flagReplay');
    if (!flag) return;
    var hour = State.currentHour === undefined ? 0 : State.currentHour;
    var max = State.maxHour === undefined ? hour : State.maxHour;
    if (State.replaying) {
      flag.textContent = '回放中：第 ' + hour + ' / ' + max + ' 小时';
      flag.style.color = '#fde047';
      flag.style.borderColor = 'rgba(234, 179, 8, 0.5)';
    } else {
      flag.textContent = '实时（最新第 ' + max + ' 小时）';
      flag.style.color = '';
      flag.style.borderColor = '';
    }
    var canBack = hour > 0;
    ['rew1', 'rew6', 'rew24', 'rewindAll'].forEach(function (id) {
      var node = $(id);
      if (node) node.disabled = !canBack;
    });
    var latest = $('toLatest');
    if (latest) latest.disabled = !State.replaying;
  }

  function loadSummary() {
    return Promise.all([
      request('/api/live/state'),
      request('/api/live/events?limit=60')
    ]).then(function (res) {
      State.summary = res[0] || {};
      State.events = res[1] || { alerts: [], engine_events: [] };
      if (State.selected) return loadDetail(State.selected, true);
    }).catch(function () { /* 单次失败不清空已有内容 */ });
  }

  function visiblePatients() {
    var rows = State.patients.slice();
    var q = State.query.trim().toLowerCase();
    if (q) {
      rows = rows.filter(function (r) {
        return r.patient_id.toLowerCase().indexOf(q) >= 0 ||
               String(r.bed || '').toLowerCase().indexOf(q) >= 0;
      });
    }
    if (State.view === 'high') {
      rows = rows.filter(function (r) { return r.risk_level === 'high' || r.risk_level === 'critical'; });
    } else if (State.view === 'rising') {
      rows = rows.filter(function (r) { return Number(r.trend_delta) > 0.02; });
    } else if (State.view === 'deteriorating') {
      rows = rows.filter(function (r) { return r.course === 'deteriorating'; });
    } else if (State.view === 'onset') {
      rows = rows.filter(function (r) { return r.has_sepsis_label; });
    }
    if (State.sort === 'risk') rows.sort(function (a, b) { return b.risk_score - a.risk_score; });
    else if (State.sort === 'peak') rows.sort(function (a, b) { return b.peak_risk_score - a.peak_risk_score; });
    else if (State.sort === 'trend') rows.sort(function (a, b) { return b.trend_delta - a.trend_delta; });
    else if (State.sort === 'completeness') {
      rows.sort(function (a, b) { return a.info_completeness - b.info_completeness; });
    } else rows.sort(function (a, b) { return a.patient_id < b.patient_id ? -1 : 1; });
    return rows;
  }

  function renderAll() {
    renderTicker();
    renderHero();
    renderMixStrip();
    renderNavCounts();
    renderTable();
  }

  function renderTicker() {
    var rows = State.patients;
    var hour = State.summary && State.summary.current_hour !== undefined
      ? State.summary.current_hour : State.currentHour;
    $('tkClock').textContent = (hour === undefined || hour === null) ? '—' : hour + ' h';
    $('clockBig').textContent = hourLabel(hour || 0, true) +
      (State.replaying ? '（回放）' : '');
    $('tkPatients').textContent = rows.length;

    var critical = 0, high = 0;
    rows.forEach(function (r) {
      if (r.risk_level === 'critical') critical++;
      else if (r.risk_level === 'high') high++;
    });
    $('tkCritical').textContent = critical;
    $('tkHigh').textContent = high;
    $('tkAlerts').textContent = (State.events && State.events.alerts) ? State.events.alerts.length : 0;
  }

  function renderHero() {
    var rows = State.patients;
    if (!rows.length) {
      $('heroSentence').textContent = '引擎已就绪，等待数据产生。点击「+1 小时」推进时间。';
      $('heroNote').textContent = '——';
      return;
    }
    var high = rows.filter(function (r) { return r.risk_level === 'high' || r.risk_level === 'critical'; });
    var rising = rows.filter(function (r) { return Number(r.trend_delta) > 0.02; });
    var onset = rows.filter(function (r) { return r.has_sepsis_label; });
    var primary = high.length ? high[0] : rows[0];

    var sentence = '当前在监 <span class="hl-accent">' + rows.length + '</span> 位患者，' +
      '其中 <span class="hl-critical">' + high.length + '</span> 位处于高风险及以上，' +
      '<span class="hl-high">' + rising.length + '</span> 位风险正在上升';
    if (onset.length) sentence += '，<span class="hl-critical">' + onset.length + '</span> 位已达到发作判定时点';
    sentence += '。';

    $('heroSentence').innerHTML = sentence;
    $('heroNote').textContent =
      '风险最高：' + primary.patient_id + '（' + primary.bed + ' · ' + primary.scenario_zh +
      '）当前风险 ' + fmt(primary.risk_score, 4) + '，分级「' + primary.risk_level_zh +
      '」，病程「' + primary.course_zh + '」。';

    var completeness = rows.reduce(function (sum, r) { return sum + Number(r.info_completeness || 0); }, 0) / rows.length;
    $('heroFactHigh').textContent = high.length;
    $('heroFactAlerts').textContent = (State.summary && State.summary.total_patient_hours !== undefined)
      ? ((State.events && State.events.alerts) ? State.events.alerts.length : 0) : '—';
    $('heroFactHours').textContent = State.summary ? (State.summary.total_patient_hours || 0) : '—';
    $('heroFactCoverage').textContent = pct(completeness, 0);
  }

  function renderMixStrip() {
    var host = clear($('mixStrip'));
    var summary = State.summary || {};
    var byScenario = summary.by_scenario_zh || {};
    var byCourse = summary.by_course_zh || {};

    Object.keys(byScenario).forEach(function (name) {
      host.appendChild(mixCell(name, byScenario[name], '场景'));
    });
    Object.keys(byCourse).forEach(function (name) {
      host.appendChild(mixCell(name, byCourse[name], '病程'));
    });
    if (!host.childNodes.length) {
      host.appendChild(el('div', 'dim', '尚无分布数据。'));
    }
  }

  function mixCell(label, value, kind) {
    var cell = el('div', 'vital-cell');
    cell.appendChild(el('div', 'vital-cell-label', label));
    cell.appendChild(el('div', 'vital-cell-value', value));
    cell.appendChild(el('div', 'vital-cell-sub', kind));
    return cell;
  }

  function renderNavCounts() {
    var rows = State.patients;
    $('navCountAll').textContent = rows.length;
    $('navCountHigh').textContent = rows.filter(function (r) {
      return r.risk_level === 'high' || r.risk_level === 'critical';
    }).length;
    $('navCountRising').textContent = rows.filter(function (r) {
      return Number(r.trend_delta) > 0.02;
    }).length;
    $('navCountDeter').textContent = rows.filter(function (r) {
      return r.course === 'deteriorating';
    }).length;
    $('navCountOnset').textContent = rows.filter(function (r) { return r.has_sepsis_label; }).length;
  }

  /* ------------------------------------------------------------------ *
   * 患者表
   * ------------------------------------------------------------------ */
  function renderTable() {
    var body = clear($('tableBody'));
    var rows = visiblePatients();
    $('tableEmpty').style.display = rows.length ? 'none' : '';

    rows.forEach(function (row) {
      var tr = document.createElement('tr');
      tr.dataset.pid = row.patient_id;
      if (row.risk_level === 'critical') tr.classList.add('row-critical');
      else if (row.risk_level === 'high') tr.classList.add('row-high');
      if (State.selected === row.patient_id) tr.classList.add('is-selected');

      var tdId = el('td', 'cell-id');
      tdId.appendChild(el('div', null, row.patient_id));
      tdId.appendChild(el('div', 'faint', row.bed + ' · ' +
        fmt(row.age, 0) + ' 岁' + (row.gender_zh || '')));
      tr.appendChild(tdId);

      tr.appendChild(el('td', null, row.scenario_zh || row.scenario));

      var tdCourse = el('td');
      tdCourse.appendChild(el('span', null, row.course_zh || row.course));
      if (row.severity !== undefined) {
        tdCourse.appendChild(el('div', 'faint', '严重度 ' + fmt(row.severity, 2)));
      }
      tr.appendChild(tdCourse);

      var tdRisk = el('td', 'num risk-cell');
      var row1 = el('div', 'row1');
      row1.appendChild(el('span', 'badge is-' + (row.risk_level === 'normal' ? 'low' : row.risk_level),
        row.risk_level_zh));
      row1.appendChild(el('span', 'mono', fmt(row.risk_score, 4)));
      tdRisk.appendChild(row1);
      tr.appendChild(tdRisk);

      tr.appendChild(el('td', 'num', fmt(row.peak_risk_score, 4)));

      var delta = Number(row.trend_delta || 0);
      var tdTrend = el('td', 'num');
      tdTrend.appendChild(el('span', delta > 0.001 ? 'num-pos' : (delta < -0.001 ? 'num-neg' : 'faint'),
        (delta > 0 ? '+' : '') + fmt(delta, 4)));
      tr.appendChild(tdTrend);

      var tdSpark = el('td');
      var canvas = document.createElement('canvas');
      canvas.className = 'risk-spark';
      canvas.width = 150; canvas.height = 26;
      tdSpark.appendChild(canvas);
      tr.appendChild(tdSpark);

      var tdComp = el('td', 'num');
      var comp = Number(row.info_completeness || 0);
      tdComp.appendChild(el('span', comp >= 0.7 ? 'num-neg' : (comp >= 0.25 ? '' : 'num-pos'),
        pct(comp, 0)));
      if (row.confidence_discount !== undefined) {
        tdComp.appendChild(el('div', 'faint', '折减 ' + fmt(row.confidence_discount, 2)));
      }
      tr.appendChild(tdComp);

      tr.appendChild(el('td', null,
        row.has_sepsis_label ? '第 ' + row.onset_hour + ' 小时' :
          (row.onset_hour !== null && row.onset_hour !== undefined ? '预计第 ' + row.onset_hour + ' 小时' : '无')));

      tr.addEventListener('click', function () { selectPatient(row.patient_id); });
      body.appendChild(tr);

      // 迷你轨迹：必须在 canvas 进入 DOM 后绘制
      if (row.spark && row.spark.length) {
        var color = LEVEL_COLOR[row.risk_level] || '#38bdf8';
        if (Charts) Charts.sparkline(canvas, row.spark, { color: color });
      }
    });

    $('footRange').textContent = '显示 ' + rows.length + ' / ' + State.patients.length + ' 位患者';
    if (State.lastAdvance) {
      $('footPerf').textContent =
        '上次推进 ' + State.lastAdvance.advanced_hours + ' 小时 · 新增评分 ' +
        State.lastAdvance.new_scores + ' 次 · ' + fmt(State.lastAdvance.hours_per_second, 0) + ' 小时/秒';
    }
    $('panelSub').textContent = '按' +
      ({ risk: '当前风险', peak: '峰值风险', trend: '风险增速',
         completeness: '信息完整度', id: '患者编号' }[State.sort] || '当前风险') +
      '排序 · 虚拟时间第 ' + ((State.summary && State.summary.current_hour) || 0) + ' 小时';

    renderScenarioGroups();
  }

  /* ------------------------------------------------------------------ *
   * 监护场景分区
   *
   * 每个场景一个区块，只列该场景的在监患者；人数与高危数直接由患者列表统计，
   * 不依赖推进摘要，因此任何时刻都与上方清单一致。
   * ------------------------------------------------------------------ */
  function scenarioProfile(key) {
    for (var i = 0; i < State.scenarios.length; i++) {
      if (State.scenarios[i].key === key) return State.scenarios[i];
    }
    return null;
  }

  function levelBadge(row) {
    var level = row.risk_level === 'normal' ? 'low' : row.risk_level;
    return el('span', 'badge is-' + level, row.risk_level_zh || row.risk_level);
  }

  function renderScenarioGroups() {
    var host = $('scenarioGrid');
    if (!host) return;
    clear(host);

    var groups = {};
    var order = [];
    (State.scenarios || []).forEach(function (s) {
      if (!groups[s.key]) { groups[s.key] = []; order.push(s.key); }
    });
    State.patients.forEach(function (row) {
      var key = row.scenario || 'icu';
      if (!groups[key]) { groups[key] = []; order.push(key); }
      groups[key].push(row);
    });

    var filled = 0;
    order.forEach(function (key) {
      var list = groups[key] || [];
      var profile = scenarioProfile(key);
      var name = profile ? profile.name_zh : ((list[0] && list[0].scenario_zh) || key);
      var high = list.filter(function (r) {
        return r.risk_level === 'high' || r.risk_level === 'critical';
      }).length;
      var mean = list.length
        ? list.reduce(function (sum, r) { return sum + Number(r.risk_score || 0); }, 0) / list.length
        : 0;
      if (list.length) filled += 1;

      var block = el('div', 'scen-block');
      var head = el('div', 'scen-head');
      head.appendChild(el('span', 'scen-name', name));
      head.appendChild(el('span', 'scen-count', list.length + ' 位'));
      var highTag = el('span', 'scen-tag', '高危 ' + high);
      if (high) highTag.classList.add('is-high');
      head.appendChild(highTag);
      head.appendChild(el('span', 'scen-mean', '平均风险 ' + fmt(mean, 4)));
      if (profile) {
        head.appendChild(el('span', 'scen-meta',
          '生命体征 ' + (profile.vital_interval_hours ? profile.vital_interval_hours + ' h' : '—') +
          ' · 检验 ' + (profile.lab_interval_hours ? profile.lab_interval_hours + ' h' : '不采血') +
          ' · 完整度 ' + pct(profile.info_completeness)));
      }
      block.appendChild(head);

      if (!list.length) {
        block.appendChild(el('div', 'scen-empty', '该场景暂无在监患者'));
      } else {
        var table = document.createElement('table');
        table.className = 'grid is-compact';
        var thead = document.createElement('thead');
        thead.innerHTML = '<tr><th>患者 / 床号</th><th class="num">当前风险</th>' +
          '<th>等级</th><th>病程</th><th class="num">峰值</th></tr>';
        table.appendChild(thead);
        var tbody = document.createElement('tbody');
        list.forEach(function (row) {
          var tr = document.createElement('tr');
          if (row.risk_level === 'critical') tr.classList.add('row-critical');
          else if (row.risk_level === 'high') tr.classList.add('row-high');

          var tdId = el('td', 'cell-id');
          tdId.appendChild(el('div', null, row.patient_id));
          tdId.appendChild(el('div', 'faint', (row.bed || '') + ' · ' + fmt(row.age, 0) + ' 岁'));
          tr.appendChild(tdId);

          tr.appendChild(el('td', 'num mono', fmt(row.risk_score, 4)));

          var tdLevel = el('td');
          tdLevel.appendChild(levelBadge(row));
          tr.appendChild(tdLevel);

          tr.appendChild(el('td', null, row.course_zh || row.course || '—'));
          tr.appendChild(el('td', 'num', fmt(row.peak_risk_score, 4)));

          tr.addEventListener('click', function () { selectPatient(row.patient_id); });
          tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        var wrap = el('div', 'scen-body');
        wrap.appendChild(table);
        block.appendChild(wrap);
      }
      host.appendChild(block);
    });

    var sub = $('scenarioSub');
    if (sub) {
      sub.textContent = State.patients.length + ' 位在监患者，分布在 ' + filled + ' 个场景';
    }
  }

  /* ------------------------------------------------------------------ *
   * 患者详情抽屉（含该患者自己的病程观察日志）
   * ------------------------------------------------------------------ */
  function selectPatient(patientId) {
    State.selected = patientId;
    renderTable();
    openDrawer();
    $('drawerTitle').textContent = patientId;
    $('drawerSub').textContent = '正在读取该患者的病程时间线…';
    clear($('drawerBody')).appendChild(el('div', 'dim', '加载中…'));
    loadDetail(patientId, false);
  }

  function loadDetail(patientId, silent) {
    return request('/api/live/patients/' + encodeURIComponent(patientId) + '?window_hours=168')
      .then(function (data) {
        State.detail = data;
        $('drawerSub').textContent =
          (data.scenario_zh || data.scenario) + ' · ' + data.unit + ' · ' +
          fmt(data.age, 0) + ' 岁' + (data.gender === 1 ? '男' : '女') + ' · ' +
          (data.course_zh || data.course) + ' · 严重度 ' + fmt(data.severity, 2);
        renderDetail(data);
      })
      .catch(function (err) {
        if (!silent) {
          clear($('drawerBody')).appendChild(
            el('div', 'result-box is-fail', '读取患者详情失败：' + err.message));
        }
      });
  }

  function renderDetail(d) {
    var host = clear($('drawerBody'));

    /* --- KPI --- */
    var risks = d.risk_history || {};
    var hours = Object.keys(risks).map(Number).sort(function (a, b) { return a - b; });
    var current = hours.length ? risks[hours[hours.length - 1]] : 0;
    var peak = hours.length ? Math.max.apply(null, hours.map(function (h) { return risks[h]; })) : 0;
    var peakHour = hours.length ? hours.reduce(function (best, h) {
      return risks[h] > risks[best] ? h : best;
    }, hours[0]) : 0;
    var level = levelOf(current);

    var kpi = el('div', 'kpi-row');
    kpi.appendChild(kpiCell('当前风险', fmt(current, 4), LEVEL_LABEL[level]));
    kpi.appendChild(kpiCell('峰值风险', fmt(peak, 4), '第 ' + peakHour + ' 小时'));
    kpi.appendChild(kpiCell('已监护', (d.current_hour || 0) + ' h',
      ((d.current_hour || 0) / 24).toFixed(1) + ' 天'));
    kpi.appendChild(kpiCell('信息完整度', pct(completenessOf(d), 0), '按场景可测比例'));
    host.appendChild(section('概览', kpi));

    /* --- 风险轨迹 --- */
    var chartBox = el('div', 'chart-box');
    var canvas = document.createElement('canvas');
    canvas.width = 720; canvas.height = 220;
    chartBox.appendChild(canvas);
    var legend = el('div', 'chart-legend');
    legend.innerHTML =
      '<span class="legend-chip"><i style="background:' + (LEVEL_COLOR[level] || '#38bdf8') +
      '"></i>风险分数（0~1）</span>' +
      '<span class="legend-chip"><i style="background:#ef4444"></i>告警时点</span>' +
      (d.onset_hour !== null && d.onset_hour !== undefined
        ? '<span class="legend-chip"><i style="background:rgba(239,68,68,.45)"></i>达到判定时点（第 ' +
          d.onset_hour + ' 小时）</span>' : '');
    chartBox.appendChild(legend);
    host.appendChild(section('风险演化轨迹', chartBox));

    // 先挂到 DOM 再绘图，否则 canvas 尺寸为 0
    global.setTimeout(function () {
      var alertsHere = ((State.events && State.events.alerts) || []).filter(function (a) {
        return a.patient_id === d.patient_id;
      });
      var markers = alertsHere.map(function (a) {
        return { hour: a.trigger_time, label: '告警 ' + a.level_zh, color: LEVEL_COLOR[a.level] || '#ef4444' };
      });
      var bands = [];
      if (d.onset_hour !== null && d.onset_hour !== undefined) {
        bands.push({ from: d.onset_hour, to: d.current_hour, color: 'rgba(239,68,68,0.10)', label: '发作期' });
      }
      if (Charts) {
        Charts.lineChart(canvas, {
          hours: hours,
          series: [{
            key: 'risk', name: '风险分数', values: hours.map(function (h) { return risks[h]; }),
            color: LEVEL_COLOR[level] || '#38bdf8', unit: ''
          }],
          yMin: 0, yMax: 1, yLabel: '风险分数', xLabel: '监护小时',
          fill: true, markers: markers, bands: bands, xTickCount: 10
        });
      }
    }, 40);

    /* --- 关键指标 --- */
    var vars = (d.timeseries && d.timeseries.variables) || {};
    var vitalHost = el('div');
    DETAIL_VARS.forEach(function (key) {
      var series = vars[key];
      if (!series || !series.length) return;
      var last = null, lastIndex = -1;
      for (var i = series.length - 1; i >= 0; i--) {
        if (series[i] !== null && series[i] !== undefined) { last = series[i]; lastIndex = i; break; }
      }
      if (last === null) return;
      var missingHours = series.length - 1 - lastIndex;

      var item = el('div', 'attr-item');
      var top = el('div', 'attr-top');
      top.appendChild(el('span', 'attr-name', (VAR_ZH[key] || {}).name || key));
      var valueSpan = el('span', 'mono', fmt(last, 2) + ((VAR_ZH[key] || {}).unit ? ' ' + VAR_ZH[key].unit : ''));
      top.appendChild(valueSpan);
      item.appendChild(top);

      var canvas2 = document.createElement('canvas');
      canvas2.className = 'risk-spark';
      canvas2.width = 320; canvas2.height = 34;
      item.appendChild(canvas2);
      item.appendChild(el('div', 'faint',
        '窗口内 ' + series.filter(function (v) { return v !== null; }).length + ' 次测量' +
        (missingHours > 0 ? '，最近一次距今 ' + missingHours + ' 小时' : '，本小时已测量')));
      vitalHost.appendChild(item);

      global.setTimeout(function () {
        if (Charts) Charts.sparkline(canvas2, series.filter(function (v) { return v !== null; }),
          { color: '#38bdf8' });
      }, 40);
    });
    if (vitalHost.childNodes.length) {
      host.appendChild(section('关键指标时序（最近 168 小时）', vitalHost));
    }

    /* --- 病程观察日志（该患者自己的时间线） --- */
    var logHost = el('div');
    var timeline = (d.timeline || []).slice().sort(function (a, b) { return a.hour - b.hour; });
    if (timeline.length) {
      var tl = el('div', 'timeline');
      timeline.forEach(function (item) {
        var kind = item.kind || 'note';
        var node = el('div', 'tl-item is-' + kind);
        node.appendChild(el('span', 'tl-hour', 'T+' + item.hour + 'h'));
        node.appendChild(el('span', 'tl-msg', item.message || ''));
        tl.appendChild(node);
      });
      logHost.appendChild(tl);
      var actions = el('div', 'config-actions');
      var btn = el('button', 'btn is-ghost', '导出该患者观察日志');
      btn.addEventListener('click', function () { exportTimeline(d); });
      actions.appendChild(btn);
      logHost.appendChild(actions);
    } else {
      logHost.appendChild(el('div', 'dim', '该患者暂无观察日志。'));
    }
    host.appendChild(section('病程观察日志（本患者独立记录）', logHost));

    /* --- 处置建议 --- */
    var advice = el('div');
    var rec = recommendation(level, current, d);
    advice.appendChild(el('div', 'attr-phrase', rec.action));
    var ul = el('ul', 'gap-list');
    rec.reasons.forEach(function (t) { ul.appendChild(el('li', 'gap-item', t)); });
    advice.appendChild(ul);
    host.appendChild(section('处置建议（辅助，不替代临床判断）', advice));
  }

  function section(title, node) {
    var wrap = el('div', 'dsec');
    var head = el('div', 'dsec-head');
    head.appendChild(el('div', 'dsec-title', title));
    wrap.appendChild(head);
    wrap.appendChild(node);
    return wrap;
  }

  function kpiCell(label, value, ref) {
    var cell = el('div', 'kpi');
    cell.appendChild(el('div', 'kpi-label', label));
    cell.appendChild(el('div', 'kpi-value', value));
    if (ref) cell.appendChild(el('div', 'kpi-ref', ref));
    return cell;
  }

  function levelOf(score) {
    var s = Number(score) || 0;
    if (s >= 0.82) return 'critical';
    if (s >= 0.62) return 'high';
    if (s >= 0.35) return 'medium';
    if (s >= 0.12) return 'low';
    return 'normal';
  }

  function completenessOf(d) {
    for (var i = 0; i < State.scenarios.length; i++) {
      if (State.scenarios[i].key === d.scenario) return State.scenarios[i].info_completeness;
    }
    return 0;
  }

  function recommendation(level, score, d) {
    var reasons = [];
    var vars = (d.timeseries && d.timeseries.variables) || {};
    function last(key) {
      var s = vars[key];
      if (!s) return null;
      for (var i = s.length - 1; i >= 0; i--) if (s[i] !== null && s[i] !== undefined) return s[i];
      return null;
    }
    var lactate = last('Lactate'), sbp = last('SBP'), o2 = last('O2Sat'),
        resp = last('Resp'), hr = last('HR'), temp = last('Temp');

    if (lactate !== null && lactate >= 2.0) reasons.push('乳酸 ' + fmt(lactate, 2) + ' mmol/L 升高，提示组织灌注不足');
    if (sbp !== null && sbp < 100) reasons.push('收缩压 ' + fmt(sbp, 0) + ' mmHg 偏低，需评估容量状态');
    if (o2 !== null && o2 < 94) reasons.push('血氧饱和度 ' + fmt(o2, 0) + '% 低于目标区间');
    if (resp !== null && resp >= 22) reasons.push('呼吸频率 ' + fmt(resp, 0) + ' 次/分，存在呼吸代偿');
    if (hr !== null && hr >= 110) reasons.push('心率 ' + fmt(hr, 0) + ' 次/分，循环负荷增加');
    if (temp !== null && (temp >= 38.3 || temp <= 36.0)) reasons.push('体温 ' + fmt(temp, 1) + '℃ 偏离正常范围');
    if (!reasons.length) reasons.push('当前指标未见明确异常偏离，维持现有监测频次');

    var action;
    if (level === 'critical') {
      action = '建议立即床旁评估：复核感染灶、启动/调整抗感染方案，评估液体复苏与升压支持，并复查乳酸与器官功能指标。';
    } else if (level === 'high') {
      action = '建议 1 小时内完成临床评估：完善感染相关检查（血培养、乳酸、器官功能），评估是否需要升级监护。';
    } else if (level === 'medium') {
      action = '建议提高监测频次并复查关键检验，记录液体出入量，4–6 小时后重新评估风险。';
    } else {
      action = '维持常规监测。若出现意识改变、尿量减少或指标持续偏离，及时复评。';
    }
    return { action: action, reasons: reasons };
  }

  function exportTimeline(d) {
    var lines = [
      '# 患者病程观察日志',
      '',
      '- 患者编号：' + d.patient_id,
      '- 监护场景：' + (d.scenario_zh || d.scenario),
      '- 床号：' + d.unit,
      '- 年龄/性别：' + fmt(d.age, 0) + ' 岁 / ' + (d.gender === 1 ? '男' : '女'),
      '- 病程类型：' + (d.course_zh || d.course),
      '- 已监护时长：' + d.current_hour + ' 小时',
      '- 导出时间：' + new Date().toLocaleString('zh-CN'),
      '- 数据来源：内置连续仿真引擎（动态监护后端）',
      '',
      '| 时间 | 类型 | 记录 |',
      '| --- | --- | --- |'
    ];
    (d.timeline || []).slice().sort(function (a, b) { return a.hour - b.hour; })
      .forEach(function (item) {
        var kindZh = { admission: '入院', onset: '病情变化', intervention: '临床干预',
                       alert: '告警', note: '记录', error: '异常' }[item.kind] || item.kind;
        lines.push('| T+' + item.hour + 'h | ' + kindZh + ' | ' +
          String(item.message || '').replace(/\|/g, '／') + ' |');
      });
    lines.push('', '> 本系统输出的是风险提示，不构成医疗诊断，临床决策请遵医嘱。');

    var blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = d.patient_id + '_病程观察日志.md';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    global.setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  /* ------------------------------------------------------------------ *
   * 抽屉控制
   * ------------------------------------------------------------------ */
  function openDrawer() {
    $('drawer').classList.add('is-open');
    $('drawer').setAttribute('aria-hidden', 'false');
    $('drawerBackdrop').classList.add('is-open');
  }

  function closeDrawer() {
    $('drawer').classList.remove('is-open');
    $('drawer').setAttribute('aria-hidden', 'true');
    $('drawerBackdrop').classList.remove('is-open');
    State.selected = null;
    renderTable();
  }

  /* ------------------------------------------------------------------ *
   * 事件绑定
   * ------------------------------------------------------------------ */
  function boot() {
    $('playBtn').addEventListener('click', togglePlay);
    $('step1').addEventListener('click', function () { pause(); advance(1); });
    $('step6').addEventListener('click', function () { pause(); advance(6); });
    $('step24').addEventListener('click', function () { pause(); advance(24); });
    $('rew1').addEventListener('click', function () { seek({ rewind_hours: 1 }); });
    $('rew6').addEventListener('click', function () { seek({ rewind_hours: 6 }); });
    $('rew24').addEventListener('click', function () { seek({ rewind_hours: 24 }); });
    $('rewindAll').addEventListener('click', function () { seek({ reset: true }); });
    $('toLatest').addEventListener('click', function () {
      seek({ hour: State.maxHour === undefined ? 0 : State.maxHour });
    });
    $('resetBtn').addEventListener('click', function () {
      pause();
      startEngine(true).catch(function () {});
    });
    $('refreshBtn').addEventListener('click', function () { refreshAll(); });
    $('drawerClose').addEventListener('click', closeDrawer);
    $('drawerBackdrop').addEventListener('click', closeDrawer);

    $('searchInput').addEventListener('input', function (ev) {
      State.query = ev.target.value;
      renderTable();
    });
    $('sortSelect').addEventListener('change', function (ev) {
      State.sort = ev.target.value;
      renderTable();
    });
    $('speedSelect').addEventListener('change', function () {
      $('flagPerf').textContent = '推流速度：每次推进 ' + $('speedSelect').value +
        ' 小时（实际节奏取决于引擎耗时）';
    });

    Array.prototype.forEach.call(document.querySelectorAll('.nav-item[data-view]'), function (node) {
      node.addEventListener('click', function () {
        Array.prototype.forEach.call(document.querySelectorAll('.nav-item[data-view]'), function (n) {
          n.classList.remove('is-active');
        });
        node.classList.add('is-active');
        State.view = node.dataset.view;
        renderTable();
      });
    });

    document.addEventListener('keydown', function (ev) {
      if (ev.target && /INPUT|SELECT|TEXTAREA/.test(ev.target.tagName)) return;
      if (ev.key === 'Escape') closeDrawer();
      if (ev.key === ' ') { ev.preventDefault(); togglePlay(); }
    });

    $('setActiveBtn').addEventListener('click', function () {
      var bridge = global.SGBridge;
      if (bridge && bridge.isBuiltin()) {
        // 内置模式下"设为当前数据源"没有意义：整个平台的仿真数据都在页面里，
        // 不存在"把某个外部来源切过来"这回事。如实说明，不假装成功。
        $('flagActive').textContent = '当前数据源：内置仿真';
        $('navSource').textContent = '数据源：内置仿真';
        $('heroNote').textContent = '当前为内置仿真，无需切换数据源。';
        return;
      }
      request('/api/sources/activate', {
        method: 'POST',
        body: { kind: 'live', address: '', token: '', timeout_seconds: 10, label: '' }
      }).then(function (data) {
        $('flagActive').textContent = '当前数据源：动态仿真后端';
        $('navSource').textContent = '数据源：动态仿真后端';
        $('heroNote').textContent = data.message || '已切换为动态仿真后端。';
      }).catch(function (err) {
        $('heroNote').textContent = '切换数据源失败：' + err.message;
      });
    });

    setConn('offline', '检测数据来源…');

    Promise.all([
      request('/api/live/scenarios'),
      request('/api/sources/active')
    ]).then(function (res) {
      State.scenarios = (res[0] && res[0].scenarios) || [];
      var select = clear($('scenarioSelect'));
      var def = (res[0] && res[0].default) || 'icu';
      State.scenarios.forEach(function (s) {
        var opt = document.createElement('option');
        opt.value = s.key;
        opt.textContent = s.name_zh;
        if (s.key === def) opt.selected = true;
        select.appendChild(opt);
      });
      renderScenarioGroups();
      var state = (res[1] && res[1].state) || {};
      $('flagActive').textContent = '当前数据源：' + (state.active_source || '—');
      $('navSource').textContent = '数据源：' + (state.active_source || '—');

      return request('/api/live/state');
    }).then(function (state) {
      if (state && state.running) {
        State.engineReady = true;
        $('flagModel').textContent = state.model_ready
          ? '模型：LightGBM（已加载）'
          : (state.source === 'builtin' ? '评分：内置临床规则' : '模型：临床规则回退');
        $('navModel').textContent = '模型：' + (state.model_ready ? 'LightGBM' : '内置规则');
        renderSourceBadge(state);
        setConn('online', state.source === 'builtin' ? '内置仿真运行中' : '引擎已就绪');
        return refreshAll();
      }
      return startEngine(false);
    }).catch(function (err) {
      // 走到这里说明是**真正的异常**（内置内核也起不来），不是"没启动后端"。
      // 内置仿真不依赖任何外部服务，因此不该再把责任推给"后端未启动"。
      var builtin = global.SGBridge && global.SGBridge.isBuiltin();
      setConn('error', '引擎异常');
      $('heroSentence').innerHTML =
        '<span class="hl-critical">引擎异常</span>：' + escapeHtml(err.message);
      $('heroNote').textContent = builtin
        ? '本页使用浏览器内置仿真内核，正常情况下不需要任何外部服务。' +
          '若持续异常，请刷新页面；仍不行说明浏览器环境受限（例如禁用了本地存储），' +
          '可改用 scripts\\start_windows.bat 启动后端服务后访问。'
        : '已连接后端服务但初始化失败，请查看服务端日志。';
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window);
