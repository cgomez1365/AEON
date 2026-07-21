// Vercel Edge Function — web search proxy
// Tries: Bing RSS → DDG HTML → DDG Lite
export const config = { runtime: 'edge' };

export default async function handler(req) {
  const { searchParams } = new URL(req.url);
  const q = searchParams.get('q');
  if (!q) return Response.json({ results: [], error: 'q param required' }, { status: 400 });

  const results = [];
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  // Try 1: Bing RSS (reliable from datacenter IPs)
  try {
    const bingRes = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(q)}&format=rss`, {
      headers: { 'User-Agent': ua },
    });
    const xml = await bingRes.text();
    const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
    for (const item of items.slice(0, 8)) {
      const title = (item.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
      const url = (item.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '';
      const desc = (item.match(/<description>([\s\S]*?)<\/description>/) || [])[1]?.replace(/<[^>]*>/g, '') || '';
      if (url && !url.includes('bing.com')) results.push({ url, title, snippet: desc.slice(0, 200) });
    }
    if (results.length > 0) {
      return Response.json({ results, total: results.length, source: 'bing' }, {
        headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 's-maxage=300' },
      });
    }
  } catch {}

  // Try 2: DDG HTML
  try {
    const ddgRes = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, {
      headers: { 'User-Agent': ua },
    });
    const html = await ddgRes.text();
    const linkRe = /<a rel="nofollow" class="result__a" href="([^"]+)">([\s\S]*?)<\/a>/g;
    const snipRe = /<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = linkRe.exec(html)) !== null) {
      let url = m[1];
      if (url.includes('uddg=')) { try { url = decodeURIComponent(new URLSearchParams(url.split('?')[1]).get('uddg')); } catch {} }
      results.push({ url, title: m[2].replace(/<[^>]*>/g, '').trim(), snippet: '' });
    }
    let si = 0;
    while ((m = snipRe.exec(html)) !== null && si < results.length) {
      results[si].snippet = m[1].replace(/<[^>]*>/g, '').trim().slice(0, 200);
      si++;
    }
    if (results.length > 0) {
      return Response.json({ results: results.slice(0, 8), total: results.length, source: 'ddg' }, {
        headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 's-maxage=300' },
      });
    }
  } catch {}

  // Try 3: DDG Lite POST
  try {
    const ddgRes = await fetch('https://lite.duckduckgo.com/lite/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': ua },
      body: `q=${encodeURIComponent(q)}`,
    });
    const html = await ddgRes.text();
    const linkRe = /<a rel="nofollow" href="([^"]+)" class='result-link'>([\s\S]*?)<\/a>/g;
    const snipRe = /<td class='result-snippet'>([\s\S]*?)<\/td>/g;
    let m;
    while ((m = linkRe.exec(html)) !== null) {
      let url = m[1];
      if (url.includes('uddg=')) { try { url = decodeURIComponent(new URLSearchParams(url.split('?')[1]).get('uddg')); } catch {} }
      results.push({ url, title: m[2].replace(/<[^>]*>/g, '').trim(), snippet: '' });
    }
    let si = 0;
    while ((m = snipRe.exec(html)) !== null && si < results.length) {
      results[si].snippet = m[1].replace(/<[^>]*>/g, '').trim().slice(0, 200);
      si++;
    }
  } catch {}

  return Response.json({ results: results.slice(0, 8), total: results.length, source: results.length ? 'ddg-lite' : 'none' }, {
    headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 's-maxage=300' },
  });
}
