/* ============================================================================
 * 哨兵 SepsisGuard —— 手动录入页脚本（manual.js）
 * ----------------------------------------------------------------------------
 * 设计目标：**让不熟悉临床参考值的人也能正确录入**。
 *
 * 三条措施：
 *   1. 指标全部预先枚举（来自后端 /api/manual/schema），使用者只需拖滑条，
 *      不需要知道"肌酐多少算高"。
 *   2. 滑条底色直接画出正常区 / 注意区 / 危险区，拖动时数值颜色同步变化。
 *   3. 滑条范围即生理可能范围，超出该范围的输入在界面上无法产生、
 *      在后端也会被拒绝——两道防线，杜绝离谱数值。
 *
 * 录入后立即调用 /api/report/assess 试算：不写库，先把结论摆出来。
 * 只有点「提交并保存」才写入手动录入存储，随后可生成正式报告。
 * ========================================================================== */
(function (global) {
  'use strict';

  var API_BASE = String(global.SEPSISGUARD_API || '').replace(/\/+$/, '');

  var LEVEL_COLOR = {
    normal: '#22c55e', low: '#38bdf8', medium: '#eab308', high: '#f97316', critical: '#ef4444'
  };

  var State = {
    fields: [],
    groups: [],
    schema: null,
    values: {},          // 变量 -> 数值（仅已录入项）
    trial: null,
    trialTimer: null,
    onlySet: false,
    rejected: 0,
    patients: []
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

  function escapeHtml(text) {
    return String(text === null || text === undefined ? '' : text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

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

  /* ------------------------------------------------------------------ *
   * 滑条分区底色
   * ------------------------------------------------------------------ */
  function trackGradient(field) {
    var lo = Number(field.plausible[0]);
    var hi = Number(field.plausible[1]);
    var span = Math.max(hi - lo, 1e-9);
    var normal = field.normal || [null, null];
    var caution = field.caution || [null, null];

    function pos(v) {
      if (v === null || v === undefined) return null;
      var t = (Number(v) - lo) / span;
      return Math.max(0, Math.min(1, t * 100));
    }

    var stops = [];
    var nLo = pos(normal[0]), nHi = pos(normal[1]);
    var cLo = pos(caution[0]), cHi = pos(caution[1]);

    // 全部区间都缺失时给一个中性底色
    if (nLo === null || nHi === null) {
      return 'linear-gradient(90deg, #334155, #475569)';
    }
    var outerLo = (cLo === null) ? 0 : cLo;
    var outerHi = (cHi === null) ? 100 : cHi;

    // 危险区（红） → 注意区（黄） → 常见区（绿） → 注意区（黄） → 危险区（红）
    stops.push('rgba(239,68,68,0.55) 0%');
    stops.push('rgba(239,68,68,0.55) ' + outerLo.toFixed(1) + '%');
    stops.push('rgba(234,179,8,0.5) ' + outerLo.toFixed(1) + '%');
    stops.push('rgba(234,179,8,0.5) ' + nLo.toFixed(1) + '%');
    stops.push('rgba(34,197,94,0.5) ' + nLo.toFixed(1) + '%');
    stops.push('rgba(34,197,94,0.5) ' + nHi.toFixed(1) + '%');
    stops.push('rgba(234,179,8,0.5) ' + nHi.toFixed(1) + '%');
    stops.push('rgba(234,179,8,0.5) ' + outerHi.toFixed(1) + '%');
    stops.push('rgba(239,68,68,0.55) ' + outerHi.toFixed(1) + '%');
    stops.push('rgba(239,68,68,0.55) 100%');
    return 'linear-gradient(90deg, ' + stops.join(', ') + ')';
  }

  function statusOf(field, value) {
    if (value === null || value === undefined || value === '') return 'empty';
    var v = Number(value);
    var normal = field.normal || [null, null];
    if (normal[0] === null || normal[1] === null) return 'normal';
    if (v >= Number(normal[0]) && v <= Number(normal[1])) return 'normal';
    var caution = field.caution || [null, null];
    var span = Math.max(Number(normal[1]) - Number(normal[0]), 1e-9);
    var outerLo = (caution[0] === null) ? Number(normal[0]) - span * 0.5 : Number(caution[0]);
    var outerHi = (caution[1] === null) ? Number(normal[1]) + span * 0.5 : Number(caution[1]);
    if (v >= outerLo && v <= outerHi) return 'caution';
    return 'alert';
  }

  /* ------------------------------------------------------------------ *
   * 渲染字段
   * ------------------------------------------------------------------ */
  function renderFields() {
    var host = clear($('entryGroups'));
    if (!State.fields.length) {
      // 指标定义是**内置的固定字典**，正常绝不该为空。若真为空说明脚本没加载
      // （例如把单个 html 拷走而没带上 js 目录），因此提示要指向真正的原因。
      host.appendChild(el('p', 'dim',
        '没有读取到指标定义。本页的 40 项指标定义内置在 js/varspec.js 中，' +
        '请确认该文件与 js/sim-core.js 一起存在（整个 web/ 目录需要完整拷贝）。'));
      return;
    }
    $('heroFactFields').textContent = State.fields.length;
    if ($('tkFields')) $('tkFields').textContent = State.fields.length + ' 项';

    State.groups.forEach(function (group) {
      var fields = State.fields.filter(function (f) { return f.group === group.key; });
      if (!fields.length) return;
      if (State.onlySet) {
        fields = fields.filter(function (f) {
          return State.values[f.name] !== undefined;
        });
        if (!fields.length) return;
      }

      var wrap = el('div', 'entry-group');
      var head = el('div', 'entry-group-head');
      head.appendChild(el('div', 'entry-group-title', group.name_zh));
      head.appendChild(el('div', 'faint', group.description || ''));
      wrap.appendChild(head);

      var grid = el('div', 'field-grid');
      fields.forEach(function (field) { grid.appendChild(renderField(field)); });
      wrap.appendChild(grid);
      host.appendChild(wrap);
    });

    if (State.onlySet && !host.childNodes.length) {
      host.appendChild(el('p', 'dim', '还没有录入任何指标。取消「只看已录入」后可拖动滑条。'));
    }
    updateCounters();
  }

  function renderField(field) {
    var box = el('div', 'mfield');
    box.dataset.var = field.name;
    var value = State.values[field.name];
    var status = statusOf(field, value);
    box.classList.add('is-' + (status === 'empty' ? 'empty' : 'set'));
    if (status === 'alert') box.classList.add('is-alert');
    if (status === 'caution') box.classList.add('is-caution');

    var head = el('div', 'mfield-head');
    head.appendChild(el('span', 'mfield-name', field.name_zh));
    if (field.unit) head.appendChild(el('span', 'mfield-unit', field.unit));
    var valueSpan = el('span', 'mfield-value is-' + (
      value === undefined ? 'empty' :
      status === 'normal' ? 'normal' : status === 'caution' ? 'caution' : 'abnormal'
    ), value === undefined ? '未录入' : fmt(value, decimalsFor(field)));
    head.appendChild(valueSpan);
    box.appendChild(head);

    var range = el('div', 'mfield-range');
    var normal = (field.normal && field.normal[0] !== null)
      ? '常见 ' + fmt(field.normal[0], 1) + '–' + fmt(field.normal[1], 1)
      : '无通用参考范围';
    range.textContent = normal + ' · 可接受 ' + fmt(field.plausible[0], 1) + '–' +
      fmt(field.plausible[1], 1);
    box.appendChild(range);

    if (field.hint) {
      box.appendChild(el('div', 'mfield-range', field.hint));
    }

    if (field.options) {
      // 离散字段（性别、监护单元）用下拉而非滑条：它们没有连续区间，
      // 画分区底色会误导使用者以为"中间值更好"。
      var select = document.createElement('select');
      select.style.cssText = 'width:100%;background:var(--surface);border:1px solid var(--border);' +
        'border-radius:3px;padding:4px 6px;color:var(--text);font-size:12px;';
      var optEmpty = document.createElement('option');
      optEmpty.value = '';
      optEmpty.textContent = '未录入';
      select.appendChild(optEmpty);
      field.options.forEach(function (option) {
        var node = document.createElement('option');
        node.value = String(option.value);
        node.textContent = option.label;
        select.appendChild(node);
      });
      select.value = value === undefined ? '' : String(value);
      select.addEventListener('change', function () {
        setValue(field, select.value === '' ? null : Number(select.value));
      });
      box.appendChild(select);
      box.appendChild(el('div', 'mfield-flag', value === undefined ? '未录入' : '已录入'));
      return box;
    }

    var slider = document.createElement('input');
    slider.type = 'range';
    slider.min = String(field.plausible[0]);
    slider.max = String(field.plausible[1]);
    slider.step = String(field.step || 0.1);
    slider.value = String(value === undefined ? (field.default !== null && field.default !== undefined
      ? field.default : (Number(field.plausible[0]) + Number(field.plausible[1])) / 2) : value);
    slider.style.background = trackGradient(field);
    box.appendChild(slider);

    var ticks = el('div', 'mfield-ticks');
    ticks.appendChild(el('span', null, fmt(field.plausible[0], 1)));
    if (field.normal && field.normal[0] !== null) {
      ticks.appendChild(el('span', null, '绿 ' + fmt(field.normal[0], 1) + '–' + fmt(field.normal[1], 1)));
      ticks.appendChild(el('span', null, '黄 ' + fmt(field.caution[0], 1) + '–' + fmt(field.caution[1], 1)));
    }
    ticks.appendChild(el('span', null, fmt(field.plausible[1], 1)));
    box.appendChild(ticks);

    var foot = el('div', 'mfield-foot');
    var number = document.createElement('input');
    number.type = 'number';
    number.min = String(field.plausible[0]);
    number.max = String(field.plausible[1]);
    number.step = String(field.step || 0.1);
    number.value = value === undefined ? '' : String(value);
    number.placeholder = '未录入';
    foot.appendChild(number);
    var clearLink = el('span', 'mfield-clear', '清除');
    foot.appendChild(clearLink);
    box.appendChild(foot);

    var flag = el('div', 'mfield-flag', value === undefined ? '未录入' : '已录入');
    box.appendChild(flag);

    slider.addEventListener('input', function () {
      setValue(field, Number(slider.value));
    });
    number.addEventListener('input', function () {
      if (number.value === '') { setValue(field, null); return; }
      var v = Number(number.value);
      if (!isFinite(v)) return;
      // 第二道防线：即使有人绕过滑条直接输入，也夹在生理可能范围内
      if (v < Number(field.plausible[0])) { v = Number(field.plausible[0]); number.value = String(v); }
      if (v > Number(field.plausible[1])) { v = Number(field.plausible[1]); number.value = String(v); }
      setValue(field, v);
    });
    clearLink.addEventListener('click', function () { setValue(field, null); });

    return box;
  }

  function decimalsFor(field) {
    var step = Number(field.step || 0.1);
    if (step >= 1) return 0;
    if (step >= 0.1) return 1;
    return 2;
  }

  function setValue(field, value) {
    if (value === null || value === undefined) {
      delete State.values[field.name];
    } else {
      State.values[field.name] = value;
    }
    // 局部更新，避免整块重绘导致滑条失焦
    var box = document.querySelector('.mfield[data-var="' + field.name + '"]');
    if (box) {
      var status = statusOf(field, value);
      box.classList.remove('is-empty', 'is-set', 'is-alert', 'is-caution');
      box.classList.add(status === 'empty' ? 'is-empty' : 'is-set');
      if (status === 'alert') box.classList.add('is-alert');
      if (status === 'caution') box.classList.add('is-caution');

      var valueSpan = box.querySelector('.mfield-value');
      if (valueSpan) {
        valueSpan.className = 'mfield-value is-' + (
          value === null || value === undefined ? 'empty' :
          status === 'normal' ? 'normal' : status === 'caution' ? 'caution' : 'abnormal');
        valueSpan.textContent = (value === null || value === undefined)
          ? '未录入' : fmt(value, decimalsFor(field));
      }
      var flag = box.querySelector('.mfield-flag');
      if (flag) flag.textContent = (value === null || value === undefined) ? '未录入' : '已录入';
      var number = box.querySelector('.mfield-foot input');
      if (number && number.value !== '' &&
          Number(number.value) !== Number(value)) {
        number.value = (value === null || value === undefined) ? '' : String(value);
      }
      var slider = box.querySelector('input[type="range"]');
      if (slider && value !== null && value !== undefined &&
          Number(slider.value) !== Number(value)) {
        slider.value = String(value);
      }
    }
    updateCounters();
    scheduleTrial();
  }

  function updateCounters() {
    var names = Object.keys(State.values);
    $('tkFilled').textContent = names.length;
    var abnormal = 0;
    State.fields.forEach(function (field) {
      if (State.values[field.name] === undefined) return;
      var status = statusOf(field, State.values[field.name]);
      if (status === 'alert' || status === 'caution') abnormal++;
    });
    $('tkAbnormal').textContent = abnormal;
    $('footHint').textContent = '已录入 ' + names.length + ' / ' + State.fields.length +
      ' 项；未录入的指标会计入信息缺口提示，不会被当作正常值。';
    $('clearPatientBtn').disabled = !($('patientId').value || '').trim();
  }

  /* ------------------------------------------------------------------ *
   * 试算
   * ------------------------------------------------------------------ */
  function scheduleTrial() {
    if (State.trialTimer) global.clearTimeout(State.trialTimer);
    State.trialTimer = global.setTimeout(runTrial, 420);
  }

  function payload() {
    var values = {};
    Object.keys(State.values).forEach(function (key) { values[key] = State.values[key]; });
    var ageRaw = ($('ageInput').value || '').trim();
    var genderRaw = $('genderInput').value;
    var hour = parseInt($('hourInput').value, 10);
    if (!isFinite(hour) || hour < 1) hour = 1;
    return {
      patient_id: ($('patientId').value || '').trim() || 'PREVIEW',
      hour: hour,
      values: values,
      age: ageRaw === '' ? null : Number(ageRaw),
      gender: genderRaw === '' ? null : Number(genderRaw)
    };
  }

  function runTrial() {
    var body = payload();
    if (!Object.keys(body.values).length && body.age === null && body.gender === null) {
      State.trial = null;
      $('tkTrial').textContent = '—';
      clear($('trialBody')).appendChild(el('p', 'dim',
        '尚未录入任何指标。拖动左侧滑条后，这里会立即给出风险分级、告警依据与处置建议。'));
      return;
    }
    $('tkTrial').textContent = '计算中…';
    request('/api/report/assess', { method: 'POST', body: body })
      .then(function (report) {
        State.trial = report;
        $('tkTrial').textContent = report.risk.level_zh;
        renderTrial(report);
        setConn('online', '后端在线');
      })
      .catch(function (err) {
        $('tkTrial').textContent = '失败';
        var box = clear($('trialBody'));
        box.appendChild(el('div', 'result-box is-fail', '试算失败：' + err.message));
      });
  }

  function renderTrial(report) {
    var host = clear($('trialBody'));
    var risk = report.risk;
    var level = risk.level || 'normal';

    var verdict = el('div', 'verdict');
    var head = el('div', 'verdict-head');
    var scoreSpan = el('span', 'verdict-score',
      risk.current === null ? '—' : fmt(risk.current, 4));
    scoreSpan.style.color = LEVEL_COLOR[level] || '#38bdf8';
    head.appendChild(scoreSpan);
    head.appendChild(el('span', 'verdict-level is-' + level, risk.level_zh));
    verdict.appendChild(head);

    var sub = el('div', 'verdict-sub');
    if (risk.current === null) {
      sub.textContent = '模型产物不可用，以下以临床规则与指标偏离为依据。';
    } else {
      sub.textContent = '观察时点 ' + report.header.observed_hours + ' 个；' +
        '分级阈值 低 ' + risk.thresholds.low + ' / 中 ' + risk.thresholds.medium +
        ' / 高 ' + risk.thresholds.high +
        (risk.thresholds.calibrated ? '（已按队列分布标定）' : '（未标定，使用回退阈值）');
    }
    verdict.appendChild(sub);
    host.appendChild(verdict);

    if (report.header.observed_hours < 6) {
      var warn = el('div', 'result-box is-info');
      warn.style.marginTop = '0';
      warn.appendChild(el('div', 'rb-title', '数据量提示'));
      warn.appendChild(el('div', null,
        '当前只有 ' + report.header.observed_hours + ' 个记录时点。窗口统计与趋势类特征基本不可用，' +
        '此时风险分数主要反映瞬时状态。若要让趋势判断生效，请按小时递增录入多次。'));
      host.appendChild(warn);
    }

    // ---- 告警 ----
    var alerts = report.alerts;
    var alertBox = el('div');
    alertBox.appendChild(el('div', 'dsec-title',
      '详细告警（' + alerts.alerts.length + ' 条 / 触发候选 ' +
      alerts.candidates_before_suppression + ' 条，抑制 ' + alerts.suppressed + ' 条）'));
    if (alerts.alerts.length) {
      var table = el('table', 'report-table');
      var thead = document.createElement('thead');
      var hr = document.createElement('tr');
      ['触发时点', '风险', '分级', '依据', '建议'].forEach(function (text) {
        hr.appendChild(el('th', null, text));
      });
      thead.appendChild(hr);
      table.appendChild(thead);
      var tbody = document.createElement('tbody');
      alerts.alerts.forEach(function (alert) {
        var tr = document.createElement('tr');
        tr.appendChild(el('td', 'num', '第 ' + alert.hour + ' 小时'));
        tr.appendChild(el('td', 'num', fmt(alert.risk_score, 4)));
        tr.appendChild(el('td', null, alert.level_zh));
        tr.appendChild(el('td', null, alert.reason_zh));
        tr.appendChild(el('td', null, alert.action_zh));
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      alertBox.appendChild(table);
    } else {
      alertBox.appendChild(el('div', 'dim', '当前录入的数值未触发告警。'));
    }
    host.appendChild(alertBox);

    // ---- 临床规则 ----
    var ruleBox = el('div');
    ruleBox.appendChild(el('div', 'dsec-title', '临床规则交叉核对'));
    var ruleTable = el('table', 'report-table');
    var rthead = document.createElement('thead');
    var rhr = document.createElement('tr');
    ['规则', '评分', '阈值', '是否触发', '说明'].forEach(function (t) {
      rhr.appendChild(el('th', null, t));
    });
    rthead.appendChild(rhr);
    ruleTable.appendChild(rthead);
    var rtbody = document.createElement('tbody');
    Object.keys(report.rules).forEach(function (name) {
      var payloadRule = report.rules[name];
      if (payloadRule.current === undefined) return;
      var tr = document.createElement('tr');
      if (payloadRule.triggered) tr.className = 'is-caution';
      tr.appendChild(el('td', null, name));
      tr.appendChild(el('td', 'num', payloadRule.current + ' / ' + payloadRule.max_score));
      tr.appendChild(el('td', 'num', payloadRule.trigger_threshold));
      tr.appendChild(el('td', null, payloadRule.triggered ? '已触发' : '未触发'));
      tr.appendChild(el('td', null, payloadRule.meaning_zh));
      rtbody.appendChild(tr);
    });
    ruleTable.appendChild(rtbody);
    ruleBox.appendChild(ruleTable);
    host.appendChild(ruleBox);

    // ---- 指标偏离 ----
    var deviated = report.vitals.filter(function (v) {
      return v.status === 'caution' || v.status === 'abnormal';
    });
    var devBox = el('div');
    devBox.appendChild(el('div', 'dsec-title', '指标偏离（' + deviated.length + ' 项）'));
    if (deviated.length) {
      var devTable = el('table', 'report-table');
      var dthead = document.createElement('thead');
      var dhr = document.createElement('tr');
      ['指标', '数值', '参考范围', '状态'].forEach(function (t) {
        dhr.appendChild(el('th', null, t));
      });
      dthead.appendChild(dhr);
      devTable.appendChild(dthead);
      var dtbody = document.createElement('tbody');
      deviated.forEach(function (item) {
        var tr = document.createElement('tr');
        tr.className = item.status === 'abnormal' ? 'is-abnormal' : 'is-caution';
        tr.appendChild(el('td', null, item.name_zh));
        tr.appendChild(el('td', 'num', item.last + item.unit));
        tr.appendChild(el('td', 'num',
          item.normal[0] === null ? '—' : item.normal[0] + '–' + item.normal[1]));
        tr.appendChild(el('td', null, item.status_zh));
        dtbody.appendChild(tr);
      });
      devTable.appendChild(dtbody);
      devBox.appendChild(devTable);
    } else {
      devBox.appendChild(el('div', 'dim', '已录入的指标均在临床常见范围内。'));
    }
    host.appendChild(devBox);

    // ---- 文字结论 ----
    var narrativeBox = el('div');
    report.narrative.forEach(function (section) {
      narrativeBox.appendChild(el('div', 'dsec-title', section.title));
      narrativeBox.appendChild(el('div', 'report-text', section.text));
    });
    host.appendChild(narrativeBox);

    var actions = el('div', 'config-actions');
    var btn = el('button', 'btn is-ghost', '查看完整报告');
    btn.addEventListener('click', function () {
      var pid = ($('patientId').value || '').trim();
      if (!pid) {
        $('heroNote').textContent = '请先填写患者编号，再打开完整报告。';
        return;
      }
      location.href = 'report.html?patient=' + encodeURIComponent(pid) + '&origin=manual';
    });
    actions.appendChild(btn);
    host.appendChild(actions);
  }

  /* ------------------------------------------------------------------ *
   * 提交保存
   * ------------------------------------------------------------------ */
  function submit() {
    var pid = ($('patientId').value || '').trim();
    if (!pid) {
      showSubmit('fail', '请先填写患者编号', ['患者编号用于把多次录入拼成同一条观察序列。']);
      $('patientId').focus();
      return;
    }
    var body = payload();
    if (!Object.keys(body.values).length && body.age === null && body.gender === null) {
      showSubmit('fail', '没有任何可提交的数值', ['请至少拖动一项滑条，或填写年龄/性别。']);
      return;
    }
    var note = ($('noteInput').value || '').trim();
    $('submitBtn').disabled = true;
    request('/api/manual/entry', {
      method: 'POST',
      body: {
        patient_id: pid, hour: body.hour, values: body.values,
        age: body.age, gender: body.gender, note: note
      }
    }).then(function (data) {
      $('submitBtn').disabled = false;
      var lines = [
        '患者 ' + data.patient_id + ' 第 ' + data.hour + ' 小时记录已保存，' +
        '该患者目前共 ' + data.patient_hours + ' 个时点，全系统共 ' + data.total_patients + ' 位患者。',
        '接受的指标（' + Object.keys(data.accepted).length + ' 项）：' +
        Object.keys(data.accepted).join('、')
      ];
      if (data.notes && data.notes.length) {
        State.rejected += data.notes.length;
        $('heroFactRejected').textContent = State.rejected;
        lines.push('校验提示：');
        data.notes.forEach(function (t) { lines.push('　· ' + t); });
      }
      showSubmit('ok', '保存成功', lines);
      $('noteInput').value = '';
      // 刷新本页的三处相关视图：患者清单、该患者的已录入序列、可报告对象。
      // 注意：早期这里调用了一个并不存在的 `loadSubjects()`，于是**每次提交
      // 成功之后都会走进 catch，界面显示"保存失败"**——数据其实已经保存了。
      // 这类"成功后报失败"的错误最误导人，是页面级自检抓出来的。
      loadPatients();
      loadHistory(pid);
    }).catch(function (err) {
      $('submitBtn').disabled = false;
      showSubmit('fail', '保存失败', ['错误：' + err.message]);
    });
  }

  function showSubmit(kind, title, lines) {
    var box = $('submitResult');
    box.style.display = '';
    box.className = 'result-box is-' + kind;
    clear(box);
    box.appendChild(el('div', 'rb-title', title));
    lines.forEach(function (line) { box.appendChild(el('div', null, line)); });
  }

  /* ------------------------------------------------------------------ *
   * 患者列表与历史
   * ------------------------------------------------------------------ */
  function loadPatients() {
    return request('/api/manual/patients').then(function (data) {
      State.patients = data.patients || [];
      $('navCount').textContent = '已录入 ' + data.count + ' 位患者';

      var nav = clear($('navPatients'));
      if (!State.patients.length) {
        nav.appendChild(el('div', 'dim', '尚无记录'));
        nav.firstChild.style.padding = '6px var(--sp-3)';
        nav.firstChild.style.fontSize = '11px';
        return;
      }
      State.patients.forEach(function (row) {
        var item = el('div', 'nav-item');
        item.appendChild(el('span', 'nav-icon', '·'));
        item.appendChild(el('span', null, row.patient_id));
        item.appendChild(el('span', 'nav-count', row.n_hours + 'h'));
        item.addEventListener('click', function () {
          $('patientId').value = row.patient_id;
          $('hourInput').value = String(row.hour_range[1] + 1);
          loadHistory(row.patient_id);
          updateCounters();
        });
        nav.appendChild(item);
      });
    }).catch(function () { /* 列表失败不阻塞录入 */ });
  }

  function loadHistory(patientId) {
    var host = clear($('historyBody'));
    if (!patientId) {
      host.appendChild(el('p', 'dim', '填写患者编号后，这里会显示该患者已录入的各时点记录。'));
      return;
    }
    request('/api/report/patient/' + encodeURIComponent(patientId) + '?origin=manual')
      .then(function (report) {
        var title = el('div', 'dsec-title',
          report.patient_id + ' · 共 ' + report.header.observed_hours + ' 个记录时点');
        host.appendChild(title);

        var table = el('table', 'report-table');
        var thead = document.createElement('thead');
        var hr = document.createElement('tr');
        ['时点', '当前风险', '分级', '已录入指标'].forEach(function (t) {
          hr.appendChild(el('th', null, t));
        });
        thead.appendChild(hr);
        table.appendChild(thead);
        var tbody = document.createElement('tbody');
        var risks = report.risk.series || [];
        // 该患者各小时已录入的指标名从时间线之外无法直接得到，这里以报告主体为准
        var measured = report.vitals.filter(function (v) { return v.n_measured > 0; })
          .map(function (v) { return v.name_zh; });
        risks.forEach(function (point) {
          var tr = document.createElement('tr');
          tr.appendChild(el('td', 'num', '第 ' + point.hour + ' 小时'));
          tr.appendChild(el('td', 'num', fmt(point.risk, 4)));
          tr.appendChild(el('td', null, levelZh(point.risk)));
          tr.appendChild(el('td', 'faint', point.hour === report.header.last_hour
            ? measured.join('、') : '（见完整报告）'));
          tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        host.appendChild(table);

        var actions = el('div', 'config-actions');
        var btn = el('button', 'btn is-primary', '生成该患者的完整报告');
        btn.addEventListener('click', function () {
          location.href = 'report.html?patient=' + encodeURIComponent(report.patient_id) +
            '&origin=manual';
        });
        actions.appendChild(btn);
        host.appendChild(actions);
      })
      .catch(function (err) {
        host.appendChild(el('p', 'dim', '尚未保存该患者的记录（' + err.message + '）。'));
      });
  }

  function levelZh(score) {
    var s = Number(score) || 0;
    var t = (State.trial && State.trial.risk && State.trial.risk.thresholds) || null;
    if (!t) return s >= 0.1 ? '高风险' : s >= 0.05 ? '中风险' : '低风险';
    if (s >= t.high) return '高风险';
    if (s >= t.medium) return '中风险';
    if (s >= t.low) return '低风险';
    return '正常';
  }

  /* ------------------------------------------------------------------ *
   * 快捷填充
   * ------------------------------------------------------------------ */
  var PRESETS = {
    normal: {
      HR: 78, O2Sat: 98, Resp: 16, Temp: 36.8, SBP: 124, DBP: 76, MAP: 92,
      Lactate: 1.1, Creatinine: 0.9, WBC: 8.2, Platelets: 240, BUN: 14,
      pH: 7.40, HCO3: 24, FiO2: 0.21
    },
    infection: {
      HR: 104, O2Sat: 95, Resp: 21, Temp: 38.6, SBP: 112, DBP: 68, MAP: 82,
      Lactate: 2.1, Creatinine: 1.3, WBC: 15.8, Platelets: 168, BUN: 22,
      pH: 7.38, HCO3: 22, FiO2: 0.28
    },
    shock: {
      HR: 126, O2Sat: 90, Resp: 28, Temp: 38.9, SBP: 84, DBP: 52, MAP: 62,
      Lactate: 4.2, Creatinine: 2.4, WBC: 19.5, Platelets: 88, BUN: 38,
      pH: 7.28, HCO3: 17, FiO2: 0.45
    },
    elderly: {
      HR: 88, O2Sat: 94, Resp: 19, Temp: 37.2, SBP: 136, DBP: 72, MAP: 93,
      Lactate: 1.6, Creatinine: 1.35, WBC: 9.4, Platelets: 196, BUN: 26,
      pH: 7.37, HCO3: 23, FiO2: 0.21,
      Age: 82, Gender: 1
    }
  };

  function applyPreset(name) {
    if (name === 'clear') {
      State.values = {};
      $('ageInput').value = '';
      $('genderInput').value = '';
      renderFields();
      scheduleTrial();
      return;
    }
    var preset = PRESETS[name];
    if (!preset) return;
    State.values = {};
    Object.keys(preset).forEach(function (key) {
      if (key === 'Age') { $('ageInput').value = String(preset[key]); return; }
      if (key === 'Gender') { $('genderInput').value = String(preset[key]); return; }
      State.values[key] = preset[key];
    });
    renderFields();
    scheduleTrial();
  }

  /* ------------------------------------------------------------------ *
   * 启动
   * ------------------------------------------------------------------ */
  function boot() {
    $('submitBtn').addEventListener('click', submit);
    $('assessBtn').addEventListener('click', runTrial);
    $('assessBtn2').addEventListener('click', runTrial);
    $('toReportBtn').addEventListener('click', function () {
      var pid = ($('patientId').value || '').trim();
      location.href = 'report.html' + (pid ? '?patient=' + encodeURIComponent(pid) +
        '&origin=manual' : '');
    });
    $('reloadSchema').addEventListener('click', loadSchema);

    $('patientId').addEventListener('input', function () {
      updateCounters();
      loadHistory(($('patientId').value || '').trim());
    });
    $('hourInput').addEventListener('input', scheduleTrial);
    $('ageInput').addEventListener('input', scheduleTrial);
    $('genderInput').addEventListener('change', scheduleTrial);

    $('onlySet').addEventListener('change', function (ev) {
      State.onlySet = ev.target.checked;
      renderFields();
    });

    Array.prototype.forEach.call(document.querySelectorAll('.chip[data-preset]'), function (chip) {
      chip.addEventListener('click', function () {
        Array.prototype.forEach.call(document.querySelectorAll('.chip[data-preset]'), function (c) {
          c.classList.remove('is-on');
        });
        chip.classList.add('is-on');
        applyPreset(chip.dataset.preset);
      });
    });

    $('clearPatientBtn').addEventListener('click', function () {
      var pid = ($('patientId').value || '').trim();
      if (!pid) return;
      if (!global.confirm('确定要删除患者 ' + pid + ' 的全部手动录入数据吗？此操作不可撤销。')) return;
      request('/api/manual/' + encodeURIComponent(pid), { method: 'DELETE' })
        .then(function () {
          showSubmit('ok', '已删除', ['患者 ' + pid + ' 的手动录入数据已清除。']);
          loadPatients();
          loadHistory('');
        })
        .catch(function (err) {
          showSubmit('fail', '删除失败', ['错误：' + err.message]);
        });
    });

    setConn('offline', '检测数据来源…');
    loadSchema();
    loadPatients();
    loadHistory('');
    request('/api/health')
      .then(function (data) {
        var builtin = global.SGBridge && global.SGBridge.isBuiltin();
        setConn('online', builtin ? '内置仿真模式' : '后端在线');
        renderSourceBadge(data);
      })
      .catch(function () { setConn('error', '异常'); });
  }

  /** 顶部「数据来源」徽标：本页不依赖后端，务必让使用者看清用的是哪条来源。 */
  function renderSourceBadge(payload) {
    var flag = $('flagSource');
    if (!flag) return;
    var builtin = global.SGBridge && global.SGBridge.isBuiltin();
    if (builtin) {
      flag.textContent = '数据来源：浏览器内置';
      flag.style.color = '#fde047';
      flag.style.borderColor = 'rgba(234, 179, 8, 0.5)';
      flag.title = '40 项指标定义内置在 js/varspec.js，录入数据保存在本浏览器的 ' +
        'localStorage 中，不需要任何外部服务';
    } else {
      flag.textContent = '数据来源：后端服务';
      flag.style.color = '';
      flag.style.borderColor = '';
      flag.title = '已连接后端服务，录入数据写入服务进程';
    }
    if (payload && payload.model_name) {
      // manual.html 里并没有 navModel 这个元素。内置模式下 /api/health 会返回
      // 带 model_name 的对象，直接写必然抛 TypeError，被 init 里的 .catch 吞掉
      // 后状态灯就停在「异常」。先判断元素存在；元素存在时行为与原来完全一致。
      var navModel = $('navModel');
      if (navModel) navModel.textContent = '评分：' + payload.model_name;
    }
  }

  function loadSchema() {
    var host = clear($('entryGroups'));
    host.appendChild(el('p', 'dim', '正在读取指标定义…'));
    request('/api/manual/schema').then(function (data) {
      State.fields = data.fields || [];
      State.groups = data.groups || [];
      State.schema = data;
      $('entrySub').textContent = data.note || '';
      var builtin = global.SGBridge && global.SGBridge.isBuiltin();
      setConn('online', builtin ? '内置仿真模式' : '后端在线');
      renderSourceBadge(data);

      // 覆盖性由数据源自报。若定义里漏了变量，这里会直接暴露出来，
      // 而不是让使用者以为"能填的就是全部"。
      var covered = data.covered_variables;
      var expected = data.expected_variables;
      if (covered !== undefined && expected !== undefined) {
        if (covered === expected) {
          $('heroSentence').innerHTML =
            '共 <span class="hl-accent">' + expected + '</span> 项医疗指标全部可录入：' +
            '生命体征 8 项、实验室检验 26 项、基本信息 4 项、监护信息 2 项。' +
            '拖动滑条即可，滑条底色已画出临床常见区（绿）、需注意区（黄）与明显异常区（红）。';
        } else {
          $('heroSentence').innerHTML =
            '<span class="hl-critical">指标覆盖不完整</span>：' +
            '已覆盖 ' + covered + ' / ' + expected + ' 项，未覆盖 ' +
            escapeHtml((data.uncovered_variables || []).join('、'));
        }
      }
      var dup = data.duplicated_variables || [];
      $('heroNote').textContent = dup.length
        ? '注意：指标定义中存在重复项 ' + dup.join('、')
        : (data.source === 'builtin'
          ? '指标定义内置于本页面（js/varspec.js），录入数据保存在本浏览器的本地存储中——' +
            '刷新后仍在，不需要启动任何服务。'
          : '指标定义来自后端服务，录入数据写入服务进程内存。');

      renderFields();
      updateCounters();
    }).catch(function (err) {
      clear(host).appendChild(el('p', 'fail',
        '读取指标定义失败：' + err.message +
        '。40 项指标定义内置在 js/varspec.js，请确认整个 web/ 目录被完整拷贝。'));
      setConn('error', '脚本加载异常');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window);
