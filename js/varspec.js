/* ============================================================================
 * 哨兵 SepsisGuard —— 全部医疗指标定义（浏览器内置，共 40 项）
 * ----------------------------------------------------------------------------
 * 本文件是 `sepsisguard/config.py::VARIABLE_SPECS` 的**逐项对应实现**，放在前端
 * 的原因很直接：手动录入是"不依赖任何外部服务也要能用"的功能。如果指标定义
 * 只能从后端接口取，那么直接双击打开 `manual.html` 就什么都录不了。
 *
 * 每一项的含义：
 *   plausible  生理可能范围 —— 超出即视为录入错误，界面无法产生、校验也拒绝
 *   normal     临床常见范围 —— 绿区
 *   caution    需注意范围   —— 黄区（超出常见但仍在生理范围内，真实患者会出现）
 *   worse      true=数值越高越危险  false=越低越危险  null=无方向性
 *
 * 40 项 = 8 生命体征 + 26 实验室检验 + 4 人口学/监护 + 2 监护单元
 * ========================================================================== */
(function (global) {
  'use strict';

  /* [名称, 中文, 单位, 分组, plausible低, plausible高, normal低, normal高, worse] */
  var RAW = [
    // ---------- 生命体征（8）----------
    ['HR', '心率', '次/分', 'vital', 0, 300, 60, 100, true],
    ['O2Sat', '血氧饱和度', '%', 'vital', 0, 100, 94, 100, false],
    ['Temp', '体温', '℃', 'vital', 25, 45, 36.0, 38.0, true],
    ['SBP', '收缩压', 'mmHg', 'vital', 0, 300, 90, 140, false],
    ['MAP', '平均动脉压', 'mmHg', 'vital', 0, 250, 65, 100, false],
    ['DBP', '舒张压', 'mmHg', 'vital', 0, 200, 60, 90, false],
    ['Resp', '呼吸频率', '次/分', 'vital', 0, 80, 12, 20, true],
    ['EtCO2', '呼气末二氧化碳', 'mmHg', 'vital', 0, 100, 35, 45, false],
    // ---------- 实验室检验（26）----------
    ['BaseExcess', '碱剩余', 'mmol/L', 'lab', -30, 30, -2, 3, false],
    ['HCO3', '碳酸氢根', 'mmol/L', 'lab', 0, 60, 22, 26, false],
    ['FiO2', '吸入氧浓度', '比例', 'lab', 0, 1, 0.21, 1.0, true],
    ['pH', '酸碱度', '', 'lab', 6.5, 8.0, 7.35, 7.45, false],
    ['PaCO2', '动脉二氧化碳分压', 'mmHg', 'lab', 0, 150, 35, 45, true],
    ['SaO2', '动脉血氧饱和度', '%', 'lab', 0, 100, 94, 100, false],
    ['AST', '谷草转氨酶', 'IU/L', 'lab', 0, 10000, 0, 40, true],
    ['BUN', '尿素氮', 'mg/dL', 'lab', 0, 200, 6, 20, true],
    ['Alkalinephos', '碱性磷酸酶', 'IU/L', 'lab', 0, 5000, 40, 150, true],
    ['Calcium', '钙', 'mg/dL', 'lab', 0, 20, 8.5, 10.5, false],
    ['Chloride', '氯', 'mmol/L', 'lab', 0, 200, 98, 107, false],
    ['Creatinine', '肌酐', 'mg/dL', 'lab', 0, 50, 0.5, 1.2, true],
    ['Bilirubin_direct', '直接胆红素', 'mg/dL', 'lab', 0, 50, 0, 0.3, true],
    ['Glucose', '血糖', 'mg/dL', 'lab', 0, 1000, 70, 140, true],
    ['Lactate', '乳酸', 'mmol/L', 'lab', 0, 50, 0.5, 2.0, true],
    ['Magnesium', '镁', 'mmol/L', 'lab', 0, 10, 1.7, 2.2, false],
    ['Phosphate', '磷酸盐', 'mg/dL', 'lab', 0, 20, 2.5, 4.5, false],
    ['Potassium', '钾', 'mmol/L', 'lab', 0, 15, 3.5, 5.0, false],
    ['Bilirubin_total', '总胆红素', 'mg/dL', 'lab', 0, 100, 0, 1.2, true],
    ['TroponinI', '肌钙蛋白I', 'ng/mL', 'lab', 0, 100, 0, 0.04, true],
    ['Hct', '红细胞压积', '%', 'lab', 0, 80, 36, 50, false],
    ['Hgb', '血红蛋白', 'g/dL', 'lab', 0, 25, 12, 17, false],
    ['PTT', '部分凝血活酶时间', '秒', 'lab', 0, 200, 25, 35, true],
    ['WBC', '白细胞计数', '10³/µL', 'lab', 0, 200, 4, 12, true],
    ['Fibrinogen', '纤维蛋白原', 'mg/dL', 'lab', 0, 1500, 200, 400, true],
    ['Platelets', '血小板计数', '10³/µL', 'lab', 0, 1000, 150, 400, false],
    // ---------- 人口学与监护（6）----------
    ['Age', '年龄', '岁', 'demo', 0, 120, 18, 90, true],
    ['Gender', '性别', '', 'demo', 0, 1, 0, 1, null],
    ['HospAdmTime', '入院至入监护单元的时间', '小时', 'demo', -24, 336, null, null, null],
    ['ICULOS', '已监护时长', '小时', 'demo', 1, 336, null, null, null],
    ['Unit1', '监护单元类型（内科 MICU）', '', 'admin', 0, 1, null, null, null],
    ['Unit2', '外科监护单元（SICU）', '', 'admin', 0, 1, null, null, null]
  ];

  /* 无连续区间的字段需要显式给出界面呈现方式与提示语。
     这些覆盖与后端 `service/ingest_api.py::manual_schema` 的 overrides 一致。 */
  var OVERRIDES = {
    ICULOS: {
      hint: '本次监护已经历的小时数。模型最重要的单个特征，务必填写。',
      step: 1, def: 1
    },
    HospAdmTime: {
      hint: '可为负值：负数表示入监护单元后才办理入院登记（数据集的原始口径）。',
      step: 0.5, def: 0
    },
    Unit1: {
      options: [{ value: 0, label: '否' }, { value: 1, label: '是' }],
      hint: '该患者是否位于内科监护单元。两项都选"否"表示普通单元。',
      step: 1, def: 0
    },
    Unit2: {
      options: [{ value: 0, label: '否' }, { value: 1, label: '是' }],
      hint: '与上一项互斥；同一患者不应同时属于内科与外科监护单元。',
      step: 1, def: 0
    },
    Gender: {
      options: [{ value: 0, label: '女' }, { value: 1, label: '男' }],
      step: 1, def: 0
    },
    Age: { step: 1, def: 65 },
    FiO2: { step: 0.01 }
  };

  var GROUPS = [
    { key: 'vital', name_zh: '生命体征', description: '床旁可测得的基础指标，反映即时生理状态' },
    { key: 'lab', name_zh: '实验室检验', description: '血液、生化与血气分析，反映器官功能与感染状态' },
    { key: 'demo', name_zh: '基本信息', description: '年龄、性别与监护时长' },
    { key: 'admin', name_zh: '监护信息', description: '监护单元类型。这些字段在模型特征里权重不低，缺填会使分数无法与真实接入的结果对齐' }
  ];

  /** 步长由**生效后的**生理范围决定；显式给出 step 时优先。 */
  function stepFor(override, plausible) {
    if (override.step !== undefined) return override.step;
    var hi = plausible[1];
    if (hi > 200) return 1;
    if (hi > 20) return 0.1;
    return 0.01;
  }

  var SPECS = {};
  RAW.forEach(function (row) {
    var name = row[0];
    var normalLow = row[6];
    var normalHigh = row[7];
    var plausible = [row[4], row[5]];
    var span = (normalLow !== null && normalHigh !== null)
      ? (normalHigh - normalLow)
      : Math.max(Math.abs(plausible[1] - plausible[0]) * 0.15, 1);
    var override = OVERRIDES[name] || {};
    var spec = {
      name: name,
      label_zh: row[1],
      unit: row[2],
      group: row[3],
      plausible: override.plausible || plausible,
      normal: [normalLow, normalHigh],
      caution: (normalLow === null || normalHigh === null) ? [null, null] : [
        round4(normalLow - span * 0.5),
        round4(normalHigh + span * 0.5)
      ],
      higher_is_worse: row[8],
      step: stepFor(override, override.plausible || plausible),
      default: (override.def !== undefined) ? override.def
        : ((normalLow === null || normalHigh === null) ? null
           : round4((normalLow + normalHigh) / 2))
    };
    if (override.options) spec.options = override.options;
    if (override.hint) spec.hint = override.hint;
    SPECS[name] = spec;
  });

  function round4(v) { return Math.round(v * 10000) / 10000; }

  /* 判定某个值处于哪一档：normal / caution / abnormal / unrated / empty */
  function classify(variable, value) {
    var spec = SPECS[variable];
    if (!spec) return 'unrated';
    if (value === null || value === undefined || value === '' || !isFinite(Number(value))) {
      return 'empty';
    }
    var v = Number(value);
    if (v < spec.plausible[0] || v > spec.plausible[1]) return 'rejected';
    if (spec.normal[0] === null || spec.normal[1] === null) return 'unrated';
    if (v >= spec.normal[0] && v <= spec.normal[1]) return 'normal';
    if (v >= spec.caution[0] && v <= spec.caution[1]) return 'caution';
    return 'abnormal';
  }

  /* 校验一组录入值：返回 {accepted, notes}
     规则与后端 `_validate_manual` 一致：超出 plausible 拒绝，超出 normal 提示。 */
  function validate(values) {
    var accepted = {};
    var notes = [];
    Object.keys(values || {}).forEach(function (name) {
      var spec = SPECS[name];
      if (!spec) { notes.push('未知指标「' + name + '」，已忽略'); return; }
      var raw = values[name];
      if (raw === null || raw === undefined || raw === '') return;
      var v = Number(raw);
      if (!isFinite(v)) { notes.push('「' + spec.label_zh + '」不是数值，已忽略'); return; }
      if (v < spec.plausible[0] || v > spec.plausible[1]) {
        notes.push('「' + spec.label_zh + '」' + v + ' 超出可接受范围 [' +
          spec.plausible[0] + ', ' + spec.plausible[1] + ']，已忽略');
        return;
      }
      if (spec.normal[0] !== null && (v < spec.normal[0] || v > spec.normal[1])) {
        notes.push('「' + spec.label_zh + '」' + v + spec.unit + ' 超出常见范围 [' +
          spec.normal[0] + ', ' + spec.normal[1] + ']，请确认');
      }
      accepted[name] = v;
    });
    return { accepted: accepted, notes: notes, rejected: Object.keys(values || {}).length - Object.keys(accepted).length };
  }

  /** 生成手动录入界面所需的字段定义（与后端 /api/manual/schema 同形）。 */
  function schema() {
    var fields = Object.keys(SPECS).map(function (name) {
      var s = SPECS[name];
      var field = {
        name: s.name, name_zh: s.label_zh, unit: s.unit, group: s.group,
        normal: s.normal.slice(), caution: s.caution.slice(),
        plausible: s.plausible.slice(), step: s.step,
        higher_is_worse: s.higher_is_worse, default: s.default
      };
      if (s.options) field.options = s.options;
      if (s.hint) field.hint = s.hint;
      return field;
    });
    var names = fields.map(function (f) { return f.name; });
    var duplicated = names.filter(function (n, i) { return names.indexOf(n) !== i; });
    return {
      fields: fields,
      groups: GROUPS.slice(),
      total_fields: fields.length,
      covered_variables: names.length,
      expected_variables: names.length,
      uncovered_variables: [],
      duplicated_variables: Array.from(new Set(duplicated)),
      source: 'builtin',
      note: '滑条范围对应生理可能取值区间；绿色为临床常见范围，黄色提示需注意，' +
            '红色为明显异常。超出区间的输入会被拒绝并给出提示。' +
            '下拉框字段（性别、监护单元）没有连续区间，因此不显示分区底色。'
    };
  }

  global.SGVars = {
    RAW: RAW,
    SPECS: SPECS,
    GROUPS: GROUPS,
    ORDER: RAW.map(function (r) { return r[0]; }),
    COUNT: RAW.length,
    classify: classify,
    validate: validate,
    schema: schema
  };
})(typeof window !== 'undefined' ? window : globalThis);
