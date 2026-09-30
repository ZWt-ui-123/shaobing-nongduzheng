/* ============================================================================
 * 哨兵 SepsisGuard —— 浏览器内置仿真内核（sim-core.js）
 * ----------------------------------------------------------------------------
 * 为什么要有这个文件
 * ------------------
 * v1 的 `live.html` 与 `manual.html` 通过 `fetch('/api/live/...')` 取数据，
 * 于是直接双击打开页面（`file://`）或没启动 Python 服务时，界面就报
 * "初始化失败""读取字段定义失败"。这是设计错误：
 *
 *   动态监护后端**本来就是我们自己模拟的**，手动录入的**指标定义本来就是
 *   固定字典**——两者都不需要外部服务。把仿真数据放在服务端，等于让"演示"
 *   依赖一个本可以不存在的东西。
 *
 * 现在把整套仿真搬到浏览器里，形成**双模式**：
 *
 *   后端可用  → 用后端（真实模型产物 LightGBM，指标定义同源）
 *   后端不可用 → 用本文件的**内置仿真内核**，页面功能完整、可交互、可视化
 *
 * 唯一仍然必须依赖后端的是**真实接入**（文件 / REST / FHIR / HL7 / 推送）——
 * 那本来就需要一个进程去读写文件与发起网络连接，浏览器沙箱做不到。
 *
 * 内置内核包含
 * ------------
 *   Scenarios    5 种监护场景画像（与 sepsisguard/scenarios.py 逐项一致）
 *   Engine       100 位患者的连续状态引擎：锚点病程 + 平滑插值 + 干预衰减，
 *                支持推进 / 快进 / 暂停 / 回退 / 回放，逐患者观察日志
 *   Score        透明的临床偏离度风险评分（**明确标注为规则评分**，
 *                不冒充机器学习模型输出）
 *   Assess       完整评估：风险序列、告警与抑制、qSOFA/SIRS/NEWS2 交叉核对、
 *                指标逐项、指标趋势、信息缺口、文字结论
 *   Timeline     localStorage 持久化的每位患者观察日志（一人一个键）
 *   Bridge       统一方法面：页面只调 SGBridge.xxx()，不直接写 fetch
 * ========================================================================== */
(function (global) {
  'use strict';

  /* ================================================================== *
   * 一、确定性随机与工具
   * ================================================================== */
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function round(v, d) { var f = Math.pow(10, d === undefined ? 2 : d); return Math.round(v * f) / f; }

  /** Box-Muller：把均匀随机转成标准正态（用于生理噪声）。 */
  function gauss(rng) {
    var u = 0, v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** 稳定的字符串哈希：同一患者编号必须总是得到同一相位，否则刷新一次就变样。 */
  function hashStr(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h * 16777619) >>> 0;
    }
    return h >>> 0;
  }

  /* ================================================================== *
   * 二、生理参数表（与 sepsisguard/simulator.py 逐项对应）
   * ================================================================== */
  var BASELINES = {
    HR: [78, 12], O2Sat: [97, 1.5], Temp: [37, 0.4], SBP: [122, 15],
    MAP: [85, 11], DBP: [70, 10], Resp: [16, 3], EtCO2: [36, 4],
    Lactate: [1.1, 0.4], WBC: [9, 3], Creatinine: [1, 0.3], Platelets: [240, 60],
    BUN: [15, 5], Hgb: [12.5, 1.8], Hct: [38, 5], Potassium: [4.1, 0.4],
    Glucose: [130, 35], pH: [7.38, 0.04], PaCO2: [40, 5], SaO2: [96.5, 1.8],
    FiO2: [0.25, 0.06], HCO3: [24, 3], Calcium: [9, 0.5], Chloride: [103, 4],
    Magnesium: [2, 0.3], Phosphate: [3.4, 0.6], AST: [35, 18],
    Alkalinephos: [95, 35], Bilirubin_total: [0.9, 0.5], Bilirubin_direct: [0.2, 0.15],
    TroponinI: [0.02, 0.02], Fibrinogen: [320, 80], PTT: [32, 6], BaseExcess: [0, 2.5]
  };

  var DETERIORATION = {
    HR: 32, Resp: 9, Temp: 1.3, SBP: -28, MAP: -22, DBP: -14, O2Sat: -5.5,
    SaO2: -5, Lactate: 3.2, WBC: 7.5, Creatinine: 0.9, BUN: 12,
    Platelets: -80, FiO2: 0.18, PaCO2: -6, pH: -0.05, HCO3: -3,
    BaseExcess: -3.5, Glucose: 45
  };

  var NOISE = {
    HR: 4, O2Sat: 1.2, Temp: 0.25, SBP: 7, MAP: 6, DBP: 5, Resp: 2, EtCO2: 3,
    Lactate: 0.25, WBC: 1.2, Creatinine: 0.12, Platelets: 18, BUN: 2.5,
    Hgb: 0.5, Hct: 1.5, Potassium: 0.2, Glucose: 18, pH: 0.02, PaCO2: 3,
    SaO2: 1.2, FiO2: 0.02, HCO3: 1.5, Calcium: 0.3, Chloride: 2,
    Magnesium: 0.15, Phosphate: 0.35, AST: 12, Alkalinephos: 20,
    Bilirubin_total: 0.2, Bilirubin_direct: 0.08, TroponinI: 0.01,
    Fibrinogen: 45, PTT: 4, BaseExcess: 1.5
  };

  var PHYS_LIMITS = {
    HR: [20, 220], O2Sat: [60, 100], Temp: [32, 42], SBP: [50, 220],
    MAP: [35, 160], DBP: [25, 130], Resp: [4, 60], EtCO2: [10, 70],
    Lactate: [0.2, 20], WBC: [0.5, 60], Creatinine: [0.2, 12],
    Platelets: [5, 700], BUN: [2, 150], Hgb: [4, 20], Hct: [12, 60],
    Potassium: [2, 8], Glucose: [25, 600], pH: [6.8, 7.8], PaCO2: [15, 100],
    SaO2: [60, 100], FiO2: [0.21, 1], HCO3: [5, 45], Calcium: [5, 14],
    Chloride: [70, 140], Magnesium: [0.5, 5], Phosphate: [0.5, 12],
    AST: [5, 3000], Alkalinephos: [20, 1200], Bilirubin_total: [0.1, 40],
    Bilirubin_direct: [0, 25], TroponinI: [0, 50], Fibrinogen: [60, 900],
    PTT: [15, 150], BaseExcess: [-25, 25]
  };

  function clipPhysiological(variable, value) {
    var lim = PHYS_LIMITS[variable];
    return lim ? clamp(value, lim[0], lim[1]) : value;
  }

  /* ================================================================== *
   * 三、监护场景（与 sepsisguard/scenarios.py 逐项一致）
   * ================================================================== */
  var BASIC_LABS = ['WBC', 'Hgb', 'Hct', 'Platelets', 'Potassium', 'Chloride',
    'Calcium', 'Glucose', 'BUN', 'Creatinine'];
  var EXTENDED_LABS = ['Lactate', 'Bilirubin_total', 'Bilirubin_direct', 'AST',
    'Alkalinephos', 'Magnesium', 'Phosphate', 'PTT', 'Fibrinogen'];
  var CRITICAL_LABS = ['pH', 'PaCO2', 'SaO2', 'FiO2', 'HCO3', 'BaseExcess', 'TroponinI'];

  function profile(o) {
    // 信息完整度与 scenarios.py 的 info_completeness() 同式：
    // 可测覆盖率 × 采样频率折扣 × 缺失率折减
    var dynamicTotal = 8 + 26;
    var available = {};
    o.monitored_vitals.concat(o.available_labs).forEach(function (v) { available[v] = 1; });
    var coverage = Object.keys(available).length / dynamicTotal;
    var freq = Math.min(1, 1 / Math.max(o.vital_interval_hours, 0.5));
    var dropout = (1 - o.vital_dropout_rate) * (1 - o.lab_dropout_rate * 0.5);
    o.info_completeness = round(coverage * (0.6 + 0.4 * freq) * dropout, 4);
    return o;
  }

  var SCENARIOS = {
    icu: profile({
      key: 'icu', name_zh: '重症监护病房',
      description: '监护仪逐小时记录生命体征，检验项目齐全、每日多次。信息最完整，风险判断的置信度最高。',
      monitored_vitals: ['HR', 'O2Sat', 'Temp', 'SBP', 'DBP', 'MAP', 'Resp', 'EtCO2'],
      vital_interval_hours: 1, vital_dropout_rate: 0.09,
      available_labs: BASIC_LABS.concat(EXTENDED_LABS, CRITICAL_LABS),
      lab_interval_hours: 12, lab_dropout_rate: 0.02,
      severity_offset: 0, sepsis_rate: 0.09, stay_hours_range: [24, 120],
      has_advanced_monitoring: true, confidence_discount: 0
    }),
    ward: profile({
      key: 'ward', name_zh: '普通病房',
      description: '护士每 4 小时测量生命体征，检验以基础血常规与生化为主、每日一次。监测密度低于重症监护，但足以支撑趋势判断。',
      monitored_vitals: ['HR', 'O2Sat', 'Temp', 'SBP', 'DBP', 'Resp', 'MAP'],
      vital_interval_hours: 4, vital_dropout_rate: 0.14,
      available_labs: BASIC_LABS.concat(['Lactate', 'Bilirubin_total', 'AST']),
      lab_interval_hours: 24, lab_dropout_rate: 0.18,
      severity_offset: 0.06, sepsis_rate: 0.06, stay_hours_range: [48, 240],
      has_advanced_monitoring: false, confidence_discount: 0.10
    }),
    nursing_home: profile({
      key: 'nursing_home', name_zh: '养老机构',
      description: '每班次约 8 小时测量一次生命体征，检验依赖外送、每周一至两次。老年患者感染表现常不典型（可无发热），需更依赖趋势与功能状态变化。',
      monitored_vitals: ['HR', 'O2Sat', 'Temp', 'SBP', 'Resp'],
      vital_interval_hours: 8, vital_dropout_rate: 0.20,
      available_labs: BASIC_LABS.concat(['Lactate']),
      lab_interval_hours: 72, lab_dropout_rate: 0.45,
      severity_offset: 0.16, sepsis_rate: 0.05, stay_hours_range: [168, 720],
      has_advanced_monitoring: false, confidence_discount: 0.28
    }),
    home_care: profile({
      key: 'home_care', name_zh: '家庭养护',
      description: '可穿戴设备连续采集心率与血氧，几乎不做检验。信息最稀薄，风险分数主要反映即时状态，趋势判断依赖长期基线。',
      monitored_vitals: ['HR', 'O2Sat'],
      vital_interval_hours: 1, vital_dropout_rate: 0.28,
      available_labs: [],
      lab_interval_hours: 0, lab_dropout_rate: 1,
      severity_offset: 0.22, sepsis_rate: 0.03, stay_hours_range: [336, 1440],
      has_advanced_monitoring: false, confidence_discount: 0.45
    }),
    post_op: profile({
      key: 'post_op', name_zh: '术后随访',
      description: '术后 72 小时内每 6 小时监测，检验按需开单。这一时段是吻合口漏、切口感染等并发症的高发窗口。',
      monitored_vitals: ['HR', 'O2Sat', 'Temp', 'SBP', 'DBP', 'MAP', 'Resp'],
      vital_interval_hours: 6, vital_dropout_rate: 0.12,
      available_labs: BASIC_LABS.concat(['Lactate', 'Bilirubin_total', 'PTT']),
      lab_interval_hours: 24, lab_dropout_rate: 0.22,
      severity_offset: 0.10, sepsis_rate: 0.07, stay_hours_range: [24, 168],
      has_advanced_monitoring: false, confidence_discount: 0.12
    })
  };
  var SCENARIO_ORDER = ['icu', 'ward', 'nursing_home', 'home_care', 'post_op'];
  var UNIT_PREFIX = { icu: 'ICU', ward: 'WARD', nursing_home: 'NH', home_care: 'HOME', post_op: 'PO' };

  var COURSE_ZH = {
    stable: '平稳观察', improving: '逐步改善',
    deteriorating: '存在恶化风险', fluctuating: '波动病程'
  };

  function scenarioSummary() {
    return SCENARIO_ORDER.map(function (key) {
      var s = SCENARIOS[key];
      return {
        key: s.key, name_zh: s.name_zh, description: s.description,
        vital_interval_hours: s.vital_interval_hours,
        n_monitored_vitals: s.monitored_vitals.length,
        monitored_vitals: s.monitored_vitals.slice(),
        n_available_labs: s.available_labs.length,
        lab_interval_hours: s.lab_interval_hours,
        sepsis_rate: s.sepsis_rate,
        info_completeness: s.info_completeness,
        confidence_discount: s.confidence_discount,
        has_advanced_monitoring: s.has_advanced_monitoring
      };
    });
  }

  /* ================================================================== *
   * 四、患者状态与连续引擎
   * ================================================================== */
  function makePatient(index, scen, rng, mixName) {
    var key = mixName || 'icu';
    var p = SCENARIOS[key];
    var age = clamp(gauss(rng) * 16 + (rng() < 0.5 ? 68 : 54), 18, 96);
    var gender = rng() < 0.55 ? 1 : 0;
    var baseline = {};
    Object.keys(BASELINES).forEach(function (v) {
      baseline[v] = BASELINES[v][0] + gauss(rng) * BASELINES[v][1];
    });
    if (age >= 70) {
      baseline.SBP -= 6;
      baseline.Creatinine += 0.15;
    }
    var willSeize = rng() < p.sepsis_rate;
    var hypothermia = willSeize && rng() < 0.28;
    var severity = clamp(betaLike(rng, 2, 3) + p.severity_offset, 0, 1);
    var lo = p.stay_hours_range[0], hi = p.stay_hours_range[1];
    var totalHours = Math.round(lo + rng() * (hi - lo));

    var course, onset = null, anchors, declineFrom, ramp;
    var roll = rng();
    if (willSeize) {
      course = 'deteriorating';
      onset = Math.round(totalHours * 0.35 + rng() * totalHours * 0.5);
      var lead = 6 + rng() * 12;
      declineFrom = Math.max(0, onset - lead);
      ramp = Math.max(4, onset - declineFrom);
      anchors = [[0, 0.10 * severity], [Math.min(6, totalHours), 0],
                 [declineFrom, 0.05], [onset, 0.85 + 0.5 * severity],
                 [totalHours, 1.0 + 0.6 * severity]];
    } else if (roll < 0.45) {
      course = 'improving';
      declineFrom = Math.round(totalHours * 0.3);
      ramp = Math.max(6, Math.round(totalHours * 0.3));
      anchors = [[0, 0.45 * severity], [Math.min(24, totalHours), 0.15 * severity],
                 [totalHours, 0]];
    } else if (roll < 0.72) {
      course = 'fluctuating';
      var eventAt = Math.max(3, Math.round(totalHours * (0.2 + rng() * 0.5)));
      declineFrom = Math.max(1, eventAt - 3);
      ramp = 3;
      anchors = [[0, 0.20 * severity], [declineFrom, 0.10],
                 [eventAt, 0.55 * severity], [Math.min(totalHours, eventAt + 6), 0.20],
                 [totalHours, 0.08]];
    } else {
      course = 'stable';
      declineFrom = Math.round(totalHours * 0.35);
      ramp = Math.max(6, Math.round(totalHours * 0.35));
      anchors = [[0, 0.18 * severity], [totalHours, 0.10 * severity]];
    }
    anchors.sort(function (a, b) { return a[0] - b[0]; });

    return {
      id: 'LIVE' + String(index).padStart(4, '0'),
      scenario: key,
      scenario_zh: p.name_zh,
      age: round(age, 1),
      gender: gender,
      unit: UNIT_PREFIX[key] + '-' + (index % 24 + 1),
      baseline: baseline,
      anchors: anchors,
      course: course,
      onset_hour: onset,
      hypothermia: hypothermia,
      severity: severity,
      total_hours: totalHours,
      current_hour: 0,
      drift: {},
      events: [],
      history: {},
      risk_history: {},
      timeline: [{
        hour: 0, kind: 'admission',
        message: p.name_zh + '收入监护，' + Math.round(age) + ' 岁' +
          (gender ? '男' : '女') + '，病程类型：' + COURSE_ZH[course],
        source: '内置仿真引擎'
      }]
    };
  }

  /** Beta(2,3) 的近似抽样：够用且不引入额外依赖。 */
  function betaLike(rng, a, b) {
    var x = 0, y = 0;
    for (var i = 0; i < a; i++) x += rng();
    for (var j = 0; j < b; j++) y += rng();
    return x / (x + y);
  }

  /** 锚点之间的平滑插值（smoothstep），避免锚点处出现折角。 */
  function offsetAt(patient, hour) {
    var a = patient.anchors;
    if (!a.length) return 0;
    if (hour <= a[0][0]) return a[0][1];
    if (hour >= a[a.length - 1][0]) return a[a.length - 1][1];
    for (var i = 1; i < a.length; i++) {
      if (hour <= a[i][0]) {
        var t0 = a[i - 1][0], v0 = a[i - 1][1], t1 = a[i][0], v1 = a[i][1];
        if (t1 === t0) return v1;
        var r = (hour - t0) / (t1 - t0);
        return v0 + (v1 - v0) * (r * r * (3 - 2 * r));
      }
    }
    return a[a.length - 1][1];
  }

  function interventionEffect(patient, variable, hour) {
    var total = 0;
    patient.events.forEach(function (e) {
      if (e.kind !== 'intervention') return;
      var elapsed = hour - e.hour;
      if (elapsed < 0 || elapsed > 12) return;
      var decay = 1 - elapsed / 12;
      var eff = e.effects[variable];
      if (eff) total += eff * decay;
    });
    return total;
  }

  function valueAt(patient, variable, hour, offset, rng) {
    var base = patient.baseline[variable];
    if (base === undefined) return null;
    var drift = patient.drift[variable] || 0;
    drift += gauss(rng) * 0.006 * Math.max(Math.abs(base), 1);
    var limit = 0.22 * Math.max(Math.abs(base), 1);
    drift = clamp(drift, -limit, limit);
    patient.drift[variable] = drift;

    var value = base + drift;
    if (DETERIORATION[variable] !== undefined && offset > 0) {
      var delta = DETERIORATION[variable] * offset;
      if (variable === 'Temp' && patient.hypothermia) delta = -Math.abs(delta) * 0.8;
      value += delta;
    }
    value += interventionEffect(patient, variable, hour);
    var sd = NOISE[variable] || 0;
    if (sd > 0) value += gauss(rng) * sd;
    return clipPhysiological(variable, value);
  }

  function shouldMeasure(patient, scen, hour, kind, rng) {
    var interval, dropout;
    if (kind === 'vital') {
      interval = scen.vital_interval_hours;
      dropout = scen.vital_dropout_rate;
    } else {
      interval = scen.lab_interval_hours;
      dropout = scen.lab_dropout_rate;
      if (!interval || interval <= 0) return false;
    }
    var phase = (hashStr(patient.id) % 1000) / 1000 * interval;
    if ((hour + phase) % interval >= 1) return false;
    return rng() >= dropout;
  }

  var INTERVENTIONS = [
    ['补液复苏', { SBP: 12, MAP: 8, HR: -6, Lactate: -0.6 }],
    ['升压药启动', { SBP: 18, MAP: 12, DBP: 8 }],
    ['退热处理', { Temp: -0.9, HR: -5 }],
    ['吸氧上调', { O2Sat: 3, Resp: -2, FiO2: 0.08 }],
    ['镇痛镇静', { HR: -8, Resp: -3, MAP: -5 }]
  ];

  function Engine(opts) {
    opts = opts || {};
    this.n_patients = opts.n_patients || 100;
    this.scenario_key = opts.scenario || 'icu';
    this.seed = opts.seed === undefined ? 20260214 : opts.seed;
    this.mix_scenarios = opts.mix_scenarios !== false;
    this.rng = mulberry32(this.seed);
    this.patients = {};
    this.events = [];
    this._current_hour = 0;
    this._max_hour = 0;
    this._initialize();
  }

  Engine.prototype._initialize = function () {
    var keys = this.mix_scenarios ? SCENARIO_ORDER.slice() : [this.scenario_key];
    var weights = keys.map(function (k, i) { return i === 0 ? 3 : 1; });
    var sum = weights.reduce(function (a, b) { return a + b; }, 0);
    weights = weights.map(function (w) { return w / sum; });
    for (var i = 0; i < this.n_patients; i++) {
      var r = this.rng(), acc = 0, chosen = keys[0];
      for (var j = 0; j < keys.length; j++) {
        acc += weights[j];
        if (r <= acc) { chosen = keys[j]; break; }
      }
      var patient = makePatient(i, SCENARIOS[chosen], this.rng, chosen);
      this.patients[patient.id] = patient;
    }
  };

  Engine.prototype.max_hour = function () { return this._max_hour; };
  Engine.prototype.current_hour = function () { return this._current_hour; };
  Engine.prototype.replaying = function () { return this._current_hour < this._max_hour; };

  Engine.prototype._setCursor = function (hour) {
    hour = Math.max(0, Math.min(Math.round(hour), this._max_hour));
    this._current_hour = hour;
    var self = this;
    Object.keys(this.patients).forEach(function (id) { self.patients[id].current_hour = hour; });
  };

  Engine.prototype._tick = function () {
    var hour = this._current_hour + 1;
    var self = this;
    Object.keys(this.patients).forEach(function (id) {
      var patient = self.patients[id];
      var scen = SCENARIOS[patient.scenario];
      var offset = offsetAt(patient, hour);
      var obs = {};
      if (shouldMeasure(patient, scen, hour, 'vital', self.rng)) {
        scen.monitored_vitals.forEach(function (v) {
          var val = valueAt(patient, v, hour, offset, self.rng);
          if (val !== null) obs[v] = round(val, 3);
        });
      }
      if (scen.available_labs.length &&
          shouldMeasure(patient, scen, hour, 'lab', self.rng)) {
        scen.available_labs.forEach(function (v) {
          var val = valueAt(patient, v, hour, offset, self.rng);
          if (val !== null) obs[v] = round(val, 3);
        });
      }
      obs.Age = patient.age;
      obs.Gender = patient.gender;
      patient.history[hour] = obs;
      patient.current_hour = hour;

      if (patient.onset_hour !== null && Math.round(patient.onset_hour) === hour) {
        patient.timeline.push({
          hour: hour, kind: 'onset',
          message: '达到脓毒症判定标准（数据集口径），病情进入发作期',
          source: '内置仿真引擎'
        });
        self.events.push({ hour: hour, patient_id: id, kind: 'onset',
          message: id + ' 达到发作判定时点' });
      }
    });
    this._current_hour = hour;
    this._max_hour = Math.max(this._max_hour, hour);
    this._maybeIntervene(hour);
  };

  Engine.prototype._maybeIntervene = function (hour) {
    var self = this;
    Object.keys(this.patients).forEach(function (id) {
      if (self.rng() > 0.012) return;
      var patient = self.patients[id];
      var pick = INTERVENTIONS[Math.floor(self.rng() * INTERVENTIONS.length)];
      patient.events.push({ kind: 'intervention', hour: hour, name: pick[0], effects: pick[1] });
      patient.timeline.push({
        hour: hour, kind: 'intervention', message: '临床干预：' + pick[0],
        detail: pick[1], source: '内置仿真引擎'
      });
    });
  };

  /**
   * 推进若干小时。若目标小时已生成过（≤ max_hour）就是**重放**——
   * 只移动游标、不调用生成逻辑，因此不消耗随机数，曲线逐位一致。
   */
  Engine.prototype.advance = function (hours) {
    var step = hours === undefined ? 1 : hours;
    for (var i = 0; i < step; i++) {
      var next = this._current_hour + 1;
      if (next <= this._max_hour) this._setCursor(next);
      else this._tick();
    }
    return this._current_hour;
  };

  Engine.prototype.seek = function (hour) { this._setCursor(hour); return this._current_hour; };
  Engine.prototype.rewind = function (hours) { return this.seek(this._current_hour - hours); };

  Engine.prototype.summary = function () {
    var byScenario = {}, byCourse = {}, totalRecords = 0, interventions = 0;
    var self = this;
    Object.keys(this.patients).forEach(function (id) {
      var p = self.patients[id];
      byScenario[p.scenario] = (byScenario[p.scenario] || 0) + 1;
      byCourse[p.course] = (byCourse[p.course] || 0) + 1;
      totalRecords += Object.keys(p.history).length;
      interventions += p.events.filter(function (e) { return e.kind === 'intervention'; }).length;
    });
    var byScenarioZh = {};
    Object.keys(byScenario).forEach(function (k) {
      byScenarioZh[SCENARIOS[k].name_zh] = byScenario[k];
    });
    var byCourseZh = {};
    Object.keys(byCourse).forEach(function (k) { byCourseZh[COURSE_ZH[k]] = byCourse[k]; });
    return {
      n_patients: Object.keys(this.patients).length,
      current_hour: this._current_hour,
      max_hour: this._max_hour,
      replaying: this.replaying(),
      total_patient_hours: totalRecords,
      by_scenario: byScenario,
      by_scenario_zh: byScenarioZh,
      by_course: byCourse,
      by_course_zh: byCourseZh,
      interventions: interventions,
      seed: this.seed,
      source: 'builtin'
    };
  };

  Engine.prototype.patientSnapshot = function (id, windowHours) {
    var patient = this.patients[id];
    if (!patient) return null;
    var cursor = patient.current_hour;
    var hours = Object.keys(patient.history).map(Number)
      .filter(function (h) { return h <= cursor; }).sort(function (a, b) { return a - b; });
    if (windowHours && windowHours > 0) hours = hours.slice(-windowHours);
    var variables = {};
    global.SGVars.ORDER.forEach(function (v) {
      variables[v] = hours.map(function (h) {
        var val = patient.history[h] ? patient.history[h][v] : undefined;
        return (val === undefined || val === null) ? null : round(val, 4);
      });
    });
    var risks = {};
    Object.keys(patient.risk_history).forEach(function (h) {
      if (Number(h) <= cursor) risks[h] = round(patient.risk_history[h], 4);
    });
    var scen = SCENARIOS[patient.scenario];
    return {
      patient_id: id,
      scenario: patient.scenario,
      scenario_zh: scen.name_zh,
      unit: patient.unit,
      age: patient.age,
      gender: patient.gender,
      course: patient.course,
      course_zh: COURSE_ZH[patient.course],
      severity: round(patient.severity, 3),
      current_hour: cursor,
      max_hour: this._max_hour,
      replaying: this.replaying(),
      hours: hours,
      series: variables,
      timeseries: { hours: hours, variables: variables },
      risk_history: risks,
      timeline: patient.timeline.filter(function (e) {
        return e.hour === null || e.hour === undefined || e.hour <= cursor;
      }),
      events: patient.events.filter(function (e) { return e.hour <= cursor; }),
      onset_hour: patient.onset_hour,
      info_completeness: scen.info_completeness,
      confidence_discount: scen.confidence_discount
    };
  };

  /* ================================================================== *
   * 五、评分：透明的临床偏离度规则评分
   * ------------------------------------------------------------------
   * 浏览器里没有 LightGBM 产物，因此**不冒充模型输出**。这里用的是
   * "相对临床参考范围的偏离度"加权求和，实现完全公开、可逐项核对，
   * 界面与报告都会标注 `来源：内置规则评分（非模型输出）`。
   * 接上后端后自动换成真实模型分数。
   * ================================================================== */
  var WEIGHTS = {
    O2Sat: 1.0, SBP: 1.0, MAP: 0.9, Resp: 0.9, HR: 0.8, Temp: 0.7,
    Lactate: 1.3, Creatinine: 1.0, Platelets: 0.9, WBC: 0.7, BUN: 0.6,
    pH: 0.9, HCO3: 0.7, BaseExcess: 0.6, PaCO2: 0.6, FiO2: 0.7,
    Bilirubin_total: 0.6, AST: 0.3, Glucose: 0.4, Hgb: 0.4, Hct: 0.3,
    Potassium: 0.5, PTT: 0.4, Fibrinogen: 0.4, TroponinI: 0.6
  };

  function deviation(variable, value) {
    var spec = global.SGVars.SPECS[variable];
    if (!spec || spec.normal[0] === null || value === null || !isFinite(value)) return null;
    var lo = spec.normal[0], hi = spec.normal[1];
    var span = Math.max(hi - lo, 1e-6);
    if (value > hi) return (value - hi) / span;
    if (value < lo) return (lo - value) / span;
    return 0;
  }

  function scoreHour(values) {
    var sum = 0, weightSum = 0;
    Object.keys(values).forEach(function (v) {
      var w = WEIGHTS[v];
      if (!w) return;
      var dev = deviation(v, values[v]);
      if (dev === null) return;
      sum += w * clamp(dev, 0, 4);
      weightSum += w;
    });
    if (!weightSum) return 0;
    // 归一化：平均加权偏离 1.0（即超出常见区间一个区间宽度）映射到约 0.5
    return clamp(sum / weightSum / 2.0, 0, 1);
  }

  /** 为引擎里所有尚未评分的小时补分数（增量）。 */
  Engine.prototype.scoreAll = function () {
    var added = 0, self = this;
    Object.keys(this.patients).forEach(function (id) {
      var patient = self.patients[id];
      Object.keys(patient.history).map(Number).sort(function (a, b) { return a - b; })
        .forEach(function (h) {
          if (patient.risk_history[h] !== undefined) return;
          patient.risk_history[h] = scoreHour(patient.history[h]);
          added++;
        });
    });
    return added;
  };

  /* ================================================================== *
   * 六、临床规则评分（qSOFA / SIRS / NEWS2）—— 与后端口径一致
   * ================================================================== */
  function news2Resp(v) {
    if (v === null || v === undefined || !isFinite(v)) return 0;
    if (v <= 8) return 3; if (v <= 11) return 1; if (v <= 20) return 0;
    if (v <= 24) return 2; return 3;
  }
  function news2O2Sat(v, scale) {
    if (v === null || v === undefined || !isFinite(v)) return 0;
    if (scale === 2) {
      if (v <= 83) return 3; if (v <= 85) return 2; if (v <= 87) return 1;
      if (v <= 92) return 0; if (v <= 94) return 1; if (v <= 96) return 2; return 3;
    }
    if (v <= 91) return 3; if (v <= 93) return 2; if (v <= 95) return 1; return 0;
  }
  function news2SBP(v) {
    if (v === null || v === undefined || !isFinite(v)) return 0;
    if (v <= 90) return 3; if (v <= 100) return 2; if (v <= 110) return 1;
    if (v <= 219) return 0; return 3;
  }
  function news2Pulse(v) {
    if (v === null || v === undefined || !isFinite(v)) return 0;
    if (v <= 40) return 3; if (v <= 50) return 1; if (v <= 90) return 0;
    if (v <= 110) return 1; if (v <= 130) return 2; return 3;
  }
  function news2Temp(v) {
    if (v === null || v === undefined || !isFinite(v)) return 0;
    if (v <= 35.0) return 3; if (v <= 36.0) return 1; if (v <= 38.0) return 0;
    if (v <= 39.0) return 1; return 2;
  }

  function rulesFor(values) {
    var t = values.Temp, hr = values.HR, resp = values.Resp;
    var wbc = values.WBC, paco2 = values.PaCO2;
    var sirs = 0;
    if (t !== undefined && (t > 38.0 || t < 36.0)) sirs++;
    if (hr !== undefined && hr > 90) sirs++;
    if (resp !== undefined && resp > 20) sirs++;
    if (wbc !== undefined && (wbc > 12 || wbc < 4)) sirs++;
    else if (paco2 !== undefined && paco2 < 32) sirs++;

    var qsofa = 0;
    if (resp !== undefined && resp >= 22) qsofa++;
    if (values.SBP !== undefined && values.SBP <= 100) qsofa++;

    var parts = {
      respiratory_rate: news2Resp(resp),
      oxygen_saturation: news2O2Sat(values.O2Sat, 1),
      air_or_oxygen: (values.FiO2 !== undefined && values.FiO2 > 0.21) ? 2 : 0,
      systolic_bp: news2SBP(values.SBP),
      pulse: news2Pulse(hr),
      temperature: news2Temp(t),
      consciousness: 0
    };
    var news2 = 0;
    Object.keys(parts).forEach(function (k) { news2 += parts[k]; });
    return { SIRS: sirs, qSOFA: qsofa, NEWS2: news2, news2_items: parts };
  }

  var RULE_META = {
    SIRS: { max_score: 4, trigger_threshold: 2 },
    qSOFA: { max_score: 2, trigger_threshold: 2 },
    NEWS2: { max_score: 20, trigger_threshold: 5 }
  };
  var RULE_NOTE = {
    SIRS: '本数据集无白细胞杆状核比例，白细胞项仅用 WBC 计数阈值。',
    qSOFA: '本数据集无 GCS，qSOFA 为两项版本（呼吸频率、收缩压），满分 2 而非 3。',
    NEWS2: '本数据集无意识状态（ACVPU）与是否吸氧标记；意识项恒为 0，吸氧项用 FiO2 > 0.21 代理；SpO2 统一采用赋分表 A。'
  };

  function ruleMeaning(name, score, threshold) {
    var hit = score >= threshold;
    if (name === 'qSOFA') {
      return hit ? 'qSOFA ≥ 2：床旁快速筛查提示器官功能障碍风险，建议进一步评估'
                 : 'qSOFA < 2：床旁快速筛查未达警示线';
    }
    if (name === 'SIRS') {
      return hit ? 'SIRS ≥ 2 项：符合全身炎症反应标准，需结合感染证据判断'
                 : 'SIRS < 2 项：未达全身炎症反应标准';
    }
    if (name === 'NEWS2') {
      if (score >= 7) return 'NEWS2 ≥ 7：极高危，临床推荐紧急评估与升级监护';
      if (score >= 5) return 'NEWS2 ≥ 5：中危，临床推荐 1 小时内完成评估';
      return 'NEWS2 < 5：低危，按常规频次监测';
    }
    return '';
  }

  /* ================================================================== *
   * 七、告警与抑制（与 service/app.py 同一策略）
   * ================================================================== */
  var ALERT = {
    low_quantile: 0.50, medium_quantile: 0.85, high_quantile: 0.96,
    suppression_window_hours: 6, escalation_delta: 0.05,
    fallback: [0.02, 0.05, 0.10]
  };

  function quantile(sorted, q) {
    if (!sorted.length) return 0;
    var pos = (sorted.length - 1) * q;
    var lo = Math.floor(pos), hi = Math.ceil(pos);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }

  function calibrate(samples) {
    var valid = samples.filter(function (v) { return isFinite(v); })
      .sort(function (a, b) { return a - b; });
    if (valid.length < 10) return ALERT.fallback.slice();
    var low = quantile(valid, ALERT.low_quantile);
    var med = quantile(valid, ALERT.medium_quantile);
    var high = quantile(valid, ALERT.high_quantile);
    var eps = Math.max(1e-6, (valid[valid.length - 1] - valid[0]) * 1e-3);
    med = Math.max(med, low + eps);
    high = Math.max(high, med + eps);
    return [low, med, high];
  }

  function levelOf(score, thresholds) {
    var t = thresholds || ALERT.fallback;
    if (score >= t[2]) return 'high';
    if (score >= t[1]) return 'medium';
    if (score >= t[0]) return 'low';
    return 'normal';
  }

  var LEVEL_ZH = { normal: '正常', low: '低风险', medium: '中风险', high: '高风险' };

  /**
   * 时间窗抑制：同一患者 window 小时内只保留一条告警，
   * 风险**等级上升**或相对上升超过 escalation_delta 时突破抑制。
   * 与 `sepsisguard/evaluation.py::suppress_alerts` 同一套状态机。
   */
  function suppress(series, threshold, windowHours, escalationDelta, thresholds) {
    var kept = [], candidates = [];
    var lastKeptIndex = -1, lastKeptLevel = -1;
    var LEVEL_RANK = { normal: 0, low: 1, medium: 2, high: 3 };
    for (var i = 0; i < series.length; i++) {
      if (series[i] >= threshold) candidates.push(i);
    }
    candidates.forEach(function (i) {
      var level = LEVEL_RANK[levelOf(series[i], thresholds)];
      if (lastKeptIndex < 0) {
        kept.push(i); lastKeptIndex = i; lastKeptLevel = level; return;
      }
      var hoursSince = i - lastKeptIndex;
      var escalatedLevel = level > lastKeptLevel;
      var escalatedDelta = series[i] - series[lastKeptIndex] >= escalationDelta;
      if (hoursSince >= windowHours || escalatedLevel || escalatedDelta) {
        kept.push(i); lastKeptIndex = i; lastKeptLevel = level;
      }
    });
    return { kept: kept, candidates: candidates };
  }

  /* ================================================================== *
   * 八、评估与报告装配（与 service/report_api.py 同结构）
   * ================================================================== */
  var REPORT_VITALS = ['HR', 'O2Sat', 'Resp', 'Temp', 'SBP', 'DBP', 'MAP',
    'Lactate', 'Creatinine', 'WBC', 'Platelets', 'BUN', 'pH', 'HCO3', 'FiO2'];
  var KEY_LABS = ['Lactate', 'Creatinine', 'Platelets', 'WBC', 'Bilirubin_total', 'pH', 'PaCO2'];
  var STALE_HOURS = 12;
  var REPORT_NUMERALS = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

  function fmtRange(lo, hi) {
    function one(x) {
      if (Math.abs(x - Math.round(x)) < 1e-9) return String(Math.round(x));
      return String(round(x, 2));
    }
    return one(lo) + ', ' + one(hi);
  }

  function classifyVital(spec, value) {
    if (spec.normal[0] === null || spec.normal[1] === null) {
      return ['unrated', '该指标无通用参考范围，需结合临床背景判读'];
    }
    var lo = spec.normal[0], hi = spec.normal[1];
    var span = Math.max(hi - lo, 1e-9);
    if (value >= lo && value <= hi) return ['normal', '在常见范围 [' + fmtRange(lo, hi) + '] 内'];
    var direction = value > hi ? '偏高' : '偏低';
    if (value >= lo - span * 0.5 && value <= hi + span * 0.5) {
      return ['caution', direction + '，超出常见范围 [' + fmtRange(lo, hi) + ']，请确认'];
    }
    return ['abnormal', '明显' + direction + '，超出常见范围 [' + fmtRange(lo, hi) + ']'];
  }

  var STATUS_ZH = { normal: '正常', caution: '需注意', abnormal: '明显异常',
    unrated: '无参考范围', not_measured: '未测量' };

  function vitalsReport(hours, valuesByHour) {
    var rows = [];
    REPORT_VITALS.forEach(function (variable) {
      var spec = global.SGVars.SPECS[variable];
      if (!spec) return;
      var measured = [];
      hours.forEach(function (h, i) {
        var v = valuesByHour[h] ? valuesByHour[h][variable] : undefined;
        if (v !== undefined && v !== null && isFinite(v)) measured.push({ h: h, i: i, v: v });
      });
      var row = {
        variable: variable, name_zh: spec.label_zh, unit: spec.unit,
        normal: spec.normal.slice(), plausible: spec.plausible.slice(),
        higher_is_worse: spec.higher_is_worse, n_measured: measured.length
      };
      if (!measured.length) {
        row.last = null; row.last_hour = null; row.min = null; row.max = null;
        row.mean = null; row.status = 'not_measured'; row.status_zh = '未测量';
        row.detail_zh = '本次观察窗口内没有该项记录，判断置信度受限';
        row.hours_since_measured = null;
        rows.push(row); return;
      }
      var last = measured[measured.length - 1];
      var vals = measured.map(function (m) { return m.v; });
      var cls = classifyVital(spec, last.v);
      row.last = round(last.v, 4);
      row.last_hour = last.h;
      row.min = round(Math.min.apply(null, vals), 4);
      row.max = round(Math.max.apply(null, vals), 4);
      row.mean = round(vals.reduce(function (a, b) { return a + b; }, 0) / vals.length, 4);
      row.status = cls[0];
      row.status_zh = STATUS_ZH[cls[0]];
      row.detail_zh = cls[1];
      row.hours_since_measured = hours.length - 1 - last.i;
      rows.push(row);
    });
    return rows;
  }

  function trendsReport(hours, valuesByHour, riskSeries) {
    var rows = [];
    REPORT_VITALS.forEach(function (variable) {
      var spec = global.SGVars.SPECS[variable];
      if (!spec) return;
      var pts = [];
      hours.forEach(function (h, i) {
        var v = valuesByHour[h] ? valuesByHour[h][variable] : undefined;
        if (v !== undefined && v !== null && isFinite(v)) pts.push({ x: h, y: v });
      });
      if (pts.length < 2) return;
      var n = pts.length;
      var mx = pts.reduce(function (a, p) { return a + p.x; }, 0) / n;
      var my = pts.reduce(function (a, p) { return a + p.y; }, 0) / n;
      var num = 0, den = 0;
      pts.forEach(function (p) { num += (p.x - mx) * (p.y - my); den += (p.x - mx) * (p.x - mx); });
      var slope = den ? num / den : 0;
      var first = pts[0].y, last = pts[n - 1].y, delta = last - first;
      var span = (spec.normal[0] !== null && spec.normal[1] !== null)
        ? (spec.normal[1] - spec.normal[0])
        : Math.max(Math.abs(spec.plausible[1] - spec.plausible[0]) * 0.15, 1e-6);
      var relative = Math.abs(delta) / Math.max(span, 1e-9);
      var direction = relative < 0.25 ? 'flat' : (delta > 0 ? 'rising' : 'falling');
      var directionZh = direction === 'flat' ? '基本平稳'
        : (direction === 'rising' ? '呈上升趋势' : '呈下降趋势');
      var concerning = null;
      if (direction !== 'flat' && spec.higher_is_worse !== null) {
        concerning = (direction === 'rising') === !!spec.higher_is_worse;
      }
      rows.push({
        variable: variable, name_zh: spec.label_zh, unit: spec.unit,
        n_points: n, first: round(first, 4), first_hour: pts[0].x,
        last: round(last, 4), last_hour: pts[n - 1].x,
        delta: round(delta, 4), slope_per_hour: round(slope, 5),
        direction: direction, direction_zh: directionZh,
        concerning: concerning, normal: spec.normal.slice(),
        phrase_zh: spec.label_zh + ' 由 ' + trimNum(first) + spec.unit + ' 变为 ' +
          trimNum(last) + spec.unit + '（' + directionZh + '，约 ' +
          (slope >= 0 ? '+' : '') + round(slope, 4) + spec.unit + '/小时）'
      });
    });
    rows.sort(function (a, b) {
      var ca = a.concerning ? 0 : 1, cb = b.concerning ? 0 : 1;
      if (ca !== cb) return ca - cb;
      return Math.abs(b.delta) - Math.abs(a.delta);
    });
    var riskTrend = { available: !!riskSeries && riskSeries.length >= 2 };
    if (riskTrend.available) {
      var n2 = riskSeries.length;
      var mx2 = (n2 - 1) / 2;
      var num2 = 0, den2 = 0, mean2 = riskSeries.reduce(function (a, b) { return a + b; }, 0) / n2;
      riskSeries.forEach(function (y, i) { num2 += (i - mx2) * (y - mean2); den2 += (i - mx2) * (i - mx2); });
      riskTrend.first = round(riskSeries[0], 5);
      riskTrend.last = round(riskSeries[n2 - 1], 5);
      riskTrend.delta = round(riskSeries[n2 - 1] - riskSeries[0], 5);
      riskTrend.slope_per_hour = round(den2 ? num2 / den2 : 0, 6);
    }
    return {
      variables: rows, risk: riskTrend,
      note: '斜率由窗口内**实测点**上的最小二乘拟合得到（单位：每小时变化量），' +
            '不使用「末值减首值」——后者对单个噪声读数过于敏感。' +
            '方向判定以变化量相对该指标常见区间宽度的比例为准。'
    };
  }

  function trimNum(v) {
    var s = String(round(v, 3));
    return s.replace(/\.?0+$/, '');
  }

  function gapsReport(hours, observedAt) {
    var gaps = [];
    var n = hours.length;
    if (!n) return gaps;
    var lastHour = hours[n - 1];
    for (var i = 0; i < KEY_LABS.length; i++) {
      var variable = KEY_LABS[i];
      var spec = global.SGVars.SPECS[variable];
      if (!spec) continue;
      var seenIndex = -1;
      for (var k = 0; k < n; k++) {
        var obs = observedAt[hours[k]] || {};
        if (obs[variable] !== undefined && obs[variable] !== null) seenIndex = k;
      }
      var stale = (seenIndex < 0) ? (24 + 1) : (n - 1 - seenIndex);
      if (seenIndex >= 0 && stale < STALE_HOURS) continue;
      var phrase = (seenIndex < 0)
        ? spec.label_zh + '未测量，补充检测可提升判断置信度'
        : spec.label_zh + '已有约 ' + stale + ' 小时未复测，复查可提升判断置信度';
      gaps.push({
        variable: variable, name_zh: spec.label_zh,
        hours_since_measured: seenIndex < 0 ? null : stale, phrase_zh: phrase
      });
      if (gaps.length >= 5) break;
    }
    return gaps;
  }

  function alertReason(values) {
    var parts = [];
    global.SGVars.ORDER.forEach(function (variable) {
      var spec = global.SGVars.SPECS[variable];
      var v = values[variable];
      if (v === undefined || v === null || spec.normal[0] === null) return;
      if (v > spec.normal[1]) parts.push(spec.label_zh + ' ' + round(v, 2) + spec.unit + ' 高于 ' + spec.normal[1]);
      else if (v < spec.normal[0]) parts.push(spec.label_zh + ' ' + round(v, 2) + spec.unit + ' 低于 ' + spec.normal[0]);
    });
    if (!parts.length) {
      return '风险分数升高，但触发时刻未测到明确偏离的单项指标（可能来自趋势或缺失模式）';
    }
    return parts.slice(0, 4).join('；');
  }

  var ACTIONS = {
    normal: { action_zh: '常规监护，无需额外干预', response_zh: '按病区常规频率继续监测' },
    low: { action_zh: '维持当前监测频次，记录关键指标变化', response_zh: '本轮按常规频次复评' },
    medium: { action_zh: '建议提高监测频次并复查关键检验，记录液体出入量，4–6 小时后重新评估风险', response_zh: '加密观察，必要时通知值班医师' },
    high: { action_zh: '建议 1 小时内完成临床评估：完善感染相关检查（血培养、乳酸、器官功能），评估是否需要升级监护', response_zh: '尽快评估，准备升级监护' },
    critical: { action_zh: '建议立即床旁评估：复核感染灶、启动或调整抗感染方案，评估液体复苏与升压支持，复查乳酸与器官功能指标', response_zh: '立即处理' }
  };

  /**
   * 对一份观测历史做完整评估。
   * @param {string} patientId
   * @param {Object} valuesByHour  {小时: {变量: 值}}
   * @param {Object} meta          来源、年龄、性别、场景、时间线等
   */
  function assess(patientId, valuesByHour, meta) {
    meta = meta || {};
    var hours = Object.keys(valuesByHour).map(Number).sort(function (a, b) { return a - b; });
    var firstHour = hours.length ? hours[0] : null;
    var lastHour = hours.length ? hours[hours.length - 1] : null;

    // ---- 风险序列 ----
    var riskSeries = hours.map(function (h) { return scoreHour(valuesByHour[h] || {}); });
    var thresholds = calibrate(riskSeries);
    var current = riskSeries.length ? riskSeries[riskSeries.length - 1] : null;
    var peak = riskSeries.length ? Math.max.apply(null, riskSeries) : null;
    var peakIndex = riskSeries.length ? riskSeries.indexOf(peak) : 0;

    // ---- 告警 ----
    var trigger = thresholds[1];
    var sup = suppress(riskSeries, trigger, ALERT.suppression_window_hours,
      ALERT.escalation_delta, thresholds);
    var alerts = sup.kept.map(function (i) {
      var level = levelOf(riskSeries[i], thresholds);
      var act = ACTIONS[level] || ACTIONS.normal;
      return {
        hour: hours[i], risk_score: round(riskSeries[i], 4),
        level: level, level_zh: LEVEL_ZH[level],
        reason_zh: alertReason(valuesByHour[hours[i]] || {}),
        action_zh: act.action_zh, response_zh: act.response_zh
      };
    }).sort(function (a, b) { return b.risk_score - a.risk_score; });
    var candidates = sup.candidates.length;

    // ---- 规则 ----
    var rules = {};
    if (hours.length) {
      var latest = valuesByHour[lastHour] || {};
      var computed = rulesFor(latest);
      ['qSOFA', 'SIRS', 'NEWS2'].forEach(function (name) {
        var series = hours.map(function (h) { return rulesFor(valuesByHour[h] || {})[name]; });
        var cur = computed[name];
        rules[name] = {
          current: cur, peak: Math.max.apply(null, series),
          max_score: RULE_META[name].max_score,
          trigger_threshold: RULE_META[name].trigger_threshold,
          triggered: cur >= RULE_META[name].trigger_threshold,
          series: series, notes: RULE_NOTE[name],
          meaning_zh: ruleMeaning(name, cur, RULE_META[name].trigger_threshold)
        };
      });
    }

    // ---- 指标 / 趋势 / 缺口 ----
    var vitals = vitalsReport(hours, valuesByHour);
    var trends = trendsReport(hours, valuesByHour, riskSeries);
    var gaps = gapsReport(hours, valuesByHour);

    var measuredRatio = null;
    if (hours.length) {
      var hit = hours.filter(function (h) {
        var row = valuesByHour[h] || {};
        return KEY_LABS.some(function (v) { return row[v] !== undefined && row[v] !== null; });
      }).length;
      measuredRatio = round(hit / hours.length, 4);
    }

    var level = current === null ? 'normal' : levelOf(current, thresholds);
    var span6 = Math.min(6, Math.max(riskSeries.length - 1, 0));
    var trend6 = span6 > 0 ? round(current - riskSeries[riskSeries.length - 1 - span6], 5) : 0;

    var header = {
      patient_id: patientId,
      origin: meta.origin || 'builtin',
      origin_zh: meta.origin_zh || '内置仿真（浏览器端）',
      age: meta.age === undefined ? null : meta.age,
      gender: meta.gender === undefined ? null : meta.gender,
      gender_zh: meta.gender === 0 ? '女' : (meta.gender === 1 ? '男' : '未知'),
      unit: meta.unit || '',
      scenario: meta.scenario || meta.scenario_key || '',
      scenario_zh: meta.scenario_zh || '',
      course_zh: meta.course_zh || '',
      observed_hours: hours.length,
      first_hour: firstHour,
      last_hour: lastHour,
      onset_hour: meta.onset_hour === undefined ? null : meta.onset_hour,
      measured_ratio: measuredRatio,
      model_available: false,
      model_name: '内置规则评分',
      model_version: 'builtin-rules-v1',
      model_source_note: '浏览器内置仿真模式：未加载训练模型，风险分数来自公开可核对的' +
        '临床偏离度规则评分（非模型输出）。启动后端服务后将自动使用 LightGBM 模型产物。'
    };
    if (meta.info_completeness !== undefined) header.scenario_completeness = meta.info_completeness;
    if (meta.confidence_discount !== undefined) header.scenario_confidence_discount = meta.confidence_discount;

    var report = {
      patient_id: patientId,
      generated_at: nowString(),
      header: header,
      risk: {
        model_available: false, series: hours.map(function (h, i) {
          return { hour: h, risk: round(riskSeries[i], 5) };
        }),
        current: current === null ? null : round(current, 5),
        peak: peak === null ? null : round(peak, 5),
        peak_hour: hours.length ? hours[peakIndex] : null,
        level: level, level_zh: LEVEL_ZH[level],
        trend_6h: trend6,
        alert_count: alerts.length,
        thresholds: {
          low: round(thresholds[0], 5), medium: round(thresholds[1], 5),
          high: round(thresholds[2], 5), calibrated: riskSeries.length >= 10,
          quantiles: { low: ALERT.low_quantile, medium: ALERT.medium_quantile, high: ALERT.high_quantile }
        }
      },
      alerts: {
        alerts: alerts, candidates_before_suppression: candidates,
        suppressed: Math.max(0, candidates - alerts.length),
        suppression_ratio: candidates ? round(1 - alerts.length / candidates, 4) : null,
        suppression_window_hours: ALERT.suppression_window_hours,
        escalation_delta: ALERT.escalation_delta,
        thresholds: { low: round(thresholds[0], 5), medium: round(thresholds[1], 5), high: round(thresholds[2], 5) },
        note: '告警经时间窗抑制：同一患者在该窗口内只保留一条，等级上升可突破抑制。'
      },
      rules: rules,
      vitals: vitals,
      trends: trends,
      information_gaps: gaps,
      attribution: { source: 'unavailable', items: [] },
      timeline: (meta.timeline || []).slice(),
      source: 'builtin'
    };
    report.narrative = narrative(header, report);
    return report;
  }

  function nowString() {
    var d = new Date();
    function pad(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
      pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  function abnormalFindings(vitals, limit) {
    var priority = { abnormal: 0, caution: 1 };
    var found = vitals.filter(function (v) {
      return priority[v.status] !== undefined && v.last !== null;
    });
    found.sort(function (a, b) {
      if (priority[a.status] !== priority[b.status]) return priority[a.status] - priority[b.status];
      return Math.abs(b.last) - Math.abs(a.last);
    });
    return found.slice(0, limit || 6).map(function (item) {
      return item.name_zh + ' ' + item.last + item.unit + '（' + item.detail_zh + '）';
    });
  }

  function narrative(header, report) {
    var sections = [];
    var risk = report.risk, alerts = report.alerts, vitals = report.vitals;
    var trends = report.trends || { variables: [] };
    var gaps = report.information_gaps;
    var level = risk.level;

    var conclusion;
    if (risk.current === null) {
      conclusion = '本次评估**未能生成风险分数**（无可用的观测数据）。';
    } else {
      conclusion = '截至第 ' + header.last_hour + ' 小时，该患者风险分数为 ' +
        risk.current.toFixed(4) + '，分级为**' + risk.level_zh + '**；' +
        '观察窗口内峰值 ' + risk.peak.toFixed(4) + '（第 ' + risk.peak_hour + ' 小时）。';
      conclusion += risk.alert_count
        ? '共产生 ' + risk.alert_count + ' 条经抑制后的告警，最高等级为 ' +
          (alerts.alerts.length ? alerts.alerts[0].level_zh : '—') + '。'
        : '观察窗口内未触发告警。';
    }
    sections.push({ id: 'conclusion', title: '一、结论', text: conclusion });

    var evidence = [];
    var findings = abnormalFindings(vitals);
    if (findings.length) evidence.push('指标偏离：' + findings.join('；') + '。');
    var concerning = trends.variables.filter(function (r) { return r.concerning; });
    if (concerning.length) {
      evidence.push('值得关注的趋势：' +
        concerning.slice(0, 4).map(function (r) { return r.phrase_zh; }).join('；') + '。');
    }
    var ruleLines = Object.keys(report.rules).map(function (name) {
      var p = report.rules[name];
      return name + ' ' + p.current + ' 分（阈值 ' + p.trigger_threshold + '，' +
        (p.triggered ? '已触发' : '未触发') + '）';
    });
    if (ruleLines.length) evidence.push('临床规则：' + ruleLines.join('；') + '。');
    if (alerts.alerts.length) {
      var first = alerts.alerts[0];
      evidence.push('最高等级告警发生于第 ' + first.hour + ' 小时（风险 ' +
        first.risk_score.toFixed(4) + '）：' + first.reason_zh + '。');
    }
    if (!evidence.length) evidence.push('观察窗口内未见明确的单项指标偏离，临床规则亦未触发。');
    sections.push({ id: 'evidence', title: '二、判断依据', text: evidence.join('\n') });

    var dataLines = [
      '观察窗口：第 ' + header.first_hour + '–' + header.last_hour + ' 小时，共 ' +
        header.observed_hours + ' 个记录时点。',
      '关键指标覆盖度：' + (header.measured_ratio === null ? '—'
        : (header.measured_ratio * 100).toFixed(1) + '%') +
        (header.scenario_completeness !== undefined
          ? '（本场景信息完整度 ' + (header.scenario_completeness * 100).toFixed(1) + '%）' : '') + '。'
    ];
    dataLines.push(gaps.length
      ? '信息缺口：' + gaps.map(function (g) { return g.phrase_zh; }).join('；') + '。'
      : '关键检验在窗口内均已测量且未明显陈旧。');
    if (header.observed_hours < 6) {
      dataLines.push('**注意**：记录时点少于 6 个，窗口统计与趋势类特征基本不可用，' +
        '此时的风险分数主要反映瞬时状态，置信度显著低于连续监护场景。');
    }
    sections.push({ id: 'data', title: '三、数据充分性', text: dataLines.join('\n') });

    var act = ACTIONS[level] || ACTIONS.normal;
    var advice = [act.action_zh];
    if (act.response_zh) advice.push('监测安排：' + act.response_zh);
    if (alerts.alerts.length) advice.push('建议按告警顺序逐条核对依据，并结合床旁评估确认。');
    if (gaps.length) advice.push('补齐上述检验后可显著提升判断置信度，建议优先安排乳酸与器官功能复查。');
    advice.push('以上均为风险提示与监测建议，具体处置请遵医嘱。');
    sections.push({ id: 'advice', title: '四、建议行动', text: advice.join('\n') });

    var limits = [
      '本报告由研究原型系统自动生成，**不构成医疗诊断**。',
      '模型训练于公开重症监护数据集（PhysioNet/CinC Challenge 2019），' +
        '在不同机构的实际表现需以本地数据复核为准；详细性能与外部验证结果见 `docs/实验结果.md`。',
      '阈值按队列风险分布标定而非固定绝对值，因此**跨机构的分数不可直接比较**。'
    ];
    if (report.source === 'builtin') {
      limits.push('**本次评估运行在浏览器内置仿真模式**：风险分数来自公开可核对的临床' +
        '偏离度规则评分，不是训练模型的输出；数据由内置引擎生成，不代表任何真实患者。');
    }
    if (header.origin === 'manual') {
      limits.push('本报告的数据来自手工录入，录入误差、漏填与时间点近似都会影响结论。');
    }
    sections.push({ id: 'limitations', title: '五、局限与边界', text: limits.join('\n') });
    return sections;
  }

  /* ================================================================== *
   * 九、报告 → Markdown
   * ================================================================== */
  function reportToMarkdown(report) {
    var h = report.header, risk = report.risk, out = [];
    function add(s) { out.push(s); }
    add('# 脓毒症风险评估报告 · ' + report.patient_id);
    add('');
    add('> 本系统输出的是风险提示，不构成医疗诊断，临床决策请遵医嘱。');
    add('');
    add('- 生成时间：' + report.generated_at);
    add('- 数据来源：' + h.origin_zh);
    add('- 患者：' + h.patient_id + '｜' + h.gender_zh + '｜' +
      (h.age === null ? '—' : Math.round(h.age) + ' 岁') + '｜' + (h.unit || '—'));
    add('- 监护场景：' + (h.scenario_zh || '—') +
      (h.course_zh ? '｜病程：' + h.course_zh : ''));
    add('- 观察窗口：第 ' + h.first_hour + '–' + h.last_hour + ' 小时，共 ' +
      h.observed_hours + ' 个记录时点');
    if (h.measured_ratio !== null) add('- 关键指标覆盖度：' + (h.measured_ratio * 100).toFixed(1) + '%');
    add('- 评分来源：' + h.model_name + '（' + h.model_version + '）');
    add('');

    var sections = [];
    var body = [];
    if (risk.current === null) {
      body.push('风险分数不可用（无可用的观测数据）。');
    } else {
      body = ['| 指标 | 数值 |', '| --- | --- |',
        '| 当前风险分数 | ' + risk.current.toFixed(4) + ' |',
        '| 风险分级 | **' + risk.level_zh + '** |',
        '| 观察窗口峰值 | ' + risk.peak.toFixed(4) + '（第 ' + risk.peak_hour + ' 小时） |',
        '| 近 6 小时变化 | ' + (risk.trend_6h >= 0 ? '+' : '') + risk.trend_6h.toFixed(4) + ' |',
        '| 经抑制后告警条数 | ' + risk.alert_count + ' |', ''];
    }
    body.push('分级阈值（按队列分布标定，跨机构不可直接比较）：低 ' + risk.thresholds.low +
      ' / 中 ' + risk.thresholds.medium + ' / 高 ' + risk.thresholds.high);
    sections.push(['风险结论', body]);

    var a = report.alerts;
    body = ['触发候选 ' + a.candidates_before_suppression + ' 条，抑制后保留 ' +
      a.alerts.length + ' 条，抑制率 ' +
      (a.suppression_ratio === null ? '—' : (a.suppression_ratio * 100).toFixed(1) + '%') + '。', ''];
    if (a.alerts.length) {
      body = body.concat(['| 序号 | 触发小时 | 风险分数 | 分级 | 依据 | 建议 |',
        '| --- | --- | --- | --- | --- | --- |']);
      a.alerts.forEach(function (item, i) {
        body.push('| ' + (i + 1) + ' | 第 ' + item.hour + ' 小时 | ' +
          item.risk_score.toFixed(4) + ' | ' + item.level_zh + ' | ' + item.reason_zh +
          ' | ' + item.action_zh + ' |');
      });
    } else { body.push('观察窗口内未触发告警。'); }
    sections.push(['告警明细', body]);

    body = ['| 规则 | 当前评分 | 满分 | 触发阈值 | 是否触发 | 说明 |',
      '| --- | --- | --- | --- | --- | --- |'];
    Object.keys(report.rules).forEach(function (name) {
      var p = report.rules[name];
      body.push('| ' + name + ' | ' + p.current + ' | ' + p.max_score + ' | ' +
        p.trigger_threshold + ' | ' + (p.triggered ? '是' : '否') + ' | ' + p.meaning_zh + ' |');
    });
    sections.push(['临床规则交叉核对', body]);

    body = ['| 指标 | 最近值 | 参考范围 | 状态 | 说明 | 测量次数 | 距上次测量 |',
      '| --- | --- | --- | --- | --- | --- | --- |'];
    report.vitals.forEach(function (v) {
      body.push('| ' + v.name_zh + ' | ' + (v.last === null ? '—' : v.last + v.unit) +
        ' | ' + (v.normal[0] === null ? '—' : v.normal[0] + '–' + v.normal[1]) +
        ' | ' + v.status_zh + ' | ' + v.detail_zh + ' | ' + v.n_measured + ' | ' +
        (v.hours_since_measured === null ? '—' : v.hours_since_measured + ' 小时') + ' |');
    });
    sections.push(['指标逐项评估', body]);

    var trends = report.trends || { variables: [] };
    if (trends.variables.length) {
      body = [];
      if (trends.risk.available) {
        body = body.concat(['风险分数趋势：' + trends.risk.first.toFixed(4) + ' → ' +
          trends.risk.last.toFixed(4) + '（' + (trends.risk.delta >= 0 ? '+' : '') +
          trends.risk.delta.toFixed(4) + '，约 ' + trends.risk.slope_per_hour.toFixed(5) + '/小时）', '']);
      }
      body = body.concat(['| 指标 | 首值 | 末值 | 变化 | 斜率（/小时） | 方向 | 是否需关注 |',
        '| --- | --- | --- | --- | --- | --- | --- |']);
      trends.variables.forEach(function (r) {
        body.push('| ' + r.name_zh + ' | ' + r.first + r.unit + ' | ' + r.last + r.unit +
          ' | ' + (r.delta >= 0 ? '+' : '') + r.delta + r.unit + ' | ' +
          (r.slope_per_hour >= 0 ? '+' : '') + r.slope_per_hour + ' | ' + r.direction_zh +
          ' | ' + (r.concerning === null ? '—' : (r.concerning ? '是' : '否')) + ' |');
      });
      body = body.concat(['', trends.note]);
      sections.push(['指标趋势', body]);
    }

    body = report.information_gaps.length
      ? report.information_gaps.map(function (g) { return '- ' + g.phrase_zh; })
      : ['关键检验在窗口内均已测量且未明显陈旧。'];
    sections.push(['信息缺口', body]);

    if (report.timeline.length) {
      var kindZh = { admission: '入院', onset: '病情变化', intervention: '临床干预',
        alert: '告警', measurement: '数据采集', note: '记录', handover: '交接班', error: '异常' };
      body = ['| 时间 | 类型 | 记录 | 来源 |', '| --- | --- | --- | --- |'];
      report.timeline.forEach(function (item) {
        body.push('| T+' + (item.hour || 0) + 'h | ' + (kindZh[item.kind] || item.kind) +
          ' | ' + String(item.message || '').replace(/\|/g, '／') + ' | ' +
          (item.source || '') + ' |');
      });
      sections.push(['病程观察日志', body]);
    }

    body = [];
    report.narrative.forEach(function (section) {
      body = body.concat(['### ' + section.title.replace(/^[一二三四五六七八九十]+、/, ''),
        '', section.text, '']);
    });
    sections.push(['文字结论', body]);

    sections.forEach(function (pair, index) {
      add('## ' + REPORT_NUMERALS[index] + '、' + pair[0]);
      add('');
      pair[1].forEach(function (line) { add(line); });
      add('');
    });
    add('---');
    add('');
    add('本系统输出的是风险提示，不构成医疗诊断，临床决策请遵医嘱。');
    return out.join('\n');
  }

  /* ================================================================== *
   * 十、观察日志：localStorage 持久化（一人一个键）
   * ================================================================== */
  var TL_PREFIX = 'sg.timeline.';
  var TL_INDEX = 'sg.timeline.index';

  function ls() {
    try {
      if (global.localStorage) {
        global.localStorage.setItem('sg.probe', '1');
        global.localStorage.removeItem('sg.probe');
        return global.localStorage;
      }
    } catch (e) { /* 隐私模式或禁用存储时退化为内存 */ }
    if (!global.__sgMemoryStore) {
      var mem = {};
      global.__sgMemoryStore = {
        getItem: function (k) { return mem[k] === undefined ? null : mem[k]; },
        setItem: function (k, v) { mem[k] = String(v); },
        removeItem: function (k) { delete mem[k]; },
        key: function (i) { return Object.keys(mem)[i]; },
        get length() { return Object.keys(mem).length; }
      };
    }
    return global.__sgMemoryStore;
  }

  var Timeline = {
    _read: function (patientId) {
      try {
        var raw = ls().getItem(TL_PREFIX + patientId);
        if (!raw) return { patient_id: patientId, entries: [], updated_at: null };
        var payload = JSON.parse(raw);
        if (!payload || !Array.isArray(payload.entries)) throw new Error('bad');
        payload.patient_id = payload.patient_id || patientId;
        return payload;
      } catch (e) {
        return { patient_id: patientId, entries: [], updated_at: null, corrupted: true };
      }
    },
    _write: function (patientId, payload) {
      payload.updated_at = nowString();
      payload.n_entries = payload.entries.length;
      try {
        ls().setItem(TL_PREFIX + patientId, JSON.stringify(payload));
      } catch (e) { /* 容量满时静默降级，读取仍可用 */ }
      var index = this._index();
      if (index.indexOf(patientId) < 0) {
        index.push(patientId);
        try { ls().setItem(TL_INDEX, JSON.stringify(index)); } catch (e2) { /* 忽略 */ }
      }
    },
    _index: function () {
      try {
        var raw = ls().getItem(TL_INDEX);
        var arr = raw ? JSON.parse(raw) : [];
        return Array.isArray(arr) ? arr : [];
      } catch (e) { return []; }
    },
    append: function (patientId, hour, kind, message, source, detail) {
      var payload = this._read(patientId);
      var entry = {
        seq: payload.entries.length + (payload.trimmed || 0) + 1,
        hour: (hour === null || hour === undefined) ? null : Math.round(hour),
        kind: kind || 'note', message: String(message),
        source: source || '内置仿真', at: nowString()
      };
      if (detail) entry.detail = detail;
      payload.entries.push(entry);
      if (payload.entries.length > 2000) {
        payload.trimmed = (payload.trimmed || 0) + payload.entries.length - 1000;
        payload.entries = payload.entries.slice(-1000);
      }
      this._write(patientId, payload);
      return entry;
    },
    appendMany: function (patientId, rows, source) {
      if (!rows || !rows.length) return 0;
      var payload = this._read(patientId);
      var base = payload.entries.length + (payload.trimmed || 0);
      var self = this;
      rows.forEach(function (row, i) {
        payload.entries.push({
          seq: base + i + 1,
          hour: (row.hour === null || row.hour === undefined) ? null : Math.round(row.hour),
          kind: row.kind || 'note', message: String(row.message || ''),
          source: source || row.source || '内置仿真', at: row.at || nowString()
        });
      });
      self._write(patientId, payload);
      return rows.length;
    },
    entries: function (patientId) { return this._read(patientId).entries.slice(); },
    has: function (patientId) { return this._read(patientId).entries.length > 0; },
    info: function (patientId) {
      var payload = this._read(patientId);
      var hours = payload.entries.map(function (e) { return e.hour; })
        .filter(function (h) { return h !== null && h !== undefined; });
      var kinds = {};
      payload.entries.forEach(function (e) { kinds[e.kind] = (kinds[e.kind] || 0) + 1; });
      return {
        patient_id: patientId, n_entries: payload.entries.length,
        trimmed: payload.trimmed || 0, corrupted: !!payload.corrupted,
        first_hour: hours.length ? Math.min.apply(null, hours) : null,
        last_hour: hours.length ? Math.max.apply(null, hours) : null,
        kinds: kinds, updated_at: payload.updated_at,
        last_message: payload.entries.length ? payload.entries[payload.entries.length - 1].message : null
      };
    },
    patients: function () {
      var self = this;
      return this._index().map(function (id) {
        var info = self.info(id);
        info.persisted = true;
        return info;
      }).filter(function (row) { return row.n_entries > 0; })
        .sort(function (a, b) { return String(b.updated_at || '').localeCompare(String(a.updated_at || '')); });
    },
    clear: function (patientId) {
      var existed = this._read(patientId).entries.length > 0;
      try { ls().removeItem(TL_PREFIX + patientId); } catch (e) { /* 忽略 */ }
      var index = this._index().filter(function (id) { return id !== patientId; });
      try { ls().setItem(TL_INDEX, JSON.stringify(index)); } catch (e2) { /* 忽略 */ }
      return existed;
    },
    sync: function (engine) {
      if (!engine) return { patients: 0, entries: 0 };
      var self = this, flushed = 0, count = 0;
      Object.keys(engine.patients).forEach(function (id) {
        var timeline = engine.patients[id].timeline;
        var mark = self._marks[id];
        if (mark === undefined) mark = self._read(id).entries.length;
        if (timeline.length <= mark) { self._marks[id] = timeline.length; return; }
        var added = self.appendMany(id, timeline.slice(mark), '内置仿真引擎');
        self._marks[id] = timeline.length;
        if (added) { flushed++; count += added; }
      });
      return { patients: flushed, entries: count };
    },
    _marks: {},
    stats: function () {
      var rows = this.patients();
      return {
        root: 'localStorage（浏览器本地存储）',
        patients: rows.length,
        entries: rows.reduce(function (a, r) { return a + r.n_entries; }, 0),
        trimmed: rows.reduce(function (a, r) { return a + (r.trimmed || 0); }, 0),
        corrupted_files: 0,
        max_entries_per_patient: 2000,
        backend: 'builtin'
      };
    },
    toMarkdown: function (patientId, entries, info) {
      var kindZh = { admission: '入院', onset: '病情变化', intervention: '临床干预',
        alert: '系统告警', measurement: '数据采集', note: '医护记录',
        handover: '交接班', error: '异常' };
      var out = ['# 病程观察日志 · ' + patientId, ''];
      info = info || {};
      out.push('- 生成时间：' + nowString());
      if (info.first_hour !== null && info.first_hour !== undefined) {
        out.push('- 覆盖时段：第 ' + info.first_hour + '–' + info.last_hour + ' 小时');
      }
      out.push('- 记录条数：' + entries.length);
      out.push('- 存储位置：浏览器本地存储（localStorage）');
      out.push('');
      out.push('| 时间 | 类型 | 记录 | 来源 |');
      out.push('| --- | --- | --- | --- |');
      entries.forEach(function (row) {
        out.push('| ' + (row.hour === null || row.hour === undefined ? '—' : 'T+' + row.hour + 'h') +
          ' | ' + (kindZh[row.kind] || row.kind) + ' | ' +
          String(row.message || '').replace(/\|/g, '／') + ' | ' + (row.source || '') + ' |');
      });
      out.push('');
      out.push('> 本系统输出的是风险提示，不构成医疗诊断，临床决策请遵医嘱。');
      return out.join('\n');
    }
  };

  /* ================================================================== *
   * 十一、内置实现：与后端接口同形的数据装配
   * ================================================================== */
  var Builtin = {
    _engine: null,
    _alerts: [],
    _thresholds: ALERT.fallback,
    _patients: {},          // 手动录入 / 导入的患者观测：{id: {hour: {var: val}}}
    _meta: {},              // {id: {age, gender, origin, ...}}
    lastAdvance: null,

    engine: function () { return this._engine; },

    /**
     * 确保引擎存在；不存在就按默认参数起一个。
     *
     * 为什么需要它：每个页面是独立的 JS 上下文，报告中心与观察日志页**不能**
     * 假设用户先打开过动态监护页。若不做这件事，"直接打开报告中心"会看到一个
     * 空的对象列表——又是一次"页面看起来坏了"。仿真是我们自己的，成本只有
     * 几十毫秒（100 位患者 × 24 小时），因此按需自启是更合理的选择。
     */
    ensureEngine: function () {
      if (!this._engine) {
        this._engine = new Engine({ n_patients: 100, seed: 20260214,
          mix_scenarios: true, warmup_hours: 24 });
        this._engine.advance(24);
        this._engine.scoreAll();
        Timeline.sync(this._engine);
        this.refreshAlerts();
      }
      return this._engine;
    },

    start: function (opts) {
      opts = opts || {};
      var started = Date.now();
      this._engine = new Engine(opts);
      var warmup = opts.warmup_hours === undefined ? 24 : opts.warmup_hours;
      if (warmup > 0) this._engine.advance(warmup);
      this._engine.scoreAll();
      Timeline.sync(this._engine);
      this.refreshAlerts();
      return {
        ok: true,
        summary: this._engine.summary(),
        model_ready: false,
        model_name: '内置规则评分',
        score_seconds: 0,
        warmup_hours: warmup,
        elapsed_seconds: round((Date.now() - started) / 1000, 2),
        source: 'builtin',
        note: '当前为**浏览器内置仿真**：患者队列与病程由页面自身生成，' +
          '风险分数来自公开可核对的临床偏离度规则评分（非模型输出），' +
          '不依赖任何外部服务。启动后端服务后将自动改用 LightGBM 模型产物。'
      };
    },

    advance: function (hours, rescore) {
      if (!this._engine) return { ok: false, error: '引擎未启动' };
      var started = Date.now();
      this._engine.advance(hours);
      var advanceSeconds = (Date.now() - started) / 1000;
      var added = rescore === false ? 0 : this._engine.scoreAll();
      Timeline.sync(this._engine);
      this.refreshAlerts();
      var n = Object.keys(this._engine.patients).length;
      var elapsed = Math.max((Date.now() - started) / 1000, 1e-6);
      this.lastAdvance = {
        current_hour: this._engine.current_hour(),
        max_hour: this._engine.max_hour(),
        advanced_hours: hours, patients: n, new_scores: added,
        advance_seconds: round(advanceSeconds, 3), score_seconds: 0,
        hours_per_second: round(hours * n / elapsed, 1),
        alerts_total: this._alerts.length,
        timeline_flushed: { patients: n, entries: 0 }
      };
      return Object.assign({ ok: true, source: 'builtin' }, this.lastAdvance);
    },

    seek: function (body) {
      if (!this._engine) return { ok: false, error: '引擎未启动' };
      var before = this._engine.current_hour();
      if (body.reset) this._engine.seek(0);
      else if (body.hour !== undefined && body.hour !== null) this._engine.seek(body.hour);
      else if (body.rewind_hours !== undefined) this._engine.rewind(body.rewind_hours);
      else return { ok: false, error: '需提供 hour、rewind_hours 或 reset 之一' };
      this.refreshAlerts();
      var engine = this._engine;
      return {
        ok: true, current_hour: engine.current_hour(), max_hour: engine.max_hour(),
        replaying: engine.replaying(), moved_from: before,
        moved_by: engine.current_hour() - before,
        patients: Object.keys(engine.patients).length,
        alerts_total: this._alerts.length,
        source: 'builtin',
        note: engine.replaying()
          ? '已进入回放状态：显示的是第 ' + engine.current_hour() + ' 小时的历史记录，' +
            '已生成的数据保留到第 ' + engine.max_hour() + ' 小时。'
          : '已回到最新时刻（游标处于高水位）。'
      };
    },

    state: function () {
      if (!this._engine) {
        return { running: false, model_ready: false, source: 'builtin',
          hint: '引擎未启动。' };
      }
      var s = this._engine.summary();
      s.running = true;
      s.model_ready = false;
      s.model_name = '内置规则评分';
      s.can_rewind = this._engine.current_hour() > 0;
      s.can_replay = this._engine.max_hour() > this._engine.current_hour();
      s.source = 'builtin';
      s.timeline_error = null;
      return s;
    },

    patients: function (opts) {
      opts = opts || {};
      if (!this._engine) return { patients: [], count: 0, current_hour: 0,
        max_hour: 0, replaying: false, model_ready: false, source: 'builtin' };
      var self = this;
      var thresholds = this._thresholds;
      var rows = [];
      Object.keys(this._engine.patients).forEach(function (id) {
        var patient = self._engine.patients[id];
        if (opts.scenario && patient.scenario !== opts.scenario) return;
        if (opts.course && patient.course !== opts.course) return;
        var cursor = patient.current_hour;
        var hours = Object.keys(patient.risk_history).map(Number)
          .filter(function (h) { return h <= cursor; }).sort(function (a, b) { return a - b; });
        var current = 0, peak = 0, peakHour = 0, trend = 0, spark = [];
        if (hours.length) {
          current = patient.risk_history[hours[hours.length - 1]];
          peak = Math.max.apply(null, hours.map(function (h) { return patient.risk_history[h]; }));
          peakHour = hours.reduce(function (best, h) {
            return patient.risk_history[h] > patient.risk_history[best] ? h : best;
          }, hours[0]);
          var span = Math.min(6, hours.length - 1);
          trend = span > 0 ? current - patient.risk_history[hours[hours.length - 1 - span]] : 0;
          spark = hours.slice(-48).map(function (h) { return round(patient.risk_history[h], 4); });
        }
        if (current < (opts.min_risk || 0)) return;
        var scen = SCENARIOS[patient.scenario];
        var level = levelOf(current, thresholds);
        rows.push({
          patient_id: id, bed: patient.unit, age: patient.age, gender: patient.gender,
          gender_zh: patient.gender === 1 ? '男' : '女',
          icu_los_hours: cursor,
          risk_score: round(current, 4), peak_risk_score: round(peak, 4),
          peak_hour: peakHour, risk_level: level, risk_level_zh: LEVEL_ZH[level],
          trend_delta: round(trend, 4), spark: spark,
          scenario: patient.scenario, scenario_zh: scen.name_zh,
          course: patient.course, course_zh: COURSE_ZH[patient.course],
          severity: round(patient.severity, 3),
          info_completeness: scen.info_completeness,
          confidence_discount: scen.confidence_discount,
          onset_hour: patient.onset_hour,
          has_sepsis_label: patient.onset_hour !== null && patient.onset_hour <= cursor
        });
      });
      rows.sort(function (a, b) { return b.risk_score - a.risk_score; });
      var limit = opts.limit || 1000;
      return {
        patients: rows.slice(0, limit), count: rows.length,
        current_hour: this._engine.current_hour(), max_hour: this._engine.max_hour(),
        replaying: this._engine.replaying(), model_ready: false, source: 'builtin'
      };
    },

    patient: function (id, windowHours) {
      if (!this._engine) return null;
      return this._engine.patientSnapshot(id, windowHours || 168);
    },

    events: function (limit) {
      if (!this._engine) return { alerts: [], engine_events: [], current_hour: 0 };
      return {
        alerts: this._alerts.slice(0, limit || 80),
        engine_events: this._engine.events.slice(-(limit || 80)),
        current_hour: this._engine.current_hour(), source: 'builtin'
      };
    },

    /** 从当前游标之前的风险序列重算告警（含抑制）。 */
    refreshAlerts: function () {
      if (!this._engine) return;
      var self = this;
      var cursor = this._engine.current_hour();
      var all = [];
      Object.keys(this._engine.patients).forEach(function (id) {
        var patient = self._engine.patients[id];
        var hours = Object.keys(patient.risk_history).map(Number)
          .filter(function (h) { return h <= cursor; }).sort(function (a, b) { return a - b; });
        if (!hours.length) return;
        var series = hours.map(function (h) { return patient.risk_history[h]; });
        var sup = suppress(series, self._thresholds[1], ALERT.suppression_window_hours,
          ALERT.escalation_delta, self._thresholds);
        sup.kept.forEach(function (i) {
          var level = levelOf(series[i], self._thresholds);
          all.push({
            alert_id: 'builtin-' + id + '-' + hours[i],
            patient_id: id, trigger_time: hours[i], level: level, level_zh: LEVEL_ZH[level],
            risk_score: round(series[i], 4), status: 'open',
            scenario: patient.scenario, scenario_zh: SCENARIOS[patient.scenario].name_zh,
            reason_zh: alertReason(patient.history[hours[i]] || {}),
            source: 'builtin'
          });
        });
      });
      all.sort(function (a, b) { return b.risk_score - a.risk_score; });
      this._alerts = all.slice(0, 400);
    },

    /** 手动录入：写入内置存储 + 观察日志。 */
    manualEntry: function (body) {
      var check = global.SGVars.validate(body.values || {});
      var accepted = check.accepted;
      if (body.age !== null && body.age !== undefined) accepted.Age = Number(body.age);
      if (body.gender !== null && body.gender !== undefined) accepted.Gender = Number(body.gender);
      if (!Object.keys(accepted).length) {
        return { ok: false, error: '没有任何有效指标被接受。请检查取值是否在可接受范围内。', notes: check.notes };
      }
      var id = body.patient_id;
      var hour = body.hour || 1;
      if (!this._patients[id]) this._patients[id] = {};
      this._patients[id][hour] = Object.assign(this._patients[id][hour] || {}, accepted);
      this._meta[id] = {
        age: accepted.Age, gender: accepted.Gender,
        origin: 'manual', origin_zh: '手动录入（浏览器内置存储）',
        scenario: 'manual', scenario_zh: '手工记录'
      };
      var summary = Object.keys(accepted).map(function (name) {
        var spec = global.SGVars.SPECS[name];
        return spec.label_zh + ' ' + accepted[name] + spec.unit;
      }).join('、');
      Timeline.append(id, hour, 'measurement',
        '录入第 ' + hour + ' 小时观察记录：' + summary +
        (body.note ? '。备注：' + body.note : ''), '手动录入',
        { accepted: accepted, notes: check.notes });
      if (body.note) Timeline.append(id, hour, 'note', body.note, '手动录入');
      return {
        ok: true, patient_id: id, hour: hour, accepted: accepted, notes: check.notes,
        patient_hours: Object.keys(this._patients[id]).length,
        total_patients: Object.keys(this._patients).length,
        timeline_entries: Timeline.info(id).n_entries,
        source: 'builtin'
      };
    },

    manualPatients: function () {
      var self = this;
      var rows = Object.keys(this._patients).sort().map(function (id) {
        var hoursMap = self._patients[id];
        var hours = Object.keys(hoursMap).map(Number).sort(function (a, b) { return a - b; });
        var n = 0;
        hours.forEach(function (h) { n += Object.keys(hoursMap[h]).length; });
        return { patient_id: id, n_hours: hours.length, n_values: n,
          hour_range: hours.length ? [hours[0], hours[hours.length - 1]] : [0, 0] };
      });
      return {
        patients: rows, count: rows.length,
        notes: [], source: 'builtin',
        note: '浏览器内置存储：手动录入的数据保存在本页面所在浏览器的 localStorage 中，' +
          '刷新页面后仍在，但换浏览器或清空站点数据会丢失。启动后端服务后写入服务进程。'
      };
    },

    manualClear: function (id) {
      if (!this._patients[id]) return false;
      delete this._patients[id];
      delete this._meta[id];
      Timeline.clear(id);
      return true;
    },

    /** 手动录入的患者观测（供报告使用）。 */
    manualSeries: function (id) { return this._patients[id] || null; },
    metaOf: function (id) { return this._meta[id] || {}; },

    /** 可报告对象目录。 */
    subjects: function () {
      // 报告中心可能在没打开过动态监护页的情况下被直接打开，
      // 因此这里按需自启一份仿真队列，保证"一定有东西可以出报告"。
      this.ensureEngine();
      var groups = [];
      var self = this;
      var manualItems = Object.keys(this._patients).map(function (id) {
        var hours = Object.keys(self._patients[id]).length;
        return { patient_id: id, n_hours: hours, n_values: 0, hour_range: [0, hours] };
      });
      groups.push({ origin: 'manual', origin_zh: '手动录入', count: manualItems.length, items: manualItems });

      var liveItems = [];
      if (this._engine) {
        var th = this._thresholds;
        Object.keys(this._engine.patients).forEach(function (id) {
          var p = self._engine.patients[id];
          var risks = Object.keys(p.risk_history).map(Number);
          var current = risks.length ? p.risk_history[Math.max.apply(null, risks)] : 0;
          liveItems.push({
            patient_id: id, scenario: p.scenario,
            scenario_zh: SCENARIOS[p.scenario].name_zh,
            current_hour: p.current_hour, risk_score: round(current, 4),
            risk_level: levelOf(current, th), risk_level_zh: LEVEL_ZH[levelOf(current, th)],
            course_zh: COURSE_ZH[p.course],
            has_sepsis_label: p.onset_hour !== null && p.onset_hour <= p.current_hour
          });
        });
        liveItems.sort(function (a, b) { return b.risk_score - a.risk_score; });
      }
      groups.push({ origin: 'live', origin_zh: '内置仿真后端', count: liveItems.length, items: liveItems });
      return {
        groups: groups, total: groups.reduce(function (a, g) { return a + g.count; }, 0),
        source: 'builtin'
      };
    },

    /** 生成患者报告（内置评估）。 */
    report: function (id, origin) {
      origin = origin || 'auto';
      // 手动录入
      if (origin === 'auto' || origin === 'manual') {
        var series = this.manualSeries(id);
        if (series) {
          var meta = this.metaOf(id) || {};
          var timeline = Timeline.entries(id);
          return this._assessSeries(id, series, Object.assign({}, meta, {
            timeline: timeline, origin: 'manual',
            origin_zh: '手动录入（浏览器内置存储）'
          }));
        }
        if (origin === 'manual') return null;
      }
      // 内置仿真（按需自启，使报告中心可以独立使用）
      if (origin === 'auto' || origin === 'live') {
        this.ensureEngine();
        var patient = this._engine.patients[id];
        if (patient) {
          var snapshot = this._engine.patientSnapshot(id, 100000);
          var persisted = Timeline.entries(id);
          var merged = mergeTimeline(persisted, patient.timeline, patient.current_hour);
          var scen = SCENARIOS[patient.scenario];
          return assess(id, seriesFromSnapshot(snapshot), {
            origin: 'live', origin_zh: '内置仿真后端（浏览器端）',
            age: patient.age, gender: patient.gender, unit: patient.unit,
            scenario: patient.scenario, scenario_zh: scen.name_zh,
            course_zh: COURSE_ZH[patient.course], onset_hour: patient.onset_hour,
            info_completeness: scen.info_completeness,
            confidence_discount: scen.confidence_discount,
            timeline: merged
          });
        }
        if (origin === 'live') return null;
      }
      return null;
    },

    _assessSeries: function (id, series, meta) {
      var valuesByHour = {};
      Object.keys(series).forEach(function (h) { valuesByHour[Number(h)] = series[h]; });
      return assess(id, valuesByHour, meta);
    }
  };

  /** 把患者快照的列式序列转回 {小时: {变量: 值}}。 */
  function seriesFromSnapshot(snapshot) {
    var out = {};
    snapshot.hours.forEach(function (h, i) {
      var row = {};
      Object.keys(snapshot.series).forEach(function (v) {
        var val = snapshot.series[v][i];
        if (val !== null && val !== undefined) row[v] = val;
      });
      out[h] = row;
    });
    return out;
  }

  function mergeTimeline(persisted, runtime, cursor) {
    var seen = {}, out = [];
    persisted.forEach(function (row) {
      var key = row.hour + '|' + row.kind + '|' + row.message;
      if (seen[key]) return;
      seen[key] = 1;
      out.push(Object.assign({}, row, { persisted: true }));
    });
    runtime.forEach(function (row) {
      if (row.hour !== null && row.hour !== undefined && row.hour > cursor) return;
      var key = row.hour + '|' + row.kind + '|' + row.message;
      if (seen[key]) return;
      seen[key] = 1;
      out.push(Object.assign({}, row, { persisted: false }));
    });
    out.sort(function (a, b) { return (a.hour || 0) - (b.hour || 0); });
    return out;
  }

  /* ================================================================== *
   * 十二、Bridge：页面统一入口
   * ------------------------------------------------------------------
   * 页面只调 `SGBridge.xxx()`，不直接写 fetch。模块自己决定走后端还是
   * 内置实现，并对外暴露 `mode`，界面据此显示"数据来源"。
   * ================================================================== */
  var PROTOCOL = (typeof global.location !== 'undefined' && global.location.protocol) || '';
  // 基地址策略：
  //   * 页面由后端服务提供（http/https）→ 用**相对地址**（同源），最稳；
  //   * 页面被直接双击打开（file://）→ 相对地址必然失败，此时退回默认的
  //     `http://127.0.0.1:8000`，因为后端允许跨源（CORS `*`），
  //     "双击打开页面 + 后端在跑"确实能连上；
  //   * 显式给了 `window.SEPSISGUARD_API` → 以它为准。
  var DEFAULT_LOCAL_BASE = 'http://127.0.0.1:8000';
  var API_BASE = String(
    global.SEPSISGUARD_API ||
    ((PROTOCOL === 'file:' || PROTOCOL === '') ? DEFAULT_LOCAL_BASE : '')
  ).replace(/\/+$/, '');
  var PROBE_TIMEOUT_MS = 1500;

  function isFileProtocol() {
    return typeof global.location !== 'undefined' &&
      global.location.protocol === 'file:';
  }

  /** 极简 query 解析（不依赖 URLSearchParams，file:// 下也能用）。 */
  function parseQuery(path) {
    var out = {};
    var idx = String(path).indexOf('?');
    if (idx < 0) return out;
    String(path).slice(idx + 1).split('&').forEach(function (pair) {
      if (!pair) return;
      var eq = pair.indexOf('=');
      var k = eq < 0 ? pair : pair.slice(0, eq);
      var v = eq < 0 ? '' : pair.slice(eq + 1);
      try { out[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, ' ')); }
      catch (e) { out[k] = v; }
    });
    return out;
  }

  function httpJSON(path, options) {
    options = options || {};
    var opts = {
      method: options.method || 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store'
    };
    if (options.body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(options.body);
    }
    var controller = (typeof global.AbortController === 'function')
      ? new global.AbortController() : null;
    if (controller) opts.signal = controller.signal;
    var timer = global.setTimeout(function () { if (controller) controller.abort(); },
      options.timeout || 8000);
    return global.fetch(API_BASE + path, opts).then(function (res) {
      global.clearTimeout(timer);
      return res.text().then(function (text) {
        var data = null;
        if (text) { try { data = JSON.parse(text); } catch (e) { data = { raw: text }; } }
        if (!res.ok) {
          var detail = data && (data.detail || data.error || data.reason);
          var err = new Error(detail || ('HTTP ' + res.status));
          err.status = res.status; err.payload = data; throw err;
        }
        return data;
      });
    }).catch(function (err) {
      global.clearTimeout(timer);
      throw err;
    });
  }

  var Bridge = {
    mode: 'unknown',       // server | builtin
    ready: null,
    apiBase: API_BASE,
    _listeners: [],

    onModeChange: function (fn) {
      this._listeners.push(fn);
      if (this.mode !== 'unknown') { try { fn(this.mode); } catch (e) { /* 忽略 */ } }
    },

    _setMode: function (mode) {
      if (this.mode === mode) return;
      this.mode = mode;
      var self = this;
      this._listeners.forEach(function (fn) { try { fn(mode); } catch (e) { /* 忽略 */ } });
    },

    /** 探测后端是否可用。只探一次，结果缓存。 */
    probe: function () {
      if (this.ready) return this.ready;
      var self = this;
      this.ready = new Promise(function (resolve) {
        // `file://` 下相对地址的 fetch 一定失败，因此只有在 API 基地址是
        // **绝对 http(s) 地址**时才值得一试。默认基地址就是
        // `http://127.0.0.1:8000`，而后端允许跨源（CORS `*`），
        // 所以"双击打开页面 + 后端在跑"这种情况**确实能连上后端**——
        // 早期实现一见 file:// 就直接判定内置，把这个能力丢掉了。
        var hasAbsoluteBase = /^https?:\/\//i.test(API_BASE);
        /* ---- [静态快照版 · 新增] --------------------------------------------
         * 部署在 GitHub Pages 时确定没有后端进程。直接判 builtin：省掉一次
         * 注定 404 的探测，也避免评委打开控制台看到红色报错。
         * 模式仍是 builtin（浏览器内置仿真内核），与原生版离线时完全一致。
         * ------------------------------------------------------------------ */
        if (global.SGBakedSnapshot) {
          self._setMode('builtin');
          resolve('builtin');
          return;
        }
        if (isFileProtocol() && !hasAbsoluteBase) {
          self._setMode('builtin');
          resolve('builtin');
          return;
        }
        if (typeof global.fetch !== 'function') {
          self._setMode('builtin');
          resolve('builtin');
          return;
        }
        httpJSON('/api/health', { timeout: PROBE_TIMEOUT_MS })
          .then(function () { self._setMode('server'); resolve('server'); })
          .catch(function () { self._setMode('builtin'); resolve('builtin'); });
      });
      return this.ready;
    },

    isServer: function () { return this.mode === 'server'; },
    isBuiltin: function () { return this.mode === 'builtin'; },

    /**
     * 统一调用：`mode` 为 server 时走后端，否则走内置实现。
     * `builtin` 是一个函数，接收参数返回内置结果。
     */
    call: function (path, options, builtin) {
      var self = this;
      return this.probe().then(function (mode) {
        if (mode === 'server') {
          return httpJSON(path, options).catch(function (err) {
            // 后端中途掉线：不静默吞掉，明确告知之后切换内置
            self._setMode('builtin');
            if (builtin) return builtin();
            throw err;
          });
        }
        if (!builtin) {
          var e = new Error('该功能需要后端服务（当前为浏览器内置仿真模式）');
          e.needsServer = true;
          throw e;
        }
        return Promise.resolve().then(builtin);
      });
    },

    /* ---------------- 统一路径路由 ---------------- *
     * 各页面原本直接 `fetch('/api/xxx')`。为了不改动 5 个页面里几十处调用点，
     * 这里把"路径 → Bridge 方法"的映射集中实现一次，页面只写：
     *     function request(path, options) { return SGBridge.route(path, options); }
     * 好处是路由规则只有一份，不会出现"某个页面漏了内置分支"的情况。
     */
    route: function (path, options) {
      options = options || {};
      var method = (options.method || 'GET').toUpperCase();
      var body = options.body;
      var m;

      if (path.indexOf('/api/health') === 0) return this.health();

      // ---- 真实接入（需要后端）----
      if (path.indexOf('/api/sources/sample') === 0) {
        var q = parseQuery(path);
        return this.sourceSample(q.kind || '', q.address || '', q.limit || 5);
      }
      if (path.indexOf('/api/sources/probe') === 0) return this.sourceProbe(body);
      if (path.indexOf('/api/sources/activate') === 0) return this.sourceActivate(body);
      if (path.indexOf('/api/sources/active') === 0) return this.activeSource();
      if (path.indexOf('/api/sources') === 0) return this.sources();
      if (path.indexOf('/api/ingest/webhook/stats') === 0) return this.webhookStats();

      // ---- 动态监护 ----
      if (path.indexOf('/api/live/scenarios') === 0) return this.liveScenarios();
      if (path.indexOf('/api/live/start') === 0) return this.liveStart(body);
      if (path.indexOf('/api/live/advance') === 0) {
        return this.liveAdvance(body && body.hours, body && body.rescore);
      }
      if (path.indexOf('/api/live/seek') === 0) return this.liveSeek(body);
      if (path.indexOf('/api/live/state') === 0) return this.liveState();
      if (path.indexOf('/api/live/events') === 0) {
        return this.liveEvents(parseQuery(path).limit || 80);
      }
      if ((m = path.match(/^\/api\/live\/patients\/([^?]+)(\?|$)/))) {
        return this.livePatient(decodeURIComponent(m[1]), parseQuery(path).window_hours);
      }
      if (path.indexOf('/api/live/patients') === 0) {
        var pq = parseQuery(path);
        return this.livePatients({
          limit: Number(pq.limit) || 1000, scenario: pq.scenario,
          course: pq.course, min_risk: Number(pq.min_risk) || 0
        });
      }

      // ---- 手动录入 ----
      if (path.indexOf('/api/manual/schema') === 0) return this.manualSchema();
      if (path.indexOf('/api/manual/validate') === 0) return this.manualValidate(body);
      if (path.indexOf('/api/manual/entry') === 0) return this.manualEntry(body);
      if (path.indexOf('/api/manual/patients') === 0) return this.manualPatients();
      if ((m = path.match(/^\/api\/manual\/([^?]+)$/)) && method === 'DELETE') {
        return this.manualClear(decodeURIComponent(m[1]));
      }

      // ---- 报告 ----
      if (path.indexOf('/api/report/subjects') === 0) return this.reportSubjects();
      if (path.indexOf('/api/report/assess') === 0) return this.reportAssess(body);
      if ((m = path.match(/^\/api\/report\/patient\/(.+?)\.md(\?|$)/))) {
        return this.reportMarkdown(decodeURIComponent(m[1]), parseQuery(path).origin);
      }
      if ((m = path.match(/^\/api\/report\/patient\/([^?]+)(\?|$)/))) {
        return this.reportPatient(decodeURIComponent(m[1]), parseQuery(path).origin);
      }

      // ---- 观察日志 ----
      if (path.indexOf('/api/timeline/stats') === 0) return this.timelineStats();
      if ((m = path.match(/^\/api\/timeline\/(.+?)\.md(\?|$)/))) {
        return this.timelineMarkdown(decodeURIComponent(m[1]));
      }
      if ((m = path.match(/^\/api\/timeline\/([^?]+)\/note$/))) {
        return this.timelineNote(decodeURIComponent(m[1]), body);
      }
      if ((m = path.match(/^\/api\/timeline\/([^?]+)(\?|$)/))) {
        if (method === 'DELETE') return this.timelineDelete(decodeURIComponent(m[1]));
        return this.timelineGet(decodeURIComponent(m[1]));
      }
      if (path.indexOf('/api/timeline') === 0) return this.timelineList();

      var err = new Error('未知接口：' + path);
      err.unknown = true;
      return Promise.reject(err);
    },

    /** 当前数据来源的可读标签，供各页面顶部徽标使用。 */
    modeLabel: function () {
      if (this.mode === 'server') return '后端服务已连接';
      if (this.mode === 'builtin') return '浏览器内置仿真';
      return '正在检测数据来源…';
    },

    /** 是否处于内置（无后端）模式——用于显示提示条。 */
    modeNote: function () {
      if (this.mode === 'server') return '';
      return '当前为**浏览器内置仿真**模式：患者队列、病程波动、观察日志与评估' +
        '全部由页面自身计算，不依赖任何外部服务，可离线演示。' +
        '唯一需要后端的是「数据接入」里的真实系统对接（文件 / REST / FHIR / HL7 / 推送）。';
    },

    /* ---------------- 健康与来源 ---------------- */
    health: function () {
      return this.call('/api/health', null, function () {
        return { status: 'ok', mode: 'builtin', model_version: 'builtin-rules-v1',
          model_name: '内置规则评分', patients_loaded: 0,
          source: 'builtin' };
      });
    },

    /* ---------------- 真实接入（必须后端） ---------------- */
    sources: function () {
      return this.call('/api/sources', null, function () {
        return { catalog: { active: null, sources: [] }, state: {
          active_key: null, active_source: '未接入',
          observations_cached: 0, patients_cached: 0, last_fetch_at: null,
          fetch_count: 0, last_error: null, registry_ready: false
        }, paths: [], needs_server: true,
        note: '真实后端接入需要一个服务进程去读写文件与发起网络连接，' +
              '浏览器沙箱无法完成。当前为内置仿真模式，接入功能不可用。' };
      });
    },
    sourceProbe: function (config) {
      return this.call('/api/sources/probe', { method: 'POST', body: config });
    },
    sourceActivate: function (config) {
      return this.call('/api/sources/activate', { method: 'POST', body: config });
    },
    sourceSample: function (kind, address, limit) {
      return this.call('/api/sources/sample?kind=' + encodeURIComponent(kind) +
        '&address=' + encodeURIComponent(address) + '&limit=' + (limit || 5), null);
    },
    activeSource: function () {
      return this.call('/api/sources/active', null, function () {
        return { state: { active_source: '未接入', fetch_count: 0,
          patients_cached: 0, observations_cached: 0 }, probe_history: [],
          needs_server: true };
      });
    },
    webhookStats: function () {
      return this.call('/api/ingest/webhook/stats', null, function () {
        return { buffered: 0, patients_in_buffer: 0, received_total: 0,
          by_patient: {}, recent: [], needs_server: true };
      });
    },

    /* ---------------- 动态监护（可内置） ---------------- */
    liveScenarios: function () {
      return this.call('/api/live/scenarios', null, function () {
        return { scenarios: scenarioSummary(), default: 'icu', source: 'builtin',
          note: '信息完整度 = 可测变量覆盖率 × 采样频率 × 缺失率折减，' +
                '用于提示场景的数据够不够支撑判断，不是模型性能指标。' };
      });
    },
    liveStart: function (body) {
      var self = this;
      return this.call('/api/live/start', { method: 'POST', body: body }, function () {
        return Builtin.start(body);
      });
    },
    liveAdvance: function (hours, rescore) {
      return this.call('/api/live/advance',
        { method: 'POST', body: { hours: hours, rescore: rescore !== false } },
        function () { return Builtin.advance(hours, rescore); });
    },
    liveSeek: function (body) {
      return this.call('/api/live/seek', { method: 'POST', body: body },
        function () { return Builtin.seek(body); });
    },
    liveState: function () {
      return this.call('/api/live/state', null, function () { return Builtin.state(); });
    },
    livePatients: function (opts) {
      opts = opts || {};
      var params = [];
      if (opts.limit) params.push('limit=' + opts.limit);
      if (opts.scenario) params.push('scenario=' + encodeURIComponent(opts.scenario));
      if (opts.course) params.push('course=' + encodeURIComponent(opts.course));
      if (opts.min_risk) params.push('min_risk=' + opts.min_risk);
      var path = '/api/live/patients' + (params.length ? '?' + params.join('&') : '');
      return this.call(path, null, function () { return Builtin.patients(opts); });
    },
    livePatient: function (id, windowHours) {
      return this.call('/api/live/patients/' + encodeURIComponent(id) +
        '?window_hours=' + (windowHours || 168), null,
        function () { return Builtin.patient(id, windowHours); });
    },
    liveEvents: function (limit) {
      return this.call('/api/live/events?limit=' + (limit || 80), null,
        function () { return Builtin.events(limit); });
    },

    /* ---------------- 手动录入（可内置） ---------------- */
    manualSchema: function () {
      return this.call('/api/manual/schema', null, function () {
        return global.SGVars.schema();
      });
    },
    manualValidate: function (body) {
      return this.call('/api/manual/validate', { method: 'POST', body: body },
        function () {
          var r = global.SGVars.validate(body.values || {});
          return { accepted: r.accepted, accepted_count: Object.keys(r.accepted).length,
            notes: r.notes, rejected_count: r.rejected, source: 'builtin' };
        });
    },
    manualEntry: function (body) {
      return this.call('/api/manual/entry', { method: 'POST', body: body },
        function () { return Builtin.manualEntry(body); });
    },
    manualPatients: function () {
      return this.call('/api/manual/patients', null,
        function () { return Builtin.manualPatients(); });
    },
    manualClear: function (id) {
      return this.call('/api/manual/' + encodeURIComponent(id), { method: 'DELETE' },
        function () {
          if (!Builtin.manualClear(id)) {
            var e = new Error('没有 ' + id + ' 的手动录入数据');
            e.status = 404; throw e;
          }
          return { ok: true, remaining: Object.keys(Builtin._patients).length };
        });
    },

    /* ---------------- 报告（可内置） ---------------- */
    reportSubjects: function () {
      return this.call('/api/report/subjects', null,
        function () { return Builtin.subjects(); });
    },
    reportPatient: function (id, origin) {
      return this.call('/api/report/patient/' + encodeURIComponent(id) +
        '?origin=' + encodeURIComponent(origin || 'auto'), null, function () {
          var report = Builtin.report(id, origin || 'auto');
          if (!report) {
            var e = new Error('未找到患者 ' + id + ' 的可评估记录');
            e.status = 404; throw e;
          }
          return report;
        });
    },
    /** 试算：对一份尚未入库的观测快照做评估（不写任何存储）。 */
    reportAssess: function (body) {
      return this.call('/api/report/assess', { method: 'POST', body: body },
        function () {
          var history = {};
          Object.keys(body.history || {}).forEach(function (h) {
            history[Number(h)] = Object.assign({}, body.history[h]);
          });
          var hour = body.hour || 1;
          history[hour] = Object.assign(history[hour] || {}, body.values || {});
          if (body.age !== null && body.age !== undefined) history[hour].Age = Number(body.age);
          if (body.gender !== null && body.gender !== undefined) history[hour].Gender = Number(body.gender);
          var report = assess(body.patient_id || 'PREVIEW', history, {
            origin: 'manual', origin_zh: '手动录入（试算，未入库）',
            age: body.age, gender: body.gender,
            scenario: 'manual', scenario_zh: '手工记录',
            timeline: [{ hour: hour, kind: 'note',
              message: '即时试算：本结果不写入存储，仅供录入时参考' }]
          });
          report.trial = true;
          return report;
        });
    },
    reportMarkdown: function (id, origin) {
      var self = this;
      return this.call('/api/report/patient/' + encodeURIComponent(id) +
        '.md?origin=' + encodeURIComponent(origin || 'auto'), null, function () {
          var report = Builtin.report(id, origin || 'auto');
          if (!report) {
            var e = new Error('未找到患者 ' + id + ' 的可评估记录');
            e.status = 404; throw e;
          }
          return reportToMarkdown(report);
        });
    },

    /* ---------------- 观察日志（可内置） ---------------- */
    timelineList: function () {
      return this.call('/api/timeline', null, function () {
        // 观察日志页可能在没打开过动态监护页的情况下被直接打开。
        // 日志本就来自仿真，因此按需自启一份队列并把观察日志落盘，
        // 让这一页一打开就有真实内容可看，而不是空列表。
        var engine = Builtin.ensureEngine();
        Timeline.sync(engine);
        var rows = Timeline.patients();
        return {
          patients: rows, count: rows.length,
          stats: Timeline.stats(),
          kinds: ['admission', 'onset', 'intervention', 'alert', 'measurement',
            'note', 'handover', 'error'],
          source: 'builtin'
        };
      });
    },
    timelineStats: function () {
      return this.call('/api/timeline/stats', null, function () { return Timeline.stats(); });
    },
    timelineGet: function (id) {
      return this.call('/api/timeline/' + encodeURIComponent(id), null, function () {
        var entries = Timeline.entries(id);
        var runtime = [];
        if (Builtin._engine && Builtin._engine.patients[id]) {
          runtime = Builtin._engine.patients[id].timeline;
        }
        var cursor = Builtin._engine && Builtin._engine.patients[id]
          ? Builtin._engine.patients[id].current_hour : 1e9;
        var merged = mergeTimeline(entries, runtime, cursor);
        if (!merged.length) {
          var e = new Error('未找到患者 ' + id + ' 的观察日志');
          e.status = 404; throw e;
        }
        return {
          patient_id: id, entries: merged,
          info: Object.assign(Timeline.info(id), { n_entries: merged.length }),
          runtime_only_entries: merged.filter(function (r) { return r.persisted === false; }).length,
          persisted: Timeline.has(id),
          path_hint: 'localStorage: sg.timeline.' + id,
          source: 'builtin'
        };
      });
    },
    timelineNote: function (id, body) {
      return this.call('/api/timeline/' + encodeURIComponent(id) + '/note',
        { method: 'POST', body: body }, function () {
          var entry = Timeline.append(id, body.hour, body.kind || 'note',
            body.message, '人工记录');
          return { ok: true, entry: entry, info: Timeline.info(id), source: 'builtin' };
        });
    },
    timelineDelete: function (id) {
      return this.call('/api/timeline/' + encodeURIComponent(id), { method: 'DELETE' },
        function () {
          if (!Timeline.clear(id)) {
            var e = new Error('没有 ' + id + ' 的观察日志');
            e.status = 404; throw e;
          }
          return { ok: true, remaining: Timeline.patients().length };
        });
    },
    timelineMarkdown: function (id) {
      return this.call('/api/timeline/' + encodeURIComponent(id) + '.md', null,
        function () {
          var entries = Timeline.entries(id);
          if (Builtin._engine && Builtin._engine.patients[id]) {
            entries = mergeTimeline(entries, Builtin._engine.patients[id].timeline,
              Builtin._engine.patients[id].current_hour);
          }
          if (!entries.length) {
            var e = new Error('未找到患者 ' + id + ' 的观察日志');
            e.status = 404; throw e;
          }
          return Timeline.toMarkdown(id, entries, Timeline.info(id));
        });
    }
  };

  /* ================================================================== *
   * 导出
   * ================================================================== */
  global.SGSim = {
    mulberry32: mulberry32, clamp: clamp, round: round,
    SCENARIOS: SCENARIOS, SCENARIO_ORDER: SCENARIO_ORDER,
    COURSE_ZH: COURSE_ZH, LEVEL_ZH: LEVEL_ZH,
    ACTIONS: ACTIONS, ALERT: ALERT,
    scenarioSummary: scenarioSummary,
    Engine: Engine,
    scoreHour: scoreHour,
    rulesFor: rulesFor,
    calibrate: calibrate,
    levelOf: levelOf,
    suppress: suppress,
    assess: assess,
    reportToMarkdown: reportToMarkdown,
    Timeline: Timeline,
    Builtin: Builtin
  };
  global.SGBridge = Bridge;

  // 页面加载即开始探测，使首屏能尽早知道走哪条路
  if (typeof global.setTimeout === 'function') global.setTimeout(function () { Bridge.probe(); }, 0);
})(typeof window !== 'undefined' ? window : globalThis);
