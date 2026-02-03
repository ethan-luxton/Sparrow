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
    items
      .filter((item) => item.role === "user" || item.role === "assistant")
      .slice(0, 30)
      .reverse()
      .forEach((item) => {
        const bubble = document.createElement("div");
        const who = item.role === "user" ? "me" : "assistant";
        bubble.className = "chat-bubble " + who + " mono";
        bubble.textContent = item.content;
        root.appendChild(bubble);
      });
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
  async function sendChat() {
    const input = document.getElementById("chat-input");
    if (!input || !input.value.trim()) return;
    const text = input.value.trim();
    input.value = "";
    await postJson("/api/chat", { message: text });
    if (page === "chat") {
      await refreshChat();
    } else {
      await refreshOverview();
    }
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
    setInterval(() => {
      loadDbMessages();
      loadDbToolLogs();
    }, 20000);
  } else if (page === "chat") {
    refreshChat();
    setInterval(refreshChat, 5000);
  }

  document.getElementById("db-msg-refresh")?.addEventListener("click", loadDbMessages);
  document.getElementById("db-tool-refresh")?.addEventListener("click", loadDbToolLogs);
  document.getElementById("chat-send")?.addEventListener("click", sendChat);
  document.getElementById("chat-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendChat();
  });
})();
