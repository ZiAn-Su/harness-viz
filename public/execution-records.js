/* Pure adapters for observed executions. Missing native times remain unknown. */
globalThis.HarnessExecutions = (() => {
  const iso = value => value == null ? null : typeof value === "number" ? new Date(value).toISOString() : value
  const elapsed = (start, end) => start && end && Number.isFinite(Date.parse(start)) && Number.isFinite(Date.parse(end)) && Date.parse(end) >= Date.parse(start) ? Date.parse(end) - Date.parse(start) : null
  const toolTypes = ["command_execution", "file_change", "mcp_tool_call", "collab_tool_call", "web_search"]
  const stateText = status => ({ running: "正在执行", pending: "等待执行", completed: "已完成", failed: "执行失败", cancelled: "已取消", unconfirmed: "尚未确认" })[status] ?? "状态未提供"
  const replyText = reply => ({ once: "允许这一次操作", always: "允许此请求对应的后续匹配操作", reject: "拒绝这次操作" })[reply] ?? reply
  const stopText = reason => ({ stop: "模型结束本次回答", end_turn: "模型结束本次回答", "tool-calls": "模型提出工具调用", tool_use: "模型提出工具调用", length: "达到输出长度限制", max_tokens: "达到输出长度限制" })[reason] ?? reason
  function content(value) {
    if (typeof value === "string") return value
    if (Array.isArray(value)) return value.map(content).filter(Boolean).join("\n")
    if (!value || typeof value !== "object") return ""
    if (typeof value.text === "string") return value.text
    if (value.type === "tool_result" || value.type === "message" || value.role) return content(value.content)
    if (value.type === "image" || value.type === "input_image") return "[图片内容；原始载荷在技术详情中保留]"
    return ""
  }
  const userText = item => typeof item?.content === "string" ? item.content : Array.isArray(item?.content)
    ? item.content.filter(block=>["text", "input_text"].includes(block.type)).map(block=>block.text ?? "").join("\n") : ""
  function historySummary(call) {
    const request = call.anthropicRequest ?? call.request?.request ?? call.request ?? {}
    const rebuilt = call.modelInput?.kind === "reconstructed" && call.modelInput.complete === true
    const items = rebuilt ? call.modelInput.items : request.messages ?? request.input
    const excerpt = (value, limit = 240) => { const text = String(value ?? "").replace(/\s+/g, " ").trim(); return text.length > limit ? text.slice(0, limit) + "…" : text }
    const calls = new Map()
    let requirement = "", progress = "", feedback = ""
    const action = tool => {
      let args = tool.input
      if (typeof args === "string") { try { args = JSON.parse(args) } catch {} }
      const name = ({ read: "读取文件", edit: "编辑文件", write: "写入文件", bash: "执行命令", grep: "检索内容", glob: "查找文件", task: "管理子任务" })[tool.name] ?? tool.name
      const path = args?.filePath ?? args?.path
      return excerpt(name + (typeof path === "string" ? " · " + path.split(/[\\/]/).at(-1) : ""), 100)
    }
    for (const item of Array.isArray(items) ? items : []) {
      if (item.role === "user" && userText(item)) requirement = excerpt(userText(item), 320)
      const blocks = Array.isArray(item.content) ? item.content : []
      const proposals = blocks.filter(b=>b.type === "tool_use").map(b=>({ id: b.id, name: b.name, input: b.input }))
      for (const tool of item.tool_calls ?? []) proposals.push({ id: tool.id, name: tool.function?.name, input: tool.function?.arguments })
      if (["function_call", "custom_tool_call"].includes(item.type)) proposals.push({ id: item.call_id, name: item.name, input: item.arguments ?? item.input })
      for (const tool of proposals) if (tool.id && tool.name) calls.set(tool.id, tool)
      if (item.role === "assistant" || proposals.length) {
        const text = item.role === "assistant" ? excerpt(userText(item)) : ""
        const actions = proposals.filter(tool=>tool.name).slice(0, 3).map(action)
        if (text || actions.length) progress = [text, actions.length ? "已提出：" + actions.join("；") + (proposals.length > 3 ? "等动作" : "") : ""].filter(Boolean).join("\n")
      }
      const results = blocks.filter(b=>b.type === "tool_result").map(b=>({ id: b.tool_use_id, failed: b.is_error === true }))
      if (item.role === "tool") results.push({ id: item.tool_call_id, failed: false })
      if (["function_call_output", "custom_tool_call_output"].includes(item.type)) results.push({ id: item.call_id, failed: false })
      for (const result of results) {
        const tool = calls.get(result.id)
        if (tool) feedback = "已收到“" + action(tool) + "”的反馈" + (result.failed ? "（工具报告错误）" : "") + "。"
      }
    }
    return { requirement, progress, feedback, rebuilt, incremental: Boolean(request.previous_response_id), hasItems: Array.isArray(items) }
  }
  function usageFields(usage) {
    if (!usage) return []
    return [["输入 token", usage.input_tokens ?? usage.prompt_tokens ?? usage.input], ["输出 token", usage.output_tokens ?? usage.completion_tokens ?? usage.output],
      ["缓存命中 token", usage.cached_input_tokens ?? usage.cache_read_input_tokens ?? usage.prompt_tokens_details?.cached_tokens],
      ["推理 token", usage.reasoning_output_tokens ?? usage.output_tokens_details?.reasoning_tokens ?? usage.completion_tokens_details?.reasoning_tokens]].filter(([,value])=>value != null)
  }
  // Learner-facing descriptions use actual values, not a second JSON dump.
  // Each field is [label, value, display]; raw data remains in fromRecord().
  function describe(p) {
    const i = p.input, o = p.output, fields = [], results = [], steps = [], add = (list, label, value, display) => {
      if (value !== undefined && value !== null && value !== "") list.push([label, value, display])
    }
    let summary = stateText(p.status), action = p.title
    if (p.operation === "model") {
      const request = i.请求参数 ?? {}, items = request.messages ?? request.input
      const user = Array.isArray(items) ? items.findLast(item=>item.role === "user" && userText(item)) : null
      add(fields, "使用模型", i.模型)
      add(fields, "最近用户文本", user ? userText(user) : undefined, "text")
      add(fields, "可见输入", Array.isArray(items) ? `${items.length} 条消息／输入项；不等于内部循环次数` : "请求通知未包含消息正文，展开后从捕获报文读取")
      add(fields, "可用工具", Array.isArray(request.tools) ? request.tools.map(t=>t.name ?? t.function?.name ?? t.type).join("、") || "本次显式传入空工具列表" : undefined)
      add(fields, "思考强度", request.reasoning_effort ?? request.reasoning?.effort ?? request.output_config?.effort ?? request.thinking_effort)
      const tools = o.工具调用 ?? []
      summary = `${i.模型 ?? "本次模型请求"} · ${stateText(p.status)}${o.文字 ? `，返回 ${o.文字.length} 字符回答` : ""}${tools.length ? `，提出 ${tools.length} 个工具调用` : ""}。`
      steps.push({ label: "发出模型请求", detail: user ? "携带下面列出的用户文本，以及本次可见历史和工具定义。" : "原始请求在本次调用详情中保留。", status: "completed" },
        { label: p.status === "cancelled" ? "响应接收被取消" : "接收模型输出", detail: tools.length ? `模型提出：${tools.map(t=>t.name).join("、")}；是否实际执行需核对对应工具记录。` : o.文字 ? "已接收到下方回答正文。" : "当前未捕获可读回答正文。", status: p.status })
      add(results, "回答正文", o.文字, "markdown")
      for (const tool of tools) add(results, `提出调用 · ${tool.name ?? "未提供名称"}`, tool.input ?? "未记录参数", "fields")
      add(results, "结束原因", stopText(o.结束原因))
      results.push(...usageFields(o.用量))
      if (!results.length) add(results, "当前结果", p.status === "running" ? "仍在等待响应。" : "已收到终态通知；完整正文需要从下方调用详情加载。")
    } else if (p.operation === "tool") {
      let args = i.参数 ?? {}
      if (typeof args === "string") { try { const parsed = JSON.parse(args); if (parsed && typeof parsed === "object") args = parsed } catch {} }
      const name = i.工具 ?? i.活动类型 ?? "工具", target = args.filePath ?? args.path
      const command = i.命令 ?? args.command, prompt = i.任务 ?? args.prompt
      const changes = i.文件
      add(fields, "工具", ({ read: "读取文件（read）", edit: "编辑文件（edit）", write: "写入文件（write）", bash: "命令执行（bash）", command_execution: "命令执行", file_change: "文件修改", collab_tool_call: "子任务管理" })[name] ?? name)
      if (command) {
        action = "运行命令"; add(fields, "执行命令", command, "code"); add(fields, "工作目录", args.workdir ?? args.cwd)
        add(fields, "执行要求", args.description); add(fields, "超时上限", args.timeout == null ? undefined : `${args.timeout} ms`)
      } else if (prompt || name === "task" || name === "collab_tool_call") {
        action = "处理子任务管理请求"; add(fields, "管理动作", i.管理动作 ?? name)
        add(fields, "任务要求", prompt ?? args.description, "text"); add(fields, "代理类型", args.subagent_type ?? i.代理类型)
        add(fields, "目标线程", i.目标线程)
      } else if (changes) {
        action = "修改文件"; add(fields, "涉及文件", changes.map(c=>({ 文件: c.path, 操作: ({ add: "新增", update: "修改", delete: "删除" })[c.kind] ?? c.kind })), "fields")
      } else {
        const reading = ["read", "read_file"].includes(name), editing = ["edit", "write", "apply_patch"].includes(name)
        action = reading ? "读取文件" : editing ? "修改文件" : args.pattern || i.查询 ? "检索内容" : `调用 ${name}`
        add(fields, "目标文件", target); add(fields, "匹配内容", args.pattern ?? i.查询)
        add(fields, "搜索范围", args.include ?? args.glob)
        add(fields, "起始位置", args.offset); add(fields, "读取上限", args.limit)
        add(fields, "修改前", args.oldString ?? args.old_string, "code"); add(fields, "修改后", args.newString ?? args.new_string ?? args.content ?? args.patch, "code")
      }
      add(fields, "外部服务", i.服务)
      const handled = new Set(["filePath", "path", "command", "workdir", "cwd", "description", "timeout", "prompt", "subagent_type", "pattern", "include", "glob", "offset", "limit", "oldString", "old_string", "newString", "new_string", "content", "patch"])
      if (typeof args === "object" && !Array.isArray(args)) {
        const extra = Object.fromEntries(Object.entries(args).filter(([key])=>!handled.has(key)))
        if (Object.keys(extra).length) add(fields, "其他执行参数", extra, "fields")
      } else add(fields, "执行参数", args, "text")
      const feedback = ["exec", "c-feedback"].includes(p.nodeID)
      const fileName = typeof target === "string" ? target.split(/[\\/]/).at(-1) : target
      summary = `${feedback ? "收到反馈" : action} · ${stateText(p.status)}${fileName ? `：${fileName}` : command ? `：${command.slice(0, 100)}` : ""}${o.退出码 == null ? "" : ` · 退出码 ${o.退出码}`}`
      const rawOutput = o.输出 ?? o.结果
      let visibleOutput = rawOutput
      if (typeof rawOutput === "string" && /<path>[\s\S]*?<\/path>/.test(rawOutput) && /<content>[\s\S]*?<\/content>/.test(rawOutput)) {
        const returnedPath = rawOutput.match(/<path>([\s\S]*?)<\/path>/)?.[1]
        if (returnedPath !== target) add(results, "返回文件", returnedPath)
        visibleOutput = rawOutput.match(/<content>([\s\S]*?)<\/content>/)?.[1]?.trim()
      }
      steps.push({ label: feedback ? "接收本次工具返回" : action, detail: feedback ? "下方保留这次调用实际返回的数据和错误。" : command ? "按上方命令执行；输出和退出情况见本次结果。" : target ? "按上方文件路径和范围处理；实际返回内容见本次结果。" : prompt ? "按上方任务要求发起管理动作；下方保留实际返回。" : `工具：${name}`, status: p.status })
      add(results, "执行结果", p.status === "running" ? "工具正在处理，尚未返回结果。" : p.status === "completed" ? "工具已返回完成状态。" : stateText(p.status))
      add(results, "退出码", o.退出码 == null ? undefined : `${o.退出码}${o.退出码 === 0 ? "（进程正常退出）" : "（进程报告非零退出码）"}`)
      add(results, "返回内容", visibleOutput, typeof visibleOutput === "string" ? "code" : "fields")
      add(results, "文件变化", changes, "fields")
      add(results, "子任务状态", o.子任务状态, "fields"); add(results, "子会话", o.子会话)
      if (name === "task" || name === "collab_tool_call") add(results, "结果范围", "这是管理调用的返回；后台任务是否结束，以子任务自身报告为准。")
    } else if (p.operation === "permission") {
      action = "处理权限询问"
      add(fields, "申请权限", ({ edit: "修改文件", bash: "执行命令", read: "读取文件", external_directory: "访问项目外目录" })[i.权限] ?? i.权限)
      add(fields, "本次匹配范围", i.匹配范围, "list")
      summary = `${({ edit: "修改文件", bash: "执行命令", read: "读取文件", external_directory: "访问项目外目录" })[i.权限] ?? i.权限 ?? "权限请求"}：${o.用户答复 === "等待答复" ? "等待你的选择" : replyText(o.用户答复)}`
      steps.push({ label: "收到权限询问", detail: Array.isArray(i.匹配范围) ? i.匹配范围.join("\n") : i.权限, status: p.startedAt ? "completed" : "unconfirmed" },
        { label: "等待并记录用户答复", detail: replyText(o.用户答复), status: p.status })
      add(results, "你的选择", replyText(o.用户答复)); add(results, "后续含义", "答复已经记录；工具是否继续执行，查看对应工具的实际结果。")
    } else if (p.operation === "returned") {
      summary = `本次处理${({ completed: "已返回", failed: "报告失败", cancelled: "被中断" })[p.status] ?? stateText(p.status)}。`
      add(fields, "用户轮次", i.用户轮次)
      add(fields, "本轮任务", i.任务, "text")
      const parts = o.返回内容 ?? [], text = Array.isArray(parts) ? parts.filter(part=>part.type === "text").map(part=>part.text).join("\n") : content(parts)
      add(results, "返回回答", text, "markdown")
      add(results, "同轮已观测回答", o.已观测回答, "markdown")
      add(results, "涉及文件", o.文件变化, "fields")
      if (o.已观测回答 || o.文件变化?.length) add(results, "内容来源", "按同一会话和用户轮次关联的原生已完成活动；不是完成报告自身携带的正文，也不代表独立验证了回答或文件。")
      add(results, "返回状态", stopText(o.返回消息?.finish) ?? stateText(p.status))
      results.push(...usageFields(o.用量 ?? o.返回消息?.tokens))
      if (!text && !o.已观测回答) add(results, "正文采集范围", "这条完成报告不包含回答正文；本轮也未采集到可明确关联的助手完成项。")
      steps.push({ label: "接收原生处理返回", detail: text ? "原生接口返回了下面的回答。" : "原生事件报告了本轮的结束状态及已提供的用量。", status: p.status })
    } else if (p.operation === "compaction") {
      summary = p.status === "completed" ? "原生报告上下文整理完成。" : `上下文整理${stateText(p.status)}。`
      add(fields, "使用模型", i.模型)
      const request = i.请求内容 ?? {}, items = request.input ?? request.messages
      add(fields, "整理要求", request.instructions, "text")
      add(fields, "待整理内容", Array.isArray(items) ? items.map(item=>content(item.content)).filter(Boolean).join("\n\n") : undefined, "text")
      const response = o.返回内容
      add(results, "整理后内容", typeof response === "string" ? response : response?.summary ?? content(response?.output ?? response?.output_items), "text")
      add(results, "当前结果", p.status === "completed" ? "已捕获完成报告；未提供的信息仍不能从完成状态反推。" : stateText(p.status))
      if (response && !results.some(([label])=>label === "整理后内容")) add(results, "返回字段", response, "fields")
      steps.push(...p.steps)
    } else if (p.operation === "submit") {
      summary = "任务入口已接受这条用户要求。"
      add(fields, "你的要求", i.用户输入, "text"); add(fields, "会话方式", i.会话方式)
      add(results, "接下来", "进入运行准备；这里不代表模型或工具已经完成任务。")
      steps.push(...p.steps)
    } else {
      for (const [key,value] of Object.entries(i)) add(fields, key, value, "fields")
      for (const [key,value] of Object.entries(o)) add(results, key, value, "fields")
      steps.push(...p.steps)
    }
    return { summary, input: fields, steps, result: results }
  }
  function fromRecord(rec, nodeID, call) {
    call ??= rec.modelCall
    const data = rec.data ?? {}, event = rec.event ?? {}, first = rec.firstEvent ?? event
    let startedAt = null, endedAt = null, status = "running", input = {}, output = {}, work = [], timing = "原生未提供执行起止；下方保留首次与最近接收时间。"
    let title = rec.title, error = null
    if (rec.kind === "preparation") return { ...data, title: "运行准备", timing: "任务入口与原生接收边界，采集端时钟。" }
    if (rec.kind === "llm") {
      const request = call?.anthropicRequest ?? call?.request?.request ?? call?.request
      const response = rec.data.responseEvent?.properties
      startedAt = iso(call?.startedAt ?? data.requestSummary?.startedAt ?? first.receivedAt)
      endedAt = iso(call?.endedAt ?? response?.endedAt ?? rec.data.responseEvent?.receivedAt)
      const terminal = call?.trace?.terminal?.payload?.type ?? response?.terminalType
      error = call?.error ?? response?.error ?? null
      status = terminal === "inference_cancelled" ? "cancelled" : error ? "failed" : endedAt ? "completed" : "running"
      title = "调用模型"
      input = { 模型: call?.model ?? data.requestSummary?.model, 会话: call?.sessionID ?? data.requestSummary?.sessionID,
        ...(request ? { 请求参数: request } : { 请求摘要: data.requestSummary }) }
      output = call?.response ? { 文字: call.response.text, 可见思考: call.response.thinking, 工具调用: call.response.toolUses,
        结束原因: call.response.stopReason, 用量: call.response.usage } : response ?? {}
      work = [{ label: "向模型发起本次请求", status: "completed" }, { label: "接收并保留响应", status }]
      timing = (call?.source ?? rec.source) === "native-trace" ? "原生 inference trace 的请求／终态边界；不是模型服务内部计算耗时。" : "客户端请求捕获与响应终态边界；包含传输等待。"
    } else if (data.type === "tool") {
      const state = data.state ?? {}
      startedAt = iso(state.time?.start); endedAt = iso(state.time?.end)
      status = ({ pending: "pending", running: "running", completed: "completed", error: "failed" })[state.status] ?? "unconfirmed"
      title = nodeID === "exec" ? "接收工具反馈" : data.tool === "task" ? "管理子任务" : "执行工具"
      input = { 工具: data.tool, 调用标识: data.callID, 会话: data.sessionID, 参数: state.input }
      output = { 标题: state.title, 输出: state.output, 元数据: state.metadata, 退出码: state.metadata?.exit ?? state.metadata?.exitCode, 子会话: state.metadata?.sessionId }
      error = state.error ?? null
      work = [{ label: nodeID === "exec" ? "保留本次工具返回的数据" : "按本次参数执行工具", status }]
      timing = "工具状态携带的原生 time.start／time.end；未提供时不补造。"
      if (data.tool === "task") timing += " 这里只记录本次管理调用，后台子任务是否完成以其自身事件为准。"
      if (nodeID === "exec") { startedAt = null; timing = "仅工具终态边界上的反馈接收；独立写入过程的开始与耗时未采集。" }
    } else if (toolTypes.includes(data.type)) {
      const terminal = first.type === "codex.item.completed" || event.type === "codex.item.completed"
      status = data.status === "failed" ? "failed" : data.status === "declined" ? "cancelled" : terminal || data.status === "completed" ? "completed" : "running"
      title = data.type === "collab_tool_call" ? "管理子任务" : nodeID === "c-feedback" ? "接收工具反馈" : "执行工具"
      input = { 活动类型: data.type, 活动标识: data.id, 会话: rec.context?.sessionID, 用户轮次: rec.context?.turnNumber, 命令: data.command, 服务: data.server, 工具: data.type === "collab_tool_call" ? "collab_tool_call" : data.tool, 管理动作: data.type === "collab_tool_call" ? data.tool : undefined, 任务: data.prompt, 代理类型: data.agent_type, 目标线程: data.receiver_thread_ids, 参数: data.arguments, 查询: data.query, 文件: data.changes }
      output = { 输出: data.aggregated_output, 结果: data.result, 退出码: data.exit_code, 子任务状态: data.agents_states }
      work = [{ label: title, status }]
      error = data.error ?? (status === "failed" ? data.aggregated_output : null)
      if (data.type === "collab_tool_call") timing += " 管理调用返回不等于所有子智能体均已完成。"
    } else if (rec.kind === "compaction-request") {
      const begin = first.properties?.event, finish = data.event, raw = finish?.payload ?? {}
      const complete = raw.type === "compaction_request_completed", failed = raw.type === "compaction_request_failed"
      startedAt = begin?.payload?.type === "compaction_request_started" ? iso(begin.wall_time_unix_ms) : null
      endedAt = complete || failed ? iso(finish.wall_time_unix_ms) : null
      status = failed ? "failed" : complete ? "completed" : "running"; error = raw.error ?? null
      title = "上下文整理请求"
      input = { 会话: begin?.payload?.thread_id, 原生处理轮次: begin?.payload?.codex_turn_id,
        模型: begin?.payload?.model, 请求标识: raw.compaction_request_id, 请求内容: first.properties?.payloads?.request_payload }
      output = { 返回内容: data.payloads?.response_payload }
      work = [{ label: "发起原生上下文整理请求", status: startedAt ? "completed" : "unconfirmed" }, { label: "接收整理结果", status }]
      timing = "原生 compaction_request_id 对应的请求／返回边界；未提供维护阶段，不归入特定压缩分支。"
    } else if (first.type === "permission.asked") {
      const replied = event.type === "permission.replied"
      title = "权限交互"; status = replied ? data.reply === "reject" ? "cancelled" : "completed" : "running"
      startedAt = first.receivedAt; endedAt = replied ? event.receivedAt : null
      input = { 权限: first.properties.permission, 匹配范围: first.properties.patterns, 工具调用: first.properties.tool, 请求标识: first.properties.id }
      output = { 用户答复: data.reply ?? "等待答复" }
      work = [{ label: "发出权限询问", status: "completed" }, { label: "等待并记录用户答复", status }]
      timing = "权限询问／答复的接收边界，耗时包含用户等待；不表示工具已经执行。"
    } else if (event.type === "permission.replied") {
      title = "权限答复"; status = data.reply === "reject" ? "cancelled" : "completed"; endedAt = event.receivedAt
      input = { 会话: data.sessionID, 请求标识: data.requestID }; output = { 用户答复: data.reply }
      work = [{ label: "收到原生权限答复", status }]; timing = "仅捕获答复，询问开始未采集；不补造交互耗时。"
    } else if (event.type === "session.compacted") {
      title = "执行压缩"; status = "completed"; endedAt = event.receivedAt
      input = { 会话: data.sessionID }; output = { 完成报告: data }
      work = [{ label: "原生报告压缩完成", status }]
      timing = "仅观测到原生完成报告；开始与完整耗时未采集。"
    } else if (event.type === "viz.prompt.returned" || ["codex.turn.completed", "codex.turn.failed"].includes(event.type)) {
      title = "本次处理返回"; endedAt = event.receivedAt
      error = data.result?.info?.error ?? data.error ?? null
      status = data.aborted || error?.name === "MessageAbortedError" ? "cancelled" : error || event.type === "codex.turn.failed" ? "failed" : "completed"
      input = { 会话: data.sessionID ?? rec.context?.sessionID, 用户轮次: event.conversationTurn ?? rec.context?.turnNumber, 任务: rec.context?.prompt }
      output = event.type === "viz.prompt.returned" ? { 返回消息: data.result?.info, 返回内容: data.result?.parts } : { 用量: data.usage, 已观测回答: rec.context?.answers?.map(a=>a.text).join("\n\n"), 文件变化: rec.context?.files }
      work = [{ label: "收到原生处理返回／完成报告", status }]
      timing = "已观测的处理返回边界；不是内部退出判断或收尾维护的逐函数计时。"
    } else if (event.type === "viz.run") {
      title = "提交任务"; endedAt = event.receivedAt; status = "completed"
      input = { 用户输入: data.prompt, 会话方式: data.continuing ? "继续当前对话" : "新建会话" }; output = { 已准入: true }
      work = [{ label: "任务入口接受本条用户输入", status }]; timing = "本地任务准入事件，仅观测到完成边界；提交开始及耗时未采集，不代表后续任务已经完成。"
    } else return null
    const operation = rec.kind === "llm" ? "model" : data.type === "tool" || toolTypes.includes(data.type) ? "tool" : event.type?.startsWith("permission.") ? "permission" : rec.kind === "compaction-request" || event.type === "session.compacted" ? "compaction" : event.type === "viz.run" ? "submit" : "returned"
    return { id: `${event.harness ?? "opencode"}:${event.runID ?? ""}:${nodeID}:${rec.seq}`, nodeID, operation, title, status, startedAt, endedAt,
      durationMs: elapsed(startedAt, endedAt), timing, input, output, error, steps: work,
      observations: { firstReceivedAt: first.receivedAt, lastReceivedAt: data.responseEvent?.receivedAt ?? event.receivedAt }, source: rec.source }
  }
  return { fromRecord, describe, content, userText, historySummary }
})()
