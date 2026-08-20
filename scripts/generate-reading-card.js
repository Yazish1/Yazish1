// Generates an SVG "currently reading" card from a public Goodreads shelf RSS feed,
// embedding the book cover as base64 so it doesn't depend on any third-party server.

const fs = require("fs");
const path = require("path");

const USER_ID = process.env.GOODREADS_USER_ID;
const SHELF = process.env.GOODREADS_SHELF || "currently-reading";
const OUT_PATH = process.env.OUT_PATH || path.join(__dirname, "..", "assets", "currently-reading.svg");

if (!USER_ID) {
  console.error("Missing GOODREADS_USER_ID env var");
  process.exit(1);
}

function extractTag(block, tag) {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = block.match(re);
  if (!m) return "";
  return m[1]
    .replace(/^<!\[CDATA\[/, "")
    .replace(/\]\]>$/, "")
    .trim();
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function escapeXml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildFallbackSvg(message) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="120" viewBox="0 0 320 120">
  <rect width="320" height="120" rx="12" fill="#161b22" stroke="#30363d"/>
  <text x="160" y="65" font-family="Helvetica, Arial, sans-serif" font-size="14" fill="#8b949e" text-anchor="middle">${escapeXml(message)}</text>
</svg>`;
}

function buildCardSvg({ title, author, imageDataUri, imgWidth, imgHeight }) {
  const cardW = 340;
  const coverH = 220;
  const coverW = Math.round((imgWidth / imgHeight) * coverH) || 150;
  const cardH = coverH + 70;
  const coverX = Math.round((cardW - coverW) / 2);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${cardW}" height="${cardH}" viewBox="0 0 ${cardW} ${cardH}">
  <defs>
    <clipPath id="coverClip">
      <rect x="${coverX}" y="16" width="${coverW}" height="${coverH}" rx="6"/>
    </clipPath>
  </defs>
  <rect width="${cardW}" height="${cardH}" rx="14" fill="#0d1117" stroke="#30363d"/>
  <image href="${imageDataUri}" x="${coverX}" y="16" width="${coverW}" height="${coverH}"
         clip-path="url(#coverClip)" preserveAspectRatio="xMidYMid slice"/>
  <rect x="${coverX}" y="16" width="${coverW}" height="${coverH}" rx="6" fill="none" stroke="#30363d"/>
  <text x="${cardW / 2}" y="${coverH + 44}" font-family="Helvetica, Arial, sans-serif" font-size="15"
        font-weight="700" fill="#e6edf3" text-anchor="middle">${escapeXml(title)}</text>
  <text x="${cardW / 2}" y="${coverH + 64}" font-family="Helvetica, Arial, sans-serif" font-size="12"
        fill="#8b949e" text-anchor="middle">${escapeXml(author)}</text>
</svg>`;
}

async function main() {
  const feedUrl = `https://www.goodreads.com/review/list_rss/${USER_ID}?shelf=${encodeURIComponent(SHELF)}`;
  const res = await fetch(feedUrl, { headers: { "User-Agent": "Mozilla/5.0 (compatible; ReadingCardBot/1.0)" } });

  if (!res.ok) {
    console.error(`Feed request failed: ${res.status}`);
    fs.writeFileSync(OUT_PATH, buildFallbackSvg("Couldn't reach Goodreads"));
    return;
  }

  const xml = await res.text();
  const itemMatch = xml.match(/<item>([\s\S]*?)<\/item>/i);

  if (!itemMatch) {
    console.log("No books found on shelf — writing fallback card");
    fs.writeFileSync(OUT_PATH, buildFallbackSvg("Nothing on this shelf right now"));
    return;
  }

  const item = itemMatch[1];
  const title = decodeEntities(extractTag(item, "title"));
  const author = decodeEntities(extractTag(item, "author_name"));
  let imageUrl =
    extractTag(item, "book_large_image_url") ||
    extractTag(item, "book_medium_image_url") ||
    extractTag(item, "book_image_url");

  if (!imageUrl) {
    console.log("No cover image in feed — writing text-only fallback");
    fs.writeFileSync(OUT_PATH, buildFallbackSvg(`${title} — ${author}`));
    return;
  }

  const imgRes = await fetch(imageUrl);
  if (!imgRes.ok) {
    console.error(`Image fetch failed: ${imgRes.status}`);
    fs.writeFileSync(OUT_PATH, buildFallbackSvg(`${title} — ${author}`));
    return;
  }
  const arrBuf = await imgRes.arrayBuffer();
  const buf = Buffer.from(arrBuf);
  const contentType = imgRes.headers.get("content-type") || "image/jpeg";
  const base64 = buf.toString("base64");
  const imageDataUri = `data:${contentType};base64,${base64}`;

  // Try to read real image dimensions from a JPEG/PNG header; fall back to a sane default ratio.
  let imgWidth = 300;
  let imgHeight = 450;
  try {
    if (contentType.includes("png")) {
      imgWidth = buf.readUInt32BE(16);
      imgHeight = buf.readUInt32BE(20);
    } else {
      // Minimal JPEG SOF scan
      let offset = 2;
      while (offset < buf.length) {
        if (buf[offset] !== 0xff) break;
        const marker = buf[offset + 1];
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          imgHeight = buf.readUInt16BE(offset + 5);
          imgWidth = buf.readUInt16BE(offset + 7);
          break;
        }
        const len = buf.readUInt16BE(offset + 2);
        offset += 2 + len;
      }
    }
  } catch (e) {
    console.log("Could not parse image dimensions, using default ratio");
  }

  const svg = buildCardSvg({ title, author, imageDataUri, imgWidth, imgHeight });
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, svg);
  console.log(`Wrote card for "${title}" by ${author} to ${OUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, buildFallbackSvg("Error fetching Goodreads data"));
});