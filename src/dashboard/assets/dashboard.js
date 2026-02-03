(() => {
  const page = document.body?.dataset?.page || "overview";

  const fmtSeconds = (s) => {
    const hours = Math.floor(s / 3600);
    const minutes = Math.floor((s % 3600) / 60);
    const seconds = Math.floor(s % 60);
    if (hours > 0) return hours + "h " + minutes + "m";
    if (minutes > 0) return minutes + "m " + seconds + "s";
    return seconds + "s";
  };
  const fmtMb = (n) => n + " MB";
  const fmtNumber = (n) => Number(n ?? 0).toLocaleString();
  const fmtBytes = (bytes) => {
    if (!Number.isFinite(bytes)) return "-";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = Number(bytes);
    let idx = 0;
    while (value >= 1024 && idx < units.length - 1) {
      value /= 1024;
      idx += 1;
    }
    const precision = value >= 10 || idx === 0 ? 0 : 1;
    return value.toFixed(precision) + " " + units[idx];
  };
  const setText = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };
  async function fetchJson(path) {
    const res = await fetch(path);
    if (!res.ok) throw new Error("Request failed");
    return await res.json();
  }
  async function postJson(path, body) {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error("Request failed");
    return await res.json();
  }
  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error("File read failed"));
      reader.readAsDataURL(file);
    });
  }
  async function uploadAttachment(file) {
    const dataUrl = await readFileAsDataUrl(file);
    return await postJson("/api/chat/upload", {
      filename: file.name,
      mime: file.type,
      data: dataUrl,
    });
  }
  function renderTools(items) {
    const root = document.getElementById("tool-logs");
    if (!root) return;
    root.innerHTML = "";
    items.slice(0, 12).forEach((item) => {
      const row = document.createElement("div");
      row.className = "row";
      row.innerHTML =
        "<strong>" +
        item.tool +
        " · " +
        item.action +
        "</strong>" +
        "<span class='mono'>chat " +
        item.chatId +
        " · " +
        item.createdAt +
        "</span>";
      root.appendChild(row);
    });
  }
  function renderMessages(items) {
    const root = document.getElementById("messages");
    if (!root) return;
    root.innerHTML = "";
    items.slice(0, 8).forEach((item) => {
      const row = document.createElement("div");
      row.className = "row";
      row.innerHTML =
        "<span class='pill'>" +
        item.role +
        "</span>" +
        "<div class='mono'>" +
        item.content +
        "</div>";
      root.appendChild(row);
    });
  }
  function renderFiles(items) {
    const root = document.getElementById("file-updates");
    if (!root) return;
    root.innerHTML = "";
    items.slice(0, 10).forEach((item) => {
      const row = document.createElement("div");
      row.className = "row";
      row.innerHTML =
        "<strong>" +
        item.action +
        "</strong>" +
        "<span class='mono'>" +
        item.path +
        "</span>";
      root.appendChild(row);
    });
  }
  function renderLogs(lines, file) {
    const root = document.getElementById("log-lines");
    if (!root) return;
    const stickToBottom = root.scrollTop + root.clientHeight >= root.scrollHeight - 20;
    root.innerHTML = "";
    if (!lines.length) {
      root.textContent = "No logs yet.";
      return;
    }
    lines.slice(-120).forEach((line) => {
      const div = document.createElement("div");
      div.className = "log-line mono";
      div.textContent = line;
      root.appendChild(div);
    });
    if (stickToBottom) root.scrollTop = root.scrollHeight;
    setText("subtitle", "Latest log: " + file + " · Redacted for safety.");
  }
  function renderChat(items) {
    const root = document.getElementById("chat-messages");
    if (!root) return;
    const stickToBottom = root.scrollTop + root.clientHeight >= root.scrollHeight - 20;
    root.innerHTML = "";
    const prevIds = new Set(chatState.lastIds || []);
    const nextIds = new Set();
    items
      .filter((item) => item.role === "user" || item.role === "assistant")
      .slice(0, 40)
      .reverse()
      .forEach((item) => {
        const idKey =
          item.id !== undefined && item.id !== null
            ? String(item.id)
            : String(item.createdAt || "") + "|" + item.role + "|" + (item.content || "").slice(0, 40);
        nextIds.add(idKey);
        const bubble = document.createElement("div");
        bubble.className = "chat-message " + (item.role === "user" ? "user" : "assistant");
        if (!prevIds.has(idKey)) bubble.classList.add("new");
        const meta = document.createElement("div");
        meta.className = "meta";
        const time = item.createdAt ? new Date(item.createdAt).toLocaleString() : "";
        meta.textContent = (item.role === "user" ? "You" : "Assistant") + (time ? " · " + time : "");
        const content = document.createElement("div");
        content.className = "content";
        content.textContent = item.content;
        bubble.appendChild(meta);
        bubble.appendChild(content);
        root.appendChild(bubble);
      });
    chatState.lastIds = nextIds;
    if (stickToBottom) root.scrollTop = root.scrollHeight;
  }
  function renderPie(chartId, legendId, items) {
    const chart = document.getElementById(chartId);
    const legend = document.getElementById(legendId);
    if (!chart || !legend) return;
    const total = items.reduce((sum, item) => sum + item.count, 0);
    legend.innerHTML = "";
    if (!total) {
      chart.style.background = "none";
      chart.classList.add("empty");
      const empty = document.createElement("div");
      empty.className = "muted";
      empty.textContent = "No data yet.";
      legend.appendChild(empty);
      return;
    }
    chart.classList.remove("empty");
    const colors = ["#f4b63e", "#58d5c9", "#ef6c74", "#4aa3ff", "#6fd38f", "#f19dd0", "#8f7dff"];
    let acc = 0;
    const segments = [];
    items.forEach((item, idx) => {
      const pct = (item.count / total) * 100;
      const color = colors[idx % colors.length];
      const start = acc;
      const end = acc + pct;
      segments.push(color + " " + start + "% " + end + "%");
      acc = end;
      const row = document.createElement("div");
      row.className = "legend-row";
      row.innerHTML =
        "<span class='swatch' style='background:" +
        color +
        "'></span><span>" +
        item.name +
        "</span><strong>" +
        fmtNumber(item.count) +
        "</strong>";
      legend.appendChild(row);
    });
    chart.style.background = "conic-gradient(" + segments.join(", ") + ")";
  }
  function renderTokenUsage(data) {
    const root = document.getElementById("token-usage");
    if (!root) return;
    root.innerHTML = "";
    const items = data?.items || [];
    if (!items.length) {
      root.textContent = "No token usage yet.";
      setText("token-total", "");
      return;
    }
    items.forEach((item) => {
      const row = document.createElement("div");
      row.className = "row";
      row.innerHTML =
        "<strong>" +
        item.model +
        "</strong><span class='mono'>prompt " +
        fmtNumber(item.promptTokens) +
        " · completion " +
        fmtNumber(item.completionTokens) +
        " · total " +
        fmtNumber(item.totalTokens) +
        "</span>";
      root.appendChild(row);
    });
    setText("token-total", "Total tokens: " + fmtNumber(data?.totalTokens ?? 0));
  }
  function sortItems(items, key, dir) {
    const sorted = [...items];
    sorted.sort((a, b) => {
      const av = a[key];
      const bv = b[key];
      if (typeof av === "number" && typeof bv === "number") return dir === "asc" ? av - bv : bv - av;
      const as = String(av ?? "");
      const bs = String(bv ?? "");
      return dir === "asc" ? as.localeCompare(bs) : bs.localeCompare(as);
    });
    return sorted;
  }
  function renderDetails(text) {
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "View";
    const pre = document.createElement("pre");
    pre.className = "cell-pre mono";
    pre.textContent = text || "";
    details.appendChild(summary);
    details.appendChild(pre);
    return details;
  }
  function renderTable(rootId, columns, state) {
    const root = document.getElementById(rootId);
    if (!root) return;
    root.innerHTML = "";
    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");
    columns.forEach((col) => {
      const th = document.createElement("th");
      th.textContent = col.label;
      if (col.sortable) {
        th.className = "sortable";
        if (state.sortKey === col.key) {
          th.dataset.dir = state.sortDir;
        }
        th.addEventListener("click", () => {
          state.sortDir = state.sortKey === col.key && state.sortDir === "asc" ? "desc" : "asc";
          state.sortKey = col.key;
          renderTable(rootId, columns, state);
        });
      }
      headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    root.appendChild(thead);
    const tbody = document.createElement("tbody");
    const items = sortItems(state.items, state.sortKey, state.sortDir);
    items.forEach((item) => {
      const tr = document.createElement("tr");
      columns.forEach((col) => {
        const td = document.createElement("td");
        if (col.render) {
          col.render(td, item);
        } else {
          td.textContent = item[col.key] ?? "";
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    root.appendChild(tbody);
  }
  const dbState = {
    messages: { items: [], sortKey: "id", sortDir: "desc" },
    toolLogs: { items: [], sortKey: "id", sortDir: "desc" },
    ledgerBlocks: { items: [], sortKey: "ts", sortDir: "desc" },
    ledgerKeywords: { items: [], sortKey: "keyword", sortDir: "asc" },
    ledgerSummaries: { items: [], sortKey: "ts", sortDir: "desc" },
    ledgerChains: { items: [], sortKey: "createdAt", sortDir: "desc" },
  };
  const chatState = {
    attachments: [],
    uploading: false,
    recording: false,
    recorder: null,
    chunks: [],
    lastIds: new Set(),
  };
  const messageColumns = [
    { key: "id", label: "ID", sortable: true },
    { key: "chatId", label: "Chat", sortable: true },
    { key: "role", label: "Role", sortable: true },
    { key: "createdAt", label: "Created", sortable: true },
    {
      key: "content",
      label: "Content",
      sortable: false,
      render: (td, item) => {
        const pre = document.createElement("pre");
        pre.className = "cell-pre mono";
        pre.textContent = item.content ?? "";
        td.appendChild(pre);
      },
    },
  ];
  const toolColumns = [
    { key: "id", label: "ID", sortable: true },
    { key: "chatId", label: "Chat", sortable: true },
    { key: "tool", label: "Tool", sortable: true },
    { key: "action", label: "Action", sortable: true },
    { key: "createdAt", label: "Created", sortable: true },
    {
      key: "payload",
      label: "Payload",
      sortable: false,
      render: (td, item) => td.appendChild(renderDetails(item.payload)),
    },
    {
      key: "result",
      label: "Result",
      sortable: false,
      render: (td, item) => td.appendChild(renderDetails(item.result)),
    },
  ];
  const ledgerBlockColumns = [
    { key: "blockId", label: "Block ID", sortable: true },
    { key: "chainId", label: "Chain", sortable: true },
    { key: "height", label: "Height", sortable: true },
    { key: "ts", label: "Timestamp", sortable: true },
    { key: "role", label: "Role", sortable: true },
    {
      key: "content",
      label: "Content",
      sortable: false,
      render: (td, item) => td.appendChild(renderDetails(item.content)),
    },
    {
      key: "keywords",
      label: "Keywords",
      sortable: false,
      render: (td, item) => td.appendChild(renderDetails(item.keywords)),
    },
    {
      key: "tags",
      label: "Tags",
      sortable: false,
      render: (td, item) => td.appendChild(renderDetails(item.tags)),
    },
    {
      key: "hashes",
      label: "Hashes",
      sortable: false,
      render: (td, item) =>
        td.appendChild(
          renderDetails(
            "contentHash: " +
              (item.contentHash || "-") +
              "\nprevHash: " +
              (item.prevHash || "-") +
              "\nheaderHash: " +
              (item.headerHash || "-")
          )
        ),
    },
    {
      key: "references",
      label: "References",
      sortable: false,
      render: (td, item) => td.appendChild(renderDetails(item.references)),
    },
    {
      key: "metadata",
      label: "Metadata",
      sortable: false,
      render: (td, item) => td.appendChild(renderDetails(item.metadata)),
    },
    { key: "redacted", label: "Redacted", sortable: true },
  ];
  const ledgerKeywordColumns = [
    { key: "chainId", label: "Chain", sortable: true },
    { key: "keyword", label: "Keyword", sortable: true },
    { key: "blockId", label: "Block ID", sortable: true },
  ];
  const ledgerSummaryColumns = [
    { key: "chainId", label: "Chain", sortable: true },
    { key: "upToHeight", label: "Up to Height", sortable: true },
    { key: "ts", label: "Timestamp", sortable: true },
    { key: "summaryHash", label: "Summary Hash", sortable: true },
    {
      key: "summaryText",
      label: "Summary",
      sortable: false,
      render: (td, item) => td.appendChild(renderDetails(item.summaryText)),
    },
  ];
  const ledgerChainColumns = [
    { key: "chainId", label: "Chain", sortable: true },
    { key: "createdAt", label: "Created", sortable: true },
    { key: "headHeight", label: "Head Height", sortable: true },
    { key: "genesisHash", label: "Genesis Hash", sortable: true },
    { key: "headHash", label: "Head Hash", sortable: true },
  ];
  async function loadDbMessages() {
    if (!document.getElementById("db-messages")) return;
    try {
      const chatId = document.getElementById("db-msg-chat")?.value || "";
      const role = document.getElementById("db-msg-role")?.value || "";
      const search = document.getElementById("db-msg-search")?.value || "";
      const limit = document.getElementById("db-msg-limit")?.value || "120";
      const params = new URLSearchParams();
      if (chatId) params.set("chatId", chatId);
      if (role) params.set("role", role);
      if (search) params.set("search", search);
      params.set("limit", limit);
      const data = await fetchJson("/api/db/messages?" + params.toString());
      dbState.messages.items = data.items || [];
      renderTable("db-messages", messageColumns, dbState.messages);
      setText("db-msg-count", "Showing " + dbState.messages.items.length + " of " + fmtNumber(data.total));
    } catch {
      setText("db-msg-count", "Unable to load messages.");
    }
  }
  async function loadDbToolLogs() {
    if (!document.getElementById("db-tool-logs")) return;
    try {
      const chatId = document.getElementById("db-tool-chat")?.value || "";
      const tool = document.getElementById("db-tool-name")?.value || "";
      const action = document.getElementById("db-tool-action")?.value || "";
      const limit = document.getElementById("db-tool-limit")?.value || "120";
      const params = new URLSearchParams();
      if (chatId) params.set("chatId", chatId);
      if (tool) params.set("tool", tool);
      if (action) params.set("action", action);
      params.set("limit", limit);
      const data = await fetchJson("/api/db/tool-logs?" + params.toString());
      dbState.toolLogs.items = data.items || [];
      renderTable("db-tool-logs", toolColumns, dbState.toolLogs);
      setText("db-tool-count", "Showing " + dbState.toolLogs.items.length + " of " + fmtNumber(data.total));
    } catch {
      setText("db-tool-count", "Unable to load tool logs.");
    }
  }
  async function loadLedgerBlocks() {
    if (!document.getElementById("db-ledger-blocks")) return;
    try {
      const chainId = document.getElementById("db-ledger-chain")?.value || "";
      const role = document.getElementById("db-ledger-role")?.value || "";
      const keyword = document.getElementById("db-ledger-keyword")?.value || "";
      const search = document.getElementById("db-ledger-search")?.value || "";
      const limit = document.getElementById("db-ledger-limit")?.value || "120";
      const params = new URLSearchParams();
      if (chainId) params.set("chainId", chainId);
      if (role) params.set("role", role);
      if (keyword) params.set("keyword", keyword);
      if (search) params.set("search", search);
      params.set("limit", limit);
      const data = await fetchJson("/api/db/ledger-blocks?" + params.toString());
      dbState.ledgerBlocks.items = data.items || [];
      renderTable("db-ledger-blocks", ledgerBlockColumns, dbState.ledgerBlocks);
      setText("db-ledger-count", "Showing " + dbState.ledgerBlocks.items.length + " of " + fmtNumber(data.total));
    } catch {
      setText("db-ledger-count", "Unable to load ledger blocks.");
    }
  }
  async function loadLedgerKeywords() {
    if (!document.getElementById("db-ledger-keywords")) return;
    try {
      const chainId = document.getElementById("db-kw-chain")?.value || "";
      const keyword = document.getElementById("db-kw-keyword")?.value || "";
      const limit = document.getElementById("db-kw-limit")?.value || "120";
      const params = new URLSearchParams();
      if (chainId) params.set("chainId", chainId);
      if (keyword) params.set("keyword", keyword);
      params.set("limit", limit);
      const data = await fetchJson("/api/db/ledger-keywords?" + params.toString());
      dbState.ledgerKeywords.items = data.items || [];
      renderTable("db-ledger-keywords", ledgerKeywordColumns, dbState.ledgerKeywords);
      setText("db-kw-count", "Showing " + dbState.ledgerKeywords.items.length + " of " + fmtNumber(data.total));
    } catch {
      setText("db-kw-count", "Unable to load ledger keywords.");
    }
  }
  async function loadLedgerSummaries() {
    if (!document.getElementById("db-ledger-summaries")) return;
    try {
      const chainId = document.getElementById("db-sum-chain")?.value || "";
      const limit = document.getElementById("db-sum-limit")?.value || "120";
      const params = new URLSearchParams();
      if (chainId) params.set("chainId", chainId);
      params.set("limit", limit);
      const data = await fetchJson("/api/db/ledger-summaries?" + params.toString());
      dbState.ledgerSummaries.items = data.items || [];
      renderTable("db-ledger-summaries", ledgerSummaryColumns, dbState.ledgerSummaries);
      setText("db-sum-count", "Showing " + dbState.ledgerSummaries.items.length + " of " + fmtNumber(data.total));
    } catch {
      setText("db-sum-count", "Unable to load ledger summaries.");
    }
  }
  async function loadLedgerChains() {
    if (!document.getElementById("db-ledger-chains")) return;
    try {
      const limit = document.getElementById("db-chain-limit")?.value || "120";
      const data = await fetchJson("/api/db/ledger-chains?limit=" + encodeURIComponent(limit));
      dbState.ledgerChains.items = data.items || [];
      renderTable("db-ledger-chains", ledgerChainColumns, dbState.ledgerChains);
    } catch {
      // ignore chain load errors
    }
  }
  async function refreshOverview() {
    try {
      const status = await fetchJson("/api/status");
      setText("host", status.hostname);
      setText("pid", status.pid);
      setText("node", status.nodeVersion);
      setText("platform", status.platform + " · " + status.arch);
      setText("cpu-count", status.cpuCount ?? "-");
      setText("uptime-process", fmtSeconds(status.processUptimeSeconds));
      setText("uptime-os", fmtSeconds(status.osUptimeSeconds));
      setText("load", status.loadAvg.map((v) => v.toFixed(2)).join(" / "));
      setText("rss", fmtMb(status.memoryMB.rss));
      setText("heap-used", fmtMb(status.memoryMB.heapUsed));
      setText("heap-total", fmtMb(status.memoryMB.heapTotal));
      setText("system-used", fmtMb(status.systemMemoryMB?.used ?? 0));
      setText("system-total", fmtMb(status.systemMemoryMB?.total ?? 0));
      setText("disk-used", fmtBytes(status.disk?.usedBytes));
      setText("disk-total", fmtBytes(status.disk?.totalBytes));
      setText("sparrow-used", fmtBytes(status.sparrow?.usedBytes));
      setText("sparrow-total", fmtBytes(status.sparrow?.totalBytes));
      setText("sparrow-path", status.sparrow?.path ?? "-");
      setText("updated", new Date().toLocaleTimeString());
      const tools = await fetchJson("/api/tool-logs?limit=24");
      renderTools(tools.items || []);
      const messages = await fetchJson("/api/messages?limit=16");
      renderMessages(messages.items || []);
      const files = await fetchJson("/api/files?limit=20");
      renderFiles(files.items || []);
    } catch {
      setText("subtitle", "Waiting for PixelTrail AI data...");
    }
  }
  async function refreshUsage() {
    if (!document.getElementById("tool-usage-chart") && !document.getElementById("token-usage")) return;
    try {
      const usage = await fetchJson("/api/usage?limit=8");
      renderPie("tool-usage-chart", "tool-usage-legend", usage.tools?.items || []);
      renderPie("api-usage-chart", "api-usage-legend", usage.apis?.items || []);
      const tokens = await fetchJson("/api/tokens?limit=6");
      renderTokenUsage(tokens);
    } catch {
      // ignore usage failures
    }
  }
  async function refreshLogs() {
    if (!document.getElementById("log-lines")) return;
    try {
      const logs = await fetchJson("/api/logs?lines=160");
      renderLogs(logs.lines || [], logs.file || "logs");
    } catch {
      setText("subtitle", "Waiting for log data...");
    }
  }
  async function refreshChat() {
    if (!document.getElementById("chat-messages")) return;
    try {
      const params = new URLSearchParams({ limit: "60", order: "desc" });
      const data = await fetchJson("/api/db/messages?" + params.toString());
      renderChat(data.items || []);
    } catch {
      // ignore chat refresh failures
    }
  }
  function renderAttachments() {
    const list = document.getElementById("chat-attachments");
    if (!list) return;
    list.innerHTML = "";
    chatState.attachments.forEach((att, idx) => {
      const chip = document.createElement("div");
      chip.className = "attachment-chip mono";
      chip.textContent = att.name + " (" + fmtBytes(att.size) + ")";
      const remove = document.createElement("button");
      remove.textContent = "×";
      remove.addEventListener("click", () => {
        chatState.attachments.splice(idx, 1);
        renderAttachments();
      });
      chip.appendChild(remove);
      list.appendChild(chip);
    });
  }
  function setChatHint(text) {
    const hint = document.getElementById("chat-hint");
    if (hint) hint.textContent = text;
  }
  async function handleFiles(files) {
    if (!files || !files.length) return;
    const maxSize = 12_000_000;
    setChatHint("Uploading files…");
    chatState.uploading = true;
    for (const file of files) {
      if (file.size > maxSize) {
        setChatHint("Skipped " + file.name + " (too large).");
        continue;
      }
      try {
        const uploaded = await uploadAttachment(file);
        chatState.attachments.push(uploaded);
        renderAttachments();
      } catch (err) {
        setChatHint("Upload failed: " + (err?.message || "unknown error"));
      }
    }
    chatState.uploading = false;
    setChatHint("Shift+Enter for new line. Files are stored locally.");
  }
  async function sendChat() {
    const input = document.getElementById("chat-input");
    if (!input) return;
    const text = input.value.trim();
    if (!text && chatState.attachments.length === 0) return;
    const sendBtn = document.getElementById("chat-send");
    if (sendBtn) sendBtn.setAttribute("disabled", "true");
    input.value = "";
    let message = text;
    if (chatState.attachments.length) {
      const attachmentLines = chatState.attachments.map((att) => {
        const type = att.mime ? att.mime : "unknown";
        return `- ${att.name} (${type}, ${att.size} bytes) saved at ${att.path}`;
      });
      const helper =
        "Attachments:\n" +
        attachmentLines.join("\n") +
        "\n\nUse filesystem to read files. If audio, you can use whisper_transcribe on the path.";
      message = message ? message + "\n\n" + helper : helper;
    }
    await postJson("/api/chat", { message });
    chatState.attachments = [];
    renderAttachments();
    if (page === "chat") {
      await refreshChat();
    } else {
      await refreshOverview();
    }
    if (sendBtn) sendBtn.removeAttribute("disabled");
  }
  function setupNav() {
    const links = document.querySelectorAll(".nav a[data-page]");
    links.forEach((link) => {
      if (link.dataset.page === page) {
        link.classList.add("active");
      }
    });
  }

  setupNav();

  if (page === "overview") {
    refreshOverview();
    refreshUsage();
    setInterval(refreshOverview, 5000);
    setInterval(refreshUsage, 20000);
  } else if (page === "logs") {
    refreshLogs();
    loadDbToolLogs();
    setInterval(refreshLogs, 5000);
    setInterval(loadDbToolLogs, 20000);
  } else if (page === "database") {
    loadDbMessages();
    loadDbToolLogs();
    loadLedgerBlocks();
    loadLedgerKeywords();
    loadLedgerSummaries();
    loadLedgerChains();
    setInterval(() => {
      loadDbMessages();
      loadDbToolLogs();
      loadLedgerBlocks();
      loadLedgerKeywords();
      loadLedgerSummaries();
      loadLedgerChains();
    }, 20000);
  } else if (page === "chat") {
    refreshChat();
    renderAttachments();
    setInterval(refreshChat, 5000);
  }

  document.getElementById("db-msg-refresh")?.addEventListener("click", loadDbMessages);
  document.getElementById("db-tool-refresh")?.addEventListener("click", loadDbToolLogs);
  document.getElementById("db-ledger-refresh")?.addEventListener("click", loadLedgerBlocks);
  document.getElementById("db-kw-refresh")?.addEventListener("click", loadLedgerKeywords);
  document.getElementById("db-sum-refresh")?.addEventListener("click", loadLedgerSummaries);
  document.getElementById("db-chain-refresh")?.addEventListener("click", loadLedgerChains);
  document.getElementById("chat-send")?.addEventListener("click", sendChat);
  document.getElementById("chat-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendChat();
    }
  });
  const chatInput = document.getElementById("chat-input");
  if (chatInput) {
    const resize = () => {
      chatInput.style.height = "auto";
      chatInput.style.height = Math.min(chatInput.scrollHeight, 160) + "px";
    };
    chatInput.addEventListener("input", resize);
    resize();
  }
  const attachBtn = document.getElementById("chat-attach");
  const fileInput = document.getElementById("chat-file");
  if (attachBtn && fileInput) {
    attachBtn.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", (e) => {
      const files = Array.from(e.target.files || []);
      fileInput.value = "";
      handleFiles(files);
    });
  }
  const clearBtn = document.getElementById("chat-clear");
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      if (chatInput) chatInput.value = "";
      chatState.attachments = [];
      renderAttachments();
    });
  }
  const chatStream = document.getElementById("chat-messages");
  if (chatStream) {
    ["dragenter", "dragover"].forEach((evt) => {
      chatStream.addEventListener(evt, (e) => {
        e.preventDefault();
        e.stopPropagation();
        chatStream.classList.add("chat-drop");
      });
    });
    ["dragleave", "drop"].forEach((evt) => {
      chatStream.addEventListener(evt, (e) => {
        e.preventDefault();
        e.stopPropagation();
        chatStream.classList.remove("chat-drop");
      });
    });
    chatStream.addEventListener("drop", (e) => {
      const files = Array.from(e.dataTransfer?.files || []);
      if (files.length) handleFiles(files);
    });
  }
  const recordBtn = document.getElementById("chat-record");
  if (recordBtn && "MediaRecorder" in window) {
    recordBtn.addEventListener("click", async () => {
      if (chatState.recording) {
        chatState.recording = false;
        recordBtn.textContent = "Record";
        setChatHint("Processing recording…");
        if (chatState.recorder) chatState.recorder.stop();
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const recorder = new MediaRecorder(stream);
        chatState.recorder = recorder;
        chatState.chunks = [];
        recorder.ondataavailable = (event) => {
          if (event.data && event.data.size > 0) chatState.chunks.push(event.data);
        };
        recorder.onstop = async () => {
          const blob = new Blob(chatState.chunks, { type: recorder.mimeType || "audio/webm" });
          stream.getTracks().forEach((t) => t.stop());
          chatState.chunks = [];
          const file = new File([blob], "recording_" + Date.now() + ".webm", { type: blob.type });
          await handleFiles([file]);
        };
        recorder.start();
        chatState.recording = true;
        recordBtn.textContent = "Stop";
        setChatHint("Recording… click Stop to finish.");
      } catch (err) {
        setChatHint("Recording failed: " + (err?.message || "permission denied"));
      }
    });
  } else if (recordBtn) {
    recordBtn.setAttribute("disabled", "true");
    recordBtn.textContent = "No mic";
  }
})();
