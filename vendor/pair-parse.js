/* generated from app.js Excel parser (v25) — used by admin.html */
(function(){
  const KEYS = "ABCDEF";
  function parseXlsx(buf, sourceFile) {
    const wb = XLSX.read(buf, { type: "array" });
    let sheetName = wb.SheetNames.includes("总表")
      ? "总表"
      : wb.SheetNames.reduce((best, name) => {
          const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: "" });
          const n = rows.filter((r) => r.some((c) => String(c).trim())).length;
          return !best || n > best.n ? { name, n } : best;
        }, null)?.name || wb.SheetNames[0];
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: "" }).map((r) =>
      r.map((c) => String(c == null ? "" : c).trim())
    );
    if (!rows.length) throw new Error("Excel 为空");
    const headerIdxMap = findExcelHeader(rows.slice(0, 5));
    if (headerIdxMap.map) return parseWithHeader(rows.slice(headerIdxMap.idx + 1), headerIdxMap.map, sourceFile);
    const out = [];
    for (const r of rows) {
      if (!r[0] || !r[1]) continue;
      if (/题干|题目|question/i.test(r[0])) continue;
      const options = r.slice(2, 8).filter((x) => x);
      out.push({
        stem: r[0],
        answer: r[1],
        options: options.length ? options : null,
        explanation: "",
        source_file: sourceFile,
        qtype: options.length ? "choice" : "short",
        tags: "",
        difficulty: null,
        raw_qtype: "",
      });
    }
    return out;
  }

  function normalizeImportedAnswer(answer, options) {
    let a = String(answer || "").trim();
    if (!a) return "";
    if (/\.0$/.test(a) && !isNaN(Number(a))) a = String(parseInt(a, 10));
    // numeric indices 1-based, possibly multi "1234" -> "ABCD"
    if (/^[1-6]+$/.test(a) && options && options.length) {
      const letters = [];
      for (const ch of a) {
        const idx = Number(ch) - 1;
        if (idx < 0 || idx >= options.length) return String(answer).trim();
        letters.push("ABCDEF"[idx]);
      }
      return letters.join("");
    }
    return a.replace(/\s+/g, "").toUpperCase();
  }

  function findExcelHeader(candidateRows) {
    for (let idx = 0; idx < candidateRows.length; idx++) {
      const map = detectHeader(candidateRows[idx]);
      if (map) return { idx, map };
    }
    return { idx: -1, map: null };
  }
  function detectHeader(row) {
    const mapping = {};
    const reStem = /题干|题目|question|stem/i;
    const reAns = /正确答案|答案|answer/i;
    const reExp = /解析|explanation|详解/i;
    const reOpt = /^(?:选项)?([A-Fa-f])$|^选项([A-Fa-f])$/i;
    const reOptCN = /^选项([一二三四五六123456])$/;
    const reTag = /标签|tags?/i;
    const reDiff = /难度/;
    const reQtype = /题型/;
    for (let i = 0; i < row.length; i++) {
      const cell = (row[i] || "").replace(/\s+/g, "");
      if (!cell) continue;
      const m = cell.match(reOpt);
      if (m) {
        mapping["opt_" + (m[1] || m[2]).toUpperCase()] = i;
        continue;
      }
      const mcn = cell.match(reOptCN);
      if (mcn) {
        const mapCN = { 一: "A", 二: "B", 三: "C", 四: "D", 五: "E", 六: "F", "1": "A", "2": "B", "3": "C", "4": "D", "5": "E", "6": "F" };
        const L = mapCN[mcn[1]];
        if (L) mapping["opt_" + L] = i;
        continue;
      }
      if (cell === "解释" && mapping.explanation == null) {
        mapping.explanation = i;
        continue;
      }
      if ((cell === "题目类型" || cell === "题型") && mapping.raw_qtype == null) {
        mapping.raw_qtype = i;
        continue;
      }
      if ("ABCDEF".includes(cell.toUpperCase()) && cell.length === 1) {
        mapping["opt_" + cell.toUpperCase()] = i;
        continue;
      }
      if (reStem.test(cell) && mapping.stem == null) {
        if (cell.includes("信息") && !cell.includes("题目（") && cell !== "题目") continue;
        if (cell.includes("类型") || cell.includes("题型")) continue;
        mapping.stem = i;
        continue;
      }
      if (reAns.test(cell) && mapping.answer == null) {
        mapping.answer = i;
        continue;
      }
      if (reExp.test(cell) && mapping.explanation == null) {
        mapping.explanation = i;
        continue;
      }
      if (reTag.test(cell) && mapping.tags == null) {
        mapping.tags = i;
        continue;
      }
      if (reDiff.test(cell) && mapping.difficulty == null) {
        mapping.difficulty = i;
        continue;
      }
      if (reQtype.test(cell) && mapping.raw_qtype == null) {
        mapping.raw_qtype = i;
        continue;
      }
    }
    if (mapping.stem != null && (mapping.answer != null || mapping.opt_A != null)) return mapping;
    return null;
  }
  function parseWithHeader(dataRows, map, sourceFile) {
    const out = [];
    for (const r of dataRows) {
      const stem = (r[map.stem] || "").trim();
      if (!stem) continue;
      const options = [];
      for (const L of KEYS) {
        const key = "opt_" + L;
        if (map[key] != null) {
          const v = (r[map[key]] || "").trim();
          if (v) options.push(v);
        }
      }
      let answer = map.answer != null ? (r[map.answer] || "").trim() : "";
      answer = normalizeImportedAnswer(answer, options);
      if (!answer && !options.length) continue;
      out.push({
        stem,
        answer: answer || (options[0] || ""),
        options: options.length ? options : null,
        explanation: map.explanation != null ? (r[map.explanation] || "").trim() : "",
        source_file: sourceFile,
        qtype: options.length ? "choice" : "short",
        tags: map.tags != null ? (r[map.tags] || "").trim() : "",
        difficulty: map.difficulty != null && r[map.difficulty] !== "" ? Number(r[map.difficulty]) || null : null,
        raw_qtype: map.raw_qtype != null ? (r[map.raw_qtype] || "").trim() : "",
      });
    }
    return out;
  }

  window.PairParse = { parseXlsx: parseXlsx };
})();
