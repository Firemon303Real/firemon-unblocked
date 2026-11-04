const address = document.querySelector("#address");
const homeAddress = document.querySelector("#home-address");
const homeForm = document.querySelector("#home-search");
const navForm = document.querySelector("#nav");
const home = document.querySelector("#home");
const frameHost = document.querySelector("#frame-host");
const tabsEl = document.querySelector("#tabs");
const toast = document.querySelector("#toast");
const proxyLabel = document.querySelector("#proxy-label");

let controller;
let utils;
let tabs = [];
let activeId = null;
let sequence = 0;
let toastTimer;

const newTabId = () => "firemon-tab-" + (++sequence);
const activeTab = () => tabs.find((tab) => tab.id === activeId);

function parseInput(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  let candidate = text;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(candidate)) {
    candidate = text.includes(" ") || !text.includes(".")
      ? "https://duckduckgo.com/?q=" + encodeURIComponent(text)
      : "https://" + text;
  }
  try {
    const url = new URL(candidate);
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function notify(message) {
  toast.textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.textContent = ""; }, 3200);
}

function persistTabs() {
  try {
    localStorage.setItem("firemon-tabs-v1", JSON.stringify({
      active: tabs.findIndex((tab) => tab.id === activeId),
      tabs: tabs.map(({ url, title }) => ({ url, title }))
    }));
  } catch {}
}

function getSavedTabs() {
  try {
    const saved = JSON.parse(localStorage.getItem("firemon-tabs-v1") || "null");
    if (!saved || !Array.isArray(saved.tabs)) return null;
    return saved;
  } catch {
    return null;
  }
}

function titleFor(url) {
  try { return new URL(url).hostname.replace(/^www\./, "") || "New tab"; }
  catch { return "New tab"; }
}

function renderTabs() {
  tabsEl.replaceChildren();
  for (const tab of tabs) {
    const item = document.createElement("div");
    item.className = "tab" + (tab.id === activeId ? " active" : "") + (tab.loading ? " loading" : "");
    item.setAttribute("role", "tab");
    item.setAttribute("aria-selected", String(tab.id === activeId));
    item.title = tab.title;

    const favicon = document.createElement("span");
    favicon.className = "tab-favicon";
    favicon.textContent = tab.loading ? "◌" : (tab.url ? "●" : "✦");

    const label = document.createElement("span");
    label.className = "tab-label";
    label.textContent = tab.title;

    const close = document.createElement("button");
    close.type = "button";
    close.className = "tab-close";
    close.setAttribute("aria-label", "Close " + tab.title);
    close.title = "Close tab";
    close.textContent = "×";
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      closeTab(tab.id);
    });

    item.append(favicon, label, close);
    item.addEventListener("click", () => selectTab(tab.id));
    item.addEventListener("auxclick", (event) => {
      if (event.button === 1) {
        event.preventDefault();
        closeTab(tab.id);
      }
    });
    tabsEl.append(item);
  }
}

function updateChrome() {
  const tab = activeTab();
  const hasPage = Boolean(tab?.url);
  home.hidden = hasPage;
  frameHost.hidden = !hasPage;
  for (const entry of tabs) {
    if (entry.element) entry.element.classList.toggle("frame-active", entry.id === activeId && hasPage);
  }
  address.value = hasPage ? tab.url : "";
  const homeButton = document.querySelector("#bottom-home");
  const moviesButton = document.querySelector("#movies-button");
  homeButton.setAttribute("aria-current", hasPage ? "false" : "page");
  let onMovies = false;
  try { onMovies = hasPage && new URL(tab.url).hostname.replace(/^www\./, "") === "movy.sx"; } catch {}
  moviesButton.setAttribute("aria-current", onMovies ? "page" : "false");
  if (tab?.url) document.title = tab.title + " · Firemon Unblocked";
  else document.title = "Firemon Unblocked";
  renderTabs();
  persistTabs();
}

function attachFrame(tab) {
  tab.element = document.createElement("iframe");
  tab.element.className = "page-frame";
  tab.element.title = tab.title;
  tab.element.addEventListener("load", () => {
    if (tab.loading) {
      tab.loading = false;
      renderTabs();
    }
    try {
      const pageTitle = tab.element.contentDocument?.title;
      if (pageTitle && pageTitle.trim()) {
        tab.title = pageTitle.trim();
        if (tab.id === activeId) document.title = tab.title + " · Firemon Unblocked";
        renderTabs();
        persistTabs();
      }
    } catch {}
  });
  frameHost.append(tab.element);
}

function makeTab(url = "", title = "") {
  const tab = {
    id: newTabId(),
    url,
    title: title || (url ? titleFor(url) : "New tab"),
    loading: false,
    session: null,
    sessionPromise: null,
    element: null
  };
  attachFrame(tab);
  tabs.push(tab);
  return tab;
}

function resetTabToHome(tab) {
  if (tab.session && controller) {
    const frameIndex = controller.frames.indexOf(tab.session);
    if (frameIndex >= 0) controller.frames.splice(frameIndex, 1);
  }
  tab.element.remove();
  tab.session = null;
  tab.sessionPromise = null;
  tab.url = "";
  tab.title = "New tab";
  tab.loading = false;
  attachFrame(tab);
  updateChrome();
  if (tab.id === activeId) homeAddress.focus({ preventScroll: true });
}

function goHome() {
  const tab = activeTab();
  if (!tab) {
    createTab();
    return;
  }
  if (tab.sessionPromise) {
    tab.sessionPromise.then(() => resetTabToHome(tab), () => resetTabToHome(tab));
    return;
  }
  resetTabToHome(tab);
}

function selectTab(id) {
  const tab = tabs.find((entry) => entry.id === id);
  if (!tab) return;
  activeId = id;
  updateChrome();
  if (tab.url && !tab.session && controller) {
    ensureSession(tab).then((session) => {
      if (tab.url) session.go(tab.url);
    }).catch((error) => notify(error.message || "Could not open this tab."));
  }
}

function createTab(url = "", { background = false } = {}) {
  const tab = makeTab();
  if (!background || !activeId) selectTab(tab.id);
  else {
    renderTabs();
    persistTabs();
  }
  if (url) navigateInTab(tab, url);
  else if (!background) homeAddress.focus({ preventScroll: true });
  return tab;
}

async function ensureSession(tab) {
  if (tab.session) return tab.session;
  if (tab.sessionPromise) return tab.sessionPromise;
  if (!controller) throw new Error("The proxy is still starting. Try again in a moment.");

  tab.sessionPromise = Promise.resolve().then(() => {
    tab.session = controller.createFrame(tab.element, {
      plugins: [
        new utils.HttpCachePlugin(),
        new utils.UrlWatcherPlugin((url) => {
          tab.url = url;
          tab.title = titleFor(url);
          tab.loading = false;
          if (tab.id === activeId) {
            address.value = url;
            document.title = tab.title + " · Firemon Unblocked";
            let onMovies = false;
            try { onMovies = new URL(url).hostname.replace(/^www\./, "") === "movy.sx"; } catch {}
            document.querySelector("#movies-button").setAttribute("aria-current", onMovies ? "page" : "false");
          }
          renderTabs();
          persistTabs();
        }),
        new utils.CatchEscapedLinksPlugin((url) => { createTab(url); return new URL(location.href); })
      ]
    });
    return tab.session;
  }).finally(() => { tab.sessionPromise = null; });
  return tab.sessionPromise;
}

async function navigateInTab(tab, value) {
  const url = parseInput(value);
  if (!url) {
    if (tab.id === activeId) {
      const input = home.hidden ? address : homeAddress;
      input.setCustomValidity("Enter a search or a valid http/https address.");
      input.reportValidity();
      input.focus();
    }
    return;
  }
  tab.url = url;
  tab.title = titleFor(url);
  tab.loading = true;
  if (tab.id === activeId) {
    address.value = url;
    document.title = tab.title + " · Firemon Unblocked";
  }
  updateChrome();
  const urlToOpen = url;
  try {
    const session = await ensureSession(tab);
    if (tab.url === urlToOpen) session.go(urlToOpen);
  } catch (error) {
    tab.loading = false;
    renderTabs();
    notify(error.message || "Could not open this page.");
  }
}

function navigate(value) {
  let tab = activeTab();
  if (!tab) tab = createTab();
  navigateInTab(tab, value);
}

function closeTab(id) {
  const index = tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return;
  const [tab] = tabs.splice(index, 1);
  if (tab.session && controller) {
    const frameIndex = controller.frames.indexOf(tab.session);
    if (frameIndex >= 0) controller.frames.splice(frameIndex, 1);
  }
  tab.element.remove();

  if (activeId === id) {
    const next = tabs[index] || tabs[index - 1];
    activeId = next?.id || null;
    if (next) selectTab(next.id);
  }
  if (!tabs.length) createTab();
  else updateChrome();
}

function setLoading(tab, value) {
  tab.loading = value;
  renderTabs();
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error("Could not load Scramjet runtime: " + src));
    document.head.append(script);
  });
}

async function loadRuntime() {
  if (!window.isSecureContext || !("serviceWorker" in navigator)) {
    throw new Error("Open Firemon on localhost or an HTTPS website to enable Scramjet.");
  }
  const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) {
    await new Promise((resolve) => navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true }));
  }
  const serviceworker = navigator.serviceWorker.controller ?? registration.active;
  if (!serviceworker) throw new Error("Scramjet's service worker did not start.");

  for (const src of ["/scram/scramjet.js", "/controller/controller.api.js", "/utils/scramjet-utils.js"]) {
    await loadScript(src);
  }
  const api = window.$scramjetController;
  utils = window.$scramjetUtils;
  const { default: LibcurlClient } = await import("/libcurl/index.mjs");
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  const transport = new LibcurlClient({ wisp: `${scheme}//${location.host}/wisp/` });
  controller = new api.Controller({
    serviceworker,
    transport,
    config: {
      scramjetPath: "/scram/scramjet.js",
      wasmPath: "/scram/scramjet.wasm",
      injectPath: "/controller/controller.inject.js"
    }
  });
  await controller.wait();
  proxyLabel.textContent = "SCRAMJET READY";
  setInterval(() => navigator.serviceWorker.controller?.postMessage("keepalive"), 15000);

  if (!tabs.length) createTab();
  const selected = activeTab();
  if (selected?.url) {
    selected.loading = true;
    renderTabs();
    const session = await ensureSession(selected);
    session.go(selected.url);
  } else {
    homeAddress.focus({ preventScroll: true });
  }
}

navForm.addEventListener("submit", (event) => {
  event.preventDefault();
  navigate(address.value);
});
homeForm.addEventListener("submit", (event) => {
  event.preventDefault();
  navigate(homeAddress.value);
});
homeAddress.addEventListener("input", () => homeAddress.setCustomValidity(""));
address.addEventListener("input", () => address.setCustomValidity(""));
document.querySelector("#new-tab").addEventListener("click", () => createTab());
document.querySelector("#home-button").addEventListener("click", (event) => {
  event.preventDefault();
  goHome();
});
document.querySelector("#bottom-home").addEventListener("click", goHome);
document.querySelector("#movies-button").addEventListener("click", () => {
  createTab("https://movy.sx/");
});
document.querySelector("#back").addEventListener("click", () => activeTab()?.session?.back());
document.querySelector("#forward").addEventListener("click", () => activeTab()?.session?.forward());
document.querySelector("#reload").addEventListener("click", () => {
  const tab = activeTab();
  if (tab?.session) {
    setLoading(tab, true);
    tab.session.reload();
  }
});
window.addEventListener("keydown", (event) => {
  if (!(event.ctrlKey || event.metaKey)) return;
  if (event.key.toLowerCase() === "t") {
    event.preventDefault();
    createTab();
  } else if (event.key.toLowerCase() === "l") {
    event.preventDefault();
    address.focus();
    address.select();
  } else if (event.key === "Tab" && tabs.length > 1) {
    event.preventDefault();
    const index = tabs.findIndex((tab) => tab.id === activeId);
    const direction = event.shiftKey ? -1 : 1;
    const next = (index + direction + tabs.length) % tabs.length;
    selectTab(tabs[next].id);
  }
});

const savedAtStart = getSavedTabs();
if (savedAtStart?.tabs?.length) {
  for (const entry of savedAtStart.tabs) makeTab(entry.url || "", entry.title || "");
  const restored = tabs[Math.min(Math.max(savedAtStart.active || 0, 0), tabs.length - 1)];
  activeId = restored.id;
  updateChrome();
} else {
  createTab();
}

loadRuntime().catch((error) => {
  proxyLabel.textContent = "PROXY OFFLINE";
  notify(error.message || "Scramjet could not start.");
});