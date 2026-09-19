/**
 * Scan Translator - Manga Canvas & Typesetting
 * Service Worker (MV3)
 */

const DEFAULT_PROVIDER = "gemini";
const DEFAULT_MODEL = "gemini-3.8-flash";
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";
const DEFAULT_GROQ_MODEL = "llama-3.2-11b-vision-preview";
const DEFAULT_OPENROUTER_MODEL = "google/gemini-2.0-flash-exp:free";
const DEFAULT_OLLAMA_MODEL = "llama3.2-vision";
const DEFAULT_OLLAMA_ENDPOINT = "http://localhost:11434/v1";
const DEFAULT_ENDPOINT = "";
const MAX_IMAGE_BYTES = 25 * 1024 * 1024; // 25MB max
const MAX_OUTPUT_TOKENS = 8192;

const GEMINI_FALLBACK_MODELS = [
  "gemini-3.8-flash",
  "gemini-2.0-flash",
  "gemini-1.5-flash",
  "gemini-2.0-flash-lite",
  "gemini-1.5-pro"
];

const MANGA_PROMPT = `You are an expert manga localization and computer vision analysis engine.
Your task is to analyze the provided Japanese manga page image, detect all dialogue and text regions (speech bubbles, thought bubbles, narration boxes, sound effects), transcribe the Japanese text, and translate it into natural, high-impact English comic dialogue.

For each dialogue region:
1. Detect the outer speech bubble or caption box contour:
   - "bubble_x", "bubble_y", "bubble_w", "bubble_h": Normalized coordinates (0.0 to 1.0 relative to total image width and height) of the ENTIRE enclosing bubble or box.
2. Detect the exact Japanese text bounds:
   - "mask_x", "mask_y", "mask_w", "mask_h": Normalized coordinates (0.0 to 1.0) of the bounding box tightly enclosing the Japanese glyphs that need to be erased/inpainted.
3. Identify visual styling:
   - "background": "light" (white, off-white, light gray) or "dark" (black, dark screentone, inverted speech bubble) or "screentone".
   - "text_color": "dark" (black lettering) or "light" (white lettering on dark bubble).
   - "shape": "oval" (standard rounded/elliptical speech bubble), "rectangle" (narration/box), "burst" (spiky shouting bubble), "cloud" (thought bubble), "free" (floating dialogue without outline).
   - "orientation": "vertical" (traditional vertical Japanese text) or "horizontal".
   - "emphasis": "normal", "shout" (bold/yelling), "whisper" (quiet/subdued), or "sfx" (sound effect).
4. OCR & Translation:
   - "source_text": Exact verbatim Japanese OCR transcript (including furigana if readable, kana, kanji, punctuation).
   - "translation": High-quality localized English translation formatted in UPPERCASE suitable for comic book lettering. Preserve emotion, comic nuance, character voice, and pacing. Keep it punchy and natural.

CRITICAL:
- Do not skip small dialogue, whispered asides, or inverted dark bubbles.
- All coordinate values MUST be between 0.0 and 1.0.
- Return ONLY a valid JSON object without markdown fences, following this exact schema:
{
  "page_width": 1000,
  "page_height": 1500,
  "regions": [
    {
      "id": "bubble-1",
      "source_text": "チームのためになると\n思ったからです",
      "translation": "BECAUSE I THOUGHT IT WOULD HELP THE TEAM.",
      "kind": "speech",
      "orientation": "vertical",
      "bubble_x": 0.12,
      "bubble_y": 0.35,
      "bubble_w": 0.15,
      "bubble_h": 0.14,
      "mask_x": 0.14,
      "mask_y": 0.37,
      "mask_w": 0.11,
      "mask_h": 0.10,
      "background": "light",
      "text_color": "dark",
      "shape": "oval",
      "emphasis": "normal",
      "confidence": 0.95
    }
  ]
}`;

function stripMarkdownJson(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return "";
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function parseJsonOutput(text) {
  const clean = stripMarkdownJson(text);
  if (!clean) {
    throw new Error("The AI model returned an empty response.");
  }

  try {
    return JSON.parse(clean);
  } catch {}

  const first = clean.indexOf("{");
  const last = clean.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(clean.slice(first, last + 1));
    } catch {}
  }

  throw new Error("Could not parse AI response as JSON: " + clean.slice(0, 150) + "...");
}

function parseDataUrl(dataUrl) {
  const match = String(dataUrl || "").match(/^data:([^;,]+);base64,([\s\S]+)$/i);
  if (!match) {
    throw new Error("Invalid image data URL format.");
  }
  return {
    mimeType: match[1],
    base64: match[2].trim()
  };
}

async function blobToDataUrl(blob) {
  if (blob.size > MAX_IMAGE_BYTES) {
    throw new Error(`Image exceeds maximum size limit (${Math.round(blob.size / 1024 / 1024)} MB).`);
  }

  const mime = blob.type && blob.type.startsWith("image/") ? blob.type : "image/jpeg";
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunkSize, bytes.length)));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

async function fetchImageAsDataUrl(url, pageUrl) {
  if (!url || !/^https?:|^data:|^blob:/i.test(url)) {
    throw new Error("Unsupported image URL scheme.");
  }
  if (/^data:/i.test(url)) {
    return url;
  }
  if (/^blob:/i.test(url)) {
    throw new Error("Blob URLs must be rasterized in content script.");
  }

  const response = await fetch(url, {
    method: "GET",
    credentials: "include",
    cache: "force-cache",
    referrer: pageUrl || undefined,
    referrerPolicy: "strict-origin-when-cross-origin"
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch image: HTTP ${response.status}`);
  }

  return blobToDataUrl(await response.blob());
}

/* =========================================================================
   Provider Implementations
   ========================================================================= */

/**
 * Official Google Gemini REST API (v1beta generateContent)
 */
async function callGemini({ apiKey, model, imageDataUrl }) {
  const { mimeType, base64 } = parseDataUrl(imageDataUrl);
  const candidateModels = Array.from(new Set([model || DEFAULT_MODEL, ...GEMINI_FALLBACK_MODELS]));

  const body = {
    system_instruction: {
      parts: [
        {
          text: "You are an expert manga localization and computer vision analysis engine. Output only valid JSON with normalized coordinates (0.0 to 1.0)."
        }
      ]
    },
    contents: [
      {
        role: "user",
        parts: [
          { text: MANGA_PROMPT },
          {
            inline_data: {
              mime_type: mimeType,
              data: base64
            }
          }
        ]
      }
    ],
    generationConfig: {
      response_mime_type: "application/json",
      temperature: 0.15,
      maxOutputTokens: MAX_OUTPUT_TOKENS
    }
  };

  let lastError = null;

  for (const currentModel of candidateModels) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(currentModel)}:generateContent?key=${encodeURIComponent(apiKey)}`;

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      });

      const rawText = await response.text();
      let json = null;
      try {
        json = JSON.parse(rawText);
      } catch {}

      if (!response.ok) {
        const errorMsg = json?.error?.message || json?.error?.status || rawText || `Gemini HTTP ${response.status}`;
        if (/404|not found|no longer available|deprecated|high demand|spikes in demand|overloaded|unavailable|resource_exhausted|quota|503|429/i.test(errorMsg) && currentModel !== candidateModels[candidateModels.length - 1]) {
          console.warn(`[ScanTranslator] Gemini model ${currentModel} error (${errorMsg}), trying fallback model...`);
          lastError = new Error(`Google Gemini Error (${currentModel}): ${errorMsg}`);
          continue;
        }
        throw new Error(`Google Gemini Error: ${errorMsg}`);
      }

      const candidate = json?.candidates?.[0];
      if (!candidate) {
        throw new Error("Gemini returned no candidate outputs.");
      }

      let textOutput = "";
      for (const part of candidate?.content?.parts || []) {
        if (typeof part.text === "string") {
          textOutput += part.text;
        }
      }

      if (currentModel !== model) {
        const stored = await chrome.storage.local.get({ settings: {} });
        await chrome.storage.local.set({
          settings: { ...(stored.settings || {}), model: currentModel }
        });
      }

      return parseJsonOutput(textOutput);
    } catch (err) {
      if (/404|not found|no longer available|deprecated|high demand|spikes in demand|overloaded|unavailable|resource_exhausted|quota|503|429/i.test(err.message) && currentModel !== candidateModels[candidateModels.length - 1]) {
        console.warn(`[ScanTranslator] Retrying with fallback model after: ${err.message}`);
        lastError = err;
        continue;
      }
      throw err;
    }
  }

  throw lastError || new Error("Failed to process manga image with available Gemini models.");
}

/**
 * Standard OpenAI Chat Completions API
 */
async function callOpenAI({ apiKey, model, imageDataUrl }) {
  const targetModel = model || DEFAULT_OPENAI_MODEL;
  const url = "https://api.openai.com/v1/chat/completions";

  const body = {
    model: targetModel,
    temperature: 0.2,
    max_tokens: MAX_OUTPUT_TOKENS,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: "You are an expert manga localization and OCR system. Always respond with valid JSON matching the requested schema."
      },
      {
        role: "user",
        content: [
          { type: "text", text: MANGA_PROMPT },
          {
            type: "image_url",
            image_url: {
              url: imageDataUrl,
              detail: "high"
            }
          }
        ]
      }
    ]
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });

  const rawText = await response.text();
  let json = null;
  try {
    json = JSON.parse(rawText);
  } catch {}

  if (!response.ok) {
    const errorMsg = json?.error?.message || rawText || `OpenAI HTTP ${response.status}`;
    throw new Error(`OpenAI Error: ${errorMsg}`);
  }

  const content = json?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("OpenAI returned an empty response.");
  }

  return parseJsonOutput(content);
}

/**
 * Custom OpenAI-compatible Chat API (Ollama, vLLM, OpenRouter, LM Studio, etc.)
 */
async function callOpenAICompatible({ apiKey, model, imageDataUrl, endpoint }) {
  let url = String(endpoint || "").trim().replace(/\/+$/, "");
  if (!url) {
    throw new Error("Endpoint URL is required for Custom provider.");
  }
  if (!/\/chat\/completions$/i.test(url)) {
    url = /\/v1$/i.test(url) ? `${url}/chat/completions` : `${url}/v1/chat/completions`;
  }

  const body = {
    model: model || "",
    temperature: 0.2,
    max_tokens: MAX_OUTPUT_TOKENS,
    messages: [
      {
        role: "system",
        content: "You are an expert manga localization system. Return raw JSON matching the required schema."
      },
      {
        role: "user",
        content: [
          { type: "text", text: MANGA_PROMPT },
          {
            type: "image_url",
            image_url: {
              url: imageDataUrl
            }
          }
        ]
      }
    ]
  };

  const headers = {
    "Content-Type": "application/json"
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });

  const rawText = await response.text();
  let json = null;
  try {
    json = JSON.parse(rawText);
  } catch {}

  if (!response.ok) {
    const errorMsg = json?.error?.message || rawText || `Custom Provider HTTP ${response.status}`;
    throw new Error(`Custom Provider Error: ${errorMsg}`);
  }

  const content = json?.choices?.[0]?.message?.content;
  return parseJsonOutput(content);
}

async function analyzeImage({ provider, apiKey, model, endpoint, imageDataUrl }) {
  const activeProvider = String(provider || DEFAULT_PROVIDER).toLowerCase();

  if (!apiKey && activeProvider !== "custom" && activeProvider !== "ollama") {
    throw new Error("No API key configured. Please add your API key in the extension popup.");
  }
  if (!imageDataUrl?.startsWith("data:image/")) {
    throw new Error("Invalid image data received.");
  }

  switch (activeProvider) {
    case "gemini":
      return callGemini({ apiKey, model, imageDataUrl });
    case "ollama":
      return callOpenAICompatible({
        apiKey: apiKey || "ollama",
        model: model || DEFAULT_OLLAMA_MODEL,
        imageDataUrl,
        endpoint: endpoint || DEFAULT_OLLAMA_ENDPOINT
      });
    case "groq":
      return callOpenAICompatible({
        apiKey,
        model: model || DEFAULT_GROQ_MODEL,
        imageDataUrl,
        endpoint: "https://api.groq.com/openai/v1"
      });
    case "openrouter":
      return callOpenAICompatible({
        apiKey,
        model: model || DEFAULT_OPENROUTER_MODEL,
        imageDataUrl,
        endpoint: "https://openrouter.ai/api/v1"
      });
    case "openai":
      return callOpenAI({ apiKey, model, imageDataUrl });
    case "custom":
    case "openai-compatible":
      return callOpenAICompatible({ apiKey, model, imageDataUrl, endpoint });
    default:
      return callGemini({ apiKey, model, imageDataUrl });
  }
}

/* =========================================================================
   Health / Ping Checks
   ========================================================================= */

async function pingGemini(apiKey, model) {
  const candidateModels = Array.from(new Set([model || DEFAULT_MODEL, ...GEMINI_FALLBACK_MODELS]));
  let lastError = null;

  for (const currentModel of candidateModels) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(currentModel)}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "Ping test. Reply with OK." }] }]
        })
      });

      if (response.ok) {
        if (currentModel !== model) {
          const stored = await chrome.storage.local.get({ settings: {} });
          await chrome.storage.local.set({
            settings: { ...(stored.settings || {}), model: currentModel }
          });
        }
        return currentModel;
      }

      const text = await response.text();
      lastError = new Error(`Gemini test failed for ${currentModel} (${response.status}): ${text.slice(0, 140)}`);
      if (!/404|not found|no longer available|deprecated|high demand|spikes in demand|overloaded|unavailable|resource_exhausted|quota|503|429/i.test(text)) {
        throw lastError;
      }
    } catch (err) {
      if (!/404|not found|no longer available|deprecated|high demand|spikes in demand|overloaded|unavailable|resource_exhausted|quota|503|429/i.test(err.message)) {
        throw err;
      }
      lastError = err;
    }
  }

  throw lastError || new Error("All Gemini models failed connection test.");
}

async function pingOpenAI(apiKey, model) {
  const targetModel = model || DEFAULT_OPENAI_MODEL;
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: targetModel,
      max_tokens: 5,
      messages: [{ role: "user", content: "Ping" }]
    })
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI test failed (${response.status}): ${text.slice(0, 120)}`);
  }
}

async function pingCustom(apiKey, model, endpoint) {
  let url = String(endpoint || "").trim().replace(/\/+$/, "");
  if (!url) throw new Error("Endpoint URL is required.");
  if (!/\/chat\/completions$/i.test(url)) {
    url = /\/v1$/i.test(url) ? `${url}/chat/completions` : `${url}/v1/chat/completions`;
  }
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: model || "",
      max_tokens: 5,
      messages: [{ role: "user", content: "Ping" }]
    })
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Custom provider test failed (${response.status}): ${text.slice(0, 120)}`);
  }
}

async function pingOllama(model, endpoint) {
  let base = String(endpoint || DEFAULT_OLLAMA_ENDPOINT).trim().replace(/\/+$/, "");
  base = base.replace(/\/v1(\/chat\/completions)?$/i, "");
  try {
    const res = await fetch(`${base}/api/tags`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const installed = (data.models || []).map(m => m.name);
    const target = model || DEFAULT_OLLAMA_MODEL;
    const found = installed.some(m => m.toLowerCase().includes(target.toLowerCase()));
    if (!found) {
      if (installed.length === 0) {
        return {
          ok: true,
          message: `Ollama is running, but no models found! Run in PowerShell: ollama run ${target}`
        };
      }
      return {
        ok: true,
        message: `Ollama connected! Note: '${target}' not downloaded yet (found: ${installed.slice(0, 2).join(", ")}). Run: ollama run ${target}`
      };
    }
    return { ok: true, message: `Connected to local Ollama with model: ${target}!` };
  } catch (err) {
    throw new Error(`Cannot reach Ollama at ${base}. Is Ollama running? (${err.message})`);
  }
}

/* =========================================================================
   Storage & Message Routing
   ========================================================================= */

async function loadSettings() {
  const values = await chrome.storage.local.get({
    apiKey: "",
    settings: {
      provider: DEFAULT_PROVIDER,
      model: DEFAULT_MODEL,
      endpoint: DEFAULT_ENDPOINT
    }
  });

  const settings = values.settings || {};
  return {
    apiKey: String(values.apiKey || "").trim(),
    provider: String(settings.provider || DEFAULT_PROVIDER).trim(),
    model: String(settings.model || DEFAULT_MODEL).trim(),
    endpoint: String(settings.endpoint || DEFAULT_ENDPOINT).trim()
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      switch (message?.type) {
        case "FETCH_IMAGE": {
          const dataUrl = await fetchImageAsDataUrl(
            message.url,
            message.pageUrl || sender?.url || ""
          );
          sendResponse({ ok: true, dataUrl });
          return;
        }

        case "ANALYZE_IMAGE": {
          const settings = await loadSettings();
          const result = await analyzeImage({
            ...settings,
            imageDataUrl: message.imageDataUrl
          });
          sendResponse({ ok: true, result });
          return;
        }

        case "PING_API": {
          const settings = await loadSettings();
          const provider = settings.provider.toLowerCase();

          if (provider === "gemini") {
            if (!settings.apiKey) throw new Error("Please enter your Google Gemini API key.");
            const workingModel = await pingGemini(settings.apiKey, settings.model);
            sendResponse({ ok: true, model: workingModel, message: `Connected successfully to Google Gemini (${workingModel})!` });
          } else if (provider === "ollama") {
            const pingRes = await pingOllama(settings.model || DEFAULT_OLLAMA_MODEL, settings.endpoint || DEFAULT_OLLAMA_ENDPOINT);
            sendResponse(pingRes);
          } else if (provider === "groq") {
            if (!settings.apiKey) throw new Error("Please enter your free Groq API key.");
            await pingCustom(settings.apiKey, settings.model || DEFAULT_GROQ_MODEL, "https://api.groq.com/openai/v1");
            sendResponse({ ok: true, message: `Connected successfully to Groq (${settings.model || DEFAULT_GROQ_MODEL})!` });
          } else if (provider === "openrouter") {
            if (!settings.apiKey) throw new Error("Please enter your OpenRouter API key.");
            await pingCustom(settings.apiKey, settings.model || DEFAULT_OPENROUTER_MODEL, "https://openrouter.ai/api/v1");
            sendResponse({ ok: true, message: `Connected successfully to OpenRouter (${settings.model || DEFAULT_OPENROUTER_MODEL})!` });
          } else if (provider === "openai") {
            if (!settings.apiKey) throw new Error("Please enter your OpenAI API key.");
            await pingOpenAI(settings.apiKey, settings.model);
            sendResponse({ ok: true, message: `Connected successfully to OpenAI (${settings.model || DEFAULT_OPENAI_MODEL})!` });
          } else {
            await pingCustom(settings.apiKey, settings.model, settings.endpoint);
            sendResponse({ ok: true, message: "Custom endpoint connected successfully!" });
          }
          return;
        }

        default:
          sendResponse({ ok: false, error: "Unrecognized message type." });
      }
    } catch (error) {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  })();

  return true; // Keep sendResponse channel open for async execution
});