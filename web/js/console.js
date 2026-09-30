/* ==========================================================================
   哨兵 SepsisGuard —— 临床预警控制台（console.js）
   ==========================================================================

   设计依据（见 css/tokens.css 顶部的完整说明）：
   - 信息密度 = 每 token 的决策价值，而非单位面积的数据量
   - D3 不确定性显式化：模型置信度、数据完整度、信息缺口全部可见
   - D9 行动建议：每一行都给出可执行的下一步
   - D11 历史轨迹：一律给趋势，不给孤立快照
   - E 状态机标签：显示患者在临床路径上的位置
   - C 数据脉象层：数据新鲜度与覆盖度是一等公民

   性能设计：
   - **虚拟滚动**：列表只保留可见窗口（加上下 overscan）的真实 DOM，其余用
     占位行撑高。实测把 20,000 位患者全部渲染会产生 8.25 MB HTML，DOM 规模
     会持续拖累滚动；虚拟滚动后 DOM 规模与患者总数无关。
   - 患者列表整体缓存；切换视图/排序/搜索在内存中完成，不重新请求。
   - 滚动事件用 requestAnimationFrame 合并，且窗口未变时直接跳过重绘。
   - 迷你趋势图只对当前窗口的行绘制。
   - 归因（可解释性）按需向后端请求，不在列表阶段计算。
   ========================================================================== */

(function (global) {
  'use strict';

  var Api = global.SGApi;
  var Charts = global.SGCharts;

  var REFRESH_MS = 20000;
  var RENDER_STEP = 120;       // 每批插入的行数（增量渲染的步长）
  var ROW_HEIGHT = 44;         // 与 CSS 的 table.grid tbody tr 高度一致
  var VIRTUAL_OVERSCAN = 12;   // 可见区上下各多渲染几行，避免快速滚动时白屏

  /* ======================================================================
     虚拟滚动
     ======================================================================
     实测（tests/frontend_perf.js）：把 20,000 位患者全部渲染成 DOM 需要
     30.9 ms、产生 8.25 MB HTML。单次插入虽然只有 30 ms，但 8 MB 的 DOM
     会持续拖累滚动与重绘，而且每行含 2 个 canvas——canvas 元素过多会显著
     增加合成层压力。

     因此列表改为**按可见窗口渲染**：只保留视口内（加上下 overscan）那几十行
     的真实 DOM，其余用上下占位行撑起滚动条高度。这样 DOM 规模与**患者总数无关**，
     20,000 位患者与 200 位患者的渲染成本相同。

     行高固定为 44px（见 tokens.css），因此可以用简单的除法定位窗口，
     不需要逐行测量高度。
     ====================================================================== */
  var virtualScroll = {
    enabled: true,
    scrollTop: 0,
    viewportHeight: 600,
    listLength: 0,
    startIndex: 0,
    endIndex: 0
  };

  function virtualWindow(listLength) {
    var visible = Math.ceil(virtualScroll.viewportHeight / ROW_HEIGHT) + 1;
    var first = Math.max(0, Math.floor(virtualScroll.scrollTop / ROW_HEIGHT) - VIRTUAL_OVERSCAN);
    var last = Math.min(listLength, first + visible + VIRTUAL_OVERSCAN * 2);
    return { first: first, last: last };
  }

  function spacerRow(height) {
    if (height <= 0) return '';
    return '<tr class="virtual-spacer" aria-hidden="true" ' +
           'style="height:' + height + 'px;"><td colspan="5" ' +
           'style="padding:0;border:0;height:' + height + 'px;"></td></tr>';
  }

  /* ======================================================================
     指标参考范围：用于"偏离正常范围"判定与 KPI 高亮
     与后端 sepsisguard/config.py 的 VARIABLE_SPECS 保持一致
     ====================================================================== */
  var VITAL_REFS = {
    HR:     { zh: '心率',       unit: '次/分', lo: 60,  hi: 100, worseHigh: true },
    SBP:    { zh: '收缩压',     unit: 'mmHg',  lo: 90,  hi: 140, worseHigh: false },
    DBP:    { zh: '舒张压',     unit: 'mmHg',  lo: 60,  hi: 90,  worseHigh: false },
    MAP:    { zh: '平均动脉压', unit: 'mmHg',  lo: 65,  hi: 100, worseHigh: false },
    Resp:   { zh: '呼吸频率',   unit: '次/分', lo: 12,  hi: 20,  worseHigh: true },
    O2Sat:  { zh: '血氧饱和度', unit: '%',     lo: 94,  hi: 100, worseHigh: false },
    Temp:   { zh: '体温',       unit: '℃',     lo: 36.0, hi: 38.0, worseHigh: true },
    Lactate:{ zh: '乳酸',       unit: 'mmol/L', lo: 0.5, hi: 2.0, worseHigh: true },
    WBC:    { zh: '白细胞',     unit: '10³/µL', lo: 4,  hi: 12,  worseHigh: true },
    Creatinine: { zh: '肌酐',   unit: 'mg/dL', lo: 0.5, hi: 1.2, worseHigh: true },
    Platelets:  { zh: '血小板', unit: '10³/µL', lo: 150, hi: 400, worseHigh: false },
    BUN:    { zh: '尿素氮',     unit: 'mg/dL', lo: 6,  hi: 20,  worseHigh: true }
  };

  /* 图表系列配色：锁定顺序，同一变量在所有视图用同一颜色 */
  var SERIES_COLORS = {
    HR: '#2dd4bf', SBP: '#60a5fa', DBP: '#38bdf8', MAP: '#818cf8',
    Resp: '#a78bfa', O2Sat: '#fbbf24', Temp: '#f472b6', Lactate: '#4ade80',
    WBC: '#fb923c', Creatinine: '#c084fc', Platelets: '#f87171', BUN: '#22d3ee'
  };

  /* ======================================================================
     状态
     ====================================================================== */
  var state = {
    patients: [],          // 全量患者列表（来自后端一次请求）
    view: 'all',
    mode: 'clinical',
    sort: 'risk',
    search: '',
    selectedId: null,
    rendered: 0,
    alerts: [],
    health: null,
    stats: null,
    lastLoaded: 0,
    loadMs: 0
  };

  /* ======================================================================
     工具
     ====================================================================== */
  function $(id) { return document.getElementById(id); }

  function esc(text) {
    return String(text === null || text === undefined ? '' : text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmt(value, digits) {
    if (value === null || value === undefined || !isFinite(value)) return '—';
    return Number(value).toFixed(digits === undefined ? 2 : digits);
  }

  function pct(value, digits) {
    if (value === null || value === undefined || !isFinite(value)) return '—';
    return (Number(value) * 100).toFixed(digits === undefined ? 1 : digits) + '%';
  }

  /* 分级 -> 徽章样式类。与后端 level_of 的 normal/low/medium/high 对齐，
     并额外承认 critical（极高风险）——由峰值风险与上升趋势共同判定。 */
  function levelClass(level) {
    return 'is-' + (level || 'normal');
  }

  function levelZh(level) {
    return { critical: '极高风险', high: '高风险', medium: '中风险',
             low: '低风险', normal: '正常' }[level] || '正常';
  }

  /* 风险分数的颜色（用于数值染色，与徽章色一致） */
  function riskColor(level) {
    return { critical: '#ef4444', high: '#f97316', medium: '#eab308',
             low: '#38bdf8', normal: '#94a3b8' }[level] || '#94a3b8';
  }

  /* 判定综合风险等级：风险分数 + 峰值 + 上升趋势
     比单看当前分数更贴近临床——一个当前 0.3 但两小时内从 0.05 冲上来的患者，
     比一个长期稳定在 0.35 的患者更需要关注。 */
  function gradeRisk(patient) {
    var current = patient.risk_score || 0;
    var peak = patient.peak_risk_score || 0;
    var trend = patient.trend_delta || 0;
    var base = patient.risk_level || 'normal';

    // 趋势显著上升 → 提升一级
    if (trend >= 0.08 && base === 'medium') return 'high';
    if (trend >= 0.08 && base === 'high') return 'critical';
    if (trend >= 0.20 && base === 'low') return 'medium';
    // 峰值很高但当前回落 → 保持较高关注（"曾经很危险"本身是信息）
    if (peak >= 0.75 && current >= 0.2) return base === 'normal' ? 'medium' : base;
    return base;
  }

  function trendOf(patient) {
    var delta = patient.trend_delta;
    if (delta === null || delta === undefined) return { cls: 'is-flat', text: '—' };
    if (delta > 0.02) return { cls: 'is-rising', text: '↗ ' + fmt(delta, 3) };
    if (delta < -0.02) return { cls: 'is-falling', text: '↘ ' + fmt(Math.abs(delta), 3) };
    return { cls: 'is-flat', text: '→ 持平' };
  }

  /* 数据完整度：以"关键指标中已测量项占比"为代理。
     后端在 patient 对象上给出 measured_ratio（0-1），缺失时退化为 null。 */
  function completeness(patient) {
    var ratio = patient.measured_ratio;
    if (ratio === null || ratio === undefined || !isFinite(ratio)) return null;
    return Math.max(0, Math.min(1, ratio));
  }

  /* ======================================================================
     视图过滤
     ====================================================================== */
  var VIEWS = {
    all:      { title: '全部在监', desc: '按综合风险降序', filter: function () { return true; } },
    critical: { title: '极高风险', desc: '风险分数高且趋势上升，建议立即复核',
                filter: function (p) { return gradeRisk(p) === 'critical'; } },
    high:     { title: '高风险', desc: '风险等级为高，建议优先查房',
                filter: function (p) { return gradeRisk(p) === 'high'; } },
    rising:   { title: '风险上升', desc: '近 6 小时风险增速显著，即使绝对值不高也需关注',
                filter: function (p) { return (p.trend_delta || 0) >= 0.05; } },
    gaps:     { title: '信息缺口', desc: '关键检验缺失或陈旧，补充检测可提升判断置信度',
                filter: function (p) { return (p.gap_count || 0) > 0; } },
    septic:   { title: '已发作', desc: '数据集标注的脓毒症发作患者（用于回顾与教学）',
                filter: function (p) { return !!p.has_sepsis_label; } },
    handover: { title: '交接班清单', desc: '按"下一位接诊者最需要知道什么"排序',
                filter: function (p) { return gradeRisk(p) !== 'normal' || (p.gap_count || 0) > 0; },
                sort: 'risk' }
  };

  function applyView(list) {
    var view = VIEWS[state.view] || VIEWS.all;
    var out = list.filter(view.filter);

    if (state.search) {
      var needle = state.search.toLowerCase();
      out = out.filter(function (p) {
        return String(p.patient_id || '').toLowerCase().indexOf(needle) >= 0 ||
               String(p.bed || '').toLowerCase().indexOf(needle) >= 0;
      });
    }
    return out;
  }

  var SORTERS = {
    risk:       function (a, b) { return (b.risk_score || 0) - (a.risk_score || 0); },
    peak:       function (a, b) { return (b.peak_risk_score || 0) - (a.peak_risk_score || 0); },
    trend:      function (a, b) { return (b.trend_delta || 0) - (a.trend_delta || 0); },
    incomplete: function (a, b) { return (b.gap_count || 0) - (a.gap_count || 0); },
    los:        function (a, b) { return (b.icu_los_hours || 0) - (a.icu_los_hours || 0); },
    bed:        function (a, b) { return String(a.bed || '').localeCompare(String(b.bed || '')); }
  };

  function visiblePatients() {
    var list = applyView(state.patients);
    var sorter = SORTERS[state.sort] || SORTERS.risk;
    return list.slice().sort(sorter);
  }

  /* ======================================================================
     表头定义：三种模式对应三套关注点
     ====================================================================== */
  var COLUMNS = {
    clinical: [
      { key: 'patient', label: '患者 / 床号', cls: '' },
      { key: 'risk',    label: '综合风险',   cls: '' },
      { key: 'trend',   label: '趋势 (6h)',  cls: 'num' },
      { key: 'lead',    label: '风险轨迹',   cls: '' },
      { key: 'action',  label: '建议下一步', cls: '' }
    ],
    uncertainty: [
      { key: 'patient', label: '患者 / 床号', cls: '' },
      { key: 'risk',    label: '风险等级',   cls: '' },
      { key: 'trend',   label: '趋势 (6h)',  cls: 'num' },
      { key: 'complete', label: '数据完整度', cls: 'num' },
      { key: 'gap',     label: '信息缺口',   cls: '' }
    ],
    workload: [
      { key: 'patient', label: '患者 / 床号', cls: '' },
      { key: 'risk',    label: '风险等级',   cls: '' },
      { key: 'alerts',  label: '告警数',     cls: 'num' },
      { key: 'handled', label: '处理状态',   cls: '' },
      { key: 'action',  label: '建议下一步', cls: '' }
    ]
  };

  function renderHead() {
    var cols = COLUMNS[state.mode] || COLUMNS.clinical;
    var html = cols.map(function (col) {
      return '<th class="' + col.cls + '">' + esc(col.label) + '</th>';
    }).join('');
    $('tableHead').innerHTML = html;
  }

  /* ======================================================================
     行渲染
     ====================================================================== */
  function patientCell(p) {
    var grade = gradeRisk(p);
    var sex = p.gender_zh || '—';
    var age = (p.age === null || p.age === undefined) ? '—' : Math.round(p.age) + '岁';
    var los = (p.icu_los_hours || 0);
    return '<div class="cell-id">' +
             '<span class="pid">' + esc(p.patient_id) + '</span>' +
             '<span class="meta">' + esc(p.bed || '—') + ' · ' + esc(sex) + ' ' + esc(age) +
             ' · 住院 ' + los + 'h</span>' +
           '</div>';
  }

  function riskCell(p) {
    var grade = gradeRisk(p);
    var score = p.risk_score || 0;
    var sparkId = 'sp_' + p.patient_id;
    return '<div class="risk-cell">' +
             '<div class="row1">' +
               '<span class="score" style="color:' + riskColor(grade) + '">' + fmt(score, 3) + '</span>' +
               '<span class="badge ' + levelClass(grade) + '">' + levelZh(grade) + '</span>' +
             '</div>' +
             '<canvas class="risk-spark" id="' + sparkId + '" width="110" height="16"></canvas>' +
           '</div>';
  }

  function trendCell(p) {
    var t = trendOf(p);
    return '<span class="trend ' + t.cls + '">' + t.text + '</span>';
  }

  function completeCell(p) {
    var ratio = completeness(p);
    if (ratio === null) return '<span class="faint">—</span>';
    var good = ratio >= 0.55;
    return '<div class="completeness' + (good ? ' is-good' : '') + '" title="关键指标中已测量项占比">' +
             '<span class="cbar"><i style="width:' + Math.round(ratio * 100) + '%"></i></span>' +
             '<span>' + pct(ratio, 0) + '</span>' +
           '</div>';
  }

  function gapCell(p) {
    var gaps = p.gap_names || [];
    if (!gaps.length) return '<span class="faint">无缺口</span>';
    return '<span class="badge is-medium" title="' + esc(gaps.join('、')) + '">' +
           '缺 ' + gaps.length + ' 项' + '</span>' +
           '<div class="action-cell" style="margin-top:2px;">需补：' + esc(gaps.slice(0, 3).join('、')) +
           (gaps.length > 3 ? ' 等' : '') + '</div>';
  }

  function alertsCell(p) {
    var n = p.alert_count || 0;
    if (!n) return '<span class="faint">0</span>';
    return '<span class="num" style="font-weight:600;">' + n + '</span>';
  }

  function handledCell(p) {
    var open = p.open_alert_count || 0;
    if (!open) return '<span class="badge is-normal">无待处理</span>';
    return '<span class="badge ' + (open >= 2 ? 'is-high' : 'is-medium') + '">' + open + ' 条待处理</span>';
  }

  /* 行动建议：D9 维度。基于风险等级 + 趋势 + 信息缺口生成可执行动作。 */
  function actionCell(p) {
    var grade = gradeRisk(p);
    var trend = p.trend_delta || 0;
    var gaps = p.gap_count || 0;
    var verb, text;

    if (grade === 'critical') {
      verb = '立即';
      text = '床旁复核生命体征，通知值班医生';
    } else if (grade === 'high') {
      verb = '尽快';
      text = trend >= 0.05 ? '复核生命体征并对比前 6 小时趋势' : '安排优先查房';
    } else if (grade === 'medium') {
      verb = '本轮';
      text = trend >= 0.05 ? '关注上升趋势，确认数据准确性' : '常规监护中留意变化';
    } else {
      verb = '按常规';
      text = '维持现有监测频率';
    }
    if (gaps > 0 && grade !== 'normal') {
      text += '；并补测 ' + gaps + ' 项缺失检验';
    }
    return '<div class="action-cell"><span class="verb">' + esc(verb) + '</span> ' + esc(text) + '</div>';
  }

  function renderRow(p) {
    var grade = gradeRisk(p);
    var rowCls = grade === 'critical' ? 'row-critical' : (grade === 'high' ? 'row-high' : '');
    if (state.selectedId === p.patient_id) rowCls += ' is-selected';

    var cells;
    if (state.mode === 'uncertainty') {
      cells = patientCell(p) +
              '<td>' + '<span class="badge ' + levelClass(grade) + '">' + levelZh(grade) + '</span></td>' +
              '<td class="num">' + trendCell(p) + '</td>' +
              '<td class="num">' + completeCell(p) + '</td>' +
              '<td>' + gapCell(p) + '</td>';
    } else if (state.mode === 'workload') {
      cells = patientCell(p) +
              '<td><span class="badge ' + levelClass(grade) + '">' + levelZh(grade) + '</span></td>' +
              '<td class="num">' + alertsCell(p) + '</td>' +
              '<td>' + handledCell(p) + '</td>' +
              '<td>' + actionCell(p) + '</td>';
    } else {
      cells = patientCell(p) +
              '<td>' + riskCell(p) + '</td>' +
              '<td class="num">' + trendCell(p) + '</td>' +
              '<td><canvas class="risk-spark" id="tr_' + p.patient_id + '" width="150" height="26"></canvas></td>' +
              '<td>' + actionCell(p) + '</td>';
    }

    return '<tr class="' + rowCls.trim() + '" data-id="' + esc(p.patient_id) + '">' + cells + '</tr>';
  }

  /* 当前视图的患者列表缓存：排序/筛选只在数据变化或视图切换时重算 */
  var currentList = [];

  function renderTable(reset) {
    var list = visiblePatients();
    currentList = list;
    virtualScroll.listLength = list.length;

    if (!list.length) {
      $('tableEmpty').style.display = '';
      $('tableWrap').style.display = 'none';
      $('tableBody').innerHTML = '';
      $('panelSub').textContent = '0 位符合条件';
      $('panelTitle').textContent = (VIEWS[state.view] || VIEWS.all).title + ' · 患者清单';
      $('footRange').innerHTML = '显示 <b>0</b> / 0 位患者';
      return;
    }
    $('tableEmpty').style.display = 'none';
    $('tableWrap').style.display = '';

    // 切换视图/排序/搜索时重置滚动位置
    if (reset) {
      virtualScroll.scrollTop = 0;
      $('tableWrap').scrollTop = 0;
    }
    if (!$('tableWrap').clientHeight) {
      // 首次渲染时容器可能还没布局，给一个合理默认值
      virtualScroll.viewportHeight = 600;
    }

    var win = virtualWindow(list.length);
    virtualScroll.startIndex = win.first;
    virtualScroll.endIndex = win.last;

    var slice = list.slice(win.first, win.last);
    var html = spacerRow(win.first * ROW_HEIGHT) +
               slice.map(renderRow).join('') +
               spacerRow((list.length - win.last) * ROW_HEIGHT);

    $('tableBody').innerHTML = html;
    drawSparks(slice);

    $('panelSub').textContent = list.length + ' 位符合条件';
    $('panelTitle').textContent = (VIEWS[state.view] || VIEWS.all).title + ' · 患者清单';
    $('footRange').innerHTML =
      '共 <b>' + list.length + '</b> 位患者' +
      (virtualScroll.enabled
        ? ' · 当前渲染第 ' + (win.first + 1) + '–' + win.last + ' 行'
        : '');
    $('footPerf').textContent = '本次加载 ' + Math.round(state.loadMs) + ' ms · ' +
      new Date(state.lastLoaded).toLocaleTimeString('zh-CN') +
      (virtualScroll.enabled ? ' · 虚拟滚动' : '');
  }

  /* 滚动时只重绘虚拟窗口，不重新排序 */
  var scrollRaf = null;
  function onTableScroll() {
    if (!virtualScroll.enabled) return;
    var wrap = $('tableWrap');
    virtualScroll.scrollTop = wrap.scrollTop;
    virtualScroll.viewportHeight = wrap.clientHeight || 600;

    // 用 requestAnimationFrame 合并高频滚动事件，避免每帧重排多次
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(function () {
      scrollRaf = null;
      var list = currentList;
      if (!list.length) return;
      var win = virtualWindow(list.length);
      if (win.first === virtualScroll.startIndex && win.last === virtualScroll.endIndex) {
        return;   // 窗口未变，无需重绘
      }
      virtualScroll.startIndex = win.first;
      virtualScroll.endIndex = win.last;
      var slice = list.slice(win.first, win.last);
      $('tableBody').innerHTML = spacerRow(win.first * ROW_HEIGHT) +
                                 slice.map(renderRow).join('') +
                                 spacerRow((list.length - win.last) * ROW_HEIGHT);
      drawSparks(slice);
      $('footRange').innerHTML = '共 <b>' + list.length + '</b> 位患者 · 当前渲染第 ' +
        (win.first + 1) + '–' + win.last + ' 行';
    });
  }

  function drawSparks(list) {
    list.forEach(function (p) {
      var series = p.risk_series || p.spark || null;
      // 列表接口可能不返回完整风险序列；此时用 峰值/当前 两点构造最简轨迹
      if (!series && p.peak_risk_score !== undefined && p.risk_score !== undefined) {
        series = [p.risk_score, (p.risk_score + p.peak_risk_score) / 2, p.peak_risk_score]
          .map(function (v) { return isFinite(v) ? v : 0; });
      }
      if (!series || series.length < 2) return;
      var color = riskColor(gradeRisk(p));
      var s1 = document.getElementById('sp_' + p.patient_id);
      if (s1) Charts.sparkline(s1, series, { color: color, fill: true });
      var s2 = document.getElementById('tr_' + p.patient_id);
      if (s2) Charts.sparkline(s2, series, { color: color, fill: true });
    });
  }

  /* ======================================================================
     Hero 决策句：整个病区的一句话结论
     ====================================================================== */
  function renderHero() {
    var list = state.patients;
    if (!list.length) {
      $('heroSentence').textContent = '尚未载入患者数据';
      $('heroNote').textContent = '请检查后端连接或数据缓存';
      return;
    }

    var counts = { critical: 0, high: 0, medium: 0, low: 0, normal: 0 };
    var rising = 0, gaps = 0, covered = 0;
    list.forEach(function (p) {
      counts[gradeRisk(p)] = (counts[gradeRisk(p)] || 0) + 1;
      if ((p.trend_delta || 0) >= 0.05) rising += 1;
      if ((p.gap_count || 0) > 0) gaps += 1;
      if ((p.alerts_hit || 0) > 0) covered += 1;
    });

    var sentence, note;
    if (counts.critical > 0) {
      sentence = '病区有 <span class="hl-critical">' + counts.critical +
                 ' 位极高风险患者</span>需要立即复核，另有 <span class="hl-high">' +
                 counts.high + ' 位高风险</span>建议优先查房';
      note = '极高风险 = 风险等级为高且近 6 小时持续上升。建议先看前 ' +
             Math.min(3, counts.critical + counts.high) + ' 位。';
    } else if (counts.high > 0) {
      sentence = '病区暂无极高风险患者，<span class="hl-high">' + counts.high +
                 ' 位高风险</span>建议在下一轮查房中优先安排';
      note = '当前分级阈值按队列分布标定，可切换到「不确定性」视图查看数据质量。';
    } else if (rising > 0) {
      sentence = '病区整体平稳，但有 <span class="hl-accent">' + rising +
                 ' 位患者风险正在上升</span>，值得提前关注';
      note = '趋势上升但绝对值不高时容易被漏掉，这正是连续预警系统相对规则评分的价值所在。';
    } else {
      sentence = '病区整体平稳，暂无需要立即干预的高风险患者';
      note = '系统持续在后台推理，风险变化会自动呈现在列表中。';
    }

    $('heroSentence').innerHTML = sentence;
    $('heroNote').textContent = note;
    $('heroFactCritical').textContent = counts.critical;
    $('heroFactHigh').textContent = counts.high;
    $('heroFactGaps').textContent = gaps;
    $('heroFactCoverage').textContent = list.length ? pct(covered / list.length, 0) : '—';
  }

  /* ======================================================================
     数据脉象层：数据新鲜度与模型不确定性（D3 + C）
     ====================================================================== */
  function renderVitals() {
    var health = state.health || {};
    var stats = state.stats || {};
    var host = $('vitalsStrip');

    var thresholds = stats.alert_thresholds || {};
    var cells = [];

    // 1) 队列规模
    var loaded = health.patients_loaded || stats.patients || 0;
    cells.push(cell('在监患者', loaded, '人', '本次装载的队列规模', null));

    // 2) 推理延迟
    var ms = stats.mean_inference_ms;
    var latRatio = ms === null || ms === undefined ? null : Math.min(1, ms / 5);
    cells.push(cell('单次推理', fmt(ms, 2), 'ms',
      (stats.inference_count || 0) + ' 次累计', latRatio,
      latRatio === null ? '' : (latRatio < 0.4 ? '' : (latRatio < 0.8 ? 'is-warn' : 'is-bad'))));

    // 3) 处理吞吐
    cells.push(cell('处理吞吐', fmt(stats.throughput_per_second, 0), '小时/秒',
      '流式特征管道 + 模型前向', null));

    // 4) 模型不确定性：预测阳性率 vs 预警触发率，两者差距越大越需谨慎
    var patients = state.patients.length || 1;
    var highRatio = (stats.patients_by_level && stats.patients_by_level.high || 0) / patients;
    cells.push(cell('高风险占比', pct(highRatio, 1), '',
      '越高说明当前队列整体越危险', highRatio,
      highRatio > 0.25 ? 'is-warn' : ''));

    // 5) 模型身份（不确定性显式化：必须让使用者知道跑的是什么）
    cells.push(cell('推理模型', (health.model_name || '—').slice(0, 12), '',
      '版本 ' + (health.model_version || '—'), null));

    // 6) 分级阈值（告知判定依据，而非黑箱）
    var mid = thresholds.medium;
    cells.push(cell('中风险阈值', mid === undefined ? '—' : fmt(mid, 4), '',
      '按队列分位数标定', null));

    host.innerHTML = cells.join('');

    function cell(label, value, unit, sub, ratio, barCls) {
      var bar = (ratio === null || ratio === undefined) ? ''
        : '<div class="vital-bar ' + (barCls || '') + '"><i style="width:' +
          Math.round(Math.max(0.02, Math.min(1, ratio)) * 100) + '%"></i></div>';
      return '<div class="vital-cell">' +
               '<div class="vital-cell-label">' + esc(label) + '</div>' +
               '<div class="vital-cell-value">' + esc(value) +
                 (unit ? ' <span style="font-size:11px;color:var(--text-dim);font-weight:400;">' +
                         esc(unit) + '</span>' : '') + '</div>' +
               '<div class="vital-cell-sub">' + esc(sub) + '</div>' +
               bar +
             '</div>';
    }
  }

  /* ======================================================================
     顶部告警条：只显示最高优先级的一条
     ====================================================================== */
  function renderAlertStrip() {
    var host = $('alertStripHost');
    var open = (state.alerts || []).filter(function (a) { return a.status === 'open'; });
    if (!open.length) { host.innerHTML = ''; return; }

    open.sort(function (a, b) { return (b.risk_score || 0) - (a.risk_score || 0); });
    var top = open[0];
    var isCritical = (top.level === 'high');
    host.innerHTML =
      '<div class="alert-strip' + (isCritical ? '' : ' is-medium') + '">' +
        '<div class="alert-strip-icon">' + (isCritical ? '⚠' : '◐') + '</div>' +
        '<div class="alert-strip-body">' +
          '<div class="alert-strip-title">' +
            esc(top.patient_id) + ' · 第 ' + top.trigger_time + ' 小时 · ' +
            esc(top.level_zh || levelZh(top.level)) +
            '（风险 ' + fmt(top.risk_score, 3) + '）' +
          '</div>' +
          '<div class="alert-strip-desc" id="alertReason">' +
            esc(top.reason_zh || '正在生成归因…') +
            (open.length > 1 ? ' · 另有 ' + (open.length - 1) + ' 条待处理告警' : '') +
          '</div>' +
        '</div>' +
        '<div class="alert-strip-actions">' +
          '<button class="btn is-ghost" data-act="view" data-id="' + esc(top.patient_id) + '">查看患者</button>' +
          '<button class="btn is-primary" data-act="ack" data-alert="' + esc(top.alert_id) + '">确认</button>' +
        '</div>' +
      '</div>';

    host.querySelectorAll('button[data-act]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (btn.dataset.act === 'view') openPatient(btn.dataset.id);
        else ackAlert(btn.dataset.alert, 'acknowledge');
      });
    });

    // 归因按需拉取（后端默认不在列表里返回，以换取启动速度）
    if (!top.reason_zh) {
      Api.alertExplain(top.alert_id).then(function (detail) {
        var reason = detail && detail.alert && detail.alert.reason_zh;
        var node = $('alertReason');
        if (reason && node) {
          node.textContent = reason +
            (open.length > 1 ? ' · 另有 ' + (open.length - 1) + ' 条待处理告警' : '');
        }
      }).catch(function () { /* 归因失败不影响告警本身 */ });
    }
  }

  /* ======================================================================
     左侧导航计数
     ====================================================================== */
  function renderNav() {
    var list = state.patients;
    var counts = { critical: 0, high: 0, medium: 0, low: 0, normal: 0 };
    var rising = 0, gaps = 0, septic = 0;
    list.forEach(function (p) {
      counts[gradeRisk(p)] += 1;
      if ((p.trend_delta || 0) >= 0.05) rising += 1;
      if ((p.gap_count || 0) > 0) gaps += 1;
      if (p.has_sepsis_label) septic += 1;
    });

    $('navCountAll').textContent = list.length;
    $('navCountCritical').textContent = counts.critical;
    $('navCountHigh').textContent = counts.high;
    $('navCountRising').textContent = rising;
    $('navCountGaps').textContent = gaps;
    $('navCountSeptic').textContent = septic;

    $('tkPatients').textContent = list.length;
    $('tkCritical').textContent = counts.critical;
    $('tkHigh').textContent = counts.high;
  }

  /* ======================================================================
     数据加载
     ====================================================================== */
  function setConn(kind, text) {
    var box = $('connBox');
    box.className = 'conn' + (kind ? ' is-' + kind : '');
    $('connText').textContent = text;
  }

  function loadAll(firstTime) {
    var started = performance.now();
    return Promise.all([
      Api.health().catch(function () { return null; }),
      Api.patients({ sort: 'risk', limit: 500 }).catch(function () { return null; }),
      Api.stats().catch(function () { return null; }),
      Api.alerts({ status: 'open', limit: 200 }).catch(function () { return null; })
    ]).then(function (res) {
      var health = res[0], patients = res[1], stats = res[2], alerts = res[3];

      state.health = health;
      state.stats = stats;
      state.alerts = (alerts && alerts.alerts) || [];
      state.patients = (patients && patients.patients) || [];
      state.loadMs = performance.now() - started;
      state.lastLoaded = Date.now();

      /* [静态快照版] 有 modeLabel 就用它给出如实的数据来源标签；
         原生版没有该方法，三元表达式分支保持原样，行为不变。 */
      setConn(Api.isOffline && Api.isOffline() ? 'offline' : 'online',
              Api.modeLabel ? Api.modeLabel()
              : (Api.isOffline && Api.isOffline() ? '离线演示模式' : '已连后端'));

      $('tkAlerts').textContent = state.alerts.filter(function (a) { return a.status === 'open'; }).length;
      var lead = stats && stats.median_early_warning_hours;
      $('tkLead').textContent = (lead === null || lead === undefined) ? '—' : fmt(lead, 1);
      $('navModel').textContent = '模型版本：' + ((health && health.model_version) || '—');
      var th = (stats && stats.alert_thresholds) || {};
      $('navThreshold').textContent = '分级阈值：' +
        (th.medium === undefined ? '—' : fmt(th.low, 4) + ' / ' + fmt(th.medium, 4) + ' / ' + fmt(th.high, 4));
      $('footPerf').textContent = '本次加载 ' + Math.round(state.loadMs) + ' ms · ' +
        new Date(state.lastLoaded).toLocaleTimeString('zh-CN');

      renderHead();
      renderHero();
      renderVitals();
      renderNav();
      renderAlertStrip();
      renderTable(true);

      if (firstTime) preloadSparkSeries();
    });
  }

  /* 列表接口若不返回风险轨迹，则按需并发拉取详情补齐（有上限，避免打爆后端） */
  function preloadSparkSeries() {
    var limit = 24;
    var need = state.patients
      .filter(function (p) { return !p.risk_series && !p.spark; })
      .slice(0, limit);
    if (!need.length) return;
    need.forEach(function (p) {
      Api.patient(p.patient_id).then(function (detail) {
        if (detail && Array.isArray(detail.risk_series)) {
          p.risk_series = detail.risk_series;
        }
      }).catch(function () { /* 忽略：迷你图缺失不影响主流程 */ });
    });
  }

  /* ======================================================================
     患者详情抽屉
     ====================================================================== */
  function openPatient(patientId) {
    state.selectedId = patientId;
    $('drawer').classList.add('is-open');
    $('drawer').setAttribute('aria-hidden', 'false');
    $('drawerBackdrop').classList.add('is-open');
    $('drawerBody').innerHTML = '<div class="skeleton" style="height:80px;margin-bottom:12px;"></div>' +
                                '<div class="skeleton" style="height:160px;"></div>';

    var patient = state.patients.filter(function (p) { return p.patient_id === patientId; })[0];

    Promise.all([
      Api.patient(patientId).catch(function () { return null; }),
      Api.risk(patientId).catch(function () { return null; })
    ]).then(function (res) {
      var detail = res[0], risk = res[1];
      renderDrawer(patient, detail, risk);
    });
  }

  function closeDrawer() {
    state.selectedId = null;
    $('drawer').classList.remove('is-open');
    $('drawer').setAttribute('aria-hidden', 'true');
    $('drawerBackdrop').classList.remove('is-open');
    document.querySelectorAll('tr.is-selected').forEach(function (tr) {
      tr.classList.remove('is-selected');
    });
  }

  function renderDrawer(patient, detail, risk) {
    if (!patient && detail && detail.patient) patient = detail.patient;
    if (!patient) {
      $('drawerBody').innerHTML = '<div class="empty"><div class="empty-title">无法加载患者信息</div></div>';
      return;
    }

    var grade = gradeRisk(patient);
    var ts = (detail && detail.timeseries) || { hours: [], variables: {} };
    var riskSeries = (detail && detail.risk_series) || patient.risk_series || [];
    var alerts = (detail && detail.alerts) || [];

    $('drawerTitle').innerHTML =
      esc(patient.patient_id) +
      ' <span class="badge ' + levelClass(grade) + '">' + levelZh(grade) + '</span>' +
      (patient.has_sepsis_label
        ? ' <span class="badge is-low" title="数据集标注的脓毒症发作患者">数据集标注：已发作</span>' : '');

    var onSet = patient.onset_hour;
    $('drawerSub').textContent =
      (patient.bed || '—') + ' · ' + (patient.gender_zh || '—') + ' ' +
      (patient.age ? Math.round(patient.age) + '岁' : '—') +
      ' · ICU 住院 ' + (patient.icu_los_hours || 0) + ' 小时' +
      (onSet !== null && onSet !== undefined ? ' · 发作于第 ' + onSet + ' 小时' : '') +
      ' · 峰值风险 ' + fmt(patient.peak_risk_score, 3);

    var html = '';

    /* ---- 1. 患者轨迹（状态机标签，E 维度） ---- */
    html += '<div class="dsec"><div class="dsec-head"><span class="dsec-title">临床路径位置</span></div>';
    html += renderTrack(patient, risk);
    html += '</div>';

    /* ---- 2. 行动建议（D9：最重要的一块，放最前面） ---- */
    html += '<div class="dsec"><div class="dsec-head"><span class="dsec-title">建议下一步行动</span></div>';
    html += renderActionPanel(patient, grade, risk);
    html += '</div>';

    /* ---- 3. 不确定性显式化（D3） ---- */
    html += '<div class="dsec"><div class="dsec-head"><span class="dsec-title">判定依据与不确定性</span></div>';
    html += renderUncertainty(risk, patient);
    html += '</div>';

    /* ---- 4. 风险轨迹 ---- */
    html += '<div class="dsec"><div class="dsec-head"><span class="dsec-title">风险轨迹</span></div>';
    html += '<div class="chart-box"><canvas id="drawerRisk" width="860" height="150"></canvas></div>';
    html += '<div class="chart-legend">' +
              '<span class="legend-chip"><span class="swatch" style="background:#ef4444"></span>风险分数</span>' +
              '<span class="legend-chip"><span class="swatch" style="background:#eab308"></span>告警触发点</span>' +
              (patient.onset_hour !== null && patient.onset_hour !== undefined
                ? '<span class="legend-chip"><span class="swatch" style="background:#a78bfa"></span>脓毒症发作</span>' : '') +
            '</div>';
    html += '</div>';

    /* ---- 5. 关键指标（当前值 + 参考范围） ---- */
    html += '<div class="dsec"><div class="dsec-head"><span class="dsec-title">关键指标</span></div>';
    html += renderKpis(ts);
    html += '</div>';

    /* ---- 6. 指标时序 ---- */
    html += '<div class="dsec"><div class="dsec-head"><span class="dsec-title">指标时序（多指标叠加）</span></div>';
    html += '<div class="chart-box"><canvas id="drawerSeries" width="860" height="190"></canvas></div>';
    html += '<div class="chart-legend" id="seriesLegend"></div>';
    html += '</div>';

    /* ---- 7. 归因（可解释性，临床语言化） ---- */
    var topFeatures = (risk && risk.top_features) || [];
    html += '<div class="dsec"><div class="dsec-head"><span class="dsec-title">风险归因（模型视角）</span></div>';
    html += renderAttributions(topFeatures, risk);
    html += '</div>';

    /* ---- 8. 信息缺口（把不确定性转化为可执行动作） ---- */
    var gaps = (risk && risk.information_gaps) || [];
    html += '<div class="dsec"><div class="dsec-head"><span class="dsec-title">信息缺口（补测可提升置信度）</span></div>';
    html += renderGaps(gaps);
    html += '</div>';

    /* ---- 9. 告警历史 ---- */
    html += '<div class="dsec"><div class="dsec-head"><span class="dsec-title">告警历史</span></div>';
    html += renderAlertHistory(alerts);
    html += '</div>';

    $('drawerBody').innerHTML = html;

    // 图表在 DOM 插入后再绘制
    requestAnimationFrame(function () {
      drawDrawerCharts(ts, riskSeries, alerts, patient);
    });
  }

  /* ---- 临床路径位置 ---- */
  function renderTrack(patient, risk) {
    var level = (risk && risk.risk_level) || gradeRisk(patient);
    var trend = patient.trend_delta || 0;
    var stages = [
      { key: 'normal', label: '常规监护' },
      { key: 'watch',  label: '加密观察' },
      { key: 'alert',  label: '启动评估' },
      { key: 'action', label: '临床干预' }
    ];
    var idx = 0;
    if (level === 'low') idx = 1;
    else if (level === 'medium') idx = 2;
    else if (level === 'high' || level === 'critical') idx = 3;
    if (trend >= 0.05 && idx < 3) idx += 1;

    return '<div class="track">' + stages.map(function (s, i) {
      var cls = i < idx ? 'is-done' : (i === idx ? 'is-now' : '');
      var link = i < stages.length - 1 ? '<div class="track-link"></div>' : '';
      return '<div class="track-step">' +
               '<div class="track-node ' + cls + '">' +
                 '<div class="track-dot"></div>' +
                 '<div class="track-label">' + esc(s.label) + '</div>' +
               '</div>' + link +
             '</div>';
    }).join('') + '</div>';
  }

  /* ---- 行动建议面板 ---- */
  function renderActionPanel(patient, grade, risk) {
    var rec = (risk && risk.recommended_action) || {};
    var action = rec.action_zh || defaultAction(grade);
    var response = rec.response_zh || '';
    var trend = patient.trend_delta || 0;
    var gaps = (risk && risk.information_gaps) || [];

    var html = '<div class="attr-item" style="border-color:var(--border-hi);">' +
                 '<div style="font-size:14px;font-weight:600;color:var(--accent-hi);">' +
                   esc(action) + '</div>' +
                 (response ? '<div class="attr-phrase" style="margin-top:4px;">' + esc(response) + '</div>' : '') +
               '</div>';

    // 生成"为什么是这一步"的依据链
    var reasons = [];
    reasons.push('当前风险分数 ' + fmt(patient.risk_score, 3) + '，等级「' + levelZh(grade) + '」');
    if (trend >= 0.05) reasons.push('近 6 小时风险上升 ' + fmt(trend, 3) + '，趋势向上');
    else if (trend <= -0.05) reasons.push('近 6 小时风险下降 ' + fmt(Math.abs(trend), 3) + '，趋势向好');
    if (patient.peak_risk_score >= 0.5) reasons.push('历史峰值 ' + fmt(patient.peak_risk_score, 3));
    if (gaps.length) reasons.push('有 ' + gaps.length + ' 项关键检验缺失或陈旧');

    html += '<div style="margin-top:8px;font-size:12px;color:var(--text-muted);line-height:1.5;">' +
            '<b style="color:var(--text-dim);">依据：</b>' + esc(reasons.join('；')) + '</div>';

    return html;
  }

  function defaultAction(grade) {
    return {
      critical: '建议立即复核生命体征与关键检验，并尽快由医生床旁评估',
      high: '建议尽快复核生命体征，对比前 6 小时趋势',
      medium: '建议在下一轮查房中关注该患者趋势',
      low: '建议按常规频率继续监测',
      normal: '无需额外干预，按病区常规频率监测'
    }[grade] || '按常规监测';
  }

  /* ---- 不确定性面板：明确告知"这个结论有多可信" ---- */
  function renderUncertainty(risk, patient) {
    var html = '<div class="kpi-row">';

    var source = (risk && risk.explanation_source) || 'unknown';
    var sourceZh = source === 'model'
      ? '模型归因（梯度提升贡献度）'
      : (source === 'heuristic' ? '启发式归因（临床参考范围偏离）' : '未知');
    html += kpiCard('归因来源', sourceZh, '', source === 'model' ? '' : 'is-watch');

    var conf = risk && risk.confidence;
    html += kpiCard('模型置信度',
      conf === null || conf === undefined ? '未提供' : pct(conf, 0), '',
      (conf !== null && conf !== undefined && conf < 0.6) ? 'is-watch' : '');

    var ratio = completeness(patient);
    html += kpiCard('数据完整度',
      ratio === null ? '—' : pct(ratio, 0), '',
      (ratio !== null && ratio < 0.5) ? 'is-watch' : '');

    var gaps = (risk && risk.information_gaps) || [];
    html += kpiCard('信息缺口', String(gaps.length), '项', gaps.length >= 2 ? 'is-watch' : '');

    html += '</div>';
    html += '<p class="disclaimer-inline" style="margin-top:8px;">' +
            '置信度与完整度较低时，风险分数的可信度下降，建议先补充缺失检验再作判断。</p>';
    return html;
  }

  function kpiCard(label, value, unit, cls) {
    return '<div class="kpi ' + (cls || '') + '">' +
             '<div class="kpi-label">' + esc(label) + '</div>' +
             '<div class="kpi-value">' + esc(value) +
               (unit ? '<span class="unit">' + esc(unit) + '</span>' : '') + '</div>' +
           '</div>';
  }

  /* ---- 关键指标卡：当前值 + 参考范围 + 异常高亮 ---- */
  function renderKpis(ts) {
    var vars = ts.variables || {};
    var names = Object.keys(vars).filter(function (name) {
      return VITAL_REFS[name];
    });
    if (!names.length) return '<p class="dim" style="font-size:12px;">该患者暂无可展示的指标数据。</p>';

    return '<div class="kpi-row">' + names.map(function (name) {
      var ref = VITAL_REFS[name];
      var series = vars[name] || [];
      var last = null;
      for (var i = series.length - 1; i >= 0; i--) {
        if (series[i] !== null && series[i] !== undefined && isFinite(series[i])) { last = series[i]; break; }
      }
      var cls = '';
      if (last !== null) {
        if (last > ref.hi || last < ref.lo) cls = 'is-watch';
        var severe = ref.hi + (ref.hi - ref.lo) * 0.5;
        var severeLow = ref.lo - (ref.hi - ref.lo) * 0.5;
        if (last > severe || last < severeLow) cls = 'is-abnormal';
      }
      return '<div class="kpi ' + cls + '">' +
               '<div class="kpi-label">' + esc(ref.zh) + '</div>' +
               '<div class="kpi-value">' + (last === null ? '—' : fmt(last, ref.hi > 50 ? 0 : 1)) +
                 '<span class="unit">' + esc(ref.unit) + '</span></div>' +
               '<div class="kpi-ref">参考 ' + ref.lo + '–' + ref.hi + '</div>' +
             '</div>';
    }).join('') + '</div>';
  }

  /* ---- 归因列表 ---- */
  function renderAttributions(items, risk) {
    if (!items.length) {
      return '<p class="dim" style="font-size:12px;">暂无可用的归因信息。</p>';
    }
    var html = '<div class="attr-list">';
    items.forEach(function (item) {
      var contrib = item.contribution || 0;
      var isPos = contrib >= 0;
      var width = Math.min(50, Math.abs(contrib) * 50);
      html += '<div class="attr-item">' +
                '<div class="attr-top">' +
                  '<span class="attr-name">' + esc(item.name_zh || item.variable || item.feature) + '</span>' +
                  '<span class="attr-contrib ' + (isPos ? 'is-pos' : 'is-neg') + '">' +
                    (isPos ? '+' : '') + fmt(contrib, 3) +
                    (isPos ? ' 推高' : ' 抵消') +
                  '</span>' +
                '</div>' +
                '<div class="attr-bar"><i class="' + (isPos ? 'is-pos' : 'is-neg') +
                  '" style="width:' + width.toFixed(1) + '%"></i></div>' +
                '<div class="attr-phrase">' + esc(item.phrase_zh || '') + '</div>' +
              '</div>';
    });
    html += '</div>';
    if (risk && risk.explanation_source === 'heuristic') {
      html += '<p class="disclaimer-inline" style="margin-top:8px;">' +
              '当前为启发式归因（基于临床参考范围的偏离度），不是模型贡献度。' +
              '加载训练好的模型后会自动切换为模型归因。</p>';
    }
    return html;
  }

  /* ---- 信息缺口 ---- */
  function renderGaps(gaps) {
    if (!gaps.length) {
      return '<p class="dim" style="font-size:12px;">关键检验目前无缺口。</p>';
    }
    return '<div class="gap-list">' + gaps.map(function (gap) {
      return '<div class="gap-item">' +
               '<span class="gi-icon">◌</span>' +
               '<span>' + esc(gap.phrase_zh || (gap.name_zh + '未测量')) + '</span>' +
             '</div>';
    }).join('') + '</div>';
  }

  /* ---- 告警历史 ---- */
  function renderAlertHistory(alerts) {
    if (!alerts.length) {
      return '<p class="dim" style="font-size:12px;">该患者暂无告警记录。</p>';
    }
    var statusZh = { open: '待处理', acknowledged: '已确认', ignored: '已忽略', snoozed: '稍后提醒' };
    var html = '<div class="attr-list">';
    alerts.forEach(function (a) {
      html += '<div class="attr-item">' +
                '<div class="attr-top">' +
                  '<span class="badge ' + levelClass(a.level) + '">' +
                    esc(a.level_zh || levelZh(a.level)) + '</span>' +
                  '<span class="mono" style="font-size:12px;color:var(--text-muted);">第 ' +
                    a.trigger_time + ' 小时</span>' +
                  '<span class="attr-contrib" style="color:var(--text-dim);">' +
                    esc(statusZh[a.status] || a.status) + '</span>' +
                '</div>' +
                '<div class="attr-phrase">' + esc(a.reason_zh || '') + '</div>';
      if (a.status === 'open') {
        html += '<div style="margin-top:6px;display:flex;gap:6px;">' +
                  '<button class="btn" data-ack="' + esc(a.alert_id) + '" data-action="acknowledge">确认</button>' +
                  '<button class="btn is-ghost" data-ack="' + esc(a.alert_id) + '" data-action="snooze">稍后提醒</button>' +
                  '<button class="btn is-danger" data-ack="' + esc(a.alert_id) + '" data-action="ignore">忽略</button>' +
                '</div>';
      }
      html += '</div>';
    });
    html += '</div>';

    // 事件委托
    setTimeout(function () {
      $('drawerBody').querySelectorAll('button[data-ack]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var action = btn.dataset.action;
          if (action === 'ignore') askReason(btn.dataset.ack);
          else ackAlert(btn.dataset.ack, action);
        });
      });
    }, 0);

    return html;
  }

  /* ---- 抽屉内图表 ---- */
  function drawDrawerCharts(ts, riskSeries, alerts, patient) {
    var riskCanvas = $('drawerRisk');
    if (riskCanvas && riskSeries && riskSeries.length) {
      var hours = riskSeries.map(function (_, i) { return i + 1; });
      var vlines = (alerts || []).map(function (a) {
        return { x: a.trigger_time, color: '#eab308', label: '告警' };
      });
      var bands = [];
      if (patient.onset_hour !== null && patient.onset_hour !== undefined) {
        bands.push({ from: patient.onset_hour - 12, to: patient.onset_hour + 3,
                     color: 'rgba(167,139,250,0.16)', label: '获益窗' });
      }
      Charts.lineChart(riskCanvas, {
        hours: hours,
        series: [{ name: '风险分数', values: riskSeries, color: '#ef4444' }],
        yMin: 0, yMax: 1, yLabel: '风险', xLabel: 'ICU 小时',
        vlines: vlines, bands: bands, fill: true
      });
    }

    var seriesCanvas = $('drawerSeries');
    var vars = ts.variables || {};
    var names = Object.keys(vars).filter(function (n) { return VITAL_REFS[n]; });
    if (seriesCanvas && names.length && ts.hours && ts.hours.length) {
      var series = names.map(function (n) {
        return { name: VITAL_REFS[n].zh, values: vars[n], color: SERIES_COLORS[n] || '#94a3b8', key: n };
      });
      // 多指标量纲差异大，按各自参考区间归一化后叠加，悬浮仍可看真实值
      var chartCfg = {
        hours: ts.hours, series: series, yMin: 0, yMax: 100,
        yLabel: '参考区间百分比（0%=下限 100%=上限）', xLabel: 'ICU 小时',
        normalize: names.length > 1, unitMap: VITAL_REFS
      };
      Charts.lineChart(seriesCanvas, chartCfg);

      // 图例可点击切换
      var legend = $('seriesLegend');
      if (legend) {
        legend.innerHTML = series.map(function (s, i) {
          return '<span class="legend-chip" data-idx="' + i + '">' +
                   '<span class="swatch" style="background:' + s.color + '"></span>' +
                   esc(s.name) + '</span>';
        }).join('');
        legend.querySelectorAll('.legend-chip').forEach(function (chip) {
          chip.addEventListener('click', function () {
            chip.classList.toggle('is-off');
            var idx = Number(chip.dataset.idx);
            var next = series.map(function (s, i) {
              return { name: s.name, values: s.values, color: s.color, key: s.key,
                       hidden: legend.querySelectorAll('.legend-chip')[i].classList.contains('is-off') };
            });
            chartCfg.series = next;
            Charts.lineChart(seriesCanvas, chartCfg);
          });
        });
      }
    }
  }

  /* ======================================================================
     告警处理
     ====================================================================== */
  function ackAlert(alertId, action, reason) {
    Api.ackAlert(alertId, { action: action, reason: reason || null, handled_by: '临床控制台' })
      .then(function () {
        var target = state.alerts.filter(function (a) { return a.alert_id === alertId; })[0];
        if (target) {
          target.status = action === 'acknowledge' ? 'acknowledged'
                        : (action === 'ignore' ? 'ignored' : 'snoozed');
        }
        renderAlertStrip();
        $('tkAlerts').textContent = state.alerts.filter(function (a) { return a.status === 'open'; }).length;
        if (state.selectedId) openPatient(state.selectedId);
      })
      .catch(function (err) {
        console.error('[哨兵] 告警处理失败', err);
      });
  }

  var pendingAlertId = null;
  function askReason(alertId) {
    pendingAlertId = alertId;
    $('reasonModal').classList.add('is-open');
  }

  function closeReason() {
    $('reasonModal').classList.remove('is-open');
    pendingAlertId = null;
  }

  /* ======================================================================
     事件绑定
     ====================================================================== */
  function bindEvents() {
    // 左侧导航
    document.querySelectorAll('.nav-item[data-view]').forEach(function (item) {
      item.addEventListener('click', function () {
        document.querySelectorAll('.nav-item').forEach(function (n) { n.classList.remove('is-active'); });
        item.classList.add('is-active');
        state.view = item.dataset.view;
        var view = VIEWS[state.view] || VIEWS.all;
        $('viewTitle').textContent = view.title;
        $('viewDesc').textContent = view.desc;
        if (view.sort) { state.sort = view.sort; $('sortSelect').value = view.sort; }
        renderTable(true);
      });
    });

    // 表格视图模式
    $('segmentTools').querySelectorAll('button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        $('segmentTools').querySelectorAll('button').forEach(function (b) { b.classList.remove('is-active'); });
        btn.classList.add('is-active');
        state.mode = btn.dataset.mode;
        renderHead();
        renderTable(true);
      });
    });

    $('searchInput').addEventListener('input', function (e) {
      state.search = e.target.value.trim();
      renderTable(true);
    });

    $('sortSelect').addEventListener('change', function (e) {
      state.sort = e.target.value;
      renderTable(true);
    });

    $('refreshBtn').addEventListener('click', function () { loadAll(false); });

    // 表格行点击 → 打开抽屉
    $('tableBody').addEventListener('click', function (e) {
      var tr = e.target.closest('tr[data-id]');
      if (!tr) return;
      document.querySelectorAll('#tableBody tr').forEach(function (r) { r.classList.remove('is-selected'); });
      tr.classList.add('is-selected');
      state.selectedId = tr.dataset.id;
      openPatient(tr.dataset.id);
    });

    // 虚拟滚动：滚动时只重绘可见窗口
    $('tableWrap').addEventListener('scroll', onTableScroll, { passive: true });
    window.addEventListener('resize', function () {
      virtualScroll.viewportHeight = $('tableWrap').clientHeight || 600;
      renderTable(false);
    });

    $('drawerClose').addEventListener('click', closeDrawer);
    $('drawerBackdrop').addEventListener('click', closeDrawer);

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { closeDrawer(); closeReason(); return; }

      // 在输入框里时不拦截按键
      var tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        return;
      }

      // 数字键 1-6 快速切换临床视图（与左侧导航顺序一致）
      var viewKeys = ['all', 'critical', 'high', 'rising', 'gaps', 'septic'];
      if (e.key >= '1' && e.key <= '6') {
        var target = document.querySelector('.nav-item[data-view="' + viewKeys[Number(e.key) - 1] + '"]');
        if (target) { target.click(); e.preventDefault(); }
        return;
      }

      // / 聚焦搜索框，符合运维/临床控制台的通用习惯
      if (e.key === '/') {
        $('searchInput').focus();
        e.preventDefault();
        return;
      }

      // j / k 或上下方向键：在患者列表中移动选择，Enter 打开详情
      // 这是高密度操作界面的关键交互——键盘流转比鼠标快得多
      if (e.key === 'j' || e.key === 'k' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!currentList.length) return;
        var step = (e.key === 'j' || e.key === 'ArrowDown') ? 1 : -1;
        var index = 0;
        if (state.selectedId) {
          for (var i = 0; i < currentList.length; i++) {
            if (currentList[i].patient_id === state.selectedId) { index = i; break; }
          }
        }
        var next = Math.max(0, Math.min(currentList.length - 1, index + step));
        var patient = currentList[next];
        state.selectedId = patient.patient_id;

        // 滚动到该行（虚拟滚动下需要先滚动才能让行进入 DOM）
        var wrap = $('tableWrap');
        var desiredTop = next * ROW_HEIGHT - wrap.clientHeight / 2 + ROW_HEIGHT / 2;
        wrap.scrollTop = Math.max(0, desiredTop);
        onTableScroll();
        requestAnimationFrame(function () {
          var row = document.querySelector('#tableBody tr[data-id="' + patient.patient_id + '"]');
          document.querySelectorAll('#tableBody tr').forEach(function (r) { r.classList.remove('is-selected'); });
          if (row) row.classList.add('is-selected');
        });
        e.preventDefault();
        return;
      }

      if (e.key === 'Enter' && state.selectedId) {
        openPatient(state.selectedId);
        e.preventDefault();
      }
    });

    // 忽略原因
    $('reasonOptions').querySelectorAll('.radio-item').forEach(function (item) {
      item.addEventListener('click', function () {
        $('reasonOptions').querySelectorAll('.radio-item').forEach(function (i) { i.classList.remove('is-on'); });
        item.classList.add('is-on');
        item.querySelector('input').checked = true;
      });
    });
    $('reasonCancel').addEventListener('click', closeReason);
    $('reasonConfirm').addEventListener('click', function () {
      var chosen = $('reasonOptions').querySelector('.radio-item.is-on');
      var reason = chosen ? chosen.dataset.reason : '其他';
      var id = pendingAlertId;
      closeReason();
      if (id) ackAlert(id, 'ignore', reason);
    });

    // 导出当前视图
    $('navExport').addEventListener('click', function () {
      var list = visiblePatients();
      var rows = [['患者编号', '床号', '年龄', '性别', 'ICU住院小时', '风险分数',
                   '峰值风险', '趋势', '等级', '信息缺口数']];
      list.forEach(function (p) {
        rows.push([p.patient_id, p.bed, p.age, p.gender_zh, p.icu_los_hours,
                   p.risk_score, p.peak_risk_score, p.trend_delta,
                   levelZh(gradeRisk(p)), p.gap_count || 0]);
      });
      var csv = '\ufeff' + rows.map(function (r) {
        return r.map(function (c) { return '"' + String(c === null || c === undefined ? '' : c) + '"'; }).join(',');
      }).join('\n');
      var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'sepsisguard_' + state.view + '_' + new Date().toISOString().slice(0, 10) + '.csv';
      a.click();
      URL.revokeObjectURL(url);
    });

    // 自动刷新
    var timer = null;
    function scheduleRefresh() {
      if (timer) clearInterval(timer);
      if ($('autoRefresh').checked) {
        timer = setInterval(function () { loadAll(false); }, REFRESH_MS);
      }
    }
    $('autoRefresh').addEventListener('change', scheduleRefresh);
    scheduleRefresh();
  }

  /* ======================================================================
     启动
     ====================================================================== */
  function boot() {
    if (!Api || !Charts) {
      document.body.innerHTML = '<div class="empty" style="padding:80px 20px;">' +
        '<div class="empty-title">依赖脚本未加载</div>' +
        '<div class="empty-desc">请确认 js/api.js 与 js/charts.js 可用</div></div>';
      return;
    }
    renderHead();
    bindEvents();
    loadAll(true);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  global.SGConsole = {
    refresh: function () { return loadAll(false); },
    state: state
  };
})(window);
