// ==UserScript==
// @name         BOSS直聘-自动筛选打招呼 v2.2
// @namespace    http://tampermonkey.net/
// @version      2.2.0
// @description  在Boss直聘「推荐牛人 -> 推荐 Tab」页面，按自定义筛选条件自动打招呼
// @author       dalaolee
// @match        https://www.zhipin.com/web/frame/*
// @icon         data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-start
// ==/UserScript==

(function () {
  "use strict";

  // =====================================================================
  // ======================== 默认配置 START =============================
  // =====================================================================

  /** 默认公司白名单：互联网大厂 + AI 初创 + 外企 */
  const DEFAULT_COMPANY_LIST = [
    // —— 互联网一线大厂 ——
    "百度", "阿里", "淘宝", "天猫", "支付宝", "蚂蚁",
    "腾讯", "微信", "字节跳动", "抖音", "TikTok", "飞书",
    "美团", "华为", "京东",
    "快手", "拼多多", "网易",
    "小米", "OPPO", "vivo", "荣耀",
    // —— 互联网二线 ——
    "滴滴", "哔哩哔哩", "B站", "小红书",
    "携程", "去哪儿", "微博", "知乎",
    "58同城", "贝壳", "链家",
    "大疆", "蔚来", "小鹏", "理想",
    "货拉拉", "SHEIN", "米哈游",
    // —— AI / 大模型初创 ——
    "智谱", "MiniMax", "月之暗面", "Moonshot",
    "百川智能", "百川", "零一万物",
    "深度求索", "DeepSeek",
    "商汤", "旷视", "依图", "云从",
    "第四范式", "昆仑万维", "面壁智能",
    "阶跃星辰", "光年之外",
    "科大讯飞", "思谋科技",
    // —— 外企 ——
    "微软", "Microsoft", "Google", "谷歌",
    "Apple", "苹果", "Amazon", "亚马逊",
    "Meta", "Facebook", "OpenAI",
    "英伟达", "NVIDIA", "英特尔", "Intel",
    "IBM", "Oracle", "SAP",
  ];

  /** 默认职位关键词 */
  const DEFAULT_POSITION_KEYWORDS = ["算法"];

  /** 默认配置（会被 GM_getValue 里保存的用户配置覆盖） */
  const DEFAULT_CONFIG = {
    jobId: "",

    apiFilter: {
      age: "16,-1",
      activation: 0,
      school: "1104,1103,1102,1106",
      recentNotView: 0,
      switchJobFrequency: 0,
      exchangeResumeWithColleague: 0,
      gender: 0,
      keyword1: -1,
      major: 0,
      degree: 0,
      experience: "110,103,104,105,106",
      intention: 0,
      salary: 0,
      firstDegree: 999,
    },

    companyWhiteList: DEFAULT_COMPANY_LIST,
    positionKeywords: DEFAULT_POSITION_KEYWORDS,
    excludeFreshGraduate: true,

    greetDelayMin: 4000,
    greetDelayMax: 9000,
    maxGreetPerDay: 80,
    maxPages: 20,

    workHourStart: 8,
    workHourEnd: 22,

    enabled: false,
  };

  // =====================================================================
  // ======================== 默认配置 END ===============================
  // =====================================================================

  // ======================== 全局状态 ========================

  const LOG_PREFIX = "[BOSS自动招呼]";
  let config = null;
  let isRunning = false;
  let mainLoopTimer = null;

  // 过滤统计
  let filterStats = { total: 0, passed: 0, rejected: 0, reasons: {} };

  /**
   * 过滤日志：每个候选人一条记录（仅记录真实操作数据，不含测试）
   * { name, works:[{company,position}], result:"pass"|"reject"|"greet_ok"|"greet_fail", reason, time }
   */
  let filterLog = [];

  // ======================== 工具函数 ========================

  function log(...args) {
    console.log(`%c${LOG_PREFIX}`, "color:#00b38a;font-weight:bold", ...args);
  }
  function warn(...args) {
    console.warn(`${LOG_PREFIX}`, ...args);
  }

  function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function sleep(minMs, maxMs) {
    const ms = maxMs ? randomInt(minMs, maxMs) : minMs;
    return new Promise((r) => setTimeout(r, ms));
  }

  function getTodayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function getTimeStr() {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
  }

  function getTodayGreetCount() {
    const data = GM_getValue("boss_greet_count", {});
    return data[getTodayKey()] || 0;
  }

  function addTodayGreetCount(n = 1) {
    const data = GM_getValue("boss_greet_count", {});
    const key = getTodayKey();
    data[key] = (data[key] || 0) + n;
    const keys = Object.keys(data).sort();
    while (keys.length > 7) delete data[keys.shift()];
    GM_setValue("boss_greet_count", data);
    return data[key];
  }

  function isWorkingHour() {
    const h = new Date().getHours();
    return h >= config.workHourStart && h < config.workHourEnd;
  }

  function extractJobIdFromUrl() {
    try {
      const u = new URL(window.location.href);
      return u.searchParams.get("jobid") || u.searchParams.get("jobId") || "";
    } catch { return ""; }
  }

  function getJobId() {
    if (config.jobId) return config.jobId;
    const fromUrl = extractJobIdFromUrl();
    if (fromUrl) { config.jobId = fromUrl; return fromUrl; }
    return "";
  }

  // ======================== 配置持久化 ========================

  function loadConfig() {
    const saved = GM_getValue("boss_auto_greet_config", null);
    if (saved) {
      config = { ...DEFAULT_CONFIG, ...saved };
      config.apiFilter = { ...DEFAULT_CONFIG.apiFilter, ...(saved.apiFilter || {}) };
      if (typeof config.companyWhiteList === "string") {
        config.companyWhiteList = config.companyWhiteList.split(/[,，\n]/).map(s => s.trim()).filter(Boolean);
      }
      if (typeof config.positionKeywords === "string") {
        config.positionKeywords = config.positionKeywords.split(/[,，\n]/).map(s => s.trim()).filter(Boolean);
      }
    } else {
      config = { ...DEFAULT_CONFIG };
    }
    log("配置已加载:", config);
  }

  function saveConfig() {
    GM_setValue("boss_auto_greet_config", config);
    log("配置已保存");
  }

  // =====================================================================
  // ======================== 实时动态面板 =============================
  // =====================================================================

  /**
   * 在面板的 live feed 区域添加一条实时记录
   * @param {Object} entry - { icon, name, info, detail, color, bgColor }
   */
  function addLiveFeedItem(entry) {
    const container = document.getElementById("bag-live-feed");
    if (!container) return;

    const placeholder = container.querySelector(".bag-live-empty");
    if (placeholder) placeholder.remove();

    const item = document.createElement("div");
    item.className = "bag-live-item";
    item.style.cssText = `
      padding:6px 8px;border-radius:8px;margin-bottom:4px;
      background:${entry.bgColor || "#f6f8fa"};line-height:1.5;
      animation: bag-fade-in 0.3s ease;
    `;
    item.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <span style="font-weight:600;color:${entry.color || "#333"};font-size:12px;">${entry.icon} ${entry.name}</span>
        <span style="font-size:10px;color:#bbb;">${getTimeStr()}</span>
      </div>
      <div style="font-size:11px;color:#888;margin-top:1px;">${entry.info}</div>
      ${entry.detail ? `<div style="font-size:10px;color:#aaa;margin-top:1px;">${entry.detail}</div>` : ""}
    `;

    container.prepend(item);

    // 最多保留 15 条实时记录
    const items = container.querySelectorAll(".bag-live-item");
    if (items.length > 15) {
      for (let i = 15; i < items.length; i++) items[i].remove();
    }
  }

  /**
   * 高亮当前正在处理的候选人（黄色闪烁效果）
   */
  function showCurrentCandidate(name, info) {
    const el = document.getElementById("bag-current");
    if (!el) return;
    el.innerHTML = `
      <div style="display:flex;align-items:center;gap:6px;">
        <span class="bag-pulse"></span>
        <span style="font-weight:600;color:#fa8c16;">${name}</span>
      </div>
      <div style="font-size:11px;color:#888;margin-top:2px;">${info}</div>
    `;
    el.style.display = "block";
  }

  function hideCurrentCandidate() {
    const el = document.getElementById("bag-current");
    if (el) { el.style.display = "none"; el.innerHTML = ""; }
  }

  // =====================================================================
  // ======================== 二次过滤逻辑 =============================
  // =====================================================================

  /**
   * 对单个候选人做过滤判定
   */
  function evaluateGeek(geek) {
    const card = geek.geekCard;
    if (!card) return { pass: false, reason: "无geekCard", detail: "geekCard 字段为空" };

    const works = card.geekWorks || [];
    const workYear = card.geekWorkYear || "";
    const freshGrad = card.freshGraduate || 0;

    // —— 规则 1：排除应届生 ——
    if (config.excludeFreshGraduate) {
      if (workYear.includes("应届") || freshGrad > 0) {
        return {
          pass: false,
          reason: "应届生",
          detail: `geekWorkYear="${workYear}", freshGraduate=${freshGrad}`,
        };
      }
    }

    // —— 规则 2：公司白名单 ——
    if (config.companyWhiteList.length > 0) {
      const companyMatch = works.some((w) =>
        config.companyWhiteList.some((target) =>
          (w.company || "").includes(target)
        )
      );
      if (!companyMatch) {
        const companies = works.map(w => w.company || "无").join(", ");
        return {
          pass: false,
          reason: "公司不匹配",
          detail: `经历公司: [${companies}]`,
        };
      }
    }

    // —— 规则 3：职位关键词 ——
    if (config.positionKeywords.length > 0) {
      const posMatch = works.some((w) =>
        config.positionKeywords.some((kw) =>
          (w.positionCategory || "").includes(kw)
        )
      );
      if (!posMatch) {
        const positions = works.map(w => w.positionCategory || "无").join(", ");
        return {
          pass: false,
          reason: "职位不匹配",
          detail: `经历职位: [${positions}]`,
        };
      }
    }

    // —— 全部通过 ——
    const summary = works.map(w => `${w.company}·${w.positionCategory}`).join(" | ");
    return { pass: true, reason: "通过", detail: summary };
  }

  /**
   * 对 API 返回的 geekList 做本地二次过滤
   * 同时写入 filterLog 和 live feed
   */
  function filterGeekList(geekList) {
    if (!geekList || !geekList.length) return [];

    filterStats = { total: geekList.length, passed: 0, rejected: 0, reasons: {} };

    const result = [];

    for (const geek of geekList) {
      const card = geek.geekCard || {};
      const name = card.geekName || "未知";
      const works = (card.geekWorks || []).map(w => ({
        company: w.company || "",
        position: w.positionCategory || "",
      }));
      const worksStr = works.map(w => `${w.company}·${w.position}`).join(" | ") || "无经历";

      // 在 live feed 显示正在分析
      showCurrentCandidate(name, `🔍 分析中... ${card.geekDegree || ""} · ${card.geekWorkYear || ""}`);

      const verdict = evaluateGeek(geek);

      // 写入日志
      const entry = {
        name,
        degree: card.geekDegree || "",
        workYear: card.geekWorkYear || "",
        works,
        result: verdict.pass ? "pass" : "reject",
        reason: verdict.reason,
        detail: verdict.detail,
        time: getTimeStr(),
      };
      filterLog.push(entry);

      if (verdict.pass) {
        filterStats.passed++;
        result.push(geek);
        log(`✅ [${name}] 通过 → ${verdict.detail}`);

        addLiveFeedItem({
          icon: "✅", name, color: "#00b38a", bgColor: "#f0faf7",
          info: worksStr,
          detail: "筛选通过，等待打招呼",
        });
      } else {
        filterStats.rejected++;
        filterStats.reasons[verdict.reason] = (filterStats.reasons[verdict.reason] || 0) + 1;
        log(`❌ [${name}] 淘汰(${verdict.reason}) → ${verdict.detail}`);

        addLiveFeedItem({
          icon: "❌", name, color: "#ff4d4f", bgColor: "#fff5f5",
          info: worksStr,
          detail: `淘汰: ${verdict.reason}`,
        });
      }
    }

    hideCurrentCandidate();

    log(`📊 过滤: ${filterStats.total}总 → ${filterStats.passed}通过, ${filterStats.rejected}淘汰`);
    log("原因:", filterStats.reasons);

    updatePanelStats();
    updateLogPanel();

    return result;
  }

  // =====================================================================
  // ======================== API 调用 =================================
  // =====================================================================

  let nativeFetch = null;

  /** 调用推荐列表接口 */
  async function fetchGeekListDirect(page = 1) {
    const jobId = getJobId();
    if (!jobId) throw new Error("jobId 为空");

    const f = config.apiFilter;
    const params = new URLSearchParams({
      age: f.age, activation: f.activation, school: f.school,
      recentNotView: f.recentNotView, switchJobFrequency: f.switchJobFrequency,
      exchangeResumeWithColleague: f.exchangeResumeWithColleague,
      gender: f.gender, keyword1: f.keyword1, major: f.major,
      degree: f.degree, experience: f.experience,
      intention: f.intention, salary: f.salary, firstDegree: f.firstDegree,
      jobId, page, coverScreenMemory: 1, cardType: 0,
    });

    const url = `https://www.zhipin.com/wapi/zpjob/rec/geek/list?${params}`;
    log(`[API] 请求第 ${page} 页...`);

    const resp = await nativeFetch(url, {
      method: "GET",
      credentials: "include",
      headers: {
        Accept: "application/json, text/plain, */*",
        "X-Requested-With": "XMLHttpRequest",
      },
    });

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.message}`);
    return data;
  }

  /**
   * 调用 Boss 打招呼 API（v2.2 修复：使用 /wapi/zpjob/chat/start）
   *
   * v2.1 用的 /wapi/zpgeek/friend/add 已失效。
   * 正确的接口是 /wapi/zpjob/chat/start，参数如下：
   *   gid          - 加密的牛人 ID（encryptGeekId）
   *   suid         - 空
   *   jid          - 职位 ID（jobId）
   *   expectId     - 牛人的期望 ID
   *   lid          - 推荐链路追踪 ID
   *   greet        - 自定义打招呼语（空则用默认）
   *   from         - 空
   *   securityId   - 安全校验 ID
   *   customGreetingGuide - -1
   *
   * @param {Object} geek - 过滤通过的候选人对象（来自 geekList 数组元素）
   * @returns {boolean} 是否成功
   */
  async function greetGeekByApi(geek) {
    const card = geek.geekCard;
    if (!card) return false;

    // gid: 加密牛人 ID，可能在 geek 顶层或 geekCard 中
    const gid = geek.encryptGeekId || card.encryptGeekId || card.geekId || "";
    const securityId = card.securityId || "";
    const lid = card.lid || "";
    const expectId = card.expectId || "";
    const jid = getJobId();

    if (!gid || !securityId || !jid) {
      warn("缺少必要参数:", { gid: !!gid, securityId: !!securityId, jid: !!jid });
      return false;
    }

    const body = new URLSearchParams({
      gid,
      suid: "",
      jid,
      expectId: String(expectId),
      lid,
      greet: "",
      from: "",
      securityId,
      customGreetingGuide: "-1",
    });

    try {
      const resp = await nativeFetch("https://www.zhipin.com/wapi/zpjob/chat/start", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json, text/plain, */*",
          "X-Requested-With": "XMLHttpRequest",
        },
        body: body.toString(),
      });

      if (!resp.ok) {
        warn(`打招呼 HTTP 失败: ${resp.status}`);
        return false;
      }

      const data = await resp.json();

      if (data.code === 0) {
        log(`🤝 [${card.geekName}] 打招呼成功`);
        return true;
      } else if (data.code === 1) {
        log(`ℹ️ [${card.geekName}] 已沟通过 (code=1: ${data.message})`);
        return false;
      } else {
        warn(`[${card.geekName}] 打招呼异常: code=${data.code} msg=${data.message}`);
        return false;
      }
    } catch (err) {
      warn(`[${card.geekName}] 打招呼请求失败:`, err);
      return false;
    }
  }

  // =====================================================================
  // ======================== 主循环 ===================================
  // =====================================================================

  async function mainLoop() {
    if (!isRunning) return;

    if (!isWorkingHour()) {
      updateStatus("⏸ 不在工作时间，等待中...");
      mainLoopTimer = setTimeout(mainLoop, 5 * 60 * 1000);
      return;
    }

    if (getTodayGreetCount() >= config.maxGreetPerDay) {
      updateStatus(`🚫 今日已达上限 (${getTodayGreetCount()})`);
      stopAutoGreet();
      return;
    }

    updateStatus("🔄 正在运行...");

    let currentPage = 1;
    let totalGreeted = 0;

    // 随机打乱候选人顺序（不按列表顺序逐个打，降低风控风险）
    function shuffleArray(arr) {
      const a = [...arr];
      for (let i = a.length - 1; i > 0; i--) {
        const j = randomInt(0, i);
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    }

    try {
      while (isRunning && currentPage <= config.maxPages) {
        if (getTodayGreetCount() >= config.maxGreetPerDay) break;

        log(`\n======== 第 ${currentPage} 页 ========`);
        addLiveFeedItem({
          icon: "📄", name: `第 ${currentPage} 页`, color: "#1677ff", bgColor: "#f0f5ff",
          info: "正在拉取候选人列表...",
        });

        // Step 1: 调 API 获取候选人
        let apiData;
        try {
          apiData = await fetchGeekListDirect(currentPage);
        } catch (err) {
          warn("API 请求失败:", err.message);
          updateStatus("⚠️ API 请求失败，30s 后重试");
          addLiveFeedItem({
            icon: "⚠️", name: "API 错误", color: "#fa8c16", bgColor: "#fff7e6",
            info: err.message,
          });
          await sleep(30000, 60000);
          break;
        }

        const rawList = apiData?.zpData?.geekList || [];
        log(`API 返回 ${rawList.length} 个候选人`);

        if (rawList.length === 0) {
          log("没有更多候选人，结束本轮");
          addLiveFeedItem({
            icon: "📭", name: "无更多候选人", color: "#999", bgColor: "#f6f8fa",
            info: "本轮结束",
          });
          break;
        }

        // Step 2: 本地二次过滤
        const filtered = filterGeekList(rawList);
        log(`过滤后 ${filtered.length} 个符合条件`);

        if (filtered.length === 0) {
          log("本页无符合条件的候选人，翻下一页");
          currentPage++;
          await sleep(5000, 10000);
          continue;
        }

        // Step 3: 随机打乱顺序后，逐个调打招呼 API
        const shuffled = shuffleArray(filtered);
        let pageGreeted = 0;

        for (let i = 0; i < shuffled.length; i++) {
          if (!isRunning) break;
          if (getTodayGreetCount() >= config.maxGreetPerDay) break;

          const geek = shuffled[i];
          const card = geek.geekCard || {};
          const name = card.geekName || "未知";
          const worksStr = (card.geekWorks || []).map(w => `${w.company}·${w.positionCategory}`).join(" | ");

          // 显示当前正在打招呼的人
          showCurrentCandidate(name, `🤝 正在打招呼 (${i + 1}/${shuffled.length}) — ${worksStr}`);
          updateStatus(`🤝 打招呼: ${name} (${i + 1}/${shuffled.length})`);

          const success = await greetGeekByApi(geek);

          if (success) {
            pageGreeted++;
            totalGreeted++;
            const total = addTodayGreetCount();
            log(`✅ 已打招呼 ${name}（今日累计: ${total}/${config.maxGreetPerDay}）`);
            updatePanelGreetCount();

            // 更新 filterLog 中该候选人的状态
            const logEntry = filterLog.findLast(e => e.name === name && e.result === "pass");
            if (logEntry) logEntry.result = "greet_ok";

            addLiveFeedItem({
              icon: "🤝", name, color: "#52c41a", bgColor: "#f6ffed",
              info: worksStr,
              detail: `打招呼成功！今日 ${total}/${config.maxGreetPerDay}`,
            });
          } else {
            const logEntry = filterLog.findLast(e => e.name === name && e.result === "pass");
            if (logEntry) logEntry.result = "greet_fail";

            addLiveFeedItem({
              icon: "⚠️", name, color: "#fa8c16", bgColor: "#fff7e6",
              info: worksStr,
              detail: "打招呼失败或已沟通过",
            });
          }

          hideCurrentCandidate();
          updateLogPanel();

          // 每次打完随机等待（防封）
          if (i < shuffled.length - 1) {
            const delay = randomInt(config.greetDelayMin, config.greetDelayMax);
            log(`⏳ 等待 ${(delay / 1000).toFixed(1)}s...`);
            updateStatus(`⏳ 等待中 ${(delay / 1000).toFixed(0)}s`);
            await sleep(delay);
          }
        }

        log(`第 ${currentPage} 页完成，打了 ${pageGreeted} 个招呼`);

        // Step 4: 翻页等待
        if (isRunning && currentPage < config.maxPages) {
          const delay = randomInt(12000, 25000);
          log(`翻页等待 ${(delay / 1000).toFixed(1)}s...`);
          updateStatus(`⏳ 翻页等待 ${(delay / 1000).toFixed(0)}s`);
          await sleep(delay);
          currentPage++;
        } else {
          break;
        }
      }
    } catch (err) {
      warn("主循环异常:", err);
    }

    log(`\n本轮结束，共打了 ${totalGreeted} 个招呼`);

    if (isRunning) {
      const cooldown = randomInt(120000, 300000);
      log(`冷却 ${(cooldown / 1000 / 60).toFixed(1)} 分钟后继续...`);
      updateStatus(`😴 冷却 ${(cooldown / 1000 / 60).toFixed(1)}min`);
      mainLoopTimer = setTimeout(mainLoop, cooldown);
    }
  }

  // ======================== 启动 / 停止 ========================

  function startAutoGreet() {
    if (isRunning) return;
    const jobId = getJobId();
    if (!jobId) {
      alert("未找到 jobId！请确保在推荐牛人页面，或在面板中手动配置。");
      return;
    }
    isRunning = true;
    config.enabled = true;
    saveConfig();
    updateToggleBtn();
    log("🚀 自动打招呼已启动");

    addLiveFeedItem({
      icon: "🚀", name: "已启动", color: "#00b38a", bgColor: "#f0faf7",
      info: `jobId: ${jobId}`,
    });

    const delay = randomInt(2000, 5000);
    updateStatus(`🔄 ${(delay / 1000).toFixed(1)}s 后开始...`);
    mainLoopTimer = setTimeout(mainLoop, delay);
  }

  function stopAutoGreet() {
    isRunning = false;
    config.enabled = false;
    saveConfig();
    if (mainLoopTimer) { clearTimeout(mainLoopTimer); mainLoopTimer = null; }
    updateToggleBtn();
    hideCurrentCandidate();
    updateStatus(`⏸ 已暂停（今日: ${getTodayGreetCount()}/${config.maxGreetPerDay}）`);
    log("⏹ 已停止");

    addLiveFeedItem({
      icon: "⏹", name: "已停止", color: "#999", bgColor: "#f6f8fa",
      info: `今日已打 ${getTodayGreetCount()} 个招呼`,
    });
  }

  // =====================================================================
  // ======================== UI 面板 ==================================
  // =====================================================================

  let panelDOM = {};

  function updateStatus(text) {
    if (panelDOM.status) panelDOM.status.textContent = text;
  }

  function updateToggleBtn() {
    if (!panelDOM.toggleBtn) return;
    panelDOM.toggleBtn.textContent = isRunning ? "⏹ 停止" : "▶ 开始";
    panelDOM.toggleBtn.style.background = isRunning ? "#ff4d4f" : "#00b38a";
  }

  function updatePanelGreetCount() {
    if (panelDOM.greetCount) {
      panelDOM.greetCount.textContent = `${getTodayGreetCount()} / ${config.maxGreetPerDay}`;
    }
  }

  function updatePanelStats() {
    if (panelDOM.filterStats) {
      const s = filterStats;
      const reasonStr = Object.entries(s.reasons).map(([k, v]) => `${k}:${v}`).join("  ");
      panelDOM.filterStats.textContent = `总数: ${s.total} | 通过: ${s.passed} | 淘汰: ${s.rejected}  ${reasonStr}`;
    }
  }

  /** 更新日志面板内容 */
  function updateLogPanel() {
    const activeTab = document.querySelector(".bag-log-tab.active");
    if (activeTab) {
      updateLogPanelFiltered(activeTab.dataset.filter || "all");
    }
  }

  function createPanel() {
    GM_addStyle(`
      #bag-panel {
        position: fixed; top: 60px; right: 16px; z-index: 999999;
        background: #fff; border-radius: 14px;
        box-shadow: 0 6px 30px rgba(0,0,0,0.16);
        width: 380px; font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif;
        font-size: 13px; color: #333; user-select: none;
        transition: box-shadow 0.3s;
      }
      #bag-panel:hover { box-shadow: 0 8px 40px rgba(0,0,0,0.22); }
      #bag-panel * { box-sizing: border-box; }
      .bag-hd {
        display: flex; align-items: center; justify-content: space-between;
        padding: 12px 16px; cursor: move;
        background: linear-gradient(135deg, #00b38a 0%, #00c897 100%);
        border-radius: 14px 14px 0 0; color: #fff;
      }
      .bag-hd-title { font-size: 14px; font-weight: 600; }
      .bag-hd-btn { background: none; border: none; color: rgba(255,255,255,0.8); font-size: 18px; cursor: pointer; padding: 0 4px; }
      .bag-hd-btn:hover { color: #fff; }
      .bag-body { padding: 12px 16px; max-height: 700px; overflow-y: auto; transition: max-height 0.3s; }
      .bag-body.collapsed { max-height: 0; padding: 0 16px; overflow: hidden; }
      .bag-row { margin-bottom: 10px; }
      .bag-label { font-size: 12px; color: #888; margin-bottom: 3px; display: flex; align-items: center; gap: 4px; }
      .bag-input {
        width: 100%; padding: 6px 10px; border: 1px solid #e8e8e8; border-radius: 6px;
        font-size: 13px; color: #333; outline: none; transition: border 0.2s;
      }
      .bag-input:focus { border-color: #00b38a; }
      .bag-textarea { resize: vertical; min-height: 60px; font-family: inherit; line-height: 1.5; }
      .bag-flex { display: flex; gap: 8px; align-items: center; }
      .bag-num { width: 80px; text-align: center; }
      .bag-btn {
        padding: 7px 16px; border: none; border-radius: 8px; color: #fff;
        cursor: pointer; font-size: 13px; font-weight: 500; transition: opacity 0.15s;
      }
      .bag-btn:hover { opacity: 0.85; }
      .bag-btn:active { opacity: 0.7; }
      .bag-toggle { background: #00b38a; }
      .bag-save { background: #1677ff; }
      .bag-log-btn { background: #722ed1; }
      .bag-status {
        margin-top: 8px; padding: 8px 10px; background: #f6f8fa; border-radius: 8px;
        font-size: 12px; color: #666; line-height: 1.6;
      }
      .bag-stats {
        font-size: 11px; color: #999; margin-top: 4px; padding: 6px 10px;
        background: #fafafa; border-radius: 6px; word-break: break-all;
      }
      .bag-divider { height: 1px; background: #f0f0f0; margin: 10px 0; }
      .bag-switch { position: relative; display: inline-block; width: 36px; height: 20px; }
      .bag-switch input { opacity: 0; width: 0; height: 0; }
      .bag-slider {
        position: absolute; cursor: pointer; inset: 0;
        background: #ccc; border-radius: 20px; transition: 0.3s;
      }
      .bag-slider:before {
        content: ""; position: absolute; height: 16px; width: 16px;
        left: 2px; bottom: 2px; background: #fff; border-radius: 50%; transition: 0.3s;
      }
      .bag-switch input:checked + .bag-slider { background: #00b38a; }
      .bag-switch input:checked + .bag-slider:before { transform: translateX(16px); }

      /* 当前候选人高亮 */
      #bag-current {
        display: none; margin-top: 6px; padding: 8px 10px;
        background: linear-gradient(135deg, #fff7e6 0%, #fffbe6 100%);
        border: 1px solid #ffe58f; border-radius: 8px;
        animation: bag-pulse-border 1.5s ease infinite;
      }
      @keyframes bag-pulse-border {
        0%, 100% { border-color: #ffe58f; }
        50% { border-color: #ffa940; }
      }
      .bag-pulse {
        display: inline-block; width: 8px; height: 8px;
        background: #fa8c16; border-radius: 50%;
        animation: bag-pulse-dot 1s ease infinite;
      }
      @keyframes bag-pulse-dot {
        0%, 100% { opacity: 1; transform: scale(1); }
        50% { opacity: 0.4; transform: scale(0.7); }
      }
      @keyframes bag-fade-in {
        from { opacity: 0; transform: translateY(-4px); }
        to { opacity: 1; transform: translateY(0); }
      }

      /* 实时动态区 */
      #bag-live-feed {
        margin-top: 6px; max-height: 200px; overflow-y: auto;
        border: 1px solid #f0f0f0; border-radius: 8px; padding: 4px;
      }
      .bag-live-empty {
        padding: 16px; text-align: center; color: #ccc; font-size: 12px;
      }

      /* 日志弹窗 */
      #bag-log-modal {
        display: none; position: fixed; inset: 0; z-index: 9999999;
        background: rgba(0,0,0,0.4); justify-content: center; align-items: center;
      }
      #bag-log-modal.show { display: flex; }
      #bag-log-inner {
        background: #fff; border-radius: 14px; width: 520px; max-height: 80vh;
        display: flex; flex-direction: column; box-shadow: 0 10px 50px rgba(0,0,0,0.3);
      }
      #bag-log-header {
        display: flex; justify-content: space-between; align-items: center;
        padding: 14px 18px; background: linear-gradient(135deg, #722ed1 0%, #9254de 100%);
        border-radius: 14px 14px 0 0; color: #fff;
      }
      #bag-log-header span { font-size: 15px; font-weight: 600; }
      #bag-log-close {
        background: none; border: none; color: rgba(255,255,255,0.8);
        font-size: 22px; cursor: pointer; padding: 0 4px; line-height: 1;
      }
      #bag-log-close:hover { color: #fff; }
      #bag-log-tabs {
        display: flex; border-bottom: 1px solid #f0f0f0; padding: 0 18px;
      }
      .bag-log-tab {
        padding: 10px 14px; font-size: 13px; cursor: pointer; color: #999;
        border-bottom: 2px solid transparent; transition: 0.2s;
      }
      .bag-log-tab:hover { color: #333; }
      .bag-log-tab.active { color: #722ed1; border-bottom-color: #722ed1; font-weight: 500; }
      #bag-log-list {
        flex: 1; overflow-y: auto; min-height: 200px; max-height: 60vh;
        font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif;
      }
    `);

    const panel = document.createElement("div");
    panel.id = "bag-panel";

    const companyStr = config.companyWhiteList.join(", ");
    const posStr = config.positionKeywords.join(", ");

    panel.innerHTML = `
      <div class="bag-hd" id="bag-hd">
        <span class="bag-hd-title">🤖 自动打招呼 v2.2</span>
        <button class="bag-hd-btn" id="bag-collapse" title="折叠/展开">—</button>
      </div>
      <div class="bag-body" id="bag-body">

        <!-- 开始/停止 + 日志 -->
        <div class="bag-row bag-flex" style="justify-content:space-between;">
          <div class="bag-flex" style="gap:6px;">
            <button class="bag-btn bag-toggle" id="bag-toggle">▶ 开始</button>
            <button class="bag-btn bag-log-btn" id="bag-log-open">📋 日志</button>
          </div>
          <span style="font-size:12px;color:#999;">今日: <b id="bag-greet-count">${getTodayGreetCount()} / ${config.maxGreetPerDay}</b></span>
        </div>

        <!-- 状态 -->
        <div class="bag-status" id="bag-status">⏸ 待启动</div>

        <!-- 当前正在处理的候选人（黄色高亮） -->
        <div id="bag-current"></div>

        <!-- 实时动态 -->
        <div id="bag-live-feed">
          <div class="bag-live-empty">启动后这里会实时显示筛选和打招呼动态</div>
        </div>

        <div class="bag-stats" id="bag-filter-stats">过滤统计：暂无数据</div>

        <div class="bag-divider"></div>

        <!-- 公司白名单 -->
        <div class="bag-row">
          <div class="bag-label">🏢 公司白名单 <span style="color:#bbb;font-size:11px;">（逗号分隔，模糊匹配）</span></div>
          <textarea class="bag-input bag-textarea" id="bag-companies" rows="4">${companyStr}</textarea>
        </div>

        <!-- 职位关键词 -->
        <div class="bag-row">
          <div class="bag-label">💼 职位关键词 <span style="color:#bbb;font-size:11px;">（逗号分隔，匹配 positionCategory）</span></div>
          <input class="bag-input" id="bag-positions" value="${posStr}" />
        </div>

        <!-- 排除应届生 -->
        <div class="bag-row bag-flex" style="justify-content:space-between;">
          <div class="bag-label" style="margin:0;">🎓 排除应届生</div>
          <label class="bag-switch">
            <input type="checkbox" id="bag-exclude-fresh" ${config.excludeFreshGraduate ? "checked" : ""} />
            <span class="bag-slider"></span>
          </label>
        </div>

        <div class="bag-divider"></div>

        <!-- 每日上限 -->
        <div class="bag-row bag-flex" style="justify-content:space-between;">
          <div class="bag-label" style="margin:0;">📊 每日上限</div>
          <input class="bag-input bag-num" type="number" id="bag-limit" value="${config.maxGreetPerDay}" min="1" max="200" />
        </div>

        <!-- 速度 -->
        <div class="bag-row">
          <div class="bag-label">⏱ 打招呼间隔（秒）</div>
          <div class="bag-flex">
            <input class="bag-input bag-num" type="number" id="bag-delay-min" value="${(config.greetDelayMin / 1000).toFixed(0)}" min="1" max="60" />
            <span style="color:#999;">~</span>
            <input class="bag-input bag-num" type="number" id="bag-delay-max" value="${(config.greetDelayMax / 1000).toFixed(0)}" min="2" max="120" />
            <span style="color:#bbb;font-size:11px;">秒</span>
          </div>
        </div>

        <!-- JobId -->
        <div class="bag-row">
          <div class="bag-label">🔑 jobId <span style="color:#bbb;font-size:11px;">（空则自动提取）</span></div>
          <input class="bag-input" id="bag-jobid" value="${config.jobId || extractJobIdFromUrl()}" placeholder="自动从URL提取" />
        </div>

        <div class="bag-divider"></div>

        <!-- 保存按钮 -->
        <div class="bag-row" style="text-align:right;">
          <button class="bag-btn bag-save" id="bag-save">💾 保存配置</button>
        </div>

      </div>
    `;

    document.body.appendChild(panel);

    // —— 日志弹窗 ——
    const logModal = document.createElement("div");
    logModal.id = "bag-log-modal";
    logModal.innerHTML = `
      <div id="bag-log-inner">
        <div id="bag-log-header">
          <span>📋 筛选日志</span>
          <button id="bag-log-close">&times;</button>
        </div>
        <div id="bag-log-tabs">
          <div class="bag-log-tab active" data-filter="all">全部</div>
          <div class="bag-log-tab" data-filter="pass">✅ 通过</div>
          <div class="bag-log-tab" data-filter="reject">❌ 淘汰</div>
          <div class="bag-log-tab" data-filter="greet_ok">🤝 已打招呼</div>
        </div>
        <div id="bag-log-list"></div>
      </div>
    `;
    document.body.appendChild(logModal);

    // 缓存 DOM
    panelDOM.status = document.getElementById("bag-status");
    panelDOM.filterStats = document.getElementById("bag-filter-stats");
    panelDOM.toggleBtn = document.getElementById("bag-toggle");
    panelDOM.greetCount = document.getElementById("bag-greet-count");

    // —— 事件绑定 ——

    panelDOM.toggleBtn.addEventListener("click", () => {
      applyPanelConfig();
      if (isRunning) stopAutoGreet(); else startAutoGreet();
    });

    document.getElementById("bag-save").addEventListener("click", () => {
      applyPanelConfig();
      saveConfig();
      alert("✅ 配置已保存！");
    });

    // 折叠
    const body = document.getElementById("bag-body");
    let collapsed = false;
    document.getElementById("bag-collapse").addEventListener("click", (e) => {
      collapsed = !collapsed;
      body.classList.toggle("collapsed", collapsed);
      e.target.textContent = collapsed ? "+" : "—";
    });

    // 日志弹窗
    let currentFilter = "all";
    document.getElementById("bag-log-open").addEventListener("click", () => {
      updateLogPanelFiltered(currentFilter);
      logModal.classList.add("show");
    });
    document.getElementById("bag-log-close").addEventListener("click", () => {
      logModal.classList.remove("show");
    });
    logModal.addEventListener("click", (e) => {
      if (e.target === logModal) logModal.classList.remove("show");
    });

    // 日志 Tab 切换
    document.querySelectorAll(".bag-log-tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        document.querySelectorAll(".bag-log-tab").forEach(t => t.classList.remove("active"));
        tab.classList.add("active");
        currentFilter = tab.dataset.filter;
        updateLogPanelFiltered(currentFilter);
      });
    });

    // 拖拽
    makeDraggable(panel, document.getElementById("bag-hd"));

    updateToggleBtn();
    log("✅ 控制面板已创建");
  }

  /** 按 tab 过滤显示日志 */
  function updateLogPanelFiltered(filter) {
    const container = document.getElementById("bag-log-list");
    if (!container) return;

    let entries = filterLog.slice(-200).reverse();
    if (filter === "pass") entries = entries.filter(e => e.result === "pass");
    if (filter === "reject") entries = entries.filter(e => e.result === "reject");
    if (filter === "greet_ok") entries = entries.filter(e => e.result === "greet_ok");

    if (entries.length === 0) {
      container.innerHTML = '<div style="padding:30px;text-align:center;color:#bbb;font-size:13px;">暂无记录</div>';
      return;
    }

    const resultMap = {
      pass: { icon: "✅", label: "筛选通过", color: "#52c41a", bg: "#f0faf7" },
      reject: { icon: "❌", label: "已淘汰", color: "#ff4d4f", bg: "#fff5f5" },
      greet_ok: { icon: "🤝", label: "已打招呼", color: "#00b38a", bg: "#e6fffb" },
      greet_fail: { icon: "⚠️", label: "打招呼失败", color: "#fa8c16", bg: "#fff7e6" },
    };

    container.innerHTML = entries.map((entry) => {
      const r = resultMap[entry.result] || resultMap.reject;
      const worksStr = entry.works.map(w => `${w.company}·${w.position}`).join(" | ");

      return `
        <div style="padding:10px 14px;border-bottom:1px solid #f5f5f5;background:${r.bg};line-height:1.6;">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <span style="font-weight:600;color:${r.color};font-size:13px;">${r.icon} ${entry.name}</span>
            <span style="font-size:10px;color:#bbb;">${entry.time}</span>
          </div>
          <div style="font-size:11px;color:#666;margin-top:2px;">
            ${entry.degree} · ${entry.workYear}
          </div>
          <div style="font-size:11px;color:#888;margin-top:3px;">
            📋 经历: ${worksStr || "无"}
          </div>
          <div style="font-size:11px;color:${r.color};margin-top:3px;font-weight:500;">
            ${r.icon} ${r.label}${entry.result === "reject" ? `: ${entry.reason}` : ""}
          </div>
          ${entry.result === "reject" ? `<div style="font-size:10px;color:#999;margin-top:2px;">${entry.detail}</div>` : ""}
        </div>
      `;
    }).join("");
  }

  /** 从面板读取配置 */
  function applyPanelConfig() {
    const companyRaw = document.getElementById("bag-companies").value;
    config.companyWhiteList = companyRaw.split(/[,，\n]/).map(s => s.trim()).filter(Boolean);

    const posRaw = document.getElementById("bag-positions").value;
    config.positionKeywords = posRaw.split(/[,，\n]/).map(s => s.trim()).filter(Boolean);

    config.excludeFreshGraduate = document.getElementById("bag-exclude-fresh").checked;
    config.maxGreetPerDay = parseInt(document.getElementById("bag-limit").value) || 80;

    const delayMin = parseInt(document.getElementById("bag-delay-min").value) || 4;
    const delayMax = parseInt(document.getElementById("bag-delay-max").value) || 9;
    config.greetDelayMin = Math.max(1, delayMin) * 1000;
    config.greetDelayMax = Math.max(delayMin + 1, delayMax) * 1000;

    const jid = document.getElementById("bag-jobid").value.trim();
    if (jid) config.jobId = jid;

    log("面板配置已应用:", {
      companies: config.companyWhiteList.length + "家",
      positions: config.positionKeywords,
      excludeFresh: config.excludeFreshGraduate,
      limit: config.maxGreetPerDay,
      delay: `${config.greetDelayMin / 1000}~${config.greetDelayMax / 1000}s`,
    });
  }

  /** 拖拽 */
  function makeDraggable(el, handle) {
    let ox = 0, oy = 0, dragging = false;
    handle.addEventListener("mousedown", (e) => {
      if (e.target.tagName === "BUTTON") return;
      dragging = true;
      ox = e.clientX - el.getBoundingClientRect().left;
      oy = e.clientY - el.getBoundingClientRect().top;
      el.style.transition = "none";
    });
    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      el.style.left = (e.clientX - ox) + "px";
      el.style.top = (e.clientY - oy) + "px";
      el.style.right = "auto";
    });
    document.addEventListener("mouseup", () => {
      dragging = false;
      el.style.transition = "box-shadow 0.3s";
    });
  }

  // =====================================================================
  // ======================== 测试用例 =================================
  // =====================================================================

  /**
   * 自包含测试：验证 filterGeekList / evaluateGeek 的正确性
   * 在浏览器 Console 里手动执行 window.__BAG_RUN_TESTS() 即可运行
   * 不会自动执行，不会污染 filterLog
   */
  function runTests() {
    const results = [];
    let passed = 0;
    let failed = 0;

    function assert(testName, condition, detail) {
      if (condition) { passed++; results.push({ name: testName, ok: true, detail }); }
      else { failed++; results.push({ name: testName, ok: false, detail }); }
    }

    // 保存并替换配置和日志
    const origConfig = config;
    const origLog = filterLog;
    filterLog = [];
    config = {
      ...DEFAULT_CONFIG,
      companyWhiteList: [...DEFAULT_COMPANY_LIST],
      positionKeywords: ["算法"],
      excludeFreshGraduate: true,
    };

    // ---- 测试数据 ----

    const geekHeXinYu = {
      geekCard: {
        geekName: "何欣雨", geekWorkYear: "7年", geekDegree: "硕士", freshGraduate: 0,
        geekWorks: [
          { company: "微财", positionCategory: "大模型算法" },
          { company: "瓴岳", positionCategory: "算法工程师" },
        ],
        securityId: "test", lid: "test", expectId: 1,
      },
    };

    const geekFreshGrad = {
      geekCard: {
        geekName: "李亚聪", geekWorkYear: "26年应届生", geekDegree: "硕士", freshGraduate: 3,
        geekWorks: [
          { company: "网易", positionCategory: "大模型算法" },
          { company: "美团", positionCategory: "大模型算法" },
        ],
        securityId: "test", lid: "test", expectId: 2,
      },
    };

    const geekGood = {
      geekCard: {
        geekName: "张三", geekWorkYear: "5年", geekDegree: "硕士", freshGraduate: 0,
        geekWorks: [
          { company: "百度", positionCategory: "搜索算法" },
          { company: "小创公司", positionCategory: "后端开发" },
        ],
        securityId: "test", lid: "test", expectId: 3,
      },
    };

    const geekWrongPos = {
      geekCard: {
        geekName: "王五", geekWorkYear: "3年", geekDegree: "本科", freshGraduate: 0,
        geekWorks: [{ company: "美团", positionCategory: "Java开发" }],
        securityId: "test", lid: "test", expectId: 4,
      },
    };

    const geekFreshFlag = {
      geekCard: {
        geekName: "赵六", geekWorkYear: "1年", geekDegree: "硕士", freshGraduate: 1,
        geekWorks: [{ company: "腾讯", positionCategory: "推荐算法" }],
        securityId: "test", lid: "test", expectId: 5,
      },
    };

    const geekAIStartup = {
      geekCard: {
        geekName: "孙七", geekWorkYear: "2年", geekDegree: "硕士", freshGraduate: 0,
        geekWorks: [{ company: "智谱AI", positionCategory: "NLP算法" }],
        securityId: "test", lid: "test", expectId: 6,
      },
    };

    // ---- 执行测试 ----

    log("\n🧪 ======== 开始运行测试 ========");

    let v = evaluateGeek(geekHeXinYu);
    assert("何欣雨: 公司不匹配应淘汰", !v.pass, `reason=${v.reason}`);

    v = evaluateGeek(geekFreshGrad);
    assert("李亚聪: 应届生应淘汰", !v.pass && v.reason === "应届生", `reason=${v.reason}`);

    v = evaluateGeek(geekGood);
    assert("张三: 百度+算法应通过", v.pass, `reason=${v.reason}`);

    v = evaluateGeek(geekWrongPos);
    assert("王五: 美团+Java应淘汰", !v.pass && v.reason === "职位不匹配", `reason=${v.reason}`);

    v = evaluateGeek(geekFreshFlag);
    assert("赵六: freshGraduate=1应淘汰", !v.pass && v.reason === "应届生", `reason=${v.reason}`);

    v = evaluateGeek(geekAIStartup);
    assert("孙七: 智谱AI+算法应通过", v.pass, `reason=${v.reason}`);

    // 恢复
    config = origConfig;
    filterLog = origLog;

    log(`\n🧪 测试完成: ✅ ${passed}  ❌ ${failed}`);
    results.forEach(r => {
      if (r.ok) log(`  ✅ ${r.name}`);
      else warn(`  ❌ ${r.name} (${r.detail})`);
    });

    return { passed, failed, results };
  }

  window.__BAG_RUN_TESTS = runTests;

  // ======================== 入口 ========================

  function init() {
    if (!window.location.href.includes("/web/frame")) {
      log("不在目标页面，脚本不启动");
      return;
    }

    log("====================================");
    log("   BOSS自动打招呼 v2.2.0");
    log("====================================");
    log("jobId:", getJobId() || "待自动提取");
    log("今日已打招呼:", getTodayGreetCount());

    createPanel();

    // 注意：测试不再自动运行，需手动在 Console 中执行 __BAG_RUN_TESTS()
  }

  // —— 启动 ——
  (function bootstrap() {
    nativeFetch = window.fetch.bind(window);
    loadConfig();

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => {
        setTimeout(init, randomInt(2000, 4000));
      });
    } else {
      setTimeout(init, randomInt(2000, 4000));
    }
  })();

})();
