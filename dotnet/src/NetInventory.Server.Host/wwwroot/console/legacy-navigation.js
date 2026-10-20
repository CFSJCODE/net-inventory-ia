(() => {
  "use strict";
  if (window.__netInventoryUnifiedNavigation) return;
  window.__netInventoryUnifiedNavigation = true;

  // Agent cards inside the original device page, composed like the Windows app (Hardware with large values and
  // small units, Armazenamento) and expandable in place ("Ver tudo") to every sensor, disk, interface and session.
  // Elements reuse classes copied from the page's own cards and labels; colors come from the theme variables the
  // page already defines. No global styles are added and the original cards are left untouched.
  const GROUP_ID = "ni-windows-agent-card";
  const EXPANDED_KEY = "ni-agent-expanded";
  const REFRESH_MS = 30000;
  const locale = "pt-BR";
  let devices = [];
  let scheduled = false;
  let summary = null;
  let summaryFor = null;
  let summaryAt = 0;
  let retryAt = 0;
  let loading = false;
  let expanded = false;
  try { expanded = sessionStorage.getItem(EXPANDED_KEY) === "1"; } catch { /* storage unavailable: start collapsed */ }

  const ICONS = {
    cpu: '<rect width="16" height="16" x="4" y="4" rx="2"></rect><rect width="6" height="6" x="9" y="9" rx="1"></rect><path d="M15 2v2"></path><path d="M15 20v2"></path><path d="M2 15h2"></path><path d="M2 9h2"></path><path d="M20 15h2"></path><path d="M20 9h2"></path><path d="M9 2v2"></path><path d="M9 20v2"></path>',
    disk: '<line x1="22" x2="2" y1="12" y2="12"></line><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"></path><line x1="6" x2="6.01" y1="16" y2="16"></line><line x1="10" x2="10.01" y1="16" y2="16"></line>',
    thermo: '<path d="M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0Z"></path>',
    fan: '<path d="M10.827 16.379a6.082 6.082 0 0 1-8.618-7.002l5.412 1.45a6.082 6.082 0 0 1 7.002-8.618l-1.45 5.412a6.082 6.082 0 0 1 8.618 7.002l-5.412-1.45a6.082 6.082 0 0 1-7.002 8.618l1.45-5.412Z"></path><path d="M12 12v.01"></path>',
    zap: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"></path>',
    network: '<rect x="16" y="16" width="6" height="6" rx="1"></rect><rect x="2" y="16" width="6" height="6" rx="1"></rect><rect x="9" y="2" width="6" height="6" rx="1"></rect><path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3"></path><path d="M12 12V8"></path>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M22 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path>',
    send: '<path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"></path><path d="m21.854 2.147-10.94 10.939"></path>',
    down: '<path d="m6 9 6 6 6-6"></path>',
    up: '<path d="m18 15-6-6-6 6"></path>',
  };
  function icon(name, className) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("fill", "none"); svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2"); svg.setAttribute("stroke-linecap", "round"); svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true"); svg.setAttribute("class", className); svg.innerHTML = ICONS[name];
    return svg;
  }
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  const number = (value, digits = 0) => value.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  function bytes(value) {
    if (typeof value !== "number" || !isFinite(value)) return "Indisponível";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let size = value, unit = 0;
    while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++; }
    return number(size, unit >= 3 ? 1 : 0) + " " + units[unit];
  }
  function rate(value) {
    if (typeof value !== "number" || !isFinite(value)) return "—";
    return value >= 1048576 ? number(value / 1048576, 1) + " MB/s" : number(value / 1024, 1) + " KB/s";
  }
  function uptime(seconds) {
    if (typeof seconds !== "number" || seconds < 0) return "—";
    const days = Math.floor(seconds / 86400), hours = Math.floor(seconds % 86400 / 3600), minutes = Math.floor(seconds % 3600 / 60);
    return days > 0 ? `${days}d ${hours}h ${minutes}m` : hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
  }
  function age(iso) {
    const time = Date.parse(iso);
    if (!isFinite(time)) return "sem coleta";
    const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
    if (seconds < 60) return `há ${seconds} s`;
    if (seconds < 3600) return `há ${Math.round(seconds / 60)} min`;
    if (seconds < 86400) return `há ${Math.round(seconds / 3600)} h`;
    return new Date(time).toLocaleString(locale);
  }
  const stamp = (iso) => { const time = Date.parse(iso); return isFinite(time) ? new Date(time).toLocaleString(locale) : "—"; };
  const observed = (item) => item && item.state === "Observed";
  const mac = (value) => /^[0-9A-Fa-f]{12}$/.test(value || "") ? value.match(/../g).join(":") : (value || "—");
  const networkState = (value) => ({ Up: "Ativa", Down: "Inativa", Dormant: "Em espera", NotPresent: "Ausente", LowerLayerDown: "Sem cabo", Testing: "Em teste" })[value] || "—";
  const sessionState = (value) => ({ Active: "Ativa", Disconnected: "Desconectada", Idle: "Ociosa", Connected: "Conectada" })[value] || value;

  // Visual vocabulary taken from the original page at render time.
  function vocabulary(content) {
    const cards = [...content.querySelectorAll(':scope > [data-slot="card"]')];
    const details = cards.find((card) => card.querySelector('[data-slot="card-title"]')?.textContent.trim() === "Detalhes") || cards[0];
    if (!details) return null;
    const pick = (selector, fallback) => details.querySelector(selector)?.className || content.querySelector(selector)?.className || fallback;
    const buttons = [...content.querySelectorAll('[data-slot="button"]')];
    const outline = buttons.find((button) => button.className.includes("bg-background"));
    return {
      details,
      card: details.className,
      header: pick('[data-slot="card-header"]', ""),
      title: pick('[data-slot="card-title"]', "font-heading font-medium text-base"),
      description: content.querySelector('[data-slot="card-description"]')?.className || "text-sm text-muted-foreground",
      label: details.querySelector('[data-slot="card-content"] p')?.className || "text-xs text-muted-foreground",
      button: (outline?.className || buttons[0]?.className || "").replace(/\bw-fit\b/, "").trim(),
    };
  }

  // ---------- building blocks (same shapes as the Windows app) ----------
  function card(v, title, description, glyph, actions) {
    const node = el("div", v.card);
    node.dataset.slot = "card"; node.dataset.size = "default";
    const header = el("div", v.header); header.dataset.slot = "card-header";
    const heading = el("div", v.title.replace(/\btext-base\b/, "") + " flex items-center gap-2 text-base"); heading.dataset.slot = "card-title";
    if (glyph) heading.append(icon(glyph, "lucide h-4 w-4 text-emerald-500"));
    heading.append(document.createTextNode(title));
    header.append(heading);
    if (description) { const text = el("div", v.description, description); text.dataset.slot = "card-description"; header.append(text); }
    if (actions?.length) {
      const action = el("div", "col-start-2 row-span-2 row-start-1 self-start justify-self-end flex items-center gap-2"); action.dataset.slot = "card-action";
      action.append(...actions); header.append(action);
    }
    const body = el("div", "px-(--card-spacing) flex flex-col gap-4 text-sm"); body.dataset.slot = "card-content";
    node.append(header, body);
    return { node, body };
  }
  // Solid green status pill, the same look as the primary "Abrir painel" button.
  function statusPill(text, ok) {
    const pill = el("span", "inline-flex items-center gap-1.5 rounded-full text-xs font-medium");
    pill.style.padding = "2px 10px";
    pill.style.background = ok ? "var(--primary)" : "var(--color-amber-500)";
    pill.style.color = "var(--primary-foreground)";
    const dot = el("span", "rounded-full"); dot.style.width = "6px"; dot.style.height = "6px"; dot.style.background = "var(--primary-foreground)";
    pill.append(dot, document.createTextNode(text));
    return pill;
  }
  // Inline grid: only utilities the installed panel already compiled can be used as classes, so the
  // responsive column count is expressed directly (fills the row, wraps on narrow screens).
  function grid(columns, children) {
    const node = el("div");
    const minimum = { 5: 140, 4: 170, 3: 200, 2: 260 }[columns] || 200;
    Object.assign(node.style, { display: "grid", gap: "16px 24px", gridTemplateColumns: `repeat(auto-fit, minmax(min(${minimum}px, 100%), 1fr))` });
    node.append(...children);
    return node;
  }
  function field(v, label, value, note, mono) {
    const box = el("div");
    box.append(el("p", v.label, label));
    box.append(el("p", mono ? "whitespace-pre-line break-all font-mono" : "whitespace-pre-line", value || "Indisponível"));
    if (note) box.append(el("p", v.label, note));
    return box;
  }
  // Large value with a small unit, as the panel's equipment card ("3 %", "60 °C"), optional usage bar.
  function metric(v, label, value, unit, note, percent, warn) {
    const box = el("div", "flex flex-col gap-1");
    box.append(el("p", v.label, label));
    const line = el("p");
    Object.assign(line.style, { display: "flex", alignItems: "baseline", gap: "4px" });
    const big = el("span", "text-2xl font-semibold", value);
    if (warn) big.style.color = warn;
    line.append(big);
    if (unit) line.append(el("span", v.label, unit));
    box.append(line);
    if (typeof percent === "number" && isFinite(percent)) {
      const track = el("div", "h-1.5 w-full overflow-hidden rounded-full");
      track.style.background = "var(--accent)";
      const fill = el("div", "h-full rounded-full");
      fill.style.width = Math.max(0, Math.min(100, percent)).toFixed(1) + "%";
      fill.style.background = percent >= 90 ? "var(--destructive)" : percent >= 75 ? "var(--color-amber-500)" : "var(--primary)";
      track.append(fill); box.append(track);
    }
    if (note) box.append(el("p", v.label, note));
    return box;
  }
  // Table with a muted header and faint row lines, as the panel's equipment ports table.
  function table(v, headers, rows, rightLast, monoColumn) {
    const wrap = el("div", "overflow-x-auto");
    const node = el("table", "w-full text-sm");
    node.style.borderCollapse = "collapse";
    const head = el("tr");
    headers.forEach((h, i) => {
      const th = el("th", v.label, h);
      th.style.textAlign = rightLast && i === headers.length - 1 ? "right" : "left";
      th.style.padding = "8px 8px 8px " + (i === 0 ? "0" : "8px"); th.style.fontWeight = "500";
      th.style.borderBottom = "1px solid var(--border)";
      head.append(th);
    });
    node.append(head);
    rows.forEach((row, r) => {
      const tr = el("tr");
      row.forEach((cell, i) => {
        const td = el("td", i === monoColumn ? "font-mono whitespace-pre-line" : "whitespace-pre-line", cell);
        td.style.textAlign = rightLast && i === row.length - 1 ? "right" : "left";
        td.style.padding = "10px 8px 10px " + (i === 0 ? "0" : "8px");
        if (r < rows.length - 1) td.style.borderBottom = "1px solid var(--border)";
        tr.append(td);
      });
      node.append(tr);
    });
    wrap.append(node);
    return wrap;
  }
  const temperatureColor = (celsius) => celsius >= 90 ? "var(--destructive)" : celsius >= 80 ? "var(--color-amber-500)" : "";
  const connector = (hardware) => { const cut = (hardware || "").lastIndexOf(" · "); return cut >= 0 ? hardware.slice(cut + 3) : hardware; };

  function volumeMetric(v, x) {
    const used = x.totalBytes - Math.min(x.freeBytes, x.totalBytes);
    const percent = 100 * used / x.totalBytes;
    return metric(v, `${x.name.replace(/\\$/, "")}${x.label ? " · " + x.label : ""}`, number(percent, 0), "%", `${bytes(x.freeBytes)} livres de ${bytes(x.totalBytes)} · ${x.fileSystem}`, percent);
  }

  function buildGroup(v, device, data) {
    const group = el("div");
    group.id = GROUP_ID;
    group.dataset.deviceId = device.id;
    group.style.display = "contents"; // children take part in the page's own column gap
    const sample = data?.latest;
    const telemetry = sample?.telemetry;

    const ok = data?.status === "Recent";
    const toggle = el("button", v.button, expanded ? "Mostrar menos" : "Ver tudo");
    toggle.type = "button"; toggle.dataset.slot = "button";
    toggle.append(icon(expanded ? "up" : "down", "lucide"));
    toggle.addEventListener("click", () => {
      expanded = !expanded;
      try { sessionStorage.setItem(EXPANDED_KEY, expanded ? "1" : "0"); } catch { /* ignore */ }
      render(true);
    });
    const status = statusPill(ok ? "Online" : "Sem coleta recente", ok);

    const hardware = card(v, "Hardware",
      sample ? `${sample.hardware?.cpu || "Agente Windows"} · coletado ${age(sample.collectedAt)}` : "Agente vinculado, aguardando a primeira coleta.",
      "cpu", [status, toggle]);
    group.append(hardware.node);
    if (!telemetry) {
      hardware.body.append(el("p", v.label, sample ? "Esta coleta ainda não traz métricas de hardware." : "Os dados aparecem aqui após o primeiro envio do agente."));
      return group;
    }

    const cpu = telemetry.cpu, memory = telemetry.memory;
    const temps = (telemetry.temperatures || []).filter((t) => observed(t) && typeof t.celsius === "number");
    const cpuTemp = temps.find((t) => t.name === "CPU") || temps.find((t) => /cpu/i.test(t.name));
    const boardTemp = temps.find((t) => /placa/i.test(t.name));
    hardware.body.append(grid(5, [
      metric(v, "CPU", observed(cpu) && typeof cpu.usagePercent === "number" ? number(cpu.usagePercent, 0) : "—", "%",
        cpu ? `${cpu.physicalCores ?? "?"} núcleos · ${cpu.logicalProcessors} threads` : null, observed(cpu) ? cpu.usagePercent : null),
      metric(v, "Memória", observed(memory) ? number(memory.usagePercent, 0) : "—", "%",
        observed(memory) ? `${bytes(memory.usedBytes)} de ${bytes(memory.totalBytes)}` : null, observed(memory) ? memory.usagePercent : null),
      metric(v, "Temperatura", cpuTemp ? number(cpuTemp.celsius, 0) : "—", "°C", cpuTemp ? "CPU" : "Sem sensor compatível", null, cpuTemp ? temperatureColor(cpuTemp.celsius) : ""),
      metric(v, "Placa-mãe", boardTemp ? number(boardTemp.celsius, 0) : "—", "°C", boardTemp ? "SYSTIN" : "Sem sensor compatível"),
      metric(v, "Ligado há", uptime(sample.uptimeSeconds), null, "Desde a inicialização do Windows"),
    ]));

    const volumes = (telemetry.volumes || []).filter((x) => observed(x) && x.totalBytes > 0);
    if (volumes.length) {
      const storage = card(v, "Armazenamento", `${volumes.length} volume(s) fixo(s)`, "disk");
      storage.body.append(grid(3, volumes.map((x) => volumeMetric(v, x))));
      if (expanded && (telemetry.disks || []).length) {
        storage.body.append(el("p", "text-sm font-medium", "Discos físicos"));
        storage.body.append(table(v, ["Modelo", "Interface", "Capacidade"], telemetry.disks.map((d) => [d.model, d.interfaceType || "—", typeof d.sizeBytes === "number" ? bytes(d.sizeBytes) : "—"]), true));
      }
      group.append(storage.node);
    }
    if (!expanded) return group;

    // ---------- full view ----------
    const system = card(v, "Processador e memória", `${sample.hardware?.manufacturer || "—"} · ${sample.hardware?.model || "—"}`, "cpu");
    system.body.append(grid(4, [
      field(v, "Processador", sample.hardware?.cpu),
      field(v, "Núcleos / threads", cpu ? `${cpu.physicalCores ?? "?"} / ${cpu.logicalProcessors}` : null),
      field(v, "RAM instalada", sample.hardware?.memoryBytes ? bytes(sample.hardware.memoryBytes) : null),
      field(v, "RAM disponível", observed(memory) ? bytes(memory.availableBytes) : null),
      field(v, "Windows", sample.operatingSystem?.caption, sample.operatingSystem ? `Versão ${sample.operatingSystem.version} · build ${sample.operatingSystem.build} · ${sample.operatingSystem.architecture}` : null),
      field(v, "Domínio / grupo", telemetry.domain),
      field(v, "Versão do agente", telemetry.agentVersion),
      field(v, "Identidade do agente", sample.agentId, null, true),
    ]));
    group.append(system.node);

    const first = (telemetry.temperatures || []).find(observed);
    const origin = first ? (first.source.includes(first.hardware) ? first.source : `${first.hardware} via ${first.source}`) : null;
    const tempCard = card(v, "Temperaturas", origin ? "Origem: " + origin : "Nenhum sensor compatível informado", "thermo");
    tempCard.body.append((telemetry.temperatures || []).length
      ? table(v, ["Sensor", "Leitura"], telemetry.temperatures.map((t) => [t.name, observed(t) && typeof t.celsius === "number" ? number(t.celsius, 1) + " °C" : "Indisponível"]), true)
      : el("p", v.label, "A disponibilidade depende do hardware e do provedor de sensores."));
    group.append(tempCard.node);

    const fans = (telemetry.fans || []).filter((f) => observed(f) && typeof f.rpm === "number");
    const rails = (telemetry.voltages || []).filter((x) => observed(x) && typeof x.volts === "number");
    if (fans.length || rails.length) {
      const pair = el("div");
      Object.assign(pair.style, { display: "grid", gap: "24px", gridTemplateColumns: "repeat(auto-fit, minmax(min(360px, 100%), 1fr))" });
      const fanCard = card(v, "Ventoinhas", "Rotação informada pela placa", "fan");
      fanCard.body.append(fans.length ? table(v, ["Ventoinha", "Conector", "Rotação"], fans.map((f) => [f.name, connector(f.hardware), number(f.rpm) + " RPM"]), true) : el("p", v.label, "Nenhuma ventoinha em rotação."));
      const railCard = card(v, "Tensões", "Entradas calibradas pelo próprio chip", "zap");
      railCard.body.append(rails.length ? table(v, ["Entrada", "Tensão"], rails.map((x) => [x.name, number(x.volts, 3) + " V"]), true) : el("p", v.label, "Nenhuma tensão informada."));
      pair.append(fanCard.node, railCard.node);
      group.append(pair);
    }

    const adapters = (sample.adapters || []).filter((a) => (a.addresses || []).some((x) => !x.includes(":")));
    const network = card(v, "Rede", "Interfaces com endereço IPv4 neste computador", "network");
    network.body.append(adapters.length ? table(v, ["Interface", "IPv4", "MAC", "Estado", "Velocidade", "Recebendo / enviando"], adapters.map((a) => {
      const n = (telemetry.network || []).find((x) => x.adapterId === a.id);
      return [a.name, a.addresses.filter((x) => !x.includes(":")).join("\n"), mac(a.mac), n ? networkState(n.status) : "—",
        n && typeof n.speedBitsPerSecond === "number" ? number(n.speedBitsPerSecond / 1e6) + " Mbps" : "—",
        n ? `${rate(n.receiveBytesPerSecond)} / ${rate(n.sendBytesPerSecond)}` : "—"];
    }), false, 2) : el("p", v.label, "Nenhuma interface com IPv4 nesta coleta."));
    group.append(network.node);

    const sessions = card(v, "Sessões de usuários", sample.sessionState === "Observed" ? "Observado" : "Coleta indisponível", "users");
    sessions.body.append(sample.sessionState !== "Observed" ? el("p", v.label, "O agente não conseguiu consultar as sessões. Isso não significa que não há usuário logado.")
      : (sample.sessions || []).length ? table(v, ["Usuário", "Domínio", "Sessão", "Estado"], sample.sessions.map((s) => [s.user, s.domain || "—", `${s.transport} · ${s.id}`, sessionState(s.state)]))
      : el("p", v.label, "Nenhuma sessão de usuário nesta coleta."));
    group.append(sessions.node);

    const communication = card(v, "Comunicação com o host", "Envio das coletas deste computador", "send");
    const history = el("div");
    history.append(el("p", v.label, "Histórico de coletas"));
    const link = el("a", "hover:underline", "Abrir no console do agente");
    link.style.color = "var(--primary)";
    link.href = "/console/devices/" + encodeURIComponent(device.id);
    history.append(link);
    communication.body.append(grid(4, [
      field(v, "Última coleta", stamp(sample.collectedAt), age(sample.collectedAt)),
      field(v, "Recebido pelo host", stamp(data.lastReceivedAt), data.lastReceivedAt ? age(data.lastReceivedAt) : null),
      field(v, "Situação", ok ? "Coletas recentes" : "Sem coleta recente"),
      history,
    ]));
    group.append(communication.node);
    return group;
  }

  function devicePageId() {
    const path = /^\/devices\/([^/]+)\/?$/.exec(window.location.pathname);
    return path ? decodeURIComponent(path[1]) : null;
  }
  function render(force) {
    const id = devicePageId();
    const existing = document.getElementById(GROUP_ID);
    // The earlier footer link is replaced by the cards' own actions.
    document.getElementById("ni-windows-agent-action")?.parentElement?.remove();
    if (!id) { existing?.remove(); return; }
    const device = devices.find((item) => item.id === id && item.agentId);
    if (!device) { existing?.remove(); return; }
    // A failed load waits retryAt; otherwise every re-render would refetch in a tight loop.
    if ((summaryFor !== id || Date.now() - summaryAt > REFRESH_MS) && Date.now() >= retryAt) { void loadSummary(id); }
    const main = document.querySelector("main");
    const content = main?.querySelector("h2")?.closest("div.mx-auto.flex.flex-col");
    if (!content) return;
    const v = vocabulary(content);
    if (!v) return;
    const version = (summaryFor === id ? String(summaryAt) : "pending") + (expanded ? ":all" : ":short");
    if (!force && existing && existing.dataset.deviceId === id && existing.dataset.version === version && existing.previousElementSibling === v.details) return;
    const group = buildGroup(v, device, summaryFor === id ? summary : null);
    group.dataset.version = version;
    existing?.remove();
    v.details.after(group);
  }
  async function loadSummary(id) {
    if (loading) return;
    loading = true;
    try {
      const response = await fetch("/api/v1/inventory/" + encodeURIComponent(id) + "/agent-summary", { credentials: "same-origin", cache: "no-store" });
      if (response.ok) { summary = await response.json(); summaryFor = id; summaryAt = Date.now(); retryAt = 0; }
      else retryAt = Date.now() + REFRESH_MS;
    } catch { retryAt = Date.now() + REFRESH_MS; /* The original page stays intact when the agent API is unavailable. */ }
    finally { loading = false; schedule(); }
  }
  // Server pages of the .NET host (agents, connection, host, security) as one group at the end of the original
  // sidebar. Nodes are cloned from one of the sidebar's own items and the "Topologia" submenu, so the group
  // keeps the original classes, sizes and colors; only the icon, labels and links change.
  const MENU_ID = "ni-server-menu";
  const SERVER_ICON = '<rect width="20" height="8" x="2" y="2" rx="2" ry="2"></rect><rect width="20" height="8" x="2" y="14" rx="2" ry="2"></rect><line x1="6" x2="6.01" y1="6" y2="6"></line><line x1="6" x2="6.01" y1="18" y2="18"></line>';
  const SERVER_PAGES = [
    ["/console/agents", "Agentes", false],
    ["/console/connection", "Conexão", false],
    ["/console/host", "Host", true],
    ["/console/security", "Segurança", true],
  ];
  function plainClone(node, deep) {
    const copy = node.cloneNode(deep);
    for (const element of [copy, ...copy.querySelectorAll("*")]) {
      element.removeAttribute("id");
      element.removeAttribute("data-active");
      element.removeAttribute("aria-current");
      element.removeAttribute("data-base-ui-tooltip-trigger");
    }
    return copy;
  }
  function ensureServerMenu() {
    // The original sidebar shows "Usuários" only to administrators; Host and Segurança follow the same rule.
    const admin = !!document.querySelector('a[data-sidebar="menu-button"][href="/users"]');
    const existing = document.getElementById(MENU_ID);
    if (existing) {
      if (existing.dataset.admin === String(admin)) return;
      existing.remove();
    }
    // Clone an item that is not the current page, so no active highlight is copied into the group.
    const source = ["/settings", "/history", "/tools"]
      .map((href) => document.querySelector('a[data-sidebar="menu-button"][href="' + href + '"]'))
      .find((link) => link && !link.hasAttribute("data-active") && link.getAttribute("aria-current") !== "page");
    const subLink = [...document.querySelectorAll('a[data-sidebar="menu-sub-button"][href="/topology/links"]')]
      .find((link) => !link.hasAttribute("data-active")) ?? document.querySelector('a[data-sidebar="menu-sub-button"][href="/topology/links"]');
    const item = source?.closest('li[data-sidebar="menu-item"]');
    const subList = subLink?.closest('ul[data-sidebar="menu-sub"]');
    const subItem = subLink?.closest("li");
    const sourceText = source?.textContent.trim();
    const labelOf = (link) => [...link.querySelectorAll("span")].find((span) => span.children.length === 0 && span.textContent.trim() === sourceText);
    if (!item || !subList || !subItem || !sourceText || !labelOf(source) || !subLink.querySelector("span")) return;
    const pages = SERVER_PAGES.filter(([, , adminOnly]) => admin || !adminOnly);
    const group = plainClone(item, false);
    group.id = MENU_ID;
    group.dataset.admin = String(admin);
    const button = plainClone(source, true);
    button.href = pages[0][0];
    // The original items show their name in a tooltip when the sidebar is collapsed; a title keeps that for the clone.
    button.title = "Servidor";
    const svg = button.querySelector("svg");
    if (svg) {
      svg.innerHTML = SERVER_ICON;
      // Drop a hover animation frozen in the copied inline style; the icon starts at rest like its siblings.
      svg.removeAttribute("style");
      svg.parentElement?.removeAttribute("style");
    }
    labelOf(button).textContent = "Servidor";
    const list = plainClone(subList, false);
    for (const [href, text] of pages) {
      const entry = plainClone(subItem, false);
      const link = plainClone(subLink, true);
      link.href = href;
      link.querySelector("span").textContent = text;
      entry.append(link);
      list.append(entry);
    }
    group.append(button, list);
    item.parentElement.append(group);
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    // A short timer instead of requestAnimationFrame: it also runs while the tab is in the background.
    setTimeout(() => { scheduled = false; ensureServerMenu(); render(false); }, 50);
  }
  async function refreshDevices() {
    try {
      const response = await fetch("/api/v1/inventory", { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) return;
      const result = await response.json();
      if (!Array.isArray(result)) return;
      devices = result;
      schedule();
    } catch { /* The original interface remains usable if the agent API is unavailable. */ }
  }
  function initialize() {
    new MutationObserver((records) => {
      // Ignore mutations caused by these cards; react to the original page re-rendering.
      // Additions of our own nodes are ignored; their removal by a re-render schedules them again.
      const own = (n) => n.id === GROUP_ID || n.id === MENU_ID;
      if (records.every((r) => r.target.closest?.("#" + GROUP_ID + ",#" + MENU_ID)
        || (r.addedNodes.length > 0 && r.removedNodes.length === 0 && [...r.addedNodes].every(own))
        || [...r.addedNodes, ...r.removedNodes].every((n) => n.id === GROUP_ID))) return;
      schedule();
    }).observe(document.body, { childList: true, subtree: true });
    ensureServerMenu();
    setInterval(() => { if (devicePageId()) { summaryAt = 0; schedule(); } }, REFRESH_MS);
    void refreshDevices();
  }
  if (document.readyState === "complete") initialize();
  else window.addEventListener("load", initialize, { once: true });
})();
