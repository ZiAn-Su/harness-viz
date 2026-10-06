/* Teaching diagrams: one structural definition for the page, audits and draw.io export. */
globalThis.HarnessFlows = (() => {
  const size = { width: 700, height: 1070 }
  const node = (id, title, detail, shape, x, y, width = 230, parent = "main-loop") =>
    ({ id, title, detail, shape, x, y, width, height: 64, parent })
  const edge = (from, to, path, label = "", lx = 0, ly = 0, kind = "normal") =>
    ({ from, to, path, label, lx, ly, kind })
  const graphs = {}
  for (const harness of ["opencode", "codex"]) {
    const codex = harness === "codex"
    const id = name => codex ? "c-" + name : name
    const context = codex ? "context" : "loop"
    const budget = codex ? "budget" : "subflow3"
    const compact = codex ? "compact" : "subflow2"
    const feedback = codex ? "feedback" : "exec"
    const modelY = codex ? 288 : 464
    const toolY = modelY + 88
    const childY = toolY + 190
    const regularY = toolY + 276
    const feedbackY = codex ? 720 : 808
    const followY = codex ? 808 : 896
    const nodes = [
      node(id("ui"), "开始任务", "说明目标与要求", "terminal", 250, 0, 200, null),
      node(id("server"), "运行准备", "项目目录 · 模型 · 工具", "process", 250, 80, 200, null),
      node(id(context), codex ? "整理上下文" : "读取历史", "任务要求 · 已有结果", "process", 70, 200),
      node(id(budget), codex ? "需切换上下文?" : "容量不足?", "", "decision", codex ? 430 : 100, codex ? 200 : 376, 170),
      { ...node(id(compact), "执行压缩", "模型摘要 / 上下文调整", "process", 400, codex ? 288 : 376), ...(codex ? { exceptions: ["压缩失败 / 中断"] } : {}) },
      { ...node(id("llm"), "调用模型", "装配输入 · 生成输出", "process", 70, modelY), exceptions: ["终止异常"] },
      node(id("decide2"), "需客户端派发?", "", "decision", 100, toolY, 170),
      { ...node(id("delegate"), "子任务工具?", "按处理器类别归并", "decision", 430, toolY, 170), evidence: "grouped" },
      node(id("sub"), "管理子任务", "能力取决于版本与配置", "subprocess", 400, childY, 230, id("sandbox")),
      node(id("tool"), "执行工具", "读写文件 · 命令 · 外部服务", "process", 400, regularY, 230, id("sandbox")),
      { ...node(id(feedback), "汇总反馈", "信息在输出 / 执行时记录", "process", 70, feedbackY), evidence: "grouped" },
      node(id("decide"), codex ? "还需处理?" : "请求已完成?", "", "decision", codex ? 100 : 430, codex ? followY : 200, 170),
      node(id("done"), codex ? "本轮返回" : "会话转空闲", codex ? "上层仍可续行或完成" : "保留完成 / 失败 / 中断状态", "terminal", 250, 994, 200, null),
      { ...node(id("sandbox"), "环境与权限", "检查发生在各自处理器内", "environment", 366, childY - 34, 300), height: 218 },
    ]
    if (codex) nodes.push(
      node("c-compact-next", "启动检查阻断?", "", "decision", 100, 464, 170),
      { ...node("c-stop", "收尾结果?", "", "decision", 100, 896, 170), branches: 3 },
      node("c-finalize", "收尾维护", "检查阈值 · 按需压缩", "process", 400, 896),
    )
    else nodes.push(
      { ...node("subflow1", "取出哪类待办?", "", "decision", 430, 288, 170), branches: 3 },
      node("compact-result", "压缩可继续?", "", "decision", 100, 288, 170),
      node("pre-sub", "执行指定任务", "写回结果 · 直接下一轮", "subprocess", 70, 640),
      node("schedule", "安排压缩", "创建任务标记，不是执行摘要", "process", 400, 464),
      { ...node("outcome", "本轮处理结果?", "", "decision", 100, 896, 170), branches: 3 },
    )
    const edges = [
      edge(id("ui"), id("server"), "M350,64 L350,80"),
      edge(id("server"), id(context), "M350,144 L350,160 L185,160 L185,200"),
      edge(id("llm"), id("decide2"), `M185,${modelY + 64} L185,${toolY}`),
      edge(id("decide2"), id("delegate"), `M270,${toolY + 32} L430,${toolY + 32}`, "是", 330, toolY + 24),
      edge(id("decide2"), id(feedback), `M100,${toolY + 32} L56,${toolY + 32} L56,${feedbackY - 14} L185,${feedbackY - 14} L185,${feedbackY}`, "否", 60, feedbackY - 20),
      edge(id("delegate"), id("sub"), `M515,${toolY + 64} L515,${childY}`, "子任务", 526, toolY + 83, "child"),
      edge(id("delegate"), id("tool"), `M600,${toolY + 32} L648,${toolY + 32} L648,${regularY + 32} L630,${regularY + 32}`, "普通工具", 607, toolY + 24),
      edge(id("sub"), id(feedback), `M400,${childY + 32} L340,${childY + 32} L340,${feedbackY + 32} L300,${feedbackY + 32}`, "反馈", 348, childY + 51, "child"),
      edge(id("tool"), id(feedback), `M400,${regularY + 32} L340,${regularY + 32} L340,${feedbackY + 32} L300,${feedbackY + 32}`),
      edge(id(feedback), codex ? "c-decide" : "outcome", `M185,${feedbackY + 64} L185,${followY}`),
      edge(id("llm"), id("done"), `M70,${modelY + 32} L8,${modelY + 32} L8,1026 L250,1026`, "终止异常", 14, modelY + 22, "exit"),
    ]
    if (codex) {
      edges.push(
        edge(id(context), id("llm"), "M185,264 L185,288"),
        edge("c-compact", "c-compact-next", "M400,320 L322,320 L322,496 L270,496"),
        edge("c-compact-next", "c-context", "M185,464 L185,452 L64,452 L64,248 L70,248", "否 · 重新准备", 78, 450, "loop"),
        edge("c-compact-next", "c-done", "M100,496 L20,496 L20,1026 L250,1026", "是", 30, 486),
        edge(id("decide"), id(budget), "M270,840 L690,840 L690,232 L600,232", "是", 298, 832, "loop"),
        edge(id(budget), id(compact), "M515,264 L515,288", "是", 526, 280),
        edge(id(budget), id(context), "M430,232 L300,232", "否", 356, 224, "loop"),
        edge(id("decide"), id("stop"), "M185,872 L185,896", "否", 198, 888),
        edge(id("stop"), id(context), "M100,928 L42,928 L42,232 L70,232", "追加工作", 44, 916, "loop"),
        edge(id("stop"), id("done"), "M185,960 L185,978 L350,978 L350,994", "提前返回", 215, 973),
        edge("c-stop", "c-finalize", "M270,928 L400,928", "正常收尾", 310, 920),
        edge("c-finalize", "c-done", "M515,960 L515,978 L350,978 L350,994"),
        edge("c-compact", "c-done", "M630,320 L698,320 L698,1026 L450,1026", "压缩失败 / 中断", 558, 281, "exit"),
      )
    } else {
      edges.push(
        edge("loop", "decide", "M300,232 L430,232"),
        edge("decide", "done", "M600,232 L698,232 L698,1026 L450,1026", "已完成", 612, 224),
        edge("decide", "subflow1", "M515,264 L515,288", "未完成", 526, 280),
        edge("subflow1", "pre-sub", "M600,320 L682,320 L682,620 L322,620 L322,672 L300,672", "子任务", 614, 312, "child"),
        edge("subflow1", "subflow2", "M515,352 L515,376", "压缩", 526, 367),
        edge("subflow1", "subflow3", "M430,320 L350,320 L350,364 L185,364 L185,376", "无待办", 362, 312),
        edge("pre-sub", "loop", "M70,672 L42,672 L42,232 L70,232", "下一轮", 43, 632, "loop"),
        edge("subflow3", "schedule", "M270,408 L314,408 L314,452 L515,452 L515,464", "是", 280, 400),
        edge("subflow3", "llm", "M185,440 L185,464", "否", 198, 458),
        edge("schedule", "loop", "M400,496 L344,496 L344,248 L300,248", "下一轮", 350, 483, "loop"),
        edge("subflow2", "compact-result", "M400,408 L326,408 L326,320 L270,320"),
        edge("compact-result", "loop", "M185,288 L185,264", "是", 198, 281, "loop"),
        edge("compact-result", "done", "M100,320 L20,320 L20,1026 L250,1026", "否", 30, 310),
        edge("outcome", "loop", "M100,928 L42,928 L42,232 L70,232", "继续", 43, 918, "loop"),
        edge("outcome", "schedule", "M270,928 L320,928 L320,540 L515,540 L515,528", "需压缩", 278, 918),
        edge("outcome", "done", "M185,960 L185,978 L350,978 L350,994", "结束", 236, 973),
      )
    }
    graphs[harness] = {
      name: harness === "opencode" ? "OpenCode" : "Codex",
      nodes, edges,
      regions: [{ id: "main-loop", title: codex ? "本轮处理的主循环" : "会话处理的主循环", x: 14, y: 178, width: 682, height: 802, parent: null }],
    }
  }
  const escape = text => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
  const pointsOf = path => [...path.matchAll(/[ML](-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g)].map(m => [Number(m[1]), Number(m[2])])
  const segmentsOf = path => {
    const points = pointsOf(path)
    return points.slice(1).map((b, i) => [points[i], b])
  }
  // A gap at a strict crossing means the wires are not connected. Shared
  // endpoints and collinear result-merge segments are left intact.
  function crossingGaps(path, previousPaths) {
    const crossings = new Map()
    for (const [a, b] of segmentsOf(path)) for (const previous of previousPaths) for (const [c, d] of segmentsOf(previous)) {
      const vertical = a[0] === b[0], otherVertical = c[0] === d[0]
      if (vertical === otherVertical) continue
      const v = vertical ? [a, b] : [c, d]
      const h = vertical ? [c, d] : [a, b]
      const x = v[0][0], y = h[0][1]
      if (x > Math.min(h[0][0], h[1][0]) && x < Math.max(h[0][0], h[1][0]) && y > Math.min(v[0][1], v[1][1]) && y < Math.max(v[0][1], v[1][1]))
        crossings.set(x + ":" + y, [x, y])
    }
    return [...crossings.values()].map(([x, y]) => `<circle class="wire-gap" cx="${x}" cy="${y}" r="4"><title>交叉不连接</title></circle>`).join("")
  }
  function render(harness) {
    const graph = graphs[harness]
    const prefix = harness === "codex" ? "cx" : "oc"
    const markers = ["normal", "loop", "child", "exit"].map(kind => `<marker id="${prefix}-${kind}" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path class="arrow-${kind}" d="M0,0 L8,4 L0,8 z"/></marker>`).join("")
    const regionHTML = region => `<rect class="${region.id === "main-loop" ? "loopbox" : "childloop"}" data-region="${region.id}" x="${region.x}" y="${region.y}" width="${region.width}" height="${region.height}" rx="14"/><text class="${region.id === "main-loop" ? "boxlbl" : "childlbl"}" x="${region.x + 14}" y="${region.y + 17}">${escape(region.title)}</text>`
    const environment = graph.nodes.find(n => n.shape === "environment")
    const area = `<rect class="envbox" x="${environment.x}" y="${environment.y}" width="${environment.width}" height="${environment.height}" rx="12"/>`
    const drawnPaths = []
    const wires = graph.edges.map(e => {
      const gaps = crossingGaps(e.path, drawnPaths)
      drawnPaths.push(e.path)
      return `${gaps}<path class="flow-edge ${e.kind === "loop" ? "loop" : e.kind === "child" ? "subedge" : e.kind === "exit" ? "exitedge" : ""}" data-from="${e.from}" data-to="${e.to}" data-branch="${escape(e.label)}" d="${e.path}" marker-end="url(#${prefix}-${e.kind})"/>`
    }).join("")
    const labels = graph.edges.filter(e => e.label).map(e => `<text class="lbl ${e.kind === "loop" ? "lbl2" : ""}" x="${e.lx}" y="${e.ly}">${escape(e.label)}</text>`).join("")
    const boxes = graph.nodes.map(n => {
      const style = `left:${n.x}px;top:${n.y}px;width:${n.width}px`
      const evidence = n.evidence === "grouped" ? ' data-evidence="grouped" title="按职责归并；不表示一个独立函数或统一判断"' : ""
      const count = `<span class="cnt" id="cnt-${n.id}" title="相关观测数量；具体统计口径见运行细节"></span>`
      if (n.shape === "environment") return `<div class="zone-label" data-node="${n.id}" data-shape="environment" id="fn-${n.id}" style="left:${n.x + 14}px;top:${n.y + 4}px;width:${n.width - 28}px"><b>${escape(n.title)}</b><span>${escape(n.detail)}</span>${count}</div>`
      if (n.shape === "decision") return `<div class="fdia" data-node="${n.id}" data-shape="decision" id="fn-${n.id}"${evidence} style="${style}"><div class="shape"></div><div class="inner"></div><div class="txt">${escape(n.title)}</div>${count}</div>`
      return `<div class="fnode ${n.shape}" data-node="${n.id}" data-shape="${n.shape}" id="fn-${n.id}"${evidence} style="${style}">${n.shape === "subprocess" ? '<i class="process-boundary left"></i><i class="process-boundary right"></i>' : ""}<div class="t">${escape(n.title)}</div><div class="s">${escape(n.detail)}</div>${count}</div>`
    }).join("")
    return `<svg class="flowsvg" viewBox="0 0 ${size.width} ${size.height}" aria-label="${graph.name} 智能体机制图"><defs>${markers}</defs>${regionHTML(graph.regions[0])}${area}${wires}${labels}</svg>${boxes}`
  }
  return { size, graphs, render }
})()
