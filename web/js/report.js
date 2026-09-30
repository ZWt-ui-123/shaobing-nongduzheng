/* ============================================================================
 * 哨兵 SepsisGuard —— 报告中心脚本（report.js）
 * ----------------------------------------------------------------------------
 * 本页把后端生成的**结构化报告**渲染成一份可直接阅读、打印、导出的文书。
 *
 * 报告不是"把分数放大显示"，而是把一次评估的全部中间结论摊开：
 *   * 风险结论与逐小时轨迹（含分级阈值）
 *   * 告警明细（触发时点、当时的实测依据、抑制前后对比）
 *   * 临床规则交叉核对（qSOFA / SIRS / NEWS2）
 *   * 指标逐项评估（最近值 vs 参考范围）
 *   * 信息缺口（未测量 / 久未复测）
 *   * 模型归因与病程观察日志
 *   * 五段式文字结论：结论 / 依据 / 数据充分性 / 建议 / 局限
 *
 * 数据来源支持三条通路：手动录入、动态监护后端、静态队列，全部由后端
 * `/api/report/patient/{id}` 统一装配。
 * ========================================================================== */
(function (global) {
  'use strict';

  var API_BASE = String(global.SEPSISGUARD_API || '').replace(/\/+$/, '');
  var Charts = global.SGCharts;

  var LEVEL_COLOR = {
    normal: '#22c55e', low: '#38bdf8', medium: '#eab308', high: '#f97316', critical: '#ef4444'
  };

  var State = {
    subjects: [],
    report: null,
    filter: '',
    origin: 'auto',
    patientId: ''
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

  /**
   * 在浏览器里直接触发文件下载。
   *
   * 内置仿真模式下没有后端可以服务 `/api/report/...md`，因此导出必须由前端
   * 自己把文本变成下载，而不是把 location 指过去。所有导出按钮都走这里。
   */
  function downloadText(filename, text) {
    try {
      var blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      global.setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
      return true;
    } catch (e) {
      // 某些环境（如被限制的 WebView）不支持 Blob 下载：退化为新窗口展示
      var win = global.open('', '_blank');
      if (win) { win.document.write('<pre>' + escapeHtml(text) + '</pre>'); return true; }
      return false;
    }
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

  /** 顶部「数据来源」徽标。报告会明确区分"内置规则评分"与"后端模型输出"。 */
  function renderSourceBadge() {
    var flag = $('flagSource');
    if (!flag) return;
    var builtin = global.SGBridge && global.SGBridge.isBuiltin();
    if (builtin) {
      flag.textContent = '评分来源：浏览器内置临床规则';
      flag.style.color = '#fde047';
      flag.style.borderColor = 'rgba(234, 179, 8, 0.5)';
      flag.title = '未连接后端服务：风险分数来自公开可核对的临床偏离度规则评分，' +
        '不是训练模型的输出；报告正文也会注明这一点';
    } else {
      flag.textContent = '评分来源：后端服务';
      flag.style.color = '';
      flag.style.borderColor = '';
      flag.title = '已连接后端推理服务，使用训练好的模型产物';
    }
  }

  /* ------------------------------------------------------------------ *
   * 可报告对象
   * ------------------------------------------------------------------ */
  function loadSubjects() {
    return request('/api/report/subjects').then(function (data) {
      State.subjects = data.groups || [];
      var total = data.total || 0;
      $('navTotal').textContent = '可报告对象：' + total;
      $('subjectSub').textContent = '按数据来源分组 · 共 ' + total + ' 个对象';

      var nav = clear($('navOrigins'));
      State.subjects.forEach(function (group) {
        var item = el('div', 'nav-item');
        item.appendChild(el('span', 'nav-icon', '·'));
        item.appendChild(el('span', null, group.origin_zh));
        item.appendChild(el('span', 'nav-count', group.count));
        item.addEventListener('click', function () {
          $('originSelect').value = group.origin;
          State.origin = group.origin;
          renderSubjects();
        });
        nav.appendChild(item);
      });

      renderSubjects();
      renderSourceBadge();
      setConn('online', global.SGBridge && global.SGBridge.isBuiltin()
        ? '内置仿真模式' : '后端在线');
      return data;
    }).catch(function (err) {
      $('subjectList').innerHTML =
        '<div class="dim" style="padding:10px;font-size:12px;">读取可报告对象失败：' +
        escapeHtml(err.message) + '</div>';
      setConn('error', '异常');
      throw err;
    });
  }

  function visibleSubjects() {
    var groups = State.subjects;
    if (State.origin !== 'auto') {
      groups = groups.filter(function (g) { return g.origin === State.origin; });
    }
    var q = State.filter.trim().toLowerCase();
    var out = [];
    groups.forEach(function (group) {
      var items = group.items || [];
      if (q) {
        items = items.filter(function (item) {
          return String(item.patient_id).toLowerCase().indexOf(q) >= 0 ||
                 String(item.scenario_zh || '').toLowerCase().indexOf(q) >= 0 ||
                 String(item.bed || '').toLowerCase().indexOf(q) >= 0;
        });
      }
      if (items.length) out.push({ group: group, items: items });
    });
    return out;
  }

  function renderSubjects() {
    var host = clear($('subjectList'));
    var groups = visibleSubjects();
    if (!groups.length) {
      host.appendChild(el('div', 'dim', '没有符合条件的对象。'));
      host.firstChild.style.padding = '10px';
      host.firstChild.style.fontSize = '12px';
      return;
    }
    var shown = 0;
    groups.forEach(function (entry) {
      // 分组标题行不是可点击对象，因此显式标注 `is-group`：
      // 样式上不显示 hover/手型，结构上也能与真正的患者行区分开
      //（早先两者共用 `.subject-row`，代码里只能靠"有没有挂监听"来区分）。
      var header = el('div', 'subject-row is-group');
      header.appendChild(el('span', 'sr-id', entry.group.origin_zh));
      header.appendChild(el('span', 'sr-meta', entry.items.length + ' / ' + entry.group.count));
      host.appendChild(header);

      entry.items.slice(0, 200).forEach(function (item) {
        shown++;
        var row = el('div', 'subject-row');
        if (State.patientId === item.patient_id) row.classList.add('is-selected');
        row.appendChild(el('span', 'sr-id', item.patient_id));

        var bits = [];
        if (item.scenario_zh) bits.push(item.scenario_zh);
        if (item.bed) bits.push(item.bed);
        if (item.risk_level_zh) bits.push(item.risk_level_zh);
        if (item.current_hour !== undefined) bits.push('第 ' + item.current_hour + ' 小时');
        if (item.icu_los_hours !== undefined) bits.push(item.icu_los_hours + ' h');
        if (item.has_sepsis_label) bits.push('已发作');
        row.appendChild(el('span', null, bits.join(' · ')));

        var score = (item.risk_score === undefined) ? null : item.risk_score;
        var scoreSpan = el('span', 'sr-meta', score === null ? '' : fmt(score, 4));
        row.appendChild(scoreSpan);

        row.addEventListener('click', function () {
          $('patientInput').value = item.patient_id;
          $('originSelect').value = entry.group.origin;
          State.origin = entry.group.origin;
          generate(item.patient_id, entry.group.origin);
        });
        host.appendChild(row);
      });
    });
    if (!shown) host.appendChild(el('div', 'dim', '没有符合条件的对象。'));
  }

  /* ------------------------------------------------------------------ *
   * 报告生成
   * ------------------------------------------------------------------ */
  function generate(patientId, origin) {
    var pid = (patientId || $('patientInput').value || '').trim();
    var org = origin || $('originSelect').value || 'auto';
    if (!pid) {
      $('reportSub').textContent = '请先输入或选择患者编号';
      return;
    }
    State.patientId = pid;
    State.origin = org;
    $('generateBtn').disabled = true;
    $('reportSub').textContent = '正在生成 ' + pid + ' 的评估报告…';
    var t0 = global.performance ? global.performance.now() : Date.now();

    request('/api/report/patient/' + encodeURIComponent(pid) + '?origin=' + encodeURIComponent(org))
      .then(function (report) {
        var elapsed = ((global.performance ? global.performance.now() : Date.now()) - t0) / 1000;
        $('generateBtn').disabled = false;
        State.report = report;
        $('tkElapsed').textContent = elapsed.toFixed(2) + ' s';
        renderReport(report);
        renderSubjects();
      })
      .catch(function (err) {
        $('generateBtn').disabled = false;
        $('tkElapsed').textContent = '—';
        var body = clear($('reportBody'));
        var box = el('div', 'result-box is-fail');
        box.appendChild(el('div', 'rb-title', '生成报告失败'));
        box.appendChild(el('div', null, '错误：' + err.message));
        box.appendChild(el('div', 'rb-hint',
          '若该患者不在当前数据来源中，请在右侧选择正确的「数据来源」，' +
          '或先到「数据接入 / 动态监护 / 手动录入」页把数据准备好。'));
        body.appendChild(box);
        $('reportSub').textContent = '生成失败';
      });
  }

  function sectionTitle(number, text) {
    var node = el('div', 'report-section-title');
    node.appendChild(el('span', 'num-badge', String(number)));
    node.appendChild(el('span', null, text));
    return node;
  }

  function renderReport(report) {
    var host = clear($('reportBody'));
    var h = report.header;
    var risk = report.risk;

    $('reportTitle').textContent = '评估报告 · ' + report.patient_id;
    $('reportSub').textContent = h.origin_zh + ' · 生成于 ' + report.generated_at;
    $('tkPatient').textContent = report.patient_id;
    $('tkLevel').textContent = risk.level_zh;
    $('tkAlerts').textContent = risk.alert_count;

    /* ---------- 页头 ---------- */
    var head = el('div', 'report-head');
    head.appendChild(el('div', 'report-title', '脓毒症风险评估报告'));
    head.appendChild(el('div', 'report-sub', report.disclaimer));
    var meta = el('div', 'report-meta');
    [
      ['患者编号', h.patient_id],
      ['数据来源', h.origin_zh],
      ['性别', h.gender_zh],
      ['年龄', h.age === null || h.age === undefined ? '—' : Math.round(h.age) + ' 岁'],
      ['床号 / 单元', h.unit || '—'],
      ['监护场景', h.scenario_zh || '—'],
      ['观察窗口', '第 ' + h.first_hour + '–' + h.last_hour + ' 小时'],
      ['记录时点', h.observed_hours + ' 个'],
      ['关键指标覆盖度', h.measured_ratio === null || h.measured_ratio === undefined
        ? '—' : pct(h.measured_ratio)],
      ['评估模型', h.model_name + '（' + h.model_version + '）']
    ].forEach(function (pair) {
      var item = el('span');
      item.appendChild(el('span', null, pair[0] + '：'));
      item.appendChild(el('b', null, String(pair[1])));
      meta.appendChild(item);
    });
    head.appendChild(meta);
    host.appendChild(head);

    /* ---------- 一、风险结论 ---------- */
    var s1 = el('div', 'report-section');
    s1.appendChild(sectionTitle(1, '风险结论'));
    if (risk.current === null) {
      var warn = el('div', 'result-box is-info');
      warn.appendChild(el('div', null,
        '模型风险分数不可用（模型产物缺失）。以下结论以临床规则评分与指标偏离为依据。'));
      s1.appendChild(warn);
    } else {
      var verdict = el('div', 'verdict');
      var vhead = el('div', 'verdict-head');
      var score = el('span', 'verdict-score', fmt(risk.current, 4));
      score.style.color = LEVEL_COLOR[risk.level] || '#38bdf8';
      vhead.appendChild(score);
      vhead.appendChild(el('span', 'verdict-level is-' + risk.level, risk.level_zh));
      verdict.appendChild(vhead);
      var vsub = el('div', 'verdict-sub');
      vsub.textContent =
        '观察窗口峰值 ' + fmt(risk.peak, 4) + '（第 ' + risk.peak_hour + ' 小时）；' +
        '近 6 小时变化 ' + (risk.trend_6h === null ? '—' : (risk.trend_6h >= 0 ? '+' : '') +
          fmt(risk.trend_6h, 4)) + '；经抑制后告警 ' + risk.alert_count + ' 条。';
      verdict.appendChild(vsub);
      var vsub2 = el('div', 'verdict-sub');
      vsub2.textContent = '分级阈值（按队列分布标定，跨机构不可直接比较）：低 ' +
        risk.thresholds.low + ' / 中 ' + risk.thresholds.medium + ' / 高 ' + risk.thresholds.high +
        (risk.thresholds.calibrated ? '（已标定）' : '（未标定，使用回退阈值）');
      verdict.appendChild(vsub2);
      s1.appendChild(verdict);

      var chartBox = el('div', 'chart-box');
      var canvas = document.createElement('canvas');
      canvas.width = 900; canvas.height = 240;
      chartBox.appendChild(canvas);
      var legend = el('div', 'chart-legend');
      legend.innerHTML =
        '<span class="legend-chip"><i style="background:' +
        (LEVEL_COLOR[risk.level] || '#38bdf8') + '"></i>逐小时风险分数</span>' +
        '<span class="legend-chip"><i style="background:#ef4444"></i>告警触发点</span>' +
        (h.onset_hour !== null && h.onset_hour !== undefined
          ? '<span class="legend-chip"><i style="background:rgba(239,68,68,.45)"></i>发作判定时点（第 ' +
            h.onset_hour + ' 小时）</span>' : '');
      chartBox.appendChild(legend);
      s1.appendChild(chartBox);

      var series = risk.series || [];
      if (Charts && series.length) {
        global.setTimeout(function () {
          var markers = (report.alerts.alerts || []).map(function (a) {
            return { hour: a.hour, label: '告警 ' + a.level_zh,
                     color: LEVEL_COLOR[a.level] || '#ef4444' };
          });
          var bands = [];
          if (h.onset_hour !== null && h.onset_hour !== undefined) {
            bands.push({ from: h.onset_hour, to: h.last_hour,
                         color: 'rgba(239,68,68,0.10)', label: '发作期' });
          }
          Charts.lineChart(canvas, {
            hours: series.map(function (p) { return p.hour; }),
            series: [{
              key: 'risk', name: '风险分数',
              values: series.map(function (p) { return p.risk; }),
              color: LEVEL_COLOR[risk.level] || '#38bdf8', unit: ''
            }],
            yMin: 0, yMax: 1, yLabel: '风险分数', xLabel: '监护小时',
            fill: true, markers: markers, bands: bands, xTickCount: 10
          });
        }, 40);
      }
    }
    host.appendChild(s1);

    /* ---------- 二、告警明细 ---------- */
    var s2 = el('div', 'report-section');
    s2.appendChild(sectionTitle(2, '告警明细'));
    var alerts = report.alerts;
    var summary = el('div', 'report-text');
    summary.textContent =
      '触发候选 ' + alerts.candidates_before_suppression + ' 条，抑制后保留 ' +
      alerts.alerts.length + ' 条，抑制 ' + alerts.suppressed + ' 条' +
      (alerts.suppression_ratio === null ? '' : '（抑制率 ' + pct(alerts.suppression_ratio) + '）') +
      '。抑制规则：同一患者 ' + (alerts.suppression_window_hours || 6) +
      ' 小时内只保留一条告警，风险等级上升可突破抑制。';
    s2.appendChild(summary);
    if (alerts.alerts.length) {
      s2.appendChild(tableOf(
        ['序号', '触发时点', '风险分数', '分级', '触发依据', '建议行动'],
        alerts.alerts.map(function (a, i) {
          return {
            cells: [String(i + 1), '第 ' + a.hour + ' 小时', fmt(a.risk_score, 4),
                    a.level_zh, a.reason_zh, a.action_zh],
            className: a.level === 'high' ? 'is-abnormal'
              : (a.level === 'medium' ? 'is-caution' : '')
          };
        })
      ));
    } else {
      s2.appendChild(el('div', 'dim', '观察窗口内未触发告警。'));
    }
    host.appendChild(s2);

    /* ---------- 三、临床规则交叉核对 ---------- */
    var s3 = el('div', 'report-section');
    s3.appendChild(sectionTitle(3, '临床规则交叉核对'));
    s3.appendChild(el('div', 'report-text',
      '本节列出临床已在使用的床旁评分。模型与规则不一致时如实并列，不做调和——' +
      '不一致本身往往提示模型捕捉到了长程趋势，或数据存在缺口。'));
    var ruleRows = [];
    Object.keys(report.rules).forEach(function (name) {
      var payload = report.rules[name];
      if (payload.current === undefined) return;
      ruleRows.push({
        cells: [name, payload.current + ' / ' + payload.max_score,
                String(payload.trigger_threshold),
                payload.triggered ? '已触发' : '未触发',
                payload.meaning_zh],
        className: payload.triggered ? 'is-caution' : ''
      });
    });
    s3.appendChild(tableOf(
      ['规则', '当前评分', '触发阈值', '是否触发', '说明'], ruleRows));
    var notes = [];
    Object.keys(report.rules).forEach(function (name) {
      var payload = report.rules[name];
      if (payload.notes) notes.push(name + '：' + payload.notes);
    });
    if (notes.length) {
      var ul = el('ul', 'evidence-list');
      notes.forEach(function (t) { ul.appendChild(el('li', null, t)); });
      s3.appendChild(ul);
    }
    host.appendChild(s3);

    /* ---------- 四、指标逐项评估 ---------- */
    var s4 = el('div', 'report-section');
    s4.appendChild(sectionTitle(4, '指标逐项评估'));
    var deviated = report.vitals.filter(function (v) {
      return v.status === 'caution' || v.status === 'abnormal';
    }).length;
    var missing = report.vitals.filter(function (v) {
      return v.status === 'not_measured';
    }).length;
    s4.appendChild(el('div', 'report-text',
      '共评估 ' + report.vitals.length + ' 项指标，其中 ' + deviated +
      ' 项偏离临床常见范围，' + missing + ' 项在观察窗口内未测量。'));
    s4.appendChild(tableOf(
      ['指标', '最近值', '参考范围', '状态', '说明', '测量次数', '距上次测量'],
      report.vitals.map(function (v) {
        return {
          cells: [
            v.name_zh,
            v.last === null ? '—' : v.last + v.unit,
            v.normal[0] === null ? '—' : v.normal[0] + '–' + v.normal[1],
            v.status_zh,
            v.detail_zh,
            String(v.n_measured),
            v.hours_since_measured === null ? '—' : v.hours_since_measured + ' 小时'
          ],
          className: v.status === 'abnormal' ? 'is-abnormal'
            : (v.status === 'caution' ? 'is-caution' : '')
        };
      })
    ));
    host.appendChild(s4);

    /* ---------- 五、指标趋势 ---------- */
    var s5 = el('div', 'report-section');
    s5.appendChild(sectionTitle(5, '指标趋势'));
    var trends = report.trends || {};
    var trendRows = trends.variables || [];
    if (trendRows.length) {
      var riskTrend = trends.risk || {};
      if (riskTrend.available) {
        s5.appendChild(el('div', 'report-text',
          '风险分数趋势：' + fmt(riskTrend.first, 4) + ' → ' + fmt(riskTrend.last, 4) +
          '（' + (riskTrend.delta >= 0 ? '+' : '') + fmt(riskTrend.delta, 4) +
          '，约 ' + fmt(riskTrend.slope_per_hour, 5) + '/小时）'));
      }
      // 单看"当前值是否超范围"会漏掉"还在正常区间但正在快速恶化"的患者，
      // 这一节就是为那类患者准备的，因此把"需关注"的行单独标出来。
      var concerning = trendRows.filter(function (row) { return row.concerning; });
      if (concerning.length) {
        s5.appendChild(el('div', 'report-text',
          '其中 ' + concerning.length + ' 项变化方向与病情改善相反，需要重点关注。'));
      }
      s5.appendChild(tableOf(
        ['指标', '首值', '末值', '变化', '斜率（/小时）', '方向', '是否需关注'],
        trendRows.map(function (row) {
          return {
            cells: [
              row.name_zh,
              fmt(row.first, 2) + row.unit,
              fmt(row.last, 2) + row.unit,
              (row.delta >= 0 ? '+' : '') + fmt(row.delta, 2) + row.unit,
              (row.slope_per_hour >= 0 ? '+' : '') + fmt(row.slope_per_hour, 4),
              row.direction_zh,
              row.concerning === null || row.concerning === undefined
                ? '—' : (row.concerning ? '是' : '否')
            ],
            className: row.concerning ? 'is-abnormal'
              : (row.direction === 'flat' ? '' : 'is-caution')
          };
        })
      ));
      s5.appendChild(el('div', 'report-text', trends.note || ''));
    } else {
      s5.appendChild(el('div', 'dim',
        '观察窗口内的实测点少于 2 个，无法计算趋势。'));
    }
    host.appendChild(s5);

    /* ---------- 六、信息缺口 ---------- */
    var s6 = el('div', 'report-section');
    s6.appendChild(sectionTitle(6, '信息缺口'));
    if (report.information_gaps.length) {
      var gapList = el('ul', 'evidence-list');
      report.information_gaps.forEach(function (gap) {
        gapList.appendChild(el('li', null, gap.phrase_zh));
      });
      s6.appendChild(gapList);
    } else {
      s6.appendChild(el('div', 'dim', '关键检验在窗口内均已测量且未明显陈旧。'));
    }
    host.appendChild(s6);

    /* ---------- 七、模型归因 ---------- */
    var s7 = el('div', 'report-section');
    s7.appendChild(sectionTitle(7, '模型归因'));
    if (report.attribution.items.length) {
      s7.appendChild(el('div', 'report-text',
        report.attribution.source === 'model'
          ? '以下为模型对该患者当前时点风险的主要贡献特征。'
          : '模型贡献度不可用，以下为基于临床显著性的启发式排序，仅供参考。'));
      s7.appendChild(tableOf(
        ['特征', '临床表述'],
        report.attribution.items.map(function (item) {
          return { cells: [item.feature || '', item.phrase_zh || ''] };
        })
      ));
    } else {
      s7.appendChild(el('div', 'dim', '暂无可用的归因结果。'));
    }
    host.appendChild(s7);

    /* ---------- 八、病程观察日志 ---------- */
    var s8 = el('div', 'report-section');
    s8.appendChild(sectionTitle(8, '病程观察日志'));
    if (report.timeline.length) {
      var kindZh = { admission: '入院', onset: '病情变化', intervention: '临床干预',
                     alert: '告警', measurement: '数据采集', note: '记录',
                     handover: '交接班', error: '异常' };
      var tl = el('div', 'timeline');
      report.timeline.forEach(function (item) {
        var node = el('div', 'tl-item is-' + (item.kind || 'note'));
        node.appendChild(el('span', 'tl-hour', 'T+' + (item.hour || 0) + 'h'));
        node.appendChild(el('span', 'tl-msg',
          (kindZh[item.kind] || item.kind || '') + '：' + (item.message || '')));
        tl.appendChild(node);
      });
      s8.appendChild(tl);
    } else {
      s8.appendChild(el('div', 'dim', '该患者暂无观察日志。'));
    }
    host.appendChild(s8);

    /* ---------- 九、文字结论 ---------- */
    var s9 = el('div', 'report-section');
    s9.appendChild(sectionTitle(9, '文字结论'));
    report.narrative.forEach(function (section) {
      var sub = el('div');
      // 去掉叙事小节自带的"一、二、…"前缀：外层章节已有编号，
      // 两层都带序号会显得像同一层级。
      sub.appendChild(el('div', 'dsec-title',
        String(section.title || '').replace(/^[一二三四五六七八九十]+、/, '')));
      sub.appendChild(el('div', 'report-text', section.text));
      sub.style.marginBottom = 'var(--sp-4)';
      s9.appendChild(sub);
    });
    host.appendChild(s9);

    /* ---------- 页脚 ---------- */
    var foot = el('div', 'report-section');
    foot.style.borderTop = '2px solid var(--border-hi)';
    foot.style.paddingTop = 'var(--sp-3)';
    foot.appendChild(el('div', 'report-text',
      '本报告由哨兵 SepsisGuard 于 ' + report.generated_at + ' 自动生成。' +
      '数据来源：' + h.origin_zh + '。\n' + report.disclaimer));
    host.appendChild(foot);

    buildTableOfContents(host, head);
  }

  /**
   * 给每一节编号并生成目录。
   *
   * 报告是"多页文书"而不是一条长滚动：打印时每节另起一页（见 connect.css 的
   * @media print），因此目录里的"第 N 节"在纸面上是可以按页翻到的。
   * 目录由已渲染的标题反推生成，而不是另维护一份标题清单——
   * 两份清单一提高概率不一致。
   */
  function buildTableOfContents(host, head) {
    var sections = host.querySelectorAll('.report-section');
    var items = [];
    Array.prototype.forEach.call(sections, function (section) {
      var title = section.querySelector('.report-section-title');
      if (!title) return;
      section.id = 'rsec-' + items.length;
      items.push({ id: section.id, label: title.textContent.trim() });
    });
    if (items.length < 2) return;

    var toc = el('div', 'report-toc');
    toc.appendChild(el('div', 'report-toc-title', '目录'));
    var list = document.createElement('ol');
    items.forEach(function (item) {
      var li = document.createElement('li');
      var link = document.createElement('a');
      link.href = '#' + item.id;
      link.textContent = item.label;
      li.appendChild(link);
      list.appendChild(li);
    });
    toc.appendChild(list);
    host.insertBefore(toc, head.nextSibling);
  }

  function tableOf(headers, rows) {
    var table = el('table', 'report-table');
    var thead = document.createElement('thead');
    var hr = document.createElement('tr');
    headers.forEach(function (text) { hr.appendChild(el('th', null, text)); });
    thead.appendChild(hr);
    table.appendChild(thead);
    var tbody = document.createElement('tbody');
    rows.forEach(function (row) {
      var tr = document.createElement('tr');
      if (row.className) tr.className = row.className;
      row.cells.forEach(function (text, index) {
        var td = el('td', index >= 1 && /^[\d.\-+—]+$/.test(String(text).trim()) ? 'num' : null,
          String(text));
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    return table;
  }

  /* ------------------------------------------------------------------ *
   * 启动
   * ------------------------------------------------------------------ */
  function boot() {
    var params = new URLSearchParams(global.location.search);
    var presetPatient = params.get('patient');
    var presetOrigin = params.get('origin');
    if (presetOrigin) {
      $('originSelect').value = presetOrigin;
      State.origin = presetOrigin;
    }
    if (presetPatient) $('patientInput').value = presetPatient;

    $('generateBtn').addEventListener('click', function () { generate(); });
    $('reloadBtn').addEventListener('click', function () { loadSubjects(); });
    $('randomBtn').addEventListener('click', function () {
      var groups = visibleSubjects();
      if (!groups.length) return;
      var entry = groups[Math.floor(Math.random() * groups.length)];
      var item = entry.items[Math.floor(Math.random() * entry.items.length)];
      $('patientInput').value = item.patient_id;
      $('originSelect').value = entry.group.origin;
      State.origin = entry.group.origin;
      generate(item.patient_id, entry.group.origin);
    });
    $('patientInput').addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') generate();
    });
    $('subjectFilter').addEventListener('input', function (ev) {
      State.filter = ev.target.value;
      renderSubjects();
    });
    $('originSelect').addEventListener('change', function (ev) {
      State.origin = ev.target.value;
      State.report = null;
      renderSubjects();
    });
    $('printBtn').addEventListener('click', function () {
      if (!State.report) { $('reportSub').textContent = '请先生成报告再打印。'; return; }
      global.print();
    });
    $('mdBtn').addEventListener('click', function () {
      if (!State.report) { $('reportSub').textContent = '请先生成报告再导出。'; return; }
      var origin = State.report.header.origin;
      var pid = State.report.patient_id;
      $('mdBtn').disabled = true;
      // 经 SGBridge 取 Markdown 文本，再在浏览器里触发下载。
      // **不能**直接把 location 指向 /api/report/...md：内置模式下没有后端可服务
      // 这个地址，点击后会跳到一个 404 页面。
      request('/api/report/patient/' + encodeURIComponent(pid) + '.md?origin=' +
        encodeURIComponent(origin))
        .then(function (text) {
          $('mdBtn').disabled = false;
          downloadText(pid + '_评估报告.md',
            typeof text === 'string' ? text : JSON.stringify(text, null, 2));
        })
        .catch(function (err) {
          $('mdBtn').disabled = false;
          $('reportSub').textContent = '导出失败：' + err.message;
        });
    });

    setConn('offline', '检测数据来源…');
    request('/api/health').then(function (data) {
      var builtin = global.SGBridge && global.SGBridge.isBuiltin();
      setConn('online', builtin ? '内置仿真模式' : '后端在线');
      renderSourceBadge();
      if (data && data.model_name) {
        $('navModel').textContent = '评分：' + data.model_name;
      }
    }).catch(function () {
      setConn('error', '异常');
    });

    loadSubjects().then(function () {
      if (presetPatient) generate(presetPatient, presetOrigin || 'auto');
    }).catch(function () { /* 已提示 */ });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window);
