/**
 * Scan Translator - Manga Canvas & Typesetting
 * Content Script (MV3)
 *
 * Implements HTML5 Canvas inpainting, Japanese text erasure,
 * professional comic typesetting (elliptical shape-fitting),
 * seamless image replacement, and hover-to-reveal inspection lens.
 */

(() => {
  "use strict";

  const DEFAULTS = {
    enabled: true,
    autoTranslate: false,
    fontFamily: "Comic Neue",
    customFont: null,
    fillRatio: 0.76,
    revealOpacity: 0.15,
    minConfidence: 0.45,
    translateVisibleOnly: true,
    showTooltip: true,
    debug: false,
    provider: "gemini",
    model: "gemini-2.5-flash",
    endpoint: ""
  };

  const state = {
    settings: { ...DEFAULTS },
    images: new Map(), // key -> Record
    observer: null,
    resizeTimer: null,
    mutationTimer: null,
    scanning: false,
    styleElement: null,
    fontFaceLoaded: false,
    root: null,
    tooltip: null,
    isRawModeGlobal: false
  };

  /* =========================================================================
     Settings & Font Management
     ========================================================================= */

  function mergeSettings(input) {
    const next = { ...DEFAULTS, ...(input || {}) };
    next.autoTranslate = Boolean(next.autoTranslate);
    next.fillRatio = Math.min(0.92, Math.max(0.50, Number(next.fillRatio) || DEFAULTS.fillRatio));
    next.revealOpacity = Math.min(0.50, Math.max(0.02, Number(next.revealOpacity) || DEFAULTS.revealOpacity));
    next.minConfidence = Math.min(1, Math.max(0, Number(next.minConfidence) || DEFAULTS.minConfidence));
    return next;
  }

  async function loadSettings() {
    const stored = await chrome.storage.local.get({ settings: DEFAULTS });
    state.settings = mergeSettings(stored.settings);
    await applyTypography();
  }

  async function applyTypography() {
    if (state.styleElement) {
      state.styleElement.remove();
    }
    state.styleElement = document.createElement("style");
    state.styleElement.id = "mot-dynamic-fonts";

    let fontStack = `'Comic Neue', 'Comic Sans MS', cursive, sans-serif`;

    if (state.settings.customFont?.dataUrl) {
      const family = safeFontName(state.settings.customFont.family || "MOT Custom Font");
      const format = state.settings.customFont.format || "woff2";

      try {
        const fontFace = new FontFace(family, `url(${state.settings.customFont.dataUrl})`);
        await fontFace.load();
        document.fonts.add(fontFace);
        state.fontFaceLoaded = true;
      } catch (err) {
        console.warn("[ScanTranslator] Could not register FontFace API:", err);
      }

      state.styleElement.textContent = `
        @font-face {
          font-family: "${escapeCss(family)}";
          src: url("${state.settings.customFont.dataUrl}") format("${escapeCss(format)}");
          font-style: normal;
          font-weight: 100 900;
          font-display: swap;
        }
        :root {
          --mot-font-family: "${escapeCss(family)}", 'Comic Neue', cursive, sans-serif !important;
        }
      `;
      fontStack = `"${family}", 'Comic Neue', cursive, sans-serif`;
    } else {
      const selected = state.settings.fontFamily || "Comic Neue";
      const allowed = {
        "Comic Neue": `'Comic Neue', cursive, sans-serif`,
        "Comic Sans MS": `'Comic Sans MS', 'Comic Neue', cursive, sans-serif`,
        "Anime Ace": `'Anime Ace', 'Comic Neue', cursive, sans-serif`,
        "CC Wild Words": `'CC Wild Words', 'Comic Neue', cursive, sans-serif`,
        "Chalkboard SE": `'Chalkboard SE', 'Comic Sans MS', cursive, sans-serif`,
        "Impact": `Impact, 'Arial Black', sans-serif`,
        "Trebuchet MS": `'Trebuchet MS', Arial, sans-serif`,
        "Arial": `Arial, Helvetica, sans-serif`
      };
      fontStack = allowed[selected] || allowed["Comic Neue"];
      state.styleElement.textContent = `
        :root {
          --mot-font-family: ${fontStack} !important;
        }
      `;
    }

    (document.head || document.documentElement).appendChild(state.styleElement);
    document.documentElement.style.setProperty("--mot-reveal-opacity", String(state.settings.revealOpacity));
  }

  function safeFontName(v) {
    return String(v || "").replace(/["\\{}<>;]/g, "").slice(0, 80) || "MOT Font";
  }

  function escapeCss(v) {
    return String(v || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  /* =========================================================================
     DOM Layer & Tooltip System
     ========================================================================= */

  function ensureRoot() {
    if (state.root?.isConnected) return state.root;
    state.root = document.createElement("div");
    state.root.id = "mot-root";
    state.root.setAttribute("aria-hidden", "true");
    document.documentElement.appendChild(state.root);
    return state.root;
  }

  function getOrCreateTooltip() {
    if (state.tooltip?.isConnected) return state.tooltip;
    state.tooltip = document.createElement("div");
    state.tooltip.className = "mot-tooltip";
    state.tooltip.style.display = "none";
    document.body.appendChild(state.tooltip);
    return state.tooltip;
  }

  function showTooltip(x, y, region) {
    if (!state.settings.showTooltip) return;
    const tt = getOrCreateTooltip();

    const kindLabel = String(region.kind || "speech").toUpperCase();
    const conf = Math.round((region.confidence || 0.9) * 100);

    tt.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <span class="mot-tooltip-badge">${kindLabel}</span>
        <span style="font-size:10px; color:#94a3b8;">${conf}% match</span>
      </div>
      <div class="mot-tooltip-raw" title="Click bubble to copy Japanese">${escapeHtml(region.sourceText || "")}</div>
      <div class="mot-tooltip-trans">${escapeHtml(region.translation || "")}</div>
      <div class="mot-tooltip-footer">
        <span>Hover: Raw Lens</span>
        <span>Click: Copy Japanese</span>
      </div>
    `;

    tt.style.display = "block";
    const pad = 12;
    const rect = tt.getBoundingClientRect();

    let left = x + pad;
    let top = y + pad;

    if (left + rect.width > window.innerWidth - 10) {
      left = x - rect.width - pad;
    }
    if (top + rect.height > window.innerHeight - 10) {
      top = y - rect.height - pad;
    }

    tt.style.left = `${Math.max(10, left)}px`;
    tt.style.top = `${Math.max(10, top)}px`;
  }

  function hideTooltip() {
    if (state.tooltip) {
      state.tooltip.style.display = "none";
    }
  }

  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  /* =========================================================================
     Manga Image Candidate Detection
     ========================================================================= */

  function isCandidateImage(img) {
    if (!(img instanceof HTMLImageElement)) return false;
    if (!img.complete || !img.naturalWidth || !img.naturalHeight) return false;

    // Filter out tiny icons, logos, or tracking pixels
    if (img.naturalWidth < 320 || img.naturalHeight < 320) return false;

    const rect = img.getBoundingClientRect();
    if (rect.width < 160 || rect.height < 160) return false;

    // Aspect ratio check (exclude extreme banners)
    const ratio = img.naturalWidth / img.naturalHeight;
    if (ratio < 0.15 || ratio > 3.5) return false;

    const style = getComputedStyle(img);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
      return false;
    }

    return true;
  }

  function getCandidateImages() {
    return Array.from(document.images).filter(isCandidateImage);
  }

  function imageKey(img) {
    const src = img.dataset.motOriginalSrc || img.currentSrc || img.src || img.dataset.src || "";
    return `${src}|${img.naturalWidth}x${img.naturalHeight}`;
  }

  function shouldProcessImage(img) {
    if (!isCandidateImage(img)) return false;
    if (!state.settings.translateVisibleOnly) return true;

    const rect = img.getBoundingClientRect();
    return rect.bottom > -window.innerHeight * 1.5 && rect.top < window.innerHeight * 2.5;
  }

  function waitForImage(img) {
    if (img.complete && img.naturalWidth) return Promise.resolve();
    return new Promise(resolve => {
      const done = () => resolve();
      img.addEventListener("load", done, { once: true });
      img.addEventListener("error", done, { once: true });
    });
  }

  async function imageToDataUrlViaCanvas(img) {
    await waitForImage(img);
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    try {
      return canvas.toDataURL("image/jpeg", 0.94);
    } catch (e) {
      throw new Error(`Cross-origin image could not be rasterized: ${e.message}`);
    }
  }

  async function getImageDataUrl(img) {
    const src = img.dataset.motOriginalSrc || img.currentSrc || img.src || img.dataset.src || "";
    if (!src) throw new Error("No valid image source found.");

    if (src.startsWith("data:image/")) return src;

    // Try background script fetch first (bypasses CORS restrictions)
    try {
      const fetched = await sendMessage({
        type: "FETCH_IMAGE",
        url: src,
        pageUrl: location.href
      });
      if (fetched?.ok && fetched.dataUrl) {
        return fetched.dataUrl;
      }
    } catch {}

    // Fallback to local canvas if same-origin
    return imageToDataUrlViaCanvas(img);
  }

  function getImageContentRect(img) {
    const rect = img.getBoundingClientRect();
    const cs = getComputedStyle(img);
    let x = rect.left;
    let y = rect.top;
    let w = rect.width;
    let h = rect.height;

    if (cs.objectFit === "contain" && img.naturalWidth && img.naturalHeight && w > 0 && h > 0) {
      const srcRatio = img.naturalWidth / img.naturalHeight;
      const boxRatio = w / h;
      if (srcRatio > boxRatio) {
        const renderedH = w / srcRatio;
        y += (h - renderedH) / 2;
        h = renderedH;
      } else {
        const renderedW = h * srcRatio;
        x += (w - renderedW) / 2;
        w = renderedW;
      }
    }

    return { x, y, w, h };
  }

  /* =========================================================================
     HTML5 Canvas Inpainting & Japanese Text Erasure
     ========================================================================= */

  /**
   * Samples clean speech bubble background and seamlessly in-paints the text region
   */
  function smartInpaintBubble(ctx, bubbleBox, textBox, isDarkBackground) {
    const { x: bx, y: by, w: bw, h: bh } = bubbleBox;
    const { x: tx, y: ty, w: tw, h: th } = textBox;

    // Clamp coordinates
    const safeTx = Math.max(bx, Math.min(bx + bw - 1, tx));
    const safeTy = Math.max(by, Math.min(by + bh - 1, ty));
    const safeTw = Math.min(bw, Math.max(1, tx + tw - safeTx));
    const safeTh = Math.min(bh, Math.max(1, ty + th - safeTy));

    // Sample boundary pixels of the text box inside the bubble to get exact background color
    const samplePad = Math.max(2, Math.round(Math.min(bw, bh) * 0.04));
    const sampleX = Math.max(bx + samplePad, safeTx - samplePad);
    const sampleY = Math.max(by + samplePad, safeTy - samplePad);
    const sampleW = Math.min(bw - samplePad * 2, safeTw + samplePad * 2);
    const sampleH = Math.min(bh - samplePad * 2, safeTh + samplePad * 2);

    let bgR = isDarkBackground ? 18 : 255;
    let bgG = isDarkBackground ? 18 : 255;
    let bgB = isDarkBackground ? 18 : 255;

    try {
      const perimeterData = ctx.getImageData(sampleX, sampleY, Math.max(1, sampleW), Math.max(1, sampleH));
      const pixels = perimeterData.data;
      let totalR = 0, totalG = 0, totalB = 0, count = 0;

      // Sample along the perimeter of the sampling window (avoids sampling central text glyphs)
      const step = 4;
      for (let px = 0; px < sampleW; px += step) {
        // Top edge
        let idx = (0 * sampleW + px) * 4;
        totalR += pixels[idx]; totalG += pixels[idx + 1]; totalB += pixels[idx + 2]; count++;
        // Bottom edge
        idx = ((sampleH - 1) * sampleW + px) * 4;
        totalR += pixels[idx]; totalG += pixels[idx + 1]; totalB += pixels[idx + 2]; count++;
      }
      for (let py = 0; py < sampleH; py += step) {
        // Left edge
        let idx = (py * sampleW + 0) * 4;
        totalR += pixels[idx]; totalG += pixels[idx + 1]; totalB += pixels[idx + 2]; count++;
        // Right edge
        idx = (py * sampleW + (sampleW - 1)) * 4;
        totalR += pixels[idx]; totalG += pixels[idx + 1]; totalB += pixels[idx + 2]; count++;
      }

      if (count > 0) {
        bgR = Math.round(totalR / count);
        bgG = Math.round(totalG / count);
        bgB = Math.round(totalB / count);
      }
    } catch {}

    ctx.save();

    // Preserve bubble outer borders:
    // Compute inset bubble path so the inpainting never clips the border stroke of the speech bubble
    const borderInset = Math.max(3, Math.min(bw, bh) * 0.05);
    const innerBx = bx + borderInset;
    const innerBy = by + borderInset;
    const innerBw = Math.max(1, bw - borderInset * 2);
    const innerBh = Math.max(1, bh - borderInset * 2);

    ctx.beginPath();
    ctx.ellipse(
      innerBx + innerBw / 2,
      innerBy + innerBh / 2,
      innerBw / 2,
      innerBh / 2,
      0,
      0,
      Math.PI * 2
    );
    ctx.clip(); // Restrict all inpainting inside the speech bubble interior

    // Multi-pass Inpainting:
    // 1. Soft feathered fill across the text bounding box
    const fillColor = `rgb(${bgR}, ${bgG}, ${bgB})`;
    ctx.fillStyle = fillColor;

    // Slight radial gradient feather for seamless blend into subtle screentones or paper shading
    const cx = safeTx + safeTw / 2;
    const cy = safeTy + safeTh / 2;
    const radius = Math.max(safeTw, safeTh) * 0.7;

    const grad = ctx.createRadialGradient(cx, cy, radius * 0.3, cx, cy, radius);
    grad.addColorStop(0, `rgba(${bgR}, ${bgG}, ${bgB}, 1.0)`);
    grad.addColorStop(0.85, `rgba(${bgR}, ${bgG}, ${bgB}, 0.98)`);
    grad.addColorStop(1, `rgba(${bgR}, ${bgG}, ${bgB}, 0.85)`);

    ctx.fillStyle = grad;
    // Draw rounded text mask area with slight margin to swallow kana & furigana
    const pad = Math.max(4, Math.round(Math.min(safeTw, safeTh) * 0.08));
    drawRoundedRect(
      ctx,
      safeTx - pad,
      safeTy - pad,
      safeTw + pad * 2,
      safeTh + pad * 2,
      Math.min(safeTw, safeTh) * 0.35
    );
    ctx.fill();

    ctx.restore();
  }

  function drawRoundedRect(ctx, x, y, w, h, r) {
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
  }

  /* =========================================================================
     Professional Manga Typesetting Engine (Elliptical Shape Fitting)
     ========================================================================= */

  /**
   * Calculates maximum allowed width inside an ellipse at vertical offset dy from center
   */
  function getEllipticalAllowedWidth(dy, halfW, halfH, shape) {
    if (shape === "rectangle") return halfW * 2;
    const normY = Math.abs(dy) / Math.max(1, halfH);
    if (normY >= 0.98) return 0;
    // Ellipse formula: (x/a)^2 + (y/b)^2 <= 1 => x = a * sqrt(1 - (y/b)^2)
    const factor = Math.sqrt(Math.max(0, 1 - normY * normY));
    return halfW * 2 * factor;
  }

  /**
   * Wraps text into lines that conform to the elliptical silhouette of the bubble
   */
  function wrapTextToShape(words, fontSize, halfW, halfH, shape) {
    const lineHeight = fontSize * 1.15;
    const maxLines = Math.max(1, Math.floor((halfH * 2) / lineHeight));

    // Try line counts from 1 up to maxLines to find best fit
    for (let targetLines = 1; targetLines <= maxLines; targetLines++) {
      const totalBlockHeight = targetLines * lineHeight;
      if (totalBlockHeight > halfH * 2 * 0.98) continue;

      const lines = [];
      let wordIndex = 0;
      let fits = true;

      for (let lineIdx = 0; lineIdx < targetLines; lineIdx++) {
        // Vertical distance of this line from vertical center
        const dy = (lineIdx - (targetLines - 1) / 2) * lineHeight;
        const allowedWidth = getEllipticalAllowedWidth(dy, halfW, halfH, shape);

        if (allowedWidth < fontSize * 1.8 && wordIndex < words.length) {
          fits = false;
          break;
        }

        let currentLine = "";
        while (wordIndex < words.length) {
          const testLine = currentLine ? `${currentLine} ${words[wordIndex]}` : words[wordIndex];
          // Approximate width based on average character width in comic typography (~0.58 em)
          const testWidth = testLine.length * (fontSize * 0.58);

          if (testWidth <= allowedWidth) {
            currentLine = testLine;
            wordIndex++;
          } else {
            break;
          }
        }

        if (currentLine) {
          lines.push({ text: currentLine, dy, allowedWidth });
        } else if (wordIndex < words.length) {
          fits = false;
          break;
        }
      }

      if (fits && wordIndex === words.length) {
        return { success: true, lines, fontSize, lineHeight };
      }
    }

    return { success: false };
  }

  /**
   * Binary searches optimal font size to achieve ~75% bubble fill without overflow
   */
  function calculateOptimalTypesetting(text, bubbleW, bubbleH, shape, fillRatio) {
    const rawWords = String(text || "").trim().split(/\s+/).filter(Boolean);
    if (!rawWords.length) return null;

    const halfW = (bubbleW / 2) * fillRatio;
    const halfH = (bubbleH / 2) * fillRatio;

    let minFont = Math.max(8, Math.round(Math.min(bubbleW, bubbleH) * 0.08));
    let maxFont = Math.round(Math.min(bubbleW, bubbleH) * 0.45);
    let bestResult = null;

    // Binary search over font sizes
    for (let iter = 0; iter < 12; iter++) {
      if (minFont > maxFont) break;
      const midFont = Math.floor((minFont + maxFont) / 2);
      const attempt = wrapTextToShape(rawWords, midFont, halfW, halfH, shape);

      if (attempt.success) {
        bestResult = attempt;
        minFont = midFont + 1; // Try larger font
      } else {
        maxFont = midFont - 1; // Need smaller font
      }
    }

    if (!bestResult) {
      // Fallback with minimal readable font
      const fallbackFont = Math.max(7, Math.round(Math.min(bubbleW, bubbleH) * 0.09));
      bestResult = wrapTextToShape(rawWords, fallbackFont, halfW, halfH, "rectangle");
      if (!bestResult.success) {
        bestResult = {
          success: true,
          fontSize: fallbackFont,
          lineHeight: fallbackFont * 1.15,
          lines: [{ text: rawWords.join(" "), dy: 0, allowedWidth: halfW * 2 }]
        };
      }
    }

    return bestResult;
  }

  /**
   * Renders typeset English text on HTML5 Canvas
   */
  function renderTypesetDialogue(ctx, region, bubbleBox, fontStack, fillRatio) {
    const text = String(region.translation || "").toUpperCase().trim();
    if (!text) return;

    const { x: bx, y: by, w: bw, h: bh } = bubbleBox;
    const cx = bx + bw / 2;
    const cy = by + bh / 2;

    const shape = region.shape || (region.kind === "caption" ? "rectangle" : "oval");
    const layout = calculateOptimalTypesetting(text, bw, bh, shape, fillRatio);
    if (!layout) return;

    ctx.save();

    const weight = region.emphasis === "shout" ? "900" : (region.emphasis === "whisper" ? "400" : "700");
    ctx.font = `${weight} ${layout.fontSize}px ${fontStack}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    const isLightBubble = region.background !== "dark" && region.textColor !== "light";
    const fillStyle = isLightBubble ? "#000000" : "#FFFFFF";
    const strokeStyle = isLightBubble ? "rgba(255, 255, 255, 0.9)" : "rgba(0, 0, 0, 0.9)";

    for (const line of layout.lines) {
      const lineY = cy + line.dy;

      // Subtle stroke for shouts or dark backgrounds to enhance contrast
      if (region.emphasis === "shout" || !isLightBubble) {
        ctx.lineWidth = Math.max(2, Math.round(layout.fontSize * 0.08));
        ctx.strokeStyle = strokeStyle;
        ctx.strokeText(line.text, cx, lineY);
      }

      ctx.fillStyle = fillStyle;
      ctx.fillText(line.text, cx, lineY);
    }

    ctx.restore();
  }

  /* =========================================================================
     Core Processing Pipeline
     ========================================================================= */

  function downscaleForAI(image, maxDimension = 1280) {
    const w = image.naturalWidth;
    const h = image.naturalHeight;
    if (w <= maxDimension && h <= maxDimension) {
      return image.src;
    }
    const scale = maxDimension / Math.max(w, h);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.82);
  }

  async function processImage(img) {
    const key = imageKey(img);
    let record = state.images.get(key);

    if (!record) {
      record = {
        key,
        img,
        status: "queued",
        originalSrc: img.dataset.motOriginalSrc || img.currentSrc || img.src,
        translatedDataUrl: null,
        analysis: null,
        layer: null,
        hotspots: [],
        toggleBtn: null,
        error: null
      };
      state.images.set(key, record);
    } else {
      record.img = img;
    }

    if (record.status === "working") return;
    if (record.status === "done") {
      repositionRecord(record);
      return;
    }

    record.status = "working";
    showProcessingBadge(record, true);

    try {
      const rawDataUrl = await getImageDataUrl(img);
      record.originalSrc = rawDataUrl;
      img.dataset.motOriginalSrc = rawDataUrl;

      // Smart pre-compression: downscale for Vision AI to maximize speed & avoid 503 high demand
      const cleanImg = await loadImage(rawDataUrl);
      const aiImageDataUrl = downscaleForAI(cleanImg, 1280);

      const response = await sendMessage({
        type: "ANALYZE_IMAGE",
        imageDataUrl: aiImageDataUrl,
        pageUrl: location.href
      });

      if (!response?.ok) {
        throw new Error(response?.error || "Vision AI analysis failed.");
      }

      record.analysis = normalizeAnalysis(response.result);
      if (!record.analysis.regions.length) {
        console.info("[ScanTranslator] No Japanese dialogue detected on page:", img);
        record.status = "done";
        showProcessingBadge(record, false);
        return;
      }

      // Render on Canvas
      await renderCanvasTranslation(record);
      record.status = "done";
      showProcessingBadge(record, false);
    } catch (err) {
      record.status = "error";
      record.error = err instanceof Error ? err.message : String(err);
      console.warn("[ScanTranslator] Image translation failed:", record.error, img);
      showProcessingBadge(record, false);
    }
  }

  function normalizeAnalysis(result) {
    const regions = Array.isArray(result?.regions) ? result.regions : [];
    return {
      pageWidth: Number(result?.page_width) || 1000,
      pageHeight: Number(result?.page_height) || 1500,
      regions: regions
        .filter(r => r && typeof r.translation === "string" && r.translation.trim())
        .map((r, idx) => ({
          id: String(r.id || `region-${idx + 1}`),
          sourceText: String(r.source_text || "").trim(),
          translation: String(r.translation || "").trim(),
          kind: r.kind || "speech",
          orientation: r.orientation === "horizontal" ? "horizontal" : "vertical",
          bubbleX: clamp01(r.bubble_x),
          bubbleY: clamp01(r.bubble_y),
          bubbleW: clamp01(r.bubble_w),
          bubbleH: clamp01(r.bubble_h),
          maskX: clamp01(r.mask_x),
          maskY: clamp01(r.mask_y),
          maskW: clamp01(r.mask_w),
          maskH: clamp01(r.mask_h),
          background: r.background === "dark" ? "dark" : "light",
          textColor: r.text_color === "light" ? "light" : "dark",
          shape: r.shape || (r.kind === "caption" ? "rectangle" : "oval"),
          emphasis: r.emphasis || "normal",
          confidence: clamp01(r.confidence ?? 0.95)
        }))
        .filter(r => r.confidence >= state.settings.minConfidence && r.bubbleW > 0 && r.bubbleH > 0)
    };
  }

  function clamp01(val) {
    const n = Number(val);
    if (!Number.isFinite(n)) return 0;
    return Math.min(1, Math.max(0, n));
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Failed to load untainted image data"));
      image.src = src;
    });
  }

  /**
   * Main Canvas processing routine: Inpainting + Typesetting -> Seamless Replacement
   */
  async function renderCanvasTranslation(record) {
    const rawSrc = record.originalSrc || (await getImageDataUrl(record.img));
    // CRITICAL: Draw cleanImg loaded from data: URL so canvas is NEVER tainted by cross-origin
    const cleanImg = await loadImage(rawSrc);

    const canvas = document.createElement("canvas");
    canvas.width = cleanImg.naturalWidth || record.img.naturalWidth;
    canvas.height = cleanImg.naturalHeight || record.img.naturalHeight;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    // Step 1: Draw the untainted raw manga page onto the canvas
    ctx.drawImage(cleanImg, 0, 0, canvas.width, canvas.height);

    const fontStack = state.settings.customFont?.family
      ? `"${safeFontName(state.settings.customFont.family)}", 'Comic Neue', sans-serif`
      : `'Comic Neue', 'Comic Sans MS', cursive, sans-serif`;

    const W = canvas.width;
    const H = canvas.height;

    // Step 2: For each speech bubble, perform smart inpainting & professional typesetting
    for (const r of record.analysis.regions) {
      const bubbleBox = {
        x: Math.round(r.bubbleX * W),
        y: Math.round(r.bubbleY * H),
        w: Math.round(r.bubbleW * W),
        h: Math.round(r.bubbleH * H)
      };

      const textBox = {
        x: Math.round(r.maskX * W),
        y: Math.round(r.maskY * H),
        w: Math.round(r.maskW * W),
        h: Math.round(r.maskH * H)
      };

      // 2A: Smart Inpaint: Clean Japanese text preserving bubble contour and art
      smartInpaintBubble(ctx, bubbleBox, textBox, r.background === "dark");

      // 2B: Typeset English translation inside the speech bubble
      renderTypesetDialogue(ctx, r, bubbleBox, fontStack, state.settings.fillRatio);
    }

    // Step 3: Export cleanly to high quality data URL (Untainted canvas exports smoothly!)
    const translatedDataUrl = canvas.toDataURL("image/jpeg", 0.94);
    record.translatedDataUrl = translatedDataUrl;
    record.img.dataset.motTranslatedSrc = translatedDataUrl;

    // Step 4: Seamlessly replace the <img> src without altering DOM layout or breaking viewer scripts
    record.img.src = translatedDataUrl;

    // Step 5: Build the interactive inspection layer (Hover Reveal & Compare Toggle)
    buildInteractiveLayer(record);
  }

  /* =========================================================================
     Interactive Inspection Layer (Hover Reveal & Quick Compare)
     ========================================================================= */

  function buildInteractiveLayer(record) {
    removeInteractiveLayer(record);

    const root = ensureRoot();
    const imageRect = getImageContentRect(record.img);

    const layer = document.createElement("div");
    layer.className = "mot-page-layer";
    layer.style.left = `${imageRect.x + window.scrollX}px`;
    layer.style.top = `${imageRect.y + window.scrollY}px`;
    layer.style.width = `${imageRect.w}px`;
    layer.style.height = `${imageRect.h}px`;

    // Floating Compare Toggle Button
    const toggleBtn = document.createElement("button");
    toggleBtn.className = "mot-page-toggle";
    toggleBtn.innerHTML = `<span>✨</span><span>English</span>`;
    toggleBtn.title = "Click to toggle between English and Raw Japanese (or hold Shift)";
    toggleBtn.addEventListener("click", e => {
      e.stopPropagation();
      toggleImageMode(record);
    });

    layer.appendChild(toggleBtn);
    record.toggleBtn = toggleBtn;

    // Create interactive hotspots for each speech bubble
    for (const r of record.analysis?.regions || []) {
      const hotspot = document.createElement("div");
      hotspot.className = "mot-bubble-hotspot";
      hotspot.style.left = `${r.bubbleX * 100}%`;
      hotspot.style.top = `${r.bubbleY * 100}%`;
      hotspot.style.width = `${r.bubbleW * 100}%`;
      hotspot.style.height = `${r.bubbleH * 100}%`;

      // Hover Reveal Lens (shows original Japanese raw text directly inside the bubble)
      const lens = document.createElement("div");
      lens.className = "mot-reveal-lens";
      lens.style.backgroundImage = `url("${record.originalSrc}")`;
      lens.style.backgroundPosition = `${r.bubbleW > 0 ? (r.bubbleX / (1 - r.bubbleW || 0.001)) * 100 : 0}% ${r.bubbleH > 0 ? (r.bubbleY / (1 - r.bubbleH || 0.001)) * 100 : 0}%`;
      lens.style.backgroundSize = `${100 / (r.bubbleW || 1)}% ${100 / (r.bubbleH || 1)}%`;
      lens.style.opacity = String(state.settings.revealOpacity);

      hotspot.appendChild(lens);

      // Tooltip triggers
      hotspot.addEventListener("mouseenter", e => {
        showTooltip(e.clientX, e.clientY, r);
      });
      hotspot.addEventListener("mousemove", e => {
        showTooltip(e.clientX, e.clientY, r);
      });
      hotspot.addEventListener("mouseleave", () => {
        hideTooltip();
      });

      // Click bubble to copy Japanese text
      hotspot.addEventListener("click", async e => {
        e.stopPropagation();
        if (r.sourceText) {
          try {
            await navigator.clipboard.writeText(r.sourceText);
            showCopyBadge(e.clientX, e.clientY);
          } catch {}
        }
      });

      layer.appendChild(hotspot);
      record.hotspots.push(hotspot);
    }

    root.appendChild(layer);
    record.layer = layer;
  }

  function showCopyBadge(x, y) {
    const badge = document.createElement("div");
    badge.className = "mot-tooltip-badge";
    badge.style.position = "fixed";
    badge.style.left = `${x}px`;
    badge.style.top = `${y - 30}px`;
    badge.style.zIndex = "2147483647";
    badge.style.background = "#22c55e";
    badge.style.color = "#000000";
    badge.style.fontWeight = "800";
    badge.textContent = "Copied Japanese!";
    document.body.appendChild(badge);
    setTimeout(() => badge.remove(), 1200);
  }

  function toggleImageMode(record, forceMode) {
    if (!record.translatedDataUrl || !record.originalSrc) return;
    const isCurrentlyRaw = record.img.src === record.originalSrc;
    const toRaw = forceMode !== undefined ? forceMode === "raw" : !isCurrentlyRaw;

    if (toRaw) {
      record.img.src = record.originalSrc;
      if (record.toggleBtn) {
        record.toggleBtn.classList.add("active");
        record.toggleBtn.innerHTML = `<span>🇯🇵</span><span>Raw</span>`;
      }
    } else {
      record.img.src = record.translatedDataUrl;
      if (record.toggleBtn) {
        record.toggleBtn.classList.remove("active");
        record.toggleBtn.innerHTML = `<span>✨</span><span>English</span>`;
      }
    }
  }

  function removeInteractiveLayer(record) {
    record.layer?.remove();
    record.layer = null;
    record.hotspots = [];
    record.toggleBtn = null;
  }

  function showProcessingBadge(record, isProcessing) {
    const existing = record.img.parentNode?.querySelector(".mot-processing-overlay");
    if (!isProcessing) {
      existing?.remove();
      return;
    }
    if (existing) return;

    const overlay = document.createElement("div");
    overlay.className = "mot-processing-overlay";
    overlay.innerHTML = `
      <div class="mot-spinner"></div>
      <div class="mot-processing-text">Translating Manga…</div>
    `;

    const parent = record.img.parentElement;
    if (parent && getComputedStyle(parent).position === "static") {
      parent.style.position = "relative";
    }
    parent?.appendChild(overlay);
  }

  function repositionRecord(record) {
    if (!record.layer || !record.img?.isConnected) return;
    const imageRect = getImageContentRect(record.img);
    record.layer.style.left = `${imageRect.x + window.scrollX}px`;
    record.layer.style.top = `${imageRect.y + window.scrollY}px`;
    record.layer.style.width = `${imageRect.w}px`;
    record.layer.style.height = `${imageRect.h}px`;
  }

  function updateAllPositions() {
    for (const record of state.images.values()) {
      repositionRecord(record);
    }
  }

  /* =========================================================================
     Scanning & Observers
     ========================================================================= */

  function getVisibleCandidateImages() {
    const all = getCandidateImages();
    const scored = all.map(img => {
      const rect = img.getBoundingClientRect();
      const visibleHeight = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
      const visibleWidth = Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0));
      const visibleArea = visibleHeight * visibleWidth;
      return { img, rect, visibleArea };
    }).filter(x => x.visibleArea > 0);

    scored.sort((a, b) => b.visibleArea - a.visibleArea);
    return scored.map(x => x.img);
  }

  async function translateCurrentVisiblePage() {
    if (state.scanning || !state.settings.enabled) return;

    const visibleCandidates = getVisibleCandidateImages();
    const untranslated = visibleCandidates.filter(img => {
      const rec = state.images.get(imageKey(img));
      return !rec || rec.status !== "done";
    });

    if (untranslated.length === 0) {
      console.info("[ScanTranslator] Current visible manga page is already translated or not found.");
      return;
    }

    state.scanning = true;
    try {
      // In manual mode: translate strictly the single primary page in view
      const targetImg = untranslated[0];
      await processImage(targetImg);
    } finally {
      state.scanning = false;
    }
  }

  async function processAutoScrollImages() {
    if (state.scanning || !state.settings.enabled || !state.settings.autoTranslate) return;
    state.scanning = true;

    try {
      const candidates = getCandidateImages().filter(shouldProcessImage).filter(img => {
        const rec = state.images.get(imageKey(img));
        return !rec || rec.status !== "done";
      });

      for (const img of candidates) {
        if (!state.settings.autoTranslate) break;
        await processImage(img);
        await new Promise(r => setTimeout(r, 60));
      }
    } finally {
      state.scanning = false;
    }
  }

  function scheduleScan(delay = 140) {
    // Only schedule scans if autoTranslate is explicitly enabled by the user!
    if (!state.settings.autoTranslate) return;
    clearTimeout(state.mutationTimer);
    state.mutationTimer = setTimeout(() => processAutoScrollImages(), delay);
  }

  function observeImages() {
    state.observer?.disconnect();
    state.observer = new IntersectionObserver(
      entries => {
        // Only trigger auto-translation if the Auto toggle is active!
        if (state.settings.autoTranslate && entries.some(e => e.isIntersecting)) {
          scheduleScan(80);
        }
      },
      { root: null, rootMargin: "60% 0px" }
    );

    for (const img of getCandidateImages()) {
      state.observer.observe(img);
    }
  }

  function attachMutationObserver() {
    const observer = new MutationObserver(mutations => {
      let relevant = false;
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          if (node.matches?.("img") || node.querySelector?.("img")) {
            relevant = true;
            break;
          }
        }
        if (relevant) break;
      }
      if (relevant) {
        observeImages();
        if (state.settings.autoTranslate) {
          scheduleScan(250);
        }
      }
    });

    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function ensureFloatingHud() {
    if (document.getElementById("mot-floating-hud")) return;

    const hud = document.createElement("div");
    hud.id = "mot-floating-hud";

    hud.innerHTML = `
      <div class="mot-hud-min-btn" title="Open Scan Translator Toolbar">✨</div>
      <div class="mot-hud-content">
        <span class="mot-hud-logo">ST</span>
        <button id="mot-hud-auto" class="mot-hud-btn" title="Toggle automatic translation as you scroll down">
          <span>⚡ Auto</span>
        </button>
        <button id="mot-hud-translate" class="mot-hud-btn primary" title="Translate current visible manga page (Hotkey: T)">
          <span>✨ Translate</span>
        </button>
        <button id="mot-hud-compare" class="mot-hud-btn" title="Toggle Raw Japanese / English (Hotkey: H)">
          <span>🇯🇵 Raw</span>
        </button>
        <button id="mot-hud-close" class="mot-hud-close" title="Minimize Toolbar">✕</button>
      </div>
    `;

    document.body.appendChild(hud);

    const closeBtn = hud.querySelector("#mot-hud-close");
    const minBtn = hud.querySelector(".mot-hud-min-btn");
    closeBtn.addEventListener("click", () => hud.classList.add("minimized"));
    minBtn.addEventListener("click", () => hud.classList.remove("minimized"));

    const autoBtn = hud.querySelector("#mot-hud-auto");
    const updateAutoBtnUI = () => {
      const isOn = Boolean(state.settings.autoTranslate);
      autoBtn.classList.toggle("active", isOn);
      autoBtn.innerHTML = isOn ? `<span>⚡ Auto ON</span>` : `<span>⚡ Auto</span>`;
    };
    updateAutoBtnUI();

    autoBtn.addEventListener("click", async () => {
      state.settings.autoTranslate = !state.settings.autoTranslate;
      updateAutoBtnUI();
      await chrome.storage.local.set({ settings: state.settings });
      if (state.settings.autoTranslate) {
        scheduleScan(50);
      } else {
        clearTimeout(state.mutationTimer);
      }
    });

    const transBtn = hud.querySelector("#mot-hud-translate");
    transBtn.addEventListener("click", async () => {
      transBtn.innerHTML = `<span>⏳ Translating…</span>`;
      state.settings.enabled = true;
      await translateCurrentVisiblePage();
      transBtn.innerHTML = `<span>✨ Translate</span>`;
    });

    const compBtn = hud.querySelector("#mot-hud-compare");
    compBtn.addEventListener("click", () => {
      state.isRawModeGlobal = !state.isRawModeGlobal;
      compBtn.classList.toggle("active", state.isRawModeGlobal);
      compBtn.innerHTML = state.isRawModeGlobal ? `<span>✨ English</span>` : `<span>🇯🇵 Raw</span>`;
      const targetMode = state.isRawModeGlobal ? "raw" : "translated";
      for (const record of state.images.values()) {
        toggleImageMode(record, targetMode);
      }
    });
  }

  function attachWindowEvents() {
    window.addEventListener(
      "resize",
      () => {
        clearTimeout(state.resizeTimer);
        state.resizeTimer = setTimeout(() => updateAllPositions(), 80);
      },
      { passive: true }
    );

    window.addEventListener("scroll", () => updateAllPositions(), { passive: true });

    // Keyboard shortcuts: 'H' for Raw Toggle, 'T' for Translate Visible Page
    window.addEventListener("keydown", e => {
      if (e.target.matches("input, textarea, select")) return;
      if (e.key.toLowerCase() === "h") {
        state.isRawModeGlobal = !state.isRawModeGlobal;
        const targetMode = state.isRawModeGlobal ? "raw" : "translated";
        for (const record of state.images.values()) {
          toggleImageMode(record, targetMode);
        }
      } else if (e.key.toLowerCase() === "t") {
        translateCurrentVisiblePage();
      }
    });
  }

  function clearAll() {
    for (const record of state.images.values()) {
      if (record.originalSrc) {
        record.img.src = record.originalSrc;
      }
      removeInteractiveLayer(record);
      showProcessingBadge(record, false);
    }
    state.images.clear();
    hideTooltip();
  }

  async function sendMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, res => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve(res);
      });
    });
  }

  /* =========================================================================
     Extension Listeners
     ========================================================================= */

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    try {
      switch (message?.type) {
        case "TRANSLATE_PAGE": {
          state.settings.enabled = true;
          translateCurrentVisiblePage().catch(err => {
            console.error("[ScanTranslator] Translate error:", err);
          });
          sendResponse({ ok: true });
          return false;
        }

        case "CLEAR_OVERLAYS": {
          clearAll();
          sendResponse({ ok: true });
          return false;
        }

        case "GET_STATUS": {
          const all = Array.from(state.images.values());
          sendResponse({
            ok: true,
            totalImages: all.length,
            translated: all.filter(x => x.status === "done").length,
            errors: all.filter(x => x.status === "error").length
          });
          return false;
        }

        default:
          sendResponse({ ok: false, error: "Unknown message." });
          return false;
      }
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
      return false;
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.settings) return;
    const prevAuto = state.settings.autoTranslate;
    state.settings = mergeSettings(changes.settings.newValue);
    applyTypography();

    const autoBtn = document.getElementById("mot-hud-auto");
    if (autoBtn) {
      const isOn = Boolean(state.settings.autoTranslate);
      autoBtn.classList.toggle("active", isOn);
      autoBtn.innerHTML = isOn ? `<span>⚡ Auto ON</span>` : `<span>⚡ Auto</span>`;
    }

    if (state.settings.autoTranslate && !prevAuto) {
      scheduleScan(80);
    }
  });

  /* =========================================================================
     Initialization
     ========================================================================= */

  async function init() {
    await loadSettings();
    ensureRoot();
    ensureFloatingHud();
    observeImages();
    attachMutationObserver();
    attachWindowEvents();
    // NEVER automatically translate on page load unless autoTranslate was saved as true!
    if (state.settings.autoTranslate) {
      scheduleScan(200);
    }
  }

  init().catch(err => console.error("[ScanTranslator] Init error:", err));
})();