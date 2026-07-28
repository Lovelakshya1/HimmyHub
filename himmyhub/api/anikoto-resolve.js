export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { malId, ep = '1', lang = 'sub' } = req.query;

  if (!malId) {
    return res.status(400).json({ error: 'malId query param is required' });
  }

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Connection': 'keep-alive',
    'X-Requested-With': 'XMLHttpRequest'
  };

  try {
    // 1. Resolve title & MAL-Sync slug mapping
    let title = '';
    let malSyncSlug = '';

    try {
      const syncRes = await fetch(`https://api.malsync.moe/mal/anime/${malId}`);
      if (syncRes.ok) {
        const syncData = await syncRes.json();
        title = syncData.title || '';
        const sites = syncData.Sites || {};
        if (sites.Anikoto) {
          const k = Object.keys(sites.Anikoto)[0];
          if (k) malSyncSlug = sites.Anikoto[k].identifier || '';
        }
        if (!malSyncSlug && sites.Zoro) {
          const k = Object.keys(sites.Zoro)[0];
          if (k) malSyncSlug = (sites.Zoro[k].identifier || '').replace(/-\d+$/, '');
        }
      }
    } catch (e) {
      console.warn('MAL-Sync error:', e.message);
    }

    if (!title) {
      try {
        const zipRes = await fetch(`https://api.ani.zip/mappings?mal_id=${malId}`);
        if (zipRes.ok) {
          const zipData = await zipRes.json();
          title = zipData.titles?.en || zipData.titles?.['x-jat'] || '';
        }
      } catch (e) {
        console.warn('AniZip error:', e.message);
      }
    }

    // 2. Resolve watch slug via Anikoto Search (/filter?keyword=...)
    let slug = malSyncSlug;
    if (!slug) {
      const searchTitle = title || malId;
      const searchUrl = `https://anikototv.to/filter?keyword=${encodeURIComponent(searchTitle)}`;
      const searchRes = await fetch(searchUrl, { headers });
      if (searchRes.ok) {
        const html = await searchRes.text();
        const cardRegex = /<a\s+class="name d-title"\s+href="https?:\/\/[^/]+\/watch\/([^"/]+)\/ep-\d+"[^>]*>([\s\S]*?)<\/a>/gi;
        const matches = [...html.matchAll(cardRegex)];

        if (matches.length > 0) {
          const normQuery = searchTitle.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
          var bestMatchSlug = matches[0][1];
          var bestScore = -1;

          for (const m of matches) {
            const cardSlug = m[1];
            const cardTitle = m[2].replace(/<[^>]+>/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();

            let score = 0;
            if (cardTitle === normQuery) score = 100;
            else if (cardTitle.startsWith(normQuery) || normQuery.startsWith(cardTitle)) score = 70;
            else if (cardTitle.includes(normQuery) || normQuery.includes(cardTitle)) score = 40;

            if (score > bestScore) {
              bestScore = score;
              bestMatchSlug = cardSlug;
            }
          }
          slug = bestMatchSlug;
        }
      }
    }

    // 3. Fetch watch page / AJAX episode list to extract internal animeId and episode data-id
    let animeId = '';
    let epDataId = '';

    if (slug) {
      const watchUrl = `https://anikototv.to/watch/${slug}/ep-${ep}`;
      const watchRes = await fetch(watchUrl, { headers });
      let html = '';
      if (watchRes.ok) html = await watchRes.text();

      const animeIdMatch = html.match(/id\s*=\s*"watch-main"[^>]*\bdata-id\s*=\s*"(\d+)"/) ||
                         html.match(/data-id\s*=\s*"(\d+)"[^>]*id\s*=\s*"watch-main"/);
      animeId = animeIdMatch?.[1] || '';

      // Extract episode data-id (e.g. data-ep-id="1335" or data-ids / data-id)
      const epMatch = html.match(new RegExp(`data-num="${ep}"[^>]*data-ep-id="(\\d+)"`)) ||
                      html.match(new RegExp(`data-num="${ep}"[^>]*data-id="(\\d+)"`));
      if (epMatch) epDataId = epMatch[1];

      // AJAX episode list fallback if epDataId not in initial HTML
      if (!epDataId && animeId) {
        try {
          const epListUrl = `https://anikototv.to/ajax/episode/list/${animeId}`;
          const epListRes = await fetch(epListUrl, { headers });
          if (epListRes.ok) {
            const epListData = await epListRes.json();
            const epListHtml = epListData.result || '';
            const m = epListHtml.match(new RegExp(`data-num="${ep}"[^>]*data-ep-id="(\\d+)"`)) ||
                      epListHtml.match(new RegExp(`data-num="${ep}"[^>]*data-id="(\\d+)"`)) ||
                      epListHtml.match(/data-ep-id="(\d+)"/);
            if (m) epDataId = m[1];
          }
        } catch (e) {
          console.warn('AJAX ep list error:', e.message);
        }
      }
    }

    // 4. Construct exact, working Megaplay stream URLs
    // MAL route: /stream/mal/{malId}/{ep}/{lang}
    const malUrl = `https://megaplay.buzz/stream/mal/${malId}/${ep}/${lang}`;

    // s-2 route: /stream/s-2/{malId}/{lang}?ep={ep} (Uses MAL ID)
    const s2Url = `https://megaplay.buzz/stream/s-2/${malId}/${lang}?ep=${ep}`;

    // s-5 route: /stream/s-5/{epDataId}/{lang}?autostart=true (Uses Episode Data ID, e.g. 1335 for FMAB Ep 1)
    const s5Url = epDataId
      ? `https://megaplay.buzz/stream/s-5/${epDataId}/${lang}?autostart=true`
      : `https://megaplay.buzz/stream/s-5/${malId}/${lang}?ep=${ep}`;

    return res.status(200).json({
      success: true,
      malId,
      title,
      slug,
      animeId,
      epDataId,
      urls: {
        mal: malUrl,
        s2: s2Url,
        s5: s5Url,
        web: slug ? `https://anikototv.to/watch/${slug}/ep-${ep}` : null
      }
    });

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
