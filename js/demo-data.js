/* ============================================================================
 * 哨兵 SepsisGuard —— 内置离线演示数据（demo-data.js）
 * ----------------------------------------------------------------------------
 * 用途：当后端服务不可用（fetch 失败或返回非 2xx）时，前端自动切换到本文件
 *       提供的数据，保证界面在任何环境下都能完整演示。
 *
 * 说明：
 *   1. 全部病例均为手工设计的仿真病例，变量口径参考 PhysioNet/CinC Challenge
 *      2019 数据集（HR / SBP / Resp / O2Sat / Temp / Lactate / WBC / Creatinine）。
 *   2. 时序中的缺失值统一为 null（不使用 NaN），以模拟真实临床数据中的
 *      "监护仪脱落""实验室未开单"等缺失模式。
 *   3. 每位患者的风险曲线由手工标注的关键帧线性插值得到，形态可控、可解释。
 *   4. 本文件不依赖任何第三方库，纯 ES2020 语法。
 * ========================================================================== */
(function (global) {
  'use strict';

  /* ------------------------------------------------------------------ *
   * 一、基础字典
   * ------------------------------------------------------------------ */

  // 变量中文名与单位
  var VARIABLE_ZH = {
    HR: { name: '心率', unit: '次/分' },
    SBP: { name: '收缩压', unit: 'mmHg' },
    Resp: { name: '呼吸频率', unit: '次/分' },
    O2Sat: { name: '血氧饱和度', unit: '%' },
    Temp: { name: '体温', unit: '℃' },
    Lactate: { name: '乳酸', unit: 'mmol/L' },
    WBC: { name: '白细胞计数', unit: '10³/µL' },
    Creatinine: { name: '肌酐', unit: 'mg/dL' }
  };

  // 临床参考区间（下限 / 上限），用于图表归一化与雷达偏离度计算
  var REF = {
    HR: [60, 100],
    SBP: [90, 140],
    Resp: [12, 20],
    O2Sat: [95, 100],
    Temp: [36.1, 37.5],
    Lactate: [0.5, 2.0],
    WBC: [4, 12],
    Creatinine: [0.5, 1.2]
  };

  // 风险等级判定阈值（与后端保持一致：high ≥0.65，medium ≥0.40，low ≥0.20）
  var LEVEL_RULES = [
    { level: 'high', zh: '高风险', min: 0.65 },
    { level: 'medium', zh: '中风险', min: 0.40 },
    { level: 'low', zh: '低风险', min: 0.20 },
    { level: 'normal', zh: '正常', min: -1 }
  ];

  /* ------------------------------------------------------------------ *
   * 二、手工构造的病例档案（12 位）
   *   riskKeys  : 风险曲线关键帧 [小时, 风险值]
   *   gaps      : 监护仪缺失窗口（含首尾小时，闭区间）
   *   labs      : 实验室指标采样间隔（小时）与停止采样小时
   * ------------------------------------------------------------------ */
  var PROFILES = [
    {
      id: 'p000001', bed: 'ICU-03', age: 83, gender: 0, los: 55,
      sepsis: true, onset: 48,
      base: { HR: 96, SBP: 104, Resp: 21, O2Sat: 95, Temp: 37.2, Lactate: 1.8, WBC: 13.5, Creatinine: 1.3 },
      drift: { HR: 30, SBP: -26, Resp: 9, O2Sat: -4, Temp: 1.0, Lactate: 3.2, WBC: 6.5, Creatinine: 0.9 },
      declineFrom: 26, ramp: 20, seed: 1011,
      gaps: { HR: [[2, 3]], O2Sat: [[13, 15]], Temp: [[31, 32]] },
      labs: { Lactate: 8, WBC: 12, Creatinine: 12, stopLactateAfter: 40 },
      riskKeys: [[1, 0.11], [12, 0.19], [26, 0.33], [36, 0.49], [43, 0.82], [52, 0.90], [55, 0.82]],
      alerts: [
        { at: 43, level: 'high', status: 'open', reason_zh: '休克指数上升，是本次风险升高的主要原因' },
        { at: 50, level: 'high', status: 'acknowledged', reason_zh: '乳酸持续升高伴血压下降，提示组织灌注不足' }
      ],
      features: [
        { feature: 'shock_index', name_zh: '休克指数', direction: 'up', contribution: 0.18, phrase_zh: '休克指数上升，是本次风险升高的主要原因' },
        { feature: 'Lactate', name_zh: '乳酸', direction: 'up', contribution: 0.15, phrase_zh: '乳酸由 2.9 mmol/L 升至 4.6 mmol/L，提示组织灌注不足' },
        { feature: 'SBP', name_zh: '收缩压', direction: 'down', contribution: 0.12, phrase_zh: '收缩压由 118 mmHg 降至 92 mmHg，血压呈下降趋势' },
        { feature: 'Resp', name_zh: '呼吸频率', direction: 'up', contribution: 0.07, phrase_zh: '呼吸频率升至 26 次/分，呼吸做功增加' }
      ],
      infoGaps: [
        { variable: 'Lactate', name_zh: '乳酸', phrase_zh: '乳酸最近一次测量在第 40 小时，之后未再复测，补充检测可提升判断置信度' },
        { variable: 'Temp', name_zh: '体温', phrase_zh: '体温在第 31~32 小时无记录，补齐数据可提升判断置信度' }
      ]
    },
    {
      id: 'p000002', bed: 'ICU-07', age: 71, gender: 1, los: 62,
      sepsis: true, onset: 56,
      base: { HR: 88, SBP: 112, Resp: 19, O2Sat: 96, Temp: 37.0, Lactate: 1.5, WBC: 11.0, Creatinine: 1.1 },
      drift: { HR: 28, SBP: -20, Resp: 8, O2Sat: -5, Temp: 1.4, Lactate: 2.4, WBC: 9.0, Creatinine: 0.6 },
      declineFrom: 34, ramp: 22, seed: 2022,
      gaps: { HR: [[18, 19]], O2Sat: [[40, 42]], Resp: [[7, 8]], SBP: [[44, 45]] },
      labs: { Lactate: 10, WBC: 12, Creatinine: 12, stopLactateAfter: 50 },
      riskKeys: [[1, 0.14], [16, 0.22], [32, 0.30], [44, 0.52], [52, 0.71], [58, 0.80], [62, 0.76]],
      alerts: [
        { at: 52, level: 'high', status: 'open', reason_zh: '体温升高合并白细胞上升，感染相关风险增加' },
        { at: 58, level: 'high', status: 'snoozed', reason_zh: '肌酐上升提示肾功能受累，需复查肾功能与尿量' }
      ],
      features: [
        { feature: 'Temp', name_zh: '体温', direction: 'up', contribution: 0.17, phrase_zh: '体温升至 38.8 ℃，发热加重提示感染进展' },
        { feature: 'HR', name_zh: '心率', direction: 'up', contribution: 0.14, phrase_zh: '心率由 88 次/分升至 118 次/分，心率增快' },
        { feature: 'WBC', name_zh: '白细胞计数', direction: 'up', contribution: 0.11, phrase_zh: '白细胞计数升至 19.4 10³/µL，炎症指标升高' },
        { feature: 'Creatinine', name_zh: '肌酐', direction: 'up', contribution: 0.08, phrase_zh: '肌酐上升 0.6 mg/dL，提示肾功能呈下降趋势' }
      ],
      infoGaps: [
        { variable: 'Lactate', name_zh: '乳酸', phrase_zh: '乳酸最近一次测量在第 50 小时，之后未再复测，补充检测可提升判断置信度' },
        { variable: 'pH', name_zh: '酸碱度', phrase_zh: '血气分析未记录，缺少酸碱状态信息，补充检测可提升判断置信度' }
      ]
    },
    {
      id: 'p000003', bed: 'ICU-01', age: 64, gender: 1, los: 52,
      sepsis: false, onset: null,
      base: { HR: 92, SBP: 118, Resp: 20, O2Sat: 96, Temp: 37.1, Lactate: null, WBC: 10.2, Creatinine: 1.0 },
      drift: { HR: 22, SBP: -12, Resp: 7, O2Sat: -3, Temp: 0.6, Lactate: 0, WBC: 5.5, Creatinine: 0.3 },
      declineFrom: 22, ramp: 18, seed: 3033,
      gaps: { HR: [[9, 10]], Temp: [[24, 26]], O2Sat: [[33, 34]], SBP: [[18, 19]] },
      // 该患者全程未开乳酸医嘱 → 形成典型的"信息缺口"
      labs: { Lactate: 0, WBC: 12, Creatinine: 12, stopLactateAfter: 0 },
      riskKeys: [[1, 0.16], [14, 0.24], [26, 0.38], [36, 0.58], [44, 0.70], [49, 0.66], [52, 0.68]],
      alerts: [
        { at: 44, level: 'high', status: 'open', reason_zh: '呼吸频率与心率同时上升，虽无发热但需警惕非典型感染' },
        { at: 49, level: 'medium', status: 'acknowledged', reason_zh: '术后炎症反应，已结合临床判断为术后常见表现' }
      ],
      features: [
        { feature: 'Resp', name_zh: '呼吸频率', direction: 'up', contribution: 0.16, phrase_zh: '呼吸频率升至 27 次/分，呼吸做功增加' },
        { feature: 'HR', name_zh: '心率', direction: 'up', contribution: 0.13, phrase_zh: '心率由 92 次/分升至 114 次/分，心率增快' },
        { feature: 'WBC', name_zh: '白细胞计数', direction: 'up', contribution: 0.09, phrase_zh: '白细胞计数轻度升高至 15.7 10³/µL' }
      ],
      infoGaps: [
        { variable: 'Lactate', name_zh: '乳酸', phrase_zh: '乳酸未测量，补充检测可提升判断置信度' },
        { variable: 'Temp', name_zh: '体温', phrase_zh: '体温在第 24~26 小时无记录，补齐数据可提升判断置信度' }
      ]
    },
    {
      id: 'p000004', bed: 'ICU-05', age: 58, gender: 0, los: 71,
      sepsis: false, onset: null,
      base: { HR: 84, SBP: 126, Resp: 18, O2Sat: 97, Temp: 36.9, Lactate: 1.4, WBC: 9.4, Creatinine: 0.9 },
      drift: { HR: 13, SBP: -9, Resp: 4, O2Sat: -2, Temp: 0.7, Lactate: 1.1, WBC: 3.4, Creatinine: 0.2 },
      declineFrom: 40, ramp: 24, seed: 4044,
      gaps: { O2Sat: [[20, 21]], HR: [[55, 56]], Temp: [[44, 45]] },
      labs: { Lactate: 12, WBC: 12, Creatinine: 12, stopLactateAfter: 71 },
      riskKeys: [[1, 0.13], [24, 0.21], [44, 0.36], [58, 0.48], [66, 0.54], [71, 0.52]],
      alerts: [
        { at: 58, level: 'medium', status: 'open', reason_zh: '乳酸轻度上升合并血压下降，需复查灌注指标' }
      ],
      features: [
        { feature: 'Lactate', name_zh: '乳酸', direction: 'up', contribution: 0.14, phrase_zh: '乳酸由 1.4 mmol/L 升至 2.6 mmol/L，轻度升高' },
        { feature: 'SBP', name_zh: '收缩压', direction: 'down', contribution: 0.10, phrase_zh: '收缩压由 126 mmHg 降至 112 mmHg，血压呈下降趋势' }
      ],
      infoGaps: [
        { variable: 'Temp', name_zh: '体温', phrase_zh: '体温在第 44~45 小时无记录，补齐数据可提升判断置信度' }
      ]
    },
    {
      id: 'p000005', bed: 'ICU-09', age: 76, gender: 0, los: 66,
      sepsis: true, onset: 60,
      base: { HR: 80, SBP: 120, Resp: 17, O2Sat: 96, Temp: 36.8, Lactate: 1.3, WBC: 8.8, Creatinine: 1.0 },
      drift: { HR: 20, SBP: -18, Resp: 6, O2Sat: -3, Temp: 0.9, Lactate: 1.8, WBC: 4.6, Creatinine: 0.5 },
      declineFrom: 38, ramp: 22, seed: 5055,
      gaps: { HR: [[28, 29]], O2Sat: [[48, 50]], Resp: [[60, 61]] },
      labs: { Lactate: 8, WBC: 12, Creatinine: 12, stopLactateAfter: 58 },
      riskKeys: [[1, 0.10], [20, 0.18], [38, 0.26], [50, 0.36], [58, 0.50], [63, 0.58], [66, 0.47]],
      alerts: [
        { at: 58, level: 'medium', status: 'open', reason_zh: '血压下降合并乳酸上升，风险由低转为中等' }
      ],
      features: [
        { feature: 'SBP', name_zh: '收缩压', direction: 'down', contribution: 0.13, phrase_zh: '收缩压由 120 mmHg 降至 98 mmHg，血压呈下降趋势' },
        { feature: 'Lactate', name_zh: '乳酸', direction: 'up', contribution: 0.11, phrase_zh: '乳酸由 1.3 mmol/L 升至 2.8 mmol/L，轻度升高' },
        { feature: 'Resp', name_zh: '呼吸频率', direction: 'up', contribution: 0.06, phrase_zh: '呼吸频率升至 23 次/分，呼吸做功增加' }
      ],
      infoGaps: [
        { variable: 'Lactate', name_zh: '乳酸', phrase_zh: '乳酸最近一次测量在第 58 小时，之后未再复测，补充检测可提升判断置信度' }
      ]
    },
    {
      id: 'p000006', bed: 'ICU-12', age: 45, gender: 1, los: 48,
      sepsis: false, onset: null,
      base: { HR: 78, SBP: 122, Resp: 16, O2Sat: 98, Temp: 36.7, Lactate: 1.1, WBC: 7.9, Creatinine: 0.8 },
      drift: { HR: 12, SBP: -8, Resp: 5, O2Sat: -2, Temp: 0.6, Lactate: 0.9, WBC: 3.0, Creatinine: 0.2 },
      declineFrom: 20, ramp: 20, seed: 6066,
      gaps: { O2Sat: [[11, 12]], Temp: [[36, 37]] },
      labs: { Lactate: 12, WBC: 12, Creatinine: 12, stopLactateAfter: 48 },
      riskKeys: [[1, 0.09], [16, 0.15], [30, 0.22], [40, 0.34], [46, 0.44], [48, 0.42]],
      alerts: [
        { at: 46, level: 'medium', status: 'ignored', reason_zh: '数据异常：监护仪袖带松动导致的血压伪低值，已由护士核对' }
      ],
      features: [
        { feature: 'Resp', name_zh: '呼吸频率', direction: 'up', contribution: 0.10, phrase_zh: '呼吸频率升至 21 次/分，略高于参考区间' },
        { feature: 'HR', name_zh: '心率', direction: 'up', contribution: 0.08, phrase_zh: '心率由 78 次/分升至 90 次/分，轻度增快' }
      ],
      infoGaps: [
        { variable: 'Temp', name_zh: '体温', phrase_zh: '体温在第 36~37 小时无记录，补齐数据可提升判断置信度' }
      ]
    },
    {
      id: 'p000007', bed: 'ICU-02', age: 69, gender: 1, los: 78,
      sepsis: false, onset: null,
      base: { HR: 74, SBP: 128, Resp: 16, O2Sat: 97, Temp: 36.6, Lactate: 1.2, WBC: 8.2, Creatinine: 1.1 },
      drift: { HR: 8, SBP: -6, Resp: 3, O2Sat: -1, Temp: 0.4, Lactate: 0.7, WBC: 2.2, Creatinine: 0.3 },
      declineFrom: 46, ramp: 26, seed: 7077,
      gaps: { HR: [[34, 35]], O2Sat: [[62, 63]], Temp: [[70, 71]] },
      labs: { Lactate: 12, WBC: 12, Creatinine: 12, stopLactateAfter: 78 },
      riskKeys: [[1, 0.07], [30, 0.12], [52, 0.18], [68, 0.25], [76, 0.30], [78, 0.29]],
      alerts: [],
      features: [
        { feature: 'Creatinine', name_zh: '肌酐', direction: 'up', contribution: 0.09, phrase_zh: '肌酐缓慢上升 0.3 mg/dL，需关注肾功能变化' }
      ],
      infoGaps: [
        { variable: 'Lactate', name_zh: '乳酸', phrase_zh: '乳酸每 12 小时复测一次，末次测量距今 6 小时，结果尚未回报' }
      ]
    },
    {
      id: 'p000008', bed: 'ICU-08', age: 52, gender: 0, los: 49,
      sepsis: false, onset: null,
      base: { HR: 82, SBP: 116, Resp: 18, O2Sat: 97, Temp: 36.9, Lactate: 1.5, WBC: 9.0, Creatinine: 0.9 },
      drift: { HR: 7, SBP: -5, Resp: 2, O2Sat: -1, Temp: 0.3, Lactate: 0.5, WBC: 1.8, Creatinine: 0.2 },
      declineFrom: 30, ramp: 18, seed: 8088,
      gaps: { O2Sat: [[5, 6]], HR: [[40, 41]] },
      labs: { Lactate: 10, WBC: 12, Creatinine: 12, stopLactateAfter: 49 },
      riskKeys: [[1, 0.08], [18, 0.13], [32, 0.18], [44, 0.24], [49, 0.24]],
      alerts: [],
      features: [
        { feature: 'HR', name_zh: '心率', direction: 'up', contribution: 0.07, phrase_zh: '心率在夜间轻度升高，尚在可接受范围' }
      ],
      infoGaps: [
        { variable: 'O2Sat', name_zh: '血氧饱和度', phrase_zh: '血氧饱和度在第 5~6 小时无记录，补齐数据可提升判断置信度' }
      ]
    },
    {
      id: 'p000009', bed: 'ICU-11', age: 37, gender: 1, los: 51,
      sepsis: false, onset: null,
      base: { HR: 76, SBP: 124, Resp: 16, O2Sat: 98, Temp: 36.7, Lactate: 1.0, WBC: 7.2, Creatinine: 0.8 },
      drift: { HR: 9, SBP: -4, Resp: 3, O2Sat: -1, Temp: 0.4, Lactate: 0.6, WBC: 2.6, Creatinine: 0.2 },
      declineFrom: 34, ramp: 16, seed: 9099,
      gaps: { Temp: [[22, 23]], Resp: [[44, 45]] },
      labs: { Lactate: 12, WBC: 12, Creatinine: 12, stopLactateAfter: 51 },
      riskKeys: [[1, 0.06], [20, 0.11], [36, 0.17], [46, 0.26], [51, 0.28]],
      alerts: [],
      features: [
        { feature: 'Resp', name_zh: '呼吸频率', direction: 'up', contribution: 0.08, phrase_zh: '呼吸频率较入科时上升 4 次/分' }
      ],
      infoGaps: [
        { variable: 'Temp', name_zh: '体温', phrase_zh: '体温在第 22~23 小时无记录，补齐数据可提升判断置信度' }
      ]
    },
    {
      id: 'p000010', bed: 'ICU-04', age: 61, gender: 0, los: 58,
      sepsis: false, onset: null,
      base: { HR: 72, SBP: 122, Resp: 15, O2Sat: 98, Temp: 36.6, Lactate: 1.1, WBC: 7.0, Creatinine: 0.9 },
      drift: { HR: 4, SBP: -3, Resp: 2, O2Sat: 0, Temp: 0.2, Lactate: 0.3, WBC: 1.2, Creatinine: 0.1 },
      declineFrom: 44, ramp: 14, seed: 1010,
      gaps: { HR: [[50, 51]], O2Sat: [[28, 29]] },
      labs: { Lactate: 12, WBC: 12, Creatinine: 12, stopLactateAfter: 58 },
      riskKeys: [[1, 0.05], [24, 0.08], [44, 0.11], [58, 0.12]],
      alerts: [],
      features: [],
      infoGaps: []
    },
    {
      id: 'p000011', bed: 'ICU-06', age: 48, gender: 1, los: 50,
      sepsis: false, onset: null,
      base: { HR: 70, SBP: 118, Resp: 15, O2Sat: 98, Temp: 36.5, Lactate: 0.9, WBC: 6.6, Creatinine: 0.8 },
      drift: { HR: 3, SBP: -2, Resp: 1, O2Sat: 0, Temp: 0.2, Lactate: 0.2, WBC: 0.9, Creatinine: 0.1 },
      declineFrom: 40, ramp: 10, seed: 1111,
      gaps: { Temp: [[12, 13]] },
      labs: { Lactate: 12, WBC: 12, Creatinine: 12, stopLactateAfter: 50 },
      riskKeys: [[1, 0.04], [20, 0.06], [38, 0.08], [50, 0.07]],
      alerts: [],
      features: [],
      infoGaps: []
    },
    {
      id: 'p000012', bed: 'ICU-10', age: 55, gender: 0, los: 64,
      sepsis: false, onset: null,
      base: { HR: 74, SBP: 120, Resp: 16, O2Sat: 97, Temp: 36.7, Lactate: 1.2, WBC: 7.6, Creatinine: 0.9 },
      drift: { HR: 5, SBP: -4, Resp: 2, O2Sat: -1, Temp: 0.3, Lactate: 0.4, WBC: 1.6, Creatinine: 0.2 },
      declineFrom: 48, ramp: 16, seed: 1212,
      gaps: { O2Sat: [[40, 41]], HR: [[58, 59]] },
      labs: { Lactate: 12, WBC: 12, Creatinine: 12, stopLactateAfter: 64 },
      riskKeys: [[1, 0.06], [28, 0.10], [48, 0.14], [62, 0.17], [64, 0.16]],
      alerts: [],
      features: [],
      infoGaps: []
    }
  ];

  /* ------------------------------------------------------------------ *
   * 三、工具函数
   * ------------------------------------------------------------------ */

  // 确定性伪随机数（保证每次刷新演示数据一致，便于复核复现）
  function mulberry32(a) {
    return function () {
      a |= 0;
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function r1(v) { return Math.round(v * 10) / 10; }
  function r2(v) { return Math.round(v * 100) / 100; }

  function levelOf(score) {
    for (var i = 0; i < LEVEL_RULES.length; i++) {
      if (score >= LEVEL_RULES[i].min) return LEVEL_RULES[i];
    }
    return LEVEL_RULES[LEVEL_RULES.length - 1];
  }

  // 线性插值风险关键帧
  function interpKeys(keys, h) {
    if (h <= keys[0][0]) return keys[0][1];
    for (var i = 1; i < keys.length; i++) {
      if (h <= keys[i][0]) {
        var a = keys[i - 1], b = keys[i];
        var span = (b[0] - a[0]) || 1;
        return a[1] + (b[1] - a[1]) * ((h - a[0]) / span);
      }
    }
    return keys[keys.length - 1][1];
  }

  // 疾病进展因子：0（基线）→ 1（最重）
  function progressAt(p, h) {
    if (h <= p.declineFrom) return 0;
    return clamp((h - p.declineFrom) / p.ramp, 0, 1);
  }

  /* ------------------------------------------------------------------ *
   * 四、时序构造
   * ------------------------------------------------------------------ */

  function buildTimeseries(p) {
    var rng = mulberry32(p.seed);
    var n = p.los;
    var hours = [];
    var vars = { HR: [], SBP: [], Resp: [], O2Sat: [], Temp: [], Lactate: [], WBC: [], Creatinine: [] };

    // 判断第 h 小时是否落在手工标注的缺失窗口内
    function inGap(name, h) {
      var wins = p.gaps[name];
      if (!wins) return false;
      for (var i = 0; i < wins.length; i++) {
        if (h >= wins[i][0] && h <= wins[i][1]) return true;
      }
      return false;
    }

    // 场景采样节律：普通病房每 4 小时、养老机构每 8 小时、术后每 6 小时。
    // 非采样时点为 null（真实缺失），这样"场景越稀薄，曲线越断"在离线数据里
    // 也如实呈现，而不是所有场景都画出一条逐小时连续曲线。
    function sampled(h) {
      var cadence = p.vitalCadence || 1;
      if (cadence <= 1) return true;
      var phase = p.phase || 0;
      return (h + phase) % cadence < 1;
    }

    // 该场景是否测这一项（家庭养护只测心率与血氧）
    function hasVital(name) {
      if (!p.vitals) return true;
      return p.vitals.indexOf(name) >= 0;
    }

    function skip(name, h) {
      return !hasVital(name) || !sampled(h) || inGap(name, h);
    }

    // 实验室指标：按固定间隔采样，其余小时为 null（真实缺失）
    function labAt(name, h) {
      var cadence = p.labs[name];
      if (!cadence || cadence <= 0) return null;              // 全程未开单
      if (p.labs.stopLactateAfter !== undefined && name === 'Lactate' && h > p.labs.stopLactateAfter) return null;
      if (h < 2 || (h - 2) % cadence !== 0) return null;
      return true;
    }

    for (var i = 0; i < n; i++) {
      var h = i + 1;
      hours.push(h);
      var prog = progressAt(p, h);
      var circ = Math.sin(((h % 24) / 24) * Math.PI * 2);   // 昼夜节律
      var nz = function (k) { return (rng() * 2 - 1) * k; };

      // 心率
      vars.HR.push(skip('HR', h) ? null : r1(p.base.HR + p.drift.HR * prog + circ * 3 + nz(4)));
      // 收缩压
      vars.SBP.push(skip('SBP', h) ? null : r1(p.base.SBP + p.drift.SBP * prog - circ * 2 + nz(4)));
      // 呼吸频率
      vars.Resp.push(skip('Resp', h) ? null : r1(p.base.Resp + p.drift.Resp * prog + nz(1.6)));
      // 血氧饱和度
      vars.O2Sat.push(skip('O2Sat', h) ? null : r1(clamp(p.base.O2Sat + p.drift.O2Sat * prog + nz(1.0), 82, 100)));
      // 体温
      vars.Temp.push(skip('Temp', h) ? null : r1(p.base.Temp + p.drift.Temp * prog + nz(0.18)));
      // 乳酸
      if (labAt('Lactate', h)) {
        var base = p.base.Lactate === null ? 1.2 : p.base.Lactate;
        vars.Lactate.push(r2(clamp(base + p.drift.Lactate * prog + nz(0.25), 0.4, 12)));
      } else {
        vars.Lactate.push(null);   // 未到采样时点或未开单 → 真实缺失
      }
      // 白细胞计数
      vars.WBC.push(labAt('WBC', h) ? r2(clamp(p.base.WBC + p.drift.WBC * prog + nz(0.9), 1.5, 40)) : null);
      // 肌酐
      vars.Creatinine.push(labAt('Creatinine', h) ? r2(clamp(p.base.Creatinine + p.drift.Creatinine * prog + nz(0.08), 0.3, 8)) : null);
    }

    return { hours: hours, variables: vars };
  }

  // 风险序列：关键帧插值 + 轻微波动
  function buildRiskSeries(p) {
    var rng = mulberry32(p.seed + 777);
    var out = [];
    for (var h = 1; h <= p.los; h++) {
      var v = interpKeys(p.riskKeys, h);
      v = clamp(v + (rng() * 2 - 1) * 0.012, 0.01, 0.99);
      out.push(Math.round(v * 1000) / 1000);
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * 四之二、监护场景与离线演示队列扩充
   * ------------------------------------------------------------------
   * 上面的 12 份病例档案是逐份手工编写的重症监护病例，用于展示细节丰富的
   * 单患者视图。但只有重症监护一种场景是不够的：本平台面向的场所还包括
   * 普通病房、养老机构、家庭养护与术后随访，而这些场景的**数据可获得性
   * 差别极大**——养老机构每 8 小时才测一次体温，家庭养护连体温都拿不到。
   *
   * 因此这里按场景画像确定性地生成一批离线演示患者。场景参数与后端
   * `sepsisguard/scenarios.py` **逐项对齐**：采样间隔、可测变量总数、
   * 脓毒症发生率、信息完整度、置信度折减。`n_variables` 取后端声明的
   * "该场景可获得的变量总数"，而 `labCadence` 只列出离线演示真正合成
   * 时间序列的那几项检验——后者是演示的表达能力，不等于场景的可测范围。
   *
   * 生成使用固定种子，因此每次刷新得到完全相同的队列，便于复核。
   * ------------------------------------------------------------------ */

  var SCENARIOS = [
    {
      key: 'icu', name_zh: '重症监护病房',
      description: '监护仪逐小时记录生命体征，检验项目齐全、每日多次。信息最完整，风险判断的置信度最高。',
      vital_interval_hours: 1, lab_interval_hours: 12, n_variables: 34,
      info_completeness: 0.901, sepsis_rate: 0.09, confidence_discount: 0,
      vitals: ['HR', 'O2Sat', 'Temp', 'SBP', 'DBP', 'MAP', 'Resp', 'EtCO2'],
      labCadence: { Lactate: 8, WBC: 12, Creatinine: 12 },
      losRange: [24, 120], seedBase: 90000
    },
    {
      key: 'ward', name_zh: '普通病房',
      description: '护士每 4 小时测量生命体征，检验以基础血常规与生化为主、每日一次。监测密度低于重症监护，但足以支撑趋势判断。',
      vital_interval_hours: 4, lab_interval_hours: 24, n_variables: 20,
      info_completeness: 0.322, sepsis_rate: 0.06, confidence_discount: 0.10,
      vitals: ['HR', 'O2Sat', 'Temp', 'SBP', 'DBP', 'Resp', 'MAP'],
      labCadence: { Lactate: 24, WBC: 24, Creatinine: 24 },
      losRange: [48, 240], seedBase: 91000
    },
    {
      key: 'nursing_home', name_zh: '养老机构',
      description: '每班次约 8 小时测量一次生命体征，检验依赖外送、每周一至两次。老年患者感染表现常不典型，可无发热，需更依赖趋势与功能状态变化。',
      vital_interval_hours: 8, lab_interval_hours: 72, n_variables: 16,
      info_completeness: 0.190, sepsis_rate: 0.05, confidence_discount: 0.28,
      vitals: ['HR', 'O2Sat', 'Temp', 'SBP', 'Resp'],
      labCadence: { Lactate: 72, WBC: 72, Creatinine: 72 },
      losRange: [168, 720], seedBase: 92000
    },
    {
      key: 'home_care', name_zh: '家庭养护',
      description: '可穿戴设备连续采集心率与血氧，几乎不做检验。信息最稀薄，风险分数主要反映即时状态，趋势判断依赖长期基线。',
      vital_interval_hours: 1, lab_interval_hours: 0, n_variables: 2,
      info_completeness: 0.021, sepsis_rate: 0.03, confidence_discount: 0.45,
      vitals: ['HR', 'O2Sat'],
      labCadence: { Lactate: 0, WBC: 0, Creatinine: 0 },   // 0 = 全程不采血
      losRange: [336, 1440], seedBase: 93000
    },
    {
      key: 'post_op', name_zh: '术后随访',
      description: '术后 72 小时内每 6 小时监测，检验按需开单。这一时段是吻合口漏、切口感染等并发症的高发窗口。',
      vital_interval_hours: 6, lab_interval_hours: 24, n_variables: 20,
      info_completeness: 0.307, sepsis_rate: 0.07, confidence_discount: 0.12,
      vitals: ['HR', 'O2Sat', 'Temp', 'SBP', 'DBP', 'MAP', 'Resp'],
      labCadence: { Lactate: 24, WBC: 24, Creatinine: 24 },
      losRange: [24, 168], seedBase: 94000
    }
  ];

  var SCENARIO_BY_KEY = {};
  SCENARIOS.forEach(function (s) { SCENARIO_BY_KEY[s.key] = s; });

  // 各场景的生理基线与病程幅度（严重程度按 confidence_discount 体现：
  // 场景越稀薄，个体严重程度越高——因为能被纳入这一场景的往往是重症）
  var SCENARIO_BASE = {
    icu: { HR: 92, SBP: 112, Resp: 20, O2Sat: 95, Temp: 37.2, Lactate: 1.7, WBC: 13.0, Creatinine: 1.25 },
    ward: { HR: 88, SBP: 122, Resp: 19, O2Sat: 95, Temp: 37.4, Lactate: 1.5, WBC: 11.5, Creatinine: 1.10 },
    nursing_home: { HR: 84, SBP: 130, Resp: 19, O2Sat: 94, Temp: 36.8, Lactate: 1.4, WBC: 10.2, Creatinine: 1.30 },
    home_care: { HR: 80, SBP: 132, Resp: 18, O2Sat: 95, Temp: 36.7, Lactate: 1.3, WBC: 8.6, Creatinine: 1.05 },
    post_op: { HR: 90, SBP: 118, Resp: 19, O2Sat: 95, Temp: 37.6, Lactate: 1.6, WBC: 12.4, Creatinine: 1.05 }
  };

  var SCENARIO_PREFIX = {
    icu: 'ICU', ward: 'WARD', nursing_home: 'NH', home_care: 'HOME', post_op: 'PO'
  };

  /**
   * 生成某场景的一位离线演示患者档案。
   * 病程分四类：平稳 / 逐步改善 / 存在恶化风险 / 波动病程，与后端动态引擎一致。
   */
  function makeScenarioProfile(scenario, index, seed) {
    var rng = mulberry32(seed);
    var los = Math.round(scenario.losRange[0] +
      rng() * (scenario.losRange[1] - scenario.losRange[0]));
    var severity = clamp(0.25 + scenario.confidence_discount + rng() * 0.5, 0, 1);
    var sepsis = rng() < scenario.sepsis_rate;
    var onset = null;
    var riskKeys;
    var declineFrom = Math.round(los * 0.35);
    var ramp = Math.max(6, Math.round(los * 0.35));

    var roll = rng();
    var course;
    if (sepsis) {
      course = 'deteriorating';
      onset = Math.round(los * 0.35 + rng() * los * 0.4);
      declineFrom = Math.max(1, onset - Math.round(6 + rng() * 12));
      ramp = Math.max(4, onset - declineFrom);
      riskKeys = [
        [1, 0.08 + severity * 0.10],
        [declineFrom, 0.16 + severity * 0.12],
        [onset, 0.62 + severity * 0.30],
        [los, 0.70 + severity * 0.28]
      ];
    } else if (roll < 0.45) {
      course = 'improving';
      riskKeys = [
        [1, 0.30 + severity * 0.28],
        [Math.min(24, los), 0.16 + severity * 0.12],
        [los, 0.06 + severity * 0.06]
      ];
    } else if (roll < 0.72) {
      course = 'fluctuating';
      // 波动病程：经历一次可逆急性事件后部分恢复，但**仍高于基线**——
      // 这类患者既不该归为"正常"，也不该归为"高风险"，正好填充中风险区间。
      // 若让末值回落到基线，中风险一档在离线演示里几乎是空的。
      var eventAt = Math.max(3, Math.round(los * (0.25 + rng() * 0.4)));
      declineFrom = Math.max(1, eventAt - 3);
      ramp = 3;
      riskKeys = [
        [1, 0.18 + severity * 0.12],
        [declineFrom, 0.14 + severity * 0.10],
        [eventAt, 0.46 + severity * 0.30],
        [Math.min(los, eventAt + 6), 0.34 + severity * 0.24],
        [los, 0.30 + severity * 0.34]
      ];
    } else {
      course = 'stable';
      riskKeys = [
        [1, 0.16 + severity * 0.10],
        [los, 0.12 + severity * 0.09]
      ];
    }

    var base = SCENARIO_BASE[scenario.key];
    var drift = {
      HR: (8 + severity * 26) * (sepsis ? 1 : 0.5),
      SBP: -(6 + severity * 24) * (sepsis ? 1 : 0.4),
      Resp: (2 + severity * 8) * (sepsis ? 1 : 0.4),
      O2Sat: -(1 + severity * 4) * (sepsis ? 1 : 0.4),
      Temp: (0.3 + severity * 1.1) * (sepsis ? 1 : 0.3),
      Lactate: (0.4 + severity * 3.0) * (sepsis ? 1 : 0.4),
      WBC: (1.5 + severity * 3.5) * (sepsis ? 1 : 0.5),
      Creatinine: (0.08 + severity * 0.7) * (sepsis ? 1 : 0.4)
    };

    // 场景采样节律造成的"未测量窗口"
    var gaps = {};
    scenario.vitals.forEach(function (name) {
      var wins = [];
      var cursor = 3 + Math.round(rng() * 6);
      while (cursor < los) {
        var length = 1 + Math.round(rng() * scenario.vital_interval_hours);
        wins.push([cursor, cursor + length]);
        cursor += length + Math.round(rng() * (12 + scenario.confidence_discount * 40));
      }
      if (wins.length) gaps[name] = wins;
    });

    var labs = {
      Lactate: scenario.labCadence.Lactate,
      WBC: scenario.labCadence.WBC,
      Creatinine: scenario.labCadence.Creatinine
    };
    if (labs.Lactate > 0 && rng() < 0.25) {
      labs.stopLactateAfter = Math.round(los * (0.5 + rng() * 0.4));
    }

    // 告警：从风险序列中挑出等级上升的时点
    var alerts = [];
    var warned = false;
    for (var h = 1; h <= los; h++) {
      var v = interpKeys(riskKeys, h);
      var lv = levelOf(v);
      if (lv.level === 'high' && !warned) {
        warned = true;
        alerts.push({
          at: h, level: 'high',
          status: rng() < 0.45 ? 'open' : 'acknowledged',
          reason_zh: sepsis
            ? '乳酸升高伴血压下降，提示组织灌注不足'
            : '多项生命体征同时偏离基线，需临床复核'
        });
      } else if (lv.level === 'medium' && alerts.length === 0 && h > 6) {
        alerts.push({
          at: h, level: 'medium', status: 'open',
          reason_zh: '生命体征偏离个体基线，风险呈上升趋势'
        });
      }
    }
    if (alerts.length > 3) alerts = alerts.slice(0, 3);

    var features = [
      { feature: 'Lactate__trend', name_zh: '乳酸趋势', direction: 'up',
        contribution: r2(0.06 + severity * 0.16),
        phrase_zh: '乳酸呈上升趋势，提示组织灌注不足' },
      { feature: 'SBP__mean_12h', name_zh: '收缩压（12 小时均值）', direction: 'down',
        contribution: r2(0.05 + severity * 0.12),
        phrase_zh: '收缩压 12 小时均值下降，循环稳定性变差' },
      { feature: 'Resp__slope_6h', name_zh: '呼吸频率（6 小时斜率）', direction: 'up',
        contribution: r2(0.03 + severity * 0.08),
        phrase_zh: '呼吸频率上升，呼吸做功增加' }
    ];

    var infoGaps = [{
      variable: 'Lactate', name_zh: '乳酸',
      phrase_zh: scenario.labCadence.Lactate > 0
        ? '乳酸按每 ' + scenario.labCadence.Lactate + ' 小时一次采样，未复测时段判断置信度下降'
        : '本场景不具备采血条件，乳酸全程无法获得，判断置信度显著下降'
    }];
    if (scenario.confidence_discount >= 0.28) {
      infoGaps.push({
        variable: 'Temp', name_zh: '体温',
        phrase_zh: '本场景每 ' + scenario.vital_interval_hours +
          ' 小时测量一次生命体征，体温存在多个未测量时段'
      });
    }

    var age = Math.round(clamp(
      scenario.key === 'nursing_home' ? 62 + rng() * 34 : 42 + rng() * 52, 18, 98));

    return {
      id: 'p' + String(100000 + index).slice(0),
      bed: SCENARIO_PREFIX[scenario.key] + '-' + String(index % 24 + 1),
      age: age,
      gender: rng() < 0.53 ? 1 : 0,
      los: los,
      sepsis: sepsis,
      onset: onset,
      course: course,
      scenario: scenario.key,
      scenario_zh: scenario.name_zh,
      info_completeness: scenario.info_completeness,
      confidence_discount: scenario.confidence_discount,
      vitalCadence: scenario.vital_interval_hours,
      vitals: scenario.vitals,
      phase: Math.round(rng() * 10),
      base: base,
      drift: drift,
      declineFrom: declineFrom,
      ramp: ramp,
      seed: seed,
      gaps: gaps,
      labs: labs,
      riskKeys: riskKeys,
      alerts: alerts,
      features: features,
      infoGaps: infoGaps
    };
  }

  /**
   * 生成全部场景的离线演示队列。
   *
   * `perScenario` 为每个场景的患者数；默认每个场景 40 位，五个场景共 200 位，
   * 重症监护另有 12 份手工病例，合计 212 位——足以让列表、筛选、排序、
   * 统计图表与场景对比都有真实规模的数据可用。
   */
  function buildScenarioCohort(perScenario) {
    var out = [];
    var counter = 0;
    SCENARIOS.forEach(function (scenario) {
      for (var i = 0; i < perScenario; i++) {
        out.push(makeScenarioProfile(scenario, counter, scenario.seedBase + i * 17));
        counter++;
      }
    });
    return out;
  }

  var OFFLINE_PER_SCENARIO = 40;
  PROFILES = PROFILES.concat(buildScenarioCohort(OFFLINE_PER_SCENARIO));

  /* ------------------------------------------------------------------ *
   * 五、聚合
   * ------------------------------------------------------------------ */

  var state = { patients: [], details: {}, alerts: [] };

  function build() {
    state.patients = [];
    state.details = {};
    state.alerts = [];

    PROFILES.forEach(function (p) {
      var riskSeries = buildRiskSeries(p);
      var last = riskSeries[riskSeries.length - 1];
      // 峰值风险：真实后端按峰值分级，这里同样提供该字段使前后端展示一致
      var peak = Math.round(Math.max.apply(null, riskSeries) * 1000) / 1000;
      var lv = levelOf(last);

      // 告警列表
      var alerts = (p.alerts || []).map(function (a, idx) {
        var aid = 'a-' + p.id.slice(1) + '-' + (idx + 1);
        return {
          alert_id: aid,
          patient_id: p.id,
          bed: p.bed,
          trigger_time: a.at,
          level: a.level,
          level_zh: levelOf(a.level === 'high' ? 0.8 : a.level === 'medium' ? 0.5 : 0.3).zh,
          risk_score: riskSeries[Math.min(a.at, p.los) - 1],
          status: a.status,
          reason_zh: a.reason_zh,
          created_at: '第 ' + a.at + ' 小时',
          handled_by: a.status === 'open' ? null : '张医生',
          top_features: p.features,
          information_gaps: p.infoGaps
        };
      });
      alerts.forEach(function (a) { state.alerts.push(a); });

      var lastAlert = alerts.length ? alerts[alerts.length - 1] : null;

      // 时序只构建一次，患者列表与详情共用
      var timeseries = buildTimeseries(p);

      // 关键指标覆盖度：窗口内"至少有一项关键检验被测量"的小时占比。
      // 这是从数据里真的算出来的，不是照抄场景表里的常数——离线演示也必须
      // 让"数据够不够支撑判断"这件事有依据。
      var keyVars = ['Lactate', 'WBC', 'Creatinine', 'Platelets'];
      var keySeries = keyVars
        .map(function (name) { return timeseries.variables[name]; })
        .filter(function (series) { return Array.isArray(series); });
      var measuredRatio = null;
      if (keySeries.length && timeseries.hours.length) {
        var measuredHours = 0;
        for (var i = 0; i < timeseries.hours.length; i++) {
          for (var j = 0; j < keySeries.length; j++) {
            if (keySeries[j][i] !== null && keySeries[j][i] !== undefined) {
              measuredHours++;
              break;
            }
          }
        }
        measuredRatio = Math.round(measuredHours / timeseries.hours.length * 10000) / 10000;
      }

      var gaps = p.infoGaps || [];

      state.patients.push({
        patient_id: p.id,
        bed: p.bed,
        age: p.age,
        gender: p.gender,
        gender_zh: p.gender === 0 ? '女' : '男',
        icu_los_hours: p.los,
        risk_score: last,
        peak_risk_score: peak,
        risk_level: lv.level,
        risk_level_zh: lv.zh,
        last_alert_time: lastAlert ? '第 ' + lastAlert.trigger_time + ' 小时' : null,
        last_alert_hour: lastAlert ? lastAlert.trigger_time : null,
        open_alert_count: alerts.filter(function (a) { return a.status === 'open'; }).length,
        has_sepsis_label: p.sepsis,
        onset_hour: p.onset,
        // ---- 监护场景维度 ----
        // 同一套模型在不同场景下的置信度不同，界面必须能把这件事显示出来
        scenario: p.scenario || 'icu',
        scenario_zh: p.scenario_zh || '重症监护病房',
        course_zh: p.course ? ({
          stable: '平稳观察', improving: '逐步改善',
          deteriorating: '存在恶化风险', fluctuating: '波动病程'
        }[p.course] || p.course) : '数据集病程',
        info_completeness: p.info_completeness === undefined
          ? SCENARIO_BY_KEY.icu.info_completeness : p.info_completeness,
        confidence_discount: p.confidence_discount === undefined
          ? SCENARIO_BY_KEY.icu.confidence_discount : p.confidence_discount,
        trend_delta: last - riskSeries[Math.max(0, riskSeries.length - 7)],
        // ---- 不确定性显式化（与后端同名同义）----
        measured_ratio: measuredRatio,
        gap_count: gaps.length,
        gap_names: gaps.map(function (g) { return g.name_zh; }),
        // 列表接口额外携带风险序列，便于医生端直接绘制迷你趋势（属扩展字段）
        risk_series: riskSeries
      });

      state.details[p.id] = {
        patient: state.patients[state.patients.length - 1],
        timeseries: timeseries,
        risk_series: riskSeries,
        alerts: alerts
      };
    });
  }

  build();

  /* ------------------------------------------------------------------ *
   * 六、对外接口（与后端 REST 契约同形）
   * ------------------------------------------------------------------ */

  function sortPatients(list, sort) {
    var arr = list.slice();
    if (sort === 'bed') {
      arr.sort(function (a, b) { return String(a.bed).localeCompare(String(b.bed)); });
    } else if (sort === 'los') {
      arr.sort(function (a, b) { return b.icu_los_hours - a.icu_los_hours; });
    } else {
      arr.sort(function (a, b) { return b.risk_score - a.risk_score; });
    }
    return arr;
  }

  var API = {
    VARIABLE_ZH: VARIABLE_ZH,
    REF: REF,
    LEVEL_RULES: LEVEL_RULES,
    SCENARIOS: SCENARIOS,
    profiles: PROFILES,
    levelOf: levelOf,
    isDemo: true,

    getHealth: function () {
      return { status: 'ok', model_version: 'demo-1.4.0', patients_loaded: state.patients.length, mode: 'demo' };
    },

    getPatients: function (opts) {
      opts = opts || {};
      var list = state.patients;
      if (opts.level && opts.level !== 'all') {
        list = list.filter(function (p) { return p.risk_level === opts.level; });
      }
      if (opts.scenario && opts.scenario !== 'all') {
        list = list.filter(function (p) { return p.scenario === opts.scenario; });
      }
      if (opts.q) {
        var q = String(opts.q).toLowerCase();
        list = list.filter(function (p) {
          return p.patient_id.toLowerCase().indexOf(q) >= 0 || String(p.bed).toLowerCase().indexOf(q) >= 0;
        });
      }
      list = sortPatients(list, opts.sort || 'risk');
      if (opts.limit) list = list.slice(0, opts.limit);
      return { patients: list, count: list.length, offline: true };
    },

    getPatient: function (id) {
      var d = state.details[id];
      if (!d) return null;
      return d;
    },

    getRisk: function (id) {
      var d = state.details[id];
      if (!d) return null;
      var prof = PROFILES.filter(function (p) { return p.id === id; })[0] || {};
      return {
        patient_id: id,
        risk_score: d.patient.risk_score,
        risk_level: d.patient.risk_level,
        risk_level_zh: d.patient.risk_level_zh,
        top_features: prof.features || [],
        information_gaps: prof.infoGaps || []
      };
    },

    getAlerts: function (opts) {
      opts = opts || {};
      var list = state.alerts;
      if (opts.status && opts.status !== 'all') {
        list = list.filter(function (a) { return a.status === opts.status; });
      }
      if (opts.level && opts.level !== 'all') {
        list = list.filter(function (a) { return a.level === opts.level; });
      }
      if (opts.patient_id) {
        list = list.filter(function (a) { return a.patient_id === opts.patient_id; });
      }
      return { alerts: list, count: list.length };
    },

    ackAlert: function (alertId, body) {
      var target = null;
      state.alerts.forEach(function (a) { if (a.alert_id === alertId) target = a; });
      if (!target) return null;
      var map = { acknowledge: 'acknowledged', ignore: 'ignored', snooze: 'snoozed' };
      target.status = map[body.action] || target.status;
      target.handled_by = body.handled_by || '当前用户';
      target.handle_reason = body.reason || '';
      // 同步到患者详情中的告警副本
      Object.keys(state.details).forEach(function (k) {
        state.details[k].alerts.forEach(function (a) {
          if (a.alert_id === alertId) {
            a.status = target.status;
            a.handled_by = target.handled_by;
            a.handle_reason = target.handle_reason;
          }
        });
      });
      return { ok: true, alert: target };
    },

    getModels: function () {
      // 离线演示模式下的模型档案。**不填写性能数字**：真实结果只在
      // docs/实验结果.md 中维护，界面若自带一份副本，两处迟早会不一致。
      return {
        models: [
          {
            model_id: 'sg-lgbm-v1', name: '哨兵风险模型', version: 'lightgbm-v1',
            algorithm: 'LightGBM', status: 'serving', features: 863, window_hours: 168,
            note: '离线演示模式：模型档案与真实服务同源；性能指标见 docs/实验结果.md'
          },
          {
            model_id: 'sg-rules-v1', name: '临床规则基线', version: 'rules-v1',
            algorithm: '规则基线（SIRS / qSOFA / NEWS2）', status: 'serving',
            features: 12, window_hours: 1,
            note: '床旁规则评分，作为模型输出的交叉核对，不单独用于预警'
          }
        ],
        count: 2,
        offline: true
      };
    },

    /** 离线演示模式下的监护场景目录（与后端 scenarios.py 逐项对齐）。 */
    getScenarios: function () {
      return {
        scenarios: SCENARIOS.map(function (s) {
          var simulated = Object.keys(s.labCadence).filter(function (k) {
            return s.labCadence[k] > 0;
          });
          return {
            key: s.key, name_zh: s.name_zh, description: s.description,
            vital_interval_hours: s.vital_interval_hours,
            lab_interval_hours: s.lab_interval_hours,
            // 以下三项与后端 `scenarios.py` 逐项一致：可测变量总数取声明值，
            // 检验项 = 总数 − 生命体征数。**不要用 labCadence 的键数当检验项数**：
            // 离线演示只合成 3 项检验的时间序列，而"该场景能拿到多少项检验"
            // 与"演示画了几条曲线"是两件不同的事，混起来会低估可测变量数
            //（实测 icu 会被算成 11 项而非 34 项）。
            n_monitored_vitals: s.vitals.length,
            n_available_labs: s.n_variables - s.vitals.length,
            n_variables: s.n_variables,
            monitored_vitals: s.vitals,
            available_labs: simulated.concat(
              s.n_variables - s.vitals.length > simulated.length
                ? ['（其余 ' + (s.n_variables - s.vitals.length - simulated.length) +
                   ' 项未在离线演示中合成时间序列）']
                : []
            ),
            simulated_series: s.vitals.length + simulated.length,
            sepsis_rate: s.sepsis_rate,
            info_completeness: s.info_completeness,
            confidence_discount: s.confidence_discount,
            has_advanced_monitoring: s.key === 'icu',
            cohort_size: state.patients.filter(function (p) {
              return p.scenario === s.key;
            }).length
          };
        }),
        default: 'icu',
        offline: true
      };
    },

    getStats: function () {
      var byLevel = { normal: 0, low: 0, medium: 0, high: 0 };
      state.patients.forEach(function (p) { byLevel[p.risk_level] = (byLevel[p.risk_level] || 0) + 1; });
      var alertsByLevel = { low: 0, medium: 0, high: 0 };
      state.alerts.forEach(function (a) { alertsByLevel[a.level] = (alertsByLevel[a.level] || 0) + 1; });
      var open = state.alerts.filter(function (a) { return a.status === 'open'; }).length;
      var byScenario = {};
      state.patients.forEach(function (p) {
        byScenario[p.scenario] = (byScenario[p.scenario] || 0) + 1;
      });
      return {
        patients: state.patients.length,
        high_risk_patients: byLevel.high,
        alerts_total: state.alerts.length,
        alerts_open: open,
        alerts_by_level: alertsByLevel,
        patients_by_level: byLevel,
        patients_by_scenario: byScenario,
        scenarios: SCENARIOS.length,
        total_hours_processed: state.patients.reduce(function (sum, p) {
          return sum + p.icu_los_hours;
        }, 0),
        // 离线演示模式不提供性能数字：真实测量结果见 docs/实验结果.md
        offline: true
      };
    }
  };

  global.SGDemo = API;
})(window);
