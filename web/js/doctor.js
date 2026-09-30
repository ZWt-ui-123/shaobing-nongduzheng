/* ============================================================================
 * 哨兵 SepsisGuard —— 医生端逻辑（doctor.js）
 * ----------------------------------------------------------------------------
 * 1. 概览统计、排序 / 筛选 / 搜索 / 自动刷新
 * 2. 患者卡片列表（风险降序 + 迷你趋势 + 高风险强调）
 * 3. 患者详情抽屉：风险趋势（告警竖线 + 发作色带）、关键指标时序（缺失断线）、
 *    指标偏离度雷达、风险归因与信息缺口
 * 4. 告警处理：确认 / 忽略（必须选择原因）/ 稍后提醒
 * ========================================================================== */
(function (global) {
  'use strict';

  /* ------------------------------------------------------------------ *
   * 常量与工具
   * ------------------------------------------------------------------ */
  var VITALS = ['HR', 'SBP', 'Resp', 'O2Sat', 'Temp', 'Lactate', 'WBC', 'Creatinine'];

  var VAR_ZH = {
    HR: { name: '心率', unit: '次/分' },
    SBP: { name: '收缩压', unit: 'mmHg' },
    Resp: { name: '呼吸频率', unit: '次/分' },
    O2Sat: { name: '血氧饱和度', unit: '%' },
    Temp: { name: '体温', unit: '℃' },
    Lactate: { name: '乳酸', unit: 'mmol/L' },
    WBC: { name: '白细胞计数', unit: '10³/µL' },
    Creatinine: { name: '肌酐', unit: 'mg/dL' }
  };

  var REF = (global.SGDemo && global.SGDemo.REF) || {
    HR: [60, 100], SBP: [90, 140], Resp: [12, 20], O2Sat: [95, 100],
    Temp: [36.1, 37.5], Lactate: [0.5, 2.0], WBC: [4, 12], Creatinine: [0.5, 1.2]
  };

  var LEVEL_ZH = { normal: '正常', low: '低风险', medium: '中风险', high: '高风险' };
  var STATUS_ZH = { open: '待处理', acknowledged: '已确认', ignored: '已忽略', snoozed: '稍后提醒' };
  var LEVEL_COLOR = (global.SGCharts && global.SGCharts.LEVEL_COLOR) || {
    normal: '#64748b', low: '#22c55e', medium: '#f59e0b', high: '#ef4444'
  };

  var REFRESH_MS = 10000;     // 自动刷新间隔
  var PREFETCH_MAX = 24;      // 离线/在线均最多预取的患者详情数量
  var PREFETCH_CONCURRENCY = 4;

  function $(sel) { return document.querySelector(sel); }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }

  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtTime(d) {
    function p(n) { return n < 10 ? '0' + n : '' + n; }
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function fmtNum(v) {
    return global.SGCharts ? global.SGCharts.fmtNum(v) : String(v);
  }

  /* ------------------------------------------------------------------ *
   * 全局状态
   * ------------------------------------------------------------------ */
  var State = {
    sort: 'risk',
    level: 'all',
    q: '',
    autoRefresh: true,
    timer: null,
    patients: [],
    stats: null,
    detailCache: {},
    sparkCanvas: {},        // patient_id -> 卡片迷你趋势画布（避免依赖 DOM 选择器定位）
    prefetching: {},
    prefetchCount: 0,
    currentId: null,
    currentDetail: null,
    vitalSel: { HR: true, SBP: true, Resp: true, O2Sat: true, Temp: false, Lactate: false, WBC: false, Creatinine: false },
    pendingAlertId: null,
    ignoreReason: '已知病情'
  };

  /* ------------------------------------------------------------------ *
   * 顶部连接状态 & 页脚
   * ------------------------------------------------------------------ */
  function bindConnection() {
    global.SGApi.onStatus(function (st) {
      var box = $('#connBox');
      var txt = $('#connText');
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
      if (fm) {
        fm.textContent = '数据模式：' + (st.mode === 'online' ? '后端实时数据'
          : (st.mode === 'snapshot' ? '后端运行结果的静态固化快照'
          : (st.mode === 'offline' ? '内置演示数据（后端不可用）' : '未知')));
      }
    });
  }

  function toast(title, body, kind) {
    var host = $('#toastHost');
    if (!host) return;
    var t = el('div', 'toast' + (kind ? ' toast-' + kind : ''));
    t.appendChild(el('div', 'toast-title', title));
    if (body) t.appendChild(el('div', 'toast-body', body));
    host.appendChild(t);
    global.setTimeout(function () {
      t.style.transition = 'opacity .3s ease, transform .3s ease';
      t.style.opacity = '0';
      t.style.transform = 'translateX(14px)';
      global.setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 320);
    }, 3600);
  }

  /* ------------------------------------------------------------------ *
   * 概览统计
   * ------------------------------------------------------------------ */
  function setStat(id, value) {
    var e = $(id);
    if (e) e.textContent = value;
  }

  function deriveStats() {
    var list = State.patients;
    var byLevel = { normal: 0, low: 0, medium: 0, high: 0 };
    var open = 0;
    list.forEach(function (p) {
      byLevel[p.risk_level] = (byLevel[p.risk_level] || 0) + 1;
      open += (p.open_alert_count || 0);
    });
    return {
      patients: list.length,
      high_risk_patients: byLevel.high,
      alerts_open: open,
      alerts_total: open,
      alerts_by_level: byLevel,
      false_alarms_per_patient_day: null,
      mean_early_warning_hours: null
    };
  }

  function renderStats() {
    var s = State.stats || deriveStats();
    var derived = deriveStats();

    setStat('#statPatients', s.patients !== undefined && s.patients !== null ? s.patients : derived.patients);
    setStat('#statHigh', s.high_risk_patients !== undefined && s.high_risk_patients !== null ? s.high_risk_patients : derived.high_risk_patients);

    var alertCount = s.alerts_open !== undefined && s.alerts_open !== null ? s.alerts_open
      : (s.alerts_total !== undefined && s.alerts_total !== null ? s.alerts_total : derived.alerts_open);
    setStat('#statAlerts', alertCount);
    var sub = $('#statAlertsSub');
    if (sub) {
      var byLevel = s.alerts_by_level || {};
      sub.textContent = '高风险告警 ' + (byLevel.high || 0) + ' 条 · 中风险 ' + (byLevel.medium || 0) + ' 条';
    }

    var lead = s.mean_early_warning_hours;
    if (lead !== undefined && lead !== null) {
      setStat('#statLead', (Math.round(lead * 10) / 10).toFixed(1));
    } else {
      setStat('#statLead', '—');
    }
    var lsub = $('#statLeadSub');
    if (lsub) {
      var fa = s.false_alarms_per_patient_day;
      lsub.textContent = fa !== undefined && fa !== null
        ? '假阳性 ' + fa + ' 次/患者/天'
        : '相对脓毒症发作时刻';
    }
  }

  /* ------------------------------------------------------------------ *
   * 患者列表
   * ------------------------------------------------------------------ */
  function sortList(list) {
    var arr = list.slice();
    if (State.sort === 'bed') {
      arr.sort(function (a, b) { return String(a.bed).localeCompare(String(b.bed)); });
    } else if (State.sort === 'los') {
      arr.sort(function (a, b) { return (b.icu_los_hours || 0) - (a.icu_los_hours || 0); });
    } else {
      arr.sort(function (a, b) { return (b.risk_score || 0) - (a.risk_score || 0); });
    }
    return arr;
  }

  function visiblePatients() {
    var list = State.patients;
    if (State.level !== 'all') {
      list = list.filter(function (p) { return p.risk_level === State.level; });
    }
    if (State.q) {
      var q = State.q.toLowerCase();
      list = list.filter(function (p) {
        return String(p.patient_id || '').toLowerCase().indexOf(q) >= 0 ||
          String(p.bed || '').toLowerCase().indexOf(q) >= 0;
      });
    }
    return sortList(list);
  }

  function buildCard(p) {
    var level = p.risk_level || 'normal';
    var card = el('div', 'patient-card level-' + level);
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('data-id', p.patient_id);

    card.appendChild(el('div', 'pc-bar'));

    var head = el('div', 'pc-head');
    var left = el('div');
    left.appendChild(el('div', 'pc-bed', p.bed || '—'));
    left.appendChild(el('div', 'pc-id', p.patient_id || '—'));
    head.appendChild(left);
    head.appendChild(el('span', 'pc-badge level-' + level, p.risk_level_zh || LEVEL_ZH[level] || '—'));
    card.appendChild(head);

    var meta = el('div', 'pc-meta');
    meta.appendChild(el('span', null, (p.age !== null && p.age !== undefined ? Math.round(p.age) + ' 岁' : '年龄未知')));
    meta.appendChild(el('span', 'sep', '·'));
    meta.appendChild(el('span', null, p.gender_zh || (p.gender === 0 ? '女' : '男')));
    meta.appendChild(el('span', 'sep', '·'));
    meta.appendChild(el('span', null, 'ICU ' + (p.icu_los_hours || 0) + ' 小时'));
    card.appendChild(meta);

    var mid = el('div', 'pc-mid');
    var riskBox = el('div');
    var riskVal = el('div', 'pc-risk level-' + level);
    riskVal.appendChild(el('span', null, Number(p.risk_score || 0).toFixed(2)));
    riskVal.appendChild(el('span', 'pc-risk-cap', '风险分数'));
    riskBox.appendChild(riskVal);
    mid.appendChild(riskBox);

    var spark = el('div', 'pc-spark');
    var cv = document.createElement('canvas');
    spark.appendChild(cv);
    mid.appendChild(spark);
    card.appendChild(mid);
    State.sparkCanvas[p.patient_id] = cv;   // 记录画布引用，预取完成后直接重绘

    var foot = el('div', 'pc-foot');
    var footLeft = el('div');
    footLeft.appendChild(el('span', null, p.last_alert_time ? '最近告警 ' + p.last_alert_time : '暂无告警'));
    foot.appendChild(footLeft);
    var tags = el('div');
    // 后端按"峰值风险"分级，当前风险已回落时补充标注峰值，避免徽章与分数看起来矛盾
    var peak = Number(p.peak_risk_score);
    if (isFinite(peak) && Math.abs(peak - Number(p.risk_score || 0)) > 0.05) {
      tags.appendChild(el('span', 'tag', '峰值 ' + peak.toFixed(2)));
    }
    if (p.has_sepsis_label) {
      tags.appendChild(el('span', 'tag sepsis', '脓毒症发作' + (p.onset_hour ? ' 第' + p.onset_hour + '小时' : '')));
    }
    if (p.open_alert_count > 0) {
      tags.appendChild(el('span', 'tag open-alert', '待处理告警 ' + p.open_alert_count));
    }
    foot.appendChild(tags);
    card.appendChild(foot);

    // 迷你风险趋势
    var series = p.risk_series || (State.detailCache[p.patient_id] && State.detailCache[p.patient_id].risk_series);
    if (series && series.length > 1) {
      global.SGCharts.sparkline(cv, series, { color: LEVEL_COLOR[level] || '#38bdf8' });
    } else {
      var flat = Number(p.risk_score || 0);
      global.SGCharts.sparkline(cv, [flat * 0.85, flat], { color: LEVEL_COLOR[level] || '#38bdf8', fill: false });
      queuePrefetch(p.patient_id);
    }

    card.addEventListener('click', function () { openDrawer(p.patient_id); });
    card.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openDrawer(p.patient_id); }
    });
    return card;
  }

  function renderGrid() {
    var grid = $('#patientGrid');
    if (!grid) return;
    var list = visiblePatients();
    grid.innerHTML = '';
    State.sparkCanvas = {};   // 卡片重建后旧的画布引用作废
    if (!list.length) {
      grid.appendChild(el('div', 'empty-state',
        State.patients.length ? '没有符合当前筛选条件的患者，请调整风险等级或搜索关键词。' : '暂未获取到患者数据，请点击「立即刷新」重试。'));
    } else {
      list.forEach(function (p) { grid.appendChild(buildCard(p)); });
    }

    var summary = $('#listSummary');
    if (summary) {
      var sortZh = State.sort === 'risk' ? '按风险降序' : (State.sort === 'bed' ? '按床号排序' : '按住院时长排序');
      summary.textContent = '共 ' + State.patients.length + ' 位 · 当前显示 ' + list.length + ' 位 · ' + sortZh;
    }

    var ri = $('#refreshInfo');
    if (ri) ri.textContent = '更新于 ' + fmtTime(new Date()) + (State.autoRefresh ? ' · 自动 ' + (REFRESH_MS / 1000) + 's' : ' · 已暂停');
  }

  /* ------------------------------------------------------------------ *
   * 详情预取（用于卡片迷你趋势；限制并发与总量）
   * ------------------------------------------------------------------ */
  function queuePrefetch(id) {
    if (!id || State.prefetching[id] || State.detailCache[id] || State.prefetchCount >= PREFETCH_MAX) return;
    if (activePrefetch() >= PREFETCH_CONCURRENCY) return;
    State.prefetching[id] = true;
    State.prefetchCount++;
    global.SGApi.patient(id).then(function (d) {
      State.prefetching[id] = false;
      if (d && d.risk_series) {
        State.detailCache[id] = d;
        var cv = State.sparkCanvas[id];
        if (cv && cv.isConnected !== false) {
          var lv = d.patient ? d.patient.risk_level : 'normal';
          global.SGCharts.sparkline(cv, d.risk_series, { color: LEVEL_COLOR[lv] || '#38bdf8' });
        }
      }
      drainPrefetch();
    }).catch(function () {
      State.prefetching[id] = false;
      drainPrefetch();
    });
  }

  function activePrefetch() {
    var n = 0;
    Object.keys(State.prefetching).forEach(function (k) { if (State.prefetching[k]) n++; });
    return n;
  }

  function drainPrefetch() {
    var pending = visiblePatients().filter(function (p) {
      return !State.detailCache[p.patient_id] && !State.prefetching[p.patient_id];
    });
    pending.slice(0, PREFETCH_CONCURRENCY).forEach(function (p) { queuePrefetch(p.patient_id); });
  }

  /* ------------------------------------------------------------------ *
   * 数据加载
   * ------------------------------------------------------------------ */
  function loadPatients(silent) {
    return global.SGApi.patients({ sort: State.sort, limit: 50 }).then(function (data) {
      State.patients = (data && data.patients) || [];
      State.prefetchCount = 0;
      renderGrid();
      renderStats();
      drainPrefetch();
      if (!silent) toast('患者列表已更新', '共 ' + State.patients.length + ' 位在监患者', 'ok');
    }).catch(function () {
      if (!silent) toast('患者列表获取失败', '已保留上一次的数据', 'err');
    });
  }

  function loadStats() {
    return global.SGApi.stats().then(function (s) {
      State.stats = s || null;
      renderStats();
    }).catch(function () { /* 使用派生统计 */ });
  }

  function loadModels() {
    return global.SGApi.models().then(function (m) {
      var list = (m && m.models) || [];
      var serving = null;
      list.forEach(function (x) { if (!serving && x.status === 'serving') serving = x; });
      if (!serving && list.length) serving = list[0];
      var f = $('#footerModel');
      if (f && serving) f.textContent = '模型版本：' + (serving.version || '—');
    }).catch(function () { /* 忽略 */ });
  }

  function refreshAll(silent) {
    return Promise.all([
      global.SGApi.health().catch(function () { return null; }),
      loadPatients(silent),
      loadStats(),
      loadModels()
    ]);
  }

  /* ------------------------------------------------------------------ *
   * 抽屉：患者详情
   * ------------------------------------------------------------------ */
  function openDrawer(id) {
    State.currentId = id;
    State.currentDetail = null;
    var drawer = $('#drawer');
    var backdrop = $('#drawerBackdrop');
    drawer.classList.add('is-open');
    backdrop.classList.add('is-open');
    drawer.setAttribute('aria-hidden', 'false');

    $('#drawerTitle').textContent = '加载中…';
    $('#drawerSub').textContent = id;
    $('#drawerBody').innerHTML = '<div class="empty-state">正在加载患者详情…</div>';

    var cached = State.detailCache[id];
    Promise.all([
      cached ? Promise.resolve(cached) : global.SGApi.patient(id),
      global.SGApi.risk(id).catch(function () { return null; })
    ]).then(function (res) {
      if (State.currentId !== id) return;   // 用户已切换患者
      var detail = res[0];
      var riskInfo = res[1];
      if (!detail) {
        $('#drawerBody').innerHTML = '<div class="empty-state">未获取到该患者的详情数据。</div>';
        return;
      }
      State.detailCache[id] = detail;
      State.currentDetail = detail;
      renderDrawer(detail, riskInfo);
    }).catch(function () {
      $('#drawerBody').innerHTML = '<div class="empty-state">患者详情加载失败，请稍后重试。</div>';
    });
  }

  function closeDrawer() {
    $('#drawer').classList.remove('is-open');
    $('#drawerBackdrop').classList.remove('is-open');
    $('#drawer').setAttribute('aria-hidden', 'true');
    State.currentId = null;
    State.currentDetail = null;
  }

  function renderDrawer(detail, riskInfo) {
    var p = detail.patient || {};
    var level = p.risk_level || 'normal';

    $('#drawerTitle').innerHTML = esc(p.bed || '—') + ' <span class="pc-id">' + esc(p.patient_id || '') + '</span>' +
      ' <span class="pc-badge level-' + esc(level) + '">' + esc(p.risk_level_zh || LEVEL_ZH[level]) + '</span>';
    $('#drawerSub').textContent = [
      (p.age !== null && p.age !== undefined ? Math.round(p.age) + ' 岁' : null),
      p.gender_zh,
      'ICU 住院 ' + (p.icu_los_hours || 0) + ' 小时',
      (Number(p.peak_risk_score) && Math.abs(Number(p.peak_risk_score) - Number(p.risk_score || 0)) > 0.05
        ? '峰值风险 ' + Number(p.peak_risk_score).toFixed(2) : null),
      p.has_sepsis_label ? '脓毒症标签：第 ' + p.onset_hour + ' 小时发作' : '无脓毒症标签',
      p.last_alert_time ? '最近告警 ' + p.last_alert_time : '暂无告警'
    ].filter(Boolean).join(' · ');

    var body = $('#drawerBody');
    body.innerHTML =
      '<div class="panel">' +
        '<div class="panel-head"><div class="panel-title">风险评分与趋势</div>' +
          '<div class="panel-hint">竖线为告警触发点，红色半透明色带为脓毒症发作时刻</div></div>' +
        '<div id="riskBarHost" style="margin-bottom:10px"></div>' +
        '<div class="chart-wrap"><canvas id="riskChart" class="chart-risk"></canvas></div>' +
        '<div class="chart-legend" id="riskLegend"></div>' +
      '</div>' +

      '<div class="panel">' +
        '<div class="panel-head"><div class="panel-title">关键指标时序</div>' +
          '<div class="panel-hint">缺失时段断开线段，不做插值跨接</div></div>' +
        '<div class="vital-toggles" id="vitalToggles"></div>' +
        '<div class="chart-wrap" style="margin-top:10px"><canvas id="vitalsChart" class="chart-vitals"></canvas></div>' +
        '<div class="chart-note" id="vitalsNote"></div>' +
      '</div>' +

      '<div class="panel">' +
        '<div class="panel-head"><div class="panel-title">指标偏离度</div>' +
          '<div class="panel-hint">以最近 6 小时有效测量值相对临床参考区间计算</div></div>' +
        '<div class="chart-wrap"><canvas id="radarChart" class="chart-radar"></canvas></div>' +
      '</div>' +

      '<div class="panel">' +
        '<div class="panel-head"><div class="panel-title">本次风险归因</div>' +
          '<div class="panel-hint">来自 /api/patients/{id}/risk 的可解释性输出</div></div>' +
        '<div id="riskExplain"></div>' +
      '</div>' +

      '<div class="panel">' +
        '<div class="panel-head"><div class="panel-title">告警历史与归因</div>' +
          '<div class="panel-hint" id="alertCountHint"></div></div>' +
        '<div class="alert-list" id="alertList"></div>' +
      '</div>';

    global.SGCharts.riskBar($('#riskBarHost'), Number(p.risk_score || 0), level, { label: '当前风险分数' });
    renderRiskChart(detail, p);
    renderVitalToggles(detail);
    renderRadar(detail);
    renderRiskExplain(riskInfo, detail);
    renderAlerts(detail);

    // 抽屉动画结束后重绘一次，确保画布尺寸精确
    global.setTimeout(function () { global.SGCharts.redrawAll(); }, 320);
  }

  /* ---- 风险趋势曲线 ---- */
  function renderRiskChart(detail, p) {
    var cv = $('#riskChart');
    if (!cv) return;
    var ts = detail.timeseries || {};
    var hours = ts.hours || [];
    var risk = detail.risk_series || [];
    if (!hours.length && risk.length) {
      hours = risk.map(function (_, i) { return i + 1; });
    }
    var level = p.risk_level || 'normal';
    var alerts = detail.alerts || [];

    var vlines = alerts.map(function (a) {
      return {
        x: a.trigger_time,
        color: LEVEL_COLOR[a.level] || '#ef4444',
        label: '告警 ' + a.trigger_time + 'h',
        dash: [4, 3]
      };
    });

    var bands = [];
    var markers = [];
    if (p.onset_hour) {
      var lastHour = hours.length ? hours[hours.length - 1] : p.onset_hour + 6;
      bands.push({
        from: p.onset_hour,
        to: Math.min(p.onset_hour + 6, lastHour),
        color: 'rgba(239, 68, 68, 0.13)',
        label: '脓毒症发作',
        labelColor: '#fca5a5'
      });
      var idx = hours.indexOf(p.onset_hour);
      if (idx >= 0 && risk[idx] !== undefined) {
        markers.push({ x: p.onset_hour, y: risk[idx], color: '#f87171' });
      }
    }

    global.SGCharts.lineChart(cv, {
      hours: hours,
      series: [{ key: 'risk', name: '风险分数', color: LEVEL_COLOR[level] || '#38bdf8', values: risk, unit: '' }],
      yMin: 0, yMax: 1, yLabel: '风险分数', xLabel: '入 ICU 后小时', fill: true,
      vlines: vlines, bands: bands, markers: markers, xTickCount: 10
    });

    var legend = $('#riskLegend');
    if (legend) {
      legend.innerHTML =
        '<span class="lg"><i style="background:' + (LEVEL_COLOR[level] || '#38bdf8') + '"></i>风险分数（0~1）</span>' +
        '<span class="lg"><i style="background:#ef4444"></i>告警触发点</span>' +
        (p.onset_hour ? '<span class="lg"><i style="background:rgba(239,68,68,.45)"></i>脓毒症发作时段（第 ' + p.onset_hour + ' 小时起）</span>' : '') +
        '<span class="lg">缺失时段：' + countGaps(risk) + ' 处</span>';
    }
  }

  function countGaps(values) {
    var gaps = 0, inGap = false;
    (values || []).forEach(function (v) {
      var missing = (v === null || v === undefined);
      if (missing && !inGap) { gaps++; inGap = true; }
      if (!missing) inGap = false;
    });
    return gaps;
  }

  /* ---- 关键指标时序 ---- */
  function latestValue(values) {
    for (var i = values.length - 1; i >= 0; i--) {
      if (values[i] !== null && values[i] !== undefined) return values[i];
    }
    return null;
  }

  function renderVitalToggles(detail) {
    var host = $('#vitalToggles');
    if (!host) return;
    host.innerHTML = '';
    var vars = (detail.timeseries && detail.timeseries.variables) || {};
    VITALS.forEach(function (key, i) {
      var label = el('label', 'vt-item' + (State.vitalSel[key] ? ' is-on' : ''));
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!State.vitalSel[key];
      cb.setAttribute('data-var', key);
      var dot = el('span', 'vt-dot');
      dot.style.background = global.SGCharts.SERIES_COLORS[i % global.SGCharts.SERIES_COLORS.length];
      label.appendChild(cb);
      label.appendChild(dot);
      label.appendChild(el('span', null, (VAR_ZH[key] || {}).name || key));
      var last = vars[key] ? latestValue(vars[key]) : null;
      label.appendChild(el('span', 'vt-now', last === null ? '未测量' : fmtNum(last)));
      cb.addEventListener('change', function () {
        State.vitalSel[key] = cb.checked;
        label.classList.toggle('is-on', cb.checked);
        renderVitalsChart(detail);
      });
      host.appendChild(label);
    });
    renderVitalsChart(detail);
  }

  function renderVitalsChart(detail) {
    var cv = $('#vitalsChart');
    if (!cv) return;
    var ts = detail.timeseries || {};
    var hours = ts.hours || [];
    var vars = ts.variables || {};
    var selected = VITALS.filter(function (k) { return State.vitalSel[k]; });

    var note = $('#vitalsNote');
    if (!hours.length) {
      global.SGCharts.clear(cv);
      if (note) note.textContent = '该患者暂无可用的时序数据。';
      return;
    }
    if (!selected.length) {
      global.SGCharts.clear(cv);
      if (note) note.textContent = '请至少勾选一个指标。';
      return;
    }

    var series = selected.map(function (key) {
      var idx = VITALS.indexOf(key);
      return {
        key: key,
        name: (VAR_ZH[key] || {}).name || key,
        unit: (VAR_ZH[key] || {}).unit || '',
        color: global.SGCharts.SERIES_COLORS[idx % global.SGCharts.SERIES_COLORS.length],
        values: vars[key] || [],
        range: REF[key]
      };
    });

    var normalize = series.length > 1;
    global.SGCharts.lineChart(cv, {
      hours: hours,
      series: series,
      normalize: normalize,
      fill: !normalize,
      yLabel: normalize ? '参考区间百分比' : ((VAR_ZH[selected[0]] || {}).unit || selected[0]),
      xLabel: '入 ICU 后小时',
      xTickCount: 10,
      yTicks: normalize ? 5 : 6
    });

    if (note) {
      var missing = 0;
      selected.forEach(function (k) { missing += countGaps(vars[k] || []); });
      note.innerHTML =
        '<span>已选 ' + selected.length + ' 项指标</span>' +
        '<span>缺失断开：' + missing + ' 段（null 不参与连线）</span>' +
        (normalize ? '<span>多指标量纲不同，纵轴按各自参考区间归一化为百分比；悬浮可查看真实值</span>' : '<span>纵轴为真实测量刻度</span>');
    }
  }

  /* ---- 指标偏离度雷达 ---- */
  function meanOfLast(values, n) {
    var acc = [], i;
    for (i = values.length - 1; i >= 0 && acc.length < n; i--) {
      if (values[i] !== null && values[i] !== undefined) acc.push(values[i]);
    }
    if (!acc.length) return null;
    return acc.reduce(function (a, b) { return a + b; }, 0) / acc.length;
  }

  function renderRadar(detail) {
    var cv = $('#radarChart');
    if (!cv) return;
    var vars = (detail.timeseries && detail.timeseries.variables) || {};
    var axes = VITALS.map(function (key) {
      var v = vars[key] ? meanOfLast(vars[key], 6) : null;
      var ref = REF[key] || [0, 1];
      var dev = v === null ? 0 : global.SGCharts.deviation(v, ref[0], ref[1]);
      return {
        label: ((VAR_ZH[key] || {}).name || key) + (v === null ? '(无)' : ' ' + fmtNum(v)),
        value: dev,
        hot: dev > 0.55
      };
    });
    global.SGCharts.radar(cv, { axes: axes, max: 1, color: '#22d3ee' });
  }

  /* ---- 风险归因（来自 /risk） ---- */
  function featureBarsHtml(features) {
    if (!features || !features.length) {
      return '<div class="muted" style="font-size:12px">本次未返回显著贡献特征。</div>';
    }
    var max = 0;
    features.forEach(function (f) { max = Math.max(max, Math.abs(f.contribution || 0)); });
    if (max <= 0) max = 1;
    var html = '<div class="feat-bars">';
    features.forEach(function (f) {
      var up = f.direction !== 'down';
      var color = up ? '#ef4444' : '#3b82f6';
      var pct = Math.round((Math.abs(f.contribution || 0) / max) * 100);
      html += '<div class="feat-row">' +
        '<div class="feat-name">' + esc(f.name_zh || f.feature) +
          ' <span class="feat-arrow ' + (up ? 'up' : 'down') + '">' + (up ? '▲' : '▼') + '</span></div>' +
        '<div class="feat-track"><div class="feat-fill" style="width:' + pct + '%;background:linear-gradient(90deg,' +
          global.SGCharts.hexToRgba(color, 0.45) + ',' + color + ')"></div></div>' +
        '<div class="mono" style="font-size:11.5px;color:' + color + '">' +
          (up ? '+' : '−') + Math.abs(f.contribution || 0).toFixed(2) + '</div>' +
        '<div class="feat-phrase">' + esc(f.phrase_zh || '') + '</div>' +
      '</div>';
    });
    html += '</div>';
    return html;
  }

  function gapListHtml(gaps) {
    if (!gaps || !gaps.length) {
      return '<div class="muted" style="font-size:12px;margin-top:8px">关键变量测量齐全，无显著信息缺口。</div>';
    }
    var html = '<div class="detail-title" style="margin-top:12px">⚠ 信息缺口提示</div><div class="gap-list">';
    gaps.forEach(function (g) {
      html += '<div class="gap-item"><span class="gap-icon">⚠</span><span>' + esc(g.phrase_zh || (g.name_zh || g.variable) + ' 数据缺失') + '</span></div>';
    });
    html += '</div>';
    return html;
  }

  function renderRiskExplain(riskInfo, detail) {
    var host = $('#riskExplain');
    if (!host) return;
    var features = riskInfo && riskInfo.top_features;
    var gaps = riskInfo && riskInfo.information_gaps;
    if ((!features || !features.length) && (!gaps || !gaps.length)) {
      // 回退：使用该患者最新一条告警的归因
      var alerts = detail.alerts || [];
      var latest = alerts.length ? alerts[alerts.length - 1] : null;
      features = latest ? latest.top_features : [];
      gaps = latest ? latest.information_gaps : [];
    }
    host.innerHTML = featureBarsHtml(features) + gapListHtml(gaps);
  }

  /* ---- 告警历史 ---- */
  function alertItemEl(alert, index) {
    var item = el('div', 'alert-item level-' + (alert.level || 'normal') + (alert.status === 'open' ? ' is-open' : ''));

    var head = el('div', 'alert-head');
    head.appendChild(el('span', 'alert-time', '第 ' + alert.trigger_time + ' 小时'));
    head.appendChild(el('span', 'pc-badge level-' + (alert.level || 'normal'), alert.level_zh || LEVEL_ZH[alert.level] || '—'));
    head.appendChild(el('span', 'mono muted', '风险 ' + Number(alert.risk_score || 0).toFixed(2)));
    head.appendChild(el('span', 'alert-status s-' + (alert.status || 'open'), STATUS_ZH[alert.status] || alert.status));
    item.appendChild(head);

    item.appendChild(el('div', 'alert-reason', alert.reason_zh || '（无归因说明）'));

    var metaParts = [];
    if (alert.handled_by) metaParts.push('处理人：' + alert.handled_by);
    if (alert.handle_reason) metaParts.push('处理原因：' + alert.handle_reason);
    if (metaParts.length) item.appendChild(el('div', 'alert-meta', metaParts.join(' · ')));

    // 操作按钮
    var actions = el('div', 'alert-actions');
    var ackBtn = el('button', 'btn btn-primary', '确认');
    var ignoreBtn = el('button', 'btn btn-danger', '忽略');
    var snoozeBtn = el('button', 'btn btn-warn', '稍后提醒');
    if (alert.status !== 'open') {
      ackBtn.disabled = ignoreBtn.disabled = snoozeBtn.disabled = true;
    }
    ackBtn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      doAck(alert.alert_id, 'acknowledge', '医生确认风险，已安排床旁评估');
    });
    ignoreBtn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      openReasonModal(alert.alert_id);
    });
    snoozeBtn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      doAck(alert.alert_id, 'snooze', '稍后 30 分钟再次提醒');
    });
    actions.appendChild(ackBtn);
    actions.appendChild(ignoreBtn);
    actions.appendChild(snoozeBtn);

    var detailToggle = el('button', 'btn btn-ghost', '归因详情 ▾');
    actions.appendChild(detailToggle);
    item.appendChild(actions);

    // 归因详情（默认展开最新一条）
    var detailBox = el('div', 'alert-detail');
    detailBox.innerHTML = '<div class="detail-title">特征贡献（后端已转为临床语言）</div>' +
      featureBarsHtml(alert.top_features) + gapListHtml(alert.information_gaps);
    if (index === 0) {
      detailBox.style.display = 'block';
      detailToggle.textContent = '收起归因 ▴';
    } else {
      detailBox.style.display = 'none';
    }
    detailToggle.addEventListener('click', function (ev) {
      ev.stopPropagation();
      var open = detailBox.style.display !== 'none';
      detailBox.style.display = open ? 'none' : 'block';
      detailToggle.textContent = open ? '归因详情 ▾' : '收起归因 ▴';
    });
    item.appendChild(detailBox);

    return item;
  }

  function renderAlerts(detail) {
    var host = $('#alertList');
    if (!host) return;
    host.innerHTML = '';
    var alerts = (detail.alerts || []).slice().sort(function (a, b) { return (b.trigger_time || 0) - (a.trigger_time || 0); });
    var hint = $('#alertCountHint');
    if (hint) {
      var open = alerts.filter(function (a) { return a.status === 'open'; }).length;
      hint.textContent = '共 ' + alerts.length + ' 条 · 待处理 ' + open + ' 条';
    }
    if (!alerts.length) {
      host.appendChild(el('div', 'empty-state', '该患者暂无告警记录。'));
      return;
    }
    alerts.forEach(function (a, i) { host.appendChild(alertItemEl(a, i)); });
  }

  /* ------------------------------------------------------------------ *
   * 告警处理
   * ------------------------------------------------------------------ */
  function doAck(alertId, action, reason) {
    var by = '当班医生';
    global.SGApi.ackAlert(alertId, { action: action, reason: reason, handled_by: by }).then(function (res) {
      if (!res || res.ok !== true) {
        toast('处理失败', '后端未返回成功状态，请稍后重试', 'err');
        return;
      }
      var actionZh = { acknowledge: '已确认', ignore: '已忽略', snooze: '已稍后提醒' }[action] || '已处理';
      toast('告警' + actionZh, '告警 ' + alertId + ' · ' + reason, action === 'ignore' ? 'warn' : 'ok');
      // 同步本地缓存，避免整页重载
      applyAckLocally(alertId, action, reason, by);
      if (State.currentDetail) renderAlerts(State.currentDetail);
      loadPatients(true);
      loadStats();
    }).catch(function () {
      toast('处理失败', '网络异常，已回退演示数据，请确认处理结果', 'err');
    });
  }

  function applyAckLocally(alertId, action, reason, by) {
    var statusMap = { acknowledge: 'acknowledged', ignore: 'ignored', snooze: 'snoozed' };
    var newStatus = statusMap[action] || 'acknowledged';
    Object.keys(State.detailCache).forEach(function (pid) {
      var d = State.detailCache[pid];
      if (!d || !d.alerts) return;
      d.alerts.forEach(function (a) {
        if (a.alert_id === alertId) {
          a.status = newStatus;
          a.handled_by = by;
          a.handle_reason = reason;
        }
      });
    });
  }

  /* ---- 忽略原因弹窗 ---- */
  function openReasonModal(alertId) {
    State.pendingAlertId = alertId;
    State.ignoreReason = '已知病情';
    var note = $('#reasonNote');
    if (note) note.value = '';
    var items = document.querySelectorAll('#reasonOptions .radio-item');
    Array.prototype.forEach.call(items, function (it, i) {
      it.classList.toggle('is-on', i === 0);
      var input = it.querySelector('input');
      if (input) input.checked = (i === 0);
    });
    $('#reasonModal').classList.add('is-open');
  }

  function closeReasonModal() {
    $('#reasonModal').classList.remove('is-open');
    State.pendingAlertId = null;
  }

  function bindReasonModal() {
    var items = document.querySelectorAll('#reasonOptions .radio-item');
    Array.prototype.forEach.call(items, function (it) {
      it.addEventListener('click', function () {
        Array.prototype.forEach.call(items, function (o) { o.classList.remove('is-on'); });
        it.classList.add('is-on');
        var input = it.querySelector('input');
        if (input) input.checked = true;
        State.ignoreReason = it.getAttribute('data-reason') || '其他';
      });
    });
    $('#reasonCancel').addEventListener('click', closeReasonModal);
    $('#reasonConfirm').addEventListener('click', function () {
      var id = State.pendingAlertId;
      if (!id) { closeReasonModal(); return; }
      var note = ($('#reasonNote') && $('#reasonNote').value) || '';
      var reason = State.ignoreReason + (note ? '：' + note : '');
      closeReasonModal();
      doAck(id, 'ignore', reason);
    });
    $('#reasonModal').addEventListener('click', function (ev) {
      if (ev.target === $('#reasonModal')) closeReasonModal();
    });
  }

  /* ------------------------------------------------------------------ *
   * 事件绑定与启动
   * ------------------------------------------------------------------ */
  function bindToolbar() {
    $('#sortSelect').addEventListener('change', function (e) {
      State.sort = e.target.value;
      renderGrid();
      loadPatients(true);
    });

    $('#levelChips').addEventListener('click', function (e) {
      var chip = e.target.closest ? e.target.closest('.chip') : null;
      if (!chip) return;
      Array.prototype.forEach.call(document.querySelectorAll('#levelChips .chip'), function (c) {
        c.classList.toggle('is-active', c === chip);
      });
      State.level = chip.getAttribute('data-level') || 'all';
      renderGrid();
      drainPrefetch();
    });

    var searchTimer = null;
    $('#searchInput').addEventListener('input', function (e) {
      var v = e.target.value.trim();
      if (searchTimer) global.clearTimeout(searchTimer);
      searchTimer = global.setTimeout(function () {
        State.q = v;
        renderGrid();
        drainPrefetch();
      }, 180);
    });

    $('#autoRefresh').addEventListener('change', function (e) {
      State.autoRefresh = e.target.checked;
      setupTimer();
      renderGrid();
    });

    $('#refreshBtn').addEventListener('click', function () {
      var btn = $('#refreshBtn');
      btn.disabled = true;
      btn.textContent = '刷新中…';
      global.SGApi.probe().then(function () {
        return refreshAll(false);
      }).then(function () {
        btn.disabled = false;
        btn.textContent = '立即刷新';
      }).catch(function () {
        btn.disabled = false;
        btn.textContent = '立即刷新';
      });
    });
  }

  function setupTimer() {
    if (State.timer) { global.clearInterval(State.timer); State.timer = null; }
    if (State.autoRefresh) {
      State.timer = global.setInterval(function () {
        loadPatients(true);
        loadStats();
      }, REFRESH_MS);
    }
  }

  function bindDrawer() {
    $('#drawerClose').addEventListener('click', closeDrawer);
    $('#drawerBackdrop').addEventListener('click', closeDrawer);
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') {
        if ($('#reasonModal').classList.contains('is-open')) closeReasonModal();
        else closeDrawer();
      }
    });
  }

  function init() {
    bindConnection();
    bindToolbar();
    bindDrawer();
    bindReasonModal();
    setupTimer();
    // 首屏：先做一次健康探测，失败会自动进入离线演示模式
    global.SGApi.probe().then(function () {
      return refreshAll(true);
    }).then(function () {
      renderGrid();
    }).catch(function () {
      renderGrid();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
