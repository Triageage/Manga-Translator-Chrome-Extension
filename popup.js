/**
 * Scan Translator - Manga Canvas & Typesetting
 * Popup Logic (MV3)
 */

(() => {
  "use strict";

  const DEFAULTS = {
    enabled: true,
    autoTranslate: false,
    provider: "gemini",
    model: "gemini-2.5-flash",
    endpoint: "",
    fontFamily: "Comic Neue",
    customFont: null,
    fillRatio: 0.76,
    revealOpacity: 0.15,
    minConfidence: 0.45,
    translateVisibleOnly: true,
    showTooltip: true
  };

  const $ = id => document.getElementById(id);

  let state = {
    settings: { ...DEFAULTS },
    apiKey: ""
  };

  function providerDefaults(provider) {
    switch (provider) {
      case "gemini":
        return {
          model: "gemini-2.5-flash",
          endpoint: "",
          hint: "Recommended: Google Gemini 2.5 Flash / 3.8 Flash (Active Free tier in Google AI Studio).",
          keyLink: "https://aistudio.google.com/app/apikey",
          keyLabel: "Get Free Gemini Key ↗"
        };
      case "ollama":
        return {
          model: "llama3.2-vision",
          endpoint: "http://localhost:11434/v1",
          hint: "Ollama: 100% Free, local & private. Run <code>ollama run llama3.2-vision</code> in PowerShell.",
          keyLink: "https://ollama.com",
          keyLabel: "Download Ollama ↗"
        };
      case "groq":
        return {
          model: "llama-3.2-11b-vision-preview",
          endpoint: "",
          hint: "Groq Cloud: 100% Free & ultra-fast LPU vision (~0.5s). Zero cost with high rate limits.",
          keyLink: "https://console.groq.com/keys",
          keyLabel: "Get Free Groq Key ↗"
        };
      case "openrouter":
        return {
          model: "google/gemini-2.0-flash-exp:free",
          endpoint: "",
          hint: "OpenRouter: Free tier models (Gemini 2.0 Flash Free, Qwen 2.5-VL 72B Free, Llama 3.2).",
          keyLink: "https://openrouter.ai/keys",
          keyLabel: "Get Free OpenRouter Key ↗"
        };
      case "openai":
        return {
          model: "gpt-4o-mini",
          endpoint: "",
          hint: "Standard: OpenAI GPT-4o Mini or GPT-4o with image input.",
          keyLink: "https://platform.openai.com/api-keys",
          keyLabel: "Get OpenAI Key ↗"
        };
      case "custom":
      default:
        return {
          model: "",
          endpoint: "",
          hint: "OpenAI-compatible endpoints (vLLM, LM Studio, Cloudflare Workers AI).",
          keyLink: "",
          keyLabel: ""
        };
    }
  }

  const PROVIDER_MODELS = {
    gemini: [
      { id: "gemini-2.5-flash", label: "gemini-2.5-flash (Recommended - Active Free Tier)" },
      { id: "gemini-2.5-flash-lite", label: "gemini-2.5-flash-lite (Fast & High Quota)" },
      { id: "gemini-3.8-flash", label: "gemini-3.8-flash (Latest Flash)" },
      { id: "gemini-2.0-flash", label: "gemini-2.0-flash (Ultra Fast Vision)" },
      { id: "gemini-1.5-flash", label: "gemini-1.5-flash" }
    ],
    ollama: [
      { id: "llama3.2-vision", label: "llama3.2-vision (11B Multimodal)" },
      { id: "minicpm-v", label: "minicpm-v (High-Res OCR & Text)" },
      { id: "llama3.2-vision:11b", label: "llama3.2-vision:11b" },
      { id: "qwen2.5-vl", label: "qwen2.5-vl (Asian OCR Specialist)" }
    ],
    groq: [
      { id: "llama-3.2-11b-vision-preview", label: "llama-3.2-11b-vision (100% Free & Fast)" },
      { id: "llama-3.2-90b-vision-preview", label: "llama-3.2-90b-vision (Large Vision)" }
    ],
    openrouter: [
      { id: "google/gemini-2.0-flash-exp:free", label: "gemini-2.0-flash:free (OpenRouter Free)" },
      { id: "qwen/qwen-2.5-vl-72b-instruct:free", label: "qwen-2.5-vl-72b:free (Top Japanese OCR)" },
      { id: "meta-llama/llama-3.2-11b-vision-instruct:free", label: "llama-3.2-11b-vision:free" }
    ],
    openai: [
      { id: "gpt-4o-mini", label: "gpt-4o-mini (Fast Multimodal)" },
      { id: "gpt-4o", label: "gpt-4o (High Precision Vision)" }
    ],
    custom: []
  };

  function updateModelSelect(provider, currentModel) {
    const modelSelect = $("modelSelect");
    if (!modelSelect) return;

    modelSelect.innerHTML = "";
    const list = PROVIDER_MODELS[provider] || [];

    for (const item of list) {
      const opt = document.createElement("option");
      opt.value = item.id;
      opt.textContent = item.label;
      modelSelect.appendChild(opt);
    }

    const customOpt = document.createElement("option");
    customOpt.value = "custom";
    customOpt.textContent = "Custom Model ID…";
    modelSelect.appendChild(customOpt);

    const match = Array.from(modelSelect.options).find(opt => opt.value === currentModel);
    modelSelect.value = match ? currentModel : "custom";
  }

  function render() {
    $("enabled").checked = Boolean(state.settings.enabled);
    $("apiKey").value = state.apiKey || "";
    $("provider").value = state.settings.provider || "gemini";

    const currentModel = state.settings.model || providerDefaults(state.settings.provider).model;
    $("model").value = currentModel;

    // Filter model dropdown dynamically to only show models for the active provider
    updateModelSelect(state.settings.provider || "gemini", currentModel);

    $("endpoint").value = state.settings.endpoint || "";
    $("fontFamily").value = state.settings.fontFamily || "Comic Neue";

    const fillPct = Math.round((state.settings.fillRatio ?? DEFAULTS.fillRatio) * 100);
    $("fillRatio").value = String(state.settings.fillRatio ?? DEFAULTS.fillRatio);
    $("fillValue").value = `${fillPct}%`;

    const revealPct = Math.round((state.settings.revealOpacity ?? DEFAULTS.revealOpacity) * 100);
    $("revealOpacity").value = String(state.settings.revealOpacity ?? DEFAULTS.revealOpacity);
    $("revealValue").value = `${revealPct}%`;

    $("showTooltip").checked = Boolean(state.settings.showTooltip);
    $("visibleOnly").checked = Boolean(state.settings.translateVisibleOnly);
    if ($("autoTranslate")) {
      $("autoTranslate").checked = Boolean(state.settings.autoTranslate);
    }

    // Endpoint display
    const isCustom = state.settings.provider === "custom" || state.settings.provider === "ollama";
    $("endpointRow").style.display = isCustom ? "block" : "none";

    if (state.settings.provider === "ollama") {
      $("apiKey").placeholder = "Not required for local Ollama (leave blank)";
      $("keyHint").textContent = "Local offline model. No API key needed!";
      if (!$("endpoint").value) {
        $("endpoint").value = "http://localhost:11434/v1";
      }
    } else {
      $("apiKey").placeholder = "Paste your API key here";
      $("keyHint").textContent = "Stored locally in your Chrome storage. Never shared.";
    }

    const pInfo = providerDefaults(state.settings.provider);
    $("modelHint").innerHTML = pInfo.hint;

    const keyLink = $("getKeyLink");
    if (pInfo.keyLink) {
      keyLink.style.display = "inline";
      keyLink.href = pInfo.keyLink;
      keyLink.textContent = pInfo.keyLabel;
    } else {
      keyLink.style.display = "none";
    }

    // Custom Font status
    const fontStatus = $("customFontStatus");
    const removeBtn = $("removeCustomFont");
    if (state.settings.customFont?.family) {
      fontStatus.textContent = `Active custom font: ${state.settings.customFont.family}`;
      removeBtn.style.display = "inline";
    } else {
      fontStatus.textContent = "No custom font loaded (using built-in comic font).";
      removeBtn.style.display = "none";
    }
  }

  async function load() {
    const stored = await chrome.storage.local.get({
      settings: DEFAULTS,
      apiKey: ""
    });

    state.settings = {
      ...DEFAULTS,
      ...(stored.settings || {})
    };

    // Auto-migrate from deprecated models if previously saved
    if (state.settings.model === "gemini-1.5-pro" || !state.settings.model) {
      state.settings.model = "gemini-2.5-flash";
    }

    state.apiKey = String(stored.apiKey || "").trim();

    render();
    queryActiveTabStatus();
  }

  async function save() {
    state.settings = {
      ...state.settings,
      enabled: $("enabled").checked,
      provider: $("provider").value,
      model: $("model").value.trim(),
      endpoint: $("endpoint").value.trim(),
      fontFamily: $("fontFamily").value,
      fillRatio: Number($("fillRatio").value) || DEFAULTS.fillRatio,
      revealOpacity: Number($("revealOpacity").value) || DEFAULTS.revealOpacity,
      showTooltip: $("showTooltip").checked,
      translateVisibleOnly: $("visibleOnly").checked,
      autoTranslate: $("autoTranslate") ? $("autoTranslate").checked : false
    };

    state.apiKey = $("apiKey").value.trim();

    await chrome.storage.local.set({
      settings: state.settings,
      apiKey: state.apiKey
    });
  }

  function isInternalUrl(url) {
    return !url || /^(chrome|edge|devtools|about|chrome-extension):/i.test(url);
  }

  async function getTargetTab() {
    const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
    let tab = activeTabs[0];

    // If current tab is chrome:// or extension settings, look for an open web tab
    if (!tab || isInternalUrl(tab.url)) {
      const allTabs = await chrome.tabs.query({ currentWindow: true });
      const webTab = allTabs.find(t => t.url && !isInternalUrl(t.url));
      if (webTab) {
        tab = webTab;
      }
    }

    if (!tab?.id) {
      throw new Error("Please switch to your manga reader tab (e.g. Rawkuma).");
    }

    if (isInternalUrl(tab.url)) {
      throw new Error("Please switch to a manga web page tab (e.g. Rawkuma) to translate.");
    }

    return tab;
  }

  async function sendToCurrentTab(message) {
    const tab = await getTargetTab();

    const trySend = () => {
      return new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tab.id, message, response => {
          const err = chrome.runtime.lastError;
          if (err) reject(err);
          else resolve(response);
        });
      });
    };

    try {
      return await trySend();
    } catch (err) {
      // If content script was disconnected or not yet injected (e.g. after extension reload),
      // dynamically inject content.js and content.css into the tab!
      if (/receiving end does not exist|could not establish connection/i.test(err?.message || "")) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ["content.js"]
          });
          await chrome.scripting.insertCSS({
            target: { tabId: tab.id },
            files: ["content.css"]
          });
          await new Promise(r => setTimeout(r, 180));
          return await trySend();
        } catch (injectErr) {
          throw new Error("Please refresh your manga tab (press F5) to connect to the reloaded extension.");
        }
      }
      throw err;
    }
  }

  async function queryActiveTabStatus() {
    try {
      const res = await sendToCurrentTab({ type: "GET_STATUS" });
      if (res?.ok) {
        $("pageStats").textContent = `Images on page: ${res.totalImages} (${res.translated} translated)`;
      } else {
        $("pageStats").textContent = "Ready on manga reader page.";
      }
    } catch {
      $("pageStats").textContent = "Open a manga chapter page to translate.";
    }
  }

  async function testApiConnection() {
    await save();
    const status = $("apiStatus");
    status.className = "status-pill busy";
    status.textContent = "Testing connection…";

    try {
      const response = await chrome.runtime.sendMessage({ type: "PING_API" });
      if (!response?.ok) {
        throw new Error(response?.error || "Connection check failed.");
      }
      if (response.model) {
        state.settings.model = response.model;
        $("model").value = response.model;
        const prov = state.settings.provider || "gemini";
        if (Array.isArray(response.availableModels)) {
          if (!PROVIDER_MODELS[prov]) PROVIDER_MODELS[prov] = [];
          for (const mId of response.availableModels) {
            if (!PROVIDER_MODELS[prov].some(m => m.id === mId)) {
              PROVIDER_MODELS[prov].unshift({
                id: mId,
                label: `${mId} (Discovered on your key)`
              });
            }
          }
        }
        updateModelSelect(prov, response.model);
      }
      status.className = "status-pill ok";
      status.textContent = response.message || "Connected successfully!";
    } catch (err) {
      status.className = "status-pill error";
      status.textContent = err.message || "Failed to connect.";
    }
  }

  function guessFontFormat(filename) {
    const lower = filename.toLowerCase();
    if (lower.endsWith(".woff2")) return "woff2";
    if (lower.endsWith(".woff")) return "woff";
    if (lower.endsWith(".otf")) return "opentype";
    return "truetype";
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error("Failed to read font file."));
      reader.readAsDataURL(file);
    });
  }

  async function handleFontUpload(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    if (file.size > 8 * 1024 * 1024) {
      alert("Font file is too large (> 8MB). Please choose a smaller font file.");
      event.target.value = "";
      return;
    }

    try {
      const dataUrl = await readFileAsDataUrl(file);
      const cleanName = file.name
        .replace(/\.(ttf|woff2?|otf)$/i, "")
        .replace(/[^a-zA-Z0-9 _-]/g, "")
        .slice(0, 60) || "Custom Manga Font";

      state.settings.customFont = {
        family: cleanName,
        format: guessFontFormat(file.name),
        dataUrl
      };

      await chrome.storage.local.set({ settings: state.settings });
      render();
    } catch (err) {
      alert("Error uploading font: " + err.message);
    } finally {
      event.target.value = "";
    }
  }

  async function handleRemoveCustomFont() {
    state.settings.customFont = null;
    await chrome.storage.local.set({ settings: state.settings });
    render();
  }

  /* =========================================================================
     Event Bindings
     ========================================================================= */

  $("toggleKey").addEventListener("click", () => {
    const input = $("apiKey");
    const isPassword = input.type === "password";
    input.type = isPassword ? "text" : "password";
    $("toggleKey").textContent = isPassword ? "🙈" : "👁️";
  });

  $("provider").addEventListener("change", async () => {
    const next = $("provider").value;
    state.settings.provider = next;
    const defaults = providerDefaults(next);
    $("model").value = defaults.model;
    state.settings.model = defaults.model;
    if (next === "ollama") {
      $("endpoint").value = defaults.endpoint;
      state.settings.endpoint = defaults.endpoint;
    } else if (next !== "custom") {
      $("endpoint").value = "";
      state.settings.endpoint = "";
    }
    render();
    await save();
  });

  $("enabled").addEventListener("change", save);
  $("apiKey").addEventListener("change", save);

  const modelSelect = $("modelSelect");
  if (modelSelect) {
    modelSelect.addEventListener("change", async () => {
      const selected = modelSelect.value;
      if (selected !== "custom") {
        $("model").value = selected;
        state.settings.model = selected;
        await save();
      } else {
        $("model").focus();
      }
    });
  }

  $("model").addEventListener("input", () => {
    const val = $("model").value.trim();
    if (modelSelect) {
      const match = Array.from(modelSelect.options).find(opt => opt.value === val);
      modelSelect.value = match ? val : "custom";
    }
  });
  $("model").addEventListener("change", save);
  $("endpoint").addEventListener("change", save);
  $("fontFamily").addEventListener("change", save);
  $("showTooltip").addEventListener("change", save);
  $("visibleOnly").addEventListener("change", save);
  if ($("autoTranslate")) {
    $("autoTranslate").addEventListener("change", save);
  }

  $("fillRatio").addEventListener("input", () => {
    const pct = Math.round(Number($("fillRatio").value) * 100);
    $("fillValue").value = `${pct}%`;
  });
  $("fillRatio").addEventListener("change", save);

  $("revealOpacity").addEventListener("input", () => {
    const pct = Math.round(Number($("revealOpacity").value) * 100);
    $("revealValue").value = `${pct}%`;
  });
  $("revealOpacity").addEventListener("change", save);

  $("fontFile").addEventListener("change", handleFontUpload);
  $("removeCustomFont").addEventListener("click", handleRemoveCustomFont);

  $("testApi").addEventListener("click", testApiConnection);

  $("translate").addEventListener("click", async () => {
    try {
      await save();
      const status = $("pageStats");
      status.textContent = "Initiating canvas translation…";
      const res = await sendToCurrentTab({ type: "TRANSLATE_PAGE" });
      if (!res?.ok) throw new Error(res?.error || "Content script did not respond.");
      status.textContent = "Translating manga pages in-place…";
      setTimeout(queryActiveTabStatus, 1800);
    } catch (err) {
      $("pageStats").textContent = "Error: " + err.message;
    }
  });

  $("clear").addEventListener("click", async () => {
    try {
      const res = await sendToCurrentTab({ type: "CLEAR_OVERLAYS" });
      if (!res?.ok) throw new Error(res?.error || "Failed to clear overlays.");
      $("pageStats").textContent = "Reverted all pages to raw Japanese.";
    } catch (err) {
      $("pageStats").textContent = "Error: " + err.message;
    }
  });

  // Start initialization
  load().catch(err => console.error("Popup init error:", err));
})();