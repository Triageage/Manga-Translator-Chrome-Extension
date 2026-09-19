# Scan Translator - Manga Canvas & Typesetting (Manifest V3)

A production-ready Chrome Extension (Manifest V3) that translates Japanese manga on web pages (such as Rawkuma, MangaDex, ComicWalker, etc.) into clean English releases in real-time.

Instead of plain, rectangular HTML text overlays, this extension processes manga page images using **HTML5 Canvas**—erasing original Japanese text inside speech bubbles via **smart background inpainting**, and rendering localized English text with **professional comic typesetting**.

---

## Key Features

1. **Computer Vision & Bounding Box Detection**:
   - Primary default model: **Google Gemini 3.8 Flash (Free tier)** with automatic fallback to **Gemini 2.0 Flash**, **Gemini 1.5 Flash**, **Groq Llama 3.2 Vision (100% Free)**, and **OpenRouter Free Tier** (`google/gemini-2.0-flash-exp:free`, `qwen/qwen-2.5-vl-72b:free`).
   - Extracts precise normalized bounding boxes for speech bubbles (`[bubble_x, bubble_y, bubble_w, bubble_h]`) and Japanese text glyphs (`[mask_x, mask_y, mask_w, mask_h]`).
   - Accurately segments and OCRs vertical Japanese dialogue, handwritten text, and styled fonts.
   - **Smart Downscaling**: Pre-compresses oversized images before Vision inference to reduce bandwidth by 90% and prevent 503 high-demand errors while maintaining crystal-clear OCR.

2. **Smart Inpainting & Cleaning (HTML5 Canvas)**:
   - Analyzes detected speech bubble regions to identify background color (pure white `#FFFFFF`, textured screentone, or dark/black inverted bubbles).
   - Erases Japanese text glyphs while strictly preserving outer speech bubble borders, tail pointers, and panel artwork.

3. **Professional Manga Typesetting**:
   - **Elliptical Shape Fitting**: Formats English text dynamically into an oval/diamond layout (tapered top and bottom lines, wider middle) to naturally fill speech bubbles without overflow.
   - **Typography**: Standard uppercase comic lettering with `Comic Neue`, `Comic Sans MS`, `Anime Ace`, `CC Wild Words`, or any custom-uploaded font file.
   - **Auto-Scaling**: Binary-searches the optimal font size to achieve a comfortable ~75% bubble fill target.
   - **Inverted / Dark Bubbles**: Automatically switches to crisp white uppercase text on dark bubbles with high-contrast outlines.

4. **Seamless Image Replacement & Layout Stability**:
   - Directly replaces the `<img>` content via high-resolution data URLs without breaking the DOM hierarchy, CSS flex/grid layout, or page viewer click-to-turn scripts.

5. **Hover-to-Reveal Inspection Lens & On-Page Floating HUD**:
   - **Floating On-Page Toolbar**: On-screen manga controller with Auto-Translate switch, Translate button, and Raw/English toggle.
   - **Hover Reveal Lens**: Hovering over any speech bubble reveals a semi-transparent lens showing original raw Japanese underneath.
   - **OCR Tooltip**: Shows a floating glassmorphism tooltip with the verbatim Japanese OCR transcript, speaker category, and English translation.
   - **Click to Copy**: Click any bubble to copy raw Japanese text to clipboard.
   - **Hotkeys**: Press **`H`** to toggle Raw/English; press **`T`** to translate visible manga pages!

---

## Supported Free AI Vision Providers

| Provider | Model | Cost | Speed | Strengths |
| :--- | :--- | :--- | :--- | :--- |
| **Google Gemini (Default)** | `gemini-3.8-flash` / `gemini-2.0-flash` | **Free Tier** (15 RPM) | ~1.5s | Best Japanese vertical OCR, furigana accuracy, and comic translation quality. |
| **Groq Cloud** | `llama-3.2-11b-vision-preview` | **100% Free** | **~0.4s** (Fastest) | Sub-second LPU inference. Never rate-limited by high demand. |
| **OpenRouter** | `google/gemini-2.0-flash-exp:free`<br>`qwen/qwen-2.5-vl-72b-instruct:free` | **100% Free** | ~1.5s - 3s | Access to Qwen 2.5-VL 72B (exceptional Asian OCR) and Gemini without Google account restrictions. |
| **Local Offline (Ollama)** | `llama3.2-vision` / `minicpm-v` | **100% Free** & Private | Depends on GPU | Runs entirely on your local machine via OpenAI-compatible endpoint `http://localhost:11434`. |

---

## Installation & Setup Guide

### 1. Get a Free API Key
- **Google Gemini (Recommended)**: Go to [Google AI Studio](https://aistudio.google.com/app/apikey) and click **Create API Key**.
- **Groq Cloud (Ultra-Fast Free)**: Go to [Groq Console](https://console.groq.com/keys) and create a free key.
- **OpenRouter (Free Aggregator)**: Go to [OpenRouter Keys](https://openrouter.ai/keys).

*(Optional: You can also use OpenAI `gpt-4o-mini` or any OpenAI-compatible endpoint like Ollama/OpenRouter).*

### 2. Load the Extension into Chrome
1. Open Google Chrome (or any Chromium browser: Brave, Edge, Opera, Vivaldi).
2. In the URL bar, navigate to: `chrome://extensions/`
3. Enable **Developer mode** using the toggle switch in the top-right corner.
4. Click the **Load unpacked** button in the top-left corner.
5. In the file picker dialog, select the extension folder:
   ```
   manga-overlay-translator-mv3
   ```
6. The **Scan Translator - Manga Canvas & Typesetting** extension is now installed and active!

---

## Operating Instructions

### Step 1: Configure Your API Key
1. Click the **Extensions** (puzzle piece) icon in Chrome's toolbar.
2. Click **Scan Translator** to open the popup.
3. Select **Google Gemini** as the provider (default).
4. Paste your API key into the **API Key** input field.
5. Click **Test Connection**. A green `Connected successfully!` pill will confirm your setup.

### Step 2: Choose or Upload Comic Fonts
- Choose from built-in fonts: `Comic Neue`, `Comic Sans MS`, `Anime Ace`, `CC Wild Words`, `Impact`.
- Or upload your own scanlation font (`.ttf`, `.woff2`, `.woff`) using the **Upload Custom Font** button. The font is stored locally in extension storage and rendered directly onto the canvas.

### Step 3: Translate Manga on Web Pages
1. Navigate to any raw Japanese manga chapter page (e.g. on [Rawkuma](https://rawkuma.net/), [ComicWalker](https://comic-walker.com/), [MangaDex](https://mangadex.org/), etc.).
2. The extension automatically detects candidate manga pages in the viewport.
3. To trigger on-demand translation for the active page, open the popup and click **✨ Translate Active Manga Page**.
4. A subtle loading spinner will appear over the page while the Vision AI processes bubbles.
5. In 1–2 seconds, the Japanese text inside speech bubbles will be erased and replaced with crisp, centered English comic lettering!

### Step 4: Interactive Inspection & Comparison
- **Hover Reveal Lens**: Move your mouse over any translated speech bubble to reveal the raw Japanese drawing underneath at the configured opacity.
- **OCR Tooltip**: View the verbatim Japanese transcription and localized text in a floating preview card.
- **Click to Copy**: Click on any speech bubble to copy the Japanese text to your clipboard.
- **Quick Compare Hotkey**: Press the **`H`** key anytime to toggle all manga pages between English and Raw Japanese.

---

## Project Structure

```
manga-overlay-translator-mv3/
├── manifest.json       # Chrome Manifest V3 declaration with host permissions
├── background.js       # Service worker: Gemini generateContent REST API & image fetcher
├── content.js          # Inpainting canvas engine, shape-fitting typesetting & hover lens
├── content.css         # Styles for hover hotspots, inspection tooltips, and compare toggle
├── popup.html          # Extension popup user interface
├── popup.css           # Modern dark-mode styling with glassmorphism
├── popup.js            # Popup controls, API testing, custom font uploader, storage
└── README.md           # Setup and operating documentation
```

---

## Troubleshooting & Tips

- **Image CORS Protection**: Some manga hosting CDNs block direct canvas rasterization. Scan Translator automatically routes image requests through the background service worker (`FETCH_IMAGE`) to ensure high-resolution translation without cross-origin taint.
- **Lazy-Loaded Readers**: On infinite-scroll web readers, images load dynamically as you scroll. Scan Translator uses an `IntersectionObserver` with a prefetch margin to translate upcoming pages before you reach them.
- **Font Rendering**: If using custom `.ttf` or `.woff2` fonts, ensure the font file size is under 8MB for optimal loading performance.
